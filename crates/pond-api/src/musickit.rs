//! Apple Music developer tokens for the player page, which asks and never sees a key. A token comes
//! from one of two places: a key the household stored here (signed locally, and it wins), or the
//! pondcredentials service (`services/pondcredentials`), which holds Jarida's key so a household needs
//! none. Signing is `pond-apple-token`, shared with that service so the two cannot drift.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use pond_core::security::ports::secret::SecretRepository;
use pond_core::shared::services::egress;
use serde::{Deserialize, Serialize};
use serde_json::json;

pub use pond_apple_token::{normalize_private_key, SigningCredentials};

use crate::player::json_error;
use crate::AppState;

pub const TEAM_ID_KEY: &str = "APPLE_MUSIC_TEAM_ID";
pub const KEY_ID_KEY: &str = "APPLE_MUSIC_KEY_ID";
pub const PRIVATE_KEY_KEY: &str = "APPLE_MUSIC_PRIVATE_KEY";

/// The player page holds a token for as long as its window lives, and a token that lapses mid-song
/// ends the music; Apple's own ceiling is about six months.
pub const DEVELOPER_TOKEN_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Where managed tokens come from. Unset means the built-in address below; `off` (or empty) turns
/// managed mode off, and any other value is used in place of the built-in address.
pub const MANAGED_URL_ENV: &str = "POND_CREDENTIALS_URL";
/// Jarida's credentials service (`docs/architecture/pondcredentials.md`), which every pond without a
/// key of its own asks for an Apple Music developer token. A test or a scratch pond must say `off`, or
/// it phones home.
const DEFAULT_MANAGED_URL: Option<&str> = Some("https://credentials.jarida.io");
/// The name a fetch is filed under in the egress log, so a person can see the pond called home.
const MANAGED_TOOL: &str = "giap-credentials";

const NOT_SET_UP: &str = "Apple Music sign-in is not available on this pond yet: no shared \
                          credentials are set up. To use your own, add your Apple Music Team ID, Key ID \
                          and private key under Developer settings in the Music extension.";

async fn stored(repo: &dyn SecretRepository, key: &str) -> Option<String> {
    repo.get(key)
        .await
        .ok()
        .flatten()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

async fn stored_credentials(repo: &dyn SecretRepository) -> Option<SigningCredentials> {
    Some(SigningCredentials {
        team_id: stored(repo, TEAM_ID_KEY).await?,
        key_id: stored(repo, KEY_ID_KEY).await?,
        private_key: stored(repo, PRIVATE_KEY_KEY).await?,
    })
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ── The managed source ───────────────────────────────────────

/// The credentials service's address from a setting, or None when managed mode is off or the
/// address is not one to send a request to. https only, apart from loopback, which is how it is
/// developed and tested: a plain-http credential fetch over a network would be its own leak.
pub fn managed_url_from(raw: Option<&str>) -> Option<String> {
    let url = raw?.trim().trim_end_matches('/');
    if url.is_empty() || url.eq_ignore_ascii_case("off") {
        return None;
    }
    let loopback = ["http://127.0.0.1", "http://localhost", "http://[::1]"]
        .iter()
        .any(|p| {
            url == *p || url.starts_with(&format!("{p}:")) || url.starts_with(&format!("{p}/"))
        });
    if url.starts_with("https://") || loopback {
        Some(url.to_string())
    } else {
        tracing::warn!("ignoring {MANAGED_URL_ENV}: it must be an https address");
        None
    }
}

pub fn managed_url() -> Option<String> {
    let set = std::env::var(MANAGED_URL_ENV).ok();
    managed_url_from(set.as_deref().or(DEFAULT_MANAGED_URL))
}

#[derive(Clone)]
struct Cached {
    token: String,
    expires_at: u64,
    fetched_at: u64,
}

impl Cached {
    /// Time to fetch again: a fifth of its life is left, or under a day. A pond then fetches about
    /// once a month and always holds a token with weeks on it. The token is kept in the secret store
    /// and read once per start, so a restart does not ask again while it is still good.
    fn due(&self, now: u64) -> bool {
        let life = self.expires_at.saturating_sub(self.fetched_at);
        let left = self.expires_at.saturating_sub(now);
        left * 5 < life || left < 86_400
    }
}

/// Where the managed token is kept between starts, so a pond that restarts does not ask again for a
/// token it still holds. Not a secret: a developer token is public by design, since every MusicKit page
/// carries one, and `GET /secrets` lists key names and never values. The secret store is simply the
/// durable place this crate already has.
pub const MANAGED_TOKEN_KEY: &str = "APPLE_MUSIC_MANAGED_TOKEN";

/// What is written under [`MANAGED_TOKEN_KEY`]. The address is part of it, so a pond pointed at another
/// service never serves the token of the last one.
#[derive(Serialize, Deserialize)]
struct Persisted {
    url: String,
    token: String,
    expires_at: u64,
    fetched_at: u64,
}

impl Persisted {
    fn of(base: &str, c: &Cached) -> Persisted {
        Persisted {
            url: base.to_string(),
            token: c.token.clone(),
            expires_at: c.expires_at,
            fetched_at: c.fetched_at,
        }
    }

    /// The token held, if what was stored is for this service and would still be accepted from it:
    /// anything else (another address, damaged text, a lapsed or implausible expiry) is ignored, and
    /// the pond simply asks.
    fn read(raw: &str, base: &str, now: u64) -> Option<Cached> {
        let p: Persisted = serde_json::from_str(raw).ok()?;
        if p.url != base || accept(&p.token, p.expires_at, now).is_err() {
            return None;
        }
        Some(Cached {
            token: p.token,
            expires_at: p.expires_at,
            fetched_at: p.fetched_at.min(now),
        })
    }
}

#[derive(Default)]
struct Slot {
    /// Whether the stored token has been looked at yet: it is read once per start, not per request.
    loaded: bool,
    cached: Option<Cached>,
    /// When the last fetch failed, and why, so a service that is down is asked once a minute and
    /// not on every retry the player makes.
    failed: Option<(u64, String)>,
}

/// How long a failed fetch stands before another is tried.
const FAILURE_STANDS: u64 = 60;
/// Apple's ceiling is 182 days; a service claiming more is not to be believed.
const MAX_CLAIMED_LIFE: u64 = 200 * 86_400;

static MANAGED: OnceLock<tokio::sync::Mutex<HashMap<String, Slot>>> = OnceLock::new();

/// A well-formed JWT and an expiry that could be Apple's. The service is Jarida's, but a reply is
/// still input: it goes into a page, and into a request header at Apple.
fn accept(token: &str, expires_at: u64, now: u64) -> Result<(), String> {
    let parts: Vec<&str> = token.split('.').collect();
    let jwt_shaped = parts.len() == 3
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        });
    if !jwt_shaped || token.len() > 4096 {
        return Err("the credentials service returned something that is not a token".into());
    }
    if expires_at <= now + 60 || expires_at > now + MAX_CLAIMED_LIFE {
        return Err("the credentials service returned a token with an impossible expiry".into());
    }
    Ok(())
}

async fn fetch_managed(client: &reqwest::Client, base: &str, now: u64) -> Result<Cached, String> {
    let url = format!("{base}/v1/musickit/developer-token");
    // The gate first: under `network_mode = offline` this is refused and nothing is sent.
    let call = egress::begin_as(&url, "POST", MANAGED_TOOL).map_err(|denied| denied.to_string())?;

    let sent = client
        .post(&url)
        .timeout(Duration::from_secs(10))
        .send()
        .await;
    call.finish(sent.as_ref().ok().map(|r| r.status().as_u16()));

    let resp = sent.map_err(|_| "the credentials service could not be reached".to_string())?;
    match resp.status() {
        s if s.is_success() => {}
        StatusCode::TOO_MANY_REQUESTS => {
            return Err("the credentials service is busy; try again shortly".into())
        }
        s => return Err(format!("the credentials service answered {}", s.as_u16())),
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|_| "the credentials service returned something unreadable".to_string())?;
    let token = body["token"].as_str().unwrap_or_default().to_string();
    let expires_at = body["expires_at"].as_u64().unwrap_or(0);
    accept(&token, expires_at, now)?;
    Ok(Cached {
        token,
        expires_at,
        fetched_at: now,
    })
}

/// A token from the credentials service at `base`: the cached one while it has life to spare, a
/// fresh fetch when it is due, and the cached one still if a refresh fails but it has not expired.
pub async fn managed_token(
    client: &reqwest::Client,
    base: &str,
    now: u64,
    store: Option<&dyn SecretRepository>,
) -> Result<(String, u64), String> {
    let mut slots = MANAGED.get_or_init(Default::default).lock().await;
    let slot = slots.entry(base.to_string()).or_default();

    // The first ask after a start reads what an earlier start stored, so a token with weeks left is
    // served with no network at all.
    if !slot.loaded {
        slot.loaded = true;
        if slot.cached.is_none() {
            if let Some(store) = store {
                if let Ok(Some(raw)) = store.get(MANAGED_TOKEN_KEY).await {
                    slot.cached = Persisted::read(&raw, base, now);
                }
            }
        }
    }

    if let Some(c) = &slot.cached {
        if !c.due(now) {
            return Ok((c.token.clone(), c.expires_at));
        }
    }
    if let Some((at, why)) = &slot.failed {
        if now.saturating_sub(*at) < FAILURE_STANDS {
            return match slot.cached.as_ref().filter(|c| c.expires_at > now + 60) {
                Some(c) => Ok((c.token.clone(), c.expires_at)),
                None => Err(why.clone()),
            };
        }
    }

    match fetch_managed(client, base, now).await {
        Ok(fresh) => {
            slot.failed = None;
            let out = (fresh.token.clone(), fresh.expires_at);
            if let Some(store) = store {
                // Failing to keep it costs a fetch at the next start and nothing else.
                if let Ok(raw) = serde_json::to_string(&Persisted::of(base, &fresh)) {
                    if let Err(error) = store.set(MANAGED_TOKEN_KEY, &raw).await {
                        tracing::debug!(%error, "could not keep the Apple Music token for the next start");
                    }
                }
            }
            slot.cached = Some(fresh);
            Ok(out)
        }
        Err(why) => {
            slot.failed = Some((now, why.clone()));
            match slot.cached.as_ref().filter(|c| c.expires_at > now + 60) {
                Some(c) => {
                    tracing::warn!(reason = %why, "could not refresh the Apple Music token; using the one held");
                    Ok((c.token.clone(), c.expires_at))
                }
                None => Err(why),
            }
        }
    }
}

/// Forgets what this process holds in memory, as a restart would, leaving the stored token alone.
/// For tests: a pond never needs it.
#[doc(hidden)]
pub async fn forget_managed_memory() {
    if let Some(slots) = MANAGED.get() {
        slots.lock().await.clear();
    }
}

// ── The route ────────────────────────────────────────────────

/// Whether a token can be had at all: a stored key, or the credentials service is on. Says nothing
/// of whether either works; the player reports that when it asks.
pub async fn has_token_source(repo: &dyn SecretRepository) -> bool {
    stored_credentials(repo).await.is_some() || managed_url().is_some()
}

#[derive(Deserialize, Default)]
pub struct TokenQuery {
    /// Only ask whether a token could be had. Never signs, never reaches the network, so a page can
    /// find out whether Apple Music is possible without starting anything.
    #[serde(default)]
    probe: bool,
}

/// `GET /api/v1/musickit/developer-token` -- the player page's developer token. With `?probe=true`
/// it answers `{available: true}` or says what is missing, and does nothing else.
pub async fn developer_token_handler(
    State(state): State<Arc<AppState>>,
    Query(q): Query<TokenQuery>,
) -> Response {
    let Some(repo) = &state.secret_repo else {
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Secret storage not available",
        );
    };

    if q.probe {
        return if has_token_source(repo.as_ref()).await {
            Json(json!({ "available": true })).into_response()
        } else {
            json_error(StatusCode::BAD_REQUEST, NOT_SET_UP)
        };
    }

    // A key the household stored beats the shared one: it is theirs, and needs no network.
    if let Some(credentials) = stored_credentials(repo.as_ref()).await {
        return match credentials.sign(now_secs(), DEVELOPER_TOKEN_TTL) {
            Ok((token, expires_at)) => {
                Json(json!({ "token": token, "expires_at": expires_at })).into_response()
            }
            Err(reason) => json_error(StatusCode::BAD_REQUEST, reason),
        };
    }

    match managed_url() {
        Some(base) => {
            match managed_token(&state.http_client, &base, now_secs(), Some(repo.as_ref())).await {
                Ok((token, expires_at)) => {
                    Json(json!({ "token": token, "expires_at": expires_at })).into_response()
                }
                Err(reason) => json_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    format!("Apple Music could not get its sign-in token: {reason}."),
                ),
            }
        }
        None => json_error(StatusCode::BAD_REQUEST, NOT_SET_UP),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored(url: &str, expires_at: u64, fetched_at: u64, token: &str) -> String {
        serde_json::to_string(&Persisted {
            url: url.into(),
            token: token.into(),
            expires_at,
            fetched_at,
        })
        .unwrap()
    }

    #[test]
    fn a_stored_token_is_read_back_when_it_is_for_this_service_and_still_good() {
        let now = 1_000_000;
        let raw = stored(
            "https://c.example",
            now + 20 * 86_400,
            now - 10 * 86_400,
            "aaaa.bbbb.cccc",
        );
        let c = Persisted::read(&raw, "https://c.example", now).expect("still good");
        assert_eq!(c.token, "aaaa.bbbb.cccc");
        assert_eq!(c.expires_at, now + 20 * 86_400);
        assert_eq!(c.fetched_at, now - 10 * 86_400);
    }

    #[test]
    fn a_stored_token_is_ignored_when_anything_about_it_is_wrong() {
        let now = 1_000_000;
        let good = |url: &str, exp: u64, tok: &str| stored(url, exp, now - 86_400, tok);
        for (label, raw) in [
            (
                "another address",
                good("https://other.example", now + 86_400 * 20, "aaaa.bbbb.cccc"),
            ),
            (
                "expired",
                good("https://c.example", now - 1, "aaaa.bbbb.cccc"),
            ),
            (
                "about to expire",
                good("https://c.example", now + 30, "aaaa.bbbb.cccc"),
            ),
            (
                "a claimed life no service would give",
                good("https://c.example", now + 86_400 * 900, "aaaa.bbbb.cccc"),
            ),
            (
                "not a token",
                good("https://c.example", now + 86_400 * 20, "<script>"),
            ),
            ("damaged", "{\"url\": ".to_string()),
            ("empty", String::new()),
        ] {
            assert!(
                Persisted::read(&raw, "https://c.example", now).is_none(),
                "{label} must not be served"
            );
        }
    }

    #[test]
    fn a_stored_fetch_time_cannot_be_in_the_future() {
        // A clock that moved back would otherwise make a token look fresher than it is.
        let now = 1_000_000;
        let raw = stored(
            "https://c.example",
            now + 20 * 86_400,
            now + 5 * 86_400,
            "aaaa.bbbb.cccc",
        );
        let c = Persisted::read(&raw, "https://c.example", now).unwrap();
        assert_eq!(c.fetched_at, now);
    }

    #[test]
    fn the_built_in_address_is_jaridas_service_over_https() {
        // A change here changes what every pond without its own key does, so it is pinned.
        assert_eq!(DEFAULT_MANAGED_URL, Some("https://credentials.jarida.io"));
        assert_eq!(
            managed_url_from(DEFAULT_MANAGED_URL).as_deref(),
            Some("https://credentials.jarida.io"),
            "the built-in address must survive the same checks a configured one does"
        );
    }

    #[test]
    fn the_service_address_must_be_https_apart_from_loopback() {
        for ok in [
            "https://credentials.example.org",
            "https://credentials.example.org/",
            "http://127.0.0.1:8080",
            "http://localhost:8080/",
            "http://[::1]:8080",
        ] {
            assert!(
                managed_url_from(Some(ok)).is_some(),
                "{ok} should be accepted"
            );
        }
        for refused in [
            "http://credentials.example.org",
            "http://127.0.0.1.evil.example",
            "http://localhost.evil.example",
            "ftp://credentials.example.org",
            "credentials.example.org",
        ] {
            assert_eq!(
                managed_url_from(Some(refused)),
                None,
                "{refused} must be refused"
            );
        }
    }

    #[test]
    fn unset_empty_and_off_all_mean_off() {
        for off in [None, Some(""), Some("  "), Some("off"), Some("OFF")] {
            assert_eq!(managed_url_from(off), None, "{off:?}");
        }
    }

    #[test]
    fn a_trailing_slash_does_not_reach_the_request() {
        assert_eq!(
            managed_url_from(Some("https://credentials.example.org///")).as_deref(),
            Some("https://credentials.example.org")
        );
    }

    #[test]
    fn a_token_is_refetched_with_a_fifth_of_its_life_left_and_not_before() {
        let day = 86_400;
        let token = Cached {
            token: "t".into(),
            fetched_at: 0,
            expires_at: 30 * day,
        };
        assert!(!token.due(0));
        assert!(
            !token.due(23 * day),
            "24 days of 30 gone, 6 left: still fine"
        );
        assert!(token.due(25 * day), "5 days left is under a fifth");
        assert!(
            token.due(29 * day + 1),
            "and under a day left is always due"
        );
    }

    #[test]
    fn a_short_lived_token_is_due_when_a_day_is_left_whatever_its_share() {
        let token = Cached {
            token: "t".into(),
            fetched_at: 0,
            expires_at: 3 * 86_400,
        };
        assert!(!token.due(86_400));
        assert!(token.due(2 * 86_400 + 1));
    }

    #[test]
    fn a_reply_is_checked_before_it_goes_into_a_page() {
        let now = 1_790_000_000;
        let good = "aaaa.bbbb.cccc";
        assert!(accept(good, now + 30 * 86_400, now).is_ok());
        for bad in [
            "",
            "one.two",
            "a.b.c.d",
            "a..c",
            "has space.b.c",
            "<script>.b.c",
        ] {
            assert!(accept(bad, now + 30 * 86_400, now).is_err(), "{bad:?}");
        }
        assert!(accept(good, now, now).is_err(), "already expired");
        assert!(accept(good, now + 30, now).is_err(), "about to expire");
        assert!(
            accept(good, now + 400 * 86_400, now).is_err(),
            "longer than Apple allows"
        );
        assert!(
            accept(&format!("{}.b.c", "a".repeat(5000)), now + 86_400 * 30, now).is_err(),
            "absurdly long"
        );
    }
}
