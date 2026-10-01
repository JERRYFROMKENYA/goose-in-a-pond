use serde::{Deserialize, Serialize};

/// An OAuth 2.1 Authorization Code + PKCE provider (e.g. Spotify). The household's own client ID
/// lives in the secret store as `{PROVIDER_ID}_CLIENT_ID` (uppercase).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthProviderConfig {
    /// Provider identifier (e.g. "spotify").
    pub id: String,
    /// Human-readable display name (e.g. "Spotify").
    pub display_name: String,
    pub authorize_url: String,
    pub token_url: String,
    pub scopes: Vec<String>,
    /// A client ID every install may share, only for a provider whose terms allow that. Spotify's do
    /// not (Developer Terms VI.1: the ID is a Security Code, kept from third parties), so it has none
    /// and each household uses its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundled_client_id: Option<String>,
    /// Secret key name under which the access token is stored.
    pub token_key: String,
    /// Secret key name under which the refresh token is stored.
    pub refresh_key: String,
}
