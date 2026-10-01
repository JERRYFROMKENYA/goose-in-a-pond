// Spotify through the Web Playback SDK, used the way Spotify's documentation shows: an ordinary page in
// the person's own browser, which becomes a Spotify Connect device they start and control by hand.
// Only this file knows the SDK's vocabulary.
//
// What it follows (https://developer.spotify.com/documentation/web-playback-sdk):
// - Getting Started: `window.onSpotifyWebPlaybackSDKReady` is defined, then the script is loaded from
//   sdk.scdn.co; `new Spotify.Player({ name, getOAuthToken })`; the error listeners, `ready` and
//   `not_ready`, then `connect()`.
// - Reference: `getOAuthToken` is called on every `connect()` and whenever the token has expired, and
//   is answered with a valid token each time. `activateElement()` is called inside a click, before
//   playback is transferred, or an autoplay-restricted browser leaves the music paused; `autoplay_failed`
//   asks for that click again. `player_state_changed` carries `disallows`, what may be done right now.
// - Web API, Transfer Playback: `PUT /v1/me/player` with this device and `play: true`, the guide's own
//   next step, is how the page's Play button brings the music here.
// - Design guidelines: artwork and metadata as Spotify supplies them, Spotify's logo and a link back to
//   the item, and play or pause as the only control.
// - Developer Policy III.3 and Terms IV.2.a.i: no voice control and nothing into an AI model. So nothing
//   here takes a command from the assistant; the page is driven by hand, and by the app's music controls
//   through Spotify's own Web API.

import {
  PlayerError,
  type AdapterCapabilities,
  type ItemRef,
  type LibraryKind,
  type PlayerAdapter,
  type PlayerBrand,
  type PlayerControl,
  type PlayerDevice,
  type PlayerState,
  type PlaylistInfo,
  type RepeatMode,
  type Track,
  type Unsubscribe,
} from "../types";

/** A WebPlaybackTrack object (Reference), reduced to what this adapter reads. */
interface SdkTrack {
  id?: string | null;
  uri?: string;
  name?: string;
  duration_ms?: number;
  album?: { name?: string; images?: Array<{ url?: string }> };
  artists?: Array<{ name?: string }>;
}

/** A WebPlaybackState object (Reference), reduced to what this adapter reads. */
export interface SdkPlaybackState {
  paused: boolean;
  loading?: boolean;
  position: number;
  duration?: number;
  shuffle?: boolean;
  /** 0 off, 1 the context repeats, 2 the track repeats. */
  repeat_mode?: number;
  track_window?: { current_track?: SdkTrack | null };
  disallows?: {
    pausing?: boolean;
    resuming?: boolean;
    seeking?: boolean;
    skipping_next?: boolean;
    skipping_prev?: boolean;
  };
}

/** The Spotify.Player methods this adapter uses, as the Reference declares them. */
export interface SdkPlayer {
  addListener(name: string, listener: (payload: never) => void): unknown;
  connect(): Promise<boolean>;
  disconnect(): void;
  pause(): Promise<void>;
  resume(): Promise<void>;
  nextTrack(): Promise<void>;
  previousTrack(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  /** The state right now, position included: the events only fire when something changes. */
  getCurrentState(): Promise<SdkPlaybackState | null>;
  activateElement(): Promise<void>;
}

export interface SpotifyGlobal {
  Player: new (options: {
    name: string;
    getOAuthToken: (deliver: (token: string) => void) => void;
  }) => SdkPlayer;
}

export interface SpotifyDeps {
  loadSdk(): Promise<SpotifyGlobal>;
  /**
   * The person's access token from the pond, which holds it. `refresh` asks Spotify for a new one
   * first: the SDK asks again when the last one has expired.
   */
  fetchUserToken(refresh: boolean): Promise<string>;
  /**
   * Whether the pond's network setting lets this page reach `url`: null when it does, else the reason.
   * Asked before the SDK's script is loaded and before the Web API is called.
   */
  networkAllows?(url: string): Promise<string | null>;
  /** For the Web API's Transfer Playback; the page's own `fetch` by default. */
  fetch?: typeof fetch;
  /** What the device is called in Spotify's device list. */
  deviceName?: string;
}

export const SDK_URL = "https://sdk.scdn.co/spotify-player.js";
/** Web API, Transfer Playback. */
export const TRANSFER_URL = "https://api.spotify.com/v1/me/player";
const DEVICE_NAME = "Goose In A Pond";
/** How often the position is read while something plays: the SDK reports changes, not the clock. */
const TICK_MS = 1_000;

/**
 * Getting Started, exactly: `window.onSpotifyWebPlaybackSDKReady` is defined before the script is
 * added, since the SDK calls it once `Spotify` exists.
 */
export function loadSpotifySdk(): Promise<SpotifyGlobal> {
  return new Promise((resolve, reject) => {
    const w = window as unknown as {
      Spotify?: SpotifyGlobal;
      onSpotifyWebPlaybackSDKReady?: () => void;
    };
    if (w.Spotify) return resolve(w.Spotify);
    w.onSpotifyWebPlaybackSDKReady = () => resolve(w.Spotify as SpotifyGlobal);
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.onerror = () =>
      reject(new Error("Could not load Spotify's player. Check this computer's internet connection."));
    document.head.appendChild(script);
  });
}

const HAND_ONLY =
  "Spotify is not controlled by the assistant: Spotify's developer rules do not allow voice or AI control. Play it by hand, on this page, in the Spotify app, or with the app's music controls.";

/** A WebPlaybackTrack in the player's terms, with the link back to it on Spotify. */
function trackFrom(item: SdkTrack | null | undefined, fallbackDuration: number): Track | null {
  if (!item?.name) return null;
  const id = item.id ?? item.uri;
  if (!id) return null;
  const art = item.album?.images?.[0]?.url;
  return {
    id,
    kind: "song",
    title: item.name,
    artist: (item.artists ?? [])
      .map((a) => a.name)
      .filter(Boolean)
      .join(", "),
    album: item.album?.name ?? "",
    duration_ms: item.duration_ms ?? fallbackDuration,
    ...(art ? { artwork_url: art } : {}),
    ...(item.id ? { link: `https://open.spotify.com/track/${item.id}` } : {}),
  };
}

function repeatFrom(mode: number | undefined): RepeatMode {
  return mode === 2 ? "one" : mode === 1 ? "all" : "off";
}

export class SpotifyWebPlaybackAdapter implements PlayerAdapter {
  readonly service = "spotify";
  readonly label = "Spotify";
  // The page is a speaker: it neither searches nor lists, and nothing asks it to.
  readonly capabilities: AdapterCapabilities = {
    queue: false,
    playlists: false,
    library: false,
  };
  /** The design guidelines recommend play and pause as the only control. */
  readonly controls: readonly PlayerControl[] = ["playPause"];
  readonly brand: PlayerBrand;

  private player: SdkPlayer | null = null;
  private deviceId: string | null = null;
  /** `activateElement()` has run in a click on this page. */
  private activated = false;
  private tokenAsks = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<(s: PlayerState) => void>();
  private snapshot: PlayerState = {
    service: "spotify",
    ready: false,
    need: "setup",
    status: "idle",
    track: null,
    position_ms: 0,
    volume: 100,
    shuffle: false,
    repeat: "off",
    message: "Starting Spotify...",
  };

  constructor(
    private readonly deps: SpotifyDeps,
    brand: Partial<PlayerBrand> = {},
  ) {
    this.brand = { linkLabel: "LISTEN ON SPOTIFY", ...brand };
  }

  state(): PlayerState {
    return this.snapshot;
  }

  onState(listener: (state: PlayerState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  device(): PlayerDevice {
    return {
      device_id: this.deviceId,
      name: this.deps.deviceName ?? DEVICE_NAME,
      ready: this.snapshot.ready && this.deviceId !== null,
    };
  }

  private set(patch: Partial<PlayerState>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of [...this.listeners]) l(this.snapshot);
  }

  // ── Starting up: Getting Started, in order ───────────────────────────────

  async init(): Promise<void> {
    if (this.player) return; // Already up; the setup retry must not open a second device.
    try {
      // The token first: not being signed in is the common case, and it needs no script.
      await this.deps.fetchUserToken(false);
      const refused = await this.deps.networkAllows?.(SDK_URL);
      if (refused) {
        this.set({ ready: false, need: "setup", message: refused });
        return;
      }
      const sdk = await this.deps.loadSdk();
      const player = new sdk.Player({
        name: this.deps.deviceName ?? DEVICE_NAME,
        // Reference: asked on every connect() and whenever the token has expired; a later ask means
        // the last one expired, so that one is renewed first.
        getOAuthToken: (deliver) => {
          const renew = this.tokenAsks++ > 0;
          this.deps.fetchUserToken(renew).then(deliver, (error) =>
            this.set({
              ready: false,
              need: "setup",
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        },
      });
      this.wire(player);
      this.player = player;
      if (!(await player.connect())) {
        this.player = null;
        this.set({
          ready: false,
          need: "setup",
          message: "Spotify's player would not connect. Check the internet connection and that this account has Premium.",
        });
      }
    } catch (error) {
      this.player = null;
      this.set({
        ready: false,
        need: "setup",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Spotify signs in on the pond (the Music extension's settings), not on this page. */
  async authorize(): Promise<void> {
    throw new PlayerError(
      "unsupported",
      "Sign in to Spotify in the Music extension's settings; there is nothing to sign in to here.",
    );
  }

  /** Every event the Reference documents, in Getting Started's order; each error says its own fix. */
  private wire(player: SdkPlayer): void {
    const said = (e: { message?: string } | null | undefined) => (e?.message ? `: ${e.message}` : "");
    player.addListener("initialization_error", ((e: { message?: string }) => {
      this.set({
        ready: false,
        need: "setup",
        message: `Spotify's player could not start in this browser${said(e)}. Use Chrome, Firefox, Safari or Edge.`,
      });
    }) as (p: never) => void);
    player.addListener("authentication_error", ((e: { message?: string }) => {
      this.set({
        ready: false,
        need: "setup",
        message: `Spotify did not accept the sign-in${said(e)}. Sign in to Spotify again in the Music extension's settings.`,
      });
    }) as (p: never) => void);
    player.addListener("account_error", ((e: { message?: string }) => {
      this.set({
        ready: false,
        need: "setup",
        message: `Spotify's player needs a Premium account${said(e)}.`,
      });
    }) as (p: never) => void);
    // The Reference says only that loading or playing a track failed; it gives no remedy, so none is
    // attempted here: the words are shown and Spotify decides what plays next.
    player.addListener("playback_error", ((e: { message?: string }) => {
      this.set({ status: "error", message: `Spotify could not play this${said(e)}.` });
    }) as (p: never) => void);
    player.addListener("ready", ((payload: { device_id: string }) => {
      this.deviceId = payload.device_id;
      this.set({
        ready: true,
        need: this.activated ? "none" : "interaction",
        message: undefined,
      });
    }) as (p: never) => void);
    player.addListener("not_ready", (() => {
      this.deviceId = null;
      this.syncTicker(false);
      this.set({
        ready: false,
        message: "Spotify lost this player, usually because the internet went. It comes back on its own.",
      });
    }) as (p: never) => void);
    player.addListener("player_state_changed", ((state: SdkPlaybackState | null) => {
      this.fromSdk(state);
    }) as (p: never) => void);
    // Reference: autoplay was refused; activateElement() in a click is what allows it.
    player.addListener("autoplay_failed", (() => {
      this.activated = false;
      this.set({
        need: "interaction",
        message: "The browser did not let this page start the music. Press Play Spotify here.",
      });
    }) as (p: never) => void);
  }

  /**
   * The page's Play Spotify here button: `activateElement()` inside the click, then the Web API's
   * Transfer Playback to this device with `play: true`.
   */
  async activate(): Promise<void> {
    const player = this.player;
    if (!player || !this.deviceId) {
      throw new PlayerError("not_ready", this.snapshot.message ?? "Spotify's player is not ready yet.");
    }
    await player.activateElement();
    this.activated = true;
    this.set({ need: "none", message: undefined });
    await this.transferHere(this.deviceId);
  }

  private async transferHere(deviceId: string): Promise<void> {
    const refused = await this.deps.networkAllows?.(TRANSFER_URL);
    if (refused) {
      this.set({ message: refused });
      return;
    }
    const token = await this.deps.fetchUserToken(false);
    const res = await (this.deps.fetch ?? fetch)(TRANSFER_URL, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ device_ids: [deviceId], play: true }),
    });
    if (res.ok) return;
    this.set({
      message:
        res.status === 404
          ? "Nothing is playing on Spotify to bring here yet. Start something in the Spotify app, then press Play Spotify here, or choose Goose In A Pond in Spotify's list of devices."
          : res.status === 403
            ? "Spotify refused to move playback here. Moving playback needs Spotify Premium."
            : `Spotify did not move playback here (HTTP ${res.status}).`,
    });
  }

  /** Reads the position every second while playing, so the clock and the pond's view move. */
  private syncTicker(playing: boolean): void {
    if (!playing) {
      if (this.ticker) clearInterval(this.ticker);
      this.ticker = null;
      return;
    }
    if (this.ticker || !this.player) return;
    this.ticker = setInterval(() => {
      const player = this.player;
      if (!player) return;
      // A failed read is not worth a message: the next event or tick sets it right.
      void player.getCurrentState().then(
        (state) => state && this.fromSdk(state),
        () => undefined,
      );
    }, TICK_MS);
  }

  /** The SDK sends null when this device stops being the active one. */
  private fromSdk(state: SdkPlaybackState | null): void {
    if (!state) {
      this.syncTicker(false);
      this.set({ status: "idle", track: null, position_ms: 0, can: undefined });
      return;
    }
    const track = trackFrom(state.track_window?.current_track, state.duration ?? 0);
    let status: PlayerState["status"];
    if (!track) status = "idle";
    else if (!state.paused) status = state.loading ? "buffering" : "playing";
    else status = "paused";
    this.syncTicker(status === "playing");
    const d = state.disallows ?? {};
    this.set({
      status,
      track,
      position_ms: Math.max(0, Math.floor(state.position)),
      shuffle: state.shuffle === true,
      repeat: repeatFrom(state.repeat_mode),
      can: {
        pause: d.pausing !== true,
        resume: d.resuming !== true,
        next: d.skipping_next !== true,
        previous: d.skipping_prev !== true,
        seek: d.seeking !== true,
      },
      // Only music playing clears a problem; a pause is not a fix.
      ...(status === "playing" ? { message: undefined } : {}),
    });
  }

  // ── Transport, for the page's own control: the SDK's documented methods ────

  private ready(): SdkPlayer {
    if (!this.player || !this.snapshot.ready) {
      throw new PlayerError("not_ready", this.snapshot.message ?? "Spotify's player is not ready yet.");
    }
    return this.player;
  }

  async resume(): Promise<void> {
    await this.ready().resume();
  }
  async pause(): Promise<void> {
    await this.ready().pause();
  }
  async next(): Promise<void> {
    await this.ready().nextTrack();
  }
  async previous(): Promise<void> {
    await this.ready().previousTrack();
  }
  async seek(positionMs: number): Promise<void> {
    await this.ready().seek(Math.max(0, Math.floor(positionMs)));
  }
  async setVolume(percent: number): Promise<void> {
    const clamped = Math.min(100, Math.max(0, percent));
    await this.ready().setVolume(clamped / 100);
    this.set({ volume: clamped });
  }

  // ── Choosing music is Spotify's, in its own apps ────────────────────────────

  async search(): Promise<Track[]> {
    throw new PlayerError("unsupported", HAND_ONLY);
  }
  async play(_ref: ItemRef): Promise<void> {
    throw new PlayerError("unsupported", HAND_ONLY);
  }
  async enqueue(): Promise<void> {
    throw new PlayerError("unsupported", HAND_ONLY);
  }
  async setShuffle(): Promise<void> {
    throw new PlayerError("unsupported", HAND_ONLY);
  }
  async setRepeat(): Promise<void> {
    throw new PlayerError("unsupported", HAND_ONLY);
  }
  async playlists(): Promise<PlaylistInfo[]> {
    throw new PlayerError("unsupported", HAND_ONLY);
  }
  async library(_kind: LibraryKind, _limit: number): Promise<Track[]> {
    throw new PlayerError("unsupported", HAND_ONLY);
  }
}
