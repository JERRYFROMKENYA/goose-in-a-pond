//! Port for the inference lane's durable clock: each job's last run, so a restart doesn't reset
//! every job to "never". A failure here must degrade to forgetting, never fail a pass.

use crate::user_data::services::inference_lane::LaneJob;
use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Utc};

/// No default bodies: a wrapper that inherited `Ok(())` for `record` would silently log nothing.
#[async_trait]
pub trait LaneRunLog: Send + Sync {
    /// Each job's last run, read once at wiring. Rows naming a removed job are skipped, not errors.
    async fn load(&self) -> Result<Vec<(LaneJob, DateTime<Utc>)>>;

    /// Stamp one job's run, replacing any previous stamp. `at` is the slot's release time, passed
    /// in because the write happens later, via a channel fed from the guard's synchronous `Drop`.
    async fn record(&self, job: LaneJob, at: DateTime<Utc>) -> Result<()>;
}
