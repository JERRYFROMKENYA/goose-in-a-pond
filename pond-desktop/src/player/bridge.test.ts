import { describe, expect, it, vi } from "vitest";
import { PlayerBridge, type BridgeApi } from "./bridge";
import type { SseFrame } from "./sse";
import {
  PlayerError,
  type PlayerAdapter,
  type PlayerReply,
  type PlayerState,
} from "./types";

function idle(over: Partial<PlayerState> = {}): PlayerState {
  return {
    service: "fake",
    ready: true,
    need: "none",
    status: "idle",
    track: null,
    position_ms: 0,
    volume: 50,
    shuffle: false,
    repeat: "off",
    ...over,
  };
}

/** An adapter that records what it was asked and can be told to fail. */
function fakeAdapter(over: Partial<PlayerAdapter> = {}) {
  let state = idle();
  const listeners = new Set<(s: PlayerState) => void>();
  const calls: Array<[string, ...unknown[]]> = [];
  const rec =
    (name: string, result: unknown = undefined) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  const adapter: PlayerAdapter = {
    service: "fake",
    label: "Fake Music",
    capabilities: { queue: true, playlists: true, library: true },
    init: rec("init") as PlayerAdapter["init"],
    authorize: rec("authorize") as PlayerAdapter["authorize"],
    state: () => state,
    onState: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    search: rec("search", [
      { id: "1", kind: "song", title: "t", artist: "a", album: "b", duration_ms: 1 },
    ]) as PlayerAdapter["search"],
    play: rec("play") as PlayerAdapter["play"],
    enqueue: rec("enqueue") as PlayerAdapter["enqueue"],
    resume: rec("resume") as PlayerAdapter["resume"],
    pause: rec("pause") as PlayerAdapter["pause"],
    next: rec("next") as PlayerAdapter["next"],
    previous: rec("previous") as PlayerAdapter["previous"],
    seek: rec("seek") as PlayerAdapter["seek"],
    setVolume: rec("setVolume") as PlayerAdapter["setVolume"],
    setShuffle: rec("setShuffle") as PlayerAdapter["setShuffle"],
    setRepeat: rec("setRepeat") as PlayerAdapter["setRepeat"],
    playlists: rec("playlists", [{ id: "p1", name: "Road trip" }]) as PlayerAdapter["playlists"],
    library: rec("library", []) as PlayerAdapter["library"],
    ...over,
  };
  return {
    adapter,
    calls,
    set(next: PlayerState) {
      state = next;
      listeners.forEach((l) => l(state));
    },
  };
}

/** A host whose command stream the test feeds by hand. */
function fakeHost() {
  const replies: PlayerReply[] = [];
  const states: PlayerState[] = [];
  const queue: Array<SseFrame | Error | "end"> = [];
  let wake: (() => void) | null = null;
  let connects = 0;
  let lastSignal: AbortSignal | null = null;

  const push = (item: SseFrame | Error | "end") => {
    queue.push(item);
    wake?.();
  };

  const api: BridgeApi = {
    async *streamPlayerEvents(_service, signal) {
      connects += 1;
      lastSignal = signal;
      for (;;) {
        if (signal.aborted) return;
        const next = queue.shift();
        if (next === undefined) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          continue;
        }
        if (next === "end") return;
        if (next instanceof Error) throw next;
        yield next;
      }
    },
    async playerReply(r) {
      replies.push(r);
    },
    async playerState(_service, s) {
      states.push(s);
    },
  };
  return {
    api,
    replies,
    states,
    push,
    connects: () => connects,
    aborted: () => lastSignal?.aborted ?? false,
    command: (id: string, op: string, args: Record<string, unknown> = {}) =>
      push({ event: "command", data: JSON.stringify({ id, service: "fake", op, args }) }),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await settle();
  expect(check()).toBe(true);
}

describe("PlayerBridge", () => {
  it("runs a command on the adapter and posts the answer", async () => {
    const f = fakeAdapter();
    const host = fakeHost();
    const bridge = new PlayerBridge(f.adapter, host.api);
    bridge.start();

    host.command("c1", "play", { id: "1001", kind: "song" });
    await until(() => host.replies.length === 1);

    expect(f.calls).toContainEqual(["play", { id: "1001", kind: "song" }]);
    expect(host.replies[0]).toMatchObject({ id: "c1", ok: true });
    bridge.stop();
  });

  it("reports what the adapter refused, with its code", async () => {
    const f = fakeAdapter({
      play: async () => {
        throw new PlayerError("drm_refused", "Apple refused the license.");
      },
    });
    const host = fakeHost();
    new PlayerBridge(f.adapter, host.api).start();

    host.command("c1", "play", { id: "1" });
    await until(() => host.replies.length === 1);

    expect(host.replies[0]).toEqual({
      id: "c1",
      ok: false,
      error: "Apple refused the license.",
      code: "drm_refused",
    });
  });

  it("answers an unexpected exception instead of leaving the extension waiting", async () => {
    const f = fakeAdapter({
      pause: async () => {
        throw new Error("boom");
      },
    });
    const host = fakeHost();
    new PlayerBridge(f.adapter, host.api).start();

    host.command("c1", "pause");
    await until(() => host.replies.length === 1);

    expect(host.replies[0]).toMatchObject({ ok: false, code: "player_error", error: "boom" });
  });

  it("answers a command it does not know, and one with bad arguments", async () => {
    const host = fakeHost();
    new PlayerBridge(fakeAdapter().adapter, host.api).start();

    host.command("c1", "teleport");
    host.command("c2", "seek", { position_ms: "soon" });
    host.command("c3", "play", { id: "" });
    host.command("c4", "repeat", { mode: "sideways" });
    await until(() => host.replies.length === 4);

    expect(host.replies.map((r) => r.code)).toEqual([
      "unsupported",
      "bad_request",
      "bad_request",
      "bad_request",
    ]);
  });

  it("never signs in from a command: that needs a click", async () => {
    const host = fakeHost();
    new PlayerBridge(fakeAdapter().adapter, host.api).start();
    host.command("c1", "authorize");
    await until(() => host.replies.length === 1);
    expect(host.replies[0]).toMatchObject({ ok: false, code: "needs_authorization" });
  });

  it("ignores a frame that is not a command it can answer", async () => {
    const host = fakeHost();
    new PlayerBridge(fakeAdapter().adapter, host.api).start();
    host.push({ event: "command", data: "not json" });
    host.push({ event: "command", data: JSON.stringify({ op: "pause" }) });
    host.command("c1", "pause");
    await until(() => host.replies.length === 1);
    expect(host.replies).toHaveLength(1);
  });

  it("maps each op onto the adapter", async () => {
    const f = fakeAdapter();
    const host = fakeHost();
    const bridge = new PlayerBridge(f.adapter, host.api);

    await bridge.handle("search", { query: "nairobi", limit: 3 });
    await bridge.handle("enqueue", { id: "9", kind: "song", where: "next" });
    await bridge.handle("volume", { percent: 30 });
    await bridge.handle("shuffle", { enabled: true });
    await bridge.handle("repeat", { mode: "all" });
    await bridge.handle("seek", { position_ms: 90_000 });
    await bridge.handle("library", { kind: "recent", limit: 7 });

    expect(f.calls).toEqual([
      ["search", "nairobi", { limit: 3 }],
      ["enqueue", { id: "9", kind: "song" }, "next"],
      ["setVolume", 30],
      ["setShuffle", true],
      ["setRepeat", "all"],
      ["seek", 90_000],
      ["library", "recent", 7],
    ]);
  });

  it("answers the device op for a service that plays to a device, and refuses it for one that does not", async () => {
    const withDevice = fakeAdapter({
      device: () => ({ device_id: "device-1", name: "Goose In A Pond", ready: true }),
    });
    const bridge = new PlayerBridge(withDevice.adapter, fakeHost().api);
    expect(await bridge.handle("device", {})).toEqual({
      device_id: "device-1",
      name: "Goose In A Pond",
      ready: true,
    });

    const without = new PlayerBridge(fakeAdapter().adapter, fakeHost().api);
    await expect(without.handle("device", {})).rejects.toMatchObject({ code: "unsupported" });
  });

  it("reports its state when the host says it is listening", async () => {
    const f = fakeAdapter();
    f.set(idle({ status: "paused" }));
    const host = fakeHost();
    new PlayerBridge(f.adapter, host.api).start();

    host.push({ event: "ready", data: "{}" });
    await until(() => host.states.length === 1);

    expect(host.states[0]).toMatchObject({ service: "fake", status: "paused" });
  });

  it("reports a change of track at once but throttles the position ticking", async () => {
    const f = fakeAdapter();
    const host = fakeHost();
    let clock = 0;
    const bridge = new PlayerBridge(f.adapter, host.api, {
      positionEveryMs: 2_000,
      now: () => clock,
    });
    bridge.start();
    host.push({ event: "ready", data: "{}" });
    await until(() => host.states.length === 1);

    clock = 100;
    f.set(idle({ position_ms: 100 }));
    clock = 600;
    f.set(idle({ position_ms: 600 }));
    await settle();
    expect(host.states).toHaveLength(1);

    f.set(idle({ status: "playing", position_ms: 700 }));
    await until(() => host.states.length === 2);

    clock = 3_000;
    f.set(idle({ status: "playing", position_ms: 3_000 }));
    await until(() => host.states.length === 3);
  });

  it("reconnects after the stream drops, and starts the wait over once it is healthy", async () => {
    const host = fakeHost();
    const sleeps: number[] = [];
    const bridge = new PlayerBridge(fakeAdapter().adapter, host.api, {
      retryMs: [10, 20, 30],
      sleep: async (ms) => void sleeps.push(ms),
    });
    host.push(new Error("network down"));
    host.push(new Error("still down"));
    host.push({ event: "ready", data: "{}" });
    host.push("end");
    host.push(new Error("down again"));
    bridge.start();

    await until(() => sleeps.length >= 4);
    bridge.stop();

    // Two failures step the wait up; a healthy connection resets it; the next failure steps again.
    expect(sleeps.slice(0, 4)).toEqual([10, 20, 10, 20]);
    expect(host.connects()).toBeGreaterThanOrEqual(4);
  });

  it("stops: aborts the stream and stops reporting", async () => {
    const f = fakeAdapter();
    const host = fakeHost();
    const bridge = new PlayerBridge(f.adapter, host.api);
    bridge.start();
    await until(() => host.connects() === 1);

    bridge.stop();
    await settle();
    expect(host.aborted()).toBe(true);

    f.set(idle({ status: "playing" }));
    await settle();
    expect(host.states).toHaveLength(0);
  });

  it("a delivery failure is logged, not thrown", async () => {
    const log = vi.fn();
    const host = fakeHost();
    host.api.playerReply = async () => {
      throw new Error("offline");
    };
    new PlayerBridge(fakeAdapter().adapter, host.api, { log }).start();
    host.command("c1", "pause");
    await until(() => log.mock.calls.some((c) => /reply/.test(String(c[0]))));
  });
});
