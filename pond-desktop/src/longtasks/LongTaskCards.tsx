import "./longTasks.css";
import { LongTaskCard } from "./LongTaskCard";
import { strayTasks } from "./longTaskWords";
import type { LongTasksState } from "./useLongTasks";

interface CardsProps {
  ids: readonly string[] | undefined;
  longTasks: LongTasksState;
  variant: "classic" | "hub";
}

/** The cards for the tasks one message started, drawn where its `task_start` call was. */
export function LongTaskCards({ ids, longTasks, variant }: CardsProps) {
  if (!longTasks.supported || !ids || ids.length === 0) return null;
  return (
    <>
      {ids.map((id) => (
        <LongTaskCard key={id} id={id} longTasks={longTasks} variant={variant} />
      ))}
    </>
  );
}

interface StraysProps {
  anchored: ReadonlySet<string>;
  longTasks: LongTasksState;
  variant: "classic" | "hub";
}

/** Tasks the pond lists for this conversation that no message points at, so a reopened chat still shows them. */
export function LongTaskStrays({ anchored, longTasks, variant }: StraysProps) {
  if (!longTasks.supported) return null;
  const strays = strayTasks(longTasks.tasks, anchored);
  if (strays.length === 0) return null;
  return (
    <section className="lt__group" aria-label="Long tasks in this conversation">
      <p className="lt__grouplabel">Long tasks in this conversation</p>
      {strays.map((task) => (
        <LongTaskCard key={task.id} id={task.id} longTasks={longTasks} variant={variant} />
      ))}
    </section>
  );
}
