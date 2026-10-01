//! Model-download cache using `huggingface_hub`'s on-disk layout, so Python tools can share it.

use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};

/// A refused or incomplete transfer, distinct from the network being down.
/// Each variant says what became of `{blob}.incomplete`; match it with [`transfer_error`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TransferError {
    /// Size differs from the pin ([`HfFetch::expect_size`] or the HEAD); nothing was written.
    #[error("the server reports {actual} bytes for this file, expected {expected}")]
    SizeMismatch { expected: u64, actual: u64 },
    /// No hop's `etag`/`x-linked-etag` matched [`HfFetch::expect_etag`]; nothing transferred.
    #[error("the server's etags {found:?} do not include the pinned {expected}")]
    EtagMismatch {
        expected: String,
        found: Vec<String>,
    },
    /// The body ended cleanly but early; `.incomplete` is kept, so a retry resumes.
    #[error("the transfer ended after {received} of {total} bytes")]
    Short { received: u64, total: u64 },
    /// Too many bytes arrived; `.incomplete` is deleted since it is not a prefix of the file.
    #[error("the transfer sent more than the {total} bytes this file has ({received} so far)")]
    Overlong { received: u64, total: u64 },
    /// A resume's partial body started at the wrong byte; `.incomplete` is left as it was.
    #[error("asked to resume at byte {requested}, the server answered from {answered:?}")]
    RangeMismatch {
        requested: u64,
        answered: Option<u64>,
    },
}

/// The [`TransferError`] behind `err`, even through `.context(..)` layers.
pub fn transfer_error(err: &anyhow::Error) -> Option<&TransferError> {
    err.downcast_ref::<TransferError>()
}

/// [`link_blob`] found a non-symlink at its destination and left it in place.
/// Callers move it aside and relink: this crate never deletes a file it did not write.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{} is not a link into the cache; move it aside before linking", .path.display())]
pub struct DestNotALink {
    pub path: PathBuf,
}

/// A download its progress callback stopped; the `.incomplete` file stays resumable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stopped;

impl std::fmt::Display for Stopped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "download stopped by caller")
    }
}

impl std::error::Error for Stopped {}

/// Whether `err` is a caller-requested stop rather than a transfer failure.
pub fn is_stopped(err: &anyhow::Error) -> bool {
    err.downcast_ref::<Stopped>().is_some()
}

/// Env vars consulted (in order) for an HF access token.
const HF_TOKEN_ENV_VARS: &[&str] = &["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_TOKEN"];

/// Root of the HF-compatible cache.
pub struct HfCache {
    root: PathBuf,
    token: Option<String>,
}

/// A handle to one HF repo within the cache.
pub struct HfRepo<'a> {
    cache: &'a HfCache,
    repo_id: String,
    revision: String,
}

/// A handle to one file within a repo.
pub struct HfFetch<'a> {
    repo: &'a HfRepo<'a>,
    filename: String,
    /// Pinned by [`HfFetch::expect_size`]; `None` trusts the server.
    expected_size: Option<u64>,
    /// Pinned by [`HfFetch::expect_etag`], already normalised.
    expected_etag: Option<String>,
}

impl HfCache {
    /// Construct a cache rooted at `$HF_HOME` if set, else `{data_dir}/hf_cache`.
    pub fn new(data_dir: &Path) -> Self {
        let root = match std::env::var_os("HF_HOME") {
            Some(v) if !v.is_empty() => PathBuf::from(v),
            _ => {
                let mut p = data_dir.to_path_buf();
                p.push("hf_cache");
                p
            }
        };
        let token = discover_token(&root);
        Self { root, token }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `{root}/hub` — parent of all `models--*` repo folders.
    pub fn hub_dir(&self) -> PathBuf {
        let mut p = self.root.clone();
        p.push("hub");
        p
    }

    /// `{root}/token` — Python-compatible token file location.
    pub fn token_path(&self) -> PathBuf {
        let mut p = self.root.clone();
        p.push("token");
        p
    }

    /// Cached HF access token, if any was discovered at construction.
    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    /// Build a repo handle (default revision = `"main"`).
    pub fn repo(&self, repo_id: impl Into<String>) -> HfRepo<'_> {
        HfRepo {
            cache: self,
            repo_id: repo_id.into(),
            revision: "main".to_string(),
        }
    }
}

/// Resolve the token via env vars first, then the `{root}/token` file.
fn discover_token(root: &Path) -> Option<String> {
    for var in HF_TOKEN_ENV_VARS {
        if let Ok(v) = std::env::var(var) {
            let trimmed = v.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    let mut token_file = root.to_path_buf();
    token_file.push("token");
    match std::fs::read_to_string(&token_file) {
        Ok(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Err(_) => None,
    }
}

impl<'a> HfRepo<'a> {
    /// Override the revision (branch / tag / commit) — default is `"main"`.
    pub fn with_revision(mut self, revision: impl Into<String>) -> Self {
        self.revision = revision.into();
        self
    }

    /// `models--{org}--{repo}` (slashes in `repo_id` become `--`).
    pub fn folder_name(&self) -> String {
        format!("models--{}", self.repo_id).replace('/', "--")
    }

    /// `{hub_dir}/models--{org}--{repo}`.
    pub fn folder_path(&self) -> PathBuf {
        let mut p = self.cache.hub_dir();
        p.push(self.folder_name());
        p
    }

    /// `{folder_path}/refs/{branch}` — text file holding a commit hash.
    pub fn refs_path(&self, branch: &str) -> PathBuf {
        let mut p = self.folder_path();
        p.push("refs");
        p.push(branch);
        p
    }

    /// `{folder_path}/snapshots/{commit}` — directory of symlinks to blobs.
    pub fn snapshot_dir(&self, commit: &str) -> PathBuf {
        let mut p = self.folder_path();
        p.push("snapshots");
        p.push(commit);
        p
    }

    /// `{folder_path}/blobs/{etag}` — content-addressed real file.
    pub fn blob_path(&self, etag: &str) -> PathBuf {
        let mut p = self.folder_path();
        p.push("blobs");
        p.push(etag);
        p
    }

    pub fn file(&self, filename: impl Into<String>) -> HfFetch<'_> {
        HfFetch {
            repo: self,
            filename: filename.into(),
            expected_size: None,
            expected_etag: None,
        }
    }
}

impl<'a> HfFetch<'a> {
    /// `{snapshot_dir}/{filename}` — where the symlink to the blob will live.
    pub fn pointer_path(&self, commit: &str) -> PathBuf {
        let mut p = self.repo.snapshot_dir(commit);
        p.push(&self.filename);
        p
    }

    pub fn blob_path(&self, etag: &str) -> PathBuf {
        self.repo.blob_path(etag)
    }

    /// Pin the file's size in bytes; `0` means no pin, as `0` is this crate's "length unknown".
    /// Stands in for a missing HEAD length; a server or cached blob that disagrees is not used.
    pub fn expect_size(mut self, bytes: u64) -> Self {
        self.expected_size = (bytes > 0).then_some(bytes);
        self
    }

    /// Pin the file's identity; for LFS, its sha256 (the first hop's `x-linked-etag`).
    /// A match names the blob by the pin: the final CDN hop's `etag` is a xet hash, not sha256.
    pub fn expect_etag(mut self, etag: impl AsRef<str>) -> Self {
        let etag = normalize_etag(etag.as_ref());
        self.expected_etag = (!etag.is_empty()).then_some(etag);
        self
    }

    /// `https://huggingface.co/{repo_id}/resolve/{revision}/{filename}`.
    pub fn url(&self) -> String {
        format!(
            "https://huggingface.co/{}/resolve/{}/{}",
            self.repo.repo_id,
            url_escape_revision(&self.repo.revision),
            self.filename
        )
    }
}

/// Percent-encode `/` in a revision so branches like `feature/x` survive the URL.
fn url_escape_revision(rev: &str) -> String {
    rev.replace('/', "%2F")
}

// ── URL parsing ──────────────────────────────────────────────────────────────

/// Split an HF `resolve` URL into `(repo_id, revision, filename)`; `None` if it isn't one.
pub fn parse_hf_url(url: &str) -> Option<(String, String, String)> {
    let after_scheme = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let (host, rest) = after_scheme.split_once('/')?;
    if host != "huggingface.co" {
        return None;
    }
    // Need at least: {org}/{repo}/resolve/{rev}/{file...}
    let parts: Vec<&str> = rest.splitn(5, '/').collect();
    if parts.len() < 5 {
        return None;
    }
    if parts[2] != "resolve" {
        return None;
    }
    let org = parts[0];
    let repo = parts[1];
    let revision = parts[3];
    let filename = parts[4];
    if org.is_empty() || repo.is_empty() || revision.is_empty() || filename.is_empty() {
        return None;
    }
    Some((
        format!("{org}/{repo}"),
        urldecode_simple(revision),
        filename.to_string(),
    ))
}

/// Decode `%2F` → `/` (just enough for revisions). Leaves other escapes alone.
fn urldecode_simple(s: &str) -> String {
    s.replace("%2F", "/").replace("%2f", "/")
}

// ── Host policy ──────────────────────────────────────────────────────────────

/// Hosts (HF and its CloudFront CDN domains) that may get the bearer token across a redirect.
pub(crate) fn should_send_auth_on_redirect(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host == "huggingface.co"
        || host.ends_with(".huggingface.co")
        || host.ends_with(".cloudfront.net")
}

// ── Redirect-aware reqwest client ────────────────────────────────────────────

/// Client with redirects off: we follow them by hand to send the token only to HF/CDN hosts.
pub fn build_redirect_aware_client(_token: Option<&str>) -> Result<reqwest::Client> {
    use reqwest::redirect::Policy;

    reqwest::Client::builder()
        .redirect(Policy::none())
        .build()
        .map_err(|e| anyhow!("failed to build redirect-aware client: {e}"))
}

/// Strip the weak `W/` prefix and quotes, as `huggingface_hub`'s `_normalize_etag` does.
/// HF gives gzipped non-LFS files weak etags, and the `/` would nest the blob path.
fn normalize_etag(s: &str) -> String {
    let s = s.trim();
    s.strip_prefix("W/")
        .unwrap_or(s)
        .trim_matches('"')
        .to_string()
}

/// Whether an etag, set by whichever host the redirects ended on, is safe as a `blobs/` name.
/// Refuses anything that could escape the directory or hide the file (a leading `.`).
fn blob_name_is_safe(etag: &str) -> bool {
    !etag.is_empty()
        && !etag.starts_with('.')
        && etag
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

fn header_str<'h>(headers: &'h reqwest::header::HeaderMap, name: &str) -> Option<&'h str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// A positive integer header; `0` is absent, being this crate's "length unknown".
fn header_len(headers: &reqwest::header::HeaderMap, name: &str) -> Option<u64> {
    header_str(headers, name)
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|n| *n > 0)
}

/// Whether `content-length` counts encoded bytes; an unreadable header counts as encoded.
fn has_content_encoding(headers: &reqwest::header::HeaderMap) -> bool {
    match headers.get(reqwest::header::CONTENT_ENCODING) {
        None => false,
        Some(v) => v
            .to_str()
            .map(|s| {
                let s = s.trim();
                !(s.is_empty() || s.eq_ignore_ascii_case("identity"))
            })
            .unwrap_or(true),
    }
}

/// The file length a response promises: `content-length`, unless the body is encoded.
fn plain_len(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    if has_content_encoding(headers) {
        None
    } else {
        header_len(headers, "content-length")
    }
}

/// Parsed `Content-Range: bytes <start>-<end>/<complete>` (or `*/<complete>`); `*` is `None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ContentRange {
    start: Option<u64>,
    complete: Option<u64>,
}

fn content_range(headers: &reqwest::header::HeaderMap) -> Option<ContentRange> {
    let value = header_str(headers, "content-range")?.trim();
    let rest = value.strip_prefix("bytes")?.trim_start();
    let (range, complete) = rest.split_once('/')?;
    let start = match range.trim() {
        "*" => None,
        r => Some(r.split_once('-')?.0.trim().parse::<u64>().ok()?),
    };
    let complete = match complete.trim() {
        "*" => None,
        c => Some(c.parse::<u64>().ok()?),
    };
    Some(ContentRange { start, complete })
}

impl<'a> HfFetch<'a> {
    /// Resumable, etag-aware download to the content-addressed blob path. `progress` returning
    /// `false` returns [`Stopped`], keeping `{blob}.incomplete` to resume; delete it to cancel.
    pub async fn download_to_blob<F>(
        &self,
        client: &reqwest::Client,
        token: Option<&str>,
        progress: F,
    ) -> Result<PathBuf>
    where
        F: FnMut(u64, u64) -> bool,
    {
        let url = self.url();
        self.download_to_blob_from(&url, client, token, progress)
            .await
    }

    /// [`download_to_blob`](Self::download_to_blob) at an explicit URL, for loopback tests.
    pub(crate) async fn download_to_blob_from<F>(
        &self,
        url: &str,
        client: &reqwest::Client,
        token: Option<&str>,
        mut progress: F,
    ) -> Result<PathBuf>
    where
        F: FnMut(u64, u64) -> bool,
    {
        use tokio::io::AsyncWriteExt as _;

        // Manual redirect follow so we can strip auth on cross-host hops.
        let head_resp = head_with_redirects(client, url, token).await?;
        let headers = head_resp.headers();

        let final_etag = header_str(headers, "etag")
            .map(normalize_etag)
            .filter(|e| !e.is_empty());
        let final_linked = header_str(headers, "x-linked-etag")
            .map(normalize_etag)
            .filter(|e| !e.is_empty());

        let etag = match &self.expected_etag {
            Some(expected) => {
                let mut found: Vec<String> = Vec::new();
                for candidate in [&final_etag, &final_linked, &head_resp.linked_etag]
                    .into_iter()
                    .flatten()
                {
                    if !found.contains(candidate) {
                        found.push(candidate.clone());
                    }
                }
                if !found.iter().any(|e| e.eq_ignore_ascii_case(expected)) {
                    return Err(anyhow::Error::new(TransferError::EtagMismatch {
                        expected: expected.clone(),
                        found,
                    }));
                }
                expected.clone()
            }
            None => final_etag
                .or(final_linked)
                .or_else(|| head_resp.linked_etag.clone())
                .ok_or_else(|| anyhow!("HEAD {url}: no etag / x-linked-etag header"))?,
        };
        if !blob_name_is_safe(&etag) {
            return Err(anyhow!(
                "HEAD {url}: etag {etag:?} cannot be used as a file name"
            ));
        }

        // A pin is checked against every length the server stated, not just the one used.
        let head_len = plain_len(headers);
        if let Some(expected) = self.expected_size {
            for actual in [head_len, head_resp.linked_size].into_iter().flatten() {
                if actual != expected {
                    return Err(anyhow::Error::new(TransferError::SizeMismatch {
                        expected,
                        actual,
                    }));
                }
            }
        }
        let total: u64 = self
            .expected_size
            .or(head_len)
            .or(head_resp.linked_size)
            .unwrap_or(0);

        let commit = headers
            .get("x-repo-commit")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "main".to_string());

        let blob_path = self.blob_path(&etag);
        let blobs_dir = blob_path
            .parent()
            .ok_or_else(|| anyhow!("blob path has no parent: {}", blob_path.display()))?;
        tokio::fs::create_dir_all(blobs_dir)
            .await
            .with_context(|| format!("create blobs dir {}", blobs_dir.display()))?;

        // ── Fast path: blob already complete on disk ────────────────────────
        if let Ok(meta) = tokio::fs::metadata(&blob_path).await {
            if total == 0 || meta.len() == total {
                progress(meta.len(), meta.len());
                finalize_pointers(self, &etag, &commit, &blob_path).await?;
                return Ok(blob_path);
            }
        }

        // ── Resumable download into {blob}.incomplete ───────────────────────
        let final_url = head_resp.final_url.clone();
        let mut incomplete_path = blob_path.clone();
        let incomplete_name = format!(
            "{}.incomplete",
            blob_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&etag)
        );
        incomplete_path.set_file_name(incomplete_name);

        // ── Per-blob advisory lock — at most one process does the GET ───────
        // Released when `_lock_guard` drops or the process exits.
        let lock_path = {
            let mut p = blob_path.clone();
            p.set_file_name(format!("{etag}.lock"));
            p
        };
        let lock_outcome = acquire_blob_lock(
            &lock_path,
            &blob_path,
            &incomplete_path,
            total,
            &mut progress,
        )
        .await?;
        let _lock_guard = match lock_outcome {
            LockOutcome::Acquired(guard) => guard,
            LockOutcome::AnotherFinished => {
                finalize_pointers(self, &etag, &commit, &blob_path).await?;
                return Ok(blob_path);
            }
        };

        // The previous lock holder may have just finished the blob; re-check the fast path.
        if let Ok(meta) = tokio::fs::metadata(&blob_path).await {
            if total == 0 || meta.len() == total {
                progress(meta.len(), meta.len());
                finalize_pointers(self, &etag, &commit, &blob_path).await?;
                return Ok(blob_path);
            }
        }

        let mut existing_size = match tokio::fs::metadata(&incomplete_path).await {
            Ok(m) => m.len(),
            Err(_) => 0,
        };

        // Settled before the GET: `bytes={total}-` of a whole file 416s on every retry, and an
        // overlong `.incomplete` is not a prefix, so nothing appended to it can be right.
        if total > 0 && existing_size == total {
            progress(total, total);
            return self
                .promote(&incomplete_path, &blob_path, &etag, &commit)
                .await;
        }
        if total > 0 && existing_size > total {
            existing_size = 0;
        }

        let range_header: Option<String> = if existing_size > 0 {
            Some(format!("bytes={existing_size}-"))
        } else {
            None
        };
        let mut resp =
            get_with_redirects(client, &final_url, token, range_header.as_deref()).await?;

        // Reached only with a `.incomplete` and no known length (or an inconsistent server).
        if resp.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            let complete = content_range(resp.headers()).and_then(|r| r.complete);
            drop(resp);
            if total == 0 && complete == Some(existing_size) {
                progress(existing_size, existing_size);
                return self
                    .promote(&incomplete_path, &blob_path, &etag, &commit)
                    .await;
            }
            existing_size = 0;
            resp = get_with_redirects(client, &final_url, token, None).await?;
        }

        // Append only a 206; a 200 to a Range request is the whole file from byte 0.
        let status = resp.status();
        let partial = status == reqwest::StatusCode::PARTIAL_CONTENT;
        let answered_range = content_range(resp.headers());
        // A 206 must start at `existing_size`, or the file gets the right length, wrong content.
        if partial {
            let answered = answered_range.and_then(|r| r.start);
            if answered != Some(existing_size) {
                return Err(anyhow::Error::new(TransferError::RangeMismatch {
                    requested: existing_size,
                    answered,
                }));
            }
        }
        let resumed = existing_size > 0 && partial;

        // Checked before opening the file, so a length disagreement costs nothing on disk.
        let offered = if partial {
            answered_range.and_then(|r| r.complete)
        } else {
            plain_len(resp.headers())
        };
        let total = match offered {
            Some(n) if total == 0 => n,
            Some(n) if n != total => {
                return Err(anyhow::Error::new(TransferError::SizeMismatch {
                    expected: total,
                    actual: n,
                }));
            }
            _ => total,
        };

        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(resumed)
            .write(true)
            .truncate(!resumed)
            .open(&incomplete_path)
            .await
            .with_context(|| format!("open {}", incomplete_path.display()))?;

        let mut downloaded: u64 = if resumed { existing_size } else { 0 };
        if !progress(downloaded, total) {
            file.flush().await.ok();
            return Err(anyhow!(Stopped));
        }

        loop {
            let chunk = match resp.chunk().await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(e) => {
                    // Flushed so the next call's Range resumes after every byte that arrived.
                    file.flush().await.ok();
                    return Err(anyhow!(e).context(format!("read chunk from {final_url}")));
                }
            };
            file.write_all(&chunk)
                .await
                .with_context(|| format!("write {}", incomplete_path.display()))?;
            downloaded += chunk.len() as u64;
            if total > 0 && downloaded > total {
                // Stop at the first byte past the end so a runaway answer can't fill the disk.
                drop(file);
                let _ = tokio::fs::remove_file(&incomplete_path).await;
                return Err(anyhow::Error::new(TransferError::Overlong {
                    received: downloaded,
                    total,
                }));
            }
            if !progress(downloaded, total) {
                // Keep `.incomplete`: the next call resumes from it, so a stop is a pause.
                file.flush().await.ok();
                return Err(anyhow!(Stopped));
            }
        }
        // A failed flush (full disk) must not reach the rename, or the blob is silently short.
        file.flush()
            .await
            .with_context(|| format!("flush {}", incomplete_path.display()))?;
        drop(file);

        // A close-delimited body cut short: kept to resume, never renamed to the blob.
        if total > 0 && downloaded < total {
            return Err(anyhow::Error::new(TransferError::Short {
                received: downloaded,
                total,
            }));
        }

        self.promote(&incomplete_path, &blob_path, &etag, &commit)
            .await
    }

    /// Rename a finished `.incomplete` to its blob and write the pointers.
    async fn promote(
        &self,
        incomplete_path: &Path,
        blob_path: &Path,
        etag: &str,
        commit: &str,
    ) -> Result<PathBuf> {
        tokio::fs::rename(incomplete_path, blob_path)
            .await
            .with_context(|| {
                format!(
                    "rename {} -> {}",
                    incomplete_path.display(),
                    blob_path.display()
                )
            })?;
        finalize_pointers(self, etag, commit, blob_path).await?;
        Ok(blob_path.to_path_buf())
    }
}

// ── Per-blob advisory locking ────────────────────────────────────────────────

/// Polls while another process downloads the same blob; at 1 s each, a 10-minute cap.
const BLOB_LOCK_MAX_POLLS: u32 = 600;
const BLOB_LOCK_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// Advisory lock held for one download attempt; dropping the `File` releases it.
struct BlobLockGuard {
    _file: std::fs::File,
}

enum LockOutcome {
    Acquired(BlobLockGuard),
    /// While waiting, the blob appeared on disk — another process finished.
    AnotherFinished,
}

/// Take an exclusive lock on `lock_path`, or poll until the blob appears or the holder dies,
/// reporting the holder's `.incomplete` size through `progress` meanwhile.
async fn acquire_blob_lock<F>(
    lock_path: &Path,
    blob_path: &Path,
    incomplete_path: &Path,
    total: u64,
    progress: &mut F,
) -> Result<LockOutcome>
where
    // The return is ignored: this only mirrors another process's progress.
    F: FnMut(u64, u64) -> bool,
{
    use fs2::FileExt as _;
    use std::fs::OpenOptions;

    if let Some(parent) = lock_path.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }

    let open_lock = || -> Result<std::fs::File> {
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .with_context(|| format!("open lock file {}", lock_path.display()))
    };

    let file = open_lock()?;
    match file.try_lock_exclusive() {
        Ok(()) => return Ok(LockOutcome::Acquired(BlobLockGuard { _file: file })),
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
        Err(e) => return Err(anyhow!("lock {}: {e}", lock_path.display())),
    }
    drop(file);

    for _ in 0..BLOB_LOCK_MAX_POLLS {
        if let Ok(meta) = tokio::fs::metadata(blob_path).await {
            if total == 0 || meta.len() == total {
                progress(meta.len(), if total == 0 { meta.len() } else { total });
                return Ok(LockOutcome::AnotherFinished);
            }
        }
        // Mirror the in-flight download's progress for UI smoothness.
        if let Ok(meta) = tokio::fs::metadata(incomplete_path).await {
            progress(meta.len(), total);
        }
        tokio::time::sleep(BLOB_LOCK_POLL_INTERVAL).await;

        // Did the holder die?
        let file = open_lock()?;
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(LockOutcome::Acquired(BlobLockGuard { _file: file })),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                drop(file);
                continue;
            }
            Err(e) => return Err(anyhow!("lock {}: {e}", lock_path.display())),
        }
    }
    Err(anyhow!(
        "timed out waiting for blob lock {} after {}s",
        lock_path.display(),
        BLOB_LOCK_MAX_POLLS as u64 * BLOB_LOCK_POLL_INTERVAL.as_secs()
    ))
}

/// Result of a manually-followed HEAD chain.
#[derive(Debug)]
struct HeadResult {
    final_url: String,
    headers: reqwest::header::HeaderMap,
    /// First `x-linked-etag` in the chain (HF's 302; an LFS sha256); the final hop lacks it.
    linked_etag: Option<String>,
    /// `x-linked-size` from the first hop that sent one, for the same reason.
    linked_size: Option<u64>,
}

impl HeadResult {
    fn headers(&self) -> &reqwest::header::HeaderMap {
        &self.headers
    }
}

/// HEAD `url`, following redirects by hand so the token only reaches HF/CloudFront hosts.
async fn head_with_redirects(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
) -> Result<HeadResult> {
    let mut current = url.to_string();
    let mut linked_etag: Option<String> = None;
    let mut linked_size: Option<u64> = None;
    for _ in 0..10 {
        let host = url::Url::parse(&current)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string));

        let mut req = client.head(&current);
        if let Some(t) = token {
            if let Some(h) = host.as_deref() {
                if should_send_auth_on_redirect(h) {
                    req = req.bearer_auth(t);
                }
            }
        }
        // Egress-gate every hop, not just `url`: an HF redirect may point at a third-party host.
        let call = pond_core::shared::services::egress::begin(&current, "HEAD")?;
        let sent = req.send().await;
        call.finish(sent.as_ref().ok().map(|r| r.status().as_u16()));
        let resp = sent.with_context(|| format!("HEAD {current}"))?;

        if linked_etag.is_none() {
            linked_etag = header_str(resp.headers(), "x-linked-etag")
                .map(normalize_etag)
                .filter(|e| !e.is_empty());
        }
        if linked_size.is_none() {
            linked_size = header_len(resp.headers(), "x-linked-size");
        }

        let status = resp.status();
        if status.is_redirection() {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| anyhow!("redirect from {current} without Location"))?;
            current = absolute_url(&current, loc)?;
            continue;
        }
        if !status.is_success() {
            return Err(anyhow!("HEAD {current} returned {status}"));
        }
        return Ok(HeadResult {
            final_url: current,
            headers: resp.headers().clone(),
            linked_etag,
            linked_size,
        });
    }
    Err(anyhow!("too many redirects following HEAD {url}"))
}

/// GET `url` following redirects like `head_with_redirects`, re-sending `Range` on every hop.
async fn get_with_redirects(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
    range: Option<&str>,
) -> Result<reqwest::Response> {
    let mut current = url.to_string();
    for _ in 0..10 {
        let host = url::Url::parse(&current)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string));

        let mut req = client.get(&current);
        if let Some(t) = token {
            if let Some(h) = host.as_deref() {
                if should_send_auth_on_redirect(h) {
                    req = req.bearer_auth(t);
                }
            }
        }
        if let Some(r) = range {
            req = req.header(reqwest::header::RANGE, r);
        }
        // Per hop, as in the HEAD loop; the file-level egress guard can't see a missed site.
        let call = pond_core::shared::services::egress::begin(&current, "GET")?;
        let sent = req.send().await;
        call.finish(sent.as_ref().ok().map(|r| r.status().as_u16()));
        let resp = sent.with_context(|| format!("GET {current}"))?;
        let status = resp.status();
        if status.is_redirection() {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| anyhow!("redirect from {current} without Location"))?;
            current = absolute_url(&current, loc)?;
            continue;
        }
        if range.is_some() && status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            return Ok(resp);
        }
        if !status.is_success() && status.as_u16() != 206 {
            return Err(anyhow!("GET {current} returned {status}"));
        }
        return Ok(resp);
    }
    Err(anyhow!("too many redirects following GET {url}"))
}

/// Resolve a possibly relative `Location` header against the current URL.
fn absolute_url(current: &str, location: &str) -> Result<String> {
    let base = url::Url::parse(current).map_err(|e| anyhow!("parse {current}: {e}"))?;
    let joined = base
        .join(location)
        .map_err(|e| anyhow!("join {location} onto {current}: {e}"))?;
    Ok(joined.into())
}

/// Write `refs/{branch}` and create the snapshot symlink pointing at the blob.
async fn finalize_pointers(
    fetch: &HfFetch<'_>,
    _etag: &str,
    commit: &str,
    blob_path: &Path,
) -> Result<()> {
    let refs_path = fetch.repo.refs_path("main");
    if let Some(parent) = refs_path.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    tokio::fs::write(&refs_path, commit.as_bytes())
        .await
        .with_context(|| format!("write {}", refs_path.display()))?;

    let pointer = fetch.pointer_path(commit);
    if let Some(parent) = pointer.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    // Best-effort cleanup of stale pointer (symlink or file) before recreating.
    let _ = tokio::fs::remove_file(&pointer).await;

    let blob = blob_path.to_path_buf();
    let ptr = pointer.clone();
    tokio::task::spawn_blocking(move || create_pointer(&blob, &ptr))
        .await
        .map_err(|e| anyhow!("pointer task panicked: {e}"))??;
    Ok(())
}

#[cfg(unix)]
fn create_pointer(blob: &Path, pointer: &Path) -> Result<()> {
    std::os::unix::fs::symlink(blob, pointer)
        .with_context(|| format!("symlink {} -> {}", pointer.display(), blob.display()))
}

#[cfg(not(unix))]
fn create_pointer(blob: &Path, pointer: &Path) -> Result<()> {
    std::fs::copy(blob, pointer)
        .map(|_| ())
        .with_context(|| format!("copy {} -> {}", blob.display(), pointer.display()))
}

// ── Linking a blob to a flat path ────────────────────────────────────────────

/// Symlink `dest` to `blob`, replacing only a symlink; anything else is [`DestNotALink`].
/// Swaps by rename; a file racing in after the check is replaced (macOS lacks renameat2).
pub async fn link_blob(blob: &Path, dest: &Path) -> Result<()> {
    let blob = blob.to_path_buf();
    let dest = dest.to_path_buf();
    tokio::task::spawn_blocking(move || link_blob_blocking(&blob, &dest))
        .await
        .map_err(|e| anyhow!("link task panicked: {e}"))?
}

fn link_blob_blocking(blob: &Path, dest: &Path) -> Result<()> {
    let meta = std::fs::metadata(blob).with_context(|| format!("blob {}", blob.display()))?;
    if !meta.is_file() {
        return Err(anyhow!("blob {} is not a file", blob.display()));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create link dir {}", parent.display()))?;
    }
    match std::fs::symlink_metadata(dest) {
        Ok(m) if m.file_type().is_symlink() => {
            if std::fs::read_link(dest).ok().as_deref() == Some(blob) {
                return Ok(());
            }
            replace_link(blob, dest)
        }
        Ok(_) => Err(anyhow::Error::new(DestNotALink {
            path: dest.to_path_buf(),
        })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => create_pointer(blob, dest),
        Err(e) => Err(anyhow!(e).context(format!("inspect {}", dest.display()))),
    }
}

/// Swap `dest`'s symlink for one to `blob` by renaming a new link over it.
#[cfg(unix)]
fn replace_link(blob: &Path, dest: &Path) -> Result<()> {
    let name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow!("link path has no file name: {}", dest.display()))?;
    let staged = dest.with_file_name(format!(".{name}.link-{}", std::process::id()));
    // Leftover staging link from a crashed attempt with this pid; never a regular file.
    if std::fs::symlink_metadata(&staged).is_ok_and(|m| m.file_type().is_symlink()) {
        let _ = std::fs::remove_file(&staged);
    }
    std::os::unix::fs::symlink(blob, &staged)
        .with_context(|| format!("symlink {} -> {}", staged.display(), blob.display()))?;
    std::fs::rename(&staged, dest).map_err(|e| {
        let _ = std::fs::remove_file(&staged);
        anyhow!(e).context(format!("rename {} -> {}", staged.display(), dest.display()))
    })
}

/// Without symlinks the "link" is a copy; `dest` is known to be one, so removing it is safe.
#[cfg(not(unix))]
fn replace_link(blob: &Path, dest: &Path) -> Result<()> {
    std::fs::remove_file(dest).with_context(|| format!("remove link {}", dest.display()))?;
    create_pointer(blob, dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::tempdir;

    // Env var manipulation must be serialised — Rust tests run in parallel.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Snapshot + clear the env vars this module reads, restoring on drop.
    struct EnvGuard {
        saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl EnvGuard {
        fn new() -> Self {
            let lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let vars = [
                "HF_HOME",
                "HF_TOKEN",
                "HUGGING_FACE_HUB_TOKEN",
                "HUGGINGFACE_TOKEN",
            ];
            let saved: Vec<_> = vars.iter().map(|v| (*v, std::env::var_os(v))).collect();
            for (v, _) in &saved {
                std::env::remove_var(v);
            }
            Self { saved, _lock: lock }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (v, old) in &self.saved {
                match old {
                    Some(val) => std::env::set_var(v, val),
                    None => std::env::remove_var(v),
                }
            }
        }
    }

    #[test]
    fn folder_name_encodes_slashes() {
        let _g = EnvGuard::new();
        let tmp = tempdir().unwrap();
        let cache = HfCache::new(tmp.path());
        let repo = cache.repo("bartowski/gemma-4-E2B-it-GGUF");
        assert_eq!(repo.folder_name(), "models--bartowski--gemma-4-E2B-it-GGUF");
    }

    #[test]
    fn folder_name_for_simple_repo() {
        let _g = EnvGuard::new();
        let tmp = tempdir().unwrap();
        let cache = HfCache::new(tmp.path());
        let repo = cache.repo("gpt2");
        assert_eq!(repo.folder_name(), "models--gpt2");
    }

    #[test]
    fn default_root_under_data_dir() {
        let _g = EnvGuard::new();
        let tmp = tempdir().unwrap();
        let cache = HfCache::new(tmp.path());
        assert_eq!(cache.root(), tmp.path().join("hf_cache"));
        assert_eq!(cache.hub_dir(), tmp.path().join("hf_cache").join("hub"));
    }

    #[test]
    fn hf_home_env_overrides_default() {
        let _g = EnvGuard::new();
        let tmp = tempdir().unwrap();
        let override_root = tmp.path().join("custom_hf");
        std::env::set_var("HF_HOME", &override_root);
        let cache = HfCache::new(tmp.path());
        assert_eq!(cache.root(), override_root.as_path());
        assert_eq!(cache.hub_dir(), override_root.join("hub"));
    }

    #[test]
    fn token_file_is_read() {
        let _g = EnvGuard::new();
        let tmp = tempdir().unwrap();
        let root = tmp.path().join("hf_cache");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("token"), "  hf_abc123\n").unwrap();
        let cache = HfCache::new(tmp.path());
        assert_eq!(cache.token(), Some("hf_abc123"));
    }

    #[test]
    fn empty_token_file_returns_none() {
        let _g = EnvGuard::new();
        let tmp = tempdir().unwrap();
        let root = tmp.path().join("hf_cache");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("token"), "   \n  \t  ").unwrap();
        let cache = HfCache::new(tmp.path());
        assert_eq!(cache.token(), None);
    }

    #[test]
    fn env_var_takes_precedence_over_token_file() {
        let _g = EnvGuard::new();
        let tmp = tempdir().unwrap();
        let root = tmp.path().join("hf_cache");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("token"), "from_file").unwrap();
        std::env::set_var("HF_TOKEN", "from_env");
        let cache = HfCache::new(tmp.path());
        assert_eq!(cache.token(), Some("from_env"));
    }

    #[test]
    fn url_with_default_revision() {
        let _g = EnvGuard::new();
        let tmp = tempdir().unwrap();
        let cache = HfCache::new(tmp.path());
        let repo = cache.repo("bartowski/foo");
        let fetch = repo.file("bar.gguf");
        assert_eq!(
            fetch.url(),
            "https://huggingface.co/bartowski/foo/resolve/main/bar.gguf"
        );
    }

    #[test]
    fn url_with_branch_slashes_url_escapes() {
        let _g = EnvGuard::new();
        let tmp = tempdir().unwrap();
        let cache = HfCache::new(tmp.path());
        let repo = cache.repo("bartowski/foo").with_revision("feature/x");
        let fetch = repo.file("bar.gguf");
        assert_eq!(
            fetch.url(),
            "https://huggingface.co/bartowski/foo/resolve/feature%2Fx/bar.gguf"
        );
    }

    #[test]
    fn parse_hf_url_simple() {
        let (repo, rev, file) =
            parse_hf_url("https://huggingface.co/bartowski/foo/resolve/main/bar.gguf").unwrap();
        assert_eq!(repo, "bartowski/foo");
        assert_eq!(rev, "main");
        assert_eq!(file, "bar.gguf");
    }

    #[test]
    fn parse_hf_url_subfolder_file() {
        let (repo, rev, file) = parse_hf_url(
            "https://huggingface.co/immich-app/antelopev2/resolve/main/recognition/model.onnx",
        )
        .unwrap();
        assert_eq!(repo, "immich-app/antelopev2");
        assert_eq!(rev, "main");
        assert_eq!(file, "recognition/model.onnx");
    }

    #[test]
    fn parse_hf_url_revision_with_encoded_slash() {
        let (repo, rev, file) =
            parse_hf_url("https://huggingface.co/foo/bar/resolve/refs%2Fpr%2F123/model.gguf")
                .unwrap();
        assert_eq!(repo, "foo/bar");
        assert_eq!(rev, "refs/pr/123");
        assert_eq!(file, "model.gguf");
    }

    #[test]
    fn parse_hf_url_non_hf_returns_none() {
        assert!(parse_hf_url("https://example.com/foo/bar/resolve/main/x.bin").is_none());
        assert!(parse_hf_url("https://github.com/owner/repo/releases/download/v1/x").is_none());
    }

    #[test]
    fn parse_hf_url_missing_segments_returns_none() {
        assert!(parse_hf_url("https://huggingface.co/foo/bar").is_none());
        assert!(parse_hf_url("https://huggingface.co/foo/bar/resolve/main/").is_none());
        assert!(parse_hf_url("https://huggingface.co/foo/bar/blob/main/x").is_none());
    }

    #[test]
    fn auth_redirect_policy_allows_hf_and_cdn_hosts() {
        assert!(should_send_auth_on_redirect("huggingface.co"));
        assert!(should_send_auth_on_redirect("cdn-lfs.huggingface.co"));
        assert!(should_send_auth_on_redirect(
            "d2l4uplgqnwxzd.cloudfront.net"
        ));
        assert!(should_send_auth_on_redirect("HUGGINGFACE.CO"));
    }

    #[test]
    fn auth_redirect_policy_blocks_other_hosts() {
        assert!(!should_send_auth_on_redirect("evil.com"));
        assert!(!should_send_auth_on_redirect("example.org"));
        assert!(!should_send_auth_on_redirect("127.0.0.1"));
        assert!(!should_send_auth_on_redirect("localhost"));
        // Substring trickery: "huggingface.co.evil.com" is NOT an HF host.
        assert!(!should_send_auth_on_redirect("huggingface.co.evil.com"));
    }

    #[test]
    fn blob_and_pointer_paths_join_correctly() {
        let _g = EnvGuard::new();
        let tmp = tempdir().unwrap();
        let cache = HfCache::new(tmp.path());
        let repo = cache.repo("bartowski/gemma-4-E2B-it-GGUF");
        let folder = tmp
            .path()
            .join("hf_cache")
            .join("hub")
            .join("models--bartowski--gemma-4-E2B-it-GGUF");

        assert_eq!(repo.folder_path(), folder);
        assert_eq!(repo.refs_path("main"), folder.join("refs").join("main"));
        assert_eq!(
            repo.snapshot_dir("abc123"),
            folder.join("snapshots").join("abc123")
        );
        assert_eq!(
            repo.blob_path("deadbeef"),
            folder.join("blobs").join("deadbeef")
        );

        let fetch = repo.file("gemma-4-E2B-it-Q4_K_M.gguf");
        assert_eq!(
            fetch.pointer_path("abc123"),
            folder
                .join("snapshots")
                .join("abc123")
                .join("gemma-4-E2B-it-Q4_K_M.gguf")
        );
        assert_eq!(
            fetch.blob_path("deadbeef"),
            folder.join("blobs").join("deadbeef")
        );
    }

    // ── Network-mode gate, per redirect hop ─────────────────────────────────
    // Behavioural, one test per site: `egress_guard.rs` only checks the file mentions a tracker.
    // `network_mode` is process-global; a test wanting a different mode needs serialising.

    use pond_core::shared::services::egress::{network_mode, set_network_mode, NetworkMode};
    use wiremock::matchers::{method as wm_method, path as wm_path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    static MODE_LOCK: Mutex<()> = Mutex::new(());

    /// Restores `NetworkMode::Open` on drop, so a panicking test can't leave the binary offline.
    /// The mode is restored before the lock is released (fields drop after `drop` runs).
    struct ModeGuard {
        previous: NetworkMode,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl ModeGuard {
        fn set(mode: NetworkMode) -> Self {
            let lock = MODE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let previous = network_mode();
            set_network_mode(mode);
            Self {
                previous,
                _lock: lock,
            }
        }
    }

    impl Drop for ModeGuard {
        fn drop(&mut self) {
            set_network_mode(self.previous);
        }
    }

    /// A loopback server that 302s to `location`.
    async fn redirector(location: &str) -> MockServer {
        let server = MockServer::start().await;
        Mock::given(wm_method("HEAD"))
            .and(wm_path("/start"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", location))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/start"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", location))
            .mount(&server)
            .await;
        server
    }

    #[tokio::test]
    async fn head_redirect_to_a_non_loopback_host_is_refused_at_the_hop() {
        // `.invalid` never resolves (RFC 2606), so a missed gate fails with a DNS error instead.
        let server = redirector("https://cdn.invalid/blob").await;
        let _mode = ModeGuard::set(NetworkMode::Allowlist);

        let client = build_redirect_aware_client(None).expect("client builds");
        let err = head_with_redirects(&client, &format!("{}/start", server.uri()), None)
            .await
            .expect_err("the second hop leaves loopback and must be refused");

        let rendered = format!("{err:#}");
        assert!(
            rendered.contains("cdn.invalid"),
            "the refusal must name the host it refused: {rendered}"
        );
        assert!(
            rendered.contains("network_mode") && rendered.contains("allowlist"),
            "the refusal must name the setting and its value, or it is \
             indistinguishable from the network being down: {rendered}"
        );
    }

    #[tokio::test]
    async fn get_redirect_to_a_non_loopback_host_is_refused_at_the_hop() {
        let server = redirector("https://cdn.invalid/blob").await;
        let _mode = ModeGuard::set(NetworkMode::Allowlist);

        let client = build_redirect_aware_client(None).expect("client builds");
        let err = get_with_redirects(&client, &format!("{}/start", server.uri()), None, None)
            .await
            .expect_err("the second hop leaves loopback and must be refused");

        let rendered = format!("{err:#}");
        assert!(
            rendered.contains("cdn.invalid"),
            "the refusal must name the host it refused: {rendered}"
        );
        assert!(
            rendered.contains("network_mode") && rendered.contains("allowlist"),
            "the refusal must name the setting and its value: {rendered}"
        );
    }

    /// Vacuity control: a gate refusing every hop would pass the two tests above.
    #[tokio::test]
    async fn a_permitted_redirect_chain_still_completes() {
        let destination = MockServer::start().await;
        Mock::given(wm_method("HEAD"))
            .and(wm_path("/blob"))
            .respond_with(ResponseTemplate::new(200).insert_header("etag", "\"deadbeef\""))
            .mount(&destination)
            .await;
        let hop = format!("{}/blob", destination.uri());
        let server = redirector(&hop).await;
        let _mode = ModeGuard::set(NetworkMode::Allowlist);

        let client = build_redirect_aware_client(None).expect("client builds");
        let head = head_with_redirects(&client, &format!("{}/start", server.uri()), None)
            .await
            .expect("loopback to loopback is permitted under allowlist");

        assert_eq!(head.final_url, hop);
        assert_eq!(
            head.headers().get("etag").and_then(|v| v.to_str().ok()),
            Some("\"deadbeef\"")
        );
    }

    // ── The transfer rules, driven through the real algorithm ───────────────
    // Add transfer tests here: `tests/hf_cache_integration_test.rs` only tests a copy of it.

    use pond_core::shared::services::egress::EgressDenied;
    use std::sync::Arc;
    use wiremock::matchers::header as wm_header;

    const FILE_ETAG: &str = "0123abcd";
    const FILE_PATH: &str = "/owner/repo/resolve/main/weights.bin";

    /// A cache in `dir` with `HF_HOME` and token vars cleared, so a real cache is never written.
    /// The env lock is dropped before any await; the cache reads the env only in `new`.
    fn scratch_cache(dir: &Path) -> HfCache {
        let _g = EnvGuard::new();
        HfCache::new(dir)
    }

    fn file_bytes(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i % 251) as u8).collect()
    }

    /// The HEAD answer for the file: its etag and, when given, its length.
    fn head_answer(len: Option<u64>) -> ResponseTemplate {
        let answer = ResponseTemplate::new(200).insert_header("etag", format!("\"{FILE_ETAG}\""));
        match len {
            Some(n) => answer.insert_header("content-length", n.to_string()),
            None => answer,
        }
    }

    /// Run one download, recording every progress call and always going on.
    async fn run(fetch: &HfFetch<'_>, url: &str) -> (Result<PathBuf>, Vec<(u64, u64)>) {
        let client = build_redirect_aware_client(None).expect("client builds");
        let mut calls = Vec::new();
        let result = fetch
            .download_to_blob_from(url, &client, None, |n, t| {
                calls.push((n, t));
                true
            })
            .await;
        (result, calls)
    }

    fn incomplete_of(repo: &HfRepo<'_>, etag: &str) -> PathBuf {
        repo.blob_path(etag)
            .with_file_name(format!("{etag}.incomplete"))
    }

    async fn seed(path: &Path, contents: &[u8]) {
        tokio::fs::create_dir_all(path.parent().expect("has a parent"))
            .await
            .expect("create parent");
        tokio::fs::write(path, contents).await.expect("seed file");
    }

    fn expect_transfer_error(result: Result<PathBuf>) -> TransferError {
        let err = result.expect_err("the transfer must not succeed");
        transfer_error(&err)
            .cloned()
            .unwrap_or_else(|| panic!("expected a TransferError, got: {err:#}"))
    }

    fn get_requests(requests: &[wiremock::Request]) -> Vec<&wiremock::Request> {
        requests
            .iter()
            .filter(|r| r.method.as_str() == "GET")
            .collect()
    }

    /// One raw HTTP/1.1 answer, closed after sending.
    fn close_delimited(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
        let mut out =
            format!("HTTP/1.1 {status}\r\n{headers}connection: close\r\n\r\n").into_bytes();
        out.extend_from_slice(body);
        out
    }

    /// Scripted loopback server for what wiremock can't do: a close-delimited body cut short.
    /// Every HEAD gets `head`, each GET the next of `gets`; returns the URL and request heads.
    async fn scripted_server(
        head: Vec<u8>,
        gets: Vec<Vec<u8>>,
    ) -> (String, Arc<Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback");
        let addr = listener.local_addr().expect("local addr");
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let log = Arc::clone(&seen);
        let mut gets = std::collections::VecDeque::from(gets);
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut request = Vec::new();
                let mut buf = [0u8; 1024];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                let request = String::from_utf8_lossy(&request).into_owned();
                let reply = if request.starts_with("HEAD ") {
                    head.clone()
                } else {
                    gets.pop_front().unwrap_or_else(|| {
                        close_delimited("500 Internal Server Error", "content-length: 0\r\n", b"")
                    })
                };
                log.lock().unwrap_or_else(|e| e.into_inner()).push(request);
                let _ = sock.write_all(&reply).await;
                let _ = sock.shutdown().await;
            }
        });
        (format!("http://{addr}{FILE_PATH}"), seen)
    }

    #[tokio::test]
    async fn a_short_body_keeps_the_incomplete_and_errors_then_resumes() {
        let full = file_bytes(1000);
        let head = close_delimited(
            "200 OK",
            &format!("etag: \"{FILE_ETAG}\"\r\ncontent-length: 1000\r\n"),
            b"",
        );
        let (url, seen) = scripted_server(
            head,
            vec![
                close_delimited("200 OK", "", &full[..600]),
                close_delimited(
                    "206 Partial Content",
                    "content-range: bytes 600-999/1000\r\ncontent-length: 400\r\n",
                    &full[600..],
                ),
            ],
        )
        .await;
        let tmp = tempdir().unwrap();
        let cache = scratch_cache(tmp.path());
        let repo = cache.repo("owner/repo");
        let fetch = repo.file("weights.bin");

        let (first, _) = run(&fetch, &url).await;
        assert_eq!(
            expect_transfer_error(first),
            TransferError::Short {
                received: 600,
                total: 1000
            },
            "a body that ends early without an error must not be taken for the file"
        );
        let kept = tokio::fs::read(incomplete_of(&repo, FILE_ETAG))
            .await
            .expect("the .incomplete is kept for the resume");
        assert_eq!(kept, &full[..600]);
        assert!(!repo.blob_path(FILE_ETAG).exists(), "never renamed");

        let (second, _) = run(&fetch, &url).await;
        let blob = second.expect("the second call resumes and finishes");
        assert_eq!(tokio::fs::read(&blob).await.unwrap(), full);
        let last_get = seen
            .lock()
            .unwrap()
            .iter()
            .rfind(|r| r.starts_with("GET "))
            .cloned()
            .expect("a GET was made");
        assert!(
            last_get.to_ascii_lowercase().contains("range: bytes=600-"),
            "the resume must ask for the rest of the prefix: {last_get}"
        );
    }

    #[tokio::test]
    async fn a_200_answer_to_a_range_request_truncates_instead_of_appending() {
        let server = MockServer::start().await;
        let full = file_bytes(1000);
        Mock::given(wm_method("HEAD"))
            .respond_with(head_answer(Some(1000)))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_header("range", "bytes=400-"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(full.clone()))
            .expect(1)
            .mount(&server)
            .await;
        let tmp = tempdir().unwrap();
        let cache = scratch_cache(tmp.path());
        let repo = cache.repo("owner/repo");
        let fetch = repo.file("weights.bin");
        seed(&incomplete_of(&repo, FILE_ETAG), &[0xEE; 400]).await;

        let (result, _) = run(&fetch, &format!("{}{FILE_PATH}", server.uri())).await;
        let blob = result.expect("a whole-file answer completes the download");
        let got = tokio::fs::read(&blob).await.unwrap();
        assert_eq!(got.len(), 1000, "appended would be 1400 bytes");
        assert_eq!(got, full, "the stale prefix must be gone");
    }

    #[tokio::test]
    async fn a_whole_incomplete_is_renamed_without_a_get() {
        let server = MockServer::start().await;
        let full = file_bytes(1000);
        Mock::given(wm_method("HEAD"))
            .respond_with(head_answer(Some(1000)))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;
        let tmp = tempdir().unwrap();
        let cache = scratch_cache(tmp.path());
        let repo = cache.repo("owner/repo");
        let fetch = repo.file("weights.bin");
        let incomplete = incomplete_of(&repo, FILE_ETAG);
        seed(&incomplete, &full).await;

        let (result, calls) = run(&fetch, &format!("{}{FILE_PATH}", server.uri())).await;
        let blob = result.expect("a whole .incomplete is the file");
        assert_eq!(blob, repo.blob_path(FILE_ETAG));
        assert_eq!(tokio::fs::read(&blob).await.unwrap(), full);
        assert!(!incomplete.exists(), "renamed, not copied");
        assert_eq!(calls.last(), Some(&(1000, 1000)));
    }

    #[tokio::test]
    async fn an_incomplete_longer_than_the_file_starts_over_without_range() {
        let server = MockServer::start().await;
        let full = file_bytes(1000);
        Mock::given(wm_method("HEAD"))
            .respond_with(head_answer(Some(1000)))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(full.clone()))
            .mount(&server)
            .await;
        let tmp = tempdir().unwrap();
        let cache = scratch_cache(tmp.path());
        let repo = cache.repo("owner/repo");
        let fetch = repo.file("weights.bin");
        seed(&incomplete_of(&repo, FILE_ETAG), &[0xEE; 1200]).await;

        let (result, _) = run(&fetch, &format!("{}{FILE_PATH}", server.uri())).await;
        let blob = result.expect("starting over completes the download");
        assert_eq!(tokio::fs::read(&blob).await.unwrap(), full);
        let requests = server.received_requests().await.unwrap_or_default();
        let gets = get_requests(&requests);
        assert_eq!(gets.len(), 1);
        assert!(
            gets[0].headers.get("range").is_none(),
            "a prefix longer than the file must not be resumed from"
        );
    }

    #[tokio::test]
    async fn an_expect_size_that_disagrees_with_the_head_refuses_before_any_transfer() {
        let server = MockServer::start().await;
        Mock::given(wm_method("HEAD"))
            .respond_with(head_answer(Some(1000)))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;
        let tmp = tempdir().unwrap();
        let cache = scratch_cache(tmp.path());
        let repo = cache.repo("owner/repo");
        let fetch = repo.file("weights.bin").expect_size(999);

        let (result, _) = run(&fetch, &format!("{}{FILE_PATH}", server.uri())).await;
        assert_eq!(
            expect_transfer_error(result),
            TransferError::SizeMismatch {
                expected: 999,
                actual: 1000
            }
        );
        assert!(!incomplete_of(&repo, FILE_ETAG).exists());
        assert!(!repo.blob_path(FILE_ETAG).exists());
    }

    /// The unpinned control half shows the refusal is the pin's doing, not another check's.
    #[tokio::test]
    async fn expect_size_supplies_the_length_the_head_left_out() {
        let full = file_bytes(1000);
        let head = close_delimited("200 OK", &format!("etag: \"{FILE_ETAG}\"\r\n"), b"");
        let short = close_delimited("200 OK", "", &full[..600]);

        let (url, _) = scripted_server(head.clone(), vec![short.clone()]).await;
        let tmp = tempdir().unwrap();
        let cache = scratch_cache(tmp.path());
        let repo = cache.repo("owner/repo");
        let pinned = repo.file("weights.bin").expect_size(1000);
        let (result, _) = run(&pinned, &url).await;
        assert_eq!(
            expect_transfer_error(result),
            TransferError::Short {
                received: 600,
                total: 1000
            }
        );

        let (url, _) = scripted_server(head, vec![short]).await;
        let tmp = tempdir().unwrap();
        let cache = scratch_cache(tmp.path());
        let repo = cache.repo("owner/repo");
        let unpinned = repo.file("weights.bin");
        let (result, _) = run(&unpinned, &url).await;
        let blob = result.expect("with no length anywhere, what arrives is accepted");
        assert_eq!(tokio::fs::metadata(&blob).await.unwrap().len(), 600);
    }

    #[tokio::test]
    async fn the_fast_path_refuses_a_blob_whose_length_differs_from_the_pin() {
        let server = MockServer::start().await;
        let full = file_bytes(1000);
        Mock::given(wm_method("HEAD"))
            .respond_with(head_answer(None))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(full.clone()))
            .expect(1)
            .mount(&server)
            .await;
        let tmp = tempdir().unwrap();
        let cache = scratch_cache(tmp.path());
        let repo = cache.repo("owner/repo");
        let fetch = repo.file("weights.bin").expect_size(1000);
        seed(&repo.blob_path(FILE_ETAG), &full[..500]).await;

        let (result, _) = run(&fetch, &format!("{}{FILE_PATH}", server.uri())).await;
        let blob = result.expect("the short blob is replaced by the file");
        assert_eq!(tokio::fs::read(&blob).await.unwrap(), full);
    }

    #[tokio::test]
    async fn an_etag_that_differs_from_the_pin_refuses_before_any_transfer() {
        let server = MockServer::start().await;
        Mock::given(wm_method("HEAD"))
            .respond_with(head_answer(Some(1000)))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;
        let tmp = tempdir().unwrap();
        let cache = scratch_cache(tmp.path());
        let repo = cache.repo("owner/repo");
        let fetch = repo.file("weights.bin").expect_etag("\"ffff0000\"");
        // A blob already on disk under the pin must not short-circuit it.
        seed(&repo.blob_path("ffff0000"), &file_bytes(1000)).await;

        let (result, _) = run(&fetch, &format!("{}{FILE_PATH}", server.uri())).await;
        assert_eq!(
            expect_transfer_error(result),
            TransferError::EtagMismatch {
                expected: "ffff0000".to_string(),
                found: vec![FILE_ETAG.to_string()],
            }
        );
        assert!(!incomplete_of(&repo, "ffff0000").exists());
    }

    /// HF's LFS shape: the 302 sends the sha256 as `x-linked-etag`, the CDN its own `etag`.
    #[tokio::test]
    async fn a_pin_matched_by_the_first_hops_linked_etag_names_the_blob() {
        let full = file_bytes(1000);
        let cdn = MockServer::start().await;
        Mock::given(wm_method("HEAD"))
            .and(wm_path("/blob"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("etag", "\"feedface\"")
                    .insert_header("content-length", "1000"),
            )
            .mount(&cdn)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/blob"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(full.clone()))
            .mount(&cdn)
            .await;
        let origin = MockServer::start().await;
        Mock::given(wm_method("HEAD"))
            .and(wm_path(FILE_PATH))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("location", format!("{}/blob", cdn.uri()))
                    .insert_header("x-linked-etag", "\"A402F10F\"")
                    .insert_header("x-linked-size", "1000"),
            )
            .mount(&origin)
            .await;
        let url = format!("{}{FILE_PATH}", origin.uri());

        let tmp = tempdir().unwrap();
        let cache = scratch_cache(tmp.path());
        let repo = cache.repo("owner/repo");
        let pinned = repo.file("weights.bin").expect_etag("a402f10f");
        let (result, _) = run(&pinned, &url).await;
        let blob = result.expect("the first hop's linked etag matches the pin");
        assert_eq!(
            blob.file_name().and_then(|n| n.to_str()),
            Some("a402f10f"),
            "the blob is named by the pin, not by the CDN's hash"
        );
        assert_eq!(tokio::fs::read(&blob).await.unwrap(), full);

        let tmp = tempdir().unwrap();
        let cache = scratch_cache(tmp.path());
        let repo = cache.repo("owner/repo");
        let unpinned = repo.file("weights.bin");
        let (result, _) = run(&unpinned, &url).await;
        let blob = result.expect("unpinned downloads are unchanged");
        assert_eq!(blob.file_name().and_then(|n| n.to_str()), Some("feedface"));
    }

    #[tokio::test]
    async fn the_first_hops_linked_size_stands_in_for_a_missing_length() {
        let full = file_bytes(1000);
        let head = close_delimited("200 OK", &format!("etag: \"{FILE_ETAG}\"\r\n"), b"");
        let (cdn_url, _) =
            scripted_server(head, vec![close_delimited("200 OK", "", &full[..600])]).await;
        let origin = MockServer::start().await;
        Mock::given(wm_method("HEAD"))
            .and(wm_path(FILE_PATH))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("location", cdn_url.as_str())
                    .insert_header("x-linked-size", "1000"),
            )
            .mount(&origin)
            .await;
        let tmp = tempdir().unwrap();
        let cache = scratch_cache(tmp.path());
        let repo = cache.repo("owner/repo");
        let fetch = repo.file("weights.bin");

        let (result, _) = run(&fetch, &format!("{}{FILE_PATH}", origin.uri())).await;
        assert_eq!(
            expect_transfer_error(result),
            TransferError::Short {
                received: 600,
                total: 1000
            }
        );
    }

    #[tokio::test]
    async fn a_get_whose_length_disagrees_with_the_head_refuses_before_writing() {
        let server = MockServer::start().await;
        let full = file_bytes(1000);
        Mock::given(wm_method("HEAD"))
            .respond_with(head_answer(Some(1000)))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(file_bytes(1200)))
            .mount(&server)
            .await;
        let tmp = tempdir().unwrap();
        let cache = scratch_cache(tmp.path());
        let repo = cache.repo("owner/repo");
        let fetch = repo.file("weights.bin");
        let incomplete = incomplete_of(&repo, FILE_ETAG);
        seed(&incomplete, &full[..400]).await;

        let (result, _) = run(&fetch, &format!("{}{FILE_PATH}", server.uri())).await;
        assert_eq!(
            expect_transfer_error(result),
            TransferError::SizeMismatch {
                expected: 1000,
                actual: 1200
            }
        );
        assert_eq!(
            tokio::fs::read(&incomplete).await.unwrap(),
            &full[..400],
            "the prefix on disk is untouched"
        );
    }

    #[tokio::test]
    async fn a_body_longer_than_the_file_deletes_the_incomplete() {
        let head = close_delimited(
            "200 OK",
            &format!("etag: \"{FILE_ETAG}\"\r\ncontent-length: 1000\r\n"),
            b"",
        );
        let (url, _) =
            scripted_server(head, vec![close_delimited("200 OK", "", &file_bytes(1200))]).await;
        let tmp = tempdir().unwrap();
        let cache = scratch_cache(tmp.path());
        let repo = cache.repo("owner/repo");
        let fetch = repo.file("weights.bin");

        let (result, _) = run(&fetch, &url).await;
        let err = expect_transfer_error(result);
        assert!(
            matches!(err, TransferError::Overlong { total: 1000, received } if received > 1000),
            "{err:?}"
        );
        assert!(!incomplete_of(&repo, FILE_ETAG).exists());
        assert!(!repo.blob_path(FILE_ETAG).exists());
    }

    #[tokio::test]
    async fn a_partial_answer_from_the_wrong_offset_refuses_and_keeps_the_prefix() {
        let server = MockServer::start().await;
        let full = file_bytes(1000);
        Mock::given(wm_method("HEAD"))
            .respond_with(head_answer(Some(1000)))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .respond_with(
                ResponseTemplate::new(206)
                    .insert_header("content-range", "bytes 0-999/1000")
                    .set_body_bytes(full.clone()),
            )
            .mount(&server)
            .await;
        let tmp = tempdir().unwrap();
        let cache = scratch_cache(tmp.path());
        let repo = cache.repo("owner/repo");
        let fetch = repo.file("weights.bin");
        let incomplete = incomplete_of(&repo, FILE_ETAG);
        seed(&incomplete, &full[..400]).await;

        let (result, _) = run(&fetch, &format!("{}{FILE_PATH}", server.uri())).await;
        assert_eq!(
            expect_transfer_error(result),
            TransferError::RangeMismatch {
                requested: 400,
                answered: Some(0)
            }
        );
        assert_eq!(tokio::fs::read(&incomplete).await.unwrap(), &full[..400]);
    }

    /// With no known length, a whole prefix can only be settled at the 416.
    #[tokio::test]
    async fn a_416_for_a_whole_incomplete_of_unknown_length_renames_it() {
        let server = MockServer::start().await;
        let full = file_bytes(1000);
        Mock::given(wm_method("HEAD"))
            .respond_with(head_answer(None))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_header("range", "bytes=1000-"))
            .respond_with(ResponseTemplate::new(416).insert_header("content-range", "bytes */1000"))
            .expect(1)
            .mount(&server)
            .await;
        let tmp = tempdir().unwrap();
        let cache = scratch_cache(tmp.path());
        let repo = cache.repo("owner/repo");
        let fetch = repo.file("weights.bin");
        seed(&incomplete_of(&repo, FILE_ETAG), &full).await;

        let (result, _) = run(&fetch, &format!("{}{FILE_PATH}", server.uri())).await;
        let blob = result.expect("the server confirms the prefix is the whole file");
        assert_eq!(tokio::fs::read(&blob).await.unwrap(), full);
    }

    /// The stop lands after the last byte, so the next call needs no GET.
    #[tokio::test]
    async fn stopping_keeps_the_incomplete_and_the_next_call_uses_it() {
        let server = MockServer::start().await;
        let full = file_bytes(1000);
        Mock::given(wm_method("HEAD"))
            .respond_with(head_answer(Some(1000)))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(full.clone()))
            .expect(1)
            .mount(&server)
            .await;
        let tmp = tempdir().unwrap();
        let cache = scratch_cache(tmp.path());
        let repo = cache.repo("owner/repo");
        let fetch = repo.file("weights.bin");
        let url = format!("{}{FILE_PATH}", server.uri());
        let client = build_redirect_aware_client(None).expect("client builds");

        let err = fetch
            .download_to_blob_from(&url, &client, None, |n, _| n == 0)
            .await
            .expect_err("the callback stops once bytes arrive");
        assert!(is_stopped(&err), "{err:#}");
        let kept = tokio::fs::metadata(incomplete_of(&repo, FILE_ETAG))
            .await
            .expect("a stop keeps the .incomplete");
        assert!(kept.len() > 0);
        assert!(!repo.blob_path(FILE_ETAG).exists());

        let (result, _) = run(&fetch, &url).await;
        let blob = result.expect("the paused download finishes");
        assert_eq!(tokio::fs::read(&blob).await.unwrap(), full);
    }

    /// The adapter downcasts to `EgressDenied` to tell a blocked mode from a down network.
    #[tokio::test]
    async fn a_hop_the_network_mode_refuses_surfaces_as_egress_denied() {
        let server = redirector("https://cdn.invalid/blob").await;
        let _mode = ModeGuard::set(NetworkMode::Allowlist);
        let tmp = tempdir().unwrap();
        let cache = scratch_cache(tmp.path());
        let repo = cache.repo("owner/repo");
        let fetch = repo.file("weights.bin");

        let (result, _) = run(&fetch, &format!("{}/start", server.uri())).await;
        let err = result.expect_err("the second hop leaves loopback");
        let denied = err
            .downcast_ref::<EgressDenied>()
            .unwrap_or_else(|| panic!("expected EgressDenied, got: {err:#}"));
        assert_eq!(denied.host, "cdn.invalid");
        assert_eq!(denied.mode, NetworkMode::Allowlist);
    }

    #[tokio::test]
    async fn an_etag_that_would_escape_the_blobs_dir_is_refused() {
        let server = MockServer::start().await;
        Mock::given(wm_method("HEAD"))
            .respond_with(ResponseTemplate::new(200).insert_header("etag", "\"../../escape\""))
            .mount(&server)
            .await;
        let tmp = tempdir().unwrap();
        let cache = scratch_cache(tmp.path());
        let repo = cache.repo("owner/repo");
        let fetch = repo.file("weights.bin");

        let (result, _) = run(&fetch, &format!("{}{FILE_PATH}", server.uri())).await;
        let err = result.expect_err("a path in an etag is not a blob name");
        assert!(
            format!("{err:#}").contains("cannot be used as a file name"),
            "{err:#}"
        );
    }

    #[test]
    fn etags_are_normalised_and_checked_as_file_names() {
        assert_eq!(normalize_etag("\"abc\""), "abc");
        assert_eq!(normalize_etag("W/\"d50091e9\""), "d50091e9");
        assert_eq!(normalize_etag("  abc  "), "abc");
        assert!(blob_name_is_safe("a402f10fb5780bf9"));
        assert!(blob_name_is_safe("9b2cf535f4f03b4c-5"));
        for bad in ["", "../x", "a/b", "a\\b", ".hidden", "..", "W/\"x\""] {
            assert!(!blob_name_is_safe(bad), "{bad:?} must be refused");
        }
    }

    #[test]
    fn content_range_parses_every_form_it_is_sent_in() {
        let parse = |v: &str| {
            let mut h = reqwest::header::HeaderMap::new();
            h.insert("content-range", v.parse().unwrap());
            content_range(&h)
        };
        assert_eq!(
            parse("bytes 600-999/1000"),
            Some(ContentRange {
                start: Some(600),
                complete: Some(1000)
            })
        );
        assert_eq!(
            parse("bytes 0-99/*"),
            Some(ContentRange {
                start: Some(0),
                complete: None
            })
        );
        assert_eq!(
            parse("bytes */1000"),
            Some(ContentRange {
                start: None,
                complete: Some(1000)
            })
        );
        assert_eq!(parse("items 0-1/2"), None);
        assert_eq!(parse("bytes garbage"), None);
    }

    #[test]
    fn an_encoded_answer_has_no_file_length() {
        let mut h = reqwest::header::HeaderMap::new();
        h.insert("content-length", "969".parse().unwrap());
        assert_eq!(plain_len(&h), Some(969));
        h.insert("content-encoding", "gzip".parse().unwrap());
        assert_eq!(plain_len(&h), None, "969 counts gzip bytes, not the file");
        h.insert("content-encoding", "identity".parse().unwrap());
        assert_eq!(plain_len(&h), Some(969));
    }

    // ── link_blob ────────────────────────────────────────────────────────────

    #[cfg(unix)]
    #[tokio::test]
    async fn link_blob_refuses_a_regular_file_and_leaves_it_alone() {
        let tmp = tempdir().unwrap();
        let blob = tmp.path().join("blobs").join("a402f10f");
        seed(&blob, b"blob").await;
        let dest = tmp.path().join("models").join("mmproj-BF16.gguf");
        seed(&dest, b"someone's bytes").await;

        let err = link_blob(&blob, &dest)
            .await
            .expect_err("a regular file is never replaced");
        assert_eq!(
            err.downcast_ref::<DestNotALink>(),
            Some(&DestNotALink { path: dest.clone() })
        );
        let meta = std::fs::symlink_metadata(&dest).unwrap();
        assert!(meta.file_type().is_file(), "still a regular file");
        assert_eq!(std::fs::read(&dest).unwrap(), b"someone's bytes");

        let dir = tmp.path().join("models").join("a-dir");
        std::fs::create_dir_all(&dir).unwrap();
        let err = link_blob(&blob, &dir)
            .await
            .expect_err("nor is a directory");
        assert!(err.downcast_ref::<DestNotALink>().is_some(), "{err:#}");
        assert!(dir.is_dir());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn link_blob_creates_an_absent_link_and_replaces_a_symlink() {
        let tmp = tempdir().unwrap();
        let old_blob = tmp.path().join("blobs").join("old");
        let new_blob = tmp.path().join("blobs").join("new");
        seed(&old_blob, b"old").await;
        seed(&new_blob, b"new").await;
        let dest = tmp
            .path()
            .join("models")
            .join("mmproj")
            .join("mmproj-BF16.gguf");

        link_blob(&old_blob, &dest).await.expect("creates the link");
        assert_eq!(std::fs::read_link(&dest).unwrap(), old_blob);

        link_blob(&new_blob, &dest)
            .await
            .expect("replaces the link");
        assert_eq!(std::fs::read_link(&dest).unwrap(), new_blob);
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
        assert_eq!(
            std::fs::read(&old_blob).unwrap(),
            b"old",
            "the blob the old link pointed at is not touched"
        );

        link_blob(&new_blob, &dest)
            .await
            .expect("relinking to the same blob is a no-op");
        assert_eq!(std::fs::read_link(&dest).unwrap(), new_blob);

        let dangling = tmp.path().join("models").join("dangling.gguf");
        std::os::unix::fs::symlink(tmp.path().join("blobs").join("gone"), &dangling).unwrap();
        link_blob(&new_blob, &dangling)
            .await
            .expect("a dangling link is still a link");
        assert_eq!(std::fs::read_link(&dangling).unwrap(), new_blob);

        let leftovers: Vec<_> = std::fs::read_dir(dest.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".link-"))
            .collect();
        assert!(leftovers.is_empty(), "no staging links left: {leftovers:?}");
    }

    #[tokio::test]
    async fn link_blob_to_a_missing_blob_creates_nothing() {
        let tmp = tempdir().unwrap();
        let dest = tmp.path().join("models").join("x.gguf");
        link_blob(&tmp.path().join("blobs").join("absent"), &dest)
            .await
            .expect_err("a link to nothing is refused");
        assert!(std::fs::symlink_metadata(&dest).is_err());
    }
}
