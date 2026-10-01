import { describe, expect, it } from "vitest";
import { playerView, splitAdvanced, type PlayerReply } from "./signInView";
import type { PlayerState } from "../player/types";

function state(over: Partial<PlayerState> = {}): PlayerState {
  return {
    service: "apple",
    ready: false,
    need: "authorization",
    status: "idle",
    track: null,
    position_ms: 0,
    volume: 100,
    shuffle: false,
    repeat: "off",
    ...over,
  };
}
const reply = (over: Partial<PlayerState> = {}, attached = true): PlayerReply => ({
  attached,
  state: state(over),
});
const view = (r: PlayerReply | null) => playerView({ label: "Apple Music", reply: r });

describe("playerView", () => {
  it("says the player is not open when no page is attached, or the pond could not be asked", () => {
    for (const r of [null, reply({}, false), { attached: true, state: null }]) {
      const v = view(r);
      expect(v.kind).toBe("closed");
      expect("note" in v && v.note).toMatch(/not open/);
      expect("note" in v && v.note).toMatch(/sign in to Apple Music on that page/);
    }
  });

  it("points at the page's Sign in button while the page waits for one", () => {
    expect(view(reply({ need: "authorization" }))).toEqual({
      kind: "needs_sign_in",
      note: "Press Sign in to Apple Music on the music player page.",
    });
  });

  it("passes on the page's own words when a sign-in failed there", () => {
    expect(view(reply({ need: "authorization", message: "The Apple Music sign-in did not finish." }))).toEqual({
      kind: "needs_sign_in",
      note: "The Apple Music sign-in did not finish.",
    });
  });

  it("says why when the service is not set up on this pond", () => {
    expect(view(reply({ need: "setup", message: "Add your Team ID." }))).toEqual({
      kind: "unavailable",
      note: "Add your Team ID.",
    });
    expect(view(reply({ need: "setup" }))).toMatchObject({ kind: "unavailable" });
  });

  it("points at the page's Play here button while the page waits for a click", () => {
    expect(playerView({ label: "Spotify", reply: reply({ need: "interaction" }) })).toEqual({
      kind: "needs_click",
      note: "Press Play Spotify here on the music player page.",
    });
  });

  it("is signed in once the page says the service needs nothing", () => {
    expect(view(reply({ need: "none", ready: true }))).toEqual({ kind: "signed_in" });
  });
});

describe("splitAdvanced", () => {
  it("separates advanced fields and keeps each group's order", () => {
    const fields = [
      { key: "A" },
      { key: "B", advanced: true },
      { key: "C", advanced: false },
      { key: "D", advanced: true },
    ];
    const { ordinary, advanced } = splitAdvanced(fields);
    expect(ordinary.map((f) => f.key)).toEqual(["A", "C"]);
    expect(advanced.map((f) => f.key)).toEqual(["B", "D"]);
  });

  it("treats a field with no flag as ordinary, which is what every other extension has", () => {
    expect(splitAdvanced<{ key: string; advanced?: boolean }>([{ key: "X" }]).ordinary).toHaveLength(1);
  });
});
