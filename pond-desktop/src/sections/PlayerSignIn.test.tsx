import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PlayerState } from "../player/types";

const shell = vi.hoisted(() => ({
  desktop: true,
  invoke: vi.fn(),
}));
const getPlayerState = vi.hoisted(() => vi.fn());

vi.mock("../shell", () => ({
  isDesktopShell: () => shell.desktop,
  invoke: shell.invoke,
}));
vi.mock("../api/PondApiClient", () => ({
  api: { getPlayerState, serverUrl: () => "http://127.0.0.1:4000" },
}));

import { PlayerSignIn } from "./PlayerSignIn";

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
const reports = (over: Partial<PlayerState> = {}) =>
  getPlayerState.mockResolvedValue({ attached: true, state: state(over) });

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

const PAGE = "http://127.0.0.1:4000/player.html?service=apple";

beforeEach(() => {
  vi.useFakeTimers();
  shell.desktop = true;
  shell.invoke.mockReset();
  getPlayerState.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("PlayerSignIn: the row that sends you to the music player page", () => {
  it("opens the pond's player page in the real browser from the app, not an in-app window", async () => {
    reports({ need: "authorization" });
    shell.invoke.mockResolvedValue(undefined);
    render(<PlayerSignIn service="apple" label="Apple Music" />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: /open the music player/i }));
    await settle();

    expect(shell.invoke).toHaveBeenCalledWith("open_external", { url: PAGE });
  });

  it("opens the page with the browser's own window.open outside the app", async () => {
    shell.desktop = false;
    reports({ need: "authorization" });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<PlayerSignIn service="apple" label="Apple Music" />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: /open the music player/i }));
    expect(open).toHaveBeenCalledWith(PAGE, "_blank", "noopener");
    expect(shell.invoke).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("says the page is not open when no page is attached", async () => {
    getPlayerState.mockResolvedValue({ attached: false, state: null });
    render(<PlayerSignIn service="apple" label="Apple Music" />);
    await settle();
    expect(screen.getByText(/The music player is not open/)).toBeTruthy();
  });

  it("points at the page's Sign in button while the page waits for one", async () => {
    reports({ need: "authorization" });
    render(<PlayerSignIn service="apple" label="Apple Music" />);
    await settle();
    expect(screen.getByText("Press Sign in to Apple Music on the music player page.")).toBeTruthy();
    // There is no sign-in button here: the sign-in may only open from a click on the page.
    expect(screen.queryByRole("button", { name: /^sign in/i })).toBeNull();
  });

  it("shows signed in once the page reports it, picked up by the poll", async () => {
    reports({ need: "authorization" });
    render(<PlayerSignIn service="apple" label="Apple Music" />);
    await settle();
    expect(screen.queryByText(/Signed in to Apple Music/)).toBeNull();

    reports({ need: "none", ready: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.getByText(/Signed in to Apple Music/)).toBeTruthy();
  });

  it("shows why it could not open the page", async () => {
    reports({ need: "authorization" });
    shell.invoke.mockRejectedValue(new Error("refusing to open a file: URL externally"));
    render(<PlayerSignIn service="apple" label="Apple Music" />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: /open the music player/i }));
    await settle();
    expect(screen.getByText(/refusing to open/)).toBeTruthy();
  });

  it("opens the Spotify player page, and says the assistant never controls Spotify", async () => {
    getPlayerState.mockResolvedValue({ attached: true, state: state({ service: "spotify", need: "interaction" }) });
    shell.invoke.mockResolvedValue(undefined);
    render(<PlayerSignIn service="spotify" label="Spotify" kind="play_here" />);
    await settle();

    expect(screen.getByText(/the assistant never controls Spotify/)).toBeTruthy();
    expect(screen.getByText("Press Play Spotify here on the music player page.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open the Spotify player" }));
    await settle();
    expect(shell.invoke).toHaveBeenCalledWith("open_external", {
      url: "http://127.0.0.1:4000/player.html?service=spotify",
    });
  });

  it("says Spotify can play here once the page is armed, not that anyone signed in there", async () => {
    getPlayerState.mockResolvedValue({ attached: true, state: state({ service: "spotify", need: "none", ready: true }) });
    render(<PlayerSignIn service="spotify" label="Spotify" kind="play_here" />);
    await settle();
    expect(screen.getByText("Spotify can play on this computer")).toBeTruthy();
    expect(screen.queryByText(/Signed in to Spotify/)).toBeNull();
  });
});
