//! Loudness per frequency band, for Studio's compact-bar visualizer.
//!
//! Studio can't analyse Spotify audio itself (the helper never hands audio
//! over), so the helper does: each packet the decoder writes gets 24 band
//! levels (0–100) from a 2048-point FFT of the most recent audio. They ride
//! along with the packet in the output queue and are published only when
//! that packet starts playing, so the visualizer follows what you hear rather
//! than the decoder, which runs about half a second ahead.
//!
//! This is 24 numbers about 30 times a second. The audio can't be rebuilt
//! from them, so the helper's rule still holds: audio goes to the sound card
//! and nowhere else.

use std::f32::consts::PI;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};

pub const BANDS: usize = 24;
const N: usize = 2048;
const LOW_HZ: f32 = 40.0;
const HIGH_HZ: f32 = 16_000.0;
/// dB window mapped onto 0–100.
const FLOOR_DB: f32 = -70.0;
const RANGE_DB: f32 = 60.0;

/// The levels of the packet playing now, shared between the audio thread
/// (which publishes) and the emitter (which reads).
#[derive(Default)]
pub struct Levels {
    bands: [AtomicU8; BANDS],
    dirty: AtomicBool,
    /// The boost limiter's gain reduction for the same packet, dB (<= 0),
    /// as f32 bits.
    reduction: AtomicU32,
}

impl Levels {
    pub fn publish(&self, v: &[u8; BANDS]) {
        for (slot, x) in self.bands.iter().zip(v) {
            slot.store(*x, Ordering::Relaxed);
        }
        self.dirty.store(true, Ordering::Release);
    }

    pub fn publish_reduction(&self, db: f32) {
        self.reduction.store(db.to_bits(), Ordering::Relaxed);
    }

    /// Gain reduction of the packet playing now, rounded to 0.1 dB.
    pub fn reduction(&self) -> f32 {
        (f32::from_bits(self.reduction.load(Ordering::Relaxed)) * 10.0).round() / 10.0
    }

    /// The latest levels, if any were published since the last take.
    pub fn take(&self) -> Option<[u8; BANDS]> {
        if !self.dirty.swap(false, Ordering::Acquire) {
            return None;
        }
        Some(std::array::from_fn(|i| self.bands[i].load(Ordering::Relaxed)))
    }
}

/// Rolling mono window plus FFT scratch, owned by the sink.
pub struct Analyser {
    ring: Vec<f32>,
    pos: usize,
    window: Vec<f32>,
    re: Vec<f32>,
    im: Vec<f32>,
    edges: [(usize, usize); BANDS],
}

impl Analyser {
    pub fn new(sample_rate: u32) -> Self {
        let bin_hz = sample_rate as f32 / N as f32;
        let edges = std::array::from_fn(|b| {
            let f = |k: f32| LOW_HZ * (HIGH_HZ / LOW_HZ).powf(k / BANDS as f32);
            let lo = ((f(b as f32) / bin_hz).round() as usize).clamp(1, N / 2 - 1);
            let hi = ((f(b as f32 + 1.0) / bin_hz).round() as usize).clamp(lo + 1, N / 2);
            (lo, hi)
        });
        Self {
            ring: vec![0.0; N],
            pos: 0,
            window: (0..N).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / (N - 1) as f32).cos()).collect(),
            re: vec![0.0; N],
            im: vec![0.0; N],
            edges,
        }
    }

    /// Feed one packet of interleaved samples; returns the band levels over
    /// the last N frames.
    pub fn feed(&mut self, interleaved: &[f32], channels: usize) -> [u8; BANDS] {
        let channels = channels.max(1);
        for frame in interleaved.chunks_exact(channels) {
            self.ring[self.pos] = frame.iter().sum::<f32>() / channels as f32;
            self.pos = (self.pos + 1) % N;
        }
        for i in 0..N {
            self.re[i] = self.ring[(self.pos + i) % N] * self.window[i];
            self.im[i] = 0.0;
        }
        fft(&mut self.re, &mut self.im);
        // A full-scale sine through a Hann window peaks at N/4.
        let scale = 4.0 / N as f32;
        std::array::from_fn(|b| {
            let (lo, hi) = self.edges[b];
            let peak = (lo..hi).map(|k| (self.re[k] * self.re[k] + self.im[k] * self.im[k]).sqrt()).fold(0.0f32, f32::max);
            let db = 20.0 * (peak * scale + 1e-9).log10();
            (((db - FLOOR_DB) / RANGE_DB).clamp(0.0, 1.0) * 100.0).round() as u8
        })
    }
}

/// In-place iterative radix-2 FFT; `re.len()` must be a power of two.
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * PI / len as f32;
        let (wr, wi) = (ang.cos(), ang.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0f32, 0.0f32);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let vr = re[b] * cr - im[b] * ci;
                let vi = re[b] * ci + im[b] * cr;
                re[b] = re[a] - vr;
                im[b] = im[a] - vi;
                re[a] += vr;
                im[a] += vi;
                let next = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = next;
            }
        }
        len <<= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tone_lights_its_own_band_and_not_the_others() {
        let mut a = Analyser::new(44_100);
        // 100 Hz at half scale, stereo, a bit more than one window's worth.
        let s: Vec<f32> = (0..2 * 2400).map(|i| 0.5 * (2.0 * PI * 100.0 * (i / 2) as f32 / 44_100.0).sin()).collect();
        let v = a.feed(&s, 2);
        let loudest = (0..BANDS).max_by_key(|&b| v[b]).unwrap();
        let hz = |k: f32| LOW_HZ * (HIGH_HZ / LOW_HZ).powf(k / BANDS as f32);
        assert!(hz(loudest as f32) <= 110.0 && hz(loudest as f32 + 1.0) >= 90.0, "band {loudest} {v:?}");
        assert!(v[loudest] > 80, "{v:?}");
        assert!(v[BANDS - 1] < 20, "{v:?}");
    }

    #[test]
    fn silence_is_zero() {
        let mut a = Analyser::new(44_100);
        assert_eq!(a.feed(&vec![0.0; 4096], 2), [0; BANDS]);
    }
}
