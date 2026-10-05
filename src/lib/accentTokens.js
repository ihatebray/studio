/* =========================================================================
 *  accentTokens — the one place the accent comes from.
 *
 *  Brief: "The accent follows the music. There is no fixed brand colour."
 *  --accent is derived from the artwork of the currently playing track and is
 *  used by every interactive element that needs colour. This module:
 *
 *    - picks the source colour from the SAME sampler the page tints use
 *      (sampleCoverTheme → barSource / swatches), so tint and accent agree
 *    - clamps it: lightness raised until it clears 4.5:1 on #0A0A0B, saturation
 *      capped so a neon sleeve doesn't make the UI vibrate
 *    - produces two variants — `fill` for filled controls and `line` for text,
 *      icons, rings and thin bars (lighter, it has less area to carry colour)
 *    - computes the label colour (`ink`) for anything filled with the accent
 *    - honours Colour intensity (Off = neutral grey, Full = full strength)
 *    - holds the last accent while idle and falls back to a neutral on a cold
 *      start, so the UI is never colourless on first launch
 *    - cross-fades the CSS variables over ~400ms on track change
 *
 *  Fixed roles never follow artwork: success, danger, and the surface scale.
 * ========================================================================= */

export const SURFACE = {
  ground: '#000000',
  surface: '#0A0A0B',
  raised: '#0E0E11',
  borderCard: 'rgba(255, 255, 255, 0.10)',
  borderControl: 'rgba(255, 255, 255, 0.14)',
  /* Text and edges are WHITE AT ALPHA, not fixed greys. studio paints its
     surfaces from cover art, and a flat #A1A1AA over a magenta or brown wash
     reads as dirty grey while white at 62% stays the same relationship to
     whatever is behind it. Same reason --border is an alpha: #191919 on a
     tinted page is a black line, not a hairline. */
  text: 'rgba(255, 255, 255, 0.96)',
  textDim: 'rgba(255, 255, 255, 0.62)',
  textFaint: 'rgba(255, 255, 255, 0.42)',
  success: '#7BE0B0',
  danger: '#FF8B8B',
};

/* Cold start with no history. The brief asks for a neutral fallback but also
   "never render a colourless UI at first launch" — a soft coral satisfies
   both: it's the colour the mockups were drawn in, and onboarding (which runs
   before anything has played) still has a visible primary action. */
export const NEUTRAL_ACCENT = '255, 122, 89';
const SURFACE_RGB = [10, 10, 11];
const LAST_KEY = 'studio:lastAccent';

/* ---- colour maths ------------------------------------------------------ */

function parse(rgb) {
  const p = String(rgb || '').split(',').map((s) => parseInt(s.trim(), 10));
  return p.length >= 3 && p.every((n) => Number.isFinite(n)) ? p.slice(0, 3) : null;
}
const str = (p) => p.map((n) => Math.max(0, Math.min(255, Math.round(n)))).join(', ');

function relLum([r, g, b]) {
  const f = (v) => { const u = v / 255; return u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrast(a, b) {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb([h, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const t = (x) => {
    let v = x; if (v < 0) v += 1; if (v > 1) v -= 1;
    if (v < 1 / 6) return p + (q - p) * 6 * v;
    if (v < 1 / 2) return q;
    if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6;
    return p;
  };
  return [t(h + 1 / 3) * 255, t(h) * 255, t(h - 1 / 3) * 255];
}

/* Saturation ceiling per Colour intensity. 'off' drains hue entirely. */
const SAT_CAP = { off: 0, muted: 0.42, balanced: 0.72, vivid: 0.86, full: 1 };

/** Raise lightness (hue fixed) until `target` contrast vs the base surface. */
function liftTo(hsl, target) {
  let [h, s, l] = hsl;
  let rgb = hslToRgb([h, s, l]);
  let guard = 0;
  while (contrast(rgb, SURFACE_RGB) < target && l < 0.97 && guard < 60) {
    l = Math.min(0.97, l + 0.012);
    rgb = hslToRgb([h, s, l]);
    guard += 1;
  }
  return rgb;
}

/** Near-black or near-white, whichever reads better on the fill. */
export function inkFor(rgb) {
  const p = parse(rgb) || [128, 128, 128];
  const dark = [11, 11, 12]; const light = [250, 250, 250];
  return contrast(p, dark) >= contrast(p, light) ? '#0B0B0C' : '#FAFAFA';
}

/**
 * The derived accent for one source colour.
 * @returns {{ fill: string, line: string, ink: string, ring: string }} "r, g, b" triples + ink hex
 */
export function deriveAccent(sourceRgb, intensity = 'balanced') {
  const src = parse(sourceRgb) || parse(NEUTRAL_ACCENT);
  let [h, s, l] = rgbToHsl(src);
  s = Math.min(s, SAT_CAP[intensity] ?? SAT_CAP.balanced);
  /* A very desaturated source is an achromatic cover — don't invent a hue. */
  if (intensity === 'off') s = 0;
  /* Don't let the lift wash everything to pastel: start no lower than 0.46. */
  l = Math.max(l, 0.46);
  const fill = liftTo([h, s, l], 4.5);
  const [, , lf] = rgbToHsl(fill);
  const line = liftTo([h, Math.min(s, 0.9), Math.max(lf, lf + 0.08)], 6.5);
  const fillS = str(fill);
  const lineS = str(line);
  return {
    fill: fillS,
    line: lineS,
    ink: inkFor(fillS),
    /* Focus ring: the line variant clears 6.5:1 on the base surface, so it's
       used there. Tinted pages override --focus-ring to white. */
    ring: lineS,
  };
}

/**
 * Pick the "dominant reasonably-saturated swatch" out of a sampled cover theme
 * (the object sampleCoverTheme resolves to). Falls back to the perceptual
 * engine's barSource, then the old readings.
 */
export function accentSourceFromTheme(theme, override = null) {
  if (override) return override;
  if (!theme) return null;
  const sat = (rgb) => { const p = parse(rgb); return p ? rgbToHsl(p)[1] : 0; };
  const lum = (rgb) => { const p = parse(rgb); return p ? rgbToHsl(p)[2] : 0; };
  const ok = (rgb) => rgb && sat(rgb) >= 0.22 && lum(rgb) > 0.08 && lum(rgb) < 0.94;
  if (ok(theme.barSource)) return theme.barSource;
  const sw = [...(theme.swatches || [])].sort((a, b) => (b.share || 0) - (a.share || 0));
  for (const s of sw) if (ok(s.exact || s.rgb)) return s.exact || s.rgb;
  for (const c of (theme.palette || [])) if (ok(c)) return c;
  return theme.barSource || theme.dominant || theme.mid || null;
}

/* ---- idle / cold start --------------------------------------------------- */
export function lastAccentSource() {
  try { return localStorage.getItem(LAST_KEY) || null; } catch { return null; }
}
export function rememberAccentSource(rgb) {
  try { if (rgb) localStorage.setItem(LAST_KEY, rgb); } catch { /* ignore */ }
}

/* ---- cross-fade ------------------------------------------------------------
 * CSS can't transition "r, g, b" triples, and most of the app reads them as
 * rgba(var(--st-acc-rgb), a). So the variables are tweened here, once per
 * frame, for ~400ms. Nothing re-renders — only :root custom properties move.
 */
let current = null;   // { fill:[r,g,b], line:[r,g,b] }
let raf = 0;

function writeVars(root, fill, line) {
  const f = str(fill); const l = str(line);
  root.setProperty('--accent-rgb', f);
  root.setProperty('--accent-line-rgb', l);
  root.setProperty('--accent', `rgb(${f})`);
  root.setProperty('--accent-line', `rgb(${l})`);
  root.setProperty('--accent-ink', inkFor(f));
  /* Legacy names the existing stylesheet already reads. */
  root.setProperty('--st-acc-rgb', l);
  root.setProperty('--st-acc-ink', inkFor(f));
}

export function applyAccent(acc, { animate = true, ms = 400 } = {}) {
  if (typeof document === 'undefined' || !acc) return;
  const root = document.documentElement.style;
  const to = { fill: parse(acc.fill), line: parse(acc.line) };
  root.setProperty('--focus-ring', `rgb(${acc.ring})`);
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!current || !animate || reduce) {
    cancelAnimationFrame(raf);
    current = to;
    writeVars(root, to.fill, to.line);
    return;
  }
  const from = { fill: [...current.fill], line: [...current.line] };
  const t0 = performance.now();
  cancelAnimationFrame(raf);
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    const e = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2;
    const mix = (a, b) => a.map((v, i) => v + (b[i] - v) * e);
    current = { fill: mix(from.fill, to.fill), line: mix(from.line, to.line) };
    writeVars(root, current.fill, current.line);
    if (k < 1) raf = requestAnimationFrame(step);
    else current = to;
  };
  raf = requestAnimationFrame(step);
}

/* ---- primitives stylesheet --------------------------------------------------
 * Tokens + the rules every screen shares: radius scale, focus ring, list-row
 * selection, tabular numerals, buttons. Mounted once by StudioHome.
 */
export const TOKENS_CSS = `
:root {
  --ground: ${SURFACE.ground};
  --surface: ${SURFACE.surface};
  --surface-raised: ${SURFACE.raised};
  --border: ${SURFACE.borderCard};
  --border-control: ${SURFACE.borderControl};
  --text: ${SURFACE.text};
  --text-dim: ${SURFACE.textDim};
  --text-faint: ${SURFACE.textFaint};
  --success: ${SURFACE.success};
  --danger: ${SURFACE.danger};
  --r-ctl-s: 8px;   /* controls up to 30px */
  --r-ctl-m: 10px;  /* 32-42px */
  --r-ctl-l: 12px;  /* above 42px */
  --r-card: 16px;
  --r-panel: 14px;
  --r-art: 8px;
  --r-art-s: 6px;
  --accent: rgb(${NEUTRAL_ACCENT});
  --accent-line: rgb(${NEUTRAL_ACCENT});
  --accent-rgb: ${NEUTRAL_ACCENT};
  --accent-line-rgb: ${NEUTRAL_ACCENT};
  --accent-ink: #0B0B0C;
  --focus-ring: #ffffff;
}

/* Focus. No screenshot of the old app showed one anywhere. */
:where(button, a, input, select, textarea, [role="button"], [role="option"], [role="tab"], [tabindex]):focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
/* Tinted pages can't guarantee the accent reads against them. */

/* Rows never select text — double-click to play used to highlight the word. */
.st-num { font-variant-numeric: tabular-nums; }

/* ---- Buttons ------------------------------------------------------------- */
.st-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  height: 34px; padding: 0 14px; border-radius: var(--r-ctl-m); font: inherit; font-size: 13px; font-weight: 700;
  cursor: pointer; white-space: nowrap; border: 1px solid transparent; transition: background 140ms ease, border-color 140ms ease, color 140ms ease, filter 140ms ease; }
.st-btn svg { flex-shrink: 0; }
.st-btn-sm { height: 30px; padding: 0 12px; border-radius: var(--r-ctl-s); font-size: 12.5px; }
.st-btn-primary { background: var(--accent); color: var(--accent-ink); }
.st-btn-primary:hover { filter: brightness(1.08); }
.st-btn-primary:disabled { background: rgba(255,255,255,0.08); color: var(--text-faint); cursor: default; filter: none; }
.st-btn-outline { background: transparent; color: var(--text); border-color: var(--border-control); }
.st-btn-outline:hover { background: rgba(255,255,255,0.05); border-color: #2c2c33; }
.st-btn-ghost { background: transparent; color: var(--text-dim); }
.st-btn-ghost:hover { background: rgba(255,255,255,0.06); color: var(--text); }
.st-btn-danger { background: rgba(255,139,139,0.08); color: var(--danger); border-color: rgba(255,139,139,0.3); }
.st-btn-danger:hover { background: rgba(255,139,139,0.14); }
.st-icon-btn { width: 34px; height: 34px; padding: 0; border-radius: var(--r-ctl-m); display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: none; color: var(--text-dim); cursor: pointer; transition: background 140ms ease, color 140ms ease; }
.st-icon-btn:hover { background: rgba(255,255,255,0.07); color: var(--text); }
.st-icon-btn.is-sm { width: 28px; height: 28px; border-radius: var(--r-ctl-s); }
.st-icon-btn.is-on { color: var(--accent-line); }
.st-icon-btn:disabled { opacity: 0.35; cursor: default; }

/* ---- Type ---------------------------------------------------------------- */
.st-eyebrow { font-size: 10.5px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: var(--text-faint); }
.st-page-title { font-size: 32px; font-weight: 800; letter-spacing: -0.02em; color: var(--text); line-height: 1.1; }
.st-section-title { font-size: 20px; font-weight: 800; letter-spacing: -0.01em; color: var(--text); }
.st-meta { font-size: 13px; color: var(--text-faint); }

/* ---- Badges / pills ------------------------------------------------------ */
.st-badge-new { display: inline-flex; align-items: center; height: 16px; padding: 0 5px; border-radius: 4px;
  font-size: 9.5px; font-weight: 800; letter-spacing: 0.06em; background: rgba(var(--accent-rgb), 0.18); color: var(--accent-line); }
.st-status { display: inline-flex; align-items: center; flex-shrink: 0; white-space: nowrap; height: 24px; padding: 0 10px; border-radius: var(--r-ctl-s); font-size: 11.5px; font-weight: 700; }
.st-status.ok { background: rgba(123,224,176,0.12); color: var(--success); }
.st-status.off { background: rgba(var(--accent-rgb), 0.14); color: var(--accent-line); }

/* ---- Toggle (keeps its capsule — the one exception) ----------------------- */
.st-toggle { position: relative; width: 42px; height: 24px; border-radius: 999px; border: none; padding: 0; cursor: pointer;
  background: rgba(255,255,255,0.12); transition: background 200ms ease; flex-shrink: 0; }
.st-toggle::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%;
  background: #8a8a92; transition: transform 200ms cubic-bezier(0.3,0.9,0.3,1), background 200ms ease; }
.st-toggle.on { background: var(--accent); }
/* The knob takes the ink colour, so a white accent doesn't put a white
   circle on a white track — which is exactly how this broke before. */
.st-toggle.on::after { transform: translateX(18px); background: var(--accent-ink); }

/* ---- Segmented control ---------------------------------------------------- */
.st-segs { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 2px; padding: 3px; width: 100%; box-sizing: border-box;
  border-radius: var(--r-ctl-m); background: rgba(255,255,255,0.03); border: 1px solid var(--border-control); }
.st-segs button { height: 30px; border: none; border-radius: var(--r-ctl-s); background: transparent; color: var(--text-dim);
  font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; white-space: nowrap; padding: 0 6px; transition: background 140ms ease, color 140ms ease; }
.st-segs button:hover { color: var(--text); }
.st-segs button.on { background: rgba(255,255,255,0.12); color: var(--text); font-weight: 700; }

/* ---- Progress ------------------------------------------------------------- */

/* ---- Inputs --------------------------------------------------------------- */
.st-input { box-sizing: border-box; width: 100%; height: 40px; padding: 0 14px; border-radius: var(--r-ctl-m); background: rgba(255,255,255,0.02);
  border: 1px solid var(--border-control); color: var(--text); font: inherit; font-size: 13.5px; outline: none; transition: border-color 140ms ease, background 140ms ease; }
.st-input:focus { border-color: rgba(var(--accent-rgb), 0.6); background: rgba(255,255,255,0.03); }
.st-input::placeholder { color: var(--text-faint); }
.st-fields { display: flex; flex-direction: column; gap: 12px; }
.st-field { display: flex; flex-direction: column; gap: 6px; }
.st-field-lbl { font-size: 10.5px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: var(--text-faint); }
.st-btn-block { width: 100%; height: 44px; border-radius: var(--r-ctl-l); font-size: 14px; }

@keyframes stSpin { to { transform: rotate(360deg); } }
.st-spin { animation: stSpin 0.9s linear infinite; }
@media (prefers-reduced-motion: reduce) { .st-spin { animation-duration: 2.4s; } }
`;
