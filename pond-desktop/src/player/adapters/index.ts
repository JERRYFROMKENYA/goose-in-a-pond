// The registry of services the player can drive. Adding one is a file here and a line below; the
// bridge, the host and the extension already speak only in the player's own terms.

import type { PlayerAdapter } from "../types";
import { AppleMusicKitAdapter, loadMusicKitFromApple } from "./appleMusicKit";
import { SpotifyWebPlaybackAdapter, loadSpotifySdk } from "./spotifyWebPlayback";
import { SPOTIFY_LOGO_URL } from "../brand";

export interface AdapterContext {
  /** Apple: a developer token the pond signs, since the pond holds the key. */
  fetchDeveloperToken(): Promise<string>;
  /**
   * Whether the pond's network setting lets this page reach `url`: null when it does, else the
   * reason in words for a person. Asked before a service's script is loaded.
   */
  networkAllows(url: string): Promise<string | null>;
  /** Spotify: the person's own access token, held by the pond. `refresh` asks for a new one. */
  fetchUserToken(service: string, refresh: boolean): Promise<string>;
}

// A Map, not an object: `service` comes from the page's URL, and an object would answer
// "constructor" or "toString" with Object's own functions.
const ADAPTERS = new Map<string, (ctx: AdapterContext) => PlayerAdapter>([
  [
    "apple",
    (ctx) =>
      new AppleMusicKitAdapter({
        loadMusicKit: loadMusicKitFromApple,
        fetchDeveloperToken: ctx.fetchDeveloperToken,
        networkAllows: ctx.networkAllows,
      }),
  ],
  [
    "spotify",
    (ctx) =>
      new SpotifyWebPlaybackAdapter(
        {
          loadSdk: loadSpotifySdk,
          fetchUserToken: (refresh) => ctx.fetchUserToken("spotify", refresh),
          networkAllows: ctx.networkAllows,
        },
        { logoUrl: SPOTIFY_LOGO_URL },
      ),
  ],
]);

export function knownServices(): string[] {
  return [...ADAPTERS.keys()];
}

/** The adapter for `service`, or null when the player has none. */
export function createAdapter(
  service: string,
  ctx: AdapterContext,
): PlayerAdapter | null {
  return ADAPTERS.get(service)?.(ctx) ?? null;
}
