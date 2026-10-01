import { useEffect, useState } from "react";
import type { PlayerAdapter, PlayerState } from "./types";

/** The adapter's state, kept current for as long as the component is mounted. */
export function usePlayerState(adapter: PlayerAdapter): PlayerState {
  const [state, setState] = useState(adapter.state());
  useEffect(() => {
    setState(adapter.state());
    return adapter.onState(setState);
  }, [adapter]);
  return state;
}
