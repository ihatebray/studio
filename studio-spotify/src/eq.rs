//! The equalizer for Spotify songs: the same ten peaking filters Studio
//! runs local files through (src/lib/eq.js, Web Audio's BiquadFilterNode),
//! so a setting sounds the same either way. Studio sends the band gains and
//! the headroom it worked out for them; nothing here is decided twice.

/// Band centres, Hz. Must match EQ_BANDS in src/lib/eq.js.
pub const BANDS: [f64; 10] = [31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0];
const Q: f64 = 1.41;
const MAX_DB: f64 = 12.0;

/// What Studio sent: a gain per band and the level drop that keeps raised
/// bands from clipping, both dB.
#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub gains: [f64; 10],
    pub headroom_db: f64,
}

impl Settings {
    /// None when the gains aren't ten numbers (an off switch sends none).
    pub fn new(gains: &[f64], headroom_db: f64) -> Option<Self> {
        if gains.len() != BANDS.len() || gains.iter().any(|g| !g.is_finite()) {
            return None;
        }
        let mut g = [0.0; 10];
        for (out, v) in g.iter_mut().zip(gains) {
            *out = v.clamp(-MAX_DB, MAX_DB);
        }
        let headroom_db = if headroom_db.is_finite() { headroom_db.clamp(-2.0 * MAX_DB, 0.0) } else { 0.0 };
        Some(Self { gains: g, headroom_db })
    }
}

/// One peaking filter (Audio EQ Cookbook), transposed direct form II.
#[derive(Clone, Copy)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

impl Biquad {
    fn peaking(f0: f64, gain_db: f64, rate: f64) -> Self {
        let a = 10f64.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f64::consts::PI * f0 / rate;
        let alpha = w0.sin() / (2.0 * Q);
        let cos = w0.cos();
        let a0 = 1.0 + alpha / a;
        Self {
            b0: (1.0 + alpha * a) / a0,
            b1: -2.0 * cos / a0,
            b2: (1.0 - alpha * a) / a0,
            a1: -2.0 * cos / a0,
            a2: (1.0 - alpha / a) / a0,
        }
    }
}

pub struct Equalizer {
    rate: f64,
    channels: usize,
    filters: Vec<Biquad>,
    /// Which band each filter is.
    bands: Vec<usize>,
    /// Per band, per channel: the two state values.
    state: Vec<[f64; 2]>,
    headroom: f64,
    on: bool,
}

impl Equalizer {
    pub fn new(rate: u32, channels: usize) -> Self {
        Self { rate: rate as f64, channels: channels.max(1), filters: Vec::new(), bands: Vec::new(), state: Vec::new(), headroom: 1.0, on: false }
    }

    /// New settings, or None for off. Filter state carries over, so moving a
    /// band while a song plays doesn't click.
    pub fn set(&mut self, settings: Option<&Settings>) {
        let Some(s) = settings else {
            self.on = false;
            return;
        };
        // Flat bands are left out: they'd only cost time.
        let mut filters = Vec::new();
        let mut bands = Vec::new();
        for (i, (&f0, &g)) in BANDS.iter().zip(&s.gains).enumerate() {
            if g != 0.0 && f0 < self.rate / 2.0 {
                filters.push(Biquad::peaking(f0, g, self.rate));
                bands.push(i);
            }
        }
        let mut state = vec![[0.0; 2]; bands.len() * self.channels];
        for (n, b) in bands.iter().enumerate() {
            if let Some(o) = self.bands.iter().position(|x| x == b) {
                if self.on {
                    state[n * self.channels..(n + 1) * self.channels]
                        .copy_from_slice(&self.state[o * self.channels..(o + 1) * self.channels]);
                }
            }
        }
        self.bands = bands;
        self.filters = filters;
        self.state = state;
        self.headroom = 10f64.powf(s.headroom_db / 20.0);
        self.on = true;
    }

    /// Filters `samples` (interleaved) in place.
    pub fn process(&mut self, samples: &mut [f32]) {
        if !self.on {
            return;
        }
        let ch = self.channels;
        for frame in samples.chunks_exact_mut(ch) {
            for (c, s) in frame.iter_mut().enumerate() {
                let mut x = *s as f64 * self.headroom;
                for (n, f) in self.filters.iter().enumerate() {
                    let z = &mut self.state[n * ch + c];
                    let y = f.b0 * x + z[0];
                    z[0] = f.b1 * x - f.a1 * y + z[1];
                    z[1] = f.b2 * x - f.a2 * y;
                    x = y;
                }
                *s = x as f32;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(f: f64, secs: f64) -> Vec<f32> {
        (0..(44100.0 * secs) as usize)
            .flat_map(|i| {
                let s = (0.25 * (2.0 * std::f64::consts::PI * f * i as f64 / 44100.0).sin()) as f32;
                [s, s]
            })
            .collect()
    }

    fn peak_db(samples: &[f32]) -> f64 {
        // The second half, once the filters have settled.
        let tail = &samples[samples.len() / 2..];
        20.0 * (tail.iter().fold(0f32, |m, s| m.max(s.abs())) as f64 / 0.25).log10()
    }

    #[test]
    fn a_band_lifts_its_own_frequency_by_its_gain() {
        let mut eq = Equalizer::new(44100, 2);
        let mut gains = [0.0; 10];
        gains[5] = 6.0; // 1 kHz
        eq.set(Settings::new(&gains, 0.0).as_ref());
        let mut at = tone(1000.0, 1.0);
        eq.process(&mut at);
        assert!((peak_db(&at) - 6.0).abs() < 0.05, "{}", peak_db(&at));
        let mut far = tone(8000.0, 1.0);
        eq.process(&mut far);
        assert!(peak_db(&far).abs() < 0.1, "{}", peak_db(&far));
        assert_eq!(at[1000], at[1001], "channels stay together");
    }

    #[test]
    fn headroom_lowers_everything_and_off_is_untouched() {
        let mut eq = Equalizer::new(44100, 2);
        eq.set(Settings::new(&[0.0; 10], -6.0).as_ref());
        let mut t = tone(440.0, 0.5);
        eq.process(&mut t);
        assert!((peak_db(&t) + 6.0).abs() < 0.05);
        eq.set(None);
        let mut u = tone(440.0, 0.5);
        let before = u.clone();
        eq.process(&mut u);
        assert_eq!(u, before);
        assert!(Settings::new(&[1.0; 3], 0.0).is_none());
        assert_eq!(Settings::new(&[99.0; 10], 5.0).unwrap().gains[0], 12.0);
    }
}
