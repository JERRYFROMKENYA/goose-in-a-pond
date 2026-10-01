import type { MusicProvider } from "./providers/types.js";

/** One tool as MCP lists it. */
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Used when a provider does not word `when: next` itself. */
const PLAY_NEXT =
  "'next' puts the song after the current one and lets the current track finish. Default 'now' replaces what is playing.";

function playTool(provider: MusicProvider): Tool {
  const properties: Record<string, unknown> = {
    query: {
      type: "string",
      description:
        "What to play, as the user said it — 'Marvin's Room by Drake', 'Randoms', 'jazz'. Omit to resume what is paused.",
    },
    target: {
      type: "string",
      enum: ["track", "playlist"],
      description: "'playlist' matches the user's playlists loosely by name. Default 'track' searches songs.",
    },
  };

  if (provider.capabilities.queue) {
    properties.when = {
      type: "string",
      enum: ["now", "next"],
      description: provider.describe.playNext ?? PLAY_NEXT,
    };
  }

  properties.uri = {
    type: "string",
    description: provider.describe.playUri,
  };

  return {
    name: "play",
    description: provider.describe.play,
    inputSchema: { type: "object", properties },
  };
}

function playlistsTool(provider: MusicProvider): Tool {
  return {
    name: "playlists",
    description:
      "List every playlist in the user's Music library. Use this to answer 'what playlists do I have', and to find the exact name before playing one with the 'play' tool.",
    inputSchema: { type: "object", properties: {} },
  };
}

function libraryTool(provider: MusicProvider): Tool {
  const properties: Record<string, unknown> = {
    action: {
      type: "string",
      enum: ["saved", "top_tracks", "top_artists", "recent"],
      description:
        "saved = list favourite songs; top_tracks / top_artists = what they have played most, by lifetime play count; recent = recently played.",
    },
  };

  if (provider.capabilities.timeRange) {
    properties.time_range = {
      type: "string",
      enum: ["short_term", "medium_term", "long_term"],
      description:
        "How far back top_tracks / top_artists look: short_term is about 4 weeks, medium_term about 6 months, long_term is several years. Defaults to medium_term.",
    };
  }

  properties.limit = {
    type: "number",
    description: "How many to return, 1-50. Defaults to 20.",
  };

  return {
    name: "library",
    description:
      "The user's own Apple Music library and listening history, read from the Music app: their favourite songs, what they have played most, and what they played recently. Read-only. Use for 'what are my favourite songs', 'what do I listen to most', 'what was I playing yesterday'.",
    inputSchema: { type: "object", properties, required: ["action"] },
  };
}

function devicesTool(): Tool {
  return {
    name: "devices",
    description:
      "List the AirPlay speakers and devices Music can play to, or switch to one of them. Call with no arguments to see what is available; pass transfer_to with a device name to send the music there. Use this for 'play this on the speaker', 'where can I play this'.",
    inputSchema: {
      type: "object",
      properties: {
        transfer_to: {
          type: "string",
          description:
            "Name of the device to move playback to, as the user said it (e.g. 'my phone', 'kitchen speaker'). Matched loosely against the device list. Omit to just list devices.",
        },
      },
    },
  };
}

function statusTool(): Tool {
  return {
    name: "status",
    description: "Get what is currently playing in Apple Music — track name, artist, album and progress.",
    inputSchema: { type: "object", properties: {} },
  };
}

function controlTool(provider: MusicProvider): Tool {
  return {
    name: "control",
    description: `Control ${provider.name} playback: pause, resume, next, previous, set volume, toggle shuffle, jump within the track, or set repeat.`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "pause",
            "resume",
            "next",
            "previous",
            "volume_up",
            "volume_down",
            "set_volume",
            "shuffle_on",
            "shuffle_off",
            "seek",
            "repeat_off",
            "repeat_track",
            "repeat_all",
          ],
          description:
            "The playback action to perform. 'seek' jumps within the current track (give position); 'repeat_track' loops the song, 'repeat_all' loops the album or playlist, 'repeat_off' stops looping.",
        },
        volume: {
          type: "number",
          description: "Exact volume level (0-100). Required when action is 'set_volume'.",
        },
        position: {
          type: "string",
          description:
            "Where to jump to, for action 'seek'. Accepts 'm:ss' like '1:30', or a plain number of seconds like '90'.",
        },
      },
      required: ["action"],
    },
  };
}

/** The tools this provider can honour: a capability it lacks is left out, not advertised and refused. */
export function buildTools(provider: MusicProvider): Tool[] {
  return [
    playTool(provider),
    playlistsTool(provider),
    libraryTool(provider),
    ...(provider.capabilities.devices ? [devicesTool()] : []),
    statusTool(),
    controlTool(provider),
  ];
}
