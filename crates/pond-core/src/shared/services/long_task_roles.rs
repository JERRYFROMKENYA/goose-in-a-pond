//! The roles a long task runs under. Shipped as `const` recipes, not `agent_recipes` rows, so
//! nobody can widen their tool groups at run time; a household's own saved roles may also work a
//! step, under the same subagent narrowing.
use crate::shared::domain::orchestration::{AgentRole, RoleError, ROLE_YAML_KEY};

/// Tools a helper uses on a long task's ledger, withheld from every top-level turn.
pub const TASK_WORK_EXTENSION: &str = "giap-task-work";

pub const PLANNER_ROLE: &str = "long-task-planner";
pub const WORKER_ROLE: &str = "long-task-worker";
pub const VERIFIER_ROLE: &str = "long-task-verifier";

/// Reads and writes nothing but the plan: a planner that could act would skip its own plan.
pub const PLANNER_ROLE_RECIPE: &str = r#"
version: 1.0.0
title: Long-task planner
description: Breaks a long task into steps small enough for one sitting each.
giap_role:
  tool_groups:
    - giap-task-work
  personal_data: inherit
  max_turns: 4
  instructions: |
    You plan a long task for a household. The task is too big for one sitting, so it runs as
    steps, one after another. Each step is done by a helper that starts fresh and sees only what
    its step gives it.

    Write the plan by calling plan_write once with every step that is still to do. Each step has:
      key: short, lowercase letters, digits and dashes, unique in the task
      role: one of the roles the brief lists
      instructions: what this step must do, complete on their own
      inputs: ids of artifacts this step needs, from the brief, or []
      depends_on: keys of steps that must finish first, or []
      acceptance: one sentence a checker can verify, or leave it out

    A good step answers one question, reads one part of one document, or writes one draft.
    Split long reading across steps. A later step sees an earlier step's work only through
    artifacts, so say in each step what it must save. The last step saves the answer for the
    person as an artifact titled "Result".

    When the brief lists finished steps, plan only what is left and never redo them. When a step
    failed, the brief says why: plan around it. If plan_write refuses the plan, fix what it names
    and call it again.
"#;

/// The general hand: reads and researches, saves what it finds, and reports.
pub const WORKER_ROLE_RECIPE: &str = r#"
version: 1.0.0
title: Long-task worker
description: Does one step of a long task and saves what later steps need.
giap_role:
  tool_groups:
    - giap-task-work
    - giap-knowledge
    - giap-memory
    - giap-weather
  personal_data: inherit
  max_turns: 8
  instructions: |
    You are doing one step of a longer task. The brief gives the task's goal, your step's
    instructions, and the artifacts you may read, each with an id, a title and a one-line summary.

    1. Read only what your step needs. artifact_read pages through a long artifact; ask for the
       next part rather than all of it.
    2. Do the step with your tools.
    3. Save what later steps need with artifact_write: a short title, a one-line summary, and the
       body.
    4. Finish with step_report: outcome "completed" or "failed", a summary of a few sentences, and
       why, if it failed.

    Do only your step. You cannot reach the person, so do not ask them anything.
"#;

/// Checks one step against its acceptance sentence; reads, never redoes.
pub const VERIFIER_ROLE_RECIPE: &str = r#"
version: 1.0.0
title: Long-task verifier
description: Checks whether one step of a long task met its acceptance check.
giap_role:
  tool_groups:
    - giap-task-work
  personal_data: inherit
  max_turns: 3
  instructions: |
    You check whether one step of a task met its acceptance check. The brief gives the check, the
    step's report and the artifacts it saved. Read what you need, then call step_report: outcome
    "completed" if the check is met, or "failed" with the reason if it is not. Do not redo the
    step's work.
"#;

fn shipped(name: &str, recipe: &str) -> Result<AgentRole, RoleError> {
    AgentRole::from_recipe_yaml(name, recipe)?.ok_or(RoleError::Yaml {
        role: name.to_string(),
        message: format!("the shipped recipe has no `{ROLE_YAML_KEY}` block"),
    })
}

pub fn planner_role() -> Result<AgentRole, RoleError> {
    shipped(PLANNER_ROLE, PLANNER_ROLE_RECIPE)
}

pub fn worker_role() -> Result<AgentRole, RoleError> {
    shipped(WORKER_ROLE, WORKER_ROLE_RECIPE)
}

pub fn verifier_role() -> Result<AgentRole, RoleError> {
    shipped(VERIFIER_ROLE, VERIFIER_ROLE_RECIPE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_shipped_role_parses_and_can_reach_the_ledger() {
        for (name, role) in [
            (PLANNER_ROLE, planner_role()),
            (WORKER_ROLE, worker_role()),
            (VERIFIER_ROLE, verifier_role()),
        ] {
            let role = role.unwrap_or_else(|e| panic!("{name} does not parse: {e}"));
            assert_eq!(role.name(), name);
            assert!(
                role.requested_tool_groups().contains(TASK_WORK_EXTENSION),
                "{name} cannot read or report on its task"
            );
        }
    }

    #[test]
    fn only_the_worker_reaches_beyond_the_ledger() {
        for role in [planner_role().unwrap(), verifier_role().unwrap()] {
            assert_eq!(
                role.requested_tool_groups().len(),
                1,
                "{} must not act: a planner or checker with tools does the work itself",
                role.name()
            );
        }
        assert!(
            worker_role().unwrap().requested_tool_groups().len() > 1,
            "the worker needs tools, or the check above proves nothing"
        );
    }
}
