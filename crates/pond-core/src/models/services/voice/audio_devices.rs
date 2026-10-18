//! Picking the microphone and speaker: the household's pin while it works, else the system
//! default, else the best device that passes a brief test.

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::models::domain::audio_device::{
    choose, probe_order, settles, AudioChoice, AudioDevice, AudioDirection, ProbeOutcome,
    ProbedDevice,
};
use crate::models::ports::audio_devices::AudioDeviceProber;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeMode {
    /// Stop at the first device that settles the choice: startup and hotplug, where every
    /// probe is a moment the microphone is busy.
    Lazy,
    /// Test every device, within [`FULL_BUDGET`]: the household asked to test again.
    Full,
}

/// Long enough for a Bluetooth headset to wake its microphone.
pub const FIRST_CHOICE_WAIT: Duration = Duration::from_millis(1_200);
/// Devices nobody asked for get less; a stalled one costs this much for nothing.
pub const OTHER_WAIT: Duration = Duration::from_millis(600);
/// Caps the probes on a board that lists dozens of ALSA nodes.
pub const MAX_PROBES: usize = 12;
pub const LAZY_BUDGET: Duration = Duration::from_secs(4);
pub const FULL_BUDGET: Duration = Duration::from_secs(8);

/// Read on [`AudioChoice::devices`] for a device that broke during the session.
pub const STOPPED_WORKING: &str = "stopped working during this session";

#[derive(Debug, Clone)]
pub struct SelectRequest<'a> {
    pub direction: AudioDirection,
    pub pinned: Option<&'a str>,
    pub mode: ProbeMode,
    /// Devices that broke mid-session: passed over without reopening them, until they reappear.
    pub exclude: &'a [String],
    /// `Settings::mic_enabled`. Off means no input is opened, listed or tested.
    pub mic_enabled: bool,
}

pub struct AudioDeviceSelector {
    prober: Arc<dyn AudioDeviceProber>,
}

impl AudioDeviceSelector {
    pub fn new(prober: Arc<dyn AudioDeviceProber>) -> Self {
        Self { prober }
    }

    pub fn prober(&self) -> &Arc<dyn AudioDeviceProber> {
        &self.prober
    }

    pub fn select(&self, req: &SelectRequest<'_>) -> AudioChoice {
        let dir = req.direction;
        let pinned = req.pinned.map(str::trim).filter(|p| !p.is_empty());
        if dir == AudioDirection::Input && !req.mic_enabled {
            return AudioChoice::mic_off(pinned);
        }
        let excluded = |d: &AudioDevice| req.exclude.iter().any(|x| x == &d.id);
        // Only worth the listing when something is actually plugged in.
        let plugged_first = self.prober.plugged_in_first()
            && self
                .prober
                .quick_list(dir)
                .iter()
                .any(|d| d.plugged_in && !excluded(d));
        let started = Instant::now();
        let budget = match req.mode {
            ProbeMode::Lazy => LAZY_BUDGET,
            ProbeMode::Full => FULL_BUDGET,
        };

        // With nothing pinned the default usually settles it, and on ALSA listing means opening
        // every node, so try the default before asking for the list.
        let mut default_probe: Option<ProbedDevice> = None;
        if req.mode == ProbeMode::Lazy && pinned.is_none() && !plugged_first {
            if let Some(default) = self.prober.default_device(dir).filter(|d| !excluded(d)) {
                let outcome = self.prober.probe(&default, dir, FIRST_CHOICE_WAIT);
                if outcome.proven() {
                    let mut devices = vec![ProbedDevice::new(default.clone(), outcome)];
                    devices.extend(
                        self.prober
                            .quick_list(dir)
                            .into_iter()
                            .filter(|d| d.id != default.id)
                            .map(|d| ProbedDevice::new(d, ProbeOutcome::Untested)),
                    );
                    return choose(dir, devices, None, false);
                }
                default_probe = Some(ProbedDevice::new(default, outcome));
            }
        }

        let mut listed = self.prober.devices(dir).unwrap_or_else(|e| {
            tracing::warn!(direction = ?dir, error = %e, "could not list audio devices");
            Vec::new()
        });
        if let Some(default) = self.prober.default_device(dir) {
            if !listed.iter().any(|d| d.id == default.id) {
                listed.insert(0, default);
            }
        }

        let mut probed = Vec::with_capacity(listed.len());
        let mut tried = 0usize;
        let mut settled = false;
        for device in probe_order(&listed, pinned, plugged_first) {
            let first_choice = Some(device.id.as_str()) == pinned
                || device.is_default
                || (plugged_first && device.plugged_in);
            let outcome = if excluded(device) {
                ProbeOutcome::Failed {
                    reason: STOPPED_WORKING.to_string(),
                }
            } else if let Some(known) = default_probe.as_ref().filter(|p| p.device.id == device.id)
            {
                known.outcome.clone()
            } else if settled || tried >= MAX_PROBES || started.elapsed() >= budget {
                ProbeOutcome::Untested
            } else {
                tried += 1;
                let wait = if first_choice {
                    FIRST_CHOICE_WAIT
                } else {
                    OTHER_WAIT
                };
                self.prober.probe(device, dir, wait)
            };
            if req.mode == ProbeMode::Lazy && settles(device, &outcome, pinned) {
                settled = true;
            }
            probed.push(ProbedDevice::new(device.clone(), outcome));
        }
        choose(dir, probed, pinned, plugged_first)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::models::domain::audio_device::{ChoiceBasis, DeviceKind};
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Scripted devices; records every probe so laziness and the mic gate can be asserted.
    #[derive(Default)]
    pub(crate) struct FakeProber {
        pub inputs: Vec<AudioDevice>,
        pub outputs: Vec<AudioDevice>,
        pub outcomes: HashMap<String, ProbeOutcome>,
        pub probes: Mutex<Vec<String>>,
        pub listings: Mutex<usize>,
        /// Mimics ALSA, where only an explicit listing reveals anything but the default.
        pub no_quick_list: bool,
        pub plugged_in_first: bool,
    }

    impl FakeProber {
        fn with(inputs: &[(&str, bool, ProbeOutcome)]) -> Self {
            let mut p = Self::default();
            for (id, is_default, outcome) in inputs {
                p.inputs
                    .push(AudioDevice::new(*id, *is_default, DeviceKind::Hardware));
                p.outcomes.insert(id.to_string(), outcome.clone());
            }
            p
        }
        fn probed(&self) -> Vec<String> {
            self.probes.lock().unwrap().clone()
        }
        fn side(&self, dir: AudioDirection) -> &Vec<AudioDevice> {
            match dir {
                AudioDirection::Input => &self.inputs,
                AudioDirection::Output => &self.outputs,
            }
        }
    }

    impl AudioDeviceProber for FakeProber {
        fn default_device(&self, dir: AudioDirection) -> Option<AudioDevice> {
            self.side(dir).iter().find(|d| d.is_default).cloned()
        }
        fn devices(&self, dir: AudioDirection) -> Result<Vec<AudioDevice>, String> {
            *self.listings.lock().unwrap() += 1;
            Ok(self.side(dir).clone())
        }
        fn quick_list(&self, dir: AudioDirection) -> Vec<AudioDevice> {
            if self.no_quick_list {
                Vec::new()
            } else {
                self.side(dir).clone()
            }
        }
        fn probe(&self, d: &AudioDevice, _: AudioDirection, _: Duration) -> ProbeOutcome {
            self.probes.lock().unwrap().push(d.id.clone());
            self.outcomes
                .get(&d.id)
                .cloned()
                .unwrap_or(ProbeOutcome::Failed {
                    reason: "unscripted".into(),
                })
        }
        fn fingerprint(&self) -> String {
            String::new()
        }
        fn chime(&self, _: &AudioDevice) -> Result<(), String> {
            Ok(())
        }
        fn plugged_in_first(&self) -> bool {
            self.plugged_in_first
        }
    }

    fn hearing() -> ProbeOutcome {
        ProbeOutcome::Hearing { level_dbfs: -61.0 }
    }

    fn select(p: Arc<FakeProber>, pinned: Option<&str>, mode: ProbeMode) -> AudioChoice {
        AudioDeviceSelector::new(p).select(&SelectRequest {
            direction: AudioDirection::Input,
            pinned,
            mode,
            exclude: &[],
            mic_enabled: true,
        })
    }

    #[test]
    fn startup_opens_only_the_default_when_it_hears() {
        let p = Arc::new(FakeProber::with(&[
            ("Built-in", true, hearing()),
            ("Phone", false, hearing()),
            ("USB", false, hearing()),
        ]));
        let c = select(p.clone(), None, ProbeMode::Lazy);
        assert_eq!(c.device_id(), Some("Built-in"));
        assert_eq!(c.basis, ChoiceBasis::SystemDefault);
        assert_eq!(p.probed(), ["Built-in"], "nothing else may be opened");
        assert_eq!(
            *p.listings.lock().unwrap(),
            0,
            "no ALSA-style listing either"
        );
        // The picker still sees every device, untested.
        assert_eq!(c.devices.len(), 3);
        assert!(c.devices[1..]
            .iter()
            .all(|d| d.outcome == ProbeOutcome::Untested));
    }

    #[test]
    fn a_silent_default_makes_startup_keep_looking_and_stop_at_the_first_that_hears() {
        let p = Arc::new(FakeProber::with(&[
            ("Built-in", true, ProbeOutcome::Silent),
            ("Phone", false, hearing()),
            ("USB", false, hearing()),
        ]));
        let c = select(p.clone(), None, ProbeMode::Lazy);
        assert_eq!(c.device_id(), Some("Phone"));
        assert_eq!(
            p.probed(),
            ["Built-in", "Phone"],
            "the default is not reopened"
        );
    }

    #[test]
    fn a_working_pin_is_the_only_device_opened() {
        let p = Arc::new(FakeProber::with(&[
            ("Built-in", true, hearing()),
            ("USB", false, hearing()),
        ]));
        let c = select(p.clone(), Some("USB"), ProbeMode::Lazy);
        assert_eq!(c.device_id(), Some("USB"));
        assert_eq!(c.basis, ChoiceBasis::Pinned);
        assert_eq!(p.probed(), ["USB"]);
    }

    #[test]
    fn a_pin_that_returns_is_chosen_again() {
        let mut fake = FakeProber::with(&[("Built-in", true, hearing())]);
        let unplugged = select(Arc::new(fake), Some("USB"), ProbeMode::Lazy);
        assert_eq!(unplugged.device_id(), Some("Built-in"));
        assert_eq!(unplugged.basis, ChoiceBasis::Fallback);

        fake = FakeProber::with(&[("Built-in", true, hearing()), ("USB", false, hearing())]);
        let replugged = select(Arc::new(fake), Some("USB"), ProbeMode::Lazy);
        assert_eq!(replugged.device_id(), Some("USB"));
        assert_eq!(replugged.basis, ChoiceBasis::Pinned);
    }

    #[test]
    fn a_full_test_opens_every_device() {
        let p = Arc::new(FakeProber::with(&[
            ("Built-in", true, hearing()),
            ("Phone", false, ProbeOutcome::Silent),
            ("Loopback", false, ProbeOutcome::Stalled),
        ]));
        let c = select(p.clone(), None, ProbeMode::Full);
        assert_eq!(c.device_id(), Some("Built-in"));
        assert_eq!(p.probed().len(), 3);
        assert!(c
            .devices
            .iter()
            .all(|d| d.outcome != ProbeOutcome::Untested));
    }

    /// The privacy switch means the device does not even open to be tested.
    #[test]
    fn with_the_mic_off_no_input_is_listed_or_opened() {
        let p = Arc::new(FakeProber::with(&[("Built-in", true, hearing())]));
        let c = AudioDeviceSelector::new(p.clone()).select(&SelectRequest {
            direction: AudioDirection::Input,
            pinned: None,
            mode: ProbeMode::Full,
            exclude: &[],
            mic_enabled: false,
        });
        assert_eq!(c.basis, ChoiceBasis::MicOff);
        assert!(p.probed().is_empty());
        assert_eq!(*p.listings.lock().unwrap(), 0);
    }

    #[test]
    fn the_mic_switch_does_not_gate_the_speaker() {
        let mut fake = FakeProber::default();
        fake.outputs
            .push(AudioDevice::new("Speakers", true, DeviceKind::Hardware));
        fake.outcomes
            .insert("Speakers".into(), ProbeOutcome::Accepting);
        let c = AudioDeviceSelector::new(Arc::new(fake)).select(&SelectRequest {
            direction: AudioDirection::Output,
            pinned: None,
            mode: ProbeMode::Lazy,
            exclude: &[],
            mic_enabled: false,
        });
        assert_eq!(c.device_id(), Some("Speakers"));
    }

    /// A device that died mid-session is not reopened until it reappears.
    #[test]
    fn a_device_that_broke_mid_session_is_skipped_without_reopening_it() {
        let p = Arc::new(FakeProber::with(&[
            ("Built-in", true, hearing()),
            ("USB", false, hearing()),
        ]));
        let exclude = vec!["Built-in".to_string()];
        let c = AudioDeviceSelector::new(p.clone()).select(&SelectRequest {
            direction: AudioDirection::Input,
            pinned: None,
            mode: ProbeMode::Lazy,
            exclude: &exclude,
            mic_enabled: true,
        });
        assert_eq!(c.device_id(), Some("USB"));
        assert_eq!(p.probed(), ["USB"]);
        let broken = c
            .devices
            .iter()
            .find(|d| d.device.id == "Built-in")
            .unwrap();
        assert_eq!(
            broken.outcome,
            ProbeOutcome::Failed {
                reason: STOPPED_WORKING.into()
            }
        );
    }

    /// ALSA: the default is all that is known until something opens the rest.
    #[test]
    fn without_a_quick_list_a_hearing_default_needs_no_listing() {
        let mut fake =
            FakeProber::with(&[("default", true, hearing()), ("plughw", false, hearing())]);
        fake.no_quick_list = true;
        let p = Arc::new(fake);
        let c = select(p.clone(), None, ProbeMode::Lazy);
        assert_eq!(c.device_id(), Some("default"));
        assert_eq!(c.devices.len(), 1);
        assert_eq!(*p.listings.lock().unwrap(), 0);
    }

    #[test]
    fn probing_stops_at_the_cap_on_a_board_with_dozens_of_nodes() {
        let mut fake = FakeProber::default();
        fake.inputs
            .push(AudioDevice::new("default", true, DeviceKind::SoundServer));
        fake.outcomes.insert("default".into(), ProbeOutcome::Silent);
        for i in 0..30 {
            let id = format!("hw:CARD=APE,DEV={i}");
            fake.inputs
                .push(AudioDevice::new(id.clone(), false, DeviceKind::Raw));
            fake.outcomes.insert(id, ProbeOutcome::Silent);
        }
        let p = Arc::new(fake);
        let c = select(p.clone(), None, ProbeMode::Full);
        assert_eq!(p.probed().len(), MAX_PROBES);
        assert_eq!(
            c.device_id(),
            Some("default"),
            "all silent keeps the default"
        );
        assert_eq!(c.basis, ChoiceBasis::BestEffort);
    }

    /// The Jetson: PulseAudio's default is the board's analog path, which takes audio and has
    /// nothing plugged in. The USB card is tried first, and the default is never opened.
    #[test]
    fn on_a_board_the_usb_card_is_tried_before_a_default_that_also_works() {
        let mut fake = FakeProber {
            plugged_in_first: true,
            ..Default::default()
        };
        fake.outputs
            .push(AudioDevice::new("default", true, DeviceKind::SoundServer));
        fake.outputs.push(
            AudioDevice::new("sysdefault:CARD=Device", false, DeviceKind::Hardware).plugged_in(),
        );
        fake.outcomes
            .insert("default".into(), ProbeOutcome::Accepting);
        fake.outcomes
            .insert("sysdefault:CARD=Device".into(), ProbeOutcome::Accepting);
        let p = Arc::new(fake);
        let c = AudioDeviceSelector::new(p.clone()).select(&SelectRequest {
            direction: AudioDirection::Output,
            pinned: None,
            mode: ProbeMode::Lazy,
            exclude: &[],
            mic_enabled: true,
        });
        assert_eq!(c.device_id(), Some("sysdefault:CARD=Device"));
        assert_eq!(c.basis, ChoiceBasis::PluggedIn);
        assert_eq!(p.probed(), ["sysdefault:CARD=Device"]);
    }

    #[test]
    fn with_nothing_plugged_in_a_board_keeps_the_cheap_default_only_start() {
        let mut fake = FakeProber::with(&[("default", true, hearing())]);
        fake.plugged_in_first = true;
        let p = Arc::new(fake);
        let c = select(p.clone(), None, ProbeMode::Lazy);
        assert_eq!(c.device_id(), Some("default"));
        assert_eq!(
            *p.listings.lock().unwrap(),
            0,
            "no ALSA listing without a USB card"
        );
    }
}
