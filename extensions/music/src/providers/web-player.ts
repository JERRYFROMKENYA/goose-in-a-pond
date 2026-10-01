import { describeError, log } from "../log.js";
import { pickSong } from "../match.js";
import { PlayerFailure, PlayerUnavailable, type PlayerHost } from "./player/host.js";
import {
  UnsupportedError,
  type ArtistInfo,
  type DeviceInfo,
  type MusicProvider,
  type PlayRequest,
  type PlayTarget,
  type PlaylistInfo,
  type RepeatState,
  type ServiceId,
  type TimeRange,
  type ToolWording,
  type TrackInfo,
} from "./types.js";

/** A track as the player page reports it. */
interface WireTrack {
  id: string;
  kind: "song" | "album" | "playlist";
  title: string;
  artist: string;
  album: string;
  duration_ms: number;
}

interface WireState {
  status: string;
  track: WireTrack | null;
  position_ms: number;
  volume: number;
  need: string;
  message?: string;
}

export interface WebPlayerDeps {
  host: PlayerHost;
  service: ServiceId;
  label: string;
  /** The service's own way of driving something else, used when the player cannot be. */
  local: MusicProvider | null;
  /** The id in a link a person pasted, for services that have such links. */
  linkToId?: (link: string) => string | null;
}

/** How long a song gets to start: the page confirms real audio, which takes a moment to buffer. */
const PLAY_WAIT_MS = 30_000;

/** The player could not be used, but something else can play instead. */
function canUseFallback(error: unknown): boolean {
  if (error instanceof PlayerUnavailable) {
    return ["no_player", "player_gone", "player_replaced", "host_unreachable"].includes(error.code);
  }
  if (error instanceof PlayerFailure) {
    return ["not_ready", "needs_authorization", "drm_refused"].includes(error.code);
  }
  return false;
}

/**
 * A music service driven through the music player page, which runs in the person's browser: the page
 * holds the service's SDK, the browser its DRM, and this reaches it through the host. Knows no service; it is handed a name and a label. When the
 * player cannot be used it says so and, if there is a fallback, uses it.
 */
export class WebPlayerProvider implements MusicProvider {
  readonly id: ServiceId;
  readonly name: string;
  // No devices: the player outputs to the Mac's chosen sound output, which is not its to switch.
  readonly capabilities = { devices: false, queue: true, timeRange: false };
  readonly describe: ToolWording;

  constructor(private readonly deps: WebPlayerDeps) {
    this.id = deps.service;
    this.name = deps.label;
    this.describe = {
      play: `Play music in ${deps.label}, in the music player page, which plays in the user's web browser. Songs from the whole ${deps.label} catalog start at once. Search picks the closest match, which is not always what was asked for — tell the user the track name and artist FROM THE RESULT, never the name they asked for, and repeat what the result says happened rather than assuming playback started. If the result says the player needs the user, such as a sign-in or a click on the page, tell them exactly that. This plays ${deps.label} only: if the user asks for Spotify, say the assistant cannot control Spotify, and do not play it on ${deps.label} instead.`,
      playNext: "'next' puts the song right after the current one and lets the current track finish. Default 'now' replaces what is playing.",
      playUri: `A pasted ${deps.label} song link, or a URI from an earlier result. Plays it directly.`,
    };
  }

  private get host(): PlayerHost {
    return this.deps.host;
  }

  private get local(): MusicProvider | null {
    return this.deps.local;
  }

  // ── Identity of things ─────────────────────────────────────

  private get prefix(): string {
    return `${this.deps.service}:web:`;
  }

  private uriOf(t: WireTrack): string {
    return `${this.prefix}${t.kind}:${t.id}`;
  }

  private parseUri(uri: string): { kind: string; id: string } | null {
    const m = uri.startsWith(this.prefix)
      ? uri.slice(this.prefix.length).match(/^(song|album|playlist):(.+)$/)
      : null;
    return m ? { kind: m[1], id: m[2] } : null;
  }

  private toTrackInfo(t: WireTrack): TrackInfo {
    return {
      id: t.id,
      name: t.title,
      artist: t.artist,
      album: t.album,
      duration_ms: t.duration_ms,
      uri: this.uriOf(t),
    };
  }

  // ── The player, or its fallback ────────────────────────────

  private async viaPlayer<T>(
    run: () => Promise<T>,
    fallback?: (local: MusicProvider) => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const local = this.local;
      if (!fallback || !local || !canUseFallback(error)) throw error;
      log.warn("web_player_fallback", "the music player page could not be used", {
        error: describeError(error),
      });
      return fallback(local);
    }
  }

  private static because(error: unknown): string {
    const why = error instanceof Error ? error.message : String(error);
    return `The music player page could not be used (${why}), so the Music app was used instead.\n\n`;
  }

  // ── Playing ────────────────────────────────────────────────

  async playRequest(request: PlayRequest): Promise<string> {
    try {
      return await this.playFromPlayer(request);
    } catch (error) {
      const local = this.local;
      if (!local?.playRequest || !canUseFallback(error)) throw error;
      log.warn("web_player_fallback", "the music player page could not be used", {
        error: describeError(error),
      });
      return WebPlayerProvider.because(error) + (await local.playRequest(request));
    }
  }

  private async playFromPlayer({ query, uri }: PlayRequest): Promise<string> {
    if (uri) {
      const parsed = this.parseUri(uri);
      const id = parsed?.id ?? this.deps.linkToId?.(uri) ?? null;
      if (!id) return `That does not look like a link to a song on ${this.name}: ${uri}`;
      await this.host.call("play", { id, kind: parsed?.kind ?? "song" }, PLAY_WAIT_MS);
      return this.describeNowPlaying();
    }

    if (!query) {
      await this.host.call("resume", {}, PLAY_WAIT_MS);
      return "Resumed playback";
    }

    const { tracks } = await this.host.call<{ tracks: WireTrack[] }>("search", { query, limit: 5 });
    if (tracks.length === 0) return `No results found for "${query}". Try a different search.`;

    const infos = tracks.map(t => this.toTrackInfo(t));
    const top = pickSong(query, infos) ?? infos[0];
    const wire = tracks[infos.indexOf(top)];
    await this.host.call("play", { id: wire.id, kind: wire.kind }, PLAY_WAIT_MS);

    let text = `Now playing track: ${top.name} by ${top.artist} (${top.album})`;
    const others = infos.filter(t => t !== top).slice(0, 3);
    if (others.length > 0) {
      text += "\n\nOther matches:\n" + others.map((t, i) => `${i + 2}. ${t.name} by ${t.artist}`).join("\n");
    }
    return text;
  }

  private async describeNowPlaying(): Promise<string> {
    const state = await this.host.call<WireState>("state");
    return state.track
      ? `Now playing track: ${state.track.title} by ${state.track.artist} (${state.track.album})`
      : "Started playback.";
  }

  async play(target?: PlayTarget): Promise<string> {
    if (!target) {
      await this.viaPlayer(
        () => this.host.call("resume", {}, PLAY_WAIT_MS),
        l => l.play().then(() => undefined),
      );
      return "Resumed playback";
    }

    const uri = typeof target === "string" ? target : target.uri;
    const parsed = this.parseUri(uri);
    if (parsed) {
      await this.host.call("play", parsed, PLAY_WAIT_MS);
      return `Playing ${uri}`;
    }
    // Not this player's: a library track or playlist from the fallback keeps its own way of playing.
    if (this.local) return this.local.play(target);
    throw new UnsupportedError(`${this.name} cannot play ${uri} directly.`);
  }

  async addToQueue(uri: string): Promise<string> {
    const parsed = this.parseUri(uri);
    if (!parsed) throw new UnsupportedError(`${this.name} cannot queue ${uri}.`);
    await this.host.call("enqueue", { ...parsed, where: "next" });
    return "Added to queue";
  }

  // ── Transport ──────────────────────────────────────────────

  async pause(): Promise<string> {
    await this.viaPlayer(() => this.host.call("pause"), l => l.pause().then(() => undefined));
    return "Playback paused";
  }

  async next(): Promise<string> {
    await this.viaPlayer(() => this.host.call("next"), l => l.next().then(() => undefined));
    return "Skipped to next track";
  }

  async previous(): Promise<string> {
    await this.viaPlayer(() => this.host.call("previous"), l => l.previous().then(() => undefined));
    return "Went to previous track";
  }

  async setVolume(percent: number): Promise<string> {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    await this.viaPlayer(
      () => this.host.call("volume", { percent: clamped }),
      l => l.setVolume(clamped).then(() => undefined),
    );
    return `Volume set to ${clamped}%`;
  }

  async setShuffle(enabled: boolean): Promise<string> {
    await this.viaPlayer(
      () => this.host.call("shuffle", { enabled }),
      l => l.setShuffle(enabled).then(() => undefined),
    );
    return `Shuffle ${enabled ? "enabled" : "disabled"}`;
  }

  async seek(positionMs: number): Promise<string> {
    const clamped = Math.max(0, Math.round(positionMs));
    await this.viaPlayer(
      () => this.host.call("seek", { position_ms: clamped }),
      l => l.seek(clamped).then(() => undefined),
    );
    const mins = Math.floor(clamped / 60000);
    const secs = String(Math.floor((clamped % 60000) / 1000)).padStart(2, "0");
    return `Jumped to ${mins}:${secs}`;
  }

  async setRepeat(state: RepeatState): Promise<string> {
    const mode = state === "track" ? "one" : state === "context" ? "all" : "off";
    await this.viaPlayer(
      () => this.host.call("repeat", { mode }),
      l => l.setRepeat(state).then(() => undefined),
    );
    return state === "off"
      ? "Repeat off"
      : state === "track"
        ? "Repeating this track"
        : "Repeating the album or playlist";
  }

  // ── What is playing, and the user's things ─────────────────

  async getNowPlaying(): Promise<TrackInfo | null> {
    return this.viaPlayer(
      async () => {
        const state = await this.host.call<WireState>("state");
        if (!state.track) return null;
        return {
          ...this.toTrackInfo(state.track),
          is_playing: state.status === "playing",
          progress_ms: state.position_ms,
          volume_percent: state.volume,
        };
      },
      l => l.getNowPlaying(),
    );
  }

  async getQueue(): Promise<TrackInfo[]> {
    const now = await this.getNowPlaying();
    return now ? [now] : [];
  }

  async searchTracks(query: string, limit: number = 10): Promise<TrackInfo[]> {
    const { tracks } = await this.host.call<{ tracks: WireTrack[] }>("search", { query, limit });
    return tracks.map(t => this.toTrackInfo(t));
  }

  async getPlaylists(limit: number = 200): Promise<PlaylistInfo[]> {
    return this.viaPlayer(
      async () => {
        const { playlists } = await this.host.call<{ playlists: Array<{ id: string; name: string }> }>(
          "playlists",
        );
        return playlists.slice(0, limit).map(p => ({
          id: p.id,
          name: p.name,
          description: "",
          track_count: 0,
          uri: `${this.prefix}playlist:${p.id}`,
          owner: "you",
          is_own: true,
        }));
      },
      l => l.getPlaylists(limit),
    );
  }

  async getSavedTracks(limit: number = 20): Promise<TrackInfo[]> {
    return this.viaPlayer(
      async () => {
        const { tracks } = await this.host.call<{ tracks: WireTrack[] }>("library", { kind: "saved", limit });
        return tracks.map(t => this.toTrackInfo(t));
      },
      l => l.getSavedTracks(limit),
    );
  }

  async getRecentlyPlayed(limit: number = 20): Promise<TrackInfo[]> {
    return this.viaPlayer(
      async () => {
        const { tracks } = await this.host.call<{ tracks: WireTrack[] }>("library", { kind: "recent", limit });
        return tracks.map(t => this.toTrackInfo(t));
      },
      l => l.getRecentlyPlayed(limit),
    );
  }

  // The catalog API has no play counts; the Music app keeps them, so its answer stands in.
  async getTopTracks(range: TimeRange, limit?: number): Promise<TrackInfo[]> {
    if (!this.local) throw new UnsupportedError(`${this.name} does not report what is played most.`);
    return this.local.getTopTracks(range, limit);
  }

  async getTopArtists(range: TimeRange, limit?: number): Promise<ArtistInfo[]> {
    if (!this.local) throw new UnsupportedError(`${this.name} does not report what is played most.`);
    return this.local.getTopArtists(range, limit);
  }


  async getDevices(): Promise<DeviceInfo[]> {
    throw new UnsupportedError(`The ${this.name} player plays through the Mac's sound output; change it in the Sound settings.`);
  }

  async transferPlayback(): Promise<string> {
    throw new UnsupportedError(`The ${this.name} player plays through the Mac's sound output.`);
  }
}
