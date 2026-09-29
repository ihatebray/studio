/* =========================================================================
 *  studio — what the compact-bar visualizer listens to
 *
 *  Two sources, one shape: 24 bands from 40 Hz to 16 kHz, each 0–1.
 *
 *   • Local files play through Studio's own <audio> graph, so the Web Audio
 *     analyser App already builds is read directly.
 *   • Saved Spotify tracks play inside the studio-spotify helper, which Studio
 *     never gets audio from; the helper sends the same 24 bands about 30 times
 *     a second instead (spectrum.rs), timed to what is actually playing.
 *
 *  On top of the bands: a smoothed copy for drawing, overall loudness, bass
 *  and treble, and a simple beat tracker (bass onsets plus a tempo estimate)
 *  for the styles that move on the beat.
 * ========================================================================= */

export const BANDS = 24;
const LOW_HZ = 40;
const HIGH_HZ = 16000;
const bandHz = (k) => LOW_HZ * (HIGH_HZ / LOW_HZ) ** (k / BANDS);

/* ---- helper levels (Spotify) -------------------------------------------- */

let helperLevels = null;   // Uint8-ish array, 0–100
let helperAt = 0;
let subscribed = false;
function subscribeHelper() {
  if (subscribed || typeof window === 'undefined') return;
  const api = window.electronAPI;
  if (!api?.onSpotifyPlayerEvent) return;
  subscribed = true;
  api.onSpotifyPlayerEvent((ev) => {
    if (ev?.event !== 'levels' || !Array.isArray(ev.v)) return;
    helperLevels = ev.v;
    helperAt = performance.now();
  });
}

/* ---- analyser (local files) ---------------------------------------------
 * The analyser's dB scale sits about 13.5 dB below the helper's for the same
 * signal (it divides by the FFT size and uses a Blackman window), so the
 * window here is shifted by that much and both sources read alike. */
const AN_FLOOR_DB = -83.5;
const RANGE_DB = 60;
let binEdges = null;
let binKey = '';
let bytes = null;
function readAnalyser(an, out) {
  const n = an.frequencyBinCount;
  const key = `${n}|${an.context.sampleRate}`;
  if (key !== binKey) {
    const binHz = an.context.sampleRate / an.fftSize;
    binEdges = Array.from({ length: BANDS }, (_, b) => {
      const lo = Math.min(n - 1, Math.max(1, Math.round(bandHz(b) / binHz)));
      const hi = Math.min(n, Math.max(lo + 1, Math.round(bandHz(b + 1) / binHz)));
      return [lo, hi];
    });
    bytes = new Uint8Array(n);
    binKey = key;
  }
  an.getByteFrequencyData(bytes);
  const minDb = an.minDecibels;
  const span = an.maxDecibels - an.minDecibels;
  for (let b = 0; b < BANDS; b++) {
    const [lo, hi] = binEdges[b];
    let peak = 0;
    for (let k = lo; k < hi; k++) if (bytes[k] > peak) peak = bytes[k];
    const db = minDb + (peak / 255) * span;
    out[b] = peak ? Math.min(1, Math.max(0, (db - AN_FLOOR_DB) / RANGE_DB)) : 0;
  }
}

/* ---- the source ---------------------------------------------------------- */

export class LevelSource {
  constructor() {
    subscribeHelper();
    this.raw = new Float32Array(BANDS);
    this.levels = new Float32Array(BANDS);   // smoothed, what styles draw
    this.loud = 0;
    this.bass = 0;
    this.highs = 0;
    // beat tracking
    this.beats = 0;
    this.beatAt = 0;
    this.period = 0.5;
    this.intervals = [];
    this.bassMean = 0;
    this.bassVar = 0.004;
    this.prevBass = 0;
    this.lastOnset = -1;
  }

  /**
   * @param {number} dt       seconds since the last frame
   * @param {object} o        { playing, streamed, analyser }
   */
  update(dt, { playing, streamed, analyser }) {
    const now = performance.now() / 1000;
    const raw = this.raw;
    if (!playing) raw.fill(0);
    else if (streamed) {
      const fresh = helperLevels && performance.now() - helperAt < 250;
      for (let b = 0; b < BANDS; b++) raw[b] = fresh ? (helperLevels[b] || 0) / 100 : 0;
    } else if (analyser) readAnalyser(analyser, raw);
    else raw.fill(0);

    // Fast attack, slower release; frame-rate independent.
    const up = 1 - Math.exp(-dt * 30);
    const down = 1 - Math.exp(-dt * (playing ? 7 : 3));
    let loud = 0;
    for (let b = 0; b < BANDS; b++) {
      const t = raw[b];
      this.levels[b] += (t - this.levels[b]) * (t > this.levels[b] ? up : down);
      loud += this.levels[b] * (1 - (b / BANDS) * 0.5);
    }
    this.loud = Math.min(1, loud / (BANDS * 0.62));
    this.bass = (this.levels[0] + this.levels[1] + this.levels[2] + this.levels[3]) / 4;
    this.highs = (this.levels[BANDS - 4] + this.levels[BANDS - 3] + this.levels[BANDS - 2] + this.levels[BANDS - 1]) / 4;

    if (playing) this._track(now, dt, (raw[0] + raw[1] + raw[2] + raw[3]) / 4);
  }

  /* Bass onsets against a running mean and spread; the gaps between them give
     the tempo. When a quiet stretch has no onsets, beats carry on at the last
     tempo so the rhythm styles don't freeze mid-song. */
  _track(now, dt, bass) {
    const a = 1 - Math.exp(-dt * 2.2);
    const d = bass - this.bassMean;
    this.bassMean += d * a;
    this.bassVar += (d * d - this.bassVar) * a;
    const rising = bass > this.prevBass;
    this.prevBass = bass;
    const threshold = this.bassMean + Math.max(0.05, 1.3 * Math.sqrt(this.bassVar));
    if (rising && bass > threshold && bass > 0.12 && now - this.lastOnset > 0.27) {
      if (this.lastOnset > 0) {
        const gap = now - this.lastOnset;
        if (gap > 0.28 && gap < 1.25) {
          this.intervals.push(gap);
          if (this.intervals.length > 9) this.intervals.shift();
          const sorted = [...this.intervals].sort((x, y) => x - y);
          this.period = sorted[Math.floor(sorted.length / 2)];
        }
      }
      this.lastOnset = now;
      this._beat(now);
    } else if (this.intervals.length >= 3 && now - this.beatAt > this.period * 1.08) {
      this._beat(this.beatAt + this.period);
    }
  }

  _beat(at) {
    this.beats += 1;
    this.beatAt = at;
  }

  /** 0–1 through the current beat. */
  beatPhase() {
    const now = performance.now() / 1000;
    return Math.min(0.999, Math.max(0, (now - this.beatAt) / (this.period || 0.5)));
  }
}

/* ---- the song's shape, for the progress ribbon -------------------------------
 * Nothing knows a streamed song's waveform in advance, so the ribbon learns it
 * as it plays: each slot keeps the loudness heard there. Unheard slots stay at
 * a low baseline. Kept for the session, per track. */
export const SHAPE_SLOTS = 240;
const shapes = new Map();
export function shapeFor(trackId) {
  if (!trackId) return null;
  let s = shapes.get(trackId);
  if (!s) {
    s = new Float32Array(SHAPE_SLOTS).fill(-1);
    shapes.set(trackId, s);
    if (shapes.size > 200) shapes.delete(shapes.keys().next().value);
  }
  return s;
}
