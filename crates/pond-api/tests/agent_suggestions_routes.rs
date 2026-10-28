//! Suggested agents: which cards a member sees, turning one on, declining one, and who owns the
//! copy when the desktop saves it.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use pond_api::build_router;
use pond_core::user_data::domain::profile::CreateProfileRequest;
use pond_core::user_data::ports::device_attribution::DeviceAttribution;
use pond_core::user_data::ports::device_registry::RegisterDeviceRequest;
#[allow(unused_imports)]
use pond_core::user_data::ports::profile::ProfileRepository as _;
#[allow(unused_imports)]
use pond_core::user_data::ports::settings::SettingsRepository as _;
use pond_infra::sqlite_device_attribution::SqliteDeviceAttribution;
use pond_infra::sqlite_recipe::SqliteRecipeRepository;
use pond_infra::sqlite_settings::SqliteSettingsRepository;
use tower::ServiceExt;

#[path = "support/device_handshake.rs"]
mod device_handshake;
use device_handshake::DeviceHandshake;

struct Pond {
    router: axum::Router,
    member: String,
    tasks: Arc<dyn pond_core::shared::ports::long_task::LongTaskRepository>,
    _dir: tempfile::TempDir,
}

/// One member and one phone; the phone is theirs when `paired`, the primary member is set when
/// `primary`.
async fn pond(paired: bool, primary: bool) -> Pond {
    let built = pond_api::test_support::app_state().await;
    let mut state = built.state;
    // The real store: the mock keeps no primary member.
    state.settings_repo = Arc::new(SqliteSettingsRepository::new(state.db.system.clone()));
    let member = state
        .profile_repo
        .create(CreateProfileRequest {
            display_name: "Jerry".into(),
            avatar_emoji: "duck".into(),
        })
        .await
        .unwrap()
        .id;
    let device_id = state
        .device_registry
        .register(RegisterDeviceRequest {
            id: None,
            name: "Phone".into(),
            device_type: "gotg".into(),
            hostname: None,
            capabilities: vec![],
            room_id: None,
        })
        .await
        .unwrap()
        .id;
    if paired {
        SqliteDeviceAttribution::new(state.db.system.clone())
            .set_device_profile(&device_id, Some(&member))
            .await
            .unwrap();
    }
    if primary {
        let mut settings = state.settings_repo.get().await.unwrap();
        settings.primary_profile_id = Some(member.clone());
        state.settings_repo.update(&settings).await.unwrap();
    }
    state.handshake = Arc::new(DeviceHandshake(device_id));
    state.recipe_repo = Some(Arc::new(SqliteRecipeRepository::new(
        state.db.system.clone(),
    )));
    let tasks: Arc<dyn pond_core::shared::ports::long_task::LongTaskRepository> = Arc::new(
        pond_infra::sqlite_long_task::SqliteLongTaskRepository::new(state.db.system.clone()),
    );
    Pond {
        tasks,
        router: build_router(
            Arc::new(state),
            std::path::PathBuf::from("pond-desktop/dist"),
        ),
        member,
        _dir: built.dir,
    }
}

/// `from_host` makes the request arrive from loopback, as the desktop's do.
fn call(
    method: Method,
    uri: &str,
    body: Option<serde_json::Value>,
    from_host: bool,
) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("Authorization", "Bearer test-token");
    let body = match body {
        Some(value) => {
            builder = builder.header("Content-Type", "application/json");
            Body::from(serde_json::to_vec(&value).unwrap())
        }
        None => Body::empty(),
    };
    let mut request = builder.body(body).unwrap();
    if from_host {
        request
            .extensions_mut()
            .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
                [127, 0, 0, 1],
                51_000,
            ))));
    }
    request
}

async fn send(pond: &Pond, request: Request<Body>) -> (StatusCode, serde_json::Value) {
    let response = pond.router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, body)
}

async fn offered(pond: &Pond, from_host: bool) -> Vec<String> {
    let (status, body) = send(
        pond,
        call(Method::GET, "/api/v1/agents/suggestions", None, from_host),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body.as_array()
        .unwrap()
        .iter()
        .map(|card| card["template"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn a_paired_member_is_offered_only_what_this_pond_can_run() {
    let pond = pond(true, false).await;
    let cards = offered(&pond, false).await;
    // A paired phone is presence; nothing here has weather, a camera, a tank or web search.
    for runs in ["welcome-back", "document-reader", "study-planner"] {
        assert!(
            cards.contains(&runs.to_string()),
            "{runs} is missing from {cards:?}"
        );
    }
    for cannot in [
        "morning-brief",
        "late-night-gate-alert",
        "low-tank-alert",
        "trip-planner",
    ] {
        assert!(
            !cards.contains(&cannot.to_string()),
            "{cannot} was offered: {cards:?}"
        );
    }
    let (_, body) = send(
        &pond,
        call(Method::GET, "/api/v1/agents/suggestions", None, false),
    )
    .await;
    let card = body
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["template"] == "welcome-back")
        .unwrap();
    assert_eq!(card["title"], "Welcome back");
    assert_eq!(card["activations_summary"], "When you come home");
    assert_eq!(card["needs"][0], "presence");
    assert!(card["why"].as_str().is_some_and(|w| !w.is_empty()));
    assert!(card["description"].as_str().is_some_and(|d| !d.is_empty()));
}

#[tokio::test]
async fn nobody_identified_is_offered_nothing_and_may_change_nothing() {
    let pond = pond(false, false).await;
    assert!(offered(&pond, false).await.is_empty());
    let enable = "/api/v1/agents/suggestions/document-reader/enable";
    let (status, _) = send(&pond, call(Method::POST, enable, None, false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let dismiss = "/api/v1/agents/suggestions/document-reader/dismiss";
    let (status, _) = send(&pond, call(Method::POST, dismiss, None, false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // Vacuity control: from the host with no primary member there is still nobody.
    assert!(offered(&pond, true).await.is_empty());
}

#[tokio::test]
async fn turning_one_on_copies_it_once_for_that_member() {
    let pond = pond(true, false).await;
    let enable = "/api/v1/agents/suggestions/document-reader/enable";
    let (status, recipe) = send(&pond, call(Method::POST, enable, None, false)).await;
    assert_eq!(status, StatusCode::CREATED, "{recipe}");
    assert_eq!(recipe["name"], "document-reader");
    assert_eq!(recipe["owner_profile_id"], pond.member.as_str());
    assert_eq!(recipe["template"], "document-reader");
    assert_eq!(recipe["active"], true);
    assert!(recipe["yaml"].as_str().unwrap().contains("giap_role:"));

    assert!(!offered(&pond, false)
        .await
        .contains(&"document-reader".to_string()));
    let (status, _) = send(&pond, call(Method::POST, enable, None, false)).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "the second tap must not make a second copy"
    );

    let (_, recipes) = send(&pond, call(Method::GET, "/api/v1/recipes", None, false)).await;
    assert_eq!(recipes.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn an_agent_this_pond_cannot_run_is_not_turned_on() {
    let pond = pond(true, false).await;
    let (status, body) = send(
        &pond,
        call(
            Method::POST,
            "/api/v1/agents/suggestions/morning-brief/enable",
            None,
            false,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["missing"][0], "weather");
    let (status, _) = send(
        &pond,
        call(
            Method::POST,
            "/api/v1/agents/suggestions/no-such-agent/enable",
            None,
            false,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn declining_a_card_hides_it_for_that_member() {
    let pond = pond(true, false).await;
    assert!(offered(&pond, false)
        .await
        .contains(&"study-planner".to_string()));
    let dismiss = "/api/v1/agents/suggestions/study-planner/dismiss";
    let (status, _) = send(&pond, call(Method::POST, dismiss, None, false)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let cards = offered(&pond, false).await;
    assert!(!cards.contains(&"study-planner".to_string()));
    assert!(
        cards.contains(&"document-reader".to_string()),
        "only the declined card is hidden"
    );
    let (status, _) = send(&pond, call(Method::POST, dismiss, None, false)).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "declining twice is fine");
    let (status, _) = send(
        &pond,
        call(
            Method::POST,
            "/api/v1/agents/suggestions/no-such-agent/dismiss",
            None,
            false,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn from_the_desktop_the_primary_member_owns_what_is_saved() {
    let pond = pond(false, true).await;
    let enable = "/api/v1/agents/suggestions/study-planner/enable";
    let (status, recipe) = send(&pond, call(Method::POST, enable, None, true)).await;
    assert_eq!(status, StatusCode::CREATED, "{recipe}");
    assert_eq!(recipe["owner_profile_id"], pond.member.as_str());

    let hand_written = serde_json::json!({
        "name": "my-agent",
        "yaml": "instructions: Help.\ngiap_role:\n  tool_groups: []\n",
    });
    let (status, saved) = send(
        &pond,
        call(
            Method::POST,
            "/api/v1/recipes",
            Some(hand_written.clone()),
            true,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(saved["owner_profile_id"], pond.member.as_str());
    assert!(saved["template"].is_null());

    // Vacuity control: the same unpaired phone off the host owns nothing.
    let elsewhere = serde_json::json!({
        "name": "their-agent",
        "yaml": "instructions: Help.\ngiap_role:\n  tool_groups: []\n",
    });
    let (status, saved) = send(
        &pond,
        call(Method::POST, "/api/v1/recipes", Some(elsewhere), false),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert!(saved["owner_profile_id"].is_null());
    let (status, _) = send(&pond, call(Method::POST, enable, None, false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn an_edited_copy_may_narrow_its_tools_but_not_widen_them() {
    let pond = pond(true, false).await;
    let (_, recipe) = send(
        &pond,
        call(
            Method::POST,
            "/api/v1/agents/suggestions/document-reader/enable",
            None,
            false,
        ),
    )
    .await;
    let id = recipe["id"].as_str().unwrap().to_string();
    let yaml = recipe["yaml"].as_str().unwrap().to_string();
    let groups = "tool_groups: [giap-task-work, giap-knowledge]";
    assert!(
        yaml.contains(groups),
        "the template's groups moved; update this test"
    );

    let wider = yaml.replace(
        groups,
        "tool_groups: [giap-task-work, giap-knowledge, giap-weather]",
    );
    let (status, body) = send(
        &pond,
        call(
            Method::PUT,
            &format!("/api/v1/recipes/{id}"),
            Some(serde_json::json!({"yaml": wider})),
            false,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["widened"][0], "giap-weather");

    let narrower = yaml.replace(groups, "tool_groups: [giap-task-work]");
    let (status, body) = send(
        &pond,
        call(
            Method::PUT,
            &format!("/api/v1/recipes/{id}"),
            Some(serde_json::json!({"yaml": narrower})),
            false,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["template"], "document-reader",
        "an edit keeps where the copy came from"
    );
}

/// The status route lists every agent the pond keeps a prefill for, and a rebuild shows as
/// queued until the compile pass takes it.
#[tokio::test]
async fn prefill_status_lists_every_agent_and_a_rebuild_queues_one() {
    let pond = pond(true, false).await;
    let (status, body) = send(
        &pond,
        call(Method::GET, "/api/v1/agents/prefills", None, false),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let agents: Vec<String> = body["agents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["agent"].as_str().unwrap().to_string())
        .collect();
    for shipped in [
        "long-task-planner",
        "long-task-verifier",
        "long-task-worker",
    ] {
        assert!(agents.iter().any(|a| a == shipped), "{agents:?}");
    }
    assert_eq!(
        body["building"]["active"], false,
        "nothing compiles in a test"
    );

    let (status, _) = send(
        &pond,
        call(
            Method::POST,
            "/api/v1/agents/no-such-agent/prefill/rebuild",
            None,
            false,
        ),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "an unknown agent has no cache to rebuild"
    );
    let (status, _) = send(
        &pond,
        call(
            Method::POST,
            "/api/v1/agents/long-task-worker/prefill/rebuild",
            None,
            false,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let (_, body) = send(
        &pond,
        call(Method::GET, "/api/v1/agents/prefills", None, false),
    )
    .await;
    let worker = body["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["agent"] == "long-task-worker")
        .unwrap()
        .clone();
    // The record is process-wide; take the request back so no other test sees it.
    pond_core::shared::services::prefill_progress::process_prefill_progress().take_rebuilds();
    assert_eq!(worker["status"], "queued");
    assert_eq!(worker["kind"], "default");
}

/// The chat card's routes: a member sees their own task, its steps and its result, and can stop
/// it once; a caller nobody identified sees nothing.
#[tokio::test]
async fn a_member_sees_and_stops_their_long_task_and_nobody_else_does() {
    use pond_core::shared::domain::long_task::{LongTask, LongTaskBudget};
    use pond_core::user_data::domain::profile::ProfileScope;

    let pond = pond(true, false).await;
    let task = LongTask::start(
        ProfileScope::Owner(pond.member.clone()),
        None,
        "plan the school trip",
        None,
        LongTaskBudget::new(12, None).unwrap(),
        chrono::Utc::now(),
    )
    .unwrap();
    pond.tasks.create_task(&task).await.unwrap();

    let (status, body) = send(&pond, call(Method::GET, "/api/v1/long-tasks", None, false)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body.as_array().unwrap().len(), 1, "{body}");
    let uri = format!("/api/v1/long-tasks/{}", task.id());
    let (status, body) = send(&pond, call(Method::GET, &uri, None, false)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["goal"], "plan the school trip");
    assert_eq!(body["state"], "planning");
    assert!(body["steps"].as_array().unwrap().is_empty());

    let (status, _) = send(
        &pond,
        call(Method::GET, "/api/v1/long-tasks/no-such-task", None, false),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let cancel = format!("{uri}/cancel");
    let (status, body) = send(&pond, call(Method::POST, &cancel, None, false)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _) = send(&pond, call(Method::POST, &cancel, None, false)).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "a stopped task cannot be stopped again"
    );

    let stranger = pond_with_no_member().await;
    let (status, body) = send(
        &stranger,
        call(Method::GET, "/api/v1/long-tasks", None, false),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        serde_json::json!([]),
        "nobody identified sees no task"
    );
}

async fn pond_with_no_member() -> Pond {
    pond(false, false).await
}
