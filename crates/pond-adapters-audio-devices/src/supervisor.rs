//! Keeps the microphone and speaker on devices that work: chooses at startup, and again when a
//! device comes or goes, when the mic is lost or stalls, when the speaker stops taking audio,
//! and when the household asks for a test.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use pond_audio::{MicHandle, MicState};
use pond_core::models::domain::audio_device::{
    AudioChoice, AudioDeviceStatus, AudioDirection, ChoiceBasis,
};
use pond_core::models::ports::audio_devices::{AudioDeviceControl, AudioDeviceProber};
use pond_core::models::services::voice::audio_devices::{
    AudioDeviceSelector, ProbeMode, SelectRequest,
};
use serde::{Deserialize, Serialize};

const TICK: Duration = Duration::from_millis(500);
const FINGERPRINT_EVERY: Duration = Duration::from_secs(2);
/// A capture with no new frames for this long has lost its device without saying so (ALSA).
const MIC_STALL: Duration = Duration::from_secs(3);
/// Spaces out reselects after failures, so a device that keeps failing is not hammered.
const FAILURE_BACKOFF: Duration = Duration::from_secs(5);
/// How long serve waits for the voice session to answer a retest request: a full test's budget
/// plus one slow device still opening when it runs out, inside the UI's 30 s request timeout.
const VOICE_ANSWER_WAIT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The voice session: owns the microphone, so it tests inputs on its own.
    Voice,
    /// The server: never opens the microphone unless the household asks for a test and no
    /// voice session holds it.
    Serve,
}

impl Role {
    fn name(self) -> &'static str {
        match self {
            Self::Voice => "voice",
            Self::Serve => "serve",
        }
    }
}

/// The settings a selection reads, fresh on every pass so a new pin applies without a restart.
#[derive(Debug, Clone, Default)]
pub struct AudioPrefs {
    pub input_pin: Option<String>,
    pub output_pin: Option<String>,
    pub mic_enabled: bool,
    /// `Settings::audio_test_chime`: the household agreed to hear a test.
    pub chime: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Startup,
    DevicesChanged,
    InputLost,
    OutputStalled,
    /// A pin or the mic switch changed: chosen again as at startup, never a full test.
    SettingsChanged,
    Retest,
}

pub type PrefsFn = Arc<dyn Fn() -> AudioPrefs + Send + Sync>;
/// Told after every pass that changed something, or that the household asked for.
pub type ChangeFn = Arc<dyn Fn(&AudioDeviceStatus, Trigger) + Send + Sync>;

pub struct SupervisorConfig {
    pub role: Role,
    pub data_dir: PathBuf,
    pub mic: Option<MicHandle>,
    pub prefs: PrefsFn,
    pub on_change: Option<ChangeFn>,
}

#[derive(Debug, Clone, Copy)]
struct Which {
    input: bool,
    output: bool,
}

const BOTH: Which = Which {
    input: true,
    output: true,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StatusFile {
    status: AudioDeviceStatus,
    /// The retest request this pass answered, so serve can tell its answer from an older one.
    answered: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RetestRequest {
    id: u64,
    chime: bool,
    /// False for a settings change: the voice session chooses again lazily, as at startup.
    #[serde(default = "full_by_default")]
    full: bool,
}

fn full_by_default() -> bool {
    true
}

fn audio_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("audio")
}
fn status_path(data_dir: &Path, role: Role) -> PathBuf {
    audio_dir(data_dir).join(format!("devices-{}.json", role.name()))
}
fn request_path(data_dir: &Path) -> PathBuf {
    audio_dir(data_dir).join("retest-request.json")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Write-then-rename, so a reader in the other process never sees half a file.
fn write_json(path: &Path, value: &impl Serialize) {
    let Ok(json) = serde_json::to_vec_pretty(value) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    // SAFETY: signal 0 checks existence and permission only; nothing is delivered.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn pid_alive(_pid: u32) -> bool {
    false
}

/// The voice session's status, if one is running in another process.
fn live_voice(data_dir: &Path) -> Option<StatusFile> {
    let file: StatusFile = read_json(&status_path(data_dir, Role::Voice))?;
    let pid = file.status.pid;
    (pid != std::process::id() && pid_alive(pid)).then_some(file)
}

struct Inner {
    role: Role,
    data_dir: PathBuf,
    mic: Option<MicHandle>,
    prefs: PrefsFn,
    on_change: Option<ChangeFn>,
    selector: AudioDeviceSelector,
    status: Mutex<Option<AudioDeviceStatus>>,
    ready: Condvar,
    /// Devices that broke mid-session, passed over until the device list changes.
    exclude: Mutex<Vec<String>>,
    /// One pass at a time: the watch thread and a retest must never probe together.
    selecting: Mutex<()>,
    stop: AtomicBool,
}

#[derive(Clone)]
pub struct AudioSupervisor {
    inner: Arc<Inner>,
}

impl AudioSupervisor {
    /// Start choosing on a thread of its own; [`Self::wait_ready`] waits for the first choice.
    pub fn spawn(config: SupervisorConfig, prober: Arc<dyn AudioDeviceProber>) -> Self {
        let inner = Arc::new(Inner {
            role: config.role,
            data_dir: config.data_dir,
            mic: config.mic,
            prefs: config.prefs,
            on_change: config.on_change,
            selector: AudioDeviceSelector::new(prober),
            status: Mutex::new(None),
            ready: Condvar::new(),
            exclude: Mutex::new(Vec::new()),
            selecting: Mutex::new(()),
            stop: AtomicBool::new(false),
        });
        let watcher = inner.clone();
        let spawned = std::thread::Builder::new()
            .name("audio-devices".into())
            .spawn(move || watcher.run());
        if let Err(e) = spawned {
            tracing::warn!(error = %e, "audio device supervisor did not start");
        }
        Self { inner }
    }

    pub fn wait_ready(&self, timeout: Duration) -> Option<AudioDeviceStatus> {
        let guard = self.inner.status.lock().unwrap_or_else(|e| e.into_inner());
        let (guard, _) = self
            .inner
            .ready
            .wait_timeout_while(guard, timeout, |s| s.is_none())
            .unwrap_or_else(|e| e.into_inner());
        guard.clone()
    }

    pub fn status(&self) -> Option<AudioDeviceStatus> {
        self.inner
            .status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Test every device now, apply the result, and return it.
    pub fn retest(&self, chime: bool) -> AudioDeviceStatus {
        self.inner.retest(chime, None)
    }

    /// Stop watching. A voice session also withdraws its status, so serve stops deferring to it.
    pub fn stop(&self) {
        self.inner.stop.store(true, Ordering::SeqCst);
        if self.inner.role == Role::Voice {
            let _ = std::fs::remove_file(status_path(&self.inner.data_dir, Role::Voice));
        }
    }
}

impl Inner {
    fn input_choice(&self, prefs: &AudioPrefs, mode: ProbeMode, exclude: &[String]) -> AudioChoice {
        let pinned = prefs.input_pin.as_deref();
        if !prefs.mic_enabled {
            return AudioChoice::mic_off(pinned);
        }
        // Serve opens the microphone only when the household asks for a test.
        if self.role == Role::Serve && mode == ProbeMode::Lazy {
            let quick = self.selector.prober().quick_list(AudioDirection::Input);
            let quick = if quick.is_empty() {
                self.selector
                    .prober()
                    .default_device(AudioDirection::Input)
                    .into_iter()
                    .collect()
            } else {
                quick
            };
            return AudioChoice::not_tested(
                AudioDirection::Input,
                quick,
                pinned,
                self.selector.prober().plugged_in_first(),
            );
        }
        self.selector.select(&SelectRequest {
            direction: AudioDirection::Input,
            pinned,
            mode,
            exclude,
            mic_enabled: prefs.mic_enabled,
        })
    }

    fn pass(
        &self,
        trigger: Trigger,
        mode: ProbeMode,
        which: Which,
        answered: Option<u64>,
    ) -> AudioDeviceStatus {
        let _one_at_a_time = self.selecting.lock().unwrap_or_else(|e| e.into_inner());
        let prefs = (self.prefs)();
        let exclude = self
            .exclude
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let previous = self
            .status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();

        let input = match (&previous, which.input) {
            (Some(prev), false) => prev.input.clone(),
            _ => self.input_choice(&prefs, mode, &exclude),
        };
        let output = match (&previous, which.output) {
            (Some(prev), false) => prev.output.clone(),
            _ => self.selector.select(&SelectRequest {
                direction: AudioDirection::Output,
                pinned: prefs.output_pin.as_deref(),
                mode,
                exclude: &exclude,
                mic_enabled: prefs.mic_enabled,
            }),
        };

        if let Some(mic) = &self.mic {
            if !matches!(input.basis, ChoiceBasis::MicOff | ChoiceBasis::NotTested) {
                mic.retarget(input.device_id().map(str::to_string));
            }
        }
        pond_audio_out::set_output_device(output.device_id().map(str::to_string));

        let status = AudioDeviceStatus {
            input,
            output,
            updated_at_ms: now_ms(),
            source: self.role.name().to_string(),
            pid: std::process::id(),
        };
        let changed = previous.as_ref().is_none_or(|p| {
            p.input.device_id() != status.input.device_id()
                || p.output.device_id() != status.output.device_id()
                || p.input.basis != status.input.basis
                || p.output.basis != status.output.basis
        });
        let speaker_moved = previous
            .as_ref()
            .is_some_and(|p| p.output.device_id() != status.output.device_id());
        if changed {
            tracing::info!(
                ?trigger,
                input = %status.input,
                output = %status.output,
                "audio devices chosen"
            );
        }
        write_json(
            &status_path(&self.data_dir, self.role),
            &StatusFile {
                status: status.clone(),
                answered,
            },
        );
        *self.status.lock().unwrap_or_else(|e| e.into_inner()) = Some(status.clone());
        self.ready.notify_all();

        // Audible only on the household's say-so, and never at startup, where the pond speaks.
        if prefs.chime && trigger == Trigger::DevicesChanged && speaker_moved {
            self.chime(&status);
        }
        if changed || matches!(trigger, Trigger::Startup | Trigger::Retest) {
            if let Some(on_change) = &self.on_change {
                on_change(&status, trigger);
            }
        }
        status
    }

    fn chime(&self, status: &AudioDeviceStatus) {
        if let Some(device) = &status.output.device {
            if let Err(e) = self.selector.prober().chime(device) {
                tracing::warn!(error = %e, "test chime did not play");
            }
        }
    }

    fn retest(&self, chime: bool, answered: Option<u64>) -> AudioDeviceStatus {
        self.exclude
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        let status = self.pass(Trigger::Retest, ProbeMode::Full, BOTH, answered);
        if chime || (self.prefs)().chime {
            self.chime(&status);
        }
        status
    }

    fn exclude(&self, device: Option<String>) {
        if let Some(device) = device.filter(|d| !d.is_empty()) {
            let mut exclude = self.exclude.lock().unwrap_or_else(|e| e.into_inner());
            if !exclude.contains(&device) {
                exclude.push(device);
            }
        }
    }

    fn current_input(&self) -> Option<String> {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .and_then(|s| s.input.device_id().map(str::to_string))
    }

    fn run(self: Arc<Self>) {
        // A request left from before this session started is not ours to answer.
        let mut handled: Option<u64> =
            read_json::<RetestRequest>(&request_path(&self.data_dir)).map(|r| r.id);
        self.pass(Trigger::Startup, ProbeMode::Lazy, BOTH, None);

        let prober = self.selector.prober().clone();
        let mut fingerprint = prober.fingerprint();
        let mut fingerprint_at = Instant::now();
        let mut mic_written = 0u64;
        let mut mic_moved_at = Instant::now();
        let mut mic_was_failed = false;
        let mut last_failure_pass: Option<Instant> = None;

        loop {
            std::thread::sleep(TICK);
            // Checked after the sleep: a stopped supervisor must not take another's stall report.
            if self.stop.load(Ordering::SeqCst) {
                break;
            }

            if self.role == Role::Voice {
                if let Some(req) = read_json::<RetestRequest>(&request_path(&self.data_dir)) {
                    if handled != Some(req.id) {
                        handled = Some(req.id);
                        if req.full {
                            self.retest(req.chime, Some(req.id));
                        } else {
                            self.pass(
                                Trigger::SettingsChanged,
                                ProbeMode::Lazy,
                                BOTH,
                                Some(req.id),
                            );
                        }
                    }
                }
            }

            if fingerprint_at.elapsed() >= FINGERPRINT_EVERY {
                fingerprint_at = Instant::now();
                let now = prober.fingerprint();
                if now != fingerprint {
                    fingerprint = now;
                    pond_audio_out::route::forget_devices();
                    self.exclude
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .clear();
                    self.pass(Trigger::DevicesChanged, ProbeMode::Lazy, BOTH, None);
                }
            }

            let may_retry = last_failure_pass.is_none_or(|t| t.elapsed() >= FAILURE_BACKOFF);
            if let (Role::Voice, Some(mic)) = (self.role, &self.mic) {
                let state = mic.state();
                let failed = matches!(state, MicState::Failed(_));
                let written = mic.shared().written();
                if written != mic_written || !state.is_open() {
                    mic_written = written;
                    mic_moved_at = Instant::now();
                }
                let stalled = state.is_open() && mic_moved_at.elapsed() >= MIC_STALL;
                if ((failed && !mic_was_failed) || stalled) && may_retry {
                    tracing::warn!(?state, stalled, "microphone lost; choosing another");
                    let lost = self.current_input();
                    self.exclude(lost.clone());
                    last_failure_pass = Some(Instant::now());
                    mic_moved_at = Instant::now();
                    let status = self.pass(
                        Trigger::InputLost,
                        ProbeMode::Lazy,
                        Which {
                            input: true,
                            output: false,
                        },
                        None,
                    );
                    // The only device came back as the choice: a retarget to the same name does
                    // not restart a stream that stalled while still open, so restart it.
                    if status.input.device_id() == lost.as_deref() {
                        mic.reopen();
                    }
                }
                mic_was_failed = failed;
            }

            if let Some(stalled) = pond_audio_out::route::take_stall() {
                if may_retry {
                    self.exclude(Some(stalled));
                    last_failure_pass = Some(Instant::now());
                    self.pass(
                        Trigger::OutputStalled,
                        ProbeMode::Lazy,
                        Which {
                            input: false,
                            output: true,
                        },
                        None,
                    );
                }
            }
        }
    }
}

/// The API's view for the server process: the voice session's choice while one runs, since it
/// owns the microphone, and the server's own otherwise.
pub struct PondAudioControl {
    serve: AudioSupervisor,
    data_dir: PathBuf,
}

impl PondAudioControl {
    pub fn new(serve: AudioSupervisor, data_dir: PathBuf) -> Self {
        Self { serve, data_dir }
    }

    fn own_status(&self) -> AudioDeviceStatus {
        self.serve
            .status()
            .or_else(|| self.serve.wait_ready(Duration::from_secs(5)))
            .unwrap_or_else(|| AudioDeviceStatus {
                input: AudioChoice::not_tested(AudioDirection::Input, Vec::new(), None, false),
                output: AudioChoice::not_tested(AudioDirection::Output, Vec::new(), None, false),
                updated_at_ms: now_ms(),
                source: Role::Serve.name().to_string(),
                pid: std::process::id(),
            })
    }
}

impl AudioDeviceControl for PondAudioControl {
    fn status(&self) -> AudioDeviceStatus {
        match live_voice(&self.data_dir) {
            Some(voice) => voice.status,
            None => self.own_status(),
        }
    }

    fn retest(&self, chime: bool) -> AudioDeviceStatus {
        if live_voice(&self.data_dir).is_none() {
            return self.serve.retest(chime);
        }
        // The voice session holds the microphone, so it runs the test; this process only
        // re-checks the speaker it announces on.
        let id = now_ms();
        let request = RetestRequest {
            id,
            chime,
            full: true,
        };
        write_json(&request_path(&self.data_dir), &request);
        self.serve.inner.pass(
            Trigger::Retest,
            ProbeMode::Full,
            Which {
                input: false,
                output: true,
            },
            None,
        );
        let deadline = Instant::now() + VOICE_ANSWER_WAIT;
        while Instant::now() < deadline {
            match live_voice(&self.data_dir) {
                Some(voice) if voice.answered == Some(id) => return voice.status,
                Some(_) => std::thread::sleep(Duration::from_millis(100)),
                None => return self.serve.retest(chime),
            }
        }
        tracing::warn!("the voice session did not answer the device test in time");
        self.status()
    }

    fn reselect(&self) {
        if live_voice(&self.data_dir).is_some() {
            let request = RetestRequest {
                id: now_ms(),
                chime: false,
                full: false,
            };
            write_json(&request_path(&self.data_dir), &request);
        }
        // Lazy, so serve still opens no microphone: its input stays untested or off.
        self.serve
            .inner
            .pass(Trigger::SettingsChanged, ProbeMode::Lazy, BOTH, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pond_core::models::domain::audio_device::{AudioDevice, DeviceKind, ProbeOutcome};
    use std::collections::HashMap;

    /// A scripted machine whose devices can be unplugged between passes.
    #[derive(Default)]
    struct Machine {
        inputs: Mutex<Vec<AudioDevice>>,
        outputs: Mutex<Vec<AudioDevice>>,
        outcomes: Mutex<HashMap<String, ProbeOutcome>>,
        probes: Mutex<Vec<String>>,
        chimes: Mutex<Vec<String>>,
    }

    impl Machine {
        fn plug(&self, dir: AudioDirection, id: &str, is_default: bool, outcome: ProbeOutcome) {
            let d = AudioDevice::new(id, is_default, DeviceKind::Hardware);
            match dir {
                AudioDirection::Input => self.inputs.lock().unwrap().push(d),
                AudioDirection::Output => self.outputs.lock().unwrap().push(d),
            }
            self.outcomes.lock().unwrap().insert(id.into(), outcome);
        }
        fn unplug(&self, id: &str) {
            self.inputs.lock().unwrap().retain(|d| d.id != id);
            self.outputs.lock().unwrap().retain(|d| d.id != id);
        }
        fn side(&self, dir: AudioDirection) -> Vec<AudioDevice> {
            match dir {
                AudioDirection::Input => self.inputs.lock().unwrap().clone(),
                AudioDirection::Output => self.outputs.lock().unwrap().clone(),
            }
        }
    }

    impl AudioDeviceProber for Machine {
        fn default_device(&self, dir: AudioDirection) -> Option<AudioDevice> {
            self.side(dir).into_iter().find(|d| d.is_default)
        }
        fn devices(&self, dir: AudioDirection) -> Result<Vec<AudioDevice>, String> {
            Ok(self.side(dir))
        }
        fn quick_list(&self, dir: AudioDirection) -> Vec<AudioDevice> {
            self.side(dir)
        }
        fn probe(&self, d: &AudioDevice, _: AudioDirection, _: Duration) -> ProbeOutcome {
            self.probes.lock().unwrap().push(d.id.clone());
            self.outcomes.lock().unwrap().get(&d.id).cloned().unwrap()
        }
        fn fingerprint(&self) -> String {
            let mut ids: Vec<String> = self
                .side(AudioDirection::Input)
                .into_iter()
                .chain(self.side(AudioDirection::Output))
                .map(|d| d.id)
                .collect();
            ids.sort();
            ids.join(",")
        }
        fn chime(&self, d: &AudioDevice) -> Result<(), String> {
            self.chimes.lock().unwrap().push(d.id.clone());
            Ok(())
        }
    }

    fn hearing() -> ProbeOutcome {
        ProbeOutcome::Hearing { level_dbfs: -55.0 }
    }

    fn machine() -> Arc<Machine> {
        let m = Arc::new(Machine::default());
        m.plug(AudioDirection::Input, "Built-in mic", true, hearing());
        m.plug(
            AudioDirection::Output,
            "Built-in speakers",
            true,
            ProbeOutcome::Accepting,
        );
        m
    }

    fn prefs(input_pin: Option<&str>, mic_enabled: bool, chime: bool) -> PrefsFn {
        let input_pin = input_pin.map(str::to_string);
        Arc::new(move || AudioPrefs {
            input_pin: input_pin.clone(),
            output_pin: None,
            mic_enabled,
            chime,
        })
    }

    fn start(m: &Arc<Machine>, role: Role, dir: &Path, prefs: PrefsFn) -> AudioSupervisor {
        AudioSupervisor::spawn(
            SupervisorConfig {
                role,
                data_dir: dir.to_path_buf(),
                mic: None,
                prefs,
                on_change: None,
            },
            m.clone(),
        )
    }

    fn wait_until(what: &str, mut f: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(8);
        while !f() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// The speaker route is process-wide; supervisor tests that read it take turns.
    static ROUTE: Mutex<()> = Mutex::new(());

    #[test]
    fn startup_chooses_both_and_writes_the_status_for_the_other_process() {
        let _g = ROUTE.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let m = machine();
        let sup = start(&m, Role::Voice, dir.path(), prefs(None, true, false));
        let status = sup.wait_ready(Duration::from_secs(5)).unwrap();
        assert_eq!(status.input.device_id(), Some("Built-in mic"));
        assert_eq!(status.output.device_id(), Some("Built-in speakers"));
        assert_eq!(
            pond_audio_out::output_device().as_deref(),
            Some("Built-in speakers")
        );
        let file: StatusFile = read_json(&status_path(dir.path(), Role::Voice)).unwrap();
        assert_eq!(file.status, status);
        assert!(
            m.chimes.lock().unwrap().is_empty(),
            "startup is never audible"
        );
        sup.stop();
    }

    #[test]
    fn serve_never_opens_the_microphone_on_its_own() {
        let _g = ROUTE.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let m = machine();
        let sup = start(&m, Role::Serve, dir.path(), prefs(None, true, false));
        let status = sup.wait_ready(Duration::from_secs(5)).unwrap();
        assert_eq!(status.input.basis, ChoiceBasis::NotTested);
        assert_eq!(status.input.device_id(), Some("Built-in mic"));
        assert_eq!(*m.probes.lock().unwrap(), ["Built-in speakers"]);

        // Asked to, it does.
        let tested = sup.retest(false);
        assert_eq!(tested.input.basis, ChoiceBasis::SystemDefault);
        assert!(m
            .probes
            .lock()
            .unwrap()
            .contains(&"Built-in mic".to_string()));
        sup.stop();
    }

    #[test]
    fn plugging_in_the_pinned_mic_moves_to_it_and_unplugging_it_moves_back() {
        let _g = ROUTE.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let m = machine();
        let sup = start(
            &m,
            Role::Voice,
            dir.path(),
            prefs(Some("USB mic"), true, false),
        );
        let first = sup.wait_ready(Duration::from_secs(5)).unwrap();
        assert_eq!(first.input.device_id(), Some("Built-in mic"));
        assert_eq!(first.input.basis, ChoiceBasis::Fallback);

        m.plug(AudioDirection::Input, "USB mic", false, hearing());
        wait_until("the pinned mic", || {
            sup.status().unwrap().input.device_id() == Some("USB mic")
        });
        assert_eq!(sup.status().unwrap().input.basis, ChoiceBasis::Pinned);

        m.unplug("USB mic");
        wait_until("the fallback", || {
            sup.status().unwrap().input.device_id() == Some("Built-in mic")
        });
        sup.stop();
    }

    #[test]
    fn headphones_arriving_as_the_new_default_take_over_and_chime_only_when_agreed() {
        let _g = ROUTE.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let m = machine();
        let sup = start(&m, Role::Voice, dir.path(), prefs(None, true, true));
        sup.wait_ready(Duration::from_secs(5)).unwrap();

        // The OS makes connected headphones the default.
        m.outputs
            .lock()
            .unwrap()
            .iter_mut()
            .for_each(|d| d.is_default = false);
        m.plug(
            AudioDirection::Output,
            "AirPods",
            true,
            ProbeOutcome::Accepting,
        );
        wait_until("the headphones", || {
            sup.status().unwrap().output.device_id() == Some("AirPods")
        });
        assert_eq!(pond_audio_out::output_device().as_deref(), Some("AirPods"));
        wait_until("the chime", || !m.chimes.lock().unwrap().is_empty());
        assert_eq!(*m.chimes.lock().unwrap(), ["AirPods"]);
        sup.stop();
    }

    #[test]
    fn a_speaker_that_stops_taking_audio_is_replaced() {
        let _g = ROUTE.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let m = machine();
        m.plug(
            AudioDirection::Output,
            "USB speaker",
            false,
            ProbeOutcome::Accepting,
        );
        let sup = start(&m, Role::Voice, dir.path(), prefs(None, true, false));
        sup.wait_ready(Duration::from_secs(5)).unwrap();
        while pond_audio_out::route::take_stall().is_some() {}

        pond_audio_out::route::report_stall(Some("Built-in speakers".into()));
        wait_until("the replacement", || {
            sup.status().unwrap().output.device_id() == Some("USB speaker")
        });
        let status = sup.status().unwrap();
        assert_eq!(status.output.basis, ChoiceBasis::Fallback);
        sup.stop();
    }

    #[test]
    fn with_the_mic_off_the_voice_session_opens_no_input() {
        let _g = ROUTE.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let m = machine();
        let sup = start(&m, Role::Voice, dir.path(), prefs(None, false, false));
        let status = sup.wait_ready(Duration::from_secs(5)).unwrap();
        assert_eq!(status.input.basis, ChoiceBasis::MicOff);
        assert_eq!(*m.probes.lock().unwrap(), ["Built-in speakers"]);
        sup.retest(false);
        assert!(!m
            .probes
            .lock()
            .unwrap()
            .contains(&"Built-in mic".to_string()));
        sup.stop();
    }

    #[test]
    fn a_retest_request_from_serve_is_answered_by_the_voice_session() {
        let _g = ROUTE.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let m = machine();
        let voice = start(&m, Role::Voice, dir.path(), prefs(None, true, false));
        voice.wait_ready(Duration::from_secs(5)).unwrap();

        write_json(
            &request_path(dir.path()),
            &RetestRequest {
                id: 7,
                chime: true,
                full: true,
            },
        );
        wait_until("the answer", || {
            read_json::<StatusFile>(&status_path(dir.path(), Role::Voice))
                .is_some_and(|f| f.answered == Some(7))
        });
        assert_eq!(*m.chimes.lock().unwrap(), ["Built-in speakers"]);
        voice.stop();
    }

    #[test]
    fn a_settings_change_reselects_without_a_full_test() {
        let _g = ROUTE.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let m = machine();
        m.plug(AudioDirection::Input, "Phone", false, hearing());
        let serve = start(&m, Role::Serve, dir.path(), prefs(None, true, false));
        serve.wait_ready(Duration::from_secs(5)).unwrap();
        let control = PondAudioControl::new(serve.clone(), dir.path().to_path_buf());
        control.reselect();
        let opened = m.probes.lock().unwrap().clone();
        assert!(
            !opened.iter().any(|p| p == "Built-in mic" || p == "Phone"),
            "serve opened a microphone for a settings change: {opened:?}"
        );

        // A voice session answers the same change lazily: the default hears, so nothing else opens.
        let voice = start(&m, Role::Voice, dir.path(), prefs(None, true, false));
        voice.wait_ready(Duration::from_secs(5)).unwrap();
        m.probes.lock().unwrap().clear();
        let request = RetestRequest {
            id: 9,
            chime: false,
            full: false,
        };
        write_json(&request_path(dir.path()), &request);
        wait_until("the lazy answer", || {
            read_json::<StatusFile>(&status_path(dir.path(), Role::Voice))
                .is_some_and(|f| f.answered == Some(9))
        });
        assert!(!m.probes.lock().unwrap().contains(&"Phone".to_string()));
        serve.stop();
        voice.stop();
    }

    #[test]
    fn a_stale_voice_status_from_a_dead_process_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let mut status = AudioDeviceStatus {
            input: AudioChoice::mic_off(None),
            output: AudioChoice::not_tested(AudioDirection::Output, Vec::new(), None, false),
            updated_at_ms: 1,
            source: "voice".into(),
            pid: u32::MAX - 1,
        };
        write_json(
            &status_path(dir.path(), Role::Voice),
            &StatusFile {
                status: status.clone(),
                answered: None,
            },
        );
        assert!(live_voice(dir.path()).is_none(), "no such process");
        status.pid = std::process::id();
        write_json(
            &status_path(dir.path(), Role::Voice),
            &StatusFile {
                status,
                answered: None,
            },
        );
        assert!(
            live_voice(dir.path()).is_none(),
            "our own file is not another session"
        );
    }
}
