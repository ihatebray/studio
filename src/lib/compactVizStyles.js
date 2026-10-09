/* =========================================================================
 *  studio — the compact-bar visualizer styles
 *
 *  Nine ways to fill the empty middle of the library bar in compact mode:
 *  seven equalizers (capsules, strings, dots and analyser curves), the song's
 *  progress, and its rhythm. Every style draws into one small canvas from
 *  the same frame:
 *
 *    f = { ctx, w, h, dpr,           canvas and its size in CSS px
 *          src,                      LevelSource (vizLevels.js) or the demo
 *          t, dt, playing,           time that only runs while playing
 *          palette,                  [[r,g,b] × 4]: the cover's, lifted, or
 *                                    all white when cover colours are off
 *          progress, hover, shape,   for the progress ribbon
 *          s }                       this view's own state
 *
 *  Nothing ends at a hard edge: the canvas fades out at both ends
 *  (CompactVisualizer.jsx), and every style keeps its marks inside its space.
 *  Sizes adapt to the width, and no size or radius can go negative, so a
 *  narrow window never throws.
 * ========================================================================= */

import { BANDS, demoLevelSource } from './vizLevels.js';

export const VIZ_STYLES = [
  { id: 'neon', name: 'Neon capsules', note: 'Glowing bars, mirrored from the center', soft: true },
  { id: 'capsuleq', name: 'Capsule EQ', note: 'Capsules on a floor, with a reflection', soft: true },
  { id: 'strings', name: 'Neon strings', note: 'Thin glowing lines, mirrored', soft: true },
  { id: 'dots', name: 'Dot matrix', note: 'An LED equalizer, in dots', soft: true },
  { id: 'proq', name: 'Pro-Q curve', note: 'An analyzer curve over the spectrum', soft: true },
  { id: 'peakcurve', name: 'Peak curve', note: 'Pro-Q with a falling peak line', soft: true },
  { id: 'layers', name: 'Layered curves', note: 'Three curves at three speeds', soft: true },
  { id: 'ribbon', name: 'Progress ribbon', note: 'The song end to end; click to seek' },
  { id: 'steps', name: 'Beat steps', note: 'Sixteen steps, one bar of music' },
];
export const VIZ_IDS = new Set(VIZ_STYLES.map((s) => s.id));
/** Styles that stay inside their space by construction, so they only need a
 *  slight fade top and bottom and can use the full height. */
export const SOFT_EDGE = new Set(VIZ_STYLES.filter((s) => s.soft).map((s) => s.id));

/* ---- shared helpers ---- */

const smooth = (a) => a * a * (3 - 2 * a);
/** 0 at both ends of the space, 1 across the middle. */
export const edge = (x) => smooth(Math.min(1, x / 0.14)) * smooth(Math.min(1, (1 - x) / 0.14));
/** Low frequencies in the middle, spreading out to both ends. */
function mirrored(src, x) {
  const f = Math.abs(x - 0.5) * 2 * (BANDS - 1);
  const i = Math.floor(f);
  const k = f - i;
  const L = src.levels;
  return L[i] * (1 - k) + L[Math.min(BANDS - 1, i + 1)] * k;
}
/** Bass on the left, treble on the right: how an equalizer reads. */
function linear(src, x) {
  const f = Math.min(1, Math.max(0, x)) * (BANDS - 1);
  const i = Math.floor(f);
  const k = f - i;
  const L = src.levels;
  return L[i] * (1 - k) + L[Math.min(BANDS - 1, i + 1)] * k;
}
function mix(pal, x) {
  const s = x * (pal.length - 1);
  const i = Math.min(pal.length - 2, Math.floor(s));
  const k = s - i;
  const a = pal[i];
  const b = pal[i + 1] || a;
  return [0, 1, 2].map((j) => Math.round(a[j] + (b[j] - a[j]) * k));
}
const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`;
/** roundRect throws on a negative radius; never hand it one. */
function rrect(ctx, x, y, w, h, r) {
  const ww = Math.max(0, w);
  const hh = Math.max(0, h);
  ctx.roundRect(x, y, ww, hh, Math.max(0, Math.min(r, ww / 2, hh / 2)));
}

/* ---- Neon capsules ----
 * Wide rounded bars mirrored from the centre line, bass in the middle, each
 * glowing in the cover's colours; the glow grows a little on loud hits. It is
 * kept tight: at most about the width of the gap between capsules. A wider
 * one (it used to reach 16px) ran neighbouring glows together into a haze
 * over the whole bar. */
function neon(f) {
  const { ctx, w, h, dpr, src, palette } = f;
  const span = w * 0.8;
  const gap = 7;
  const n = Math.max(5, Math.min(18, Math.floor(span / 16)));
  const bw = Math.max(3, Math.min(9, (span - gap * (n - 1)) / n));
  const total = bw * n + gap * (n - 1);
  const x0 = (w - total) / 2;
  const mid = h / 2;
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    const L = mirrored(src, x);
    const half = Math.max(bw / 2, L * (mid - 3));
    const [r, g, b] = mix(palette, x);
    const lift = (c) => Math.round(c + (255 - c) * 0.5);
    ctx.shadowColor = `rgba(${r},${g},${b},${0.5 + 0.5 * L})`;
    ctx.shadowBlur = Math.min(gap * 0.65, 2 + 2.5 * L) * dpr;
    ctx.fillStyle = `rgba(${lift(r)},${lift(g)},${lift(b)},${(0.55 + 0.45 * L) * (0.35 + 0.65 * edge(x))})`;
    ctx.beginPath();
    rrect(ctx, (x0 + i * (bw + gap)) * dpr, (mid - half) * dpr, bw * dpr, half * 2 * dpr, (bw / 2) * dpr);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}

/* ---- Pro-Q curve ----
 * One smooth analyser curve, 40 Hz to 16 kHz on a log axis, with a soft fill
 * under it and faint gridlines at 100 Hz, 1 kHz and 10 kHz. */
function proq(f) {
  const { ctx, w, h, dpr, src, palette } = f;
  const x0 = w * 0.07;
  const x1 = w * 0.93;
  const floor = h * 0.9;
  const top = h * 0.08;
  if (x1 - x0 < 8) return;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  for (const hz of [100, 1000, 10000]) {
    const gx = x0 + (Math.log(hz / 40) / Math.log(16000 / 40)) * (x1 - x0);
    ctx.fillRect(gx * dpr, top * dpr, 1 * dpr, (floor - top) * dpr);
  }
  const pts = [];
  for (let px = x0; px <= x1; px += 3) pts.push([px, floor - linear(src, (px - x0) / (x1 - x0)) * (floor - top)]);
  if (pts.length < 3) return;
  const curve = () => {
    ctx.moveTo(pts[0][0] * dpr, pts[0][1] * dpr);
    for (let i = 1; i < pts.length - 1; i++) {
      const xc = (pts[i][0] + pts[i + 1][0]) / 2;
      const yc = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0] * dpr, pts[i][1] * dpr, xc * dpr, yc * dpr);
    }
  };
  const col = palette[0];
  ctx.beginPath();
  curve();
  ctx.lineTo(x1 * dpr, floor * dpr);
  ctx.lineTo(x0 * dpr, floor * dpr);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, top * dpr, 0, floor * dpr);
  g.addColorStop(0, rgba(col, 0.55));
  g.addColorStop(1, rgba(col, 0.02));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.beginPath();
  curve();
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 1.6 * dpr;
  ctx.lineJoin = 'round';
  ctx.shadowColor = rgba(col, 0.9);
  ctx.shadowBlur = 6 * dpr;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

/* ---- Progress ribbon ---- */
function ribbon(f) {
  const { ctx, w, h, dpr, src, progress, hover, shape } = f;
  const step = 4;
  const n = Math.floor(w / step);
  const mid = h / 2;
  const head = progress * n;
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    const known = shape ? shape[Math.min(shape.length - 1, Math.floor(x * shape.length))] : -1;
    const base = known >= 0 ? 0.18 + 0.82 * known : 0.14;
    const near = Math.max(0, 1 - Math.abs(i - head) / 7);
    const live = near * mirrored(src, Math.min(1, Math.abs(i - head) / 14)) * 0.9;
    const half = Math.max(1, (base * 0.72 + live * 0.6) * (mid - 5));
    let a = i < head ? 0.9 : 0.26;
    if (hover != null && Math.abs(x - hover) < 1.5 / n) a = 1;
    ctx.fillStyle = `rgba(255,255,255,${a * edge(x) + (1 - edge(x)) * a * 0.35})`;
    ctx.fillRect(i * step * dpr, (mid - half) * dpr, 2 * dpr, half * 2 * dpr);
  }
  const hx = Math.min(w - 1, head * step);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.shadowColor = 'rgba(255,255,255,0.7)';
  ctx.shadowBlur = 8 * dpr;
  ctx.fillRect(hx * dpr, h * 0.18 * dpr, 2 * dpr, h * 0.64 * dpr);
  ctx.shadowBlur = 0;
}

/* ---- Beat steps ---- */
function steps(f) {
  const { ctx, w, h, dpr, src, s, dt, playing } = f;
  const n = 16;
  const span = Math.min(w * 0.86, 520);
  // Spacing shrinks with the space, so all sixteen always fit.
  const gapIn = Math.max(2, Math.min(5, span / 100));
  const gapGroup = gapIn * 3.2;
  const pillW = Math.max(2, (span - gapIn * 12 - gapGroup * 3) / n);
  const total = pillW * n + gapIn * 12 + gapGroup * 3;
  const cur = (src.beats * 4 + Math.floor(src.beatPhase() * 4)) % n;
  s.lit = s.lit || new Float32Array(n);
  const decay = Math.exp(-dt * (playing ? 5 : 0.8));
  let x = (w - total) / 2;
  for (let i = 0; i < n; i++) {
    if (playing && i === cur) s.lit[i] = 1;
    else if (!playing && i === cur) s.lit[i] = Math.max(s.lit[i] * decay, 0.5);
    else s.lit[i] *= decay;
    const weight = i % 4 === 0 ? 1 : i % 8 === 4 ? 0.8 : 0.45;
    const energy = playing ? weight * (0.45 + 0.55 * src.loud) : 0.3;
    const ph = Math.min(h * 0.56, 4 + 15 * energy * (0.35 + 0.65 * s.lit[i]));
    const cx = (x + pillW / 2) / w;
    ctx.fillStyle = `rgba(255,255,255,${(0.16 + 0.8 * s.lit[i]) * (0.4 + 0.6 * edge(cx))})`;
    ctx.beginPath();
    rrect(ctx, x * dpr, ((h - ph) / 2) * dpr, pillW * dpr, ph * dpr, (Math.min(pillW, ph) / 2) * dpr);
    ctx.fill();
    x += pillW + ((i + 1) % 4 === 0 ? gapGroup : gapIn);
  }
}

/* ---- Capsule EQ ----
 * Neon's capsules standing on a floor, bass on the left, each over a faint
 * reflection that fades out below the floor line. */
function capsuleq(f) {
  const { ctx, w, h, dpr, src, palette } = f;
  const span = w * 0.84;
  const gap = 5;
  const n = Math.max(6, Math.min(24, Math.floor(span / 13)));
  const bw = Math.max(3, Math.min(8, (span - gap * (n - 1)) / n));
  const total = bw * n + gap * (n - 1);
  const x0 = (w - total) / 2;
  const floor = h * 0.7;
  const top = h * 0.08;
  const refl = h * 0.24;
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    const L = linear(src, x);
    const bh = Math.max(bw, L * (floor - top));
    const [r, g, b] = mix(palette, x);
    const lift = (c) => Math.round(c + (255 - c) * 0.5);
    const px = (x0 + i * (bw + gap)) * dpr;
    ctx.shadowColor = `rgba(${r},${g},${b},${0.5 + 0.5 * L})`;
    ctx.shadowBlur = Math.min(gap * 0.65, 2 + 2.5 * L) * dpr;
    ctx.fillStyle = `rgba(${lift(r)},${lift(g)},${lift(b)},${0.6 + 0.4 * L})`;
    ctx.beginPath();
    rrect(ctx, px, (floor - bh) * dpr, bw * dpr, bh * dpr, (bw / 2) * dpr);
    ctx.fill();
    ctx.shadowBlur = 0;
    const rh = Math.min(refl, bh * 0.45);
    const g2 = ctx.createLinearGradient(0, (floor + 2) * dpr, 0, (floor + 2 + rh) * dpr);
    g2.addColorStop(0, `rgba(${lift(r)},${lift(g)},${lift(b)},0.22)`);
    g2.addColorStop(1, `rgba(${lift(r)},${lift(g)},${lift(b)},0)`);
    ctx.fillStyle = g2;
    ctx.beginPath();
    rrect(ctx, px, (floor + 2) * dpr, bw * dpr, rh * dpr, (bw / 2) * dpr);
    ctx.fill();
  }
}

/* ---- Neon strings ----
 * Many thin glowing lines mirrored from the centre line; the glow stays
 * narrower than the space between lines. */
function strings(f) {
  const { ctx, w, h, dpr, src, palette } = f;
  const span = w * 0.84;
  const n = Math.max(12, Math.min(64, Math.floor(span / 7)));
  const step = span / (n - 1);
  const x0 = (w - span) / 2;
  const mid = h / 2;
  ctx.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const L = mirrored(src, x);
    const half = Math.max(0.8, L * (mid - 3));
    const [r, g, b] = mix(palette, x);
    const lift = (q) => Math.round(q + (255 - q) * 0.55);
    ctx.strokeStyle = `rgba(${lift(r)},${lift(g)},${lift(b)},${0.55 + 0.45 * L})`;
    ctx.lineWidth = 1.5 * dpr;
    ctx.shadowColor = `rgba(${r},${g},${b},${0.6 + 0.4 * L})`;
    ctx.shadowBlur = Math.min(step * 0.6, 2 + 2 * L) * dpr;
    const px = (x0 + i * step) * dpr;
    ctx.beginPath();
    ctx.moveTo(px, (mid - half) * dpr);
    ctx.lineTo(px, (mid + half) * dpr);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
}

/* ---- Dot matrix ----
 * A grid of round dots, columns bass to treble, lit from the bottom up; the
 * unlit dots stay faintly visible. */
function dots(f) {
  const { ctx, w, h, dpr, src, palette, playing } = f;
  const rows = 6;
  const pitchY = (h * 0.84) / rows;
  const rad = Math.max(1, Math.min(2.2, pitchY * 0.32));
  const pitchX = Math.max(5, rad * 3.2);
  const cols = Math.max(8, Math.floor((w * 0.86) / pitchX));
  const x0 = (w - (cols - 1) * pitchX) / 2;
  const y0 = h * 0.08 + pitchY / 2;
  for (let c = 0; c < cols; c++) {
    const x = c / (cols - 1);
    const lit = Math.max(playing ? 0 : 1, Math.round(linear(src, x) * rows));
    const [r, g, b] = mix(palette, x);
    const lift = (q) => Math.round(q + (255 - q) * 0.45);
    for (let row = 0; row < rows; row++) {
      const on = rows - 1 - row < lit;
      if (on) {
        ctx.fillStyle = `rgb(${lift(r)},${lift(g)},${lift(b)})`;
        ctx.shadowColor = `rgba(${r},${g},${b},0.8)`;
        ctx.shadowBlur = Math.min(pitchX * 0.5, 3) * dpr;
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.shadowBlur = 0;
      }
      ctx.beginPath();
      ctx.arc((x0 + c * pitchX) * dpr, (y0 + row * pitchY) * dpr, rad * dpr, 0, 7);
      ctx.fill();
    }
  }
  ctx.shadowBlur = 0;
}

/* ---- analyser curves (Pro-Q family) ---- */
const AX = (w) => ({ x0: w * 0.07, x1: w * 0.93 });
function gridlines(ctx, x0, x1, top, floor, dpr) {
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  for (const hz of [100, 1000, 10000]) {
    const gx = x0 + (Math.log(hz / 40) / Math.log(16000 / 40)) * (x1 - x0);
    ctx.fillRect(gx * dpr, top * dpr, 1 * dpr, (floor - top) * dpr);
  }
}
/** Traces a smooth curve through valueAt(0–1) across [x0, x1]. */
function tracePath(ctx, dpr, x0, x1, top, floor, valueAt) {
  const pts = [];
  for (let px = x0; px <= x1; px += 3) pts.push([px, floor - valueAt((px - x0) / (x1 - x0)) * (floor - top)]);
  if (pts.length < 3) return false;
  ctx.moveTo(pts[0][0] * dpr, pts[0][1] * dpr);
  for (let i = 1; i < pts.length - 1; i++) {
    const xc = (pts[i][0] + pts[i + 1][0]) / 2;
    const yc = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0] * dpr, pts[i][1] * dpr, xc * dpr, yc * dpr);
  }
  return true;
}
const sampler = (arr) => (x) => {
  const k = arr.length - 1;
  const f = Math.min(1, Math.max(0, x)) * k;
  const i = Math.floor(f);
  const t = f - i;
  return arr[i] * (1 - t) + arr[Math.min(k, i + 1)] * t;
};

/* ---- Peak curve ----
 * The Pro-Q curve and fill, plus a dashed line holding each band's recent
 * peak for half a second before it sinks. */
function peakcurve(f) {
  const { ctx, w, h, dpr, src, palette, s, dt } = f;
  const { x0, x1 } = AX(w);
  const floor = h * 0.9;
  const top = h * 0.08;
  if (x1 - x0 < 8) return;
  const K = 80;
  if (!s.peak) { s.peak = new Float32Array(K); s.hold = new Float32Array(K); }
  for (let k = 0; k < K; k++) {
    const L = linear(src, k / (K - 1));
    if (L >= s.peak[k]) { s.peak[k] = L; s.hold[k] = 0.5; } else if ((s.hold[k] -= dt) <= 0) s.peak[k] = Math.max(0, s.peak[k] - dt * 0.35);
  }
  gridlines(ctx, x0, x1, top, floor, dpr);
  const col = palette[0];
  const now = (x) => linear(src, x);
  ctx.beginPath();
  if (!tracePath(ctx, dpr, x0, x1, top, floor, now)) return;
  ctx.lineTo(x1 * dpr, floor * dpr);
  ctx.lineTo(x0 * dpr, floor * dpr);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, top * dpr, 0, floor * dpr);
  g.addColorStop(0, rgba(col, 0.5));
  g.addColorStop(1, rgba(col, 0.02));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.beginPath();
  tracePath(ctx, dpr, x0, x1, top, floor, sampler(s.peak));
  ctx.strokeStyle = rgba(col, 0.9);
  ctx.lineWidth = 1 * dpr;
  ctx.setLineDash([3 * dpr, 3 * dpr]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  tracePath(ctx, dpr, x0, x1, top, floor, now);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 1.6 * dpr;
  ctx.lineJoin = 'round';
  ctx.shadowColor = rgba(col, 0.9);
  ctx.shadowBlur = 5 * dpr;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

/* ---- Layered curves ----
 * Three curves in three palette colours following the music at three speeds
 * (fast, medium, slow), each filled softly down to the floor. Only the curves
 * get a line, so there is no hard edge at the floor or the ends. */
function layers(f) {
  const { ctx, w, h, dpr, src, palette, s, dt } = f;
  const { x0, x1 } = AX(w);
  const floor = h * 0.9;
  const top = h * 0.1;
  if (x1 - x0 < 8) return;
  const K = 48;
  if (!s.layers) s.layers = [new Float32Array(K), new Float32Array(K), new Float32Array(K)];
  const speeds = [30, 9, 3];
  s.layers.forEach((arr, li) => {
    const k2 = 1 - Math.exp(-dt * speeds[li]);
    for (let k = 0; k < K; k++) arr[k] += (linear(src, k / (K - 1)) * (1 - li * 0.08) - arr[k]) * k2;
  });
  /* Adding light blends three different colours nicely, but three whites
     (cover colours off) only pile up into a solid wash; stack those normally
     and more faintly instead. */
  const distinct = palette[0].join() !== palette[1].join() || palette[1].join() !== palette[2].join();
  const fillK = distinct ? 1 : 0.55;
  ctx.globalCompositeOperation = distinct ? 'lighter' : 'source-over';
  for (let li = 2; li >= 0; li--) {
    const at = sampler(s.layers[li]);
    const col = palette[li % palette.length];
    ctx.beginPath();
    if (!tracePath(ctx, dpr, x0, x1, top, floor, at)) break;
    ctx.lineTo(x1 * dpr, floor * dpr);
    ctx.lineTo(x0 * dpr, floor * dpr);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, top * dpr, 0, floor * dpr);
    g.addColorStop(0, rgba(col, (0.2 + li * 0.06) * fillK));
    g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.beginPath();
    tracePath(ctx, dpr, x0, x1, top, floor, at);
    ctx.strokeStyle = rgba(col, 0.45 + (2 - li) * 0.2);
    ctx.lineWidth = (1 + (2 - li) * 0.3) * dpr;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

const DRAW = { neon, capsuleq, strings, dots, proq, peakcurve, layers, ribbon, steps };

export function drawViz(style, f) {
  const fn = DRAW[style];
  if (!fn) return;
  f.ctx.clearRect(0, 0, f.w * f.dpr, f.h * f.dpr);
  // One bad frame must not stop the loop (and with it the visualizer) for
  // good: skip it, reset the style's state, and carry on.
  try {
    fn(f);
  } catch (err) {
    console.warn('[compact viz]', style, err?.message || err);
    for (const k of Object.keys(f.s)) delete f.s[k];
    f.ctx.restore?.();
    f.ctx.shadowBlur = 0;
    f.ctx.globalAlpha = 1;
    f.ctx.globalCompositeOperation = 'source-over';
    f.ctx.setLineDash?.([]);
  }
}

/** Whether a paused style still has something moving. None of the current
 *  styles keeps moving once paused. */
export function stillMoving() {
  return false;
}

/* ---- the Settings previews ----
 * The real analysis (vizLevels.LevelSource), fed a stand-in song, so every
 * tile shows its style behaving the way it will with music: beats on the
 * kick, the voice in its phrases, resting in the breakdown. */
export function demoSource() {
  return demoLevelSource();
}
