// jsdom has no layout, so the drag tests stub `clientWidth` and `scrollLeft` and assert only
// what the gesture decides; how the track looks belongs to E2E.

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WidgetTrack } from "./WidgetTrack";

beforeEach(() => {
  cleanup();
});

function pages(n: number) {
  return Array.from({ length: n }, (_, i) => <p key={i}>Page {i + 1} body</p>);
}

/** Stubbed page width; any number works. */
const PAGE_W = 300;

/**
 * Answers the two layout reads and logs each `scrollLeft` write with the snap setting at that
 * instant: once `fireEvent` returns, React has committed, so asking afterwards is too late.
 */
function mountTrack(count: number, onPageChange = vi.fn()) {
  const { container } = render(
    <WidgetTrack pages={pages(count)} page={0} onPageChange={onPageChange} />,
  );
  const el = container.querySelector<HTMLDivElement>('[data-hook="widget-track"]');
  if (!el) throw new Error("no track");

  Object.defineProperty(el, "clientWidth", { configurable: true, value: PAGE_W });
  const writes: Array<{ left: number; snap: string }> = [];
  let left = 0;
  Object.defineProperty(el, "scrollLeft", {
    configurable: true,
    get: () => left,
    set: (v: number) => {
      writes.push({ left: v, snap: el.style.scrollSnapType });
      left = v;
    },
  });
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  el.scrollTo = vi.fn();

  return { el, writes, onPageChange };
}

function down(el: HTMLElement, pointerId: number, clientX: number) {
  fireEvent.pointerDown(el, { pointerId, clientX, pointerType: "touch", button: 0 });
}

function move(el: HTMLElement, pointerId: number, clientX: number) {
  fireEvent.pointerMove(el, { pointerId, clientX, pointerType: "touch" });
}

function up(el: HTMLElement, pointerId: number, clientX: number) {
  fireEvent.pointerUp(el, { pointerId, clientX, pointerType: "touch" });
}

describe("the page dots", () => {
  it("has one per page, and marks the one showing", () => {
    render(<WidgetTrack pages={pages(3)} page={1} onPageChange={() => {}} />);
    const dots = screen.getAllByRole("button", { name: /^Page \d of 3$/ });
    expect(dots.length).toBe(3);
    expect(dots[1].getAttribute("aria-current")).toBe("true");
    expect(dots[0].getAttribute("aria-current")).toBeNull();
    expect(dots[2].getAttribute("aria-current")).toBeNull();
  });

  it("reports the page it was asked for", () => {
    const onPageChange = vi.fn();
    render(<WidgetTrack pages={pages(3)} page={0} onPageChange={onPageChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Page 3 of 3" }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("is not drawn at all for a single page", () => {
    const { container } = render(
      <WidgetTrack pages={pages(1)} page={0} onPageChange={() => {}} />,
    );
    expect(container.querySelector(".wtrack__dots")).toBeNull();
  });

  it("renders every page's contents, not only the one showing", () => {
    render(<WidgetTrack pages={pages(2)} page={0} onPageChange={() => {}} />);
    expect(screen.getByText("Page 1 body")).toBeTruthy();
    expect(screen.getByText("Page 2 body")).toBeTruthy();
  });
});

describe("the drag", () => {
  /** Mandatory snap drops a `scrollLeft` write synchronously, so snap must be off before it. */
  it("has snapping already off at the first write, not a commit later", () => {
    const { el, writes } = mountTrack(3);
    down(el, 1, 200);
    move(el, 1, 80);

    expect(writes.length).toBeGreaterThan(0);
    expect(writes[0]).toEqual({ left: 120, snap: "none" });
  });

  it("hands snapping back to the stylesheet on release", () => {
    const { el } = mountTrack(3);
    down(el, 1, 200);
    move(el, 1, 80);
    expect(el.style.scrollSnapType).toBe("none");

    up(el, 1, 80);
    expect(el.style.scrollSnapType).toBe("");
  });

  it("settles the swipe when a second finger lands on the track mid-drag", () => {
    const { el, onPageChange } = mountTrack(3);
    down(el, 1, 200);
    move(el, 1, 80);
    down(el, 2, 400);
    up(el, 1, 80);

    expect(onPageChange).toHaveBeenCalledWith(1);
    expect(el.style.scrollSnapType).toBe("");
  });

  it("ignores a move and a release that belong to the other finger", () => {
    const { el, writes, onPageChange } = mountTrack(3);
    down(el, 1, 200);
    move(el, 1, 80);
    const afterFingerA = writes.length;

    move(el, 2, 40);
    up(el, 2, 40);
    expect(writes.length).toBe(afterFingerA);
    expect(onPageChange).not.toHaveBeenCalled();
    expect(el.style.scrollSnapType).toBe("none");

    up(el, 1, 80);
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it("settles and restores snapping when capture is lost with no release", () => {
    const { el, onPageChange } = mountTrack(3);
    down(el, 1, 200);
    move(el, 1, 40);

    fireEvent.lostPointerCapture(el, { pointerId: 1, pointerType: "touch", bubbles: true });

    expect(el.style.scrollSnapType).toBe("");
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  /** A press that never crossed the threshold is a tap on whatever is inside the page. */
  it("reports nothing for a press that never became a drag", () => {
    const { el, writes, onPageChange } = mountTrack(3);
    down(el, 1, 200);
    move(el, 1, 198);
    up(el, 1, 198);

    expect(writes).toEqual([]);
    expect(onPageChange).not.toHaveBeenCalled();
    expect(el.style.scrollSnapType).toBe("");
  });
});
