import { LogIn, LogOut, Music, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { usePlayerState } from "./usePlayerState";
import type { PlayerAdapter, PlayerControl } from "./types";
import "./player.css";

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const ALL_CONTROLS: readonly PlayerControl[] = ["previous", "playPause", "next"];

/**
 * One service on the player page: what is playing, with its artwork, and the controls that service's
 * own rules call for (Apple requires play, pause and skip; Spotify's guidelines recommend play and
 * pause only). Signing in, and arming the page with a click, are buttons here, because a browser only
 * opens a sign-in window, or lets a page play sound, after a click on the page itself.
 */
export function PlayerApp({ adapter }: { adapter: PlayerAdapter }) {
  const state = usePlayerState(adapter);
  const playing = state.status === "playing";
  const controls = adapter.controls ?? ALL_CONTROLS;
  const can = state.can;
  const brand = adapter.brand;

  async function run(action: () => Promise<void>) {
    try {
      await action();
    } catch {
      // The adapter already put the reason in its state.message, which is shown below.
    }
  }

  return (
    <main className="player" aria-label={`${adapter.label} player`}>
      <header className="player__head">
        {brand?.logoUrl ? (
          <img className="player__logo" src={brand.logoUrl} alt={adapter.label} height={24} />
        ) : (
          <>
            <Music size={18} strokeWidth={1.8} aria-hidden="true" />
            <h1 className="player__title">{adapter.label}</h1>
          </>
        )}
      </header>

      {state.need === "authorization" && (
        <section className="player__card">
          <p className="player__text">
            Sign in to {adapter.label} with the account that has your subscription.
          </p>
          <button
            type="button"
            className="player__primary"
            onClick={() => void run(() => adapter.authorize())}
          >
            <LogIn size={16} strokeWidth={1.8} aria-hidden="true" />
            Sign in to {adapter.label}
          </button>
        </section>
      )}

      {state.need === "interaction" && adapter.activate && (
        <section className="player__card">
          <p className="player__text">
            {adapter.label} plays on this page once you press the button. It moves what is playing on{" "}
            {adapter.label} here; you can also pick this computer in {adapter.label}'s list of devices.
          </p>
          <button
            type="button"
            className="player__primary"
            onClick={() => void run(() => adapter.activate!())}
          >
            <Play size={16} strokeWidth={1.8} aria-hidden="true" />
            Play {adapter.label} here
          </button>
        </section>
      )}

      {state.need === "setup" && (
        <section className="player__card">
          <p className="player__text">
            {state.message ??
              `${adapter.label} is not set up yet. Add it in the Music extension's settings.`}
          </p>
        </section>
      )}

      {state.need === "none" && (
        <section className="player__card">
          {state.track ? (
            <div className="player__now">
              {state.track.artwork_url && (
                <img
                  className="player__art"
                  src={state.track.artwork_url}
                  alt={`Artwork for ${state.track.album || state.track.title}`}
                  width={150}
                  height={150}
                />
              )}
              <div className="player__about">
                <p className="player__track" title={state.track.title}>
                  {state.track.title}
                </p>
                <p className="player__meta" title={state.track.artist}>
                  {state.track.artist}
                </p>
                {state.track.album && (
                  <p className="player__meta" title={state.track.album}>
                    {state.track.album}
                  </p>
                )}
                <p className="player__time">
                  {clock(state.position_ms)} / {clock(state.track.duration_ms)}
                </p>
                {brand && state.track.link && (
                  <a
                    className="player__link"
                    href={state.track.link}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {brand.linkLabel}
                  </a>
                )}
              </div>
            </div>
          ) : (
            <p className="player__text">
              {adapter.activate
                ? `Nothing is playing here. Start something in ${adapter.label} and choose this computer, or press Play.`
                : "Nothing is playing. Ask the assistant for a song."}
            </p>
          )}
          <div className="player__controls">
            {controls.includes("previous") && (
              <button
                type="button"
                className="player__key"
                aria-label="Previous"
                disabled={can ? !can.previous : false}
                onClick={() => void run(() => adapter.previous())}
              >
                <SkipBack size={18} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
            {controls.includes("playPause") && (
              <button
                type="button"
                className="player__key"
                aria-label={playing ? "Pause" : "Play"}
                disabled={can ? !(playing ? can.pause : can.resume) : false}
                onClick={() => void run(() => (playing ? adapter.pause() : adapter.resume()))}
              >
                {playing ? (
                  <Pause size={18} strokeWidth={1.8} aria-hidden="true" />
                ) : (
                  <Play size={18} strokeWidth={1.8} aria-hidden="true" />
                )}
              </button>
            )}
            {controls.includes("next") && (
              <button
                type="button"
                className="player__key"
                aria-label="Next"
                disabled={can ? !can.next : false}
                onClick={() => void run(() => adapter.next())}
              >
                <SkipForward size={18} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
          </div>
          {adapter.signOut && (
            <button
              type="button"
              className="player__quiet"
              onClick={() => void run(() => adapter.signOut!())}
            >
              <LogOut size={14} strokeWidth={1.8} aria-hidden="true" />
              Sign out of {adapter.label}
            </button>
          )}
        </section>
      )}

      {state.message && state.need !== "setup" && (
        <p
          className={`player__note${state.status === "error" ? " player__note--error" : ""}`}
          role="status"
        >
          {state.message}
        </p>
      )}
    </main>
  );
}
