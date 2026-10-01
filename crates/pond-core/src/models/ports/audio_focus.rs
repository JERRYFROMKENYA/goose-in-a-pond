//! Other audio the pond's own sound must not play over.

use async_trait::async_trait;

/// What [`AudioFocus::pause`] paused, as the service names it: where it was playing and what, so
/// [`AudioFocus::resume`] can tell whether anyone has taken over since.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paused {
    pub device: Option<String>,
    pub item: Option<String>,
}

/// Audio from elsewhere that pauses while the pond makes a sound. Spotify's Developer Policy III.7:
/// "Do not permit any device or system to segue, mix, re-mix, or overlap any Spotify Content with
/// any other audio content (including other Spotify Content)."
#[async_trait]
pub trait AudioFocus: Send + Sync {
    /// Pause whatever is playing. `Some` is what was paused, for [`Self::resume`]; `None` when
    /// nothing was playing or it could not be paused.
    async fn pause(&self) -> Option<Paused>;

    /// Resume what [`Self::pause`] paused, unless it has been stopped, changed or resumed since.
    async fn resume(&self, paused: Paused);
}
