import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { MarketplaceExtension, SecretRequirement } from "../api/types";

const getPlayerState = vi.hoisted(() => vi.fn());
vi.mock("../shell", () => ({ isDesktopShell: () => true, invoke: vi.fn() }));
vi.mock("../api/PondApiClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/PondApiClient")>();
  // Spreading the client copies its fields, not its prototype, so the methods used are listed.
  return {
    ...original,
    api: { ...original.api, getPlayerState, serverUrl: () => "http://127.0.0.1:4000" },
  };
});

import { SecretConfigModal } from "./Extensions";

const secret = (over: Partial<SecretRequirement> & Pick<SecretRequirement, "key">): SecretRequirement => ({
  display_name: over.key,
  description: "",
  required: false,
  kind: "generic",
  ...over,
});

/** The music entry as the registry describes it. */
const music: MarketplaceExtension = {
  id: "music",
  name: "Music",
  description: "Play music",
  kind: "stdio",
  args: [],
  category: "entertainment",
  featured: true,
  tools: [],
  required_secrets: [
    secret({
      key: "MUSIC_SERVICE",
      display_name: "Music service",
      kind: "choice",
      options: [
        { value: "apple", label: "Apple Music", description: "The assistant can play it for you." },
        { value: "spotify", label: "Spotify", description: "Played by hand." },
      ],
    }),
    secret({
      key: "MUSIC_PLAYER",
      display_name: "Player",
      kind: "choice",
      options: [
        { value: "page", label: "The player page, in your web browser" },
        { value: "app", label: "The service's own app" },
      ],
    }),
    secret({ key: "SPOTIFY_CLIENT_ID", display_name: "Spotify client ID", host_only: true }),
    secret({ key: "SPOTIFY_ACCESS_TOKEN", display_name: "Spotify", kind: "oauth_flow", host_only: true }),
    secret({ key: "APPLE_MUSIC_TEAM_ID", display_name: "Apple Music Team ID", advanced: true, host_only: true }),
    secret({ key: "APPLE_MUSIC_KEY_ID", display_name: "Apple Music Key ID", advanced: true, host_only: true }),
    secret({
      key: "APPLE_MUSIC_PRIVATE_KEY",
      display_name: "Apple Music private key",
      kind: "api_key",
      advanced: true,
      host_only: true,
    }),
  ],
} as unknown as MarketplaceExtension;

const github = {
  id: "github",
  name: "GitHub",
  description: "",
  kind: "stdio",
  args: [],
  category: "dev",
  featured: false,
  tools: [],
  required_secrets: [
    secret({ key: "GITHUB_TOKEN", display_name: "GitHub token", kind: "api_key", required: true }),
  ],
} as unknown as MarketplaceExtension;

const props = { mode: "edit" as const, onClose: () => undefined, onComplete: async () => undefined };

beforeEach(() => {
  getPlayerState.mockReset();
  getPlayerState.mockResolvedValue({ attached: true, state: { need: "authorization" } });
});
afterEach(cleanup);

describe("the Music extension's settings", () => {
  it("leads with the choice of service and player, showing what is saved", () => {
    render(
      <SecretConfigModal ext={music} {...props} choiceValues={{ MUSIC_SERVICE: "spotify", MUSIC_PLAYER: "app" }} />,
    );
    expect((screen.getByRole("radio", { name: /^Spotify/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: /^The service's own app/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("starts on each choice's first answer when nothing is saved: Apple Music on the player page", () => {
    render(<SecretConfigModal ext={music} {...props} />);
    expect((screen.getByRole("radio", { name: /^Apple Music/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: /^The player page/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("with Apple Music chosen, shows Apple Music's setup and none of Spotify's", async () => {
    render(<SecretConfigModal ext={music} {...props} />);
    expect(await screen.findByRole("button", { name: /open the music player/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /sign in with spotify/i })).toBeNull();
    expect(screen.queryByText("Spotify client ID")).toBeNull();
    expect(screen.queryByRole("button", { name: /open the spotify player/i })).toBeNull();
    const panel = screen.getByText("Developer settings").closest("details") as HTMLElement;
    for (const label of ["Apple Music Team ID", "Apple Music Key ID", "Apple Music private key"]) {
      expect(within(panel).getByText(label)).toBeTruthy();
    }
  });

  it("switching to Spotify shows its client ID, with the exact redirect URI, its sign-in and its page", async () => {
    render(<SecretConfigModal ext={music} {...props} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Spotify/ }));
    expect(screen.getByText("Spotify client ID")).toBeTruthy();
    expect(screen.getByText("http://127.0.0.1:4000/api/v1/oauth/callback")).toBeTruthy();
    expect(screen.getByRole("button", { name: /sign in with spotify/i })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /open the spotify player/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /open the music player/i })).toBeNull();
    expect(screen.queryByText("Developer settings")).toBeNull();
  });

  it("with the service's own app chosen, offers no player page", () => {
    render(<SecretConfigModal ext={music} {...props} choiceValues={{ MUSIC_SERVICE: "apple", MUSIC_PLAYER: "app" }} />);
    expect(screen.queryByRole("button", { name: /open the music player/i })).toBeNull();
  });

  it("saves the choices with everything else", async () => {
    const onComplete = vi.fn(async () => undefined);
    render(<SecretConfigModal ext={music} {...props} onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Spotify/ }));
    fireEvent.click(screen.getByRole("radio", { name: /^The service's own app/ }));
    fireEvent.change(screen.getByPlaceholderText("Enter your Spotify client ID"), {
      target: { value: " abc123 " },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(onComplete).toHaveBeenCalledWith({
      MUSIC_SERVICE: "spotify",
      MUSIC_PLAYER: "app",
      SPOTIFY_CLIENT_ID: "abc123",
    });
  });

  it("says how many developer settings are already saved, so a custom key is not hidden from view", () => {
    render(
      <SecretConfigModal
        ext={music}
        {...props}
        fulfilledMap={{ APPLE_MUSIC_TEAM_ID: true, APPLE_MUSIC_KEY_ID: true }}
      />,
    );
    expect(screen.getByText("2 saved")).toBeTruthy();
  });

  it("does not claim anything is saved when nothing is", () => {
    render(<SecretConfigModal ext={music} {...props} />);
    expect(screen.queryByText(/saved$/)).toBeNull();
  });
});

describe("an extension with no advanced fields", () => {
  it("looks as it always did: its field, no Developer settings, no Apple sign-in", () => {
    render(<SecretConfigModal ext={github} {...props} />);
    expect(screen.getByText("GitHub token")).toBeTruthy();
    expect(screen.queryByText("Developer settings")).toBeNull();
    expect(screen.queryByRole("button", { name: /open the music player/i })).toBeNull();
    expect(getPlayerState).not.toHaveBeenCalled();
  });
});
