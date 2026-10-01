#!/usr/bin/env node
/** GIAP Music MCP server for Apple Music: a few intent-shaped tools, not one per endpoint. */
import * as readline from "readline";
import { describeError, log } from "./log.js";
import { normalizeName, playlistMatchScore } from "./match.js";
import { createProvider } from "./providers/index.js";
import { buildTools } from "./tools.js";
import { chooseService, noMusicInstructions } from "./providers/select.js";
import type { MusicProvider, TimeRange } from "./providers/types.js";

const available = await createProvider();
// Said to the model when there is no provider, so it can tell the person why.
const NO_MUSIC_INSTRUCTIONS = noMusicInstructions(chooseService(process.platform, process.env));
// Every handler below runs only when there is a provider: `tools/call` refuses first when there is not.
const provider = available as MusicProvider;
const TOOLS = available ? buildTools(available) : [];

// ── Tool handlers ─────────────────────────────────────────────

async function handlePlay(args: Record<string, unknown>): Promise<string> {
  return provider.playRequest({
    query: args.query as string | undefined,
    uri: args.uri as string | undefined,
  });
}

async function handleQueue(args: Record<string, unknown>): Promise<string> {
  const uri = args.uri as string | undefined;
  const query = args.query as string | undefined;

  if (uri) {
    await provider.addToQueue(uri);
    return `Queued ${uri}`;
  }

  if (!query) {
    return "Tell me what to queue — a song name, optionally with the artist.";
  }

  const tracks = await provider.searchTracks(query, 5);
  if (tracks.length === 0) {
    return `No results found for "${query}". Try a different search.`;
  }

  const top = tracks[0];
  await provider.addToQueue(top.uri);

  // Name the pick so a wrong one can be spotted and skipped.
  let text = `Queued: ${top.name} by ${top.artist} (${top.album}). Current track keeps playing.`;
  const others = tracks.slice(1, 4);
  if (others.length > 0) {
    text +=
      "\n\nOther matches:\n" +
      others.map((t, i) => `${i + 2}. ${t.name} by ${t.artist}`).join("\n");
  }
  return text;
}

/** Splits off a trailing "by X" owner, only when X owns something here: names contain "by" too. */
function splitOwnerHint(
  query: string,
  playlists: { owner: string }[]
): { name: string; owner: string | null } {
  const m = query.match(/^(.*?)\s+by\s+([^,]+)$/i);
  if (!m) return { name: query, owner: null };

  const candidate = normalizeName(m[2]);
  const known = playlists.some(p => {
    const o = normalizeName(p.owner);
    return o === candidate || o.includes(candidate) || candidate.includes(o);
  });

  return known && m[1].trim()
    ? { name: m[1].trim(), owner: m[2].trim() }
    : { name: query, owner: null };
}

/** Finds a library playlist by name; the model has names, not ids. */
async function resolvePlaylist(query: string): Promise<{ uri: string; name: string }> {
  const playlists = await provider.getPlaylists();
  const { name, owner } = splitOwnerHint(query, playlists);

  // Narrow to the named owner, or the own-playlist tie-break picks the user's lookalike.
  let pool = playlists;
  if (owner) {
    const wanted = normalizeName(owner);
    pool = playlists.filter(p => {
      const o = normalizeName(p.owner);
      return o === wanted || o.includes(wanted) || wanted.includes(o);
    });
    if (pool.length === 0) {
      throw new Error(`Nobody called "${owner}" owns a playlist in this library.`);
    }
  }

  const ranked = pool
    .map(p => ({ p, score: playlistMatchScore(name, p.name) }))
    // On a tie only, prefer the user's own playlist over a followed one.
    .sort((a, b) => b.score - a.score || Number(b.p.is_own) - Number(a.p.is_own));

  const best = ranked[0];
  if (best && best.score >= 0.5) return { uri: best.p.uri, name: best.p.name };

  const suggestions = ranked
    .slice(0, 8)
    .map(r => r.p.name)
    .join(", ");
  const scope = owner ? ` from ${owner}` : "";
  // Other users' playlists are 403 for this app, so explain the way out.
  throw new Error(
    `No playlist matching "${name}"${scope} in this library. ` +
      `Closest${scope}: ${suggestions || "(none)"}. ` +
      `Only playlists the user created or follows are visible — if it belongs to someone else, ` +
      `they can add it to their library in ${provider.name}.`
  );
}

async function handlePlayPlaylist(args: Record<string, unknown>): Promise<string> {
  // A link or URI is the only way to reach a playlist outside the library.
  const given = (args.uri ?? args.url) as string | undefined;
  if (given) {
    return `${provider.name} can only play playlists in the user's library; ask for one by name.`;
  }

  const name = (args.name ?? args.query) as string | undefined;
  if (!name) return "Which playlist? Give me its name.";

  const { uri, name: actual } = await resolvePlaylist(name);
  await provider.play(uri);
  return `Now playing playlist: ${actual}`;
}


async function handleLibrary(args: Record<string, unknown>): Promise<string> {
  const action = args.action as string;
  const range = (args.time_range as TimeRange) || "medium_term";
  const limit = typeof args.limit === "number" ? args.limit : 20;
  const query = args.query as string | undefined;

  switch (action) {
    case "saved": {
      const tracks = await provider.getSavedTracks(limit);
      if (tracks.length === 0) return `No favourite songs in this ${provider.name} library.`;
      return (
        `${tracks.length} liked song(s):\n` +
        tracks.map((t, i) => `${i + 1}. ${t.name} by ${t.artist}`).join("\n")
      );
    }


    case "top_tracks": {
      const tracks = await provider.getTopTracks(range, limit);
      if (tracks.length === 0) return `${provider.name} has no top tracks for this period yet.`;
      return (
        `Top ${tracks.length} track(s) (${describeRange(range)}):\n` +
        tracks.map((t, i) => `${i + 1}. ${t.name} by ${t.artist}`).join("\n")
      );
    }

    case "top_artists": {
      const artists = await provider.getTopArtists(range, limit);
      if (artists.length === 0) return `${provider.name} has no top artists for this period yet.`;
      return (
        `Top ${artists.length} artist(s) (${describeRange(range)}):\n` +
        artists
          .map((a, i) => `${i + 1}. ${a.name}${a.genres.length ? ` - ${a.genres.slice(0, 3).join(", ")}` : ""}`)
          .join("\n")
      );
    }

    case "recent": {
      const tracks = await provider.getRecentlyPlayed(limit);
      if (tracks.length === 0) return "No recent listening history.";
      return (
        `${tracks.length} recently played:\n` +
        tracks.map((t, i) => `${i + 1}. ${t.name} by ${t.artist}`).join("\n")
      );
    }

    default:
      return `Unknown action: ${action}`;
  }
}

function describeRange(range: TimeRange): string {
  // A service that cannot narrow by period reports lifetime totals, whatever the default says.
  if (!provider.capabilities.timeRange) return "all time";
  return range === "short_term"
    ? "last 4 weeks"
    : range === "long_term"
      ? "several years"
      : "last 6 months";
}

async function handleDevices(args: Record<string, unknown>): Promise<string> {
  const devices = await provider.getDevices();
  if (devices.length === 0) {
    return `No ${provider.name} devices are available.`;
  }

  const target = args.transfer_to as string | undefined;
  if (!target) {
    return (
      `${devices.length} device(s) available:\n` +
      devices
        .map(d => `- ${d.name} (${d.type})${d.is_active ? " - currently playing here" : ""}`)
        .join("\n")
    );
  }

  // Also match on device type: people say "the speaker" more than a device's name.
  const ranked = devices
    .map(d => ({ d, score: Math.max(playlistMatchScore(target, d.name), playlistMatchScore(target, d.type)) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < 0.5) {
    return `No device matching "${target}". Available: ${devices.map(d => `${d.name} (${d.type})`).join(", ")}`;
  }
  if (best.d.is_active) {
    return `${best.d.name} is already the one playing.`;
  }

  return provider.transferPlayback(best.d.id, best.d.name);
}

async function handlePlaylists(): Promise<string> {
  const playlists = await provider.getPlaylists();
  if (playlists.length === 0) return `No playlists found in this ${provider.name} library.`;

  const mine = playlists.filter(p => p.is_own);
  const followed = playlists.filter(p => !p.is_own);

  let text = `${playlists.length} playlist(s) in the library: ${mine.length} created by the user, ${followed.length} followed from others.`;
  if (mine.length > 0) {
    text += `\n\nCreated by the user (${mine.length}):\n` + mine.map(p => `- ${p.name}`).join("\n");
  }
  if (followed.length > 0) {
    text +=
      `\n\nFollowed from other people (${followed.length}):\n` +
      followed.map(p => `- ${p.name} (by ${p.owner})`).join("\n");
  }
  return text;
}

async function handleStatus(): Promise<string> {
  const now = await provider.getNowPlaying();
  if (!now) {
    return `Nothing is currently playing on ${provider.name}.`;
  }

  const progress = now.progress_ms
    ? `${Math.floor(now.progress_ms / 60000)}:${String(Math.floor((now.progress_ms % 60000) / 1000)).padStart(2, "0")}`
    : "0:00";
  const duration = `${Math.floor(now.duration_ms / 60000)}:${String(Math.floor((now.duration_ms % 60000) / 1000)).padStart(2, "0")}`;

  let text = `${now.is_playing ? "Playing" : "Paused"}: ${now.name} by ${now.artist}\nAlbum: ${now.album}\nProgress: ${progress} / ${duration}`;

  try {
    const queue = await provider.getQueue();
    const upcoming = queue.slice(1, 4);
    if (upcoming.length > 0) {
      text +=
        "\n\nUp next:\n" +
        upcoming.map((t, i) => `${i + 1}. ${t.name} by ${t.artist}`).join("\n");
    }
  } catch {
    // Queue not available — that's fine
  }

  return text;
}

async function handleControl(args: Record<string, unknown>): Promise<string> {
  const action = args.action as string;
  const volume = args.volume as number | undefined;

  switch (action) {
    case "pause":
      return provider.pause();
    case "resume":
      return provider.play();
    case "next":
      return provider.next();
    case "previous":
      return provider.previous();
    case "volume_up": {
      const now = await provider.getNowPlaying();
      const cur = now?.volume_percent ?? 50;
      return provider.setVolume(Math.min(100, cur + 10));
    }
    case "volume_down": {
      const now = await provider.getNowPlaying();
      const cur = now?.volume_percent ?? 50;
      return provider.setVolume(Math.max(0, cur - 10));
    }
    case "set_volume":
      return provider.setVolume(volume ?? 50);
    case "shuffle_on":
      return provider.setShuffle(true);
    case "shuffle_off":
      return provider.setShuffle(false);
    case "seek": {
      const ms = parsePosition(args.position);
      if (ms === null) {
        return "Where should I jump to? Give a time like '1:30' or a number of seconds.";
      }
      return provider.seek(ms);
    }
    case "repeat_off":
      return provider.setRepeat("off");
    case "repeat_track":
      return provider.setRepeat("track");
    case "repeat_all":
      return provider.setRepeat("context");
    default:
      return `Unknown action: ${action}`;
  }
}

/** Reads "1:30", "90" or 90 as milliseconds. Returns null if it is neither. */
function parsePosition(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value * 1000);
  if (typeof value !== "string") return null;

  const text = value.trim();
  const clock = text.match(/^(\d+):([0-5]?\d)$/);
  if (clock) return (Number(clock[1]) * 60 + Number(clock[2])) * 1000;

  const seconds = Number(text);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null;
}

// ── Logging ───────────────────────────────────────────────────
function debug(...args: unknown[]) {
  const [first, ...rest] = args;
  log.debug(
    "jsonrpc",
    typeof first === "string" ? first : JSON.stringify(first),
    rest.length > 0 ? { detail: rest.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") } : undefined,
  );
}

// ── MCP JSON-RPC server ───────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: string;
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

async function handleRequest(
  request: JsonRpcRequest
): Promise<Record<string, unknown> | null> {
  const { method, id, params } = request;

  debug(`<-- ${method}`, params ? JSON.stringify(params).slice(0, 200) : "");

  switch (method) {
    case "initialize":
      debug("initializing");
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "giap-music", version: "0.4.0" },
          ...(available ? {} : { instructions: NO_MUSIC_INSTRUCTIONS }),
        },
      };

    case "notifications/initialized":
      debug("initialized OK");
      return null;

    case "tools/list":
      debug(`listing ${TOOLS.length} tools`);
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

    case "tools/call": {
      const toolName = (params as Record<string, unknown>)?.name as string;
      const args =
        ((params as Record<string, unknown>)?.arguments as Record<
          string,
          unknown
        >) ?? {};

      if (!available) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: NO_MUSIC_INSTRUCTIONS },
        };
      }

      const started = Date.now();
      log.info("tool_call", `handling ${toolName}`, { tool: toolName });

      try {
        let text: string;
        switch (toolName) {
          case "play": {
            const target = (args.target as string | undefined) ?? "track";
            const when = (args.when as string | undefined) ?? "now";
            debug(`play → ${target}/${when}`, String(args.query ?? args.uri ?? "(resume)"));
            if (target === "playlist") {
              text = await handlePlayPlaylist({ ...args, name: args.name ?? args.query });
              if (when === "next") {
                text += `\n\n(Played now — ${provider.name} cannot add a whole playlist to the queue.)`;
              }
            } else if (when === "next" && !provider.capabilities.queue) {
              text = `${provider.name} has no queue to add to. Nothing was changed; ask to play it now to replace what is playing.`;
            } else if (when === "next") {
              text = await handleQueue(args);
            } else {
              text = await handlePlay(args);
            }
            break;
          }
          case "library":
            debug("library →", args.action, args.query ?? "");
            text = await handleLibrary(args);
            break;
          case "devices":
            if (!provider.capabilities.devices) throw new Error(`${provider.name} has no devices tool.`);
            debug("devices →", args.transfer_to ?? "(list)");
            text = await handleDevices(args);
            break;
          case "playlists":
            debug("playlists → listing");
            text = await handlePlaylists();
            break;
          case "status":
            debug("status → checking now playing");
            text = await handleStatus();
            break;
          case "control":
            debug("control →", args.action, args.volume ?? "");
            text = await handleControl(args);
            break;
          default:
            log.warn("unknown_tool", "the model asked for a tool this extension does not have", {
              tool: toolName,
            });
            return {
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: `Unknown tool: ${toolName}` },
            };
        }

        log.info("tool_ok", `${toolName} succeeded`, {
          tool: toolName,
          chars: text.length,
          duration_ms: Date.now() - started,
        });
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text }] },
        };
      } catch (err) {
        const msg = describeError(err);
        log.warn("tool_failed", `${toolName} failed`, {
          tool: toolName,
          error: msg,
          duration_ms: Date.now() - started,
        });
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Error: ${msg}` }],
            isError: true,
          },
        };
      }
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line: string) => {
  try {
    const request = JSON.parse(line) as JsonRpcRequest;
    const response = await handleRequest(request);
    if (response) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  } catch {
    // ignore malformed JSON
  }
});
