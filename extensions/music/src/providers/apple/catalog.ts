import { splitTitleArtist } from "../../match.js";
import type { EgressGate, Fetch } from "./egress.js";

/** A song in the Apple Music catalog, which is not the same thing as a song in the library. */
export interface CatalogSong {
  id: string;
  name: string;
  artist: string;
  album: string;
  duration_ms: number;
  /** The song's page on music.apple.com. */
  url: string | null;
}

export interface CatalogSource {
  searchSongs(query: string, limit: number): Promise<CatalogSong[]>;
  lookupSong(id: string): Promise<CatalogSong | null>;
}

/** The catalog id in an Apple Music song link, or null for anything else. */
export function songIdFromLink(link: string): string | null {
  if (!/music\.apple\.com|^music:\/\/|itmss?:\/\//i.test(link)) return null;
  return link.match(/[?&]i=(\d+)/)?.[1] ?? link.match(/\/song\/[^/?#]*\/(\d+)/)?.[1] ?? null;
}

/**
 * `music://` hands the page straight to the Music app instead of the browser. The URL came off
 * the network, so anything that is not an Apple page is refused rather than opened.
 */
export function musicAppUrl(url: string): string | null {
  return /^https:\/\/(music|itunes)\.apple\.com\//i.test(url) ? url.replace(/^https:\/\//i, "music://") : null;
}

/** The two-letter store to search: an explicit setting, else the machine's region, else US. */
export function defaultStorefront(explicit: string | undefined, locale: string): string {
  const fromSetting = explicit?.trim();
  if (fromSetting && /^[a-z]{2}$/i.test(fromSetting)) return fromSetting.toLowerCase();
  const region = locale.match(/[-_]([A-Za-z]{2})\b/)?.[1];
  return (region ?? "us").toLowerCase();
}

interface ItunesResult {
  kind?: string;
  trackId?: number;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  trackTimeMillis?: number;
  trackViewUrl?: string;
}

function songFromItunes(r: ItunesResult): CatalogSong | null {
  if (r.kind !== "song" || !r.trackId || !r.trackName) return null;
  return {
    id: String(r.trackId),
    name: r.trackName,
    artist: r.artistName ?? "",
    album: r.collectionName ?? "",
    duration_ms: r.trackTimeMillis ?? 0,
    url: r.trackViewUrl ?? null,
  };
}

/** The iTunes Search API: public, keyless, and enough to name a song and find its page. */
export class ItunesSearch implements CatalogSource {
  constructor(
    private readonly fetchFn: Fetch,
    private readonly egress: EgressGate,
    private readonly storefront: string,
  ) {}

  private async get(path: string, params: Record<string, string>): Promise<ItunesResult[]> {
    const url = `https://itunes.apple.com/${path}?${new URLSearchParams(params)}`;
    await this.egress.allow(url);

    const resp = await this.fetchFn(url, { signal: AbortSignal.timeout(10_000) });
    if (resp.status === 429 || resp.status === 403) {
      throw new Error("Apple's public search is rate limiting requests. Try again in a minute.");
    }
    if (!resp.ok) throw new Error(`Apple's public search answered ${resp.status}.`);

    const body = (await resp.json()) as { results?: ItunesResult[] };
    return body.results ?? [];
  }

  async searchSongs(query: string, limit: number): Promise<CatalogSong[]> {
    // The index is term-based over every field, so "X by Y" reads better as "X Y".
    const { title, artist } = splitTitleArtist(query);
    const term = artist ? `${title} ${artist}` : title;

    const results = await this.get("search", {
      term,
      media: "music",
      entity: "song",
      limit: String(Math.max(1, Math.min(25, limit))),
      country: this.storefront,
    });
    return results.map(songFromItunes).filter((s): s is CatalogSong => s !== null);
  }

  async lookupSong(id: string): Promise<CatalogSong | null> {
    const results = await this.get("lookup", { id, country: this.storefront });
    return results.map(songFromItunes).find((s): s is CatalogSong => s !== null) ?? null;
  }
}
