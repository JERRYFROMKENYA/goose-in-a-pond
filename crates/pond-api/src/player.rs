//! The player bridge. The music player page, which runs in the person's own browser (the services'
//! SDKs and the browser's DRM live there, not here), listens on `/player/events`; extensions send it
//! commands through `/player/command` and get its reply.
//! Nothing here knows a service: `service` is a label the page's adapter answers to.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use pond_core::shared::services::egress;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

use crate::oauth_callback;
use crate::AppState;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_TIMEOUT: Duration = Duration::from_secs(60);

/// Ops that reach the service's servers. Transport (pause, next, volume) never is refused: a
/// network policy that cannot stop the music that is already playing is a bug, not a policy.
const NETWORK_OPS: &[&str] = &[
    "search",
    "play",
    "enqueue",
    "playlists",
    "library",
    "authorize",
];

/// The host an op reaches for a known service, so `network_mode` can judge it before it is sent.
fn service_host(service: &str) -> Option<&'static str> {
    match service {
        "apple" => Some("https://api.music.apple.com/"),
        "spotify" => Some("https://api.spotify.com/"),
        "tidal" => Some("https://api.tidal.com/"),
        _ => None,
    }
}

pub fn is_service_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 32
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

fn is_op_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 32
        && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
}

/// A page's answer to one command.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub ok: bool,
    pub result: Value,
    pub error: Option<String>,
    pub code: Option<String>,
}

impl Reply {
    fn failure(code: &str, error: &str) -> Self {
        Reply {
            ok: false,
            result: Value::Null,
            error: Some(error.to_string()),
            code: Some(code.to_string()),
        }
    }

    fn into_json(self) -> Value {
        if self.ok {
            json!({ "ok": true, "result": self.result })
        } else {
            json!({ "ok": false, "error": self.error, "code": self.code })
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum DispatchError {
    /// No page is listening for this service.
    NoPlayer,
    /// The page took the command and did not answer in time.
    Timeout,
}

struct Attached {
    generation: u64,
    commands: mpsc::UnboundedSender<Value>,
}

struct Pending {
    service: String,
    reply: oneshot::Sender<Reply>,
}

/// Who is listening, what they were asked, and what they last said about themselves.
#[derive(Default)]
pub struct PlayerBridge {
    attached: Mutex<HashMap<String, Attached>>,
    pending: Mutex<HashMap<String, Pending>>,
    states: Mutex<HashMap<String, Value>>,
    generations: AtomicU64,
}

impl PlayerBridge {
    /// One page per service: a newer one replaces the older, whose calls in flight fail at once
    /// rather than wait out a timeout for an answer that can no longer come.
    pub fn attach(&self, service: &str) -> (u64, mpsc::UnboundedReceiver<Value>) {
        let generation = self.generations.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::unbounded_channel();
        let replaced = self.attached.lock().unwrap().insert(
            service.to_string(),
            Attached {
                generation,
                commands: tx,
            },
        );
        if replaced.is_some() {
            self.fail_pending(
                service,
                "player_replaced",
                "The player was reopened; ask again.",
            );
        }
        (generation, rx)
    }

    /// Removes the page only if it is still the one that attached: a slow close of an old stream
    /// must not evict its replacement.
    pub fn detach(&self, service: &str, generation: u64) {
        let mut attached = self.attached.lock().unwrap();
        if attached
            .get(service)
            .is_some_and(|a| a.generation == generation)
        {
            attached.remove(service);
            drop(attached);
            self.fail_pending(
                service,
                "player_gone",
                "The player closed before it answered.",
            );
            self.states.lock().unwrap().remove(service);
        }
    }

    pub fn is_attached(&self, service: &str) -> bool {
        self.attached.lock().unwrap().contains_key(service)
    }

    pub fn attached_services(&self) -> Vec<String> {
        let mut services: Vec<String> = self.attached.lock().unwrap().keys().cloned().collect();
        services.sort();
        services
    }

    fn fail_pending(&self, service: &str, code: &str, error: &str) {
        let mut pending = self.pending.lock().unwrap();
        let ids: Vec<String> = pending
            .iter()
            .filter(|(_, p)| p.service == service)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(p) = pending.remove(&id) {
                let _ = p.reply.send(Reply::failure(code, error));
            }
        }
    }

    /// Sends `op` to the page and waits for its reply.
    pub async fn dispatch(
        &self,
        service: &str,
        op: &str,
        args: Value,
        timeout: Duration,
    ) -> Result<Reply, DispatchError> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(
            id.clone(),
            Pending {
                service: service.to_string(),
                reply: tx,
            },
        );

        let sent = {
            let attached = self.attached.lock().unwrap();
            attached.get(service).is_some_and(|a| {
                a.commands
                    .send(json!({ "id": id, "service": service, "op": op, "args": args }))
                    .is_ok()
            })
        };
        if !sent {
            self.pending.lock().unwrap().remove(&id);
            return Err(DispatchError::NoPlayer);
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply)) => Ok(reply),
            _ => {
                self.pending.lock().unwrap().remove(&id);
                Err(DispatchError::Timeout)
            }
        }
    }

    /// Delivers a page's answer; false when nobody is waiting (it came too late, or twice).
    pub fn reply(&self, id: &str, reply: Reply) -> bool {
        match self.pending.lock().unwrap().remove(id) {
            Some(p) => p.reply.send(reply).is_ok(),
            None => false,
        }
    }

    pub fn set_state(&self, service: &str, state: Value) {
        self.states
            .lock()
            .unwrap()
            .insert(service.to_string(), state);
    }

    pub fn state(&self, service: &str) -> Option<Value> {
        self.states.lock().unwrap().get(service).cloned()
    }
}

static BRIDGE: OnceLock<Arc<PlayerBridge>> = OnceLock::new();

pub fn bridge() -> &'static Arc<PlayerBridge> {
    BRIDGE.get_or_init(|| Arc::new(PlayerBridge::default()))
}

pub(crate) fn json_error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

fn is_internal_caller(headers: &HeaderMap) -> bool {
    matches!(
        crate::middleware::extract_bearer_token(headers),
        Ok(token) if token == oauth_callback::internal_extension_token()
    )
}

fn unauthorised() -> Response {
    json_error(
        StatusCode::UNAUTHORIZED,
        "Invalid or missing internal token",
    )
}

/// Removes the page from the bridge when its stream ends, however it ends.
struct DetachOnDrop {
    service: String,
    generation: u64,
}

impl Drop for DetachOnDrop {
    fn drop(&mut self) {
        bridge().detach(&self.service, self.generation);
    }
}

#[derive(Deserialize)]
pub struct ServiceQuery {
    #[serde(default)]
    service: String,
}

/// `GET /api/v1/player/events?service=` -- the page's command stream (server-sent events).
pub async fn events_handler(
    Query(q): Query<ServiceQuery>,
) -> Result<Sse<impl futures::Stream<Item = Result<SseEvent, Infallible>>>, Response> {
    if !is_service_name(&q.service) {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Expected ?service=<name>.",
        ));
    }
    let service = q.service;
    let (generation, mut commands) = bridge().attach(&service);
    let guard = DetachOnDrop {
        service: service.clone(),
        generation,
    };

    let stream = async_stream::stream! {
        let _guard = guard;
        yield Ok(SseEvent::default().event("ready").data(json!({ "service": service }).to_string()));
        while let Some(command) = commands.recv().await {
            yield Ok(SseEvent::default().event("command").data(command.to_string()));
        }
    };
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

#[derive(Deserialize)]
pub struct ReplyBody {
    id: String,
    ok: bool,
    #[serde(default)]
    result: Value,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    code: Option<String>,
}

/// `POST /api/v1/player/reply` -- the page answers a command.
pub async fn reply_handler(body: Result<Json<ReplyBody>, JsonRejection>) -> Response {
    let Ok(Json(b)) = body else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Expected {id, ok, result?, error?, code?}.",
        );
    };
    let accepted = bridge().reply(
        &b.id,
        Reply {
            ok: b.ok,
            result: b.result,
            error: b.error,
            code: b.code,
        },
    );
    Json(json!({ "accepted": accepted })).into_response()
}

#[derive(Deserialize)]
pub struct StateBody {
    service: String,
    state: Value,
}

/// `POST /api/v1/player/state` -- the page reports what is playing.
pub async fn post_state_handler(body: Result<Json<StateBody>, JsonRejection>) -> Response {
    let Ok(Json(b)) = body else {
        return json_error(StatusCode::BAD_REQUEST, "Expected {service, state}.");
    };
    if !is_service_name(&b.service) || !bridge().is_attached(&b.service) {
        return json_error(
            StatusCode::CONFLICT,
            "No player is attached for that service.",
        );
    }
    bridge().set_state(&b.service, b.state);
    Json(json!({})).into_response()
}

/// `GET /api/v1/player/state?service=` -- the last state the page reported.
pub async fn get_state_handler(Query(q): Query<ServiceQuery>) -> Response {
    if !is_service_name(&q.service) {
        return json_error(StatusCode::BAD_REQUEST, "Expected ?service=<name>.");
    }
    Json(json!({
        "attached": bridge().is_attached(&q.service),
        "state": bridge().state(&q.service),
    }))
    .into_response()
}

/// Whether the household has signed in to Spotify: a token is stored. Says nothing of whether it
/// still works; the page reports that when it asks.
async fn spotify_has_token(state: &AppState) -> bool {
    let Some(repo) = &state.secret_repo else {
        return false;
    };
    let providers = pond_core::user_data::services::oauth_providers::builtin_oauth_providers();
    let Some(provider) = providers.iter().find(|p| p.id == "spotify") else {
        return false;
    };
    matches!(repo.get(&provider.token_key).await, Ok(Some(t)) if !t.is_empty())
}

/// `GET /api/v1/player/status` -- which services have a page and which have credentials.
pub async fn status_handler(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !is_internal_caller(&headers) {
        return unauthorised();
    }
    let mut services: Vec<String> = vec!["apple".to_string(), "spotify".to_string()];
    for s in bridge().attached_services() {
        if !services.contains(&s) {
            services.push(s);
        }
    }

    let apple_configured = match &state.secret_repo {
        Some(repo) => crate::musickit::has_token_source(repo.as_ref()).await,
        None => false,
    };
    let spotify_configured = spotify_has_token(&state).await;
    let mut out = serde_json::Map::new();
    for s in services {
        let configured = match s.as_str() {
            "apple" => apple_configured,
            "spotify" => spotify_configured,
            _ => true,
        };
        out.insert(
            s.clone(),
            json!({ "attached": bridge().is_attached(&s), "configured": configured }),
        );
    }
    Json(Value::Object(out)).into_response()
}

#[derive(Deserialize)]
pub struct UserTokenQuery {
    service: String,
    /// Ask the service for a new token first: the SDK asks again when the last one stopped working.
    #[serde(default)]
    refresh: bool,
}

const SPOTIFY_NOT_CONNECTED: &str =
    "Spotify is not connected: sign in to Spotify in the Music extension's settings.";

/// `GET /api/v1/player/user-token?service=spotify[&refresh=true]` -- the page's access token for
/// a service whose SDK signs in with the person's own token, not a developer key. For the paired
/// page only: an extension holds the internal token, which is not a session and is refused here by
/// the same rule as the developer token. Renewal goes through the same gate as every other
/// outbound call, so `network_mode = offline` refuses it and the page says so.
pub async fn user_token_handler(
    State(state): State<Arc<AppState>>,
    Query(q): Query<UserTokenQuery>,
) -> Response {
    if q.service != "spotify" {
        return json_error(
            StatusCode::BAD_REQUEST,
            "That service does not sign in with a user token.",
        );
    }
    let Some(repo) = &state.secret_repo else {
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Secret storage not available",
        );
    };
    if !spotify_has_token(&state).await {
        return json_error(StatusCode::BAD_REQUEST, SPOTIFY_NOT_CONNECTED);
    }

    if q.refresh {
        return match crate::routes::refresh_spotify_access_token(&state).await {
            Some(token) => Json(json!({ "token": token })).into_response(),
            None => json_error(
                StatusCode::BAD_GATEWAY,
                "Spotify would not renew the sign-in. Sign in to Spotify again in the Music \
                 extension's settings, or check the network setting.",
            ),
        };
    }

    let providers = pond_core::user_data::services::oauth_providers::builtin_oauth_providers();
    let stored = match providers.iter().find(|p| p.id == "spotify") {
        Some(p) => repo.get(&p.token_key).await.ok().flatten(),
        None => None,
    };
    match stored {
        Some(token) => Json(json!({ "token": token })).into_response(),
        None => json_error(StatusCode::BAD_REQUEST, SPOTIFY_NOT_CONNECTED),
    }
}

#[derive(Deserialize)]
pub struct CommandBody {
    service: String,
    op: String,
    #[serde(default)]
    args: Value,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

/// `POST /api/v1/player/command` -- an extension asks the page to do something and waits.
/// Failures the caller can act on come back as `{ok:false, code, error}` with status 200; the
/// status codes are for a malformed or unauthorised request.
pub async fn command_handler(
    headers: HeaderMap,
    body: Result<Json<CommandBody>, JsonRejection>,
) -> Response {
    if !is_internal_caller(&headers) {
        return unauthorised();
    }
    let Ok(Json(cmd)) = body else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Expected {service, op, args?, timeout_ms?}.",
        );
    };
    if !is_service_name(&cmd.service) || !is_op_name(&cmd.op) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "service and op must be short lowercase names.",
        );
    }

    if NETWORK_OPS.contains(&cmd.op.as_str()) {
        if let Some(url) = service_host(&cmd.service) {
            let tool = format!("giap-music-{}", cmd.service);
            if let Err(denied) = egress::check_egress_for(url, &tool, &egress::current_session_id())
            {
                return Json(Reply::failure("refused", &denied.to_string()).into_json())
                    .into_response();
            }
        }
    }

    let timeout = cmd
        .timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_TIMEOUT)
        .min(MAX_TIMEOUT);
    let reply = match bridge()
        .dispatch(&cmd.service, &cmd.op, cmd.args, timeout)
        .await
    {
        Ok(reply) => reply,
        Err(DispatchError::NoPlayer) => Reply::failure(
            "no_player",
            "The music player is not open. Open it from the Music extension's settings: it is a page \
             in your web browser on the pond's computer.",
        ),
        Err(DispatchError::Timeout) => Reply::failure(
            "timeout",
            "The music player did not answer in time. It may be waiting for you to sign in.",
        ),
    };
    Json(reply.into_json()).into_response()
}

#[derive(Deserialize)]
pub struct EgressRequest {
    url: String,
    #[serde(default)]
    method: Option<String>,
    extension: String,
}

/// Bounded labels, so a caller cannot mint arbitrary event attribute values.
fn method_label(method: Option<&str>) -> &'static str {
    match method.map(str::to_ascii_uppercase).as_deref() {
        None | Some("GET") => "GET",
        Some("POST") => "POST",
        Some("PUT") => "PUT",
        Some("PATCH") => "PATCH",
        Some("DELETE") => "DELETE",
        Some("HEAD") => "HEAD",
        Some(_) => "OTHER",
    }
}

fn is_extension_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn verdict(url: &str, method: Option<&str>, tool: &str) -> Value {
    // Passed explicitly: the process-global current tool belongs to whatever else is in flight.
    let session_id = egress::current_session_id();
    match egress::check_egress_for(url, tool, &session_id) {
        Ok(()) => {
            egress::record_egress_for(url, method_label(method), tool, &session_id, None, 0);
            json!({ "allowed": true })
        }
        Err(denied) => json!({ "allowed": false, "reason": denied.to_string() }),
    }
}

/// `POST /api/v1/extension/egress` -- asks, before an extension's own outbound call, whether the
/// network mode allows it, and records it in the egress log attributed to `giap-<extension>`.
pub async fn extension_egress_handler(
    headers: HeaderMap,
    body: Result<Json<EgressRequest>, JsonRejection>,
) -> Response {
    if !is_internal_caller(&headers) {
        return unauthorised();
    }
    let request = match body {
        Ok(Json(r)) if r.url.contains("://") && is_extension_name(&r.extension) => r,
        _ => return json_error(
            StatusCode::BAD_REQUEST,
            "Expected {\"url\": \"https://...\", \"method\": \"GET\", \"extension\": \"<id>\"}.",
        ),
    };
    let tool = format!("giap-{}", request.extension);
    Json(verdict(&request.url, request.method.as_deref(), &tool)).into_response()
}

#[derive(Deserialize)]
pub struct PolicyRequest {
    url: String,
    #[serde(default)]
    method: Option<String>,
}

/// `POST /api/v1/player/egress-policy` -- the player page asks, before it loads a service's script,
/// whether the network setting allows it. Loopback only, and untokened.
pub async fn player_egress_handler(body: Result<Json<PolicyRequest>, JsonRejection>) -> Response {
    let request = match body {
        Ok(Json(r)) if r.url.contains("://") => r,
        _ => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "Expected {\"url\": \"https://...\", \"method\": \"GET\"}.",
            )
        }
    };
    Json(verdict(
        &request.url,
        request.method.as_deref(),
        "giap-player",
    ))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHORT: Duration = Duration::from_millis(150);

    #[tokio::test]
    async fn a_command_reaches_the_page_and_its_reply_comes_back() {
        let bridge = PlayerBridge::default();
        let (_, mut page) = bridge.attach("apple");

        let call = bridge.dispatch(
            "apple",
            "play",
            json!({ "id": "1" }),
            Duration::from_secs(2),
        );
        let answer = async {
            let cmd = page.recv().await.unwrap();
            assert_eq!(cmd["op"], "play");
            assert_eq!(cmd["args"]["id"], "1");
            assert_eq!(cmd["service"], "apple");
            let id = cmd["id"].as_str().unwrap().to_string();
            assert!(bridge.reply(
                &id,
                Reply {
                    ok: true,
                    result: json!({ "playing": true }),
                    error: None,
                    code: None
                }
            ));
        };
        let (reply, ()) = tokio::join!(call, answer);

        assert_eq!(reply.unwrap().result["playing"], true);
    }

    #[tokio::test]
    async fn no_page_means_no_player_and_nothing_is_left_waiting() {
        let bridge = PlayerBridge::default();
        assert_eq!(
            bridge.dispatch("apple", "play", Value::Null, SHORT).await,
            Err(DispatchError::NoPlayer)
        );
        assert!(bridge.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_page_that_never_answers_times_out_and_is_forgotten() {
        let bridge = PlayerBridge::default();
        let (_, _page) = bridge.attach("apple");
        assert_eq!(
            bridge.dispatch("apple", "play", Value::Null, SHORT).await,
            Err(DispatchError::Timeout)
        );
        assert!(bridge.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_late_or_repeated_reply_is_refused() {
        let bridge = PlayerBridge::default();
        let (_, mut page) = bridge.attach("apple");
        let _ = bridge.dispatch("apple", "play", Value::Null, SHORT).await;
        let cmd = page.recv().await.unwrap();
        let id = cmd["id"].as_str().unwrap();
        let ok = Reply {
            ok: true,
            result: Value::Null,
            error: None,
            code: None,
        };
        assert!(!bridge.reply(id, ok.clone()), "it timed out already");
        assert!(!bridge.reply("never-issued", ok));
    }

    #[tokio::test]
    async fn reopening_the_player_fails_the_calls_it_orphaned() {
        let bridge = Arc::new(PlayerBridge::default());
        let (_, _first) = bridge.attach("apple");

        let waiting = {
            let bridge = bridge.clone();
            tokio::spawn(async move {
                bridge
                    .dispatch("apple", "play", Value::Null, Duration::from_secs(5))
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        let (_, _second) = bridge.attach("apple");

        let reply = waiting.await.unwrap().unwrap();
        assert_eq!(reply.code.as_deref(), Some("player_replaced"));
    }

    #[test]
    fn a_stale_detach_does_not_evict_the_page_that_replaced_it() {
        let bridge = PlayerBridge::default();
        let (old, _a) = bridge.attach("apple");
        let (_new, _b) = bridge.attach("apple");

        bridge.detach("apple", old);

        assert!(
            bridge.is_attached("apple"),
            "the newer page must survive the older one closing"
        );
    }

    #[test]
    fn detaching_the_current_page_forgets_it_and_its_state() {
        let bridge = PlayerBridge::default();
        let (generation, _page) = bridge.attach("apple");
        bridge.set_state("apple", json!({ "playing": true }));

        bridge.detach("apple", generation);

        assert!(!bridge.is_attached("apple"));
        assert_eq!(
            bridge.state("apple"),
            None,
            "a closed player has no now-playing"
        );
    }

    #[test]
    fn services_are_kept_apart() {
        let bridge = PlayerBridge::default();
        let (_, _apple) = bridge.attach("apple");
        assert!(!bridge.is_attached("tidal"));
        bridge.set_state("apple", json!({ "n": 1 }));
        assert_eq!(bridge.state("tidal"), None);
    }

    #[test]
    fn names_are_bounded() {
        assert!(
            is_service_name("apple") && is_service_name("tidal-hifi") && is_service_name("a_1")
        );
        assert!(!is_service_name("") && !is_service_name("Apple") && !is_service_name("a b"));
        assert!(!is_service_name(&"a".repeat(33)));
        assert!(is_op_name("play") && is_op_name("set_volume"));
        assert!(!is_op_name("") && !is_op_name("play2") && !is_op_name("Play"));
    }

    #[test]
    fn egress_labels_are_bounded() {
        assert_eq!(method_label(None), "GET");
        assert_eq!(method_label(Some("post")), "POST");
        assert_eq!(method_label(Some("PROPFIND")), "OTHER");
        assert!(is_extension_name("music"));
        assert!(!is_extension_name("") && !is_extension_name("music\nx"));
        assert!(!is_extension_name(&"a".repeat(65)));
    }

    #[test]
    fn only_network_ops_are_judged_and_transport_never_is() {
        for op in [
            "pause", "resume", "next", "previous", "seek", "volume", "state",
        ] {
            assert!(
                !NETWORK_OPS.contains(&op),
                "{op} must work under any network mode"
            );
        }
        for op in ["search", "play", "enqueue"] {
            assert!(NETWORK_OPS.contains(&op));
        }
    }
}
