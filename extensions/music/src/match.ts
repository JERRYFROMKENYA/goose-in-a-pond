/** Lowercase, drop emoji and punctuation, collapse runs of whitespace. */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Filler around a spoken playlist name, stripped from the query only (it dilutes the match). */
const QUERY_FILLER = new Set([
  "the", "a", "an", "my", "our", "from", "in", "on", "of", "please", "playlist",
  "playlists", "list", "library", "spotify", "apple", "music", "called", "named", "one",
]);

/** Drops filler, keeping the original if that would leave nothing to match on. */
function contentWords(normalized: string): string {
  const kept = normalized.split(" ").filter(w => w && !QUERY_FILLER.has(w));
  return kept.length > 0 ? kept.join(" ") : normalized;
}

/** 0–1 match score; compares without spaces too, since people say "sautisol" for "Sauti sol". */
export function playlistMatchScore(query: string, playlistName: string): number {
  const q = contentWords(normalizeName(query));
  const n = normalizeName(playlistName);
  if (!q || !n) return 0;
  if (q === n) return 1;

  const qs = q.replace(/ /g, "");
  const ns = n.replace(/ /g, "");
  if (qs === ns) return 0.95;

  // Prefix is the common case; weighting containment by coverage stops short names tying with it.
  if (ns.startsWith(qs)) return 0.92;
  if (ns.includes(qs)) return 0.75 + 0.15 * (qs.length / ns.length);
  if (qs.includes(ns)) return 0.7 + 0.15 * (ns.length / qs.length);

  const qWords = q.split(" ");
  const nSet = new Set(n.split(" "));
  const overlap = qWords.filter(w => nSet.has(w)).length;
  // Kept below the containment band so a partial word match never outranks one.
  return Math.min(0.65, overlap / qWords.length);
}

/** "Marvin's Room by Drake" → title and artist; a query with no "by" is all title. */
export function splitTitleArtist(query: string): { title: string; artist: string | null } {
  const m = query.match(/^(.*?)\s+by\s+(.*)$/i);
  if (!m) return { title: query.trim(), artist: null };

  const title = m[1].trim();
  // Drop "feat. X": a track is filed under its primary artist.
  const artist = m[2].replace(/\s+(feat\.?|ft\.?|featuring|with)\s+.*$/i, "").trim();
  return title && artist ? { title, artist } : { title: query.trim(), artist: null };
}

/** 1 for the same title, 0.9 once a "(Remastered)" or "- Live" suffix is set aside, else 0. */
function titleScore(wanted: string, candidate: string): number {
  const w = normalizeName(wanted).replace(/ /g, "");
  if (!w) return 0;
  if (normalizeName(candidate).replace(/ /g, "") === w) return 1;

  const bare = candidate.replace(/\s*[(\[].*$/, "").replace(/\s+-\s+.*$/, "");
  return normalizeName(bare).replace(/ /g, "") === w ? 0.9 : 0;
}

/** Whether `wanted` is one of the names in a joined artist string like "Drake, Rihanna". */
function artistMatches(wanted: string, candidate: string): boolean {
  const w = normalizeName(wanted).replace(/ /g, "");
  if (!w) return false;
  return candidate
    .split(/,|&|\band\b|\bfeat\.?\s|\bft\.?\s|\bwith\b/i)
    .some(part => normalizeName(part).replace(/ /g, "") === w);
}

/**
 * The candidate that is the song asked for, or null. Stricter than playlist matching: a prefix is
 * not enough ("Home" is not "Homecoming"), and a named artist must be among the song's artists.
 */
export function pickSong<T extends { name: string; artist: string }>(
  query: string,
  candidates: T[],
): T | null {
  const { title, artist } = splitTitleArtist(query);
  let best: { song: T; score: number } | null = null;

  for (const song of candidates) {
    const score = titleScore(title, song.name);
    if (score === 0) continue;
    if (artist && !artistMatches(artist, song.artist)) continue;
    if (!best || score > best.score) best = { song, score };
  }

  return best?.song ?? null;
}
