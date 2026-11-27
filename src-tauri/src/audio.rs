//! The microphones Windows knows about, for the Settings screen. OBS
//! records the sound (see obs.rs).

use cpal::traits::HostTrait;

/// Names of the microphones, as Windows shows them.
pub fn input_device_names() -> Vec<String> {
    cpal::default_host()
        .input_devices()
        .map(|ds| ds.map(|d| d.to_string()).collect())
        .unwrap_or_default()
}
