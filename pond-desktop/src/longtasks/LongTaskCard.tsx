import { useState } from "react";
import { AlertCircle, AlertTriangle, Check, CircleSlash, Clock, Loader2, Pause } from "lucide-react";
import "./longTasks.css";
import { api } from "../api/PondApiClient";
import type { LongTask, LongTaskArtifactBody, LongTaskState } from "../api/types";
import { MarkdownText } from "../components/MarkdownText";
import { useConfirm } from "../components/shared";
import { isEnded, resultLine, resultOf, stepAgent, stepWords, taskWords } from "./longTaskWords";
import type { LongTasksState } from "./useLongTasks";

function StateIcon({ state }: { state: LongTaskState }) {
  const props = { size: 14, "aria-hidden": true as const };
  switch (state) {
    case "planning":
    case "running":
      return <Loader2 {...props} className="animate-spin" />;
    case "awaiting_approval":
      return <Clock {...props} />;
    case "paused":
      return <Pause {...props} />;
    case "completed":
      return <Check {...props} />;
    case "failed":
      return <AlertTriangle {...props} />;
    case "cancelled":
      return <CircleSlash {...props} />;
  }
}

type Reading =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "open"; artifact: LongTaskArtifactBody }
  | { status: "failed"; message: string };

interface Props {
  id: string;
  longTasks: LongTasksState;
  /** Classic is dense for a mouse; the hub takes the touch sizes. */
  variant: "classic" | "hub";
}

/** A working note on one long task: what it is for, how far it has got, who is on each step, and its result. */
export function LongTaskCard({ id, longTasks, variant }: Props) {
  const confirm = useConfirm();
  const [reading, setReading] = useState<Reading>({ status: "idle" });
  const task: LongTask | undefined = longTasks.tasks[id];

  if (!task) {
    if (longTasks.gone[id]) {
      return (
        <div className={`lt lt--${variant} lt--quiet`}>
          <p className="lt__note">This task is no longer on the pond.</p>
        </div>
      );
    }
    const why = longTasks.unreadable[id];
    return (
      <div className={`lt lt--${variant} lt--quiet`} aria-busy={why === undefined}>
        <p className="lt__note">{why === undefined ? "Checking on this task..." : "Couldn't check on this task just now."}</p>
        {why !== undefined ? (
          <button type="button" className="ink-btn ink-btn--quiet lt__btn" onClick={() => longTasks.retry(id)}>
            Try again
          </button>
        ) : null}
      </div>
    );
  }

  const ended = isEnded(task.state);
  const stopping = longTasks.stopping[id] === true;
  const stopError = longTasks.stopErrors[id];
  const result = task.state === "completed" ? resultOf(task) : null;

  async function onStop() {
    const ok = await confirm("Stop this task? A step that is already under way finishes first.", {
      title: "Stop task",
      confirmLabel: "Stop task",
      destructive: true,
    });
    if (ok) await longTasks.stop(id);
  }

  async function onRead(artifactId: string) {
    if (reading.status === "open") {
      setReading({ status: "idle" });
      return;
    }
    setReading({ status: "loading" });
    try {
      setReading({ status: "open", artifact: await api.getLongTaskArtifact(id, artifactId) });
    } catch (e) {
      setReading({ status: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    // The thread is a polite live region; only the state line speaks, so step and summary churn stays quiet.
    <div className={`lt lt--${variant}`} role="group" aria-label={`Long task: ${task.goal}`} aria-live="off" data-state={task.state}>
      <div className="lt__head">
        <StateIcon state={task.state} />
        <p className="lt__goal">{task.goal}</p>
      </div>
      <p className="lt__state" aria-live="polite">
        {taskWords(task)}
      </p>

      {task.steps.length > 0 ? (
        <ol className="lt__steps">
          {task.steps.map((step) => (
            <li key={step.key} className="lt__step" data-state={step.state}>
              <span className="lt__agent">{stepAgent(step)}</span>
              <span className="lt__stepstate">
                {stepWords(step.state)}
                {step.attempts > 1 ? ` (attempt ${step.attempts})` : ""}
              </span>
              {step.failure ? <span className="lt__failure">{step.failure}</span> : null}
              {step.summary ? <span className="lt__summary">{step.summary}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}

      {result ? <p className="lt__resultline">{resultLine(result)}</p> : null}

      <div className="lt__actions">
        {result ? (
          <button
            type="button"
            className="ink-btn ink-btn--quiet lt__btn"
            disabled={reading.status === "loading"}
            onClick={() => void onRead(result.id)}
          >
            {reading.status === "open" ? "Hide the result" : reading.status === "loading" ? "Opening..." : "Read the result"}
          </button>
        ) : null}
        {!ended ? (
          <button
            type="button"
            className="ink-btn ink-btn--quiet lt__btn"
            disabled={stopping}
            aria-label={`Stop the task: ${task.goal}`}
            onClick={() => void onStop()}
          >
            {stopping ? "Stopping..." : "Stop"}
          </button>
        ) : null}
      </div>

      {stopError ? (
        <p className="lt__error" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          <span>{stopError}</span>
        </p>
      ) : null}
      {reading.status === "failed" ? (
        <p className="lt__error" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          <span>Couldn't open the result. {reading.message}</span>
        </p>
      ) : null}
      {reading.status === "open" ? (
        <div className="lt__result">
          <h4 className="lt__resulttitle">{reading.artifact.title}</h4>
          <MarkdownText source={reading.artifact.body} />
        </div>
      ) : null}
    </div>
  );
}
