// Live picture-support status for the active chat model. Polls for the component's life (a
// download can start outside this tab): fast while something is in motion, never while hidden.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./PondApiClient";
import type { VisionStatus } from "./types";

const FAST_POLL_MS = 2_000;
const SLOW_POLL_MS = 30_000;
/** An unlisted kind is treated as unknown (fail open), so a newer server can't break attach. */
const KNOWN_KINDS = new Set([
  "unknown",
  "not_declared",
  "not_on_this_device",
  "absent",
  "verifying",
  "downloading",
  "ready",
  "failed",
  "blocked",
]);
/** Poll fast while something is actually in motion; slow otherwise. */
const FAST_KINDS = new Set(["absent", "downloading", "verifying"]);

export interface UseVisionStatus {
  status: VisionStatus | null;
  /** Re-ask now, e.g. after a model switch (mesh included) or a restored 409. */
  refresh: () => void;
}

export function useVisionStatus(): UseVisionStatus {
  const [status, setStatus] = useState<VisionStatus | null>(null);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleRef = useRef<(s: VisionStatus | null) => void>(() => {});
  const tickRef = useRef<() => void>(() => {});

  scheduleRef.current = (s: VisionStatus | null) => {
    if (cancelledRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    const delay = s && FAST_KINDS.has(s.state.kind) ? FAST_POLL_MS : SLOW_POLL_MS;
    timerRef.current = setTimeout(() => {
      // Hidden: skip the fetch and re-check next tick (no visibilitychange listener to tear down).
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        scheduleRef.current(s);
        return;
      }
      tickRef.current();
    }, delay);
  };

  tickRef.current = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // A partial api mock may lack the method; a sync throw degrades like a failed request.
    let call: Promise<VisionStatus>;
    try {
      call = api.getVisionStatus();
    } catch {
      if (!cancelledRef.current) setStatus(null);
      return;
    }
    call
      .then((s) => {
        if (cancelledRef.current) return;
        // request<T> may return undefined or an HTML shell, and the E2E models/** catch-all {status:"ok"}.
        if (!s || typeof s !== "object" || !s.state || !KNOWN_KINDS.has(s.state.kind)) {
          setStatus(null);
          scheduleRef.current(null);
          return;
        }
        setStatus(s);
        scheduleRef.current(s);
      })
      .catch(() => {
        if (cancelledRef.current) return;
        setStatus(null);
        scheduleRef.current(null);
      });
  };

  const refresh = useCallback(() => {
    tickRef.current();
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    tickRef.current();
    return () => {
      cancelledRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { status, refresh };
}
