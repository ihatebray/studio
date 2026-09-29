/* =========================================================================
 *  studio — the compact-bar visualizer styles
 *
 *  Eleven ways to fill the empty middle of the library bar in compact mode.
 *  Every style draws into one small canvas from the same frame:
 *
 *    f = { ctx, w, h, dpr,           canvas and its size in CSS px
 *          src,                      LevelSource (vizLevels.js) or the demo
 *          t, dt, playing,           time that only runs while playing
 *          palette,                  [[r,g,b] × 4] from the cover, lifted
 *          cover,                    the cover <img>, when loaded
 *          progress, hover, shape,   for the progress ribbon
 *          s }                       this view's own state (particles…)
 *
 *  Nothing may end at a hard edge: the canvas is masked to fade out on all
 *  four sides (CompactVisualizer.jsx), and each style also keeps its marks
 *  inside the middle of the space and thins them out towards the ends, so
 *  a spark or a ring fades before the mask would have to hide it.
 * ========================================================================= */

import { BANDS } from './vizLevels.js';

export const VIZ_STYLES = [
  { id: 'dither', name: 'Dither bars', note: "Mirrored bars in Studio's dither grain" },
  { id: 'cover', name: 'Cover spectrum', note: "Bars tinted with the cover's colours" },
  { id: 'ribbon', name: 'Progress ribbon', note: 'The song end to end; click to seek' },
  { id: 'line', name: 'Breath line', note: 'One soft line that swells' },
  { id: 'fireflies', name: 'Fireflies', note: 'Sparks rise on every beat' },
  { id: 'steps', name: 'Beat steps', note: 'Sixteen steps, one bar of music' },
  { id: 'window', name: 'Cover window', note: 'The cover, seen through the bars' },
  { id: 'aurora', name: 'Aurora', note: 'Soft ribbons of colour' },
  { id: 'tide', name: 'Tide', note: 'The spectrum as one smooth shape' },
  { id: 'ripple', name: 'Ripple', note: 'A ring on every beat' },
  { id: 'meter', name: 'Hi-fi meter', note: 'LED columns with falling peaks' },
];
export const VIZ_IDS = new Set(VIZ_STYLES.map((s) => s.id));

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
function mix(pal, x) {
  const s = x * (pal.length - 1);
  const i = Math.min(pal.length - 2, Math.floor(s));
  const k = s - i;
  const a = pal[i];
  const b = pal[i + 1] || a;
  return [0, 1, 2].map((j) => Math.round(a[j] + (b[j] - a[j]) * k));
}
const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`;

/* ---- A · Dither bars ---- */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
function dither(f) {
  const { ctx, w, h, dpr, src } = f;
  const P = 2;
  const cols = Math.floor(w / P);
  const rows = Math.floor(h / P);
  const mid = rows / 2;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  for (let c = 0; c < cols; c++) {
    if (c % 3 === 2) continue;
    const x = c / cols;
    const win = edge(x);
    if (win <= 0.01) continue;
    const half = Math.max(0.6, mirrored(src, x) * (mid - 2));
    for (let r = 0; r < rows; r++) {
      const d = Math.abs(r + 0.5 - mid);
      if (d > half) continue;
      const intensity = (1 - 0.8 * Math.pow(d / half, 1.5)) * win * (half < 1 ? 0.55 : 1);
      if (intensity * 16 > BAYER[(r % 4) * 4 + (c % 4)] + 0.5) ctx.fillRect(c * P * dpr, r * P * dpr, P * dpr, P * dpr);
    }
  }
}

/* ---- B · Cover spectrum ---- */
function cover(f) {
  const { ctx, w, h, dpr, src, palette } = f;
  const step = 6;
  const n = Math.floor(w / step);
  const mid = h / 2;
  ctx.lineCap = 'round';
  ctx.lineWidth = 3 * dpr;
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    const win = edge(x);
    if (win <= 0.01) continue;
    const L = mirrored(src, x);
    const half = Math.max(0.01, L * (mid - 5));
    ctx.strokeStyle = rgba(mix(palette, x), (0.4 + 0.6 * Math.min(1, L * 1.4)) * win);
    const px = (i + 0.5) * step * dpr;
    ctx.beginPath();
    ctx.moveTo(px, (mid - half) * dpr);
    ctx.lineTo(px, (mid + half) * dpr);
    ctx.stroke();
  }
}

/* ---- C · Progress ribbon ---- */
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

/* ---- D · Breath line ---- */
function line(f) {
  const { ctx, w, h, dpr, src, t, palette } = f;
  const mid = h / 2;
  const light = palette[0];
  const amp = (mid - 7) * Math.min(1, src.loud * 1.35);
  const path = () => {
    ctx.beginPath();
    for (let px = 0; px <= w; px += 2) {
      const x = px / w;
      const wave = 0.6 * Math.sin(x * 13 + t * 3.1) + 0.3 * Math.sin(x * 29 - t * 4.7) + 0.15 * Math.sin(x * 57 + t * 7.9);
      const y = mid + amp * edge(x) * wave * (0.4 + mirrored(src, x));
      if (px === 0) ctx.moveTo(px * dpr, y * dpr); else ctx.lineTo(px * dpr, y * dpr);
    }
  };
  ctx.lineJoin = 'round';
  path();
  ctx.strokeStyle = rgba(light, 0.28);
  ctx.lineWidth = 5 * dpr;
  ctx.shadowColor = rgba(light, 0.8);
  ctx.shadowBlur = 10 * dpr;
  ctx.stroke();
  ctx.shadowBlur = 0;
  path();
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.lineWidth = 1.5 * dpr;
  ctx.stroke();
}

/* ---- E · Fireflies ----
 * Sparks start low in the space and die before the upper fade, so none is
 * ever cut by the edge; they also thin out as they climb. */
function fireflies(f) {
  const { ctx, w, h, dpr, src, s, dt, playing, palette } = f;
  s.flies = s.flies || [];
  if (playing && src.beats !== s.beat) {
    s.beat = src.beats;
    const count = 2 + Math.round(src.loud * 6);
    for (let i = 0; i < count && s.flies.length < 60; i++) {
      const spread = (Math.random() - 0.5) * Math.random() * 1.5;
      s.flies.push({
        x: Math.min(0.9, Math.max(0.1, 0.5 + spread)),
        y: h * (0.6 + Math.random() * 0.18),
        vy: 3.5 + Math.random() * 8,
        ph: Math.random() * 6.28,
        life: 0,
        max: 1.3 + Math.random() * 1.5,
        r: 1.1 + Math.random() * 1.4,
        c: palette[Math.floor(Math.random() * palette.length)],
      });
    }
  }
  const top = h * 0.22;
  s.flies = s.flies.filter((fl) => fl.life < fl.max && fl.y > top);
  for (const fl of s.flies) {
    const speed = playing ? 1 : 0.3;
    fl.life += dt * speed;
    fl.y -= fl.vy * dt * speed;
    const px = fl.x * w + Math.sin(fl.life * 2.4 + fl.ph) * 6;
    const rise = Math.min(1, Math.max(0, (fl.y - top) / (h * 0.4)));
    const fade = Math.sin(Math.PI * Math.min(1, fl.life / fl.max)) * edge(fl.x) * rise;
    if (fade <= 0.01) continue;
    const rad = fl.r * 4 * dpr;
    const g = ctx.createRadialGradient(px * dpr, fl.y * dpr, 0, px * dpr, fl.y * dpr, rad);
    g.addColorStop(0, rgba(fl.c, 0.9 * fade));
    g.addColorStop(0.35, rgba(fl.c, 0.35 * fade));
    g.addColorStop(1, rgba(fl.c, 0));
    ctx.fillStyle = g;
    ctx.fillRect(px * dpr - rad, fl.y * dpr - rad, rad * 2, rad * 2);
  }
  if (!playing && !s.flies.length) {
    [0.34, 0.46, 0.58, 0.68].forEach((x, i) => {
      ctx.fillStyle = rgba(palette[i % palette.length], 0.32);
      ctx.beginPath();
      ctx.arc(x * w * dpr, (h / 2 + (i % 2 ? 3 : -2)) * dpr, 1.3 * dpr, 0, 7);
      ctx.fill();
    });
  }
}

/* ---- F · Beat steps ---- */
function steps(f) {
  const { ctx, w, h, dpr, src, s, dt, playing } = f;
  const n = 16;
  const gapIn = 5;
  const gapGroup = 16;
  const span = Math.min(w * 0.86, 520);
  const pillW = Math.max(5, (span - gapIn * 12 - gapGroup * 3) / n);
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
    ctx.roundRect(x * dpr, ((h - ph) / 2) * dpr, pillW * dpr, ph * dpr, (Math.min(pillW, ph) / 2) * dpr);
    ctx.fill();
    x += pillW + ((i + 1) % 4 === 0 ? gapGroup : gapIn);
  }
}

/* ---- G · Cover window ---- */
function artFrom(palette, s) {
  const key = palette.map((c) => c.join()).join('|');
  if (s.artKey === key) return s.art;
  const c = document.createElement('canvas');
  c.width = 480;
  c.height = 120;
  const g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, 480, 120);
  palette.forEach((col, i) => bg.addColorStop(i / Math.max(1, palette.length - 1), rgba(col, 1)));
  g.fillStyle = bg;
  g.fillRect(0, 0, 480, 120);
  s.art = c;
  s.artKey = key;
  return c;
}
function coverWindow(f) {
  const { ctx, w, h, dpr, src, t, palette, cover: img, s } = f;
  const art = img && img.complete && img.naturalWidth ? img : artFrom(palette, s);
  const aw = art.naturalWidth || art.width;
  const ah = art.naturalHeight || art.height;
  // A band across the middle of the cover, panning slowly side to side.
  const bandH = ah * 0.3;
  const bandW = Math.min(aw, bandH * (w / h));
  const pan = (Math.sin(t * 0.05) * 0.5 + 0.5) * (aw - bandW);
  const srcRect = [pan, (ah - bandH) / 2, bandW, bandH];
  ctx.globalAlpha = 0.12;
  ctx.drawImage(art, ...srcRect, 0, 0, w * dpr, h * dpr);
  ctx.globalAlpha = 1;
  ctx.save();
  ctx.beginPath();
  const step = 7;
  const n = Math.floor(w / step);
  const mid = h / 2;
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    const win = edge(x);
    if (win <= 0.02) continue;
    const half = Math.max(1, mirrored(src, x) * (mid - 5) * win);
    ctx.roundRect(i * step * dpr, (mid - half) * dpr, 4 * dpr, half * 2 * dpr, 2 * dpr);
  }
  ctx.clip();
  ctx.drawImage(art, ...srcRect, 0, 0, w * dpr, h * dpr);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(0, 0, w * dpr, h * dpr);
  ctx.restore();
}

/* ---- H · Aurora ---- */
function aurora(f) {
  const { ctx, w, h, dpr, src, t, playing, palette } = f;
  const mid = h / 2;
  ctx.globalCompositeOperation = 'lighter';
  for (let k = 0; k < 3; k++) {
    const col = palette[k % palette.length];
    const amp = (mid - 9) * (0.25 + 0.75 * (playing ? src.bass : 0.1)) * (1 - k * 0.2);
    const thick = Math.min(mid * 0.55, (5 + 9 * src.loud) * (1 - k * 0.2));
    for (let px = 0; px <= w; px += 3) {
      const x = px / w;
      const y = mid + amp * Math.sin(x * (5 + k * 2.3) + t * (0.8 + k * 0.35) + k * 2) * 0.6 + Math.sin(x * 40 + t * 9 + k) * src.highs * 2.2;
      const a = (0.1 + 0.28 * (playing ? src.loud : 0.1)) * edge(x) * (1 - k * 0.2);
      const g = ctx.createLinearGradient(0, (y - thick) * dpr, 0, (y + thick) * dpr);
      g.addColorStop(0, rgba(col, 0));
      g.addColorStop(0.5, rgba(col, a));
      g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g;
      ctx.fillRect(px * dpr, (y - thick) * dpr, 3 * dpr, thick * 2 * dpr);
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

/* ---- I · Tide ---- */
function tide(f) {
  const { ctx, w, h, dpr, src, palette } = f;
  const mid = h / 2;
  const pts = [];
  for (let px = 0; px <= w; px += 4) {
    const x = px / w;
    pts.push([px, Math.max(0.8, mirrored(src, x) * (mid - 5) * edge(x))]);
  }
  ctx.beginPath();
  ctx.moveTo(pts[0][0] * dpr, (mid - pts[0][1]) * dpr);
  for (let i = 1; i < pts.length - 1; i++) {
    const xc = (pts[i][0] + pts[i + 1][0]) / 2;
    const yc = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0] * dpr, (mid - pts[i][1]) * dpr, xc * dpr, (mid - yc) * dpr);
  }
  for (let i = pts.length - 1; i > 0; i--) {
    const xc = (pts[i][0] + pts[i - 1][0]) / 2;
    const yc = (pts[i][1] + pts[i - 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0] * dpr, (mid + pts[i][1]) * dpr, xc * dpr, (mid + yc) * dpr);
  }
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h * dpr);
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.5, rgba(palette[0], 0.55));
  g.addColorStop(1, 'rgba(255,255,255,0.85)');
  ctx.fillStyle = g;
  ctx.fill();
}

/* ---- J · Ripple ----
 * Rings widen and fade to nothing well before the ends of the space. */
function ripple(f) {
  const { ctx, w, h, dpr, src, s, dt, playing, palette } = f;
  const mid = h / 2;
  const cx = w / 2;
  const col = palette[0];
  s.rings = s.rings || [];
  if (playing && src.beats !== s.beat) {
    s.beat = src.beats;
    if (s.rings.length < 8) s.rings.push({ age: 0, strength: 0.5 + 0.5 * src.loud });
  }
  const life = 1.6;
  const maxR = w * 0.36;
  s.rings = s.rings.filter((r) => (r.age += dt) < life);
  for (const r of s.rings) {
    const k = r.age / life;
    const rad = 6 + k * maxR;
    const a = (1 - k) ** 2 * 0.55 * r.strength;
    ctx.strokeStyle = rgba(col, a);
    ctx.lineWidth = (2.2 - 1.4 * k) * dpr;
    ctx.beginPath();
    ctx.ellipse(cx * dpr, mid * dpr, rad * dpr, Math.min(rad, mid - 6) * 0.62 * dpr, 0, 0, 7);
    ctx.stroke();
  }
  const core = 3 + 6 * (playing ? src.bass : 0);
  const g = ctx.createRadialGradient(cx * dpr, mid * dpr, 0, cx * dpr, mid * dpr, core * 2.6 * dpr);
  g.addColorStop(0, `rgba(255,255,255,${playing ? 0.95 : 0.45})`);
  g.addColorStop(0.35, rgba(col, playing ? 0.55 : 0.2));
  g.addColorStop(1, rgba(col, 0));
  ctx.fillStyle = g;
  ctx.fillRect((cx - core * 2.6) * dpr, (mid - core * 2.6) * dpr, core * 5.2 * dpr, core * 5.2 * dpr);
}

/* ---- K · Hi-fi meter ---- */
function meter(f) {
  const { ctx, w, h, dpr, src, s, dt, playing } = f;
  const colW = 5;
  const gap = 3;
  const n = Math.floor(w / (colW + gap));
  const segH = 2;
  const segGap = 1.5;
  const top = h * 0.2;
  const bottom = h * 0.8;
  const rows = Math.floor((bottom - top) / (segH + segGap));
  if (!s.peaks || s.peaks.length !== n) { s.peaks = new Float32Array(n); s.hold = new Float32Array(n); }
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    const win = edge(x);
    const L = Math.min(1, mirrored(src, x) * 1.05);
    if (L >= s.peaks[i]) { s.peaks[i] = L; s.hold[i] = 0.35; } else if ((s.hold[i] -= dt) <= 0) s.peaks[i] = Math.max(0, s.peaks[i] - dt * 0.9);
    const lit = Math.max(playing ? 0 : 1, Math.round(L * rows));
    const px = i * (colW + gap);
    for (let r = 0; r < lit; r++) {
      const y = bottom - (r + 1) * (segH + segGap);
      ctx.fillStyle = `rgba(255,255,255,${(0.45 + 0.5 * (r / rows)) * win})`;
      ctx.fillRect(px * dpr, y * dpr, colW * dpr, segH * dpr);
    }
    const pr = Math.round(s.peaks[i] * rows);
    if (pr > lit) {
      ctx.fillStyle = `rgba(255,255,255,${0.9 * win})`;
      ctx.fillRect(px * dpr, (bottom - pr * (segH + segGap)) * dpr, colW * dpr, segH * dpr);
    }
  }
}

const DRAW = { dither, cover, ribbon, line, fireflies, steps, window: coverWindow, aurora, tide, ripple, meter };

export function drawViz(style, f) {
  const fn = DRAW[style];
  if (!fn) return;
  f.ctx.clearRect(0, 0, f.w * f.dpr, f.h * f.dpr);
  fn(f);
}

/** Whether a paused style still has something moving (sparks, rings). */
export function stillMoving(style, s) {
  if (style === 'fireflies') return (s.flies || []).length > 0;
  if (style === 'ripple') return (s.rings || []).length > 0;
  return false;
}

/* ---- a stand-in signal for the Settings previews ----
 * A groove at 104 BPM, so each tile shows its style moving without a song. */
export function demoSource() {
  const levels = new Float32Array(BANDS);
  const d = { levels, loud: 0, bass: 0, highs: 0, beats: 0, _t: 0, _beatAt: 0 };
  d.update = (dt) => {
    d._t += dt;
    const t = d._t;
    const beat = (t * 104) / 60;
    const ph = beat % 1;
    const barPos = Math.floor(beat) % 4;
    if (Math.floor(beat) !== d.beats) { d.beats = Math.floor(beat); d._beatAt = performance.now() / 1000; }
    const kick = Math.exp(-ph * 6);
    const snare = barPos % 2 === 1 ? Math.exp(-ph * 8) : 0;
    const hat = Math.exp(-((beat * 2) % 1) * 14);
    let loud = 0;
    for (let i = 0; i < BANDS; i++) {
      const x = i / (BANDS - 1);
      const tone = 0.35 + 0.25 * Math.sin(t * 2.1 + i * 0.9) + 0.15 * Math.sin(t * 5.3 + i * 2.3);
      const v = Math.exp(-x * 6) * (0.3 + 0.7 * kick) + Math.exp(-((x - 0.42) ** 2) / 0.035) * (0.2 + 0.45 * snare + 0.35 * tone)
        + Math.exp(-((x - 0.86) ** 2) / 0.02) * (0.12 + 0.5 * hat) * 0.85 + 0.1 * tone;
      const target = Math.min(1, Math.pow(Math.max(0, v * 0.85), 0.7) * 1.1);
      levels[i] += (target - levels[i]) * (target > levels[i] ? 0.5 : 0.12);
      loud += levels[i] * (1 - (i / BANDS) * 0.5);
    }
    d.loud = Math.min(1, loud / (BANDS * 0.62));
    d.bass = (levels[0] + levels[1] + levels[2] + levels[3]) / 4;
    d.highs = (levels[BANDS - 4] + levels[BANDS - 3] + levels[BANDS - 2] + levels[BANDS - 1]) / 4;
  };
  d.beatPhase = () => ((d._t * 104) / 60) % 1;
  return d;
}
