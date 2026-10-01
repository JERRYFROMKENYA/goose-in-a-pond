// Apple Music through MusicKit on the Web (v3), used the way Apple's documentation shows, in the kind
// of place it documents: an ordinary web page, in the person's own browser. Only this file knows
// MusicKit's vocabulary; everything it hands back is the player's own (types.ts).
//
// What it follows, page by page (https://js-cdn.music.apple.com/musickit/v3/docs/index.html):
// - Getting Started: Apple's hosted script, with `async`; wait for `musickitloaded` on `document`;
//   `await MusicKit.configure({ developerToken, app })`, which resolves to the instance.
// - User Authorization: `authorize()` opens Apple's sign-in and resolves with nothing when it did not
//   finish. The page calls it from a click.
// - Queue: `setQueue({ song | album | playlist: id, startPlaying: true })` starts playback; a queue
//   that resolves to nothing means this environment cannot play.
// - MusicKit Instance: `play()` can fail until the person has interacted with the page
//   (USER_INTERACTION_REQUIRED), so the page's own Play button is how a first play gets allowed.
// - Events and MKError: state is read from the instance on its events; a playback failure arrives as
//   an MKError on `mediaPlaybackError`, its code in `errorCode`.
// - Using Album Art: `MusicKit.formatArtworkURL(artwork, width, height)`.
// - Apple Developer Program License Agreement 3.3.6(D): full songs, playback the person starts, and
//   standard play, pause and skip controls, which the page always shows.

import {
  PlayerError,
  type AdapterCapabilities,
  type ItemKind,
  type ItemRef,
  type LibraryKind,
  type PlayerAdapter,
  type PlayerState,
  type PlaylistInfo,
  type RepeatMode,
  type Track,
  type Unsubscribe,
} from "../types";

/** An Apple Music API Artwork object. `url` is a template with `{w}` and `{h}` in it. */
export interface Artwork {
  url?: string;
  width?: number;
  height?: number;
}

/** A MediaItem as the Events reference reads it: the song's fields are under `attributes`. */
export interface MediaItem {
  id?: string;
  attributes?: {
    name?: string;
    artistName?: string;
    albumName?: string;
    durationInMillis?: number;
    artwork?: Artwork;
    playParams?: { id?: string; catalogId?: string };
  };
}

/** The parts of the MusicKit Instance reference this adapter touches. */
export interface MusicKitInstance {
  readonly isAuthorized: boolean;
  volume: number;
  shuffleMode: number;
  repeatMode: number;
  readonly playbackState: number;
  readonly currentPlaybackTime: number;
  readonly nowPlayingItem: MediaItem | undefined;
  readonly api: {
    music(path: string, queryParameters?: Record<string, unknown>): Promise<unknown>;
  };
  authorize(): Promise<string | void>;
  unauthorize(): Promise<unknown>;
  setQueue(options: Record<string, unknown>): Promise<unknown>;
  /** Declared `void` in the reference; a browser that refuses to play can surface that as a rejection. */
  play(): unknown;
  pause(): unknown;
  skipToNextItem(): Promise<unknown>;
  skipToPreviousItem(): Promise<unknown>;
  seekToTime(seconds: number): Promise<unknown>;
  playNext(options: Record<string, unknown>): Promise<unknown>;
  playLater(options: Record<string, unknown>): Promise<unknown>;
  addEventListener(name: string, callback: (event: unknown) => void): void;
  removeEventListener(name: string, callback: (event: unknown) => void): void;
}

/** The `MusicKit` global, as the MusicKit reference documents it. */
export interface MusicKitGlobal {
  configure(config: {
    developerToken: string;
    app: { name: string; build?: string };
  }): Promise<MusicKitInstance | undefined>;
  getInstance(): MusicKitInstance | undefined;
  formatArtworkURL(artwork: Artwork, width?: number, height?: number): string;
  PlaybackStates: Record<
    | "none"
    | "loading"
    | "playing"
    | "paused"
    | "stopped"
    | "ended"
    | "seeking"
    | "waiting"
    | "stalled"
    | "completed",
    number
  >;
  PlayerShuffleMode: { off: number; songs: number };
  PlayerRepeatMode: { none: number; one: number; all: number };
}

export interface AppleDeps {
  loadMusicKit(): Promise<MusicKitGlobal>;
  /** Asks the pond, which holds the key, for a signed developer token. */
  fetchDeveloperToken(): Promise<string>;
  /**
   * Asks the pond whether its network setting lets this page reach Apple at all: null when it does,
   * else the reason, in words for a person. Asked before Apple's script is loaded.
   */
  networkAllows?(url: string): Promise<string | null>;
  /** How long a played song has to start before it is reported as not starting. */
  playConfirmMs?: number;
}

export const MUSICKIT_URL = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
/** `app.name` is shown in Apple's sign-in; `build` is optional and left out rather than made up. */
const APP = { name: "Goose In A Pond" };
/** Audio that has advanced this far is really playing, not just announced. */
const PLAYING_AFTER_MS = 500;
/** Artwork is asked for at the size the page shows it, twice over for sharp screens. */
const ARTWORK_PX = 300;

/**
 * Getting Started, exactly: a script tag for Apple's hosted MusicKit, `async`, and the `MusicKit`
 * global used only after `musickitloaded` fires on the document.
 */
export function loadMusicKitFromApple(): Promise<MusicKitGlobal> {
  return new Promise((resolve, reject) => {
    const existing = (window as unknown as { MusicKit?: MusicKitGlobal }).MusicKit;
    if (existing) return resolve(existing);
    document.addEventListener(
      "musickitloaded",
      () => resolve((window as unknown as { MusicKit: MusicKitGlobal }).MusicKit),
      { once: true },
    );
    const script = document.createElement("script");
    script.src = MUSICKIT_URL;
    script.async = true;
    script.onerror = () =>
      reject(
        new Error(
          "Could not load MusicKit from Apple. Check this computer's internet connection.",
        ),
      );
    document.head.appendChild(script);
  });
}

/**
 * An MKError (the MKError reference) in words a person can act on. The code is in `errorCode`; the
 * reference documents what each means, and a remedy only for USER_INTERACTION_REQUIRED and for
 * authorization, so the other messages say what happened rather than guess at a fix.
 */
export function describeMkError(error: unknown): PlayerError {
  const e = (error ?? {}) as { errorCode?: unknown; description?: unknown; message?: unknown };
  const code = typeof e.errorCode === "string" ? e.errorCode : "";
  const detail = String(e.description ?? e.message ?? "").trim();
  switch (code) {
    case "USER_INTERACTION_REQUIRED":
      return new PlayerError(
        "needs_interaction",
        "The browser wants a click on the music player page before it plays sound. Press Play there once.",
      );
    case "AUTHORIZATION_ERROR":
    case "TOKEN_EXPIRED":
      return new PlayerError(
        "needs_authorization",
        "Apple Music needs you to sign in again on the music player page.",
      );
    case "SUBSCRIPTION_ERROR":
      return new PlayerError(
        "player_error",
        "The Apple Account signed in here has no active Apple Music subscription.",
      );
    case "STREAM_UPSELL":
      return new PlayerError(
        "player_error",
        "Apple Music is playing on another device with this account, and the plan plays on one at a time.",
      );
    case "DEVICE_LIMIT":
      return new PlayerError(
        "player_error",
        "This Apple Account has reached its limit of devices for Apple Music.",
      );
    case "MEDIA_LICENSE":
    case "MEDIA_KEY":
    case "MEDIA_SESSION":
    case "MEDIA_CERTIFICATE":
      return new PlayerError(
        "drm_refused",
        `This browser could not get the licence to play that song (${code}).`,
      );
    case "WIDEVINE_CDM_EXPIRED":
      return new PlayerError(
        "drm_refused",
        "This browser's DRM module is too old for Apple Music to license. Update the browser, then try again.",
      );
    case "OUTPUT_RESTRICTED":
      return new PlayerError(
        "drm_refused",
        "The display or audio output here does not allow protected playback (HDCP).",
      );
    case "CONTENT_UNAVAILABLE":
    case "CONTENT_RESTRICTED":
    case "CONTENT_UNSUPPORTED":
    case "NOT_FOUND":
      return new PlayerError("player_error", "That is not available to play here.");
    case "UNAUTHORIZED_ERROR":
    case "CONFIGURATION_ERROR":
      return new PlayerError(
        "not_ready",
        "Apple Music did not accept this pond's developer token. Check the Apple Music settings in the Music extension.",
      );
    case "NETWORK_ERROR":
    case "SERVICE_UNAVAILABLE":
    case "SERVER_ERROR":
      return new PlayerError(
        "player_error",
        "Apple Music could not be reached. Check this computer's internet connection.",
      );
    default:
      return new PlayerError(
        "player_error",
        `Apple Music could not play this${detail ? `: ${detail}` : ""}${code ? ` (${code})` : ""}.`,
      );
  }
}

/** The Passthrough API resolves to `{ data: body }`, and a list endpoint's body has its own `data`. */
function body(reply: unknown): Record<string, unknown> {
  const inner = ((reply ?? {}) as { data?: unknown }).data;
  return inner && typeof inner === "object" ? (inner as Record<string, unknown>) : {};
}

export class AppleMusicKitAdapter implements PlayerAdapter {
  readonly service = "apple";
  readonly label = "Apple Music";
  readonly capabilities: AdapterCapabilities = {
    queue: true,
    playlists: true,
    library: true,
  };

  private mk: MusicKitGlobal | null = null;
  private music: MusicKitInstance | null = null;
  private failure: PlayerError | null = null;
  /** Why the last sign-in did not finish, shown until one does. */
  private signInNote: string | null = null;
  private readonly listeners = new Set<(s: PlayerState) => void>();
  private snapshot: PlayerState = {
    service: "apple",
    ready: false,
    need: "setup",
    status: "idle",
    track: null,
    position_ms: 0,
    volume: 100,
    shuffle: false,
    repeat: "off",
    message: "Starting Apple Music...",
  };

  constructor(private readonly deps: AppleDeps) {}

  state(): PlayerState {
    return this.snapshot;
  }

  onState(listener: (state: PlayerState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<PlayerState>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of [...this.listeners]) l(this.snapshot);
  }

  // ── Starting up: Getting Started, in order ───────────────────────────────

  async init(): Promise<void> {
    if (this.music) return; // Already configured: the instance is a singleton.
    try {
      // The token first: it comes from the pond, and without one there is nothing to configure. The
      // network question second, since the pond logs a yes as a request this page is about to make.
      const developerToken = await this.deps.fetchDeveloperToken();
      const refused = await this.deps.networkAllows?.(MUSICKIT_URL);
      if (refused) {
        this.set({ ready: false, need: "setup", message: refused });
        return;
      }
      const mk = await this.deps.loadMusicKit();
      const music = (await mk.configure({ developerToken, app: APP })) ?? mk.getInstance();
      if (!music) throw new Error("MusicKit did not return an instance after configure().");
      this.mk = mk;
      this.music = music;
      this.wire(music);
      this.refresh();
    } catch (error) {
      this.set({
        ready: false,
        need: "setup",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** User Authorization: from a click on the page, so Apple's sign-in window is allowed to open. */
  async authorize(): Promise<void> {
    const music = this.configured();
    let user: string | void;
    try {
      user = await music.authorize();
    } catch (error) {
      user = undefined;
      this.signInNote = describeMkError(error).message;
    }
    if (user) this.signInNote = null;
    else this.signInNote ??= "The Apple Music sign-in did not finish. Press Sign in to try again.";
    this.refresh();
  }

  /** Signs this page out of Apple Music: `unauthorize()` invalidates the Music User Token. */
  async signOut(): Promise<void> {
    await this.configured().unauthorize();
    this.refresh();
  }

  /** The instance's events, as the Events reference lists them; every one re-reads the instance. */
  private wire(music: MusicKitInstance): void {
    const sync = () => this.refresh();
    for (const name of [
      "playbackStateDidChange",
      "nowPlayingItemDidChange",
      "playbackTimeDidChange",
      "playbackVolumeDidChange",
      "shuffleModeDidChange",
      "repeatModeDidChange",
      "authorizationStatusDidChange",
    ]) {
      music.addEventListener(name, sync);
    }
    music.addEventListener("mediaPlaybackError", (error) => {
      this.failure = describeMkError(error);
      this.refresh();
    });
    // Documented: playback fell back to previews because DRM could not be set up here.
    music.addEventListener("drmUnsupported", () => {
      this.failure = new PlayerError(
        "drm_refused",
        "This browser cannot play protected Apple Music audio, so only previews would play. Use Safari, Chrome, Edge or Firefox.",
      );
      this.refresh();
    });
    // Documented: playback started in another tab on this address, and this one stopped.
    music.addEventListener("primaryPlayerDidChange", () => {
      this.set({
        message: "Apple Music started playing in another tab of this music player, so this one stopped.",
      });
    });
  }

  /** Rebuilds the snapshot from the instance, the one source of truth. */
  private refresh(): void {
    const { mk, music } = this;
    if (!mk || !music) return;

    const S = mk.PlaybackStates;
    const p = music.playbackState;
    let status: PlayerState["status"] = "idle";
    if (p === S.playing) status = "playing";
    else if (p === S.paused) status = "paused";
    else if (p === S.loading || p === S.waiting || p === S.stalled || p === S.seeking)
      status = "buffering";
    else if (p === S.ended || p === S.completed) status = "ended";
    // An error stays until the next attempt: MusicKit walks through paused and seeking after it.
    if (this.failure) status = "error";

    const item = music.nowPlayingItem;
    const a = item?.attributes;
    const art = a?.artwork?.url ? mk.formatArtworkURL(a.artwork, ARTWORK_PX, ARTWORK_PX) : undefined;
    const track: Track | null =
      item?.id && a?.name
        ? {
            id: item.id,
            kind: "song",
            title: a.name,
            artist: a.artistName ?? "",
            album: a.albumName ?? "",
            duration_ms: a.durationInMillis ?? 0,
            ...(art ? { artwork_url: art } : {}),
          }
        : null;

    const signedIn = music.isAuthorized;
    this.set({
      ready: signedIn,
      need: signedIn ? "none" : "authorization",
      status,
      track,
      position_ms: Math.round((music.currentPlaybackTime || 0) * 1000),
      volume: Math.round((music.volume ?? 1) * 100),
      shuffle: music.shuffleMode === mk.PlayerShuffleMode.songs,
      repeat:
        music.repeatMode === mk.PlayerRepeatMode.one
          ? "one"
          : music.repeatMode === mk.PlayerRepeatMode.all
            ? "all"
            : "off",
      // Not being signed in is `need`, not a problem; the message is only ever the last problem.
      message: this.failure?.message ?? (signedIn ? undefined : (this.signInNote ?? undefined)),
    });
  }

  // ── Guards ───────────────────────────────────────────────────────────────

  private configured(): MusicKitInstance {
    if (!this.music) {
      throw new PlayerError("not_ready", this.snapshot.message ?? "Apple Music is not set up.");
    }
    return this.music;
  }

  /** Full playback and the person's library need a sign-in (User Authorization). */
  private signedIn(): MusicKitInstance {
    const music = this.configured();
    if (!music.isAuthorized) {
      throw new PlayerError(
        "needs_authorization",
        "Sign in to Apple Music on the music player page first.",
      );
    }
    return music;
  }

  private async api(path: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      return body(await this.configured().api.music(path, params));
    } catch (error) {
      if (error instanceof PlayerError) throw error;
      throw describeMkError(error);
    }
  }

  private track(item: MediaItem, kind: ItemKind = "song"): Track | null {
    const a = item.attributes;
    if (!a?.name) return null;
    // A library entry's own id is not playable everywhere; the catalog id is.
    const id = a.playParams?.catalogId ?? a.playParams?.id ?? item.id;
    if (!id) return null;
    const art = a.artwork?.url && this.mk ? this.mk.formatArtworkURL(a.artwork, ARTWORK_PX, ARTWORK_PX) : undefined;
    return {
      id,
      kind,
      title: a.name,
      artist: a.artistName ?? "",
      album: a.albumName ?? "",
      duration_ms: a.durationInMillis ?? 0,
      ...(art ? { artwork_url: art } : {}),
    };
  }

  // ── Finding things: the Passthrough API, with the {{storefrontId}} path token ─

  async search(query: string, opts: { limit?: number } = {}): Promise<Track[]> {
    const limit = Math.max(1, Math.min(25, opts.limit ?? 5));
    const reply = await this.api("/v1/catalog/{{storefrontId}}/search", {
      term: query,
      types: "songs",
      limit,
    });
    const songs = (reply.results as { songs?: { data?: MediaItem[] } } | undefined)?.songs?.data ?? [];
    return songs.map((s) => this.track(s)).filter((t): t is Track => t !== null);
  }

  /** Paginated Requests: follow `next`, and pass `limit` again, since `next` does not carry it. */
  async playlists(): Promise<PlaylistInfo[]> {
    this.signedIn();
    const out: PlaylistInfo[] = [];
    let path: string | undefined = "/v1/me/library/playlists";
    // Three pages is 300 playlists; beyond that a spoken name would not find one anyway.
    for (let page = 0; page < 3 && path; page++) {
      const reply = await this.api(path, { limit: 100 });
      for (const p of (reply.data as MediaItem[] | undefined) ?? []) {
        if (p.id && p.attributes?.name) out.push({ id: p.id, name: p.attributes.name });
      }
      path = typeof reply.next === "string" ? reply.next : undefined;
    }
    return out;
  }

  async library(kind: LibraryKind, limit: number): Promise<Track[]> {
    this.signedIn();
    const capped = Math.max(1, Math.min(kind === "recent" ? 30 : 100, limit));
    const path = kind === "recent" ? "/v1/me/recent/played/tracks" : "/v1/me/library/songs";
    const reply = await this.api(path, { limit: capped });
    return ((reply.data as MediaItem[] | undefined) ?? [])
      .map((s) => this.track(s))
      .filter((t): t is Track => t !== null);
  }

  // ── Playing ──────────────────────────────────────────────────────────────

  /**
   * Resolves once the position has really advanced, rejects on an error event or a timeout.
   * Registered before playback is asked for, so an error that arrives at once is not missed.
   */
  private confirmPlaying(): { done: Promise<void>; cancel(): void } {
    let cancel = () => undefined as void;
    const done = new Promise<void>((resolve, reject) => {
      const finish = (settle: () => void) => {
        off();
        clearTimeout(timer);
        settle();
      };
      const check = (s: PlayerState) => {
        if (this.failure) finish(() => reject(this.failure));
        else if (s.status === "playing" && s.position_ms >= PLAYING_AFTER_MS) finish(resolve);
      };
      const off = this.onState(check);
      const wait = this.deps.playConfirmMs ?? 15_000;
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new PlayerError(
                "player_error",
                `Apple Music did not start playing within ${Math.round(wait / 1000)} seconds.`,
              ),
            ),
          ),
        wait,
      );
      cancel = () => finish(() => undefined);
      check(this.snapshot);
    });
    return { done, cancel };
  }

  private async begin(start: () => Promise<unknown>): Promise<void> {
    this.failure = null;
    const confirm = this.confirmPlaying();
    // Nobody else awaits this until `start` finishes; a rejection meanwhile is handled below.
    confirm.done.catch(() => undefined);
    try {
      await start();
    } catch (error) {
      confirm.cancel();
      this.failure = error instanceof PlayerError ? error : describeMkError(error);
      this.refresh();
      throw this.failure;
    }
    await confirm.done;
  }

  async play(ref: ItemRef): Promise<void> {
    const music = this.signedIn();
    await this.begin(async () => {
      const queue = await music.setQueue({ [ref.kind]: ref.id, startPlaying: true });
      if (queue === undefined) {
        throw new PlayerError("unsupported", "Apple Music says this browser cannot play it.");
      }
    });
  }

  async resume(): Promise<void> {
    const music = this.signedIn();
    await this.begin(async () => {
      await music.play();
    });
  }

  async enqueue(ref: ItemRef, where: "next" | "last"): Promise<void> {
    const music = this.signedIn();
    const options = { [ref.kind]: ref.id };
    await (where === "next" ? music.playNext(options) : music.playLater(options));
  }

  async pause(): Promise<void> {
    await this.configured().pause();
  }

  async next(): Promise<void> {
    await this.signedIn().skipToNextItem();
  }

  async previous(): Promise<void> {
    await this.signedIn().skipToPreviousItem();
  }

  async seek(positionMs: number): Promise<void> {
    await this.signedIn().seekToTime(Math.max(0, positionMs) / 1000);
  }

  async setVolume(percent: number): Promise<void> {
    this.configured().volume = Math.max(0, Math.min(100, percent)) / 100;
    this.refresh();
  }

  async setShuffle(enabled: boolean): Promise<void> {
    const music = this.configured();
    const modes = this.mk!.PlayerShuffleMode;
    music.shuffleMode = enabled ? modes.songs : modes.off;
    this.refresh();
  }

  async setRepeat(mode: RepeatMode): Promise<void> {
    const music = this.configured();
    const modes = this.mk!.PlayerRepeatMode;
    music.repeatMode = mode === "one" ? modes.one : mode === "all" ? modes.all : modes.none;
    this.refresh();
  }
}
