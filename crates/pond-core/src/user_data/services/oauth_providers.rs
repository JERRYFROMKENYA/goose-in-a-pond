//! Built-in OAuth PKCE providers. Each household's client ID is the `{PROVIDER_ID}_CLIENT_ID` secret.

use crate::security::domain::oauth_provider::OAuthProviderConfig;

pub fn builtin_oauth_providers() -> Vec<OAuthProviderConfig> {
    vec![OAuthProviderConfig {
        id: "spotify".to_string(),
        display_name: "Spotify".to_string(),
        authorize_url: "https://accounts.spotify.com/authorize".to_string(),
        token_url: "https://accounts.spotify.com/api/token".to_string(),
        // Only what the app's own Spotify features use (Developer Terms V.3: ask for no more): the
        // Web Playback SDK needs the last three, the music controls read and change playback. The
        // assistant never controls Spotify, so nothing here reads playlists, the library or history.
        // New scopes only reach tokens issued after the user signs in again.
        scopes: vec![
            "user-read-playback-state".to_string(),
            "user-modify-playback-state".to_string(),
            "user-read-currently-playing".to_string(),
            "streaming".to_string(),
            "user-read-email".to_string(),
            "user-read-private".to_string(),
        ],
        // Spotify's Developer Terms VI.1: a client ID is a Security Code, not to be disclosed, and
        // development mode admits five allowlisted users. So none ships here: each household
        // registers its own app and stores its ID as SPOTIFY_CLIENT_ID.
        bundled_client_id: None,
        token_key: "SPOTIFY_ACCESS_TOKEN".to_string(),
        refresh_key: "SPOTIFY_REFRESH_TOKEN".to_string(),
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_providers_contains_spotify() {
        let providers = builtin_oauth_providers();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "spotify");
        assert_eq!(providers[0].display_name, "Spotify");
        assert!(!providers[0].scopes.is_empty());
        for needed in ["streaming", "user-read-email", "user-read-private"] {
            assert!(
                providers[0].scopes.iter().any(|s| s == needed),
                "the Spotify player page's SDK needs the {needed} scope"
            );
        }
        // Developer Terms V.3: no more than the app's own features use.
        let mut asked: Vec<&str> = providers[0].scopes.iter().map(String::as_str).collect();
        asked.sort_unstable();
        assert_eq!(
            asked,
            [
                "streaming",
                "user-modify-playback-state",
                "user-read-currently-playing",
                "user-read-email",
                "user-read-playback-state",
                "user-read-private",
            ],
            "the assistant never controls Spotify, so no playlist, library or history scope"
        );
        assert_eq!(
            providers[0].bundled_client_id, None,
            "no Spotify client ID ships with GIAP: each household uses its own"
        );
        assert_eq!(providers[0].token_key, "SPOTIFY_ACCESS_TOKEN");
        assert_eq!(providers[0].refresh_key, "SPOTIFY_REFRESH_TOKEN");
    }

    #[test]
    fn provider_config_is_serializable() {
        let providers = builtin_oauth_providers();
        let json = serde_json::to_string(&providers[0]).unwrap();
        assert!(json.contains("spotify"));
        let roundtrip: OAuthProviderConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(roundtrip.id, "spotify");
    }
}
