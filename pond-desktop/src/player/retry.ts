import type { PlayerAdapter } from "./types";

/**
 * The window opens before the user has added a key, and saving the key does not reopen it, so an
 * adapter that came up needing setup is asked again until it no longer does. Returns a stop.
 */
export function retrySetup(
  adapter: PlayerAdapter,
  opts: { intervalMs?: number } = {},
): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running || adapter.state().need !== "setup") return;
    running = true;
    try {
      await adapter.init();
    } finally {
      running = false;
    }
  }, opts.intervalMs ?? 10_000);
  return () => clearInterval(timer);
}
