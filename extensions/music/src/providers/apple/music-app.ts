import type { ScriptRunner } from "./osascript.js";

/** A track in the user's library, as Music.app reports it. */
export interface LibraryTrack {
  pid: string;
  name: string;
  artist: string;
  album: string;
  duration_s: number;
  played_count: number;
  /** Seconds since it was last played; only set by the recent-plays listing. */
  age_s?: number;
}

export interface PlayerState {
  state: string;
  volume: number;
  shuffle: boolean;
  repeat: "off" | "one" | "all";
  position_s: number;
  track: LibraryTrack | null;
}

export interface LibraryPlaylist {
  pid: string;
  name: string;
  description: string;
  track_count: number;
  kind: string;
}

export interface AirPlayDevice {
  name: string;
  kind: string;
  active: boolean;
  selected: boolean;
  available: boolean;
  volume: number;
}

/**
 * Tab-separated output needs tabs and newlines gone from the text, or one field becomes two.
 * An empty result raises -1728 in some cases and returns {} in others, so scripts treat it as
 * empty; -1743 (not allowed) and -1712 (no answer) are real failures and are rethrown.
 */
const PRELUDE = `
on clean(v)
  if v is missing value then return ""
  set t to v as text
  set od to AppleScript's text item delimiters
  repeat with ch in {tab, linefeed, return}
    set AppleScript's text item delimiters to (ch as text)
    set parts to text items of t
    set AppleScript's text item delimiters to " "
    set t to parts as text
  end repeat
  set AppleScript's text item delimiters to od
  return t
end clean

on join(rows)
  set od to AppleScript's text item delimiters
  set AppleScript's text item delimiters to linefeed
  set out to rows as text
  set AppleScript's text item delimiters to od
  return out
end join

on trackRow(t)
  tell application "Music"
    set pid to persistent ID of t
    set n to name of t
    set a to artist of t
    set al to album of t
    set d to 0
    try
      set d to duration of t
    end try
    set pc to 0
    try
      set pc to played count of t
    end try
  end tell
  if d is missing value then set d to 0
  if pc is missing value then set pc to 0
  return my clean(pid) & tab & my clean(n) & tab & my clean(a) & tab & my clean(al) & tab & (round d) & tab & pc & tab & ""
end trackRow
`;

const script = (body: string) => `${PRELUDE}\n${body}\n`;

const STATE = script(`
on run argv
  set stateName to "stopped"
  set vol to 0
  set shuf to "false"
  set rep to "off"
  set pos to 0
  set row to ""
  tell application "Music"
    set stateName to (player state) as text
    set vol to sound volume
    set shuf to (shuffle enabled) as text
    set rep to (song repeat) as text
    try
      set pos to player position
    end try
    try
      set t to current track
      set row to my trackRow(t)
    end try
  end tell
  set pos to round pos
  return stateName & tab & vol & tab & shuf & tab & rep & tab & pos & tab & row
end run
`);

const CONTROL = script(`
on run argv
  set cmd to item 1 of argv
  tell application "Music"
    if cmd is "play" then
      play
    else if cmd is "pause" then
      pause
    else if cmd is "next" then
      next track
    else if cmd is "previous" then
      previous track
    else if cmd is "volume" then
      set sound volume to ((item 2 of argv) as integer)
    else if cmd is "shuffle" then
      set shuffle enabled to ((item 2 of argv) is "true")
    else if cmd is "repeat" then
      set r to item 2 of argv
      if r is "one" then
        set song repeat to one
      else if r is "all" then
        set song repeat to all
      else
        set song repeat to off
      end if
    else if cmd is "seek" then
      set player position to ((item 2 of argv) as integer)
    end if
  end tell
  return "ok"
end run
`);

const SEARCH_LIBRARY = script(`
on run argv
  set q to item 1 of argv
  set area to item 2 of argv
  set rows to {}
  tell application "Music"
    set lib to library playlist 1
    set found to {}
    try
      if area is "names" then
        set found to search lib for q only names
      else
        set found to search lib for q
      end if
    on error errMsg number errNum
      if errNum is -1743 or errNum is -1712 then error errMsg number errNum
    end try
    set n to count of found
    if n > 25 then set n to 25
    repeat with i from 1 to n
      set end of rows to my trackRow(item i of found)
    end repeat
  end tell
  return my join(rows)
end run
`);

const PLAY_TRACK = script(`
on run argv
  set pid to item 1 of argv
  tell application "Music"
    set t to first track of library playlist 1 whose persistent ID is pid
    play t
  end tell
  return "ok"
end run
`);

const PLAYLISTS = script(`
on run argv
  set rows to {}
  tell application "Music"
    set pidList to persistent ID of every playlist
    set nameList to name of every playlist
    set kindList to special kind of every playlist
    set classList to class of every playlist
    repeat with i from 1 to count of pidList
      if (item i of kindList) is none and (item i of classList) is not folder playlist then
        set end of rows to (my clean(item i of pidList)) & tab & (my clean(item i of nameList)) & tab & "" & tab & 0 & tab & ((item i of classList) as text)
      end if
    end repeat
  end tell
  return my join(rows)
end run
`);

const PLAY_PLAYLIST = script(`
on run argv
  set pid to item 1 of argv
  tell application "Music"
    set p to first playlist whose persistent ID is pid
    play p
  end tell
  return "ok"
end run
`);

const AIRPLAY_LIST = script(`
on run argv
  set rows to {}
  tell application "Music"
    repeat with d in (every AirPlay device)
      try
        set end of rows to (my clean(name of d)) & tab & (my clean((kind of d) as text)) & tab & (active of d) & tab & (selected of d) & tab & (available of d) & tab & (sound volume of d)
      end try
    end repeat
  end tell
  return my join(rows)
end run
`);

const AIRPLAY_SET = script(`
on run argv
  set n to item 1 of argv
  tell application "Music"
    set d to first AirPlay device whose name is n
    set current AirPlay devices to {d}
  end tell
  return "ok"
end run
`);

const OPEN_URL = script(`
on run argv
  tell application "Music"
    activate
    open location (item 1 of argv)
  end tell
  return "ok"
end run
`);

/**
 * Whole-library listing behind a filter. Property lists come back in bulk, one Apple event each,
 * because asking per track is thousands of round trips on a real library. `filter` is one of the
 * constants below, never user text.
 */
function trackList(filter: string, withAge: boolean): string {
  return script(`
on run argv
  set rows to {}
  tell application "Music"
    set pidList to {}
    try
      set sel to a reference to (every track of library playlist 1 whose ${filter})
      set pidList to persistent ID of sel
      set nameList to name of sel
      set artistList to artist of sel
      set albumList to album of sel
      set durList to duration of sel
      set countList to played count of sel
      ${withAge ? "set dateList to played date of sel" : ""}
    on error errMsg number errNum
      if errNum is -1743 or errNum is -1712 then error errMsg number errNum
    end try
  end tell
  repeat with i from 1 to count of pidList
    set d to item i of durList
    if d is missing value then set d to 0
    set age to ""
    ${withAge ? "set age to round ((current date) - (item i of dateList))" : ""}
    set end of rows to (my clean(item i of pidList)) & tab & (my clean(item i of nameList)) & tab & (my clean(item i of artistList)) & tab & (my clean(item i of albumList)) & tab & (round d) & tab & (item i of countList) & tab & age
  end repeat
  return my join(rows)
end run
`);
}

/** Favourites use the raw code: the property was `loved` before it was `favorited`, and the code stayed. */
const FAVOURITES = trackList("«property pLov» is true", false);
const MOST_PLAYED = trackList("played count > 0", false);
const RECENT = trackList("played date > ((current date) - (60 * days))", true);

/** Every script, so a test can compile each without running it. */
export const SCRIPTS = {
  STATE, CONTROL, SEARCH_LIBRARY, PLAY_TRACK, PLAYLISTS, PLAY_PLAYLIST,
  AIRPLAY_LIST, AIRPLAY_SET, OPEN_URL, FAVOURITES, MOST_PLAYED, RECENT,
};

const num = (v: string | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function rowsOf(out: string): string[][] {
  return out
    .split("\n")
    .filter(line => line.trim() !== "")
    .map(line => line.split("\t"));
}

function trackFrom(f: string[]): LibraryTrack | null {
  if (!f[0]) return null;
  const track: LibraryTrack = {
    pid: f[0],
    name: f[1] ?? "",
    artist: f[2] ?? "",
    album: f[3] ?? "",
    duration_s: num(f[4]),
    played_count: num(f[5]),
  };
  if (f[6] !== undefined && f[6] !== "") track.age_s = num(f[6]);
  return track;
}

export function parseTracks(out: string): LibraryTrack[] {
  return rowsOf(out)
    .map(trackFrom)
    .filter((t): t is LibraryTrack => t !== null);
}

export function parseState(out: string): PlayerState {
  const f = out.replace(/\n$/, "").split("\t");
  const repeat = f[3] === "one" || f[3] === "all" ? f[3] : "off";
  return {
    state: f[0] || "stopped",
    volume: num(f[1]),
    shuffle: f[2] === "true",
    repeat,
    position_s: num(f[4]),
    track: trackFrom(f.slice(5)),
  };
}

export function parsePlaylists(out: string): LibraryPlaylist[] {
  return rowsOf(out)
    .filter(f => f[0] && f[1])
    .map(f => ({
      pid: f[0],
      name: f[1],
      description: f[2] ?? "",
      track_count: num(f[3]),
      kind: f[4] ?? "",
    }));
}

export function parseAirPlay(out: string): AirPlayDevice[] {
  return rowsOf(out)
    .filter(f => f[0])
    .map(f => ({
      name: f[0],
      kind: f[1] ?? "",
      active: f[2] === "true",
      selected: f[3] === "true",
      available: f[4] !== "false",
      volume: num(f[5]),
    }));
}

/** Music.app driven through AppleScript; every call is one `osascript` run. */
export class MusicApp {
  constructor(private readonly run: ScriptRunner) {}

  async state(): Promise<PlayerState> {
    return parseState(await this.run(STATE, []));
  }

  async transport(command: "play" | "pause" | "next" | "previous"): Promise<void> {
    await this.run(CONTROL, [command]);
  }

  async setVolume(percent: number): Promise<void> {
    await this.run(CONTROL, ["volume", String(Math.round(percent))]);
  }

  async setShuffle(enabled: boolean): Promise<void> {
    await this.run(CONTROL, ["shuffle", String(enabled)]);
  }

  async setRepeat(mode: "off" | "one" | "all"): Promise<void> {
    await this.run(CONTROL, ["repeat", mode]);
  }

  async seek(seconds: number): Promise<void> {
    await this.run(CONTROL, ["seek", String(Math.max(0, Math.round(seconds)))]);
  }

  async searchLibrary(query: string, area: "names" | "all" = "names"): Promise<LibraryTrack[]> {
    return parseTracks(await this.run(SEARCH_LIBRARY, [query, area]));
  }

  async playTrack(pid: string): Promise<void> {
    await this.run(PLAY_TRACK, [pid]);
  }

  async playlists(): Promise<LibraryPlaylist[]> {
    return parsePlaylists(await this.run(PLAYLISTS, []));
  }

  async playPlaylist(pid: string): Promise<void> {
    await this.run(PLAY_PLAYLIST, [pid]);
  }

  async airPlayDevices(): Promise<AirPlayDevice[]> {
    return parseAirPlay(await this.run(AIRPLAY_LIST, []));
  }

  async setAirPlayDevice(name: string): Promise<void> {
    await this.run(AIRPLAY_SET, [name]);
  }

  async favourites(): Promise<LibraryTrack[]> {
    return parseTracks(await this.run(FAVOURITES, []));
  }

  async mostPlayed(): Promise<LibraryTrack[]> {
    return parseTracks(await this.run(MOST_PLAYED, []));
  }

  async recentlyPlayed(): Promise<LibraryTrack[]> {
    return parseTracks(await this.run(RECENT, []));
  }

  async openUrl(url: string): Promise<void> {
    await this.run(OPEN_URL, [url]);
  }
}
