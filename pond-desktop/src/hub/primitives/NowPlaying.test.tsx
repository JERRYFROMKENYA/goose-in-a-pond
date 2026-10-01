import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const store = vi.hoisted(() => ({
  nowPlaying: {
    track: "Blue Train",
    artist: "John Coltrane",
    elapsed: 0.4,
    hue: 260,
    connected: true,
    playing: true,
  } as Record<string, unknown>,
}));

vi.mock("../state/hubDataStore", () => ({
  useHomeData: () => ({ nowPlaying: store.nowPlaying }),
  controlNowPlaying: vi.fn(),
  refreshNowPlaying: vi.fn(),
}));

import { NowPlaying } from "./NowPlaying";
import { controlNowPlaying, refreshNowPlaying } from "../state/hubDataStore";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const healthy = {
  track: "Blue Train",
  artist: "John Coltrane",
  elapsed: 0.4,
  hue: 260,
  connected: true,
  playing: true,
  albumArt: "https://i.scdn.co/image/blue",
  link: "https://open.spotify.com/track/blue",
};

describe("NowPlaying", () => {
  beforeEach(() => {
    store.nowPlaying = { ...healthy };
  });

  it("offers play or pause as the one control, as Spotify's design guidelines recommend", () => {
    render(<NowPlaying />);
    expect(screen.getByLabelText("Pause")).toBeTruthy();
    expect(screen.queryByLabelText("Next")).toBeNull();
    expect(screen.queryByLabelText("Previous")).toBeNull();
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();

    fireEvent.click(screen.getByLabelText("Pause"));
    expect(vi.mocked(controlNowPlaying)).toHaveBeenCalledWith("pause");
  });

  it("shows the cover art as an image, uncropped, never as a scrimmed background", () => {
    const { container } = render(<NowPlaying variant="tile" />);
    const img = screen.getByRole("img", { name: "Cover art for Blue Train" }) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("https://i.scdn.co/image/blue");
    const card = container.querySelector(".np") as HTMLElement;
    expect(card.style.backgroundImage).toBe("");
    expect(card.className).not.toMatch(/np--has-art/);
  });

  it("credits Spotify with its official logo, and links back to the item in the guidelines' own words", () => {
    render(<NowPlaying />);
    const logo = screen.getByRole("img", { name: "Spotify" }) as HTMLImageElement;
    expect(logo.getAttribute("src")).toBe("/brand/spotify/Full_Logo_Black_RGB.svg");
    const link = screen.getByRole("link", { name: "LISTEN ON SPOTIFY" });
    expect(link.getAttribute("href")).toBe("https://open.spotify.com/track/blue");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("does not offer what Spotify disallows right now", () => {
    store.nowPlaying = { ...healthy, can: { pause: false, resume: true, next: true, previous: true } };
    render(<NowPlaying />);
    const pause = screen.getByLabelText("Pause") as HTMLButtonElement;
    expect(pause.disabled).toBe(true);
    fireEvent.click(pause);
    expect(vi.mocked(controlNowPlaying)).not.toHaveBeenCalled();
  });

  it("with nothing playing, offers to play Spotify on this computer in the player page", () => {
    store.nowPlaying = { ...healthy, track: "Nothing playing", artist: "", playing: false, link: null, albumArt: null };
    render(<NowPlaying />);
    expect(screen.getByRole("button", { name: "Play Spotify on this computer" })).toBeTruthy();
  });

  it("says Spotify is not connected, with no control that pretends to work", () => {
    store.nowPlaying = { track: "", artist: "", elapsed: 0, hue: 260, connected: false, playing: false };
    render(<NowPlaying />);
    expect(screen.getByText("Spotify is not connected")).toBeTruthy();
    expect((screen.getByLabelText("Play") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("img", { name: "Spotify" })).toBeNull();
  });

  // Polling has stopped on this refusal, so nothing else will bring the widget back.
  it("replaces the dead transport controls with a way to ask again", () => {
    store.nowPlaying = {
      track: "Spotify not authorised",
      artist: "Sign in to Spotify again.",
      elapsed: 0,
      hue: 260,
      connected: true,
      playing: false,
      error: "unauthorized",
      message: "Sign in to Spotify again.",
    };
    render(<NowPlaying />);

    expect(screen.queryByLabelText("Pause")).toBeNull();
    expect(screen.queryByLabelText("Next")).toBeNull();
    expect(screen.queryByLabelText("Previous")).toBeNull();

    const retry = screen.getByRole("button", { name: /Try again/ });
    expect((retry as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(retry);
    expect(vi.mocked(refreshNowPlaying)).toHaveBeenCalled();
    // Asking again is not a playback command.
    expect(vi.mocked(controlNowPlaying)).not.toHaveBeenCalled();
  });

  it("carries the server's explanation rather than a generic failure", () => {
    store.nowPlaying = {
      track: "Spotify unavailable",
      artist: "Spotify is rate-limiting requests. Playback should reappear shortly.",
      elapsed: 0,
      hue: 260,
      connected: true,
      playing: false,
      error: "rate_limited",
      message: "Spotify is rate-limiting requests. Playback should reappear shortly.",
    };
    render(<NowPlaying />);
    expect(screen.getByText(/rate-limiting/)).toBeTruthy();
  });

  it("with Apple Music chosen, says where it plays, offers its page, and shows nothing of Spotify", () => {
    store.nowPlaying = { track: "", artist: "", elapsed: 0, hue: 260, connected: false, playing: false, service: "apple", player: "page" };
    render(<NowPlaying />);
    expect(screen.getByText("Apple Music")).toBeTruthy();
    expect(screen.getByText(/plays on the music player page/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open the music player" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Spotify" })).toBeNull();
    expect(screen.queryByLabelText("Play")).toBeNull();
  });

  it("with Apple Music in the Music app chosen, offers no page", () => {
    store.nowPlaying = { track: "", artist: "", elapsed: 0, hue: 260, connected: false, playing: false, service: "apple", player: "app" };
    render(<NowPlaying />);
    expect(screen.getByText(/plays in the Music app/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open the music player" })).toBeNull();
  });
});
