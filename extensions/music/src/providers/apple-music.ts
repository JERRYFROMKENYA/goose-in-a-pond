import { describeError, log } from "../log.js";
import { normalizeName, pickSong, splitTitleArtist } from "../match.js";
import { musicAppUrl, songIdFromLink, type CatalogSong, type CatalogSource } from "./apple/catalog.js";
import type { LibraryTrack, MusicApp } from "./apple/music-app.js";
import {
  UnsupportedError,
  type ArtistInfo,
  type DeviceInfo,
  type MusicProvider,
  type PlayRequest,
  type PlayTarget,
  type PlaylistInfo,
  type RepeatState,
  type TimeRange,
  type TrackInfo,
} from "./types.js";

const LIBRARY_PREFIX = "apple:library:";
const PLAYLIST_PREFIX = "apple:playlist:";

export interface AppleDeps {
  app: MusicApp;
  /** Apple's public, keyless catalog search: names a song and finds its page. */
  catalog: CatalogSource;
}

function toTrackInfo(t: LibraryTrack): TrackInfo {
  return {
    id: t.pid,
    name: t.name,
    artist: t.artist,
    album: t.album,
    duration_ms: t.duration_s * 1000,
    uri: `${LIBRARY_PREFIX}${t.pid}`,
  };
}

const firstArtist = (artist: string) => artist.split(/,|&/)[0].trim();

/** The longest word of a title, for a second library search when the punctuation defeats the first. */
function longestWord(title: string): string {
  return normalizeName(title)
    .split(" ")
    .reduce((best, w) => (w.length > best.length ? w : best), "");
}

/**
 * Apple Music through the Music app. The Music app plays and controls the user's library; it
 * cannot search Apple's catalog or start a song that is not in the library. So a song the library
 * lacks is found through the public search and opened in Music, which does not start it. The
 * music player page (web-player.ts) is what plays the catalog; this is its fallback.
 */
export class AppleMusicProvider implements MusicProvider {
  id = "apple" as const;
  name = "Apple Music";
  capabilities = { devices: true, queue: false, timeRange: false };
  describe = {
    play:
      "Play music in Apple Music, through the Music app. A song in the user's library starts at once; one only in the Apple Music catalog is opened in the Music app, which does not start it. Search picks the closest match, which is not always what was asked for — tell the user the track name and artist FROM THE RESULT, never the name they asked for, and repeat what the result says happened rather than assuming playback started. This plays Apple Music only: if the user asks for Spotify, say the assistant cannot control Spotify, and do not play it on Apple Music instead.",
    playUri: "A pasted Apple Music song link, or a URI from an earlier result. Plays it directly.",
  };

  constructor(private readonly deps: AppleDeps) {}

  private get app(): MusicApp {
    return this.deps.app;
  }

  // ── Playing ────────────────────────────────────────────────

  async playRequest({ query, uri }: PlayRequest): Promise<string> {
    if (uri) return this.playUri(uri);
    if (query) return this.playQuery(query);
    return this.play();
  }

  async play(target?: PlayTarget): Promise<string> {
    if (!target) {
      await this.app.transport("play");
      return "Resumed playback";
    }

    const uri = typeof target === "string" ? target : target.uri;
    if (uri.startsWith(LIBRARY_PREFIX)) {
      await this.app.playTrack(uri.slice(LIBRARY_PREFIX.length));
      return `Playing ${uri}`;
    }
    if (uri.startsWith(PLAYLIST_PREFIX)) {
      await this.app.playPlaylist(uri.slice(PLAYLIST_PREFIX.length));
      return `Playing ${uri}`;
    }
    throw new UnsupportedError(`Apple Music cannot play ${uri} directly.`);
  }

  private async playUri(uri: string): Promise<string> {
    if (uri.startsWith(LIBRARY_PREFIX) || uri.startsWith(PLAYLIST_PREFIX)) return this.play(uri);

    const id = songIdFromLink(uri);
    if (!id) return `That does not look like an Apple Music song link: ${uri}`;

    const song = await this.deps.catalog.lookupSong(id);
    if (!song) return `Apple Music has no song with that link.`;
    return this.playCatalogSong(song, []);
  }

  private async playQuery(query: string): Promise<string> {
    const mine = pickSong(query, await this.libraryCandidates(splitTitleArtist(query).title));
    if (mine) {
      await this.app.playTrack(mine.pid);
      return this.nowPlaying(mine);
    }

    let songs: CatalogSong[];
    try {
      songs = await this.deps.catalog.searchSongs(query, 5);
    } catch (error) {
      log.warn("apple_catalog_search_failed", "could not search the Apple Music catalog", {
        error: describeError(error),
      });
      return `"${query}" is not in the Apple Music library, and the catalog could not be searched: ${describeError(error)}`;
    }
    if (songs.length === 0) return `No results found for "${query}". Try a different search.`;

    const top = pickSong(query, songs) ?? songs[0];
    const others = songs.filter(s => s.id !== top.id).slice(0, 3);
    return this.playCatalogSong(top, others);
  }

  private async playCatalogSong(top: CatalogSong, others: CatalogSong[]): Promise<string> {
    const owned = await this.findInLibrary(top);
    if (owned) {
      await this.app.playTrack(owned.pid);
      return this.nowPlaying(owned, others);
    }

    const page = top.url ? musicAppUrl(top.url) : null;
    if (page) {
      await this.app.openUrl(page);
      return (
        `Opened ${top.name} by ${top.artist} in the Music app. It is not in the user's library, so it has NOT started playing — tell them to press play there. ` +
        `Adding an Apple Music key in the Extensions tab lets the app's own player play songs like this.`
      );
    }
    return `${top.name} by ${top.artist} is in the Apple Music catalog but not the user's library, and there is no link to open it.`;
  }

  private nowPlaying(t: { name: string; artist: string; album: string }, others: CatalogSong[] = []): string {
    let text = `Now playing track: ${t.name} by ${t.artist} (${t.album})`;
    if (others.length > 0) {
      text += "\n\nOther matches:\n" + others.map((s, i) => `${i + 2}. ${s.name} by ${s.artist}`).join("\n");
    }
    return text;
  }

  // ── Finding songs ──────────────────────────────────────────

  /** Library tracks that could be the song named, widening the search once if the first finds none. */
  private async libraryCandidates(title: string): Promise<LibraryTrack[]> {
    const terms = [...new Set([title, longestWord(title)])].filter(t => t.length > 0);
    for (const term of terms) {
      const found = await this.app.searchLibrary(term);
      if (found.length > 0) return found;
    }
    return [];
  }

  private async findInLibrary(song: CatalogSong): Promise<LibraryTrack | null> {
    const candidates = await this.libraryCandidates(song.name);
    return pickSong(`${song.name} by ${firstArtist(song.artist)}`, candidates);
  }

  async searchTracks(query: string, limit: number = 10): Promise<TrackInfo[]> {
    const found = await this.app.searchLibrary(splitTitleArtist(query).title);
    return found.slice(0, limit).map(toTrackInfo);
  }


  // ── Transport ──────────────────────────────────────────────

  async pause(): Promise<string> {
    await this.app.transport("pause");
    return "Playback paused";
  }

  async next(): Promise<string> {
    await this.app.transport("next");
    return "Skipped to next track";
  }

  async previous(): Promise<string> {
    await this.app.transport("previous");
    return "Went to previous track";
  }

  async setVolume(percent: number): Promise<string> {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    await this.app.setVolume(clamped);
    return `Volume set to ${clamped}%`;
  }

  async setShuffle(enabled: boolean): Promise<string> {
    await this.app.setShuffle(enabled);
    return `Shuffle ${enabled ? "enabled" : "disabled"}`;
  }

  async seek(positionMs: number): Promise<string> {
    const clamped = Math.max(0, Math.round(positionMs));
    await this.app.seek(clamped / 1000);
    const mins = Math.floor(clamped / 60000);
    const secs = String(Math.floor((clamped % 60000) / 1000)).padStart(2, "0");
    return `Jumped to ${mins}:${secs}`;
  }

  async setRepeat(state: RepeatState): Promise<string> {
    await this.app.setRepeat(state === "track" ? "one" : state === "context" ? "all" : "off");
    return state === "off"
      ? "Repeat off"
      : state === "track"
        ? "Repeating this track"
        : "Repeating the album or playlist";
  }

  // ── Devices ────────────────────────────────────────────────

  async getDevices(): Promise<DeviceInfo[]> {
    const devices = await this.app.airPlayDevices();
    return devices
      .filter(d => d.available)
      .map(d => ({
        id: d.name,
        name: d.name,
        type: d.kind || "AirPlay",
        is_active: d.active || d.selected,
        volume_percent: d.volume,
      }));
  }

  async transferPlayback(_deviceId: string, deviceName: string): Promise<string> {
    await this.app.setAirPlayDevice(deviceName);
    return `Playback moved to ${deviceName}`;
  }

  // ── Library and history ────────────────────────────────────

  async getSavedTracks(limit: number = 20): Promise<TrackInfo[]> {
    return (await this.app.favourites()).slice(0, limit).map(toTrackInfo);
  }

  async getTopTracks(_range: TimeRange, limit: number = 20): Promise<TrackInfo[]> {
    const played = await this.app.mostPlayed();
    return played
      .sort((a, b) => b.played_count - a.played_count)
      .slice(0, limit)
      .map(toTrackInfo);
  }

  async getTopArtists(_range: TimeRange, limit: number = 20): Promise<ArtistInfo[]> {
    const plays = new Map<string, number>();
    for (const t of await this.app.mostPlayed()) {
      const artist = firstArtist(t.artist);
      if (artist) plays.set(artist, (plays.get(artist) ?? 0) + t.played_count);
    }
    return [...plays.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name]) => ({ id: name, name, genres: [] }));
  }

  async getRecentlyPlayed(limit: number = 20): Promise<TrackInfo[]> {
    const recent = await this.app.recentlyPlayed();
    return recent
      .sort((a, b) => (a.age_s ?? Infinity) - (b.age_s ?? Infinity))
      .slice(0, limit)
      .map(toTrackInfo);
  }

  async getNowPlaying(): Promise<TrackInfo | null> {
    const state = await this.app.state();
    if (!state.track) return null;
    return {
      ...toTrackInfo(state.track),
      is_playing: state.state === "playing",
      progress_ms: state.position_s * 1000,
      volume_percent: state.volume,
    };
  }

  async getQueue(): Promise<TrackInfo[]> {
    const now = await this.getNowPlaying();
    return now ? [now] : [];
  }

  async getPlaylists(limit: number = 200): Promise<PlaylistInfo[]> {
    return (await this.app.playlists()).slice(0, limit).map(p => ({
      id: p.pid,
      name: p.name,
      description: p.description,
      track_count: p.track_count,
      uri: `${PLAYLIST_PREFIX}${p.pid}`,
      owner: "you",
      is_own: true,
    }));
  }

  async addToQueue(): Promise<string> {
    throw new UnsupportedError("Apple Music has no queue that can be added to.");
  }

}
