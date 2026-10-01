import { describe, expect, it } from "vitest";
import {
  SDK_URL,
  SpotifyWebPlaybackAdapter,
  TRANSFER_URL,
  type SdkPlaybackState,
  type SdkPlayer,
  type SpotifyDeps,
  type SpotifyGlobal,
} from "./spotifyWebPlayback";
import { PlayerError } from "../types";

/**
 * The Web Playback SDK as its Reference describes it: a player that emits `ready` with a device id
 * once connected, `player_state_changed` with a WebPlaybackState, and the error events with a message.
 * Built from the documented shapes; these tests say what the adapter does with them.
 */
class FakePlayer implements SdkPlayer {
  static instances: FakePlayer[] = [];
  /** What the next player's connect() answers. */
  static connects = true;
  listeners = new Map<string, Array<(payload: never) => void>>();
  calls: Array<[string, ...unknown[]]> = [];
  connectResult = FakePlayer.connects;
  autoReady: string | null = "device-1";
  getOAuthToken: (deliver: (t: string) => void) => void;
  name: string;
  delivered: string[] = [];

  constructor(options: { name: string; getOAuthToken: (deliver: (t: string) => void) => void }) {
    this.name = options.name;
    this.getOAuthToken = options.getOAuthToken;
    FakePlayer.instances.push(this);
  }

  addListener(name: string, listener: (payload: never) => void) {
    const list = this.listeners.get(name) ?? [];
    list.push(listener);
    this.listeners.set(name, list);
  }
  emit(name: string, payload: unknown = {}) {
    for (const l of this.listeners.get(name) ?? []) l(payload as never);
  }
  /** The Reference: the SDK asks for a token on every connect(). */
  async connect() {
    this.getOAuthToken((t) => this.delivered.push(t));
    if (this.connectResult && this.autoReady) this.emit("ready", { device_id: this.autoReady });
    return this.connectResult;
  }
  disconnect() {
    this.calls.push(["disconnect"]);
  }
  async pause() {
    this.calls.push(["pause"]);
  }
  async resume() {
    this.calls.push(["resume"]);
  }
  async nextTrack() {
    this.calls.push(["next"]);
  }
  async previousTrack() {
    this.calls.push(["previous"]);
  }
  async seek(ms: number) {
    this.calls.push(["seek", ms]);
  }
  async setVolume(v: number) {
    this.calls.push(["volume", v]);
  }
  async activateElement() {
    this.calls.push(["activateElement"]);
  }
  current: SdkPlaybackState | null = null;
  async getCurrentState() {
    this.calls.push(["getCurrentState"]);
    return this.current;
  }
}

function sdk(): SpotifyGlobal {
  return { Player: FakePlayer as unknown as SpotifyGlobal["Player"] };
}

/** A fake of the Web API's Transfer Playback, recording what the page asked. */
function transfers(status = 204) {
  const asked: Array<{ url: string; method?: string; body: unknown; auth?: string }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    asked.push({
      url,
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
    });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { asked, fetchFn };
}

function setup(over: Partial<SpotifyDeps> = {}) {
  FakePlayer.instances = [];
  FakePlayer.connects = true;
  const log = { sdkLoads: 0, tokenAsks: [] as boolean[], networkAsks: [] as string[] };
  const web = transfers();
  const deps: SpotifyDeps = {
    loadSdk: async () => {
      log.sdkLoads += 1;
      return sdk();
    },
    fetchUserToken: async (refresh) => {
      log.tokenAsks.push(refresh);
      return refresh ? "renewed-token" : "first-token";
    },
    networkAllows: async (url) => {
      log.networkAsks.push(url);
      return null;
    },
    fetch: web.fetchFn,
    ...over,
  };
  const adapter = new SpotifyWebPlaybackAdapter(deps);
  return { adapter, deps, log, web, player: () => FakePlayer.instances[0]! };
}

const track = {
  id: "4uLU6hMCjMI75M1A2tKUQC",
  uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
  name: "So What",
  duration_ms: 545_000,
  album: { name: "Kind of Blue", images: [{ url: "https://i.scdn.co/image/abc" }] },
  artists: [{ name: "Miles Davis" }, { name: "John Coltrane" }],
};

function playing(over: Partial<SdkPlaybackState> = {}): SdkPlaybackState {
  return {
    paused: false,
    position: 12_345.9,
    duration: 545_000,
    shuffle: false,
    repeat_mode: 0,
    track_window: { current_track: track },
    ...over,
  };
}

describe("SpotifyWebPlaybackAdapter: starting up, as Getting Started does", () => {
  it("names the device, connects, and waits for a click once ready", async () => {
    const { adapter, player } = setup();
    await adapter.init();
    expect(player().name).toBe("Goose In A Pond");
    expect(adapter.state()).toMatchObject({ ready: true, need: "interaction" });
    expect(adapter.device()).toEqual({ device_id: "device-1", name: "Goose In A Pond", ready: true });
  });

  it("asks for the token before anything else, and loads no script when there is none", async () => {
    const { adapter, log } = setup({
      fetchUserToken: async () => {
        throw new Error("Sign in to Spotify in the Music extension's settings.");
      },
    });
    await adapter.init();
    expect(log.sdkLoads).toBe(0);
    expect(log.networkAsks).toEqual([]);
    expect(adapter.state()).toMatchObject({ need: "setup", message: expect.stringContaining("Sign in to Spotify") });
  });

  it("asks the pond's network setting before loading Spotify's script, and loads nothing when it says no", async () => {
    const { adapter, log } = setup({
      networkAllows: async (url) => {
        log.networkAsks.push(url);
        return "This pond is set to stay offline.";
      },
    });
    await adapter.init();
    expect(log.networkAsks).toEqual([SDK_URL]);
    expect(log.sdkLoads).toBe(0);
    expect(adapter.state()).toMatchObject({ need: "setup", message: "This pond is set to stay offline." });
  });

  it("answers getOAuthToken with a token every time it asks, renewing on every ask after the first", async () => {
    const { adapter, log, player } = setup();
    await adapter.init();
    await Promise.resolve();
    // The Reference: asked on every connect(), and again whenever the token has expired.
    player().getOAuthToken((t) => player().delivered.push(t));
    await Promise.resolve();
    await Promise.resolve();
    expect(player().delivered).toEqual(["first-token", "renewed-token"]);
    expect(log.tokenAsks).toEqual([false, false, true]);
  });

  it("says so when the player will not connect", async () => {
    const { adapter } = setup();
    FakePlayer.connects = false;
    await adapter.init();
    expect(adapter.state()).toMatchObject({ ready: false, need: "setup" });
    expect(adapter.state().message).toMatch(/would not connect/);
  });

  it("connects once: a second init does not open a second device", async () => {
    const { adapter } = setup();
    await adapter.init();
    await adapter.init();
    expect(FakePlayer.instances).toHaveLength(1);
  });
});

describe("SpotifyWebPlaybackAdapter: the click that starts it here", () => {
  it("calls activateElement in the click, then transfers playback to this device with play: true", async () => {
    const { adapter, player, web } = setup();
    await adapter.init();
    await adapter.activate();
    expect(player().calls[0]).toEqual(["activateElement"]);
    expect(web.asked).toEqual([
      { url: TRANSFER_URL, method: "PUT", body: { device_ids: ["device-1"], play: true }, auth: "Bearer first-token" },
    ]);
    expect(adapter.state()).toMatchObject({ need: "none" });
  });

  it("calls activateElement before its first await, so the click still counts", async () => {
    const { adapter, player } = setup();
    await adapter.init();
    void adapter.activate();
    expect(player().calls).toEqual([["activateElement"]]);
  });

  it("asks the network setting before calling the Web API", async () => {
    const { adapter, log } = setup();
    await adapter.init();
    await adapter.activate();
    expect(log.networkAsks).toEqual([SDK_URL, TRANSFER_URL]);
  });

  it("says what to do when there is nothing to move here yet (404)", async () => {
    const web = transfers(404);
    const { adapter } = setup({ fetch: web.fetchFn });
    await adapter.init();
    await adapter.activate();
    expect(adapter.state().message).toMatch(/Nothing is playing on Spotify to bring here/);
    expect(adapter.state().message).toMatch(/choose Goose In A Pond in Spotify's list of devices/);
  });

  it("says Premium is needed when Spotify refuses the move (403)", async () => {
    const web = transfers(403);
    const { adapter } = setup({ fetch: web.fetchFn });
    await adapter.init();
    await adapter.activate();
    expect(adapter.state().message).toMatch(/needs Spotify Premium/);
  });

  it("refuses before the device is ready", async () => {
    const { adapter } = setup();
    await expect(adapter.activate()).rejects.toMatchObject({ code: "not_ready" });
  });

  it("asks for the click again when the browser refused autoplay (autoplay_failed)", async () => {
    const { adapter, player } = setup();
    await adapter.init();
    await adapter.activate();
    player().emit("autoplay_failed");
    expect(adapter.state()).toMatchObject({ need: "interaction" });
    expect(adapter.state().message).toMatch(/Press Play Spotify here/);
  });

  it("stays armed across a reconnect: ready again after activation needs no second click", async () => {
    const { adapter, player } = setup();
    await adapter.init();
    await adapter.activate();
    player().emit("not_ready", { device_id: "device-1" });
    expect(adapter.state().ready).toBe(false);
    player().emit("ready", { device_id: "device-2" });
    expect(adapter.state()).toMatchObject({ ready: true, need: "none" });
    expect(adapter.device().device_id).toBe("device-2");
  });
});

describe("SpotifyWebPlaybackAdapter: what is playing, as the design guidelines show it", () => {
  it("maps the WebPlaybackState, with the artwork, every artist, and a link back to the track", async () => {
    const { adapter, player } = setup();
    await adapter.init();
    player().emit("player_state_changed", playing());
    expect(adapter.state()).toMatchObject({
      status: "playing",
      position_ms: 12_345,
      track: {
        id: track.id,
        title: "So What",
        artist: "Miles Davis, John Coltrane",
        album: "Kind of Blue",
        duration_ms: 545_000,
        artwork_url: "https://i.scdn.co/image/abc",
        link: `https://open.spotify.com/track/${track.id}`,
      },
    });
  });

  it("reads disallows into what may be done right now", async () => {
    const { adapter, player } = setup();
    await adapter.init();
    player().emit("player_state_changed", playing({ disallows: { pausing: true, skipping_next: true } }));
    expect(adapter.state().can).toEqual({ pause: false, resume: true, next: false, previous: true, seek: true });
  });

  it("goes idle when this device stops being the active one (a null state)", async () => {
    const { adapter, player } = setup();
    await adapter.init();
    player().emit("player_state_changed", playing());
    player().emit("player_state_changed", null);
    expect(adapter.state()).toMatchObject({ status: "idle", track: null });
  });

  it("offers play and pause as its only control, and credits Spotify with the guidelines' link words", () => {
    const { adapter } = setup();
    expect(adapter.controls).toEqual(["playPause"]);
    expect(adapter.brand.linkLabel).toBe("LISTEN ON SPOTIFY");
  });
});

describe("SpotifyWebPlaybackAdapter: errors, each in its own words", () => {
  it.each([
    ["initialization_error", /could not start in this browser: no EME/, "setup"],
    ["authentication_error", /did not accept the sign-in: bad token/, "setup"],
    ["account_error", /needs a Premium account: free user/, "setup"],
  ])("%s", async (event, words, need) => {
    const { adapter, player } = setup();
    await adapter.init();
    const message = { initialization_error: "no EME", authentication_error: "bad token", account_error: "free user" }[event];
    player().emit(event, { message });
    expect(adapter.state().need).toBe(need);
    expect(adapter.state().message).toMatch(words);
  });

  it("shows a playback error and does nothing the Reference does not say to do: no pause", async () => {
    const { adapter, player } = setup();
    await adapter.init();
    player().emit("player_state_changed", playing());
    player().emit("playback_error", { message: "Cannot perform operation; no list was loaded." });
    expect(adapter.state()).toMatchObject({ status: "error" });
    expect(adapter.state().message).toMatch(/no list was loaded/);
    expect(player().calls.filter((c) => c[0] === "pause")).toEqual([]);
  });

  it("keeps a problem on screen through a pause, and clears it once music plays", async () => {
    const { adapter, player } = setup();
    await adapter.init();
    player().emit("playback_error", { message: "boom" });
    player().emit("player_state_changed", playing({ paused: true }));
    expect(adapter.state().message).toMatch(/boom/);
    player().emit("player_state_changed", playing());
    expect(adapter.state().message).toBeUndefined();
  });
});

describe("SpotifyWebPlaybackAdapter: by hand only", () => {
  it("does the page's own transport with the SDK's documented methods", async () => {
    const { adapter, player } = setup();
    await adapter.init();
    await adapter.pause();
    await adapter.resume();
    await adapter.next();
    await adapter.previous();
    await adapter.seek(-5);
    await adapter.setVolume(250);
    expect(player().calls).toEqual([["pause"], ["resume"], ["next"], ["previous"], ["seek", 0], ["volume", 1]]);
  });

  it("chooses no music: that is Spotify's, in its own apps, never the assistant's", async () => {
    const { adapter } = setup();
    await adapter.init();
    for (const attempt of [
      () => adapter.search(),
      () => adapter.play({ id: "x", kind: "song" }),
      () => adapter.playlists(),
      () => adapter.library("saved", 5),
    ]) {
      const error = await attempt().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PlayerError);
      expect((error as PlayerError).code).toBe("unsupported");
      expect((error as PlayerError).message).toMatch(/not controlled by the assistant/);
    }
  });

  it("has no sign-in of its own", async () => {
    const { adapter } = setup();
    await expect(adapter.authorize()).rejects.toMatchObject({ code: "unsupported" });
  });
});
