import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Players } from "./Players";
import type { PlayerAdapter, PlayerState } from "./types";

afterEach(cleanup);

function adapterFor(service: string, label: string, initial: Partial<PlayerState>) {
  let current: PlayerState = {
    service,
    ready: true,
    need: "none",
    status: "idle",
    track: null,
    position_ms: 0,
    volume: 50,
    shuffle: false,
    repeat: "off",
    ...initial,
  };
  const listeners = new Set<(s: PlayerState) => void>();
  const adapter = {
    service,
    label,
    capabilities: { queue: true, playlists: true, library: true },
    state: () => current,
    onState: (l: (s: PlayerState) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  } as unknown as PlayerAdapter;
  return {
    adapter,
    update(next: Partial<PlayerState>) {
      current = { ...current, ...next };
      act(() => listeners.forEach((l) => l(current)));
    },
  };
}

describe("Players", () => {
  it("shows the service that needs the person, not the one still waiting for its key", () => {
    const apple = adapterFor("apple", "Apple Music", { ready: false, need: "authorization" });
    const spotify = adapterFor("spotify", "Spotify", {
      ready: false,
      need: "setup",
      message: "Spotify is not connected.",
    });
    render(<Players adapters={[apple.adapter, spotify.adapter]} />);

    expect(screen.getByRole("button", { name: "Sign in to Apple Music" })).toBeTruthy();
    expect(screen.queryByText("Spotify is not connected.")).toBeNull();
  });

  it("shows every service, each saying what it waits for, when none is set up", () => {
    const apple = adapterFor("apple", "Apple Music", {
      ready: false,
      need: "setup",
      message: "Apple Music is not set up.",
    });
    const spotify = adapterFor("spotify", "Spotify", {
      ready: false,
      need: "setup",
      message: "Spotify is not connected.",
    });
    render(<Players adapters={[apple.adapter, spotify.adapter]} />);

    expect(screen.getByText("Apple Music is not set up.")).toBeTruthy();
    expect(screen.getByText("Spotify is not connected.")).toBeTruthy();
  });

  it("brings a service in as soon as it is set up", () => {
    const apple = adapterFor("apple", "Apple Music", {
      ready: false,
      need: "setup",
      message: "Apple Music is not set up.",
    });
    const spotify = adapterFor("spotify", "Spotify", {
      ready: false,
      need: "setup",
      message: "Spotify is not connected.",
    });
    render(<Players adapters={[apple.adapter, spotify.adapter]} />);

    spotify.update({ ready: true, need: "none", message: undefined });

    expect(screen.getByLabelText("Spotify player")).toBeTruthy();
    expect(screen.queryByText("Apple Music is not set up.")).toBeNull();
  });
});
