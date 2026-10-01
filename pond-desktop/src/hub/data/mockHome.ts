// ─── Mock Home Data ────────────────────────────────────────────

export interface WeatherForecastDay {
  d: string;
  i: "sun" | "cloudSun" | "cloud" | "rain";
  t: number;
}

export interface WeatherData {
  temp: number;
  cond: string;
  icon: string;
  hi: number;
  lo: number;
  hum: number;
  wind: number;
  /** "HH:MM" local time, used to derive the day/night background phase. */
  sunrise: string;
  sunset: string;
  forecast: WeatherForecastDay[];
}

export interface RoomData {
  id: string;
  name: string;
  icon: string;
}

export type DeviceKind = "light" | "lock" | "thermo" | "plug" | "other";

export interface DeviceData {
  id: string;
  name: string;
  kind: DeviceKind;
  /** Raw backend device_type (host, sensor, gotg, …); picks the icon when kind is "other". */
  subtype?: string;
  on?: boolean;
  locked?: boolean;
  value?: number;
  target?: number;
  room: string;
  /** Verbatim from `GET /api/v1/devices`; an empty list is what keeps a switch off a contact sensor. */
  capabilities?: string[];
}

export interface CameraData {
  id: string;
  name: string;
  time: string;
  hue: number;
}

export interface CategoryData {
  id: string;
  label: string;
  status: string;
  icon: string;
  color: string;
  bg: string;
}

export interface SceneData {
  id: string;
  name: string;
  icon: string;
  active: boolean;
}

export interface NowPlayingData {
  track: string;
  artist: string;
  elapsed: number;
  hue: number;
  /** Spotify cover-art URL; the hue gradient is used when absent. */
  albumArt?: string | null;
  /** Whether Spotify is connected — gates real playback controls vs. the cosmetic demo toggle. */
  connected: boolean;
  playing: boolean;
  /** Spotify refused the request (not "nothing playing"); playback controls would fail too. */
  error?: string;
  /** Human-readable explanation for `error`. */
  message?: string;
  /** Position and length in ms from Spotify; null when unreported, since 0 would read as a track's start. */
  progressMs: number | null;
  durationMs: number | null;
  /** The item's page on Spotify, linked from the card as Spotify's design guidelines ask. */
  link?: string | null;
  /** The household's chosen service; absent is Spotify, which is all these controls drive. */
  service?: "apple" | "spotify";
  /** The chosen player: the player page, or the service's own app. */
  player?: "page" | "app";
  /** What Spotify allows right now; absent means everything. */
  can?: { pause: boolean; resume: boolean; next: boolean; previous: boolean };
}

/**
 * "off" is a household decision; "unreachable" a provider 502, egress refusal or timeout; "unknown"
 * not yet asked. Treating the last two as "off" asks for a location that is already set.
 */
export type WeatherStatus = "on" | "off" | "unreachable" | "unknown";

export interface HomeData {
  user: string;
  weather: WeatherData;
  rooms: RoomData[];
  devices: DeviceData[];
  cameras: CameraData[];
  categories: CategoryData[];
  scenes: SceneData[];
  nowPlaying: NowPlayingData;
  /** Weather is on and answered; false includes "not answered yet". Write copy off `weatherStatus`. */
  weatherEnabled: boolean;
  /** Why `weatherEnabled` reads the way it does. */
  weatherStatus: WeatherStatus;
  /** The devices in this snapshot came from the pond rather than from this file. */
  devicesAreReal: boolean;
}

/** Placeholder so `weather` stays non-null. Never paint from it: a zero here is a temperature. */
export const NO_WEATHER: WeatherData = {
  temp: 0,
  cond: "",
  icon: "",
  hi: 0,
  lo: 0,
  hum: 0,
  wind: 0,
  sunrise: "",
  sunset: "",
  forecast: [],
};

/** Nothing playing, and nothing claimed about why. */
const SILENT_PLAYER: NowPlayingData = {
  track: "",
  artist: "",
  elapsed: 0,
  hue: 265,
  connected: false,
  playing: false,
  progressMs: null,
  durationMs: null,
};

/**
 * What a household sees before their pond has answered: empty, so nothing can pass for a real
 * house. `user` stays because a name to greet claims nothing about the home.
 */
export const EMPTY_HOME: HomeData = {
  user: "Jerry",
  weather: NO_WEATHER,
  rooms: [],
  devices: [],
  cameras: [],
  categories: [],
  scenes: [],
  nowPlaying: SILENT_PLAYER,
  weatherEnabled: false,
  weatherStatus: "unknown",
  devicesAreReal: false,
};

export const HOME: HomeData = {
  user: "Jerry",
  weather: {
    temp: 64,
    cond: "Partly cloudy",
    icon: "cloudSun",
    hi: 68,
    lo: 54,
    hum: 62,
    wind: 12,
    sunrise: "06:30",
    sunset: "20:15",
    forecast: [
      { d: "Tue", i: "sun", t: 66 },
      { d: "Wed", i: "cloud", t: 62 },
      { d: "Thu", i: "rain", t: 58 },
    ],
  },
  rooms: [
    { id: "home",    name: "Home",        icon: "home" },
    { id: "living",  name: "Living Room", icon: "sofa" },
    { id: "kitchen", name: "Kitchen",     icon: "utensils" },
    { id: "bedroom", name: "Bedroom",     icon: "bed" },
    { id: "office",  name: "Office",      icon: "briefcase" },
    { id: "outdoor", name: "Outdoor",     icon: "tree" },
  ],
  devices: [
    { id: "driveway",  name: "Driveway Light",  kind: "light", on: false, room: "Outdoor" },
    { id: "thermo",    name: "Thermostat",       kind: "thermo", value: 68, target: 70, room: "Living Room" },
    { id: "frontdoor", name: "Front Door",       kind: "lock",  locked: true, room: "Outdoor" },
    { id: "patio",     name: "Patio Lights",     kind: "light", on: false, room: "Outdoor" },
    { id: "lrlights",  name: "Living Room",      kind: "light", on: true, room: "Living Room" },
    { id: "plug",      name: "Coffee Plug",      kind: "plug",  on: true, room: "Kitchen" },
    { id: "kitchenlt", name: "Kitchen Lights",   kind: "light", on: true, room: "Kitchen" },
    { id: "bedlamp",   name: "Bedside Lamp",     kind: "light", on: false, room: "Bedroom" },
    { id: "bedfan",    name: "Bedroom Fan",      kind: "plug",  on: false, room: "Bedroom" },
    { id: "desklamp",  name: "Desk Lamp",        kind: "light", on: true, room: "Office" },
  ],
  cameras: [
    { id: "front", name: "Front Door", time: "8:48 AM", hue: 150 },
    { id: "drive", name: "Driveway",   time: "8:49 AM", hue: 35 },
    { id: "back",  name: "Backyard",   time: "8:47 AM", hue: 205 },
  ],
  categories: [
    { id: "security", label: "Security", status: "Disarmed",    icon: "shieldCheck", color: "#16A34A", bg: "#DCFCE7" },
    { id: "locks",    label: "Locks",    status: "All locked",  icon: "lock",        color: "#2563EB", bg: "#DBEAFE" },
    { id: "climate",  label: "Climate",  status: "Heat to 70°", icon: "thermo",      color: "#EA580C", bg: "#FFEDD5" },
    { id: "lights",   label: "Lights",   status: "2 on",        icon: "bulb",        color: "#D97706", bg: "#FEF3C7" },
    { id: "cameras",  label: "Cameras",  status: "3 live",      icon: "cctv",        color: "#7C3AED", bg: "#EDE9FE" },
    { id: "plugs",    label: "Plugs",    status: "9 on",        icon: "plug",        color: "#0D9488", bg: "#CCFBF1" },
  ],
  scenes: [
    { id: "morning", name: "Good Morning", icon: "sun",   active: true },
    { id: "night",   name: "Good Night",   icon: "moon",  active: false },
    { id: "movie",   name: "Movie Time",   icon: "film",  active: false },
    { id: "away",    name: "Away",         icon: "away",  active: false },
    { id: "focus",   name: "Focus",        icon: "focus", active: false },
  ],
  nowPlaying: {
    track: "Weightless",
    artist: "Marconi Union",
    elapsed: 0.42,
    hue: 265,
    connected: false,
    playing: true,
    progressMs: null,
    durationMs: null,
  },
  weatherEnabled: false,
  weatherStatus: "unknown",
  devicesAreReal: false,
};
