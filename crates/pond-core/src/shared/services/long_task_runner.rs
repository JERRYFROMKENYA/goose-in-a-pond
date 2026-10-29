//! What a long task runs next, and what each helper is told. Pure: the lane loop in `pond-server`
//! does the I/O, so every decision here is tested without a model.
use crate::shared::domain::long_task::{
    blocked_steps, next_ready_step, ArtifactSummary, LongTask, LongTaskKind, LongTaskState,
    OutcomeKind, PlanStep, StepKey, StepOutcome, StepState,
};
use crate::shared::domain::orchestration::{AgentRole, TaskRun, TaskStatus};
use crate::shared::services::long_task_roles::{self as roles, TASK_WORK_EXTENSION};
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

/// The artifact the planner is told to end with, which `task_status` reports as the answer.
pub const RESULT_TITLE: &str = "Result";

pub fn result_artifact(artifacts: &[ArtifactSummary]) -> Option<&ArtifactSummary> {
    artifacts
        .iter()
        .rev()
        .find(|a| a.title.eq_ignore_ascii_case(RESULT_TITLE))
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

/// A research report is as long as its plan: the pond joins the sections steps drafted, so no
/// single reply has to hold it.
const RESEARCH_PLAN: &str = "This is deep research the person asked for, and the report can be \
     as long as the question needs: a page for a quick question, many for a trip or a big \
     decision. Plan it in three parts. First, steps that each look into one part of the question \
     with search_web or get_wikipedia_article, or recall what the household has said with the \
     memory tools, and save their findings with their sources. Then one step per section of the \
     report, each writing its section from the findings it is given and saving it as a draft \
     artifact titled as the reader should see it. Give every section that is a plan, such as an \
     itinerary, a meal plan or a packing or shopping list, to long-task-composer. Last, one step \
     writes the artifact titled \"Result\": a short title on its first line as a \"# \" heading, \
     then a few paragraphs that answer the question and introduce the sections without repeating \
     them. Do not plan a step that combines, compiles or merges sections: the pond joins the \
     Result and the sections, in plan order, into the report itself.\n";

/// A research step works from sources, not from what a small model remembers, and keeps the
/// household's particulars out of what it sends to a search engine.
const RESEARCH_STEP: &str = "This is deep research. Look things up with search_web or \
     get_wikipedia_article rather than from memory, keep only what the sources say, and cite each \
     source as a Markdown link, [its title](its address), using the address the search gave. If \
     the sources disagree, say so. If your step writes a section, save it as a draft artifact \
     titled as the reader should see it, such as \"Getting around\", and write it in full: the \
     pond puts it in the report as you wrote it. Use no emoji. Never put a person's name, health \
     or diet in a web search: search for the place, the dish or the thing.\n";

fn date_line(now: DateTime<Utc>) -> String {
    format!("Today is {} (UTC).\n", now.format("%A %-d %B %Y, %H:%M"))
}

/// What the planner sees: the goal, who can do steps, what is done and why anything failed.
pub fn planner_brief(
    task: &LongTask,
    steps: &[PlanStep],
    artifacts: &[ArtifactSummary],
    roles: &[AgentRole],
    reason: &PlanReason,
    now: DateTime<Utc>,
) -> String {
    let mut brief = date_line(now);
    brief.push_str(&format!("Goal: {}\n", task.goal()));
    if task.kind() == LongTaskKind::Research {
        brief.push_str(RESEARCH_PLAN);
    }
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
    if task.kind() == LongTaskKind::Research {
        brief.push_str(RESEARCH_STEP);
    }
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
pub fn verifier_brief(
    step: &PlanStep,
    report: &StepOutcome,
    artifacts: &[ArtifactSummary],
    now: DateTime<Utc>,
) -> String {
    let saved: Vec<&ArtifactSummary> = artifacts
        .iter()
        .filter(|a| a.step_key.as_ref() == Some(step.key()) || report.artifacts().contains(&a.id))
        .collect();
    let mut brief = date_line(now);
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
    if run.status == TaskStatus::Cancelled {
        return RunEnd::Preempted;
    }
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
