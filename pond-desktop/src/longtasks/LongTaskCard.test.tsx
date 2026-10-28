import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api/PondApiClient";
import { LongTaskCard } from "./LongTaskCard";
import { LongTaskCards, LongTaskStrays } from "./LongTaskCards";
import { artifactOf, doneTask, fakeLongTasks, OTHER_ID, stepOf, TASK_ID, taskOf } from "./longTaskFixtures";
import type { LongTask, LongTaskArtifactBody } from "../api/types";

vi.mock("../api/PondApiClient", () => ({
  api: { getLongTaskArtifact: vi.fn() },
}));

const confirmMock = vi.hoisted(() => vi.fn());
vi.mock("../components/shared", async () => {
  const actual = (await vi.importActual("../components/shared")) as Record<string, unknown>;
  return { ...actual, useConfirm: () => confirmMock };
});

beforeEach(() => {
  vi.resetAllMocks();
  confirmMock.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
});

function show(task: LongTask, over: Parameters<typeof fakeLongTasks>[0] = {}, variant: "classic" | "hub" = "classic") {
  const longTasks = fakeLongTasks({ tasks: { [task.id]: task }, stop: vi.fn(async () => {}), retry: vi.fn(), ...over });
  render(<LongTaskCard id={task.id} longTasks={longTasks} variant={variant} />);
  return longTasks;
}

const stopButton = () => screen.queryByRole("button", { name: /^Stop the task/ });

describe("a long task under way", () => {
  it("says what it is for and how far it has got", () => {
    show(taskOf());
    expect(screen.getByText("Plan a trip to Lamu")).toBeTruthy();
    expect(screen.getByText("Working: step 2 of 4")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Long task: Plan a trip to Lamu" })).toBeTruthy();
  });

  it("lets only the state line speak inside the thread's live region", () => {
    show(taskOf());
    expect(document.querySelector(".lt")?.getAttribute("aria-live")).toBe("off");
    expect(screen.getByText("Working: step 2 of 4").getAttribute("aria-live")).toBe("polite");
  });

  it("shows each step with its agent, its state and its summary", () => {
    show(taskOf());
    expect(screen.getByText("Long-task planner")).toBeTruthy();
    expect(screen.getAllByText("Long-task worker")).toHaveLength(2);
    expect(screen.getByText("Long-task verifier")).toBeTruthy();
    expect(screen.getByText("Split it into three parts.")).toBeTruthy();
    expect(screen.getAllByText("Waiting")).toHaveLength(2);
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
  });

  it("names an agent of the household's by the name it was saved under", () => {
    show(taskOf({ steps: [stepOf("a", { role: "study-planner", state: "running", attempts: 1 })] }));
    expect(screen.getByText("study-planner")).toBeTruthy();
  });

  it("says when a step is on another attempt, and why one could not finish", () => {
    show(
      taskOf({
        steps: [
          stepOf("a", { state: "running", attempts: 2 }),
          stepOf("b", { state: "failed", attempts: 3, failure: "The ferry site did not answer." }),
        ],
      }),
    );
    expect(screen.getByText("Working (attempt 2)")).toBeTruthy();
    expect(screen.getByText("Couldn't finish (attempt 3)")).toBeTruthy();
    expect(screen.getByText("The ferry site did not answer.")).toBeTruthy();
  });

  it("says Planning before it has any steps, and draws no step list", () => {
    show(taskOf({ state: "planning", steps: [] }));
    expect(screen.getByText("Planning")).toBeTruthy();
    expect(document.querySelector("ol")).toBeNull();
  });

  it("says so when it is paused or waiting on a person", () => {
    show(taskOf({ state: "paused" }));
    expect(screen.getByText("Paused")).toBeTruthy();
    cleanup();
    show(taskOf({ state: "awaiting_approval" }));
    expect(screen.getByText("Waiting for your approval")).toBeTruthy();
  });

  it("is drawn the same on the hub, with its own size class", () => {
    show(taskOf(), {}, "hub");
    expect(document.querySelector(".lt.lt--hub")).not.toBeNull();
  });
});

describe("stopping a task", () => {
  it("asks first, in words that say what happens to a step under way", async () => {
    const longTasks = show(taskOf());
    fireEvent.click(stopButton() as HTMLElement);
    await waitFor(() => expect(longTasks.stop).toHaveBeenCalledWith(TASK_ID));
    expect(confirmMock).toHaveBeenCalledWith("Stop this task? A step that is already under way finishes first.", {
      title: "Stop task",
      confirmLabel: "Stop task",
      destructive: true,
    });
  });

  it("leaves the task alone when the person says no", async () => {
    confirmMock.mockResolvedValue(false);
    const longTasks = show(taskOf());
    fireEvent.click(stopButton() as HTMLElement);
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(longTasks.stop).not.toHaveBeenCalled();
  });

  it("shows Stopping while the pond is told, and cannot be pressed twice", () => {
    show(taskOf(), { stopping: { [TASK_ID]: true } });
    const button = screen.getByRole("button", { name: /^Stop the task/ }) as HTMLButtonElement;
    expect(button.textContent).toBe("Stopping...");
    expect(button.disabled).toBe(true);
  });

  it("says so, as an alert, when the pond could not stop it", () => {
    show(taskOf(), { stopErrors: { [TASK_ID]: "Could not stop it. boom" } });
    expect(screen.getByRole("alert").textContent).toContain("Could not stop it. boom");
    expect(stopButton()).not.toBeNull();
  });

  it("is offered for a paused task and one waiting on approval", () => {
    show(taskOf({ state: "paused" }));
    expect(stopButton()).not.toBeNull();
    cleanup();
    show(taskOf({ state: "awaiting_approval" }));
    expect(stopButton()).not.toBeNull();
  });
});

describe("a long task that has ended", () => {
  it.each([
    ["completed", "Done"],
    ["failed", "Couldn't finish"],
    ["cancelled", "Stopped"],
  ] as const)("says %s as %s, with nothing to stop", (state, words) => {
    show(taskOf({ state, steps: [] }));
    expect(screen.getByText(words)).toBeTruthy();
    expect(stopButton()).toBeNull();
    expect(document.querySelector(".lt")?.getAttribute("data-state")).toBe(state);
  });

  it("offers no result for a task that failed or was stopped", () => {
    show(taskOf({ state: "failed", artifacts: [artifactOf()], result_artifact_id: "art-1" }));
    expect(screen.queryByRole("button", { name: "Read the result" })).toBeNull();
  });

  it("offers none for a finished task that made no result", () => {
    show(doneTask({ artifacts: [], result_artifact_id: null }));
    expect(screen.queryByRole("button", { name: "Read the result" })).toBeNull();
  });
});

describe("reading a result", () => {
  const BODY = "# Plan\n\n- ferry at **7:00**\n- [the map](https://example.com/map)\n\n```\nraw <b>text</b>\n```";

  it("shows the result's summary, and reads nothing until asked", () => {
    show(doneTask());
    expect(screen.getByText("Three days in Lamu, with ferry times.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Read the result" })).toBeTruthy();
    expect(api.getLongTaskArtifact).not.toHaveBeenCalled();
  });

  it("falls back to the result's title when it has no summary", () => {
    show(doneTask({ artifacts: [artifactOf({ summary: "" })] }));
    expect(screen.getByText("Trip plan")).toBeTruthy();
  });

  it("fetches the body and draws it as markdown, never as html", async () => {
    vi.mocked(api.getLongTaskArtifact).mockResolvedValue({
      id: "art-1",
      title: "Trip plan",
      kind: "result",
      summary: "",
      body: BODY,
    });
    show(doneTask());
    fireEvent.click(screen.getByRole("button", { name: "Read the result" }));
    const strong = await screen.findByText("7:00");
    expect(api.getLongTaskArtifact).toHaveBeenCalledWith(TASK_ID, "art-1");
    expect(strong.tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "the map" }).getAttribute("href")).toBe("https://example.com/map");
    expect(screen.getByText("Plan").tagName).toBe("H4");
    expect(document.querySelector(".lt__result pre")?.textContent).toBe("raw <b>text</b>");
    expect(document.querySelector(".lt__result b")).toBeNull();
  });

  it("hides it again, and keeps the button's name for the same action", async () => {
    vi.mocked(api.getLongTaskArtifact).mockResolvedValue({ id: "art-1", title: "Trip plan", kind: "result", summary: "", body: "Hello" });
    show(doneTask());
    fireEvent.click(screen.getByRole("button", { name: "Read the result" }));
    await screen.findByText("Hello");
    fireEvent.click(screen.getByRole("button", { name: "Hide the result" }));
    expect(screen.queryByText("Hello")).toBeNull();
    expect(screen.getByRole("button", { name: "Read the result" })).toBeTruthy();
  });

  it("shows Opening while the body is on its way", async () => {
    let arrive: (v: LongTaskArtifactBody) => void = () => {};
    vi.mocked(api.getLongTaskArtifact).mockReturnValue(new Promise<LongTaskArtifactBody>((resolve) => (arrive = resolve)));
    show(doneTask());
    fireEvent.click(screen.getByRole("button", { name: "Read the result" }));
    const opening = await screen.findByRole("button", { name: "Opening..." });
    expect((opening as HTMLButtonElement).disabled).toBe(true);
    arrive({ id: "art-1", title: "Trip plan", kind: "result", summary: "", body: "Arrived" });
    await screen.findByText("Arrived");
  });

  it("says when the body could not be fetched, and lets the person try again", async () => {
    vi.mocked(api.getLongTaskArtifact).mockRejectedValueOnce(new Error("offline")).mockResolvedValue({
      id: "art-1",
      title: "Trip plan",
      kind: "result",
      summary: "",
      body: "Second try",
    });
    show(doneTask());
    fireEvent.click(screen.getByRole("button", { name: "Read the result" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't open the result. offline");
    fireEvent.click(screen.getByRole("button", { name: "Read the result" }));
    await screen.findByText("Second try");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("a task that is not on screen yet", () => {
  it("says it is checking, as busy", () => {
    render(<LongTaskCard id={TASK_ID} longTasks={fakeLongTasks()} variant="classic" />);
    expect(screen.getByText("Checking on this task...")).toBeTruthy();
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
  });

  it("says the pond no longer has it, without offering anything", () => {
    render(<LongTaskCard id={TASK_ID} longTasks={fakeLongTasks({ gone: { [TASK_ID]: true } })} variant="classic" />);
    expect(screen.getByText("This task is no longer on the pond.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says it could not be read, and Try again reads it once more", () => {
    const retry = vi.fn();
    render(<LongTaskCard id={TASK_ID} longTasks={fakeLongTasks({ unreadable: { [TASK_ID]: "offline" }, retry })} variant="classic" />);
    expect(screen.getByText("Couldn't check on this task just now.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledWith(TASK_ID);
  });
});

describe("the cards of a conversation", () => {
  it("draws one card per id a message points at", () => {
    const longTasks = fakeLongTasks({ tasks: { [TASK_ID]: taskOf(), [OTHER_ID]: doneTask({ id: OTHER_ID, goal: "Book the ferry" }) } });
    render(<LongTaskCards ids={[TASK_ID, OTHER_ID]} longTasks={longTasks} variant="classic" />);
    expect(screen.getByText("Plan a trip to Lamu")).toBeTruthy();
    expect(screen.getByText("Book the ferry")).toBeTruthy();
  });

  it("draws nothing for a message with no task, or on a pond that has none", () => {
    const longTasks = fakeLongTasks({ tasks: { [TASK_ID]: taskOf() } });
    const { container, rerender } = render(<LongTaskCards ids={undefined} longTasks={longTasks} variant="classic" />);
    expect(container.textContent).toBe("");
    rerender(<LongTaskCards ids={[]} longTasks={longTasks} variant="classic" />);
    expect(container.textContent).toBe("");
    rerender(<LongTaskCards ids={[TASK_ID]} longTasks={{ ...longTasks, supported: false }} variant="classic" />);
    expect(container.textContent).toBe("");
  });

  it("gathers the tasks no message points at under one label, and only those", () => {
    const longTasks = fakeLongTasks({ tasks: { [TASK_ID]: taskOf(), [OTHER_ID]: doneTask({ id: OTHER_ID, goal: "Book the ferry" }) } });
    render(<LongTaskStrays anchored={new Set([TASK_ID])} longTasks={longTasks} variant="classic" />);
    expect(screen.getByRole("region", { name: "Long tasks in this conversation" })).toBeTruthy();
    expect(screen.getByText("Book the ferry")).toBeTruthy();
    expect(screen.queryByText("Plan a trip to Lamu")).toBeNull();
  });

  it("draws no group when every task is anchored, or on a pond that has none", () => {
    const longTasks = fakeLongTasks({ tasks: { [TASK_ID]: taskOf() } });
    const { container, rerender } = render(<LongTaskStrays anchored={new Set([TASK_ID])} longTasks={longTasks} variant="classic" />);
    expect(container.textContent).toBe("");
    rerender(<LongTaskStrays anchored={new Set()} longTasks={{ ...longTasks, supported: false }} variant="classic" />);
    expect(container.textContent).toBe("");
  });
});
