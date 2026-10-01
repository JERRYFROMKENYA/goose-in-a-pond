import { log } from "../log.js";
import { AppleMusicProvider } from "./apple-music.js";
import { defaultStorefront, ItunesSearch, songIdFromLink } from "./apple/catalog.js";
import { EgressGate, type Fetch } from "./apple/egress.js";
import { MusicApp } from "./apple/music-app.js";
import { runAppleScript } from "./apple/osascript.js";
import { HostPlayer } from "./player/host.js";
import { chooseService } from "./select.js";
import type { MusicProvider } from "./types.js";
import { WebPlayerProvider } from "./web-player.js";

function createApple(env: NodeJS.ProcessEnv): AppleMusicProvider {
  const hostUrl = env.GIAP_SERVER_URL || "http://127.0.0.1:4000";
  const internalToken = env.GIAP_INTERNAL_TOKEN ?? "";

  const egress = new EgressGate(fetch, hostUrl, internalToken);
  const storefront = defaultStorefront(env.APPLE_MUSIC_STOREFRONT, Intl.DateTimeFormat().resolvedOptions().locale);

  return new AppleMusicProvider({
    app: new MusicApp(runAppleScript),
    catalog: new ItunesSearch(fetch, egress, storefront),
  });
}

/**
 * The provider for this run, or null when the assistant has no music service here (see
 * `chooseService`). With the player page chosen, Apple Music plays there when an Apple Music key or the
 * shared credentials are set up, since that plays the whole catalog; otherwise, and whenever the page
 * cannot be used, through the Music app. With the Music app chosen, only there.
 */
export async function createProvider(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  fetchFn: Fetch = fetch,
): Promise<MusicProvider | null> {
  const { service, player, reason } = chooseService(platform, env);
  log.info("service_chosen", service ? `using ${service}` : "no music service for the assistant", {
    service,
    player,
    reason,
  });
  if (service !== "apple") return null;

  const local = createApple(env);
  if (player === "app") return local;
  const host = new HostPlayer(
    fetchFn,
    env.GIAP_SERVER_URL || "http://127.0.0.1:4000",
    env.GIAP_INTERNAL_TOKEN ?? "",
    "apple",
  );
  const status = await host.status();
  if (!status?.configured) {
    log.info("apple_backend", "using the Music app: no Apple Music key is set up", {
      host_reachable: status !== null,
    });
    return local;
  }

  log.info("apple_backend", "using the music player page, with the Music app as its fallback", {
    player_attached: status.attached,
  });
  return new WebPlayerProvider({
    host,
    service: "apple",
    label: "Apple Music",
    local,
    linkToId: songIdFromLink,
  });
}
