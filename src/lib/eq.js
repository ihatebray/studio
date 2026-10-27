/* =========================================================================
 *  The equalizer: bands, presets and the filter math.
 *
 *  Ten peaking filters an octave apart, ±12 dB each. Local files run
 *  through Web Audio's BiquadFilterNode ('peaking'), which is defined by
 *  the same formulas as peaking() below (the Audio EQ Cookbook), and Spotify
 *  songs through the helper's copy of them (studio-spotify/src/eq.rs), so
 *  both sound the same.
 *
 *  Raising bands can push the loudest parts past full scale, which would
 *  distort. So the whole signal is lowered by the curve's highest point
 *  (eqHeadroomDb): a raised band sounds louder against the rest, nothing
 *  gets louder than the song was, and nothing clips.
 * ========================================================================= */

export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
/** An octave wide, so neighbouring bands meet without gaps or bumps. */
export const EQ_Q = 1.41;
export const EQ_MAX_DB = 12;
export const EQ_FLAT = EQ_BANDS.map(() => 0);

/** [id, label, gains]. Gentle on purpose: a few dB is a big change. */
export const EQ_PRESETS = [
  ['flat', 'Flat', EQ_FLAT],
  ['bass', 'Bass Boost', [6, 5, 3.5, 1.5, 0, 0, 0, 0, 0, 0]],
  ['bassCut', 'Bass Reducer', [-6, -5, -3.5, -1.5, 0, 0, 0, 0, 0, 0]],
  ['treble', 'Treble Boost', [0, 0, 0, 0, 0, 0, 1.5, 3.5, 5, 6]],
  ['trebleCut', 'Treble Reducer', [0, 0, 0, 0, 0, 0, -1.5, -3.5, -5, -6]],
  ['vocal', 'Vocal', [-2, -2, -1, 0, 1.5, 3, 3, 2, 0, -1]],
  ['loudness', 'Loudness', [5, 4, 1.5, 0, -1, -1, 0, 1, 3, 4]],
  ['acoustic', 'Acoustic', [3, 3, 2, 0.5, 1, 1, 2, 2.5, 2, 1.5]],
  ['electronic', 'Electronic', [4.5, 4, 1, 0, -1.5, 1, 0.5, 1, 4, 4.5]],
];

export const EQ_DEFAULT = { on: false, gains: EQ_FLAT };

export function clampGain(db) {
  const v = Number(db);
  return Number.isFinite(v) ? Math.max(-EQ_MAX_DB, Math.min(EQ_MAX_DB, Math.round(v * 2) / 2)) : 0;
}

/** A saved setting, made safe to use. */
export function readEq(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const gains = Array.isArray(v.gains) && v.gains.length === EQ_BANDS.length ? v.gains.map(clampGain) : EQ_FLAT;
  return { on: !!v.on, gains };
}

/** The preset these gains are, or 'custom'. */
export function presetOf(gains) {
  const hit = EQ_PRESETS.find(([, , g]) => g.every((x, i) => x === gains[i]));
  return hit ? hit[0] : 'custom';
}

/** Peaking filter coefficients (Audio EQ Cookbook), normalised so a0 = 1. */
export function peaking(f0, gainDb, q, fs) {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha / A;
  return {
    b0: (1 + alpha * A) / a0,
    b1: (-2 * cos) / a0,
    b2: (1 - alpha * A) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha / A) / a0,
  };
}

/** Gain of one filter at `f`, in dB. */
function filterDb({ b0, b1, b2, a1, a2 }, f, fs) {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
  const dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** The whole curve's gain at `f`, in dB. */
export function responseDb(gains, f, fs = 48000) {
  let db = 0;
  EQ_BANDS.forEach((f0, i) => { if (gains[i]) db += filterDb(peaking(f0, gains[i], EQ_Q, fs), f, fs); });
  return db;
}

/** Frequencies the curve is checked (and drawn) at: 20 Hz to 20 kHz. */
export const EQ_CURVE_FREQS = Array.from({ length: 160 }, (_, i) => 20 * 1000 ** (i / 159));

/** How far the whole signal is lowered so raised bands can't clip (<= 0). */
export function eqHeadroomDb(gains) {
  let top = 0;
  for (const f of EQ_CURVE_FREQS) top = Math.max(top, responseDb(gains, f));
  return top > 0 ? -Math.round(top * 10) / 10 : 0;
}
