import type { ServiceId } from "./types.js";

/** Where the assistant's music plays, when it has a service: the player page, or the service's app. */
export type Player = "page" | "app";

export interface Choice {
  /** Null: no music service is offered to the assistant here. */
  service: ServiceId | null;
  player: Player;
  /** Why, for the log and for the assistant: a missing service is otherwise invisible. */
  reason: string;
}

/**
 * What the household chose on the Extensions page (`MUSIC_SERVICE` and `MUSIC_PLAYER`), as the
 * assistant can use it. Apple Music is the default, and plays on a Mac only. Spotify is never offered
 * to the assistant: Spotify's Developer Policy forbids an app that controls Spotify by voice (III.3),
 * and its Developer Terms forbid feeding Spotify content into an AI model (IV.2.a.i), which every tool
 * result would do. So a household that chose Spotify plays it by hand, and the assistant says why.
 */
export function chooseService(
  platform: string,
  env: { MUSIC_SERVICE?: string; MUSIC_PLAYER?: string } = {},
): Choice {
  const player: Player = env.MUSIC_PLAYER?.trim() === "app" ? "app" : "page";
  if (env.MUSIC_SERVICE?.trim() === "spotify") {
    return {
      service: null,
      player,
      reason: "Spotify is this household's music service, and Spotify cannot be controlled by the assistant",
    };
  }
  if (platform !== "darwin") {
    return { service: null, player, reason: "Apple Music needs macOS" };
  }
  return {
    service: "apple",
    player,
    reason: player === "app" ? "Apple Music, in the Music app" : "Apple Music, on the music player page",
  };
}

/** What the assistant is told when it has no music tools, so it can say why instead of guessing. */
export function noMusicInstructions(choice: Choice): string {
  const spotify =
    "Spotify is never controlled by the assistant, because Spotify's developer rules do not allow " +
    "voice or AI control of Spotify: the person plays it in the Spotify app, or in Goose In A Pond's " +
    "Spotify player page, and controls it with the app's music controls.";
  const lead = choice.reason.startsWith("Spotify")
    ? "This household chose Spotify as its music service."
    : "No music service can be controlled by the assistant on this computer: Apple Music needs a Mac.";
  return `${lead} ${spotify} If they ask you to play or control music, tell them that, in a sentence.`;
}
