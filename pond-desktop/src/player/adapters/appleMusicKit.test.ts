import { describe, expect, it } from "vitest";
import {
  AppleMusicKitAdapter,
  MUSICKIT_URL,
  describeMkError,
  type AppleDeps,
  type MediaItem,
  type MusicKitGlobal,
  type MusicKitInstance,
} from "./appleMusicKit";
import { PlayerError } from "../types";

type Scenario = "plays" | "license" | "silent" | "announces-only" | "needs-click" | "unsupported";

/** An MKError as MusicKit throws it: its code is `errorCode` (the MKError reference). */
const mkError = (errorCode: string, description = "") => Object.assign(new Error(description), { errorCode, description });

const PLAYBACK = {
  none: 0, loading: 1, playing: 2, paused: 3, stopped: 4, ended: 5, seeking: 6, waiting: 8, stalled: 9, completed: 10,
};

/** MusicKit as the Instance, Queue and Events references describe it. */
class FakeMusic implements MusicKitInstance {
  isAuthorized = false;
  volume = 1;
  shuffleMode = 0;
  repeatMode = 0;
  playbackState = PLAYBACK.none;
  currentPlaybackTime = 0;
  nowPlayingItem: MediaItem | undefined = undefined;
  scenario: Scenario = "plays";
  signIn: "grants" | "cancels" | "throws" = "grants";
  clicked = false;
  calls: Array<[string, ...unknown[]]> = [];
  apiCalls: Array<[string, Record<string, unknown> | undefined]> = [];
  replies = new Map<string, unknown>();
  private listeners = new Map<string, Set<(e: unknown) => void>>();

  api = {
    music: async (path: string, params?: Record<string, unknown>) => {
      this.apiCalls.push([path, params]);
      const reply = this.replies.get(path);
      if (reply instanceof Error) throw reply;
      return reply ?? { data: {} };
    },
  };

  addEventListener(name: string, l: (e: unknown) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(l);
  }
  removeEventListener(name: string, l: (e: unknown) => void) {
    this.listeners.get(name)?.delete(l);
  }
  emit(name: string, payload: unknown = {}) {
    this.listeners.get(name)?.forEach((l) => l(payload));
  }

  /** Resolves with a user string, or with nothing when the sign-in did not finish. */
  async authorize() {
    this.calls.push(["authorize"]);
    if (this.signIn === "throws") throw mkError("AUTHORIZATION_ERROR", "rejected");
    if (this.signIn === "cancels") return undefined;
    this.isAuthorized = true;
    this.emit("authorizationStatusDidChange");
    return "a-user";
  }
  async unauthorize() {
    this.calls.push(["unauthorize"]);
    this.isAuthorized = false;
    this.emit("authorizationStatusDidChange");
  }
  private start() {
    if (this.scenario === "silent") return;
    this.playbackState = PLAYBACK.playing;
    this.emit("playbackStateDidChange");
    if (this.scenario === "announces-only") return;
    setTimeout(() => {
      if (this.scenario === "license") {
        this.emit("mediaPlaybackError", mkError("MEDIA_LICENSE", "Error acquiring license"));
      } else {
        this.currentPlaybackTime = 1;
        this.emit("playbackTimeDidChange");
      }
    }, 0);
  }
  async setQueue(o: Record<string, unknown>) {
    this.calls.push(["setQueue", o]);
    if (o.song === "reject") throw mkError("CONTENT_UNAVAILABLE");
    if (this.scenario === "unsupported") return undefined;
    const id = String(o.song ?? o.album ?? o.playlist);
    this.nowPlayingItem = {
      id,
      attributes: {
        name: "Nairobi",
        artistName: "Bensoul",
        albumName: "Qwarantunes",
        durationInMillis: 210_000,
        artwork: { url: "https://x/{w}x{h}.jpg", width: 3000, height: 3000 },
      },
    };
    this.emit("nowPlayingItemDidChange", { item: this.nowPlayingItem });
    if (o.startPlaying === true) {
      if (this.scenario === "needs-click" && !this.clicked) throw mkError("USER_INTERACTION_REQUIRED");
      this.start();
    }
    return { items: [this.nowPlayingItem] };
  }
  play() {
    this.calls.push(["play"]);
    if (this.scenario === "needs-click" && !this.clicked) return Promise.reject(mkError("USER_INTERACTION_REQUIRED"));
    this.start();
    return Promise.resolve();
  }
  pause() {
    this.calls.push(["pause"]);
    this.playbackState = PLAYBACK.paused;
    this.emit("playbackStateDidChange");
  }
  async skipToNextItem() { this.calls.push(["next"]); }
  async skipToPreviousItem() { this.calls.push(["previous"]); }
  async seekToTime(s: number) { this.calls.push(["seek", s]); }
  async playNext(o: Record<string, unknown>) { this.calls.push(["playNext", o]); }
  async playLater(o: Record<string, unknown>) { this.calls.push(["playLater", o]); }
}

/** The MusicKit global: `configure` resolves with the instance (the MusicKit reference). */
function fakeKit(music: FakeMusic) {
  const configured: unknown[] = [];
  const kit: MusicKitGlobal = {
    configure: async (c) => {
      configured.push(c);
      return music;
    },
    getInstance: () => music,
    formatArtworkURL: (art, w, h) => (art.url ?? "").replace("{w}", String(w ?? art.width)).replace("{h}", String(h ?? art.height)),
    PlaybackStates: PLAYBACK,
    PlayerShuffleMode: { off: 0, songs: 1 },
    PlayerRepeatMode: { none: 0, one: 1, all: 2 },
  };
  return { kit, configured };
}

async function ready(over: { authorised?: boolean; scenario?: Scenario; playConfirmMs?: number } = {}) {
  const music = new FakeMusic();
  music.isAuthorized = over.authorised ?? true;
  music.scenario = over.scenario ?? "plays";
  const { kit, configured } = fakeKit(music);
  const deps: AppleDeps = {
    loadMusicKit: async () => kit,
    fetchDeveloperToken: async () => "dev-token",
    networkAllows: async () => null,
    playConfirmMs: over.playConfirmMs ?? 200,
  };
  const adapter = new AppleMusicKitAdapter(deps);
  await adapter.init();
  return { adapter, music, configured };
}

describe("AppleMusicKitAdapter: starting up, as Getting Started does", () => {
  it("configures MusicKit with the pond's developer token and the app's name, and uses the instance configure returns", async () => {
    const { adapter, configured } = await ready();
    expect(configured).toEqual([{ developerToken: "dev-token", app: { name: "Goose In A Pond" } }]);
    expect(adapter.state()).toMatchObject({ ready: true, need: "none" });
  });

  it("asks the pond's network setting before loading Apple's script, and loads nothing when it says no", async () => {
    const asked: string[] = [];
    let loaded = false;
    const adapter = new AppleMusicKitAdapter({
      loadMusicKit: async () => {
        loaded = true;
        return fakeKit(new FakeMusic()).kit;
      },
      fetchDeveloperToken: async () => "t",
      networkAllows: async (url) => {
        asked.push(url);
        return "This pond is set to stay offline.";
      },
    });
    await adapter.init();
    expect(asked).toEqual([MUSICKIT_URL]);
    expect(loaded).toBe(false);
    expect(adapter.state()).toMatchObject({ ready: false, need: "setup", message: "This pond is set to stay offline." });
  });

  it("asks the network question only once there is a token, so a pond with no key logs nothing", async () => {
    let asked = 0;
    let loads = 0;
    const adapter = new AppleMusicKitAdapter({
      loadMusicKit: async () => {
        loads += 1;
        return fakeKit(new FakeMusic()).kit;
      },
      fetchDeveloperToken: async () => {
        throw new Error("Apple Music is not set up: add your Team ID.");
      },
      networkAllows: async () => {
        asked += 1;
        return null;
      },
    });
    // The setup retry asks every ten seconds, so this runs over and over on a pond with no key.
    await adapter.init();
    await adapter.init();
    expect({ asked, loads }).toEqual({ asked: 0, loads: 0 });
    expect(adapter.state()).toMatchObject({ ready: false, need: "setup" });
    expect(adapter.state().message).toContain("Team ID");
  });

  it("asks for a sign-in when nobody is signed in, and is ready at once when MusicKit still holds one", async () => {
    expect((await ready({ authorised: false })).adapter.state()).toMatchObject({ ready: false, need: "authorization" });
    expect((await ready({ authorised: true })).adapter.state()).toMatchObject({ ready: true, need: "none" });
  });

  it("says so when Apple's script cannot be loaded", async () => {
    const adapter = new AppleMusicKitAdapter({
      loadMusicKit: async () => {
        throw new Error("Could not load MusicKit from Apple.");
      },
      fetchDeveloperToken: async () => "t",
    });
    await adapter.init();
    expect(adapter.state().need).toBe("setup");
    expect(adapter.state().message).toContain("MusicKit");
  });

  it("configures once: a second init is a no-op, since the instance is a singleton", async () => {
    const { adapter, configured } = await ready();
    await adapter.init();
    expect(configured).toHaveLength(1);
  });
});

describe("AppleMusicKitAdapter: User Authorization", () => {
  it("signs in and becomes ready", async () => {
    const { adapter } = await ready({ authorised: false });
    await adapter.authorize();
    expect(adapter.state()).toMatchObject({ ready: true, need: "none" });
  });

  it("treats a sign-in that resolves with nothing as not finished, and says so", async () => {
    const { adapter, music } = await ready({ authorised: false });
    music.signIn = "cancels";
    await adapter.authorize();
    expect(adapter.state().ready).toBe(false);
    expect(adapter.state().message).toMatch(/did not finish/);
  });

  it("reports a refused sign-in without throwing", async () => {
    const { adapter, music } = await ready({ authorised: false });
    music.signIn = "throws";
    await adapter.authorize();
    expect(adapter.state().ready).toBe(false);
    expect(adapter.state().message).toMatch(/sign in again/);
  });

  it("calls MusicKit's authorize before its first await, so the sign-in window opens inside the click", async () => {
    const { adapter, music } = await ready({ authorised: false });
    void adapter.authorize();
    expect(music.calls).toEqual([["authorize"]]);
  });

  it("signs out with unauthorize", async () => {
    const { adapter, music } = await ready();
    await adapter.signOut();
    expect(music.calls).toEqual([["unauthorize"]]);
    expect(adapter.state()).toMatchObject({ ready: false, need: "authorization" });
  });
});

describe("AppleMusicKitAdapter: guards", () => {
  it("refuses everything before it has been configured", async () => {
    const adapter = new AppleMusicKitAdapter({
      loadMusicKit: async () => {
        throw new Error("offline");
      },
      fetchDeveloperToken: async () => "t",
    });
    await adapter.init();
    await expect(adapter.play({ id: "1", kind: "song" })).rejects.toMatchObject({ code: "not_ready" });
    await expect(adapter.search("x")).rejects.toMatchObject({ code: "not_ready" });
  });

  it("can search without a sign-in but cannot play or read the library", async () => {
    const { adapter, music } = await ready({ authorised: false });
    music.replies.set("/v1/catalog/{{storefrontId}}/search", { data: { results: { songs: { data: [] } } } });
    await expect(adapter.search("x")).resolves.toEqual([]);
    await expect(adapter.play({ id: "1", kind: "song" })).rejects.toMatchObject({ code: "needs_authorization" });
    await expect(adapter.playlists()).rejects.toMatchObject({ code: "needs_authorization" });
    await expect(adapter.library("saved", 5)).rejects.toMatchObject({ code: "needs_authorization" });
  });
});

describe("AppleMusicKitAdapter: finding things, through the Passthrough API", () => {
  it("searches with the {{storefrontId}} path token and maps the songs, artwork through formatArtworkURL", async () => {
    const { adapter, music } = await ready();
    music.replies.set("/v1/catalog/{{storefrontId}}/search", {
      data: {
        results: {
          songs: {
            data: [
              {
                id: "1001",
                attributes: {
                  name: "Nairobi",
                  artistName: "Bensoul",
                  albumName: "Qwarantunes",
                  durationInMillis: 210_000,
                  artwork: { url: "https://x/{w}x{h}.jpg", width: 3000, height: 3000 },
                },
              },
              { id: "no-name", attributes: {} },
            ],
          },
        },
      },
    });

    const tracks = await adapter.search("nairobi bensoul", { limit: 3 });

    expect(music.apiCalls[0]).toEqual([
      "/v1/catalog/{{storefrontId}}/search",
      { term: "nairobi bensoul", types: "songs", limit: 3 },
    ]);
    expect(tracks).toEqual([
      {
        id: "1001",
        kind: "song",
        title: "Nairobi",
        artist: "Bensoul",
        album: "Qwarantunes",
        duration_ms: 210_000,
        artwork_url: "https://x/300x300.jpg",
      },
    ]);
  });

  it("keeps the search limit within what Apple allows", async () => {
    const { adapter, music } = await ready();
    await adapter.search("a", { limit: 500 });
    await adapter.search("a", { limit: 0 });
    expect(music.apiCalls.map((c) => c[1]?.limit)).toEqual([25, 1]);
  });

  it("turns an Apple API failure into a player error", async () => {
    const { adapter, music } = await ready();
    music.replies.set("/v1/catalog/{{storefrontId}}/search", mkError("QUOTA_EXCEEDED"));
    await expect(adapter.search("a")).rejects.toBeInstanceOf(PlayerError);
  });

  it("follows next across pages and passes the limit each time, since next does not carry it", async () => {
    const { adapter, music } = await ready();
    music.replies.set("/v1/me/library/playlists", {
      data: {
        data: [{ id: "p.1", attributes: { name: "Road trip" } }],
        next: "/v1/me/library/playlists?offset=100",
      },
    });
    music.replies.set("/v1/me/library/playlists?offset=100", {
      data: { data: [{ id: "p.2", attributes: { name: "Focus" } }] },
    });
    expect(await adapter.playlists()).toEqual([
      { id: "p.1", name: "Road trip" },
      { id: "p.2", name: "Focus" },
    ]);
    expect(music.apiCalls.map((c) => c[1])).toEqual([{ limit: 100 }, { limit: 100 }]);
  });

  it("reads the library and prefers the catalog id of what it finds", async () => {
    const { adapter, music } = await ready();
    music.replies.set("/v1/me/library/songs", {
      data: {
        data: [
          {
            id: "i.abc",
            attributes: { name: "Nairobi", artistName: "Bensoul", playParams: { id: "i.abc", catalogId: "1001" } },
          },
        ],
      },
    });
    music.replies.set("/v1/me/recent/played/tracks", { data: { data: [] } });

    expect((await adapter.library("saved", 10))[0]?.id).toBe("1001");
    await adapter.library("recent", 500);
    expect(music.apiCalls.at(-1)).toEqual(["/v1/me/recent/played/tracks", { limit: 30 }]);
  });
});

describe("AppleMusicKitAdapter: playing, with setQueue and startPlaying", () => {
  it("queues the song with startPlaying and resolves once audio has really advanced", async () => {
    const { adapter, music } = await ready();
    await adapter.play({ id: "1001", kind: "song" });
    expect(music.calls).toEqual([["setQueue", { song: "1001", startPlaying: true }]]);
    expect(adapter.state()).toMatchObject({
      status: "playing",
      track: { id: "1001", title: "Nairobi", artist: "Bensoul", album: "Qwarantunes", artwork_url: "https://x/300x300.jpg" },
    });
  });

  it("queues an album or a playlist under its own key", async () => {
    const { adapter, music } = await ready();
    await adapter.play({ id: "p.1", kind: "playlist" });
    expect(music.calls[0]).toEqual(["setQueue", { playlist: "p.1", startPlaying: true }]);
  });

  it("says so when setQueue resolves with nothing, which means this environment cannot play", async () => {
    const { adapter } = await ready({ scenario: "unsupported" });
    await expect(adapter.play({ id: "1", kind: "song" })).rejects.toMatchObject({ code: "unsupported" });
  });

  it("reports a refused licence with its code, even though MusicKit said playing first", async () => {
    const { adapter } = await ready({ scenario: "license" });
    const outcome = adapter.play({ id: "1001", kind: "song" });
    await expect(outcome).rejects.toMatchObject({ code: "drm_refused" });
    expect(adapter.state().status).toBe("error");
    expect(adapter.state().message).toContain("MEDIA_LICENSE");
  });

  it("asks for a click on the page when the browser wants one, and plays once Play is pressed", async () => {
    const { adapter, music } = await ready({ scenario: "needs-click" });
    await expect(adapter.play({ id: "1", kind: "song" })).rejects.toMatchObject({ code: "needs_interaction" });
    expect(adapter.state()).toMatchObject({ status: "error" });
    expect(adapter.state().message).toMatch(/Press Play there once/);

    // The page's Play button is the click; it resumes the queued song.
    music.clicked = true;
    await adapter.resume();
    expect(music.calls.at(-1)).toEqual(["play"]);
    expect(adapter.state()).toMatchObject({ status: "playing" });
    expect(adapter.state().message).toBeUndefined();
  });

  it("does not count 'playing' as playing until the position moves", async () => {
    const { adapter, music } = await ready({ scenario: "announces-only", playConfirmMs: 500 });
    let settled = false;
    const outcome = adapter.play({ id: "1", kind: "song" }).then(() => (settled = true));

    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);

    music.currentPlaybackTime = 2;
    music.emit("playbackTimeDidChange");
    await outcome;
    expect(settled).toBe(true);
  });

  it("times out honestly when nothing starts", async () => {
    const { adapter } = await ready({ scenario: "silent", playConfirmMs: 40 });
    await expect(adapter.play({ id: "1", kind: "song" })).rejects.toThrow(/did not start playing within/);
  });

  it("reports a song Apple cannot queue", async () => {
    const { adapter } = await ready();
    await expect(adapter.play({ id: "reject", kind: "song" })).rejects.toMatchObject({ code: "player_error" });
  });

  it("clears an earlier failure when the next attempt works", async () => {
    const { adapter, music } = await ready({ scenario: "license" });
    await adapter.play({ id: "1", kind: "song" }).catch(() => undefined);
    expect(adapter.state().status).toBe("error");

    music.scenario = "plays";
    music.currentPlaybackTime = 0;
    await adapter.play({ id: "2", kind: "song" });
    expect(adapter.state()).toMatchObject({ status: "playing" });
    expect(adapter.state().message).toBeUndefined();
  });

  it("says so when playback falls back to previews because DRM cannot be set up (drmUnsupported)", async () => {
    const { adapter, music } = await ready();
    music.emit("drmUnsupported");
    expect(adapter.state()).toMatchObject({ status: "error" });
    expect(adapter.state().message).toMatch(/only previews/);
  });

  it("says so when another tab of the player took over playback (primaryPlayerDidChange)", async () => {
    const { adapter, music } = await ready();
    music.emit("primaryPlayerDidChange");
    expect(adapter.state().message).toMatch(/another tab/);
  });

  it("puts a song at the front or the back of the queue", async () => {
    const { adapter, music } = await ready();
    await adapter.enqueue({ id: "9", kind: "song" }, "next");
    await adapter.enqueue({ id: "8", kind: "song" }, "last");
    expect(music.calls).toEqual([["playNext", { song: "9" }], ["playLater", { song: "8" }]]);
  });
});

describe("AppleMusicKitAdapter: transport and state", () => {
  it("maps each control onto MusicKit and reflects it in the state", async () => {
    const { adapter, music } = await ready();

    await adapter.next();
    await adapter.previous();
    await adapter.seek(90_000);
    await adapter.pause();
    await adapter.setVolume(30);
    await adapter.setShuffle(true);
    await adapter.setRepeat("all");

    expect(music.calls).toEqual([["next"], ["previous"], ["seek", 90], ["pause"]]);
    expect(music.volume).toBeCloseTo(0.3);
    expect(adapter.state()).toMatchObject({ status: "paused", volume: 30, shuffle: true, repeat: "all" });

    await adapter.setShuffle(false);
    await adapter.setRepeat("off");
    expect(adapter.state()).toMatchObject({ shuffle: false, repeat: "off" });
    await adapter.setRepeat("one");
    expect(adapter.state().repeat).toBe("one");
  });

  it("maps every documented playback state", async () => {
    const { adapter, music } = await ready();
    const seen: Record<string, string> = {};
    for (const [name, value] of Object.entries(PLAYBACK)) {
      music.playbackState = value;
      music.emit("playbackStateDidChange");
      seen[name] = adapter.state().status;
    }
    expect(seen).toEqual({
      none: "idle",
      loading: "buffering",
      playing: "playing",
      paused: "paused",
      stopped: "idle",
      ended: "ended",
      seeking: "buffering",
      waiting: "buffering",
      stalled: "buffering",
      completed: "ended",
    });
  });

  it("keeps volume within 0 to 100 and seek from going negative", async () => {
    const { adapter, music } = await ready();
    await adapter.setVolume(500);
    expect(music.volume).toBe(1);
    await adapter.setVolume(-5);
    expect(music.volume).toBe(0);
    await adapter.seek(-1_000);
    expect(music.calls.at(-1)).toEqual(["seek", 0]);
  });

  it("lets the user pause even before signing in", async () => {
    const { adapter, music } = await ready({ authorised: false });
    await adapter.pause();
    expect(music.calls).toEqual([["pause"]]);
  });

  it("notifies listeners, and stops when they unsubscribe", async () => {
    const { adapter, music } = await ready();
    const seen: string[] = [];
    const off = adapter.onState((s) => seen.push(s.status));
    music.playbackState = PLAYBACK.paused;
    music.emit("playbackStateDidChange");
    off();
    music.playbackState = PLAYBACK.playing;
    music.emit("playbackStateDidChange");
    expect(seen).toEqual(["paused"]);
  });
});

describe("describeMkError: the MKError codes, in words", () => {
  it.each([
    ["USER_INTERACTION_REQUIRED", "needs_interaction", /Press Play there once/],
    ["AUTHORIZATION_ERROR", "needs_authorization", /sign in again/],
    ["TOKEN_EXPIRED", "needs_authorization", /sign in again/],
    ["SUBSCRIPTION_ERROR", "player_error", /no active Apple Music subscription/],
    ["STREAM_UPSELL", "player_error", /another device/],
    ["DEVICE_LIMIT", "player_error", /limit of devices/],
    ["MEDIA_LICENSE", "drm_refused", /MEDIA_LICENSE/],
    ["WIDEVINE_CDM_EXPIRED", "drm_refused", /too old/],
    ["OUTPUT_RESTRICTED", "drm_refused", /HDCP/],
    ["CONTENT_UNAVAILABLE", "player_error", /not available/],
    ["UNAUTHORIZED_ERROR", "not_ready", /developer token/],
    ["NETWORK_ERROR", "player_error", /could not be reached/],
  ])("%s", (code, expected, words) => {
    const e = describeMkError(mkError(code));
    expect(e.code).toBe(expected);
    expect(e.message).toMatch(words);
  });

  it("names an unlisted code and its description rather than guessing at a fix", () => {
    const e = describeMkError(mkError("PARSE_ERROR", "bad json"));
    expect(e).toMatchObject({ code: "player_error" });
    expect(e.message).toContain("bad json");
    expect(e.message).toContain("PARSE_ERROR");
  });

  it("copes with something that is not an MKError at all", () => {
    expect(describeMkError(undefined).code).toBe("player_error");
    expect(describeMkError("boom").message).toMatch(/could not play/);
  });
});
