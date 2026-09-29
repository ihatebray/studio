/* =========================================================================
 *  studio — what the compact-bar visualizer listens to
 *
 *  Two sources, one shape: 24 bands from 40 Hz to 16 kHz.
 *
 *   • Local files play through Studio's own <audio> graph. The visualizer
 *     taps it with its own lightly-smoothed analyser: App's shared one is
 *     smoothed heavily for the backgrounds, which smears every beat.
 *   • Saved Spotify tracks play inside the studio-spotify helper, which sends
 *     the same 24 bands about 30 times a second (spectrum.rs).
 *
 *  Both arrive as decibels on one scale (full-scale sine = 0 dB) and go
 *  through the same steps:
 *
 *   1. Timing. Each source is delayed by how far it runs ahead of the
 *      speakers (the helper's device buffer; Web Audio's output latency), so
 *      a kick is drawn when it is heard.
 *   2. Levels that follow the song, not a fixed scale. Every band learns its
 *      own floor (what's always there: a droning sub-bass, room noise) and
 *      ceiling (its recent peaks), and shows where it sits between them.
 *      A bass-heavy mix no longer pins the low bars at the top, so the kick
 *      moves them; an instrument that drops out falls to 0 instead of
 *      hovering; true silence is gated to 0.
 *   3. Beats: onsets are rises in the low bands (spectral flux), against an
 *      adaptive threshold. Their spacing gives the tempo; onsets far from the
 *      next expected beat (off-beat snares, fills) don't move the count, and
 *      a short gap in the drums is bridged at the same tempo.
 *   4. Voice: how much is happening in the vocal range (about 250 Hz to
 *      3.5 kHz) once sustained accompaniment is floored away, smoothed so
 *      drum hits don't read as singing, plus a rough pitch height (where in
 *      that range the energy sits).
 *   5. History: a few seconds of all of the above, for the styles that scroll.
 * ========================================================================= */

export const BANDS = 24;
const LOW_HZ = 40;
const HIGH_HZ = 16000;
export const bandHz = (k) => LOW_HZ * (HIGH_HZ / LOW_HZ) ** (k / BANDS);

/* The vocal range, as band indices (inclusive). */
const VOCAL_LO = (() => { let b = 0; while (b < BANDS && bandHz(b) < 250) b++; return b; })();
const VOCAL_HI = (() => { let b = BANDS - 1; while (b > 0 && bandHz(b + 1) > 3600) b--; return b; })();
export const VOCAL_BANDS = [VOCAL_LO, VOCAL_HI];
const BASS_HI = 5;                           // bands 0–5: roughly 40–110 Hz

/* ---- tuning (see the tests in the Studio notes for how these were set) ---- */
const GATE_DB = -62;          // below this a band is silent
/* A band's floor-to-ceiling span never shrinks below this, so tiny wobbles
   don't read as activity. Tighter for the bass: in a heavy mix the kick only
   lifts the low bands a few dB over the drone, and that has to show. */
const MIN_RANGE_BASS_DB = 8;
const MIN_RANGE_DB = 14;
/* A band's floor is the quietest it has been over a short window: what's
   always there. Short for the bass, so a droning sub-bass is floored within
   a second and only the kicks stand out; longer elsewhere, so a held sung
   note isn't erased while it's being held. */
const FLOOR_WINDOW_BASS_S = 1.0;
const FLOOR_WINDOW_S = 2.5;
const FLOOR_EASE_S = 0.2;     // the floor glides to that minimum
const FLOOR_SLOT_S = 1 / 20;  // resolution of the sliding window
const CEIL_DOWN_S = 4;        // ceiling holds recent peaks for a few seconds
const HELPER_DELAY_S = 0.045; // helper runs ahead by its device buffer (~2048 frames)
const HISTORY_HZ = 30;
export const HISTORY = 150;   // 5 s at 30 Hz

/* ---- helper frames (Spotify) --------------------------------------------- */

const helperQueue = [];      // [{ at (ms), db: Float32Array }]
let subscribed = false;
function subscribeHelper() {
  if (subscribed || typeof window === 'undefined') return;
  const api = window.electronAPI;
  if (!api?.onSpotifyPlayerEvent) return;
  subscribed = true;
  api.onSpotifyPlayerEvent((ev) => {
    if (ev?.event !== 'levels' || !Array.isArray(ev.v)) return;
    const db = new Float32Array(BANDS);
    // spectrum.rs maps -70…-10 dB onto 0–100.
    for (let b = 0; b < BANDS; b++) db[b] = (ev.v[b] || 0) > 0 ? -70 + ev.v[b] * 0.6 : -100;
    helperQueue.push({ at: performance.now(), db });
    if (helperQueue.length > 40) helperQueue.shift();
  });
}
/** The newest helper frame that is due at `now` (after the output delay). */
function helperFrameAt(now) {
  const due = now - HELPER_DELAY_S * 1000;
  let pick = null;
  for (const f of helperQueue) if (f.at <= due) pick = f;
  if (!pick || due - pick.at > 250) return null;   // stale: nothing playing
  return pick;
}

/* ---- local files: the visualizer's own analyser -------------------------- */

const tapFor = new WeakMap();
/* A second analyser hung off App's, with light smoothing and a longer FFT for
   bass detail. Analysers pass audio through untouched and Chromium runs them
   without a downstream connection, so this changes nothing you hear. */
function vizTap(shared) {
  let tap = tapFor.get(shared);
  if (tap) return tap;
  try {
    const ctx = shared.context;
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.35;
    shared.connect(an);
    const binHz = ctx.sampleRate / an.fftSize;
    const n = an.frequencyBinCount;
    const edges = Array.from({ length: BANDS }, (_, b) => {
      const lo = Math.min(n - 1, Math.max(1, Math.round(bandHz(b) / binHz)));
      const hi = Math.min(n, Math.max(lo + 1, Math.round(bandHz(b + 1) / binHz)));
      return [lo, hi];
    });
    tap = { an, ctx, edges, bins: new Float32Array(n), queue: [] };
    tapFor.set(shared, tap);
  } catch {
    tap = null;
  }
  return tap;
}
/* Web Audio's dB sit 13.5 dB below the helper's for the same signal (it
   divides by the FFT size and uses a Blackman window); shift onto one scale. */
const WEBAUDIO_OFFSET_DB = 13.5;
function readTap(tap, now) {
  tap.an.getFloatFrequencyData(tap.bins);
  const db = new Float32Array(BANDS);
  for (let b = 0; b < BANDS; b++) {
    const [lo, hi] = tap.edges[b];
    let peak = -Infinity;
    for (let k = lo; k < hi; k++) if (tap.bins[k] > peak) peak = tap.bins[k];
    db[b] = Number.isFinite(peak) ? peak + WEBAUDIO_OFFSET_DB : -100;
  }
  // The analyser hears the audio before the speakers do, by the context's
  // output latency; hold each frame back by that much.
  const delay = Math.min(0.12, (tap.ctx.outputLatency || 0) + (tap.ctx.baseLatency || 0)) * 1000;
  tap.queue.push({ at: now, db });
  while (tap.queue.length > 1 && tap.queue[1].at <= now - delay) tap.queue.shift();
  return tap.queue[0];
}

/* ---- the source ------------------------------------------------------------ */

const ease = (dt, seconds) => 1 - Math.exp(-dt / Math.max(1e-3, seconds));

export class LevelSource {
  constructor() {
    subscribeHelper();
    this.norm = new Float32Array(BANDS);     // where each band sits in its own range, 0–1
    this.levels = new Float32Array(BANDS);   // smoothed, what the styles draw
    this.floor = new Float32Array(BANDS).fill(-70);
    // per band: the minimum of each 50 ms slot over the last few seconds
    this._slots = Array.from({ length: BANDS }, (_, b) => new Float32Array(Math.ceil((b <= BASS_HI ? FLOOR_WINDOW_BASS_S : FLOOR_WINDOW_S) / FLOOR_SLOT_S)).fill(0));
    this._slotMin = new Float32Array(BANDS).fill(0);
    this._slotI = 0;
    this._slotAcc = 0;
    this.ceil = new Float32Array(BANDS).fill(-40);
    this.prevNorm = new Float32Array(BANDS);
    this.loud = 0;
    this.bass = 0;
    this.highs = 0;
    // voice
    this.vocal = 0;          // presence, 0–1
    this.vocalPitch = 0.5;   // where the melody sits in this song's range, 0 (low) – 1 (high)
    this._vocalSmooth = 0;
    this._pitchRaw = (VOCAL_LO + VOCAL_HI) / 2;
    this._pitchLo = this._pitchRaw - 1;
    this._pitchHi = this._pitchRaw + 1;
    // beats
    this.beats = 0;
    this.beatAt = 0;         // seconds (performance clock) of the last beat
    this.period = 0.5;
    this.tempoConfidence = 0;
    this.onset = 0;          // this frame's onset strength, for styles that flash
    this._onsets = [];
    this._odfMean = 0;
    this._odfDev = 0.02;
    this._lastOnset = -1;
    this._quietFor = 0;
    // history, newest at head-1
    this.hist = new Float32Array(HISTORY * BANDS);
    this.histVocal = new Float32Array(HISTORY);
    this.histPitch = new Float32Array(HISTORY).fill(0.5);
    this.histBeat = new Uint8Array(HISTORY);
    this.histHead = 0;
    this._histAcc = 0;
    this._beatSinceHist = false;
    this._lastFrame = null;
    this._frameGap = 1 / 60;
    this._punch = 0;
  }

  /**
   * @param {number} dt   seconds since the last call
   * @param {object} o    { playing, streamed, analyser, frame, now }
   *                      `frame` (dB per band) bypasses both sources: demos, tests.
   */
  update(dt, { playing, streamed, analyser, frame, now = performance.now() } = {}) {
    const t = now / 1000;
    let db = null;
    let fresh = false;
    if (playing) {
      let f = null;
      if (frame) f = { at: now, db: frame };
      else if (streamed) f = helperFrameAt(now);
      else if (analyser) { const tap = vizTap(analyser); if (tap) f = readTap(tap, now); }
      if (f) {
        db = f.db;
        fresh = f !== this._lastFrame;
        if (fresh && this._lastFrame) this._frameGap = Math.min(0.1, (f.at - this._lastFrame.at) / 1000) || this._frameGap;
        this._lastFrame = f;
      }
    }

    // 2. each band between its own floor and ceiling
    let rollSlot = false;
    if (db) {
      this._slotAcc += dt;
      if (this._slotAcc >= FLOOR_SLOT_S) { this._slotAcc %= FLOOR_SLOT_S; rollSlot = true; }
    }
    for (let b = 0; b < BANDS; b++) {
      const x = db ? Math.max(-100, Math.min(0, db[b])) : -100;
      if (db) {
        // sliding minimum: the current slot keeps its lowest value; when it
        // rolls over, the window's minimum is recomputed
        const slots = this._slots[b];
        const i = this._slotI % slots.length;
        if (rollSlot) {
          let m = 0;
          for (let k = 0; k < slots.length; k++) if (slots[k] < m) m = slots[k];
          this._slotMin[b] = m;
          slots[(this._slotI + 1) % slots.length] = x;
        } else if (x < slots[i]) slots[i] = x;
        const target = Math.min(this._slotMin[b], x);
        this.floor[b] += (target - this.floor[b]) * ease(dt, target < this.floor[b] ? 0.05 : FLOOR_EASE_S);
        if (x > this.ceil[b]) this.ceil[b] = x;
        else this.ceil[b] += (x - this.ceil[b]) * ease(dt, CEIL_DOWN_S);
        const minRange = b <= BASS_HI ? MIN_RANGE_BASS_DB : MIN_RANGE_DB;
        if (this.ceil[b] < this.floor[b] + minRange) this.ceil[b] = this.floor[b] + minRange;
      }
      let n = 0;
      if (db && x > GATE_DB) {
        const rel = (x - this.floor[b]) / (this.ceil[b] - this.floor[b]);
        const abs = Math.min(1, (x - GATE_DB) / 52);
        n = Math.max(0, Math.min(1, rel)) * (0.7 + 0.3 * abs);
      }
      this.norm[b] = n;
    }
    if (rollSlot) this._slotI += 1;

    // 3. beats (before drawing levels, so a kick found this frame shows now)
    this.onset = 0;
    if (fresh) this._track(t);
    // A detected kick punches the bass bars: in a heavy mix the kick only
    // lifts the low bands a few dB over the drone, and this makes every one
    // read. It only fires on onsets, so quiet passages stay quiet.
    this._punch *= 1 - ease(dt, 0.1);
    if (this.onset > 0) this._punch = Math.max(this._punch, 0.35 + 0.4 * this.onset);

    // what the styles draw: quick to rise, quick enough to fall that a
    // stopped instrument is gone in a fraction of a second
    const up = ease(dt, 0.03);
    const down = ease(dt, playing ? 0.11 : 0.2);
    let loud = 0;
    for (let b = 0; b < BANDS; b++) {
      const punch = b <= BASS_HI ? this._punch * (1 - b / (BASS_HI + 2)) : 0;
      const target = Math.min(1, this.norm[b] + punch);
      this.levels[b] += (target - this.levels[b]) * (target > this.levels[b] ? up : down);
      if (this.levels[b] < 0.004) this.levels[b] = 0;
      loud += this.levels[b] * (1 - (b / BANDS) * 0.4);
    }
    this.loud = Math.min(1, loud / (BANDS * 0.55));
    let bass = 0;
    for (let b = 0; b <= 3; b++) bass += this.levels[b];
    this.bass = bass / 4;
    let highs = 0;
    for (let b = BANDS - 4; b < BANDS; b++) highs += this.levels[b];
    this.highs = highs / 4;

    // 4. voice
    let vs = 0;
    let vmax = 0;
    for (let b = VOCAL_LO; b <= VOCAL_HI; b++) {
      vs += this.norm[b];
      if (this.norm[b] > vmax) vmax = this.norm[b];
    }
    const vocalNow = vs / (VOCAL_HI - VOCAL_LO + 1);
    // Sustained, not struck: slow-ish attack keeps a snare's 50 ms burst from
    // reading as a sung line, the release keeps a phrase joined up.
    this._vocalSmooth += (vocalNow - this._vocalSmooth) * ease(dt, vocalNow > this._vocalSmooth ? 0.09 : 0.22);
    this.vocal = Math.max(0, Math.min(1, (this._vocalSmooth - 0.08) / 0.42));
    /* Pitch height: a voice's lowest strong band is close to the note being
       sung (its fundamental); the bands above it are its harmonics. Refined
       between neighbouring bands, then placed within this song's own recent
       range, so every song's melody uses the whole height. */
    if (vmax > 0.12 && this.vocal > 0.05) {
      let b = VOCAL_LO;
      while (b < VOCAL_HI && this.norm[b] < vmax * 0.55) b++;
      const l = b > VOCAL_LO ? this.norm[b - 1] : 0;
      const r = b < VOCAL_HI ? this.norm[b + 1] : 0;
      const c = this.norm[b];
      const off = c > 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (r - l) / Math.max(1e-3, c + Math.max(l, r)))) : 0;
      const raw = b + off;
      this._pitchRaw += (raw - this._pitchRaw) * ease(dt, 0.08);
      if (this._pitchRaw < this._pitchLo) this._pitchLo = this._pitchRaw;
      else this._pitchLo += (this._pitchRaw - this._pitchLo) * ease(dt, 8);
      if (this._pitchRaw > this._pitchHi) this._pitchHi = this._pitchRaw;
      else this._pitchHi += (this._pitchRaw - this._pitchHi) * ease(dt, 8);
      const span = Math.max(2, this._pitchHi - this._pitchLo);
      const mid = (this._pitchHi + this._pitchLo) / 2;
      this.vocalPitch = Math.max(0, Math.min(1, 0.5 + (this._pitchRaw - mid) / span));
    }

    // bridging gaps in the drums
    if (this.loud < 0.03) this._quietFor += dt; else this._quietFor = 0;
    // Bridge a short gap in the drums at the known tempo, for up to 8 beats;
    // stop once the music has.
    if (playing && this.tempoConfidence >= 0.5 && this._quietFor < 1.5
      && t - this._lastOnset < this.period * 8 && t - this.beatAt > this.period * 1.3) {
      this._beat(this.beatAt + this.period);
    }

    // 5. history: only while music is coming in, so a pause freezes it
    if (db) this._histAcc += dt;
    if (db && this._histAcc >= 1 / HISTORY_HZ) {
      this._histAcc %= 1 / HISTORY_HZ;
      const h = this.histHead;
      this.hist.set(this.norm, h * BANDS);
      this.histVocal[h] = this.vocal;
      this.histPitch[h] = this.vocalPitch;
      this.histBeat[h] = this._beatSinceHist ? 1 : 0;
      this._beatSinceHist = false;
      this.histHead = (h + 1) % HISTORY;
    }
  }

  _track(t) {
    // Onset strength: how much the low bands rose since the last frame.
    let odf = 0;
    for (let b = 0; b <= BASS_HI; b++) odf += Math.max(0, this.norm[b] - this.prevNorm[b]);
    this.prevNorm.set(this.norm);
    odf /= BASS_HI + 1;
    const a = 0.06;
    const threshold = this._odfMean + Math.max(0.035, 2.2 * this._odfDev);
    const isOnset = odf > threshold && odf > 0.05 && t - this._lastOnset > 0.2;
    this._odfMean += (odf - this._odfMean) * a;
    this._odfDev += (Math.abs(odf - this._odfMean) - this._odfDev) * a;
    if (!isOnset) return;
    this.onset = Math.min(1, odf * 4);
    this._lastOnset = t;
    this._onsets.push(t);
    while (this._onsets.length && t - this._onsets[0] > 6) this._onsets.shift();
    this._estimateTempo();

    // The rise happened somewhere since the previous frame; date it midway.
    const at = t - this._frameGap / 2;
    if (this.tempoConfidence < 0.5) { this._beat(at); return; }
    // With a tempo, only onsets near the next beat move the count; they also
    // pull the phase back into line.
    const since = at - this.beatAt;
    // Just after a beat (one bridged a moment early, as the drums come back
    // in): this is the same beat; correct its timing instead of counting it.
    if (since < this.period * 0.5) { this.beatAt = at; return; }
    const off = Math.abs(since - this.period) / this.period;
    if (off < 0.28 || since > this.period * 1.28) this._beat(at);
  }

  /* Tempo from the spacing of recent onsets: every pair within 2.5 s votes
     for its interval folded into 0.34–0.75 s (80–176 BPM), and the busiest
     10 ms bin (with its neighbours) wins. */
  _estimateTempo() {
    const on = this._onsets;
    if (on.length < 4) { this.tempoConfidence = 0; return; }
    const lo = 0.34;
    const hi = 0.75;
    const bins = new Float32Array(Math.ceil((hi - lo) / 0.01) + 1);
    let votes = 0;
    for (let i = 0; i < on.length; i++) {
      for (let j = i + 1; j < on.length; j++) {
        let d = on[j] - on[i];
        if (d > 2.5) break;
        while (d > hi) d /= 2;
        while (d < lo) d *= 2;
        if (d > hi) continue;
        const k = Math.round((d - lo) / 0.01);
        const wgt = 1 / (j - i);                  // neighbours count most
        bins[k] += wgt;
        if (k > 0) bins[k - 1] += wgt * 0.5;
        if (k < bins.length - 1) bins[k + 1] += wgt * 0.5;
        votes += wgt;
      }
    }
    let best = 0;
    for (let k = 1; k < bins.length; k++) if (bins[k] > bins[best]) best = k;
    const period = lo + best * 0.01;
    const conf = votes > 0 ? bins[best] / votes : 0;
    this.period += (period - this.period) * 0.5;
    this.tempoConfidence = Math.min(1, conf * 3 * Math.min(1, on.length / 8));
  }

  _beat(at) {
    this.beats += 1;
    this.beatAt = at;
    this._beatSinceHist = true;
  }

  /** 0–1 through the current beat. */
  beatPhase(now = performance.now()) {
    return Math.min(0.999, Math.max(0, (now / 1000 - this.beatAt) / (this.period || 0.5)));
  }

  /** Band values from `ago` history steps back (0 = newest). */
  histAt(ago) {
    const i = (this.histHead - 1 - ago + HISTORY * 4) % HISTORY;
    return this.hist.subarray(i * BANDS, i * BANDS + BANDS);
  }

  histIndex(ago) {
    return (this.histHead - 1 - ago + HISTORY * 4) % HISTORY;
  }
}

/* ---- a stand-in song, for the Settings previews and the tests --------------
 * 100 BPM, 16 bars on a loop, in decibels per band:
 *   bars 0–1   intro: a pad and a quiet hi-hat
 *   bars 2–11  kick, snare, hats, a heavy sustained sub-bass, and a sung melody
 *              in two-bar phrases with a beat of rest between them
 *   bars 12–13 breakdown: drums and bass drop out, the voice carries on
 *   bars 14–15 everything back in
 */
export const DEMO_BPM = 100;
export function synthSong(t, out = new Float32Array(BANDS)) {
  const spb = 60 / DEMO_BPM;
  const beatF = t / spb;
  const beat = Math.floor(beatF);
  const ph = (beatF - beat) * spb;              // seconds into the beat
  const bar = Math.floor(beat / 4) % 16;
  const inBar = beat % 4;
  const drums = bar >= 2 && !(bar === 12 || bar === 13);
  const bassOn = drums;
  const sing = bar >= 2;
  for (let b = 0; b < BANDS; b++) out[b] = -78 + 2 * Math.sin(b * 1.7 + t * 3);   // room noise
  const add = (b, db) => { if (b >= 0 && b < BANDS) out[b] = 10 * Math.log10(10 ** (out[b] / 10) + 10 ** (db / 10)); };
  // pad (always, soft, mid-low)
  for (let b = 6; b <= 12; b++) add(b, -46 + 3 * Math.sin(t * 0.7 + b));
  if (bassOn) {
    // heavy sub-bass that barely changes: the case that used to pin the bars
    for (let b = 0; b <= 4; b++) add(b, -9 - b * 1.5 + 1.5 * Math.sin(t * 0.9));
  }
  if (drums) {
    const kick = Math.exp(-ph / 0.07);          // on every beat
    for (let b = 0; b <= 5; b++) add(b, -8 + 20 * Math.log10(0.02 + kick) - b * 0.5);
    if (inBar === 1 || inBar === 3) {           // snare on 2 and 4
      const sn = Math.exp(-ph / 0.09);
      for (let b = 9; b <= 17; b++) add(b, -14 + 20 * Math.log10(0.01 + sn));
    }
  }
  if (bar >= 1) {                                // hats on the eighths
    const hp = (beatF * 2) % 1 * spb / 2;
    const hat = Math.exp(-hp / 0.03);
    for (let b = 19; b <= 23; b++) add(b, (drums ? -18 : -30) + 20 * Math.log10(0.01 + hat));
  }
  if (sing) {
    // two-bar phrases, resting on the last beat of the second bar
    const phraseBeat = beat % 8;
    if (phraseBeat !== 7) {
      const melody = [0.2, 0.35, 0.5, 0.35, 0.65, 0.8, 0.5];
      const p = melody[phraseBeat] + 0.03 * Math.sin(t * 34);   // with vibrato
      const f0 = VOCAL_LO + 1 + p * (VOCAL_HI - VOCAL_LO - 5);
      const env = Math.min(1, ph / 0.04) * (0.85 + 0.15 * Math.sin(t * 5));
      for (let b = VOCAL_LO; b <= VOCAL_HI; b++) {
        const d = b - f0;
        // fundamental plus two formant-ish humps above it
        const shape = Math.exp(-(d * d) / 1.2) + 0.55 * Math.exp(-((d - 3) ** 2) / 1.5) + 0.3 * Math.exp(-((d - 6) ** 2) / 2);
        if (shape > 0.02) add(b, -16 + 20 * Math.log10(shape * env));
      }
    }
  }
  return out;
}

/** A LevelSource fed by the stand-in song (Settings previews). */
export function demoLevelSource(startAt = 12) {
  const src = new LevelSource();
  const frame = new Float32Array(BANDS);
  let t = startAt;
  let clock = 0;
  const update = src.update.bind(src);
  src.update = (dt) => {
    t += dt;
    clock += dt * 1000;
    update(dt, { playing: true, frame: synthSong(t, frame), now: clock });
  };
  src.beatPhase = () => Math.min(0.999, Math.max(0, (clock / 1000 - src.beatAt) / (src.period || 0.5)));
  return src;
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
