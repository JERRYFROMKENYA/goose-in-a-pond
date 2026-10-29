//! What a long task runs next, and what each helper is told. Pure: the lane loop in `pond-server`
//! does the I/O, so every decision here is tested without a model.
use crate::mcp::domain::tool_group::{group_of_tool, HOUSEHOLD_READ_TOOLS};
use crate::models::domain::message::Role;
use crate::shared::domain::long_task::StepAgent;
use crate::shared::domain::long_task::{
    blocked_steps, next_ready_step, validate_plan, AnswerShape, ArtifactSummary, LongTask,
    LongTaskKind, LongTaskState, OutcomeKind, PlanError, PlanStep, StepDraft, StepKey, StepOutcome,
    StepState, ValidatedPlan,
};
use crate::shared::domain::orchestration::{
    AgentRole, DelegationAuthority, RoleError, RolePersonalData, TaskRun, TaskStatus,
};
use crate::shared::services::long_task_roles::{self as roles, TASK_WORK_EXTENSION};
use crate::user_data::domain::profile::ProfileScope;
use crate::user_data::domain::recipe::AgentRecipe;
use chrono::{DateTime, Utc};
use std::collections::HashMap;

/// Tool-group ceiling for a long task's runs, which have no parent turn to inherit one from.
/// Read-only beyond the ledger: until approvals exist, no step may act on the world.
pub const LONG_TASK_ROOT_GROUPS: &[&str] = &[
    TASK_WORK_EXTENSION,
    "giap-knowledge",
    "giap-memory",
    "giap-weather",
    "giap-sensors",
];

/// The authority every run of a long task starts from, the prefill compile's included, so both
/// build the same prompt: the ceiling above plus the house's read-only tools.
pub fn long_task_authority(session_id: &str, scope: ProfileScope) -> DelegationAuthority {
    DelegationAuthority::root(
        session_id,
        scope,
        LONG_TASK_ROOT_GROUPS
            .iter()
            .map(|group| (*group).to_string())
            .collect(),
    )
    .with_read_tools(HOUSEHOLD_READ_TOOLS.iter().copied())
}

/// Whether a run of a long task can hold anything of `group`: the whole of it, or its reads.
pub fn lane_reaches_group(group: &str) -> bool {
    LONG_TASK_ROOT_GROUPS.contains(&group)
        || HOUSEHOLD_READ_TOOLS
            .iter()
            .any(|tool| group_of_tool(tool) == Some(group))
}

/// The roles the planner may give a step: the shipped worker first, then the household's own
/// active roles. The planner and verifier are not offered: neither does a step's work.
pub fn step_roles(household: &[AgentRecipe]) -> Vec<AgentRole> {
    let mut offered: Vec<AgentRole> = roles::worker_role()
        .into_iter()
        .chain(roles::composer_role())
        .collect();
    for recipe in household.iter().filter(|r| r.active) {
        if [
            roles::PLANNER_ROLE,
            roles::VERIFIER_ROLE,
            roles::WORKER_ROLE,
        ]
        .contains(&recipe.name.as_str())
        {
            continue;
        }
        if let Ok(Some(role)) = AgentRole::from_recipe_yaml(&recipe.name, &recipe.yaml) {
            offered.push(role);
        }
    }
    offered
}

/// A failed step is tried this many times before the planner is asked to plan around it.
pub const MAX_STEP_ATTEMPTS: u32 = 2;

/// The failure a helper that used up its turns leaves; its retry gets more of them.
pub const OUT_OF_TURNS: &str = "the helper ran out of turns before reporting";

/// The failure a helper that reported done with nothing to show leaves.
pub const CAME_BACK_EMPTY: &str = "the helper reported done but gave no result";

/// A summary shorter than this, with nothing saved, is no result at all.
const MIN_RESULT_CHARS: usize = 20;

/// An input this small is put in the brief whole: a helper that must first call `artifact_read`
/// spends a model turn and a re-prefill before it starts the work, and a small model sometimes
/// never reads it at all. Larger inputs, and any past the total, stay pull-only.
pub const INLINE_ARTIFACT_TOKENS: u32 = 1_500;
pub const INLINE_TOTAL_TOKENS: u32 = 3_000;

/// Plans in a row that leave nothing runnable before the task is given up.
pub const MAX_FRUITLESS_PLANS: u32 = 3;

/// Starts with `sched-` so `SessionOrigin` treats a step's session as the pond's own, never as
/// somebody being home.
pub const LONG_TASK_SESSION_PREFIX: &str = "sched-long-task-";

/// The root session one run of a task works under.
pub fn long_task_session_id(task_id: &str, run_id: &str) -> String {
    format!("{LONG_TASK_SESSION_PREFIX}{task_id}-{run_id}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanReason {
    /// No plan yet.
    Fresh,
    /// These steps cannot run: something they depend on failed for good or was skipped.
    Blocked(Vec<StepKey>),
}

#[derive(Debug, PartialEq, Eq)]
pub enum NextRun<'a> {
    Plan(PlanReason),
    Do(&'a PlanStep),
    /// Every step is settled.
    Finish,
    GiveUp(String),
    /// Nothing to run until somebody acts (paused, awaiting approval, or finished).
    Wait,
}

/// The one decision the runner makes per slot.
pub fn next_run<'a>(
    task: &LongTask,
    steps: &'a [PlanStep],
    fruitless_plans: u32,
    now: DateTime<Utc>,
) -> NextRun<'a> {
    match task.state() {
        LongTaskState::Planning | LongTaskState::Running => {}
        _ => return NextRun::Wait,
    }
    if task.budget().deadline_passed(now) {
        return NextRun::GiveUp("it ran past its deadline".to_string());
    }
    if fruitless_plans >= MAX_FRUITLESS_PLANS {
        return NextRun::GiveUp(format!(
            "{fruitless_plans} plans in a row left nothing that could run"
        ));
    }
    if task.state() == LongTaskState::Planning || steps.is_empty() {
        return NextRun::Plan(PlanReason::Fresh);
    }
    // A retry comes before the blocked check: a failed step's dependents wait for its retry.
    if let Some(retry) = steps
        .iter()
        .filter(|s| s.state() == StepState::Failed && s.attempts() < MAX_STEP_ATTEMPTS)
        .min_by_key(|s| s.ordinal())
    {
        return NextRun::Do(retry);
    }
    let blocked = blocked_steps(steps);
    if !blocked.is_empty() {
        return NextRun::Plan(PlanReason::Blocked(
            blocked.iter().map(|s| s.key().clone()).collect(),
        ));
    }
    if let Some(step) = next_ready_step(steps) {
        return NextRun::Do(step);
    }
    let settled = steps
        .iter()
        .all(|s| matches!(s.state(), StepState::Completed | StepState::Skipped));
    if settled {
        return NextRun::Finish;
    }
    if steps.iter().any(|s| s.state() == StepState::Failed) {
        // Out of retries with nothing depending on it: the planner decides whether it mattered.
        return NextRun::Plan(PlanReason::Blocked(Vec::new()));
    }
    NextRun::Wait
}

/// The rules a made agent works by; a saved role's instructions carry the same in its own words.
const MADE_AGENT_RULES: &str = "How you work:
1. Your brief gives the task's goal, your step and your inputs. Use only your tools.
2. Save what you make with artifact_write, titled as the reader should see it. On your last
   save, when the step is done, set finish to true: that reports the step completed.
3. Otherwise finish with step_report once, last: outcome completed or failed, what you did in a
   few sentences, and the ids of what you saved.
Never put a person's name, health or diet in a web search.";

/// The agent a plan made for one step. Its tools are those it asked for within the task's
/// ceiling, always with the task-work tools, and it takes the shipped worker's turns and window.
pub fn role_for_agent(
    step: &PlanStep,
    agent: &StepAgent,
    worker: &AgentRole,
) -> Result<AgentRole, RoleError> {
    let mut tools: std::collections::BTreeSet<String> = agent
        .tools
        .iter()
        .filter(|group| lane_reaches_group(group))
        .cloned()
        .collect();
    tools.insert(TASK_WORK_EXTENSION.to_string());
    AgentRole::new(
        step.role(),
        format!(
            "You are {}, an agent made for one step of a longer task. {}\n\n{MADE_AGENT_RULES}",
            agent.name, agent.instructions
        ),
        tools,
        RolePersonalData::Inherit,
        worker.max_turns(),
        worker.context_fraction(),
    )
}

/// The task-level note every helper is given: what the conversation said that the goal leaves out.
/// A helper starts in an empty window, so without it "I'm lactose intolerant" said three messages
/// before the ask never reaches the plan.
pub const BRIEF_TITLE: &str = "Brief";

/// A brief longer than this keeps its end, which is what was said last.
pub const BRIEF_CHARS: usize = 4_000;

/// The task's brief, if it has one: saved when the task started, belonging to no step.
pub fn brief_artifact(artifacts: &[ArtifactSummary]) -> Option<&ArtifactSummary> {
    artifacts
        .iter()
        .find(|a| a.step_key.is_none() && a.title == BRIEF_TITLE)
}

/// A brief made from the conversation before the ask, oldest first, kept to [`BRIEF_CHARS`] from
/// its end. `None` when nothing came before it.
pub fn conversation_brief(earlier: &[(Role, &str)]) -> Option<String> {
    let lines: Vec<String> = earlier
        .iter()
        .filter_map(|(role, text)| {
            let text = text.trim();
            let who = match role {
                Role::User => "The person",
                Role::Assistant => "The assistant",
                Role::System | Role::Tool => return None,
            };
            (!text.is_empty()).then(|| format!("{who}: {text}"))
        })
        .collect();
    if lines.is_empty() {
        return None;
    }
    let mut kept: Vec<&str> = Vec::new();
    let mut total = 0;
    for line in lines.iter().rev() {
        if total + line.len() + 1 > BRIEF_CHARS {
            if kept.is_empty() {
                let tail: String = line
                    .chars()
                    .rev()
                    .take(BRIEF_CHARS)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                return Some(format!("Earlier in the conversation:\n...{tail}"));
            }
            break;
        }
        total += line.len() + 1;
        kept.push(line);
    }
    kept.reverse();
    Some(format!("Earlier in the conversation:\n{}", kept.join("\n")))
}

/// Cut a brief the prime wrote to [`BRIEF_CHARS`], keeping its start: it leads with what matters.
pub fn clip_brief(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.chars().take(BRIEF_CHARS).collect())
}

/// The artifact the planner is told to end with, which `task_status` reports as the answer.
pub const RESULT_TITLE: &str = "Result";

/// The newest artifact titled "Result", else the newest whose title has "result" as a word: a model
/// told to save "Result" sometimes saves "Arusha Trip Result", and the task then read as having no
/// answer. "Search results" is not one.
pub fn result_artifact(artifacts: &[ArtifactSummary]) -> Option<&ArtifactSummary> {
    let names_result = |title: &str| {
        title
            .split(|c: char| !c.is_alphanumeric())
            .any(|word| word.eq_ignore_ascii_case(RESULT_TITLE))
    };
    artifacts
        .iter()
        .rev()
        .find(|a| a.title.trim().eq_ignore_ascii_case(RESULT_TITLE))
        .or_else(|| artifacts.iter().rev().find(|a| names_result(&a.title)))
}

fn artifact_lines(artifacts: &[&ArtifactSummary]) -> String {
    if artifacts.is_empty() {
        return "  (none)\n".to_string();
    }
    artifacts
        .iter()
        .map(|a| {
            format!(
                "  - {} [{}] \"{}\" ({} tokens): {}\n",
                a.id,
                a.kind.as_str(),
                a.title,
                a.tokens,
                a.summary
            )
        })
        .collect()
}

/// Where a research task's answers come from, for the planner: the house's own tools for the
/// house, and the web only for the world.
const RESEARCH_SOURCES: &str = "This is research the person asked for. First decide where the \
     answer lives. What happened in this house, who the cameras saw, what the sensors read, what \
     is scheduled and what the household has said live in the house, and a step reads them with \
     get_recent_camera_events, the sensor, schedule and device tools, or the memory tools. A \
     question about this house needs no web step at all. Plan a web step only for something the \
     goal itself asks about that lies outside the house, such as places, prices or facts about \
     the world. When part of the answer is out of every helper's reach, \
     such as old camera footage or a picture, plan no step for it: the Result says what could not \
     be read and how the person can get it.\n";

/// A short answer is one or two steps: a plan with sections is the slow, long kind.
const SHORT_PLAN: &str = "The person wants a short answer. Plan one step, or two when the \
     answer needs looking in two places, and no sections. The last step saves the Result: the \
     answer itself in its first sentence, at most 150 words in all, with its sources, and no \
     heading.\n";

/// A research report gathers, writes a section per part, then the Result that opens it.
const RESEARCH_REPORT_PLAN: &str = "The person wants a report, as long as the question needs: \
     a page for a narrow question, many for a trip or a big decision. Plan it in three parts. \
     First, steps that each look into one part of the question and save their findings with \
     their sources. Then one step per section of the report, each writing its section from the \
     findings it is given and saving it as a draft artifact titled as the reader should see it. \
     Give every section that is a plan, such as an itinerary, a meal plan or a packing or \
     shopping list, to long-task-composer. Last, one step writes the artifact titled \"Result\": \
     a short title on its first line as a \"# \" heading, then a few paragraphs that answer the \
     question and introduce the sections without repeating them. Do not plan a step that \
     combines, compiles or merges sections: the pond joins the Result and the sections, in plan \
     order, into the report itself.\n";

const REPORT_PLAN: &str = "The person wants all of it: plan the steps the work needs, and the \
     last step saves the Result in full.\n";

/// Nobody chose a length, so the planner reads it from the ask; short when unsure, for speed.
const DECIDE_ANSWER: &str = "Nobody has said how long the answer should be, so decide it from \
     the goal and what the person said, and pass it as plan_write's answer. short suits a \
     question with one answer: a fact, a number, a yes or no, a check, what happened, or a choice \
     among a few named options. report suits a trip, a plan, a comparison of many options, a big \
     decision, or an ask to be thorough or for a report. When it could be either, choose short.\n";

/// A research step works from sources, not from what a small model remembers, and keeps the
/// household's particulars out of what it sends to a search engine.
const RESEARCH_STEP: &str = "This is research. Answer from sources, never from memory: the \
     house's own tools for what happened here, such as get_recent_camera_events, the sensor and \
     schedule tools and the memory tools, and search_web or get_wikipedia_article only for what \
     is outside the house. Keep only what the sources say, and cite each web source as a Markdown \
     link, [its title](its address), using the address the search gave. If the sources disagree, \
     say so. Write only what your tools returned or your inputs say: never write that the house \
     has nothing of something unless the house's own tool said so. If what your step needs is \
     out of your tools' reach, do not search the web for it: save what you could find, say \
     plainly what is missing and how the person could get it, and report the step completed. \
     Use no emoji. Never put a person's name, health or diet in a web \
     search: search for the place, the dish or the thing.\n";

/// A report's sections are where its length comes from, so they ask for specifics.
const SECTION_STEP: &str = "If your step writes a section, save it as a draft artifact titled \
     as the reader should see it, such as \"Getting around\", and write it in full: the pond \
     puts it in the report as you wrote it. A section is 400 to 900 words of specifics from the \
     findings: names, prices, times, distances, addresses and what each is good for, not a \
     summary of them. A plan covers every day or item with its times, places and costs.\n";

const SHORT_STEP: &str = "The person wants a short answer. If your step saves the Result, put \
     the answer itself in its first sentence and keep the whole to 150 words with its sources, \
     no heading and no sections.\n";

/// The step a short answer the member chose runs in place of a plan: the planner's run would take
/// longer than the answer.
const SHORT_ANSWER_STEP: &str = "Answer the task's goal for the person. Find what it needs with \
     your tools, then save the answer with artifact_write, titled \"Result\", with finish true.";

pub const SHORT_ANSWER_KEY: &str = "answer";

/// The whole plan of a short answer the member chose: one worker step, so no planner runs.
pub fn short_answer_plan(task: &LongTask) -> Result<ValidatedPlan, PlanError> {
    validate_plan(
        task,
        vec![StepDraft {
            key: SHORT_ANSWER_KEY.to_string(),
            role: roles::WORKER_ROLE.to_string(),
            instructions: SHORT_ANSWER_STEP.to_string(),
            ..StepDraft::default()
        }],
        &[],
    )
}

/// How the planner is told to size the answer: the member's choice, or its own reading of the ask.
fn answer_plan(task: &LongTask) -> String {
    let research = task.kind() == LongTaskKind::Research;
    let report = if research {
        RESEARCH_REPORT_PLAN
    } else {
        REPORT_PLAN
    };
    let mut text = String::new();
    if research {
        text.push_str(RESEARCH_SOURCES);
    }
    match task.answer() {
        AnswerShape::Short => text.push_str(SHORT_PLAN),
        AnswerShape::Report => text.push_str(report),
        AnswerShape::Auto => {
            text.push_str(DECIDE_ANSWER);
            text.push_str("If short: ");
            text.push_str(SHORT_PLAN);
            text.push_str("If report: ");
            text.push_str(report);
        }
    }
    text
}

/// How a worker is told to size what it writes. A task still `Auto` here had a planner that chose
/// nothing, and is written as before shapes existed.
fn answer_step(task: &LongTask) -> String {
    let mut text = String::new();
    if task.kind() == LongTaskKind::Research {
        text.push_str(RESEARCH_STEP);
    }
    match task.answer() {
        AnswerShape::Short => text.push_str(SHORT_STEP),
        AnswerShape::Report | AnswerShape::Auto if task.kind() == LongTaskKind::Research => {
            text.push_str(SECTION_STEP)
        }
        AnswerShape::Report | AnswerShape::Auto => {}
    }
    text
}

fn date_line(now: DateTime<Utc>) -> String {
    format!("Today is {} (UTC).\n", now.format("%A %-d %B %Y, %H:%M"))
}

/// What the planner sees: the goal, who can do steps, what is done and why anything failed.
/// `context` is the task's brief, read by the caller.
pub fn planner_brief(
    task: &LongTask,
    steps: &[PlanStep],
    artifacts: &[ArtifactSummary],
    roles: &[AgentRole],
    reason: &PlanReason,
    context: Option<&str>,
    now: DateTime<Utc>,
) -> String {
    let mut brief = date_line(now);
    brief.push_str(&format!("Goal: {}\n", task.goal()));
    if let Some(context) = context {
        brief.push_str(&format!(
            "What the person said that the goal leaves out (every step is given this too):\n{}\n",
            context.trim()
        ));
    }
    brief.push_str(&answer_plan(task));
    brief.push_str(&format!(
        "At most {} steps in all.\n\nRoles that can do a step:\n",
        task.budget().max_steps()
    ));
    for role in roles {
        brief.push_str(&format!(
            "  - {}: {}\n",
            role.name(),
            first_line(role.instructions())
        ));
    }
    let done: Vec<&PlanStep> = steps
        .iter()
        .filter(|s| s.state() == StepState::Completed)
        .collect();
    brief.push_str("\nFinished steps:\n");
    if done.is_empty() {
        brief.push_str("  (none)\n");
    }
    for step in done {
        brief.push_str(&format!(
            "  - {}: {}\n",
            step.key(),
            step.summary().unwrap_or("done")
        ));
    }
    for step in steps.iter().filter(|s| s.state() == StepState::Failed) {
        brief.push_str(&format!(
            "Step {} failed after {} tries: {}\n",
            step.key(),
            step.attempts(),
            step.failure().unwrap_or("no reason given")
        ));
    }
    if let PlanReason::Blocked(keys) = reason {
        if !keys.is_empty() {
            let keys: Vec<&str> = keys.iter().map(StepKey::as_str).collect();
            brief.push_str(&format!(
                "These steps cannot run as planned: {}. Plan around them.\n",
                keys.join(", ")
            ));
        }
    }
    brief.push_str("\nArtifacts so far:\n");
    brief.push_str(&artifact_lines(&artifacts.iter().collect::<Vec<_>>()));
    brief
}

/// What a worker sees: its step, the artifacts it was given and what its dependencies saved.
/// What a step is given: its named inputs, what the steps it depends on saved, and on a retry what
/// its own last try saved, so the retry continues that work rather than starting again.
fn given_artifacts<'a>(
    step: &PlanStep,
    artifacts: &'a [ArtifactSummary],
) -> Vec<&'a ArtifactSummary> {
    artifacts
        .iter()
        .filter(|a| {
            step.inputs().contains(&a.id)
                || (a.step_key.is_none() && a.title == BRIEF_TITLE)
                || a.step_key.as_ref().is_some_and(|key| {
                    step.depends_on().contains(key) || (step.attempts() > 0 && key == step.key())
                })
        })
        .collect()
}

/// The given artifacts whose bodies go in the brief, in order, within the inline budget.
pub fn inline_ids(step: &PlanStep, artifacts: &[ArtifactSummary]) -> Vec<String> {
    let mut total = 0;
    let mut ids = Vec::new();
    for artifact in given_artifacts(step, artifacts) {
        if artifact.tokens <= INLINE_ARTIFACT_TOKENS
            && total + artifact.tokens <= INLINE_TOTAL_TOKENS
        {
            total += artifact.tokens;
            ids.push(artifact.id.clone());
        }
    }
    ids
}

/// The turn budget for a step's run: a retry after running out of turns gets half again as many.
pub fn turns_for(role_max_turns: u32, step: &PlanStep) -> u32 {
    if step.attempts() > 0 && step.failure() == Some(OUT_OF_TURNS) {
        role_max_turns + role_max_turns.div_ceil(2)
    } else {
        role_max_turns
    }
}

/// `bodies` holds the text of the inputs [`inline_ids`] chose, read by the caller.
pub fn worker_brief(
    task: &LongTask,
    step: &PlanStep,
    artifacts: &[ArtifactSummary],
    bodies: &HashMap<String, String>,
    now: DateTime<Utc>,
) -> String {
    let given = given_artifacts(step, artifacts);
    let mut brief = date_line(now);
    brief.push_str(&format!("The task's goal: {}\n", task.goal()));
    brief.push_str(&answer_step(task));
    brief.push_str(&format!(
        "Your step ({}): {}\n",
        step.key(),
        step.instructions()
    ));
    if let Some(acceptance) = step.acceptance() {
        brief.push_str(&format!("It will be checked against: {acceptance}\n"));
    }
    if step.attempts() > 0 {
        if let Some(failure) = step.failure() {
            brief.push_str(&format!("The last try failed: {failure}\n"));
        }
    }
    let (inline, pull): (Vec<&ArtifactSummary>, Vec<&ArtifactSummary>) =
        given.into_iter().partition(|a| bodies.contains_key(&a.id));
    if !inline.is_empty() {
        brief.push_str(
            "\nYour inputs, already read for you (do not call artifact_read for these):\n",
        );
        for artifact in &inline {
            brief.push_str(&format!(
                "--- {} \"{}\" ---\n{}\n",
                artifact.id,
                artifact.title,
                bodies[&artifact.id].trim()
            ));
        }
    }
    brief.push_str(if inline.is_empty() {
        "\nArtifacts you may read:\n"
    } else {
        "\nOther artifacts you may read:\n"
    });
    brief.push_str(&artifact_lines(&pull));
    brief
}

/// What a verifier sees: the check, the worker's report and what the step saved.
/// `context` is the task's brief: a step can pass its own check and still miss what was asked.
pub fn verifier_brief(
    task: &LongTask,
    step: &PlanStep,
    report: &StepOutcome,
    artifacts: &[ArtifactSummary],
    context: Option<&str>,
    now: DateTime<Utc>,
) -> String {
    let saved: Vec<&ArtifactSummary> = artifacts
        .iter()
        .filter(|a| a.step_key.as_ref() == Some(step.key()) || report.artifacts().contains(&a.id))
        .collect();
    let mut brief = date_line(now);
    brief.push_str(&format!("The task's goal: {}\n", task.goal()));
    if let Some(context) = context.and_then(clip_brief) {
        brief.push_str(&format!("What the person said about it:\n{context}\n"));
    }
    brief.push_str(
        "Fail the step, too, if what it saved does not serve that goal: if it is about something \
         else, or comes from the web when the goal asks about this house.\n",
    );
    brief.push_str(&format!("Step {}: {}\n", step.key(), step.instructions()));
    brief.push_str(&format!(
        "Acceptance check: {}\n",
        step.acceptance().unwrap_or("the step did what it says")
    ));
    brief.push_str(&format!("The step's report: {}\n", report.summary()));
    brief.push_str("\nWhat it saved:\n");
    brief.push_str(&artifact_lines(&saved));
    brief
}

fn first_line(text: &str) -> &str {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
}

/// How one run ended, from the runner's side.
#[derive(Debug, PartialEq, Eq)]
pub enum RunEnd {
    /// The helper's hand-back, or the one its run implies.
    Reported(StepOutcome),
    /// A household turn stopped it; the step reruns without spending an attempt.
    Preempted,
}

/// What a helper is told when it stops with turns left but has not reported.
pub const REPORT_NUDGE: &str = "You stopped without calling step_report, so your step is not \
     finished. Call step_report now: outcome completed or failed, a few sentences on what you did, \
     and the ids of the artifacts you saved.";

/// One hand-back per run: the reported one; else, when the helper saved work, that work; else one
/// read from its last text; else a failure that says why there is none.
/// `may_retry` says the step has a try left: a helper that ran out of turns then fails, so its
/// retry gets more turns and what it saved, rather than its half-done work counting as done.
pub fn settle_run(
    reported: Option<StepOutcome>,
    written: &[String],
    run: &TaskRun,
    may_retry: bool,
) -> RunEnd {
    // A report is the hand-back even when the run was then stopped: the runner ends a run as soon
    // as it reports, rather than pay for the turn the model takes after "stop here".
    if let Some(outcome) = reported {
        let empty = outcome.outcome() == OutcomeKind::Completed
            && outcome.artifacts().is_empty()
            && written.is_empty()
            && outcome.summary().trim().chars().count() < MIN_RESULT_CHARS;
        return RunEnd::Reported(if empty {
            failed(CAME_BACK_EMPTY)
        } else {
            outcome
        });
    }
    if run.status == TaskStatus::Cancelled {
        return RunEnd::Preempted;
    }
    if run.status == TaskStatus::TurnBudgetExhausted && may_retry {
        return RunEnd::Reported(failed(OUT_OF_TURNS));
    }
    // Small models often save their work and stop without reporting; the work is the evidence.
    if !written.is_empty() {
        let summary = run
            .result
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("Saved {} artifact(s).", written.len()));
        return RunEnd::Reported(StepOutcome::new(
            OutcomeKind::Completed,
            &summary,
            written.to_vec(),
            None,
        ));
    }
    if run.status == TaskStatus::TurnBudgetExhausted {
        return RunEnd::Reported(failed(OUT_OF_TURNS));
    }
    match run.result_for_parent().map(StepOutcome::parse) {
        Some(Ok(outcome)) => RunEnd::Reported(outcome),
        Some(Err(_)) | None => RunEnd::Reported(failed(
            run.error
                .as_deref()
                .unwrap_or("the helper ended without reporting"),
        )),
    }
}

fn failed(reason: &str) -> StepOutcome {
    StepOutcome::new(OutcomeKind::Failed, reason, Vec::new(), Some(reason))
}

#[cfg(test)]
mod tests;
