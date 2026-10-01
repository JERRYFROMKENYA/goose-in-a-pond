import type { PlayerState } from "../player/types";

/** What the player page last reported for a service, as `GET /player/state` answers it. */
export interface PlayerReply {
  attached: boolean;
  state: PlayerState | null;
}

/** What the music player row shows. `note` is a sentence for a person. */
export type PlayerView =
  | { kind: "closed"; note: string }
  | { kind: "unavailable"; note: string }
  | { kind: "needs_sign_in"; note: string }
  | { kind: "needs_click"; note: string }
  | { kind: "signed_in" };

/**
 * One decision, kept out of the component so it can be tested: given what the player page last
 * reported, what the person sees. The sign-in itself is on the page, so this only ever says where
 * to go and what the page is waiting for.
 */
export function playerView(input: {
  /** Null when the pond could not be asked. */
  reply: PlayerReply | null;
  label: string;
}): PlayerView {
  const { reply, label } = input;
  if (!reply || !reply.attached || !reply.state) {
    return {
      kind: "closed",
      note: `The music player is not open. Open it, then sign in to ${label} on that page.`,
    };
  }
  const state = reply.state;
  if (state.need === "none") return { kind: "signed_in" };
  if (state.need === "setup") {
    return {
      kind: "unavailable",
      note: state.message ?? `${label} is not set up on this pond yet.`,
    };
  }
  if (state.need === "interaction") {
    return {
      kind: "needs_click",
      note: state.message ?? `Press Play ${label} here on the music player page.`,
    };
  }
  return {
    kind: "needs_sign_in",
    note: state.message ?? `Press Sign in to ${label} on the music player page.`,
  };
}

/** Advanced fields sit apart from the ordinary ones; the order within each is the registry's. */
export function splitAdvanced<T extends { advanced?: boolean }>(
  requirements: T[],
): { ordinary: T[]; advanced: T[] } {
  return {
    ordinary: requirements.filter((r) => !r.advanced),
    advanced: requirements.filter((r) => r.advanced === true),
  };
}
