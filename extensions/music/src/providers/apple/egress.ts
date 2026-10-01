import { describeError, log } from "../../log.js";

export type Fetch = typeof fetch;

/** The host's network policy refused this call; the message is its own explanation. */
export class EgressRefused extends Error {}

/**
 * Asks the host to authorise and record each outbound call, so `network_mode` and the Logs
 * screen cover this extension. Only an explicit refusal stops a call: a host that cannot be
 * reached or does not know the route (an older build, a standalone `npm start`) must not
 * silence the extension.
 */
export class EgressGate {
  constructor(
    private readonly fetchFn: Fetch,
    private readonly hostUrl: string,
    private readonly internalToken: string,
    private readonly extension = "music",
  ) {}

  async allow(url: string, method = "GET"): Promise<void> {
    if (!this.internalToken) {
      log.debug("egress_check_skipped", "no internal token, so no host to ask", { url });
      return;
    }

    let resp: Response;
    try {
      resp = await this.fetchFn(`${this.hostUrl}/api/v1/extension/egress`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.internalToken}`,
        },
        body: JSON.stringify({ url, method, extension: this.extension }),
        signal: AbortSignal.timeout(3_000),
      });
    } catch (error) {
      log.debug("egress_check_unreachable", "could not ask the host about an outbound call", {
        error: describeError(error),
      });
      return;
    }

    if (!resp.ok) {
      log.warn("egress_check_rejected", "the host did not accept the egress check", {
        status: resp.status,
      });
      return;
    }

    const verdict = (await resp.json().catch(() => ({}))) as { allowed?: boolean; reason?: string };
    if (verdict.allowed === false) {
      throw new EgressRefused(verdict.reason || "The network policy refused this call.");
    }
  }
}
