import { useCallback, useEffect, useState } from "react";
import { Check, ExternalLink } from "lucide-react";
import { api } from "../api/PondApiClient";
import { invoke, isDesktopShell } from "../shell";
import { playerView, type PlayerReply } from "./signInView";

/** The page is asked now and then, so a sign-in made there shows up here. */
const POLL_MS = 3_000;

/**
 * How a service is started on its page: signed in there (Apple Music, whose sign-in window may only
 * open from a click on the page), or armed there with Play here after signing in above (Spotify).
 */
export type PlayerPageKind = "sign_in" | "play_here";

/**
 * Where a music service plays: the music player page, which opens in the person's own web browser
 * because that is where the service documents its player running. This row opens the page and says
 * what the page last reported; what has to be done is done on the page itself.
 */
export function PlayerSignIn({
  service,
  label,
  kind = "sign_in",
  disabled = false,
}: {
  service: string;
  label: string;
  kind?: PlayerPageKind;
  disabled?: boolean;
}) {
  const desktop = isDesktopShell();
  const [reply, setReply] = useState<PlayerReply | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setReply(await api.getPlayerState(service));
    } catch {
      // Not being able to ask reads the same as the page not being open.
      setReply(null);
    }
  }, [service]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const view = playerView({ reply, label });
  const url = `${api.serverUrl()}/player.html?service=${encodeURIComponent(service)}`;

  async function open() {
    setError(null);
    try {
      // In the app, `window.open` would open an in-app window; the page belongs in the real browser.
      if (desktop) await invoke("open_external", { url });
      else window.open(url, "_blank", "noopener");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="secret-modal__oauth-block" data-testid={`player-sign-in-${service}`}>
      <p className="secret-modal__oauth-desc">
        {kind === "sign_in"
          ? `${label} plays in the music player, a page that opens in your web browser on this computer. Sign in there.`
          : `${label} plays in its own player page, which opens in your web browser on this computer: sign in above, then press Play ${label} here on that page. You control it by hand there, in the ${label} app, or with the music controls; the assistant never controls ${label}, because its developer rules do not allow that.`}
      </p>

      {view.kind === "signed_in" && (
        <div className="secret-modal__fulfilled-indicator">
          <Check size={13} strokeWidth={2.5} />
          {kind === "sign_in" ? `Signed in to ${label}` : `${label} can play on this computer`}
        </div>
      )}

      <button
        type="button"
        className="secret-modal__oauth-btn"
        onClick={() => void open()}
        disabled={disabled}
      >
        <ExternalLink size={13} strokeWidth={1.8} />
        {kind === "sign_in" ? "Open the music player" : `Open the ${label} player`}
      </button>

      {view.kind !== "signed_in" && <p className="secret-modal__oauth-note">{view.note}</p>}
      {error && <p className="secret-modal__field-error">{error}</p>}
    </div>
  );
}
