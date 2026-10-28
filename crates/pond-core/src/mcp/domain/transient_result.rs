//! A tool result the model reads during its turn and history never keeps: the tool marks it in
//! `CallToolResult._meta`, and every store of tool results keeps the marker's stub instead.
//! Web search is the one such tool: Brave's terms (3(b)(i)) allow Search Results only transient
//! storage.

use serde_json::{Map, Value};

/// The `_meta` key a transient result carries; its value is `{"keep": "<stub>"}`.
pub const TRANSIENT_META_KEY: &str = "giap/transient";

/// The field under [`TRANSIENT_META_KEY`] holding what history keeps.
pub const KEEP_FIELD: &str = "keep";

/// Domains a web search stub names, at most.
pub const MAX_STUB_DOMAINS: usize = 5;

/// A domain as a stub names it, at most; past it a name is not a plain host.
const MAX_STUB_DOMAIN_BYTES: usize = 63;

const WEB_SEARCH_KEPT: &str = "Web search results are not kept after the turn.";

/// What history keeps of a web search: the sources' domains and nothing they said.
pub fn web_search_stub<S: AsRef<str>>(domains: &[S]) -> String {
    let mut named: Vec<&str> = Vec::new();
    for domain in domains.iter().map(|d| d.as_ref().trim()) {
        if named.len() == MAX_STUB_DOMAINS {
            break;
        }
        if is_plain_domain(domain) && !named.contains(&domain) {
            named.push(domain);
        }
    }
    if named.is_empty() {
        WEB_SEARCH_KEPT.to_string()
    } else {
        format!("{WEB_SEARCH_KEPT} Sources: {}.", named.join(", "))
    }
}

/// A host name and nothing else, so no page text can ride the stub in place of a domain.
fn is_plain_domain(domain: &str) -> bool {
    !domain.is_empty()
        && domain.len() <= MAX_STUB_DOMAIN_BYTES
        && domain.contains('.')
        && domain
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

/// The `_meta` object marking a result transient, keeping `keep`.
pub fn transient_meta(keep: &str) -> Map<String, Value> {
    let mut marker = Map::new();
    marker.insert(KEEP_FIELD.to_string(), Value::String(keep.to_string()));
    let mut meta = Map::new();
    meta.insert(TRANSIENT_META_KEY.to_string(), Value::Object(marker));
    meta
}

/// The stub a result's `_meta` asks history to keep; `None` for a result history keeps whole.
pub fn keep_from_meta(meta: &Map<String, Value>) -> Option<String> {
    meta.get(TRANSIENT_META_KEY)?
        .get(KEEP_FIELD)?
        .as_str()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stub_names_domains_only() {
        assert_eq!(
            web_search_stub(&["kenyapower.co.ke", "nation.africa"]),
            "Web search results are not kept after the turn. Sources: kenyapower.co.ke, \
             nation.africa."
        );
        assert_eq!(
            web_search_stub::<&str>(&[]),
            "Web search results are not kept after the turn."
        );
    }

    #[test]
    fn the_stub_drops_repeats_and_anything_that_is_not_a_domain() {
        let stub = web_search_stub(&[
            "nation.africa",
            "nation.africa",
            "Junction Mall closes at 9pm",
            "https://evil.example/path",
            "",
            "localhost",
            "kws.go.ke",
        ]);
        assert_eq!(
            stub,
            "Web search results are not kept after the turn. Sources: nation.africa, kws.go.ke."
        );
    }

    #[test]
    fn the_stub_names_at_most_five() {
        let domains: Vec<String> = (0..9).map(|i| format!("s{i}.example")).collect();
        let stub = web_search_stub(&domains);
        assert!(stub.contains("s4.example"), "{stub}");
        assert!(!stub.contains("s5.example"), "{stub}");
    }

    #[test]
    fn the_marker_round_trips() {
        let meta = transient_meta("Web search results are not kept after the turn.");
        assert_eq!(
            Value::Object(meta.clone()),
            serde_json::json!({"giap/transient": {"keep": "Web search results are not kept after the turn."}})
        );
        assert_eq!(
            keep_from_meta(&meta).as_deref(),
            Some("Web search results are not kept after the turn.")
        );
    }

    #[test]
    fn other_meta_is_not_transient() {
        let other = serde_json::json!({"goose": {"x": 1}, "giap/transient": {"keep": "  "}});
        assert_eq!(keep_from_meta(other.as_object().unwrap()), None);
        let wrong = serde_json::json!({"giap/transient": "keep"});
        assert_eq!(keep_from_meta(wrong.as_object().unwrap()), None);
    }
}
