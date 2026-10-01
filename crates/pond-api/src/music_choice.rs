//! The household's music choice, the Music extension's `MUSIC_SERVICE` and `MUSIC_PLAYER`, where the
//! pond itself needs it: the app's music controls follow the chosen service, and an install from
//! before the choice existed keeps the service it was already using.

use pond_core::security::ports::secret::SecretRepository;

pub const SERVICE_KEY: &str = "MUSIC_SERVICE";
pub const PLAYER_KEY: &str = "MUSIC_PLAYER";
const SPOTIFY_TOKEN_KEY: &str = "SPOTIFY_ACCESS_TOKEN";

async fn stored(repo: &dyn SecretRepository, key: &str) -> Option<String> {
    repo.get(key)
        .await
        .ok()
        .flatten()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// The chosen service: Spotify when that is what is stored, else Apple Music, the choice's default.
pub async fn chosen_service(repo: &dyn SecretRepository) -> &'static str {
    match stored(repo, SERVICE_KEY).await.as_deref() {
        Some("spotify") => "spotify",
        _ => "apple",
    }
}

/// The chosen player: the service's own app when that is what is stored, else the player page.
pub async fn chosen_player(repo: &dyn SecretRepository) -> &'static str {
    match stored(repo, PLAYER_KEY).await.as_deref() {
        Some("app") => "app",
        _ => "page",
    }
}

/// Before the choice existed, a household signed in to Spotify was using Spotify. Store that once, so
/// the choice's default, Apple Music, does not switch it without anyone asking. Does nothing once a
/// service is stored, or for a household that never signed in to Spotify. Returns what it stored.
pub async fn keep_an_existing_choice(repo: &dyn SecretRepository) -> Option<&'static str> {
    if stored(repo, SERVICE_KEY).await.is_some() {
        return None;
    }
    stored(repo, SPOTIFY_TOKEN_KEY).await?;
    repo.set(SERVICE_KEY, "spotify").await.ok()?;
    Some("spotify")
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use async_trait::async_trait;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Store(Mutex<HashMap<String, String>>);

    #[async_trait]
    impl SecretRepository for Store {
        async fn get(&self, key: &str) -> Result<Option<String>> {
            Ok(self.0.lock().unwrap().get(key).cloned())
        }
        async fn set(&self, key: &str, value: &str) -> Result<()> {
            self.0
                .lock()
                .unwrap()
                .insert(key.to_string(), value.to_string());
            Ok(())
        }
        async fn delete(&self, key: &str) -> Result<()> {
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
        async fn list_keys(&self) -> Result<Vec<String>> {
            Ok(self.0.lock().unwrap().keys().cloned().collect())
        }
        async fn has(&self, key: &str) -> Result<bool> {
            Ok(self.0.lock().unwrap().contains_key(key))
        }
    }

    fn with(pairs: &[(&str, &str)]) -> Store {
        let store = Store::default();
        for (k, v) in pairs {
            store.0.lock().unwrap().insert(k.to_string(), v.to_string());
        }
        store
    }

    #[tokio::test]
    async fn nothing_stored_means_apple_music_on_the_player_page() {
        let store = with(&[]);
        assert_eq!(chosen_service(&store).await, "apple");
        assert_eq!(chosen_player(&store).await, "page");
    }

    #[tokio::test]
    async fn what_is_stored_is_what_is_chosen_and_anything_else_is_the_default() {
        let store = with(&[(SERVICE_KEY, " spotify "), (PLAYER_KEY, "app")]);
        assert_eq!(chosen_service(&store).await, "spotify");
        assert_eq!(chosen_player(&store).await, "app");
        let odd = with(&[(SERVICE_KEY, "tidal"), (PLAYER_KEY, "radio")]);
        assert_eq!(chosen_service(&odd).await, "apple");
        assert_eq!(chosen_player(&odd).await, "page");
    }

    #[tokio::test]
    async fn a_household_signed_in_to_spotify_keeps_spotify_once() {
        let store = with(&[(SPOTIFY_TOKEN_KEY, "BQD-token")]);
        assert_eq!(keep_an_existing_choice(&store).await, Some("spotify"));
        assert_eq!(chosen_service(&store).await, "spotify");
        // Once stored, it is the person's to change: nothing is kept a second time.
        store.set(SERVICE_KEY, "apple").await.unwrap();
        assert_eq!(keep_an_existing_choice(&store).await, None);
        assert_eq!(chosen_service(&store).await, "apple");
    }

    #[tokio::test]
    async fn no_spotify_sign_in_or_an_empty_token_changes_nothing() {
        for store in [with(&[]), with(&[(SPOTIFY_TOKEN_KEY, "")])] {
            assert_eq!(keep_an_existing_choice(&store).await, None);
            assert!(!store.has(SERVICE_KEY).await.unwrap());
        }
    }
}
