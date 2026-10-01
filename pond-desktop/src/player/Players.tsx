import { PlayerApp } from "./PlayerApp";
import type { PlayerAdapter } from "./types";
import { usePlayerStates } from "./usePlayerStates";

/**
 * Every service this window runs, but only the ones that are set up: a service waiting for its
 * key or its sign-in would otherwise sit beside the one that needs the person. When none is set
 * up, all are shown, so each says what it is waiting for.
 */
export function Players({ adapters }: { adapters: PlayerAdapter[] }) {
  const states = usePlayerStates(adapters);
  const live = adapters.filter((_, i) => states[i]?.need !== "setup");
  const shown = live.length > 0 ? live : adapters;
  return (
    <>
      {shown.map((adapter) => (
        <PlayerApp key={adapter.service} adapter={adapter} />
      ))}
    </>
  );
}
