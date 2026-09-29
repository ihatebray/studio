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
//!   of after the queue.
//!
//! Like the stock backend, audio goes to the sound card and nowhere else.

use std::sync::atomic::{AtomicU32, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use librespot_playback::audio_backend::{Sink, SinkError, SinkResult};
use librespot_playback::convert::Converter;
use librespot_playback::decoder::AudioPacket;
use librespot_playback::{NUM_CHANNELS, SAMPLE_RATE};
use rodio::buffer::SamplesBuffer;
use rodio::Source;

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
    /// Track the player is being moved to; only its announcement arms.
    expect: Arc<Mutex<Option<String>>>,
    stale: Arc<AtomicU8>,
    /// Band levels of the packet playing now (spectrum.rs).
    pub levels: Arc<Levels>,
}

impl Cue {
    pub fn new(volume: f32) -> Self {
        let cue = Self::default();
        cue.set_volume(volume);
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

    fn admit(&self) -> bool {
        self.state.load(Ordering::Relaxed) == OPEN
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
    levels: Arc<Levels>,
}

impl Iterator for Chunk {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        if self.generation.load(Ordering::Relaxed) != self.born {
            return None;
        }
        if let Some(b) = self.bands.take() {
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
        Ok(Self { sink, _stream: stream, cue, live: Arc::default(), volume, analyser: Analyser::new(SAMPLE_RATE) })
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
        let samples = converter.f64_to_f32(samples);
        let bands = self.analyser.feed(&samples, NUM_CHANNELS as usize);
        self.live.fetch_add(1, Ordering::Relaxed);
        self.sink.append(Chunk {
            samples: SamplesBuffer::new(NUM_CHANNELS as rodio::ChannelCount, SAMPLE_RATE, samples),
            born: self.cue.generation.load(Ordering::Relaxed),
            generation: self.cue.generation.clone(),
            live: self.live.clone(),
            bands: Some(bands),
            levels: self.cue.levels.clone(),
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
        let mut chunk = Chunk {
            samples: SamplesBuffer::new(2, 44100, vec![0.5f32; 8]),
            born: cue.generation.load(Ordering::Relaxed),
            generation: cue.generation.clone(),
            live: live.clone(),
            bands: Some([7; BANDS]),
            levels: cue.levels.clone(),
        };
        assert!(cue.levels.take().is_none(), "nothing published before it plays");
        assert_eq!(chunk.next(), Some(0.5));
        assert_eq!(cue.levels.take(), Some([7; BANDS]), "published as it starts playing");
        cue.clear(None);
        assert_eq!(chunk.next(), None);
        drop(chunk);
        assert_eq!(live.load(Ordering::Relaxed), 0);
    }
}
