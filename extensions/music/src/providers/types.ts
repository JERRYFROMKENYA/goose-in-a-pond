export interface TrackInfo {
  id: string;
  name: string;
  artist: string;
  album: string;
  duration_ms: number;
  uri: string;
  is_playing?: boolean;
  progress_ms?: number;
  volume_percent?: number;
  /** The album to play the track inside, so playback continues; absent from player/queue tracks. */
  album_uri?: string;
  /** Tracks on the album, for deciding whether it is long enough to continue. */
  album_total_tracks?: number;
  /** `album`, `single` or `compilation`. A single needs topping up. */
  album_type?: string;
  /** Artist ids, for telling this artist apart from a same-named cover. */
  artist_ids?: string[];
}

/** A context or track URI, or a `TrackInfo`, which carries the album to play the track inside. */
export type PlayTarget = string | TrackInfo;

/** An artist, as returned by the taste endpoints. */
export interface ArtistInfo {
  id: string;
  name: string;
  genres: string[];
}

/** How far back the taste endpoints look. */
export type TimeRange = "short_term" | "medium_term" | "long_term";

/** Repeat modes: off, repeat one track, repeat the whole album or playlist. */
export type RepeatState = "off" | "track" | "context";

/** A device the service can play to, such as an AirPlay speaker. */
export interface DeviceInfo {
  id: string;
  name: string;
  /** The service's own label for it, e.g. "AirPlay" or "Computer". */
  type: string;
  is_active: boolean;
  volume_percent?: number;
}

export interface PlaylistInfo {
  id: string;
  name: string;
  description: string;
  track_count: number;
  uri: string;
  /** Display name of whoever created it. */
  owner: string;
  /** True when the signed-in user created it, false when they only follow it. */
  is_own: boolean;
}

export type ServiceId = 'apple';

/** What a service can do, so the tool list advertises only what will work. */
export interface ProviderCapabilities {
  /** `devices` lists and moves playback: AirPlay speakers. */
  devices: boolean;
  /** Appending to the play queue. Music.app has no queue to append to. */
  queue: boolean;
  /** Whether top tracks and artists can be narrowed to a period. */
  timeRange: boolean;
}

/** Tool wording each provider gets right for itself, such as what "next" does. */
export interface ToolWording {
  play: string;
  /** Falls back to the text every service shares. */
  playNext?: string;
  playUri: string;
}

/** A `play` call as the model made it, for providers that resolve it themselves. */
export interface PlayRequest {
  query?: string;
  uri?: string;
}

export class UnsupportedError extends Error {}

export interface MusicProvider {
  id: ServiceId;
  name: string;
  capabilities: ProviderCapabilities;
  describe: ToolWording;
  /** Owns the whole `play` intent: search, pick, start. */
  playRequest(request: PlayRequest): Promise<string>;
  /** Replaces current playback; pass a `TrackInfo`, not its `uri`, so playback continues after it. */
  play(target?: PlayTarget): Promise<string>;
  pause(): Promise<string>;
  next(): Promise<string>;
  previous(): Promise<string>;
  setVolume(percent: number): Promise<string>;
  setShuffle(enabled: boolean): Promise<string>;
  seek(positionMs: number): Promise<string>;
  setRepeat(state: RepeatState): Promise<string>;
  getDevices(): Promise<DeviceInfo[]>;
  transferPlayback(deviceId: string, deviceName: string): Promise<string>;
  getSavedTracks(limit?: number): Promise<TrackInfo[]>;
  getTopTracks(range: TimeRange, limit?: number): Promise<TrackInfo[]>;
  getTopArtists(range: TimeRange, limit?: number): Promise<ArtistInfo[]>;
  getRecentlyPlayed(limit?: number): Promise<TrackInfo[]>;
  getNowPlaying(): Promise<TrackInfo | null>;
  getQueue(): Promise<TrackInfo[]>;
  /** Appends to the queue without disturbing what is currently playing. */
  addToQueue(uri: string): Promise<string>;
  searchTracks(query: string, limit?: number): Promise<TrackInfo[]>;
  getPlaylists(limit?: number): Promise<PlaylistInfo[]>;
}

