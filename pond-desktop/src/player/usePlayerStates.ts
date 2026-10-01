import { useEffect, useState } from "react";
import type { PlayerAdapter, PlayerState } from "./types";

/** The state of every adapter, in order, for a page that runs more than one service. */
export function usePlayerStates(adapters: PlayerAdapter[]): PlayerState[] {
  const [states, setStates] = useState(() => adapters.map((a) => a.state()));
  useEffect(() => {
    setStates(adapters.map((a) => a.state()));
    const stops = adapters.map((adapter, index) =>
      adapter.onState((next) =>
        setStates((prev) => prev.map((s, i) => (i === index ? next : s))),
      ),
    );
    return () => stops.forEach((stop) => stop());
  }, [adapters]);
  return states;
}
