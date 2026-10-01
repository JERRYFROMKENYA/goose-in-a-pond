import { HubIco } from "./HubIco";
import { HP_PATHS } from "./icons";
import { pauseEl } from "./HubIco";
import { useHomeData, controlNowPlaying, refreshNowPlaying } from "../state/hubDataStore";
import { api } from "../../api/PondApiClient";
import { invoke, isDesktopShell } from "../../shell";
import { SPOTIFY_LOGO } from "../../player/brand";

type NowPlayingVariant = "bar" | "tile";

interface NowPlayingProps {
  variant?: NowPlayingVariant;
}

/** A service's player page from the pond, in the real browser: the app's window would open it in-app. */
function openPlayerPage(service: "apple" | "spotify"): void {
  const url = `${api.serverUrl()}/player.html?service=${service}`;
  if (isDesktopShell()) void invoke("open_external", { url }).catch(() => undefined);
  else window.open(url, "_blank", "noopener");
}

/** With Apple Music chosen, the card says where it plays; the assistant and the page do the playing. */
function AppleMusicCard({ variant, player }: { variant: NowPlayingVariant; player: "page" | "app" }) {
  return (
    <div className={`np np--${variant}`}>
      <div className="np__art" style={{ background: "linear-gradient(135deg,hsl(350,70%,60%),hsl(20,70%,52%))" }}>
        <HubIco d={HP_PATHS.music} size={variant === "tile" ? 26 : 18} color="rgba(255,255,255,.9)" />
      </div>
      <div className="np__info">
        <span className="np__track">Apple Music</span>
        <span className="np__artist">
          {player === "page"
            ? "Ask the assistant for a song. It plays on the music player page."
            : "Ask the assistant for a song. It plays in the Music app."}
        </span>
        {player === "page" && (
          <span className="np__credit">
            <button type="button" className="np__link" onClick={() => openPlayerPage("apple")}>
              Open the music player
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The app's own Spotify control, by hand, through Spotify's Web API: never the assistant's, since
 * Spotify's developer rules forbid voice and AI control. Drawn to Spotify's design guidelines: the
 * cover art uncropped and unaltered, the metadata as Spotify sends it, Spotify's logo and a link back to
 * the item, and play or pause as the one control, off when Spotify disallows it right now.
 */
export function NowPlaying({ variant = "bar" }: NowPlayingProps) {
  const np = useHomeData().nowPlaying;
  if (np.service === "apple") return <AppleMusicCard variant={variant} player={np.player ?? "page"} />;
  return <SpotifyCard variant={variant} />;
}

/** The chosen service is Spotify (or none is stored yet): the app's own Spotify controls. */
function SpotifyCard({ variant }: { variant: NowPlayingVariant }) {
  const np = useHomeData().nowPlaying;
  // Spotify is linked but refusing requests: the control would fail too, so it gives way to a retry.
  const errored = Boolean(np.error);
  const playing = np.connected && np.playing;
  const allowed = np.can ? (playing ? np.can.pause : np.can.resume) : true;
  const art = !errored && np.albumArt ? np.albumArt : null;
  const idle = np.connected && !errored && !playing && !np.link;

  function handlePlayPause() {
    if (errored || !np.connected || !allowed) return;
    void controlNowPlaying(playing ? "pause" : "play");
  }

  return (
    <div className={`np np--${variant}${errored ? " np--error" : ""}`}>
      <div
        className="np__art"
        style={
          art
            ? undefined
            : {
                background: errored
                  ? "linear-gradient(135deg,#94A3B8,#64748B)"
                  : `linear-gradient(135deg,hsl(${np.hue},60%,58%),hsl(${np.hue + 40},55%,42%))`,
              }
        }
      >
        {art ? (
          <img className="np__artImg" src={art} alt={`Cover art for ${np.track}`} />
        ) : (
          <HubIco
            d={errored ? HP_PATHS.alert : HP_PATHS.music}
            size={variant === "tile" ? 26 : 18}
            color="rgba(255,255,255,.9)"
          />
        )}
      </div>
      <div className="np__info">
        <span className="np__track" title={np.track}>
          {np.connected ? np.track : "Spotify is not connected"}
        </span>
        <span className="np__artist" title={np.message ?? np.artist}>
          {np.connected ? np.artist : "Sign in to Spotify in the Music extension's settings."}
        </span>
        {variant === "tile" && !errored && np.connected && (
          <div className="np__bar">
            <span style={{ width: `${np.elapsed * 100}%` }} />
          </div>
        )}
        {np.connected && !errored && (
          <span className="np__credit">
            {/* Black on a light ground, white on a dark one; CSS shows the one for the theme. */}
            <img className="np__logo np__logo--on-light" src={SPOTIFY_LOGO.onLight} alt="Spotify" />
            <img className="np__logo np__logo--on-dark" src={SPOTIFY_LOGO.onDark} alt="" aria-hidden="true" />
            {np.link ? (
              <a className="np__link" href={np.link} target="_blank" rel="noopener noreferrer">
                LISTEN ON SPOTIFY
              </a>
            ) : (
              idle && (
                <button type="button" className="np__link" onClick={() => openPlayerPage("spotify")}>
                  Play Spotify on this computer
                </button>
              )
            )}
          </span>
        )}
      </div>
      <div className="np__ctrls">
        {errored ? (
          /* Repeated refusals stop the poll; a person asking again is what resumes it. */
          <button className="np__retry" onClick={() => void refreshNowPlaying(true)}>
            Try again
          </button>
        ) : (
          <button
            className="np__play"
            onClick={handlePlayPause}
            aria-label={playing ? "Pause" : "Play"}
            disabled={!np.connected || !allowed}
          >
            <HubIco d={playing ? pauseEl : HP_PATHS.play} size={16} color="#fff" />
          </button>
        )}
      </div>
    </div>
  );
}
