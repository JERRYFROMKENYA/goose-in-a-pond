//! Which speaker this process plays on. One route for every sound it makes, so the thinking tone,
//! the wake ping and the voice never end up on different devices.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};

use anyhow::{anyhow, Result};
use rodio::cpal::traits::{DeviceTrait, HostTrait};

static ROUTE: RwLock<Option<String>> = RwLock::new(None);
/// Bumped on every change, so holders of an open stream know to reopen.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// The device playback last saw stop taking audio, for the device supervisor to collect.
static STALLED: Mutex<Option<String>> = Mutex::new(None);
/// Devices a [`crate::Speaker`] or [`crate::AudioKeeper`] holds open, so a probe can read one
/// as working instead of opening it a second time (ALSA `hw` refuses that).
static HELD: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// The routed device, found once: on ALSA finding a named device opens every node to list them,
/// which would otherwise happen each time the thinking tone or the wake ping starts.
static RESOLVED: Mutex<Option<(String, rodio::cpal::Device)>> = Mutex::new(None);

/// Play on `device` from now on; `None` follows the system default.
pub fn set_output_device(device: Option<String>) {
    let mut route = ROUTE.write().unwrap_or_else(|e| e.into_inner());
    if *route != device {
        tracing::info!(device = ?device, "speaker route");
        *route = device;
        forget_devices();
        GENERATION.fetch_add(1, Ordering::SeqCst);
    }
}

pub fn output_device() -> Option<String> {
    ROUTE.read().unwrap_or_else(|e| e.into_inner()).clone()
}

pub fn generation() -> u64 {
    GENERATION.load(Ordering::SeqCst)
}

/// Playback found `device` (`None`: the default) no longer taking audio.
pub fn report_stall(device: Option<String>) {
    let name = device.or_else(default_output_name).unwrap_or_default();
    tracing::warn!(device = %name, "the speaker stopped taking audio");
    *STALLED.lock().unwrap_or_else(|e| e.into_inner()) = Some(name);
}

/// The device playback found stalled since the last call, if any.
pub fn take_stall() -> Option<String> {
    STALLED.lock().unwrap_or_else(|e| e.into_inner()).take()
}

pub fn is_held(device: &str) -> bool {
    HELD.lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .any(|d| d == device)
}

pub(crate) struct Hold(String);

impl Hold {
    pub(crate) fn new(device: String) -> Self {
        HELD.lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(device.clone());
        Self(device)
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        let mut held = HELD.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(i) = held.iter().position(|d| d == &self.0) {
            held.remove(i);
        }
    }
}

pub fn default_output_name() -> Option<String> {
    rodio::cpal::default_host()
        .default_output_device()
        .and_then(|d| d.name().ok())
}

/// Find an output device by name. ALSA's `default` is not worth listing every node for.
pub fn find_output(name: &str) -> Option<rodio::cpal::Device> {
    if let Some((cached, device)) = &*RESOLVED.lock().unwrap_or_else(|e| e.into_inner()) {
        if cached == name {
            return Some(device.clone());
        }
    }
    let host = rodio::cpal::default_host();
    let found = host
        .default_output_device()
        .filter(|d| d.name().ok().as_deref() == Some(name))
        .or_else(|| {
            host.output_devices()
                .ok()?
                .find(|d| d.name().ok().as_deref() == Some(name))
        })?;
    *RESOLVED.lock().unwrap_or_else(|e| e.into_inner()) = Some((name.to_string(), found.clone()));
    Some(found)
}

/// Find the routed device afresh next time: one replugged under the same name is a new device.
pub fn forget_devices() {
    *RESOLVED.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// An open stream on `device` (`None`: the system default), and the name of what opened. A
/// routed device that has gone falls back to the default rather than going quiet.
pub fn open_output(
    device: Option<&str>,
) -> Result<(rodio::OutputStream, rodio::OutputStreamHandle, String)> {
    if let Some(want) = device {
        match find_output(want).map(|d| rodio::OutputStream::try_from_device(&d)) {
            Some(Ok((stream, handle))) => return Ok((stream, handle, want.to_string())),
            Some(Err(e)) => {
                forget_devices();
                tracing::warn!(device = %want, error = %e, "speaker failed to open; using the default")
            }
            None => tracing::warn!(device = %want, "speaker not found; using the default"),
        }
    }
    let (stream, handle) = rodio::OutputStream::try_default()
        .map_err(|e| anyhow!("audio output device unavailable: {e}"))?;
    Ok((stream, handle, default_output_name().unwrap_or_default()))
}

/// [`open_output`] on the current route.
pub fn open_routed() -> Result<(rodio::OutputStream, rodio::OutputStreamHandle, String)> {
    open_output(output_device().as_deref())
}

/// Two soft rising notes, a third of a second, for a speaker test the household asked to hear.
pub fn chime_samples(rate: u32) -> Vec<f32> {
    let note = |freq: f32, ms: u64| -> Vec<f32> {
        let n = (rate as u64 * ms / 1000) as usize;
        (0..n)
            .map(|i| {
                let t = i as f32 / rate as f32;
                let p = i as f32 / n as f32;
                // A short attack keeps it from clicking; the decay keeps it from nagging.
                let env = (p / 0.1).min(1.0) * (1.0 - p);
                (2.0 * std::f32::consts::PI * freq * t).sin() * env * 0.4
            })
            .collect()
    };
    let mut out = note(523.25, 140);
    out.extend(note(783.99, 200));
    out
}

/// Play [`chime_samples`] on `device`, and wait for it to finish.
pub fn play_chime(device: Option<&str>) -> Result<()> {
    let (_stream, handle, _) = open_output(device)?;
    let sink = rodio::Sink::try_new(&handle).map_err(|e| anyhow!("no sink: {e}"))?;
    sink.set_volume(0.5);
    let rate = 44_100;
    sink.append(rodio::buffer::SamplesBuffer::new(
        1,
        rate,
        chime_samples(rate),
    ));
    sink.sleep_until_end();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The route is process-wide, so its tests take turns.
    pub(crate) static ROUTE_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn changing_the_route_bumps_the_generation_and_repeating_it_does_not() {
        let _g = ROUTE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let saved = output_device();
        set_output_device(Some("Test Speaker A".into()));
        let after_a = generation();
        set_output_device(Some("Test Speaker A".into()));
        assert_eq!(generation(), after_a, "same route, no reopen");
        set_output_device(Some("Test Speaker B".into()));
        assert_eq!(generation(), after_a + 1);
        assert_eq!(output_device().as_deref(), Some("Test Speaker B"));
        set_output_device(saved);
    }

    #[test]
    fn a_stall_is_collected_once() {
        report_stall(Some("Test Speaker".into()));
        assert_eq!(take_stall().as_deref(), Some("Test Speaker"));
        assert_eq!(take_stall(), None);
    }

    #[test]
    fn a_hold_is_released_on_drop() {
        let hold = Hold::new("Held Speaker".into());
        assert!(is_held("Held Speaker"));
        drop(hold);
        assert!(!is_held("Held Speaker"));
    }

    #[test]
    fn the_chime_is_short_soft_and_never_clips() {
        let s = chime_samples(44_100);
        assert!(s.len() < 44_100 / 2, "longer than half a second");
        let peak = s.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!(peak > 0.05 && peak <= 0.4, "peak {peak}");
        assert_eq!(s[0], 0.0, "starts from silence");
    }
}
