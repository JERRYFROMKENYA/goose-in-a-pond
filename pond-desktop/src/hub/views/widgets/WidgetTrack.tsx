// Home's pages and the swipe between them. Not a CSS scroller: mandatory snap re-snaps every
// `scrollLeft` write, so a drag turns snap off by inline style (state would commit after Chrome
// discards the first write) and clears it to hand snap back to the stylesheet.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import "./widget-track.css";

/** Travel in px that counts as a swipe wherever it ended: a short fast flick still means "next". */
const FLICK_PX = 48;

/**
 * Travel in px before a press becomes a drag. Capture waits for it because capture also
 * redirects the click: taken on press, no tap would reach the widget under the finger.
 */
const DRAG_START_PX = 6;

export interface WidgetTrackProps {
  /** One entry per page, each already framed. */
  pages: ReactNode[];
  /** Which page is showing. Controlled, so the arrange sheet can jump to the page it just changed. */
  page: number;
  onPageChange: (page: number) => void;
}

/** Read per call, since the setting can change while the app runs; test DOMs may lack `matchMedia`. */
function prefersReducedMotion(): boolean {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function WidgetTrack({ pages, page, onPageChange }: WidgetTrackProps): ReactElement {
  const track = useRef<HTMLDivElement | null>(null);
  // The gesture's only source of truth; `dragging` merely renders it and must not drive decisions.
  const start = useRef<{ pointerId: number; x: number; left: number; captured: boolean } | null>(
    null,
  );
  // Last page this component reported, so an echo of it doesn't trigger a second scrollTo.
  const emitted = useRef(page);
  const [dragging, setDragging] = useState(false);
  // Consumed a render after the gesture ends, once `dragging: false` has painted (see `endGesture`).
  const [settleTo, setSettleTo] = useState<number | null>(null);

  const count = pages.length;

  // 1 before layout: callers divide by it, and 0 would report a NaN page.
  const pageWidth = useCallback(() => {
    const width = track.current?.clientWidth ?? 0;
    return width > 0 ? width : 1;
  }, []);

  /** Moves the track only; returns the clamped page. */
  const scrollToPage = useCallback(
    (i: number): number => {
      const n = Math.max(0, Math.min(count - 1, i));
      track.current?.scrollTo?.({
        left: n * pageWidth(),
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
      return n;
    },
    [count, pageWidth],
  );

  /** Reports a page the track has reached, recording it in `emitted`. */
  const emit = useCallback(
    (n: number) => {
      emitted.current = n;
      onPageChange(n);
    },
    [onPageChange],
  );

  const goToPage = useCallback(
    (i: number) => {
      emit(scrollToPage(i));
    },
    [emit, scrollToPage],
  );

  // An external page change (the arrange sheet): scroll to it without reporting it back.
  useEffect(() => {
    if (page === emitted.current) return;
    emitted.current = page;
    scrollToPage(page);
  }, [page, scrollToPage]);

  const onScroll = useCallback(() => {
    // Ignored mid-drag. Checks the ref too: a drag's first write lands before `dragging` renders.
    if (!track.current || dragging || start.current?.captured) return;
    const p = Math.round(track.current.scrollLeft / pageWidth());
    if (p !== page) emit(p);
  }, [dragging, emit, page, pageWidth]);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!track.current) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // A second finger can't take over a drag, but may replace a press that never became one.
    if (start.current?.captured) return;
    // Recorded, not captured: see DRAG_START_PX.
    start.current = {
      pointerId: e.pointerId,
      x: e.clientX,
      left: track.current.scrollLeft,
      captured: false,
    };
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s || !track.current || e.pointerId !== s.pointerId) return;
    const dx = e.clientX - s.x;
    if (!s.captured) {
      if (Math.abs(dx) < DRAG_START_PX) return;
      s.captured = true;
      track.current.setPointerCapture?.(e.pointerId);
      // Set by hand before the write below; see the header.
      track.current.style.scrollSnapType = "none";
      setDragging(true);
    }
    // 1:1, inverted: the page follows the finger.
    track.current.scrollLeft = s.left - dx;
  }, []);

  /**
   * Ends a gesture on release, cancel or lost capture; idempotent. `endX` is null for a lost
   * capture, which skips the flick check and settles to the nearest page.
   */
  const endGesture = useCallback(
    (pointerId: number, endX: number | null) => {
      const s = start.current;
      // Another finger lifting is not the end of this drag.
      if (s && pointerId !== s.pointerId) return;

      start.current = null;
      // Clearing the inline value restores the stylesheet's mandatory snap.
      if (track.current) track.current.style.scrollSnapType = "";
      setDragging(false);

      // A press that never became a drag was a tap: nothing to settle.
      if (!s || !s.captured || !track.current) return;

      const w = pageWidth();
      const from = Math.round(s.left / w);
      const dx = endX === null ? 0 : endX - s.x;
      let target = Math.round(track.current.scrollLeft / w);
      if (Math.abs(dx) > FLICK_PX && target === from) {
        target = from + (dx < 0 ? 1 : -1);
      }
      // Deferred a render: re-enabling snap mid-scrollTo jumps to a snap point mid-animation.
      setSettleTo(target);
    },
    [pageWidth],
  );

  const onPointerEnd = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => endGesture(e.pointerId, e.clientX),
    [endGesture],
  );

  // Backstop for capture lost without pointerup/pointercancel; after a normal release it's a no-op.
  const onLostCapture = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => endGesture(e.pointerId, null),
    [endGesture],
  );

  useEffect(() => {
    if (settleTo === null || dragging) return;
    setSettleTo(null);
    goToPage(settleTo);
  }, [dragging, goToPage, settleTo]);

  // Only the cursor renders from state: a frame late is cosmetic here, unlike snapping.
  const trackStyle: CSSProperties = {
    cursor: dragging ? "grabbing" : "grab",
  };

  return (
    <>
      <div
        ref={track}
        className="wtrack"
        data-hook="widget-track"
        style={trackStyle}
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onLostPointerCapture={onLostCapture}
      >
        {pages.map((contents, i) => (
          <div className="wtrack__page" key={i}>
            {contents}
          </div>
        ))}
      </div>

      {/* One page is not a set of pages. Nothing to choose between, so no dots. */}
      {count > 1 ? (
        <div className="wtrack__dots">
          {pages.map((_, i) => (
            <button
              key={i}
              type="button"
              className="wtrack__dot"
              aria-label={`Page ${i + 1} of ${count}`}
              aria-current={i === page ? "true" : undefined}
              onClick={() => goToPage(i)}
            >
              <span className="wtrack__dot-bar" />
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
