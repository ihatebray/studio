//! The sound-card output librespot's player writes into, in place of its
//! stock rodio backend. Modelled on Sonora's paced sink.
//!
//! Why not the stock one: its `stop()` waits for everything queued to play
//! out before pausing, so a pause, a skip or a seek let the old audio run on
//! for about half a second. Here:
//!
//! * pause stops the device where it is, keeping the queue for resume;
//! * a skip, seek or stop moves the cue on a generation, which ends every
//!   queued packet at its next sample and refuses the ones the decoder is
//!   still writing from the old position, until the player announces the new
//!   one (`arm`);
//! * volume is applied at the output, so a change is heard at once instead
//!   of after the queue;
//! * boost (gain past full volume, for quietly mastered tracks) is applied
//!   to each packet as it is queued, through a peak limiter so the extra
//!   gain never clips;
//! * the equalizer (eq.rs) runs on each packet as it is queued, so a
//!   change is heard from the next packet;
//! * Spotify's 44.1 kHz is converted to the device's own rate here, with a
//!   proper band-limited resampler, so rodio's linear one never runs.
//!
//! Like the stock backend, audio goes to the sound card and nowhere else.

use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use librespot_playback::audio_backend::{Sink, SinkError, SinkResult};
use librespot_playback::convert::Converter;
use librespot_playback::decoder::AudioPacket;
use librespot_playback::{NUM_CHANNELS, SAMPLE_RATE};
use rodio::buffer::SamplesBuffer;
use rodio::Source;
use rubato::{FftFixedIn, Resampler};

use crate::eq::{self, Equalizer};
use crate::spectrum::{Analyser, Levels, BANDS};

/// Packets queued before a write waits. This paces librespot's decoder to
/// real time (~0.5 s at the packet sizes librespot produces); it no longer
/// sets how long a pause or skip takes, because those don't wait for it.
const QUEUED: usize = 26;
const DRAIN_POLL: Duration = Duration::from_millis(10);
/// Device buffer. Small, so pause is immediate at the device too; large
/// enough not to underrun on a busy machine. Falls back to the device
/// default where a fixed size is refused.
const DEVICE_FRAMES: u32 = 2048;

/// Boost range, as a gain multiplier: 1 is off, 16 is +24 dB.
pub const MIN_BOOST: f32 = 1.0;
pub const MAX_BOOST: f32 = 16.0;
/// The limiter's ceiling, just under full scale.
const CEILING: f32 = 0.977; // -0.2 dBFS
/// How fast the limiter lets go once a peak has passed.
const RELEASE_S: f32 = 0.08;

pub fn clamp_boost(v: f32) -> f32 {
    if v.is_finite() { v.clamp(MIN_BOOST, MAX_BOOST) } else { MIN_BOOST }
}

const OPEN: u8 = 0;
const CLEARED: u8 = 1;

/// Shared between the command loop (which clears on skip/seek/stop and sets
/// volume), the event task (which arms when the new track or position is
/// announced) and the sink on librespot's player thread.
#[derive(Clone, Default)]
pub struct Cue {
    state: Arc<AtomicU8>,
    generation: Arc<AtomicU32>,
    volume: Arc<AtomicU32>,
    boost: Arc<AtomicU32>,
    /// Track the player is being moved to; only its announcement arms.
    expect: Arc<Mutex<Option<String>>>,
    stale: Arc<AtomicU8>,
    /// Equalizer settings (None: off), and a count bumped on each change.
    eq: Arc<Mutex<Option<eq::Settings>>>,
    eq_changes: Arc<AtomicU32>,
    /// Samples queued for the device that haven't started playing, and the
    /// rate they play at: how far behind the decoder what you hear is.
    queued: Arc<AtomicI64>,
    out_rate: Arc<AtomicU32>,
    /// Band levels of the packet playing now (spectrum.rs).
    pub levels: Arc<Levels>,
}

impl Cue {
    pub fn new(volume: f32) -> Self {
        let cue = Self::default();
        cue.set_volume(volume);
        cue.set_boost(MIN_BOOST);
        cue
    }

    /// Silence everything queued now and refuse writes until `arm`. `track`
    /// is the id being loaded, or None for a seek/stop on the current one.
    pub fn clear(&self, track: Option<String>) {
        *self.expect.lock().unwrap_or_else(|e| e.into_inner()) = track;
        self.stale.store(0, Ordering::Relaxed);
        self.generation.fetch_add(1, Ordering::Relaxed);
        self.state.store(CLEARED, Ordering::Relaxed);
    }

    /// The player announced audio for `track` (loading/playing/seeked): let
    /// writes through again. An announcement for another track (one already
    /// in flight when the clear happened) is ignored.
    pub fn announce(&self, track: &str) {
        if self.state.load(Ordering::Relaxed) != CLEARED {
            return;
        }
        let ok = match self.expect.lock().unwrap_or_else(|e| e.into_inner()).as_deref() {
            Some(want) => want == track,
            None => true,
        };
        if ok {
            self.state.store(OPEN, Ordering::Relaxed);
        }
    }

    /// Position reports while cleared. A run of them means the seek or load
    /// never happened (bad id, same position), so let audio through rather
    /// than stay silent.
    pub fn position(&self) {
        if self.state.load(Ordering::Relaxed) == CLEARED && self.stale.fetch_add(1, Ordering::Relaxed) >= 2 {
            self.state.store(OPEN, Ordering::Relaxed);
        }
    }

    pub fn set_volume(&self, v: f32) {
        self.volume.store(v.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }

    fn volume(&self) -> f32 {
        f32::from_bits(self.volume.load(Ordering::Relaxed))
    }

    pub fn set_boost(&self, v: f32) {
        self.boost.store(clamp_boost(v).to_bits(), Ordering::Relaxed);
    }

    fn boost(&self) -> f32 {
        f32::from_bits(self.boost.load(Ordering::Relaxed))
    }

    /// How far what's coming out of the speakers is behind the decoder, ms:
    /// the audio queued for the device plus the device's own buffer. librespot
    /// reports the decoder's position; Studio subtracts this so the position
    /// (and the lyrics following it) is what you hear.
    pub fn output_lag_ms(&self) -> u64 {
        let rate = self.out_rate.load(Ordering::Relaxed);
        if rate == 0 {
            return 0; // no output open yet: nothing queued
        }
        let rate = rate as f64;
        let queued = self.queued.load(Ordering::Relaxed).max(0) as f64 / NUM_CHANNELS as f64;
        ((queued + DEVICE_FRAMES as f64) / rate * 1000.0) as u64
    }

    pub fn set_eq(&self, settings: Option<eq::Settings>) {
        *self.eq.lock().unwrap_or_else(|e| e.into_inner()) = settings;
        self.eq_changes.fetch_add(1, Ordering::Relaxed);
    }

    fn admit(&self) -> bool {
        self.state.load(Ordering::Relaxed) == OPEN
    }
}

/// Gain past full volume, then a peak limiter so it can't clip. Instant
/// attack (the gain drops to exactly what the loudest sample of a frame
/// allows), exponential release. At a boost of 1 nothing is touched.
struct Limiter {
    gain: f32,
    release: f32,
}

impl Limiter {
    fn new(rate: u32) -> Self {
        Self { gain: 1.0, release: 1.0 - (-1.0 / (RELEASE_S * rate as f32)).exp() }
    }

    /// Boosts `samples` (interleaved) in place; returns the deepest gain
    /// reduction applied, in dB (0 when the limiter never engaged).
    fn process(&mut self, samples: &mut [f32], channels: usize, boost: f32) -> f32 {
        if boost <= MIN_BOOST && self.gain >= 1.0 {
            return 0.0;
        }
        let mut deepest = 1.0f32;
        for frame in samples.chunks_mut(channels.max(1)) {
            let peak = frame.iter().fold(0.0f32, |m, s| m.max(s.abs())) * boost;
            let allowed = if peak > CEILING { CEILING / peak } else { 1.0 };
            self.gain = (self.gain + (1.0 - self.gain) * self.release).min(allowed);
            deepest = deepest.min(self.gain);
            let g = boost * self.gain;
            for s in frame.iter_mut() {
                *s *= g;
            }
        }
        if deepest < 1.0 { 20.0 * deepest.log10() } else { 0.0 }
    }
}

/// 44.1 kHz to the device rate (usually 48 kHz on Windows). rodio would
/// otherwise do it by linear interpolation, which smears the top end and
/// folds some of it back down as distortion.
struct Resample {
    fft: FftFixedIn<f32>,
    channels: usize,
    /// Input not yet resampled, per channel.
    pending: Vec<Vec<f32>>,
    out: Vec<Vec<f32>>,
    /// Lead-in frames still to drop after a reset, so audio isn't late.
    skip: usize,
}

impl Resample {
    /// Input frames per pass: about 23 ms at 44.1 kHz.
    const CHUNK: usize = 1024;

    fn new(from: u32, to: u32, channels: usize) -> Option<Self> {
        if from == to || channels == 0 {
            return None;
        }
        let fft = FftFixedIn::<f32>::new(from as usize, to as usize, Self::CHUNK, 2, channels).ok()?;
        let out = fft.output_buffer_allocate(true);
        let skip = fft.output_delay();
        Some(Self { fft, channels, pending: vec![Vec::new(); channels], out, skip })
    }

    /// Takes interleaved input, returns whatever interleaved output is ready
    /// (empty until a full pass of input has gathered).
    fn push(&mut self, samples: &[f32]) -> Vec<f32> {
        for frame in samples.chunks_exact(self.channels) {
            for (ch, s) in self.pending.iter_mut().zip(frame) {
                ch.push(*s);
            }
        }
        let mut result = Vec::new();
        while self.pending[0].len() >= self.fft.input_frames_next() {
            let Ok((used, made)) = self.fft.process_into_buffer(&self.pending, &mut self.out, None) else {
                // Can't happen with these buffer sizes; drop the input rather than stall.
                self.reset();
                break;
            };
            for ch in &mut self.pending {
                ch.drain(..used);
            }
            let start = self.skip.min(made);
            self.skip -= start;
            result.reserve((made - start) * self.channels);
            for i in start..made {
                for ch in &self.out {
                    result.push(ch[i]);
                }
            }
        }
        result
    }

    /// After a skip, seek or stop: forget the old audio.
    fn reset(&mut self) {
        self.fft.reset();
        for ch in &mut self.pending {
            ch.clear();
        }
        self.skip = self.fft.output_delay();
    }
}

/// One packet in rodio's queue. It ends early when the cue moves on, and
/// counts itself out when dropped either way.
struct Chunk {
    samples: SamplesBuffer,
    born: u32,
    generation: Arc<AtomicU32>,
    live: Arc<AtomicUsize>,
    /// This packet's band levels, published when its first sample plays.
    bands: Option<[u8; BANDS]>,
    /// The limiter's deepest reduction in this packet, dB.
    reduction: f32,
    levels: Arc<Levels>,
    /// Counted in the cue's `queued` until its first sample plays (or it's
    /// dropped unplayed).
    queued: Arc<AtomicI64>,
    len: i64,
    started: bool,
}

impl Iterator for Chunk {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        if self.generation.load(Ordering::Relaxed) != self.born {
            return None;
        }
        if !self.started {
            self.started = true;
            self.queued.fetch_sub(self.len, Ordering::Relaxed);
        }
        if let Some(b) = self.bands.take() {
            self.levels.publish_reduction(self.reduction);
            self.levels.publish(&b);
        }
        self.samples.next()
    }
}

impl Source for Chunk {
    fn current_span_len(&self) -> Option<usize> {
        self.samples.current_span_len()
    }
    fn channels(&self) -> rodio::ChannelCount {
        self.samples.channels()
    }
    fn sample_rate(&self) -> rodio::SampleRate {
        self.samples.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.samples.total_duration()
    }
}

impl Drop for Chunk {
    fn drop(&mut self) {
        self.live.fetch_sub(1, Ordering::Relaxed);
        if !self.started {
            self.queued.fetch_sub(self.len, Ordering::Relaxed);
        }
    }
}

pub struct CuedSink {
    // Declared first so it drops first: the sink before the stream it plays on.
    sink: rodio::Sink,
    _stream: rodio::OutputStream,
    cue: Cue,
    live: Arc<AtomicUsize>,
    volume: f32,
    analyser: Analyser,
    limiter: Limiter,
    /// The device's rate, and the converter to it (None when it's 44.1 kHz).
    rate: u32,
    resample: Option<Resample>,
    /// Generation the resampler's buffered audio belongs to.
    born: u32,
    /// Levels of input the resampler is still holding, for the next chunk.
    held: Option<([u8; BANDS], f32)>,
    equalizer: Equalizer,
    /// The cue's eq_changes when the equalizer was last set.
    eq_seen: u32,
}

impl CuedSink {
    /// Opens the default output device, paused until librespot starts it.
    pub fn open(cue: Cue) -> Result<Self, String> {
        let stream = rodio::OutputStreamBuilder::from_default_device()
            .and_then(|b| b.with_buffer_size(rodio::cpal::BufferSize::Fixed(DEVICE_FRAMES)).open_stream())
            .or_else(|_| rodio::OutputStreamBuilder::open_default_stream())
            .map_err(|e| format!("cannot open the audio output: {e}"))?;
        let mut stream = stream;
        stream.log_on_drop(false);
        let sink = rodio::Sink::connect_new(stream.mixer());
        sink.pause();
        let volume = cue.volume();
        sink.set_volume(volume);
        let rate = stream.config().sample_rate();
        let resample = Resample::new(SAMPLE_RATE, rate, NUM_CHANNELS as usize);
        let rate = if resample.is_some() { rate } else { SAMPLE_RATE };
        let born = cue.generation.load(Ordering::Relaxed);
        cue.out_rate.store(rate, Ordering::Relaxed);
        Ok(Self {
            sink,
            _stream: stream,
            cue,
            live: Arc::default(),
            volume,
            analyser: Analyser::new(SAMPLE_RATE),
            limiter: Limiter::new(SAMPLE_RATE),
            rate,
            resample,
            born,
            held: None,
            equalizer: Equalizer::new(SAMPLE_RATE, NUM_CHANNELS as usize),
            // Never matches, so the first packet picks up the settings.
            eq_seen: u32::MAX,
        })
    }

    fn follow_volume(&mut self) {
        let v = self.cue.volume();
        if v != self.volume {
            self.volume = v;
            self.sink.set_volume(v);
        }
    }
}

impl Sink for CuedSink {
    fn start(&mut self) -> SinkResult<()> {
        self.follow_volume();
        self.sink.play();
        Ok(())
    }

    /// Pause where it is. The stock backend drained the queue first, which is
    /// the half-second that kept playing after pressing pause.
    fn stop(&mut self) -> SinkResult<()> {
        self.sink.pause();
        Ok(())
    }

    fn write(&mut self, packet: AudioPacket, converter: &mut Converter) -> SinkResult<()> {
        self.follow_volume();
        if !self.cue.admit() {
            return Ok(()); // audio from before a skip/seek: dropped
        }
        let samples = packet.samples().map_err(|e| SinkError::OnWrite(e.to_string()))?;
        let mut samples = converter.f64_to_f32(samples);
        let changes = self.cue.eq_changes.load(Ordering::Relaxed);
        if changes != self.eq_seen {
            self.eq_seen = changes;
            self.equalizer.set(self.cue.eq.lock().unwrap_or_else(|e| e.into_inner()).as_ref());
        }
        self.equalizer.process(&mut samples);
        // The analyser sees the music before boost, so the visualizer
        // doesn't jump when boost changes.
        let bands = self.analyser.feed(&samples, NUM_CHANNELS as usize);
        let reduction = self.limiter.process(&mut samples, NUM_CHANNELS as usize, self.cue.boost());
        let born = self.cue.generation.load(Ordering::Relaxed);
        if let Some(r) = self.resample.as_mut() {
            if born != self.born {
                r.reset(); // what it holds is from before the skip/seek
                self.held = None;
            }
            samples = r.push(&samples);
        }
        self.born = born;
        let (bands, reduction) = match self.held.take() {
            // Keep the deepest reduction of everything that goes into this chunk.
            Some((_, held)) => (bands, reduction.min(held)),
            None => (bands, reduction),
        };
        if samples.is_empty() {
            self.held = Some((bands, reduction));
            return Ok(());
        }
        self.live.fetch_add(1, Ordering::Relaxed);
        let len = samples.len() as i64;
        self.cue.queued.fetch_add(len, Ordering::Relaxed);
        self.sink.append(Chunk {
            samples: SamplesBuffer::new(NUM_CHANNELS as rodio::ChannelCount, self.rate, samples),
            born,
            generation: self.cue.generation.clone(),
            live: self.live.clone(),
            bands: Some(bands),
            reduction,
            levels: self.cue.levels.clone(),
            queued: self.cue.queued.clone(),
            len,
            started: false,
        });
        // Pace the decoder. A paused device doesn't drain, but librespot
        // doesn't write while paused, so this can't hold a command up for
        // longer than one packet.
        while self.live.load(Ordering::Relaxed) > QUEUED {
            self.follow_volume();
            if !self.cue.admit() {
                break;
            }
            std::thread::sleep(DRAIN_POLL);
        }
        Ok(())
    }
}

/// Stands in when no output device opens, so playback state still moves
/// (and ends) instead of hanging: each packet takes as long as it lasts.
pub struct Silence;

impl Sink for Silence {
    fn write(&mut self, packet: AudioPacket, _converter: &mut Converter) -> SinkResult<()> {
        if let Ok(s) = packet.samples() {
            std::thread::sleep(Duration::from_secs_f64(s.len() as f64 / f64::from(NUM_CHANNELS as u32 * SAMPLE_RATE)));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skip_refuses_old_audio_until_the_new_track_is_announced() {
        let cue = Cue::new(1.0);
        assert!(cue.admit());
        let before = cue.generation.load(Ordering::Relaxed);
        cue.clear(Some("new".into()));
        assert_ne!(before, cue.generation.load(Ordering::Relaxed), "queued chunks end");
        assert!(!cue.admit());
        cue.announce("old"); // in flight from before the skip
        assert!(!cue.admit());
        cue.announce("new");
        assert!(cue.admit());
    }

    #[test]
    fn seek_opens_on_any_announcement_and_stale_positions_give_up() {
        let cue = Cue::new(1.0);
        cue.clear(None);
        cue.announce("whatever");
        assert!(cue.admit());
        cue.clear(None);
        cue.position();
        cue.position();
        assert!(!cue.admit());
        cue.position();
        assert!(cue.admit(), "never silent for good");
    }

    #[test]
    fn queued_chunk_stops_at_the_next_sample_after_a_clear() {
        let cue = Cue::new(1.0);
        let live = Arc::new(AtomicUsize::new(1));
        cue.queued.fetch_add(8, Ordering::Relaxed);
        let mut chunk = Chunk {
            samples: SamplesBuffer::new(2, 44100, vec![0.5f32; 8]),
            born: cue.generation.load(Ordering::Relaxed),
            generation: cue.generation.clone(),
            live: live.clone(),
            bands: Some([7; BANDS]),
            reduction: -3.0,
            levels: cue.levels.clone(),
            queued: cue.queued.clone(),
            len: 8,
            started: false,
        };
        assert!(cue.levels.take().is_none(), "nothing published before it plays");
        assert_eq!(chunk.next(), Some(0.5));
        assert_eq!(cue.queued.load(Ordering::Relaxed), 0, "playing, so no longer queued");
        assert_eq!(cue.levels.take(), Some([7; BANDS]), "published as it starts playing");
        assert_eq!(cue.levels.reduction(), -3.0);
        cue.clear(None);
        assert_eq!(chunk.next(), None);
        drop(chunk);
        assert_eq!(live.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn resampling_keeps_a_tone_clean_and_on_time() {
        assert!(Resample::new(44100, 44100, 2).is_none(), "nothing to do at the same rate");
        let mut r = Resample::new(44100, 48000, 2).unwrap();
        // 2 s of a 1 kHz tone, fed in odd-sized packets like the decoder's.
        let input: Vec<f32> = (0..88200)
            .flat_map(|i| {
                let s = 0.5 * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / 44100.0).sin();
                [s, s]
            })
            .collect();
        let mut out = Vec::new();
        for packet in input.chunks(2 * 937) {
            out.extend(r.push(packet));
        }
        let frames = out.len() / 2;
        // All but the last pass's worth comes out, at the new rate.
        assert!(frames > 96000 - 1400 && frames <= 96000, "{frames}");
        // No lead-in delay: the tone starts at the start (sin(0) = 0, then rising).
        assert!(out[0].abs() < 0.02 && out[2] > 0.0, "{:?}", &out[..6]);
        // Clean: every sample matches a 1 kHz sine at 48 kHz.
        let worst = (1000..frames - 1000)
            .map(|i| (out[2 * i] - 0.5 * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / 48000.0).sin()).abs())
            .fold(0.0f32, f32::max);
        assert!(worst < 1e-3, "{worst}");
        assert_eq!(out[100], out[101], "channels stay together");
        // After a reset the old audio is gone.
        r.reset();
        assert!(r.push(&[0.0; 20]).is_empty());
    }

    #[test]
    fn output_lag_counts_audio_not_yet_playing() {
        let cue = Cue::new(1.0);
        cue.out_rate.store(48000, Ordering::Relaxed);
        let base = cue.output_lag_ms(); // the device buffer alone
        assert_eq!(base, (DEVICE_FRAMES as f64 / 48.0) as u64);
        let live = Arc::new(AtomicUsize::new(1));
        // Half a second queued (48000 frames x 2 channels / 2).
        cue.queued.fetch_add(48000, Ordering::Relaxed);
        let chunk = Chunk {
            samples: SamplesBuffer::new(2, 48000, vec![0.0f32; 48000]),
            born: cue.generation.load(Ordering::Relaxed),
            generation: cue.generation.clone(),
            live: live.clone(),
            bands: None,
            reduction: 0.0,
            levels: cue.levels.clone(),
            queued: cue.queued.clone(),
            len: 48000,
            started: false,
        };
        assert_eq!(cue.output_lag_ms(), base + 500);
        drop(chunk); // cut before it played
        assert_eq!(cue.output_lag_ms(), base);
    }

    #[test]
    fn boost_is_limited_below_full_scale() {
        let mut lim = Limiter::new(44100);
        // Unity: untouched.
        let mut quiet = vec![0.25f32; 8];
        assert_eq!(lim.process(&mut quiet, 2, 1.0), 0.0);
        assert_eq!(quiet, vec![0.25; 8]);
        // A quiet passage gets the full boost.
        let mut q = vec![0.1f32; 8];
        assert_eq!(lim.process(&mut q, 2, 4.0), 0.0);
        assert!((q[0] - 0.4).abs() < 1e-6);
        // A loud one is held at the ceiling, and the reduction is reported.
        let mut loud = vec![0.9f32, -0.9, 0.5, 0.5];
        let gr = lim.process(&mut loud, 2, 4.0);
        assert!(loud.iter().all(|s| s.abs() <= CEILING + 1e-6), "{loud:?}");
        assert!(gr < -10.0, "{gr}");
        assert_eq!(clamp_boost(99.0), MAX_BOOST);
        assert_eq!(clamp_boost(f32::NAN), MIN_BOOST);
    }
}
