import { describeError } from "../../log.js";
import type { Fetch } from "../apple/egress.js";

/** Why the host could not get a command answered by a page. */
export type UnavailableCode =
  | "no_player"
  | "timeout"
  | "refused"
  | "player_replaced"
  | "player_gone"
  | "host_unreachable";

const HOST_CODES = new Set<string>([
  "no_player",
  "timeout",
  "refused",
  "player_replaced",
  "player_gone",
]);

/** The command never reached a page that could answer it, or the page did not answer in time. */
export class PlayerUnavailable extends Error {
  constructor(
    readonly code: UnavailableCode,
    message: string,
  ) {
    super(message);
    this.name = "PlayerUnavailable";
  }
}

/** The page answered, and the answer was no; `code` is the page's own. */
export class PlayerFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PlayerFailure";
  }
}

export interface PlayerStatus {
  attached: boolean;
  configured: boolean;
}

/** What a provider needs of the player: send a command, and ask whether one is there. */
export interface PlayerHost {
  call<T = unknown>(op: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  status(): Promise<PlayerStatus | null>;
}

const DEFAULT_WAIT_MS = 20_000;
/** The host answers a timeout itself, so the request must outlast the wait it was asked to make. */
const HOST_SLACK_MS = 5_000;

/** The host's player bridge, spoken to as an extension: with the internal token, over loopback. */
export class HostPlayer implements PlayerHost {
  constructor(
    private readonly fetchFn: Fetch,
    private readonly hostUrl: string,
    private readonly internalToken: string,
    readonly service: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.internalToken}`,
    };
  }

  async call<T = unknown>(
    op: string,
    args: Record<string, unknown> = {},
    timeoutMs: number = DEFAULT_WAIT_MS,
  ): Promise<T> {
    let resp: Response;
    try {
      resp = await this.fetchFn(`${this.hostUrl}/api/v1/player/command`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ service: this.service, op, args, timeout_ms: timeoutMs }),
        signal: AbortSignal.timeout(timeoutMs + HOST_SLACK_MS),
      });
    } catch (error) {
      throw new PlayerUnavailable(
        "host_unreachable",
        `Could not reach Goose In A Pond: ${describeError(error)}`,
      );
    }

    if (!resp.ok) {
      throw new PlayerUnavailable(
        "host_unreachable",
        resp.status === 401
          ? "Goose In A Pond did not accept this extension's token."
          : `Goose In A Pond answered ${resp.status}.`,
      );
    }

    const body = (await resp.json()) as {
      ok: boolean;
      result?: T;
      error?: string;
      code?: string;
    };
    if (body.ok) return body.result as T;

    const code = body.code ?? "player_error";
    const message = body.error ?? "The music player reported an error.";
    if (HOST_CODES.has(code)) throw new PlayerUnavailable(code as UnavailableCode, message);
    throw new PlayerFailure(code, message);
  }

  /** Null when the host cannot be asked: the caller then works without the player. */
  async status(): Promise<PlayerStatus | null> {
    try {
      const resp = await this.fetchFn(`${this.hostUrl}/api/v1/player/status`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(2_000),
      });
      if (!resp.ok) return null;
      const all = (await resp.json()) as Record<string, PlayerStatus | undefined>;
      return all[this.service] ?? null;
    } catch {
      return null;
    }
  }
}
