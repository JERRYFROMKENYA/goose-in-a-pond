//! No background writer may stamp `sessions.updated_at`.
//!
//! The idle gate reads that column as activity, so a background write cancels background jobs
//! (a batch pass would cancel itself every time). This grep backs the behavioural tests in
//! `sqlite_session_storage.rs` by catching a new writer copied from `update_title`.

const STORAGE: &str = include_str!("../src/sqlite_session_storage.rs");

/// Signatures of methods that write a session row on the pond's own initiative.
const BACKGROUND_WRITERS: &[&str] = &[
    "async fn set_derived_title(",
    "async fn set_generated_title(",
    "async fn set_extraction_cursor(",
    "async fn note_extraction_attempt(",
];

/// Methods that SHOULD stamp the clock, because a person acted; the vacuity control.
const REAL_ACTIVITY: &[&str] = &["async fn update_title(", "async fn add_message("];

/// The text from `signature` to the next method at the same indent; crude on purpose.
fn method_body<'a>(source: &'a str, signature: &str) -> Option<&'a str> {
    let start = source.find(signature)?;
    let rest = &source[start + signature.len()..];
    let end = rest.find("\n    async fn ").unwrap_or(rest.len());
    Some(&rest[..end])
}

#[test]
fn no_background_session_writer_stamps_the_activity_clock() {
    for signature in BACKGROUND_WRITERS {
        let body = method_body(STORAGE, signature)
            .unwrap_or_else(|| panic!("{signature} is not in sqlite_session_storage.rs"));
        assert!(
            !body.contains("updated_at = datetime('now')"),
            "{signature} stamps `sessions.updated_at`. That column is an activity source: \
             a background writer touching it reads to every lane job as a person coming \
             back, so the pass cancels itself and pushes the idle clock forward. Write the \
             row without it, as `set_derived_title` does."
        );
    }
}

#[test]
fn every_named_background_writer_still_exists() {
    for signature in BACKGROUND_WRITERS {
        assert!(
            STORAGE.contains(signature),
            "{signature} is no longer in sqlite_session_storage.rs -- this guard is now \
             checking nothing. Update the list in the same change that renamed it."
        );
    }
}

/// Vacuity control: the adapter really does stamp the clock when a PERSON acts.
#[test]
fn a_persons_own_writes_still_stamp_the_activity_clock() {
    for signature in REAL_ACTIVITY {
        let body = method_body(STORAGE, signature)
            .unwrap_or_else(|| panic!("{signature} is not in sqlite_session_storage.rs"));
        assert!(
            body.contains("updated_at = datetime('now')"),
            "{signature} no longer stamps `sessions.updated_at`. If that is deliberate the \
             idle gate has lost an activity source and background jobs will run while \
             somebody is mid-conversation; if it is not, this guard has gone vacuous."
        );
    }
}
