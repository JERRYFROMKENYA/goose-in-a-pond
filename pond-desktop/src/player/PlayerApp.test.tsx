import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PlayerApp } from "./PlayerApp";
import type { PlayerAdapter, PlayerState } from "./types";

afterEach(cleanup);

function state(over: Partial<PlayerState> = {}): PlayerState {
  return {
    service: "apple",
    ready: true,
    need: "none",
    status: "idle",
    track: null,
    position_ms: 0,
    volume: 50,
    shuffle: false,
    repeat: "off",
    ...over,
  };
}

function adapterIn(initial: PlayerState) {
  let current = initial;
  const listeners = new Set<(s: PlayerState) => void>();
  const spies = {
    authorize: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    next: vi.fn(async () => undefined),
    previous: vi.fn(async () => undefined),
  };
  const adapter = {
    service: "apple",
    label: "Apple Music",
    capabilities: { queue: true, playlists: true, library: true },
    state: () => current,
    onState: (l: (s: PlayerState) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    ...spies,
  } as unknown as PlayerAdapter;
  return {
    adapter,
    spies,
    update(next: PlayerState) {
      current = next;
      act(() => listeners.forEach((l) => l(next)));
    },
  };
}

const track = {
  id: "1",
  kind: "song" as const,
  title: "Nairobi",
  artist: "Bensoul",
  album: "Qwarantunes",
  duration_ms: 210_000,
};

describe("PlayerApp", () => {
  it("offers one thing to do when nobody is signed in", () => {
    const { adapter, spies } = adapterIn(state({ ready: false, need: "authorization" }));
    render(<PlayerApp adapter={adapter} />);

    fireEvent.click(screen.getByRole("button", { name: "Sign in to Apple Music" }));

    expect(spies.authorize).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("Play")).toBeNull();
  });

  it("says what is missing when the player cannot be set up", () => {
    const { adapter } = adapterIn(
      state({
        ready: false,
        need: "setup",
        message: "Apple Music is not set up: add your Team ID.",
      }),
    );
    render(<PlayerApp adapter={adapter} />);
    expect(screen.getByText(/add your Team ID/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("still points to the settings when the reason is not known", () => {
    const { adapter } = adapterIn(state({ ready: false, need: "setup" }));
    render(<PlayerApp adapter={adapter} />);
    expect(screen.getByText(/not set up yet/)).toBeTruthy();
  });

  it("invites a request when nothing is playing", () => {
    const { adapter } = adapterIn(state());
    render(<PlayerApp adapter={adapter} />);
    expect(screen.getByText(/Nothing is playing/)).toBeTruthy();
  });

  it("shows what is playing, with its clock", () => {
    const { adapter } = adapterIn(state({ status: "playing", track, position_ms: 65_000 }));
    render(<PlayerApp adapter={adapter} />);
    expect(screen.getByText("Nairobi")).toBeTruthy();
    expect(screen.getByText("Bensoul")).toBeTruthy();
    expect(screen.getByText("Qwarantunes")).toBeTruthy();
    expect(screen.getByText("1:05 / 3:30")).toBeTruthy();
  });

  it("shows the artwork as the service supplies it, with words for it", () => {
    const art = "https://x/300x300.jpg";
    const { adapter } = adapterIn(state({ status: "playing", track: { ...track, artwork_url: art } }));
    render(<PlayerApp adapter={adapter} />);
    const img = screen.getByRole("img", { name: "Artwork for Qwarantunes" }) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(art);
  });

  it("keeps the standard controls on screen whenever the service can play, even with nothing playing", () => {
    const { adapter } = adapterIn(state());
    render(<PlayerApp adapter={adapter} />);
    for (const name of ["Previous", "Play", "Next"]) expect(screen.getByLabelText(name)).toBeTruthy();
  });

  it("offers a sign-out for a service that signs in on the page, and only then", () => {
    const signed = adapterIn(state());
    const signOut = vi.fn(async () => undefined);
    (signed.adapter as unknown as { signOut: () => Promise<void> }).signOut = signOut;
    render(<PlayerApp adapter={signed.adapter} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out of Apple Music" }));
    expect(signOut).toHaveBeenCalledOnce();
    cleanup();

    render(<PlayerApp adapter={adapterIn(state()).adapter} />);
    expect(screen.queryByRole("button", { name: /Sign out/ })).toBeNull();
  });

  it("pauses while playing and resumes while paused", () => {
    const { adapter, spies, update } = adapterIn(state({ status: "playing", track }));
    render(<PlayerApp adapter={adapter} />);

    fireEvent.click(screen.getByLabelText("Pause"));
    expect(spies.pause).toHaveBeenCalledOnce();

    update(state({ status: "paused", track }));
    fireEvent.click(screen.getByLabelText("Play"));
    expect(spies.resume).toHaveBeenCalledOnce();
  });

  it("skips in both directions", () => {
    const { adapter, spies } = adapterIn(state({ status: "playing", track }));
    render(<PlayerApp adapter={adapter} />);
    fireEvent.click(screen.getByLabelText("Next"));
    fireEvent.click(screen.getByLabelText("Previous"));
    expect(spies.next).toHaveBeenCalledOnce();
    expect(spies.previous).toHaveBeenCalledOnce();
  });

  it("puts a refusal in words where it can be read", () => {
    const { adapter } = adapterIn(
      state({ status: "error", message: "Apple refused the playback license (MEDIA_LICENSE)." }),
    );
    render(<PlayerApp adapter={adapter} />);
    expect(screen.getByRole("status").textContent).toContain("Apple refused");
  });

  it("a control that fails does not crash the window", async () => {
    const { adapter, spies } = adapterIn(state({ status: "playing", track }));
    spies.pause.mockRejectedValueOnce(new Error("no"));
    render(<PlayerApp adapter={adapter} />);
    fireEvent.click(screen.getByLabelText("Pause"));
    await Promise.resolve();
    expect(screen.getByText("Nairobi")).toBeTruthy();
  });
  it("arms a service that needs a click, from that click, with Play here", () => {
    const { adapter } = adapterIn(state({ service: "spotify", need: "interaction" }));
    const activate = vi.fn(async () => undefined);
    Object.assign(adapter, { label: "Spotify", activate });
    render(<PlayerApp adapter={adapter} />);
    fireEvent.click(screen.getByRole("button", { name: "Play Spotify here" }));
    expect(activate).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("Next")).toBeNull();
  });

  it("shows only the controls the service calls for, and disables what it does not allow now", () => {
    const { adapter } = adapterIn(
      state({
        status: "playing",
        track,
        can: { pause: false, resume: true, next: false, previous: true, seek: true },
      }),
    );
    Object.assign(adapter, { controls: ["playPause"] });
    render(<PlayerApp adapter={adapter} />);
    expect(screen.queryByLabelText("Previous")).toBeNull();
    expect(screen.queryByLabelText("Next")).toBeNull();
    expect((screen.getByLabelText("Pause") as HTMLButtonElement).disabled).toBe(true);
  });

  it("credits the service by its brand rules: its logo, and the link back in its own words", () => {
    const { adapter } = adapterIn(
      state({ status: "playing", track: { ...track, link: "https://open.spotify.com/track/1" } }),
    );
    Object.assign(adapter, {
      label: "Spotify",
      brand: { logoUrl: "/brand/spotify-logo.png", linkLabel: "LISTEN ON SPOTIFY" },
    });
    render(<PlayerApp adapter={adapter} />);
    expect(screen.getByRole("img", { name: "Spotify" }).getAttribute("src")).toBe("/brand/spotify-logo.png");
    const link = screen.getByRole("link", { name: "LISTEN ON SPOTIFY" });
    expect(link.getAttribute("href")).toBe("https://open.spotify.com/track/1");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("names the service in text, and shows no link, when it has no brand rules", () => {
    const { adapter } = adapterIn(
      state({ status: "playing", track: { ...track, link: "https://music.apple.com/x" } }),
    );
    render(<PlayerApp adapter={adapter} />);
    expect(screen.getByRole("heading", { name: "Apple Music" })).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
