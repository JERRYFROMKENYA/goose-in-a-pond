// Connects a PlayerAdapter to the host. The host relays commands from extensions over a
// server-sent stream; this runs each on the adapter, always answers, and reports what is
// playing. It knows no service: whichever adapter it is handed is the whole story.

import {
  PlayerError,
  type ItemKind,
  type ItemRef,
  type LibraryKind,
  type PlayerAdapter,
  type PlayerCommand,
  type PlayerReply,
  type PlayerState,
  type RepeatMode,
} from "./types";
import type { SseFrame } from "./sse";

/** The slice of the API client the bridge uses, so a test can stand in for the server. */
export interface BridgeApi {
  streamPlayerEvents(
    service: string,
    signal: AbortSignal,
  ): AsyncIterable<SseFrame>;
  playerReply(reply: PlayerReply): Promise<unknown>;
  playerState(service: string, state: PlayerState): Promise<unknown>;
}

export interface BridgeOptions {
  /** Waits between reconnects, in order; the last repeats. */
  retryMs?: number[];
  /** Least gap between reports that differ only in the playback position. */
  positionEveryMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string, detail?: unknown) => void;
}

const DEFAULT_RETRY_MS = [1_000, 2_000, 5_000, 15_000, 30_000];
const DEFAULT_POSITION_EVERY_MS = 2_000;

const KINDS: ItemKind[] = ["song", "album", "playlist"];

function bad(message: string): PlayerError {
  return new PlayerError("bad_request", message);
}

function text(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw bad(`${key} must be a non-empty string.`);
  }
  return v;
}

function whole(
  args: Record<string, unknown>,
  key: string,
  fallback?: number,
): number {
  const v = args[key];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw bad(`${key} must be a number.`);
  }
  return v;
}

function ref(args: Record<string, unknown>): ItemRef {
  const kind = (args.kind ?? "song") as ItemKind;
  if (!KINDS.includes(kind)) throw bad(`kind must be one of ${KINDS.join(", ")}.`);
  return { id: text(args, "id"), kind };
}

function sameButPosition(a: PlayerState, b: PlayerState): boolean {
  return JSON.stringify({ ...a, position_ms: 0 }) ===
    JSON.stringify({ ...b, position_ms: 0 });
}

export class PlayerBridge {
  private stopped = true;
  private controller: AbortController | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastSent: PlayerState | null = null;
  private lastSentAt = 0;

  private readonly retryMs: number[];
  private readonly positionEveryMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string, detail?: unknown) => void;

  constructor(
    private readonly adapter: PlayerAdapter,
    private readonly api: BridgeApi,
    opts: BridgeOptions = {},
  ) {
    this.retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
    this.positionEveryMs = opts.positionEveryMs ?? DEFAULT_POSITION_EVERY_MS;
    this.now = opts.now ?? Date.now;
    this.sleep =
      opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = opts.log ?? (() => undefined);
  }

  /** Begins listening; returns at once and keeps reconnecting until `stop`. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribe = this.adapter.onState((s) => void this.report(s, false));
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      const controller = new AbortController();
      this.controller = controller;
      try {
        for await (const frame of this.api.streamPlayerEvents(
          this.adapter.service,
          controller.signal,
        )) {
          attempt = 0;
          if (frame.event === "ready") {
            this.lastSent = null;
            await this.report(this.adapter.state(), true);
          } else if (frame.event === "command") {
            void this.execute(frame.data);
          }
        }
      } catch (error) {
        if (this.stopped) return;
        this.log("the command stream failed", error);
      }
      if (this.stopped) return;
      const wait = this.retryMs[Math.min(attempt, this.retryMs.length - 1)] ?? 1_000;
      attempt += 1;
      await this.sleep(wait);
    }
  }

  /** Every command gets an answer, or the extension waits out a timeout for nothing. */
  private async execute(raw: string): Promise<void> {
    let command: PlayerCommand;
    try {
      command = JSON.parse(raw) as PlayerCommand;
    } catch {
      this.log("a command was not JSON", raw.slice(0, 120));
      return;
    }
    if (typeof command.id !== "string") return;

    let reply: PlayerReply;
    try {
      const result = await this.handle(command.op, command.args ?? {});
      reply = { id: command.id, ok: true, result };
    } catch (error) {
      reply =
        error instanceof PlayerError
          ? { id: command.id, ok: false, error: error.message, code: error.code }
          : {
              id: command.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              code: "player_error",
            };
    }
    try {
      await this.api.playerReply(reply);
    } catch (error) {
      this.log("could not deliver a reply", error);
    }
  }

  /** Runs one op on the adapter. Exposed for tests. */
  async handle(op: string, args: Record<string, unknown>): Promise<unknown> {
    const a = this.adapter;
    switch (op) {
      case "state":
        return a.state();
      case "search":
        return {
          tracks: await a.search(text(args, "query"), {
            limit: whole(args, "limit", 5),
          }),
        };
      case "play":
        await a.play(ref(args));
        return { state: a.state() };
      case "enqueue": {
        const where = args.where === "next" ? "next" : "last";
        await a.enqueue(ref(args), where);
        return {};
      }
      case "resume":
        await a.resume();
        return {};
      case "pause":
        await a.pause();
        return {};
      case "next":
        await a.next();
        return {};
      case "previous":
        await a.previous();
        return {};
      case "seek":
        await a.seek(whole(args, "position_ms"));
        return {};
      case "volume":
        await a.setVolume(whole(args, "percent"));
        return {};
      case "shuffle":
        await a.setShuffle(args.enabled === true);
        return {};
      case "repeat": {
        const mode = args.mode as RepeatMode;
        if (!["off", "one", "all"].includes(mode)) {
          throw bad("mode must be off, one or all.");
        }
        await a.setRepeat(mode);
        return {};
      }
      case "playlists":
        return { playlists: await a.playlists() };
      case "library": {
        const kind = (args.kind ?? "saved") as LibraryKind;
        if (kind !== "saved" && kind !== "recent") {
          throw bad("kind must be saved or recent.");
        }
        return { tracks: await a.library(kind, whole(args, "limit", 20)) };
      }
      case "device":
        if (!a.device) {
          throw new PlayerError("unsupported", `${a.label} has no device to play to.`);
        }
        return a.device();
      case "authorize":
        throw new PlayerError(
          "needs_authorization",
          `Sign in to ${a.label} on the music player page; it cannot be done from a command.`,
        );
      default:
        throw new PlayerError("unsupported", `The player has no "${op}" command.`);
    }
  }

  /** Reports state to the host; a change in position alone is sent at most every couple of seconds. */
  private async report(state: PlayerState, force: boolean): Promise<void> {
    if (this.stopped) return;
    const at = this.now();
    if (
      !force &&
      this.lastSent &&
      sameButPosition(this.lastSent, state) &&
      at - this.lastSentAt < this.positionEveryMs
    ) {
      return;
    }
    this.lastSent = state;
    this.lastSentAt = at;
    try {
      await this.api.playerState(this.adapter.service, state);
    } catch (error) {
      this.log("could not report state", error);
    }
  }
}
