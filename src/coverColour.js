/* =============================================================================
 *  coverColour.js — choosing a bar colour from a piece of cover art.
 *
 *  WHAT THIS REPLACES, AND WHY
 *
 *  The previous engine clustered in RGB, scored candidates against six
 *  hand-tuned HSL targets, and finished every colour at a fixed lightness of
 *  0.24 with saturation capped at 0.60. Three separate problems came out of
 *  that:
 *
 *    1. RGB distance is not perceptual. A gap of 20 units among blues looks
 *       nothing like a gap of 20 among yellows, so clusters split and merged
 *       in places the eye doesn't agree with, and "the dominant colour" often
 *       wasn't the colour anyone would name.
 *
 *    2. A fixed output lightness throws away information. Every cover — a
 *       black metal sleeve, a pastel pop record — arrived at the same 0.24.
 *       The bar told you the hue and nothing else, and two very different
 *       records produced two bars that felt identical.
 *
 *    3. That 0.24 was chosen to guarantee white text stayed readable, but it
 *       guarantees far more contrast than readability needs. Measured with
 *       APCA, a 0.24-lightness bar sits near Lc 100 while body text needs
 *       Lc 75. Every cover was being darkened past the point of any benefit.
 *
 *  THE APPROACH HERE
 *
 *  Cluster in OKLab, score with Material's hue-excitation idea, then darken
 *  only as far as the contrast requirement actually demands.
 *
 *    - OKLab (Ottosson 2020) is the current consensus perceptual space for
 *      image work: equal numeric distances correspond to roughly equal
 *      perceived differences. Clusters land where a person would draw them.
 *
 *    - Scoring follows Google's Material Color Utilities `Score`, which is
 *      the most carefully validated public work on this exact question —
 *      picking a UI theme colour from an image. Its key insight is the
 *      "hue-excited proportion": a hue's weight is the population of its
 *      whole ±15 degree neighbourhood, not just its own bin. A cover with
 *      many近 shades of one colour therefore beats a single bright speck,
 *      which is what naive dominant-colour extraction gets wrong.
 *
 *    - Contrast uses APCA rather than WCAG 2. WCAG 2's ratio is not
 *      polarity-aware and overstates contrast badly at the dark end — its own
 *      successor working group states it "cannot be used for guidance
 *      designing dark mode". APCA is perceptually uniform and knows that
 *      light-text-on-dark is a different problem from dark-on-light, which is
 *      precisely the case here: white text, coloured bar.
 *
 *    - Dark yellow-greens get special handling. Colour preference research
 *      (Palmer & Schloss 2010) finds a consistent cross-cultural aversion to
 *      that band, correlated with the appearance of spoiled food; Material
 *      encodes it as hue 90-111 at low tone. Material's fix is to lighten,
 *      which isn't available to us on a dark bar, so this drains chroma
 *      instead — an olive sludge becomes a warm neutral brown.
 *
 *  Deterministic throughout: same image in, same colour out, every run.
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 *  OKLab.
 *  Ottosson's published matrices, unmodified.
 * ------------------------------------------------------------------------- */

const srgbToLinear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

const linearToSrgb = (v) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * (v ** (1 / 2.4)) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

export function rgbToOklab(r, g, b) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function oklabToRgb(L, a, bb) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * bb) ** 3;

  return [
    linearToSrgb(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
}

/** Is an OKLCh triple representable in sRGB without clipping? */
function inGamut(L, C, h) {
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const lin = (x) => x ** 3;
  const l = lin(L + 0.3963377774 * a + 0.2158037573 * b);
  const m = lin(L - 0.1055613458 * a - 0.0638541728 * b);
  const s = lin(L - 0.0894841775 * a - 1.2914855480 * b);
  const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  const e = 0.0001;
  return r >= -e && r <= 1 + e && g >= -e && g <= 1 + e && bl >= -e && bl <= 1 + e;
}

/**
 * Convert OKLCh to sRGB, reducing chroma until the colour fits.
 *
 * Naive clipping — computing the channels and clamping each to 0..255 —
 * shifts hue, sometimes badly: an out-of-gamut vivid blue clips its red
 * channel and arrives purple. Binary-searching chroma instead keeps hue and
 * lightness exactly and gives up only the saturation that genuinely isn't
 * representable, which is the standard CSS Color 4 gamut-mapping approach.
 */
export function oklchToRgb(L, C, h) {
  if (inGamut(L, C, h)) return oklabToRgb(L, C * Math.cos(h), C * Math.sin(h));
  let lo = 0;
  let hi = C;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (inGamut(L, mid, h)) lo = mid; else hi = mid;
  }
  return oklabToRgb(L, lo * Math.cos(h), lo * Math.sin(h));
}

export function oklabToLch([L, a, b]) {
  return [L, Math.hypot(a, b), Math.atan2(b, a)];
}

const degrees = (rad) => ((rad * 180) / Math.PI + 360) % 360;

/* ---------------------------------------------------------------------------
 *  APCA (Accessible Perceptual Contrast Algorithm), W3 revision 0.1.9.
 *
 *  Implemented here rather than pulled in as a dependency: it's forty lines,
 *  it has to run in the renderer with no build step, and the constants are
 *  published and stable. Validated against the reference `apca-w3` package —
 *  see the test harness.
 *
 *  Returns a NEGATIVE Lc for light text on a dark background, which is the
 *  polarity this file always deals in. Magnitude is what matters:
 *  Lc 75 is the published minimum for body text, Lc 90 the preferred value.
 * ------------------------------------------------------------------------- */

const APCA = {
  TRC: 2.4,
  Rco: 0.2126729,
  Gco: 0.7151522,
  Bco: 0.0721750,
  normBG: 0.56,
  normTXT: 0.57,
  revTXT: 0.62,
  revBG: 0.65,
  blkThrs: 0.022,
  blkClmp: 1.414,
  scale: 1.14,
  loOffset: 0.027,
  loClip: 0.1,
  deltaYmin: 0.0005,
};

function sRGBtoY([r, g, b]) {
  return APCA.Rco * ((r / 255) ** APCA.TRC)
    + APCA.Gco * ((g / 255) ** APCA.TRC)
    + APCA.Bco * ((b / 255) ** APCA.TRC);
}

function apcaContrast(txtRgb, bgRgb) {
  let txtY = sRGBtoY(txtRgb);
  let bgY = sRGBtoY(bgRgb);
  txtY = txtY > APCA.blkThrs ? txtY : txtY + ((APCA.blkThrs - txtY) ** APCA.blkClmp);
  bgY = bgY > APCA.blkThrs ? bgY : bgY + ((APCA.blkThrs - bgY) ** APCA.blkClmp);
  if (Math.abs(bgY - txtY) < APCA.deltaYmin) return 0;

  let out;
  if (bgY > txtY) {
    const sapc = ((bgY ** APCA.normBG) - (txtY ** APCA.normTXT)) * APCA.scale;
    out = sapc < APCA.loClip ? 0 : sapc - APCA.loOffset;
  } else {
    const sapc = ((bgY ** APCA.revBG) - (txtY ** APCA.revTXT)) * APCA.scale;
    out = sapc > -APCA.loClip ? 0 : sapc + APCA.loOffset;
  }
  return out * 100;
}

const WHITE = [255, 255, 255];
/** Readability of white text on this background, as a positive magnitude. */
function whiteTextLc(rgb) {
  return Math.abs(apcaContrast(WHITE, rgb));
}

/* ---------------------------------------------------------------------------
 *  Quantization: weighted k-means in OKLab.
 *
 *  Material runs Wu (variance-minimising box cuts) to seed k-means, for
 *  determinism and speed at high cluster counts. The same two properties are
 *  available more simply here: a coarse OKLab histogram collapses 16k pixels
 *  into a few hundred weighted points, and k-means++ seeded from a fixed PRNG
 *  makes the result reproducible. Same image in, same colour out — which
 *  matters, because a bar that picks a different shade on each launch reads
 *  as a bug even when both shades are defensible.
 * ------------------------------------------------------------------------- */

/** mulberry32 — small, fast, fixed-seed PRNG. */
function prng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const HIST_L = 24;   // lightness bins
const HIST_AB = 24;  // chroma-plane bins per axis
const AB_RANGE = 0.5; // OKLab a/b span that covers sRGB comfortably

function histogram(samples) {
  const bins = new Map();
  for (let i = 0; i < samples.length; i += 1) {
    const [r, g, b] = samples[i];
    const lab = rgbToOklab(r, g, b);
    const li = Math.min(HIST_L - 1, Math.max(0, Math.floor(lab[0] * HIST_L)));
    const ai = Math.min(HIST_AB - 1, Math.max(0, Math.floor(((lab[1] + AB_RANGE / 2) / AB_RANGE) * HIST_AB)));
    const bi = Math.min(HIST_AB - 1, Math.max(0, Math.floor(((lab[2] + AB_RANGE / 2) / AB_RANGE) * HIST_AB)));
    const key = (li * HIST_AB + ai) * HIST_AB + bi;
    const hit = bins.get(key);
    if (hit) {
      hit.n += 1;
      hit.L += lab[0]; hit.a += lab[1]; hit.b += lab[2];
    } else {
      bins.set(key, { n: 1, L: lab[0], a: lab[1], b: lab[2] });
    }
  }
  // Bin CENTROIDS, not bin centres: the average of the pixels that landed in
  // the bin is a truer representative than the geometric middle of a box.
  return [...bins.values()].map((v) => ({
    L: v.L / v.n, a: v.a / v.n, b: v.b / v.n, w: v.n,
  }));
}

function kmeans(points, k, seed = 0x5EED) {
  if (points.length <= k) {
    return points.map((p) => ({ L: p.L, a: p.a, b: p.b, w: p.w }));
  }
  const rnd = prng(seed);
  const dist2 = (p, c) => ((p.L - c.L) ** 2) + ((p.a - c.a) ** 2) + ((p.b - c.b) ** 2);

  /* k-means++ seeding, population-weighted. Picking the first centre as the
     heaviest point rather than at random removes the last source of run-to-run
     variation while keeping the spread-out property that makes ++ work. */
  const centres = [];
  let heaviest = points[0];
  for (const p of points) if (p.w > heaviest.w) heaviest = p;
  centres.push({ L: heaviest.L, a: heaviest.a, b: heaviest.b });

  while (centres.length < k) {
    let total = 0;
    const weights = points.map((p) => {
      let best = Infinity;
      for (const c of centres) { const d = dist2(p, c); if (d < best) best = d; }
      const w = best * p.w;
      total += w;
      return w;
    });
    if (total <= 0) break;
    let target = rnd() * total;
    let idx = points.length - 1;
    for (let i = 0; i < weights.length; i += 1) {
      target -= weights[i];
      if (target <= 0) { idx = i; break; }
    }
    centres.push({ L: points[idx].L, a: points[idx].a, b: points[idx].b });
  }

  const assign = new Int32Array(points.length).fill(-1);
  for (let iter = 0; iter < 20; iter += 1) {
    let moved = false;
    for (let i = 0; i < points.length; i += 1) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centres.length; c += 1) {
        const d = dist2(points[i], centres[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; moved = true; }
    }
    const acc = centres.map(() => ({ L: 0, a: 0, b: 0, w: 0 }));
    for (let i = 0; i < points.length; i += 1) {
      const p = points[i];
      const t = acc[assign[i]];
      t.L += p.L * p.w; t.a += p.a * p.w; t.b += p.b * p.w; t.w += p.w;
    }
    for (let c = 0; c < centres.length; c += 1) {
      if (acc[c].w === 0) continue;
      centres[c] = { L: acc[c].L / acc[c].w, a: acc[c].a / acc[c].w, b: acc[c].b / acc[c].w };
    }
    if (!moved && iter > 0) break;
  }

  const weights = centres.map(() => 0);
  for (let i = 0; i < points.length; i += 1) weights[assign[i]] += points[i].w;
  return centres
    .map((c, i) => ({ ...c, w: weights[i] }))
    .filter((c) => c.w > 0);
}

/* ---------------------------------------------------------------------------
 *  Scoring.
 * ------------------------------------------------------------------------- */

const TARGET_CHROMA = 0.115;   // OKLCh analogue of Material's HCT chroma 48
const CUTOFF_CHROMA = 0.025;   // below this a cluster is a neutral, not a colour
const CUTOFF_PROPORTION = 0.01;
const WEIGHT_PROPORTION = 0.7;
const WEIGHT_CHROMA_ABOVE = 0.3;
const WEIGHT_CHROMA_BELOW = 0.1;

/**
 * Rank clusters by how well each would serve as THE colour of this cover.
 *
 * Population alone picks the background of the sleeve, which is very often
 * white, black or a paper tone — true, and useless. Chroma alone picks the
 * brightest speck, which is arresting and unrepresentative. Material's
 * weighting of the two, with the hue-neighbourhood excitation, is the best
 * published resolution of that tension and is what this follows.
 */
function scoreClusters(clusters) {
  const total = clusters.reduce((n, c) => n + c.w, 0) || 1;

  const huePop = new Float64Array(360);
  for (const c of clusters) {
    const [, C, h] = oklabToLch([c.L, c.a, c.b]);
    if (C < CUTOFF_CHROMA) continue; // neutrals carry no hue to excite
    huePop[Math.floor(degrees(h)) % 360] += c.w;
  }
  const excited = new Float64Array(360);
  for (let hue = 0; hue < 360; hue += 1) {
    const proportion = huePop[hue] / total;
    if (proportion === 0) continue;
    for (let i = hue - 14; i < hue + 16; i += 1) {
      excited[((i % 360) + 360) % 360] += proportion;
    }
  }

  return clusters.map((c) => {
    const [L, C, h] = oklabToLch([c.L, c.a, c.b]);
    const hueDeg = degrees(h);
    const proportion = excited[Math.round(hueDeg) % 360];
    const chromaWeight = C < TARGET_CHROMA ? WEIGHT_CHROMA_BELOW : WEIGHT_CHROMA_ABOVE;
    const score = (proportion * 100 * WEIGHT_PROPORTION)
      + ((C - TARGET_CHROMA) * 100 * chromaWeight);
    return {
      L, C, h, hueDeg, proportion, share: c.w / total, score,
      lab: [c.L, c.a, c.b], w: c.w,
      usable: C >= CUTOFF_CHROMA && proportion > CUTOFF_PROPORTION,
      rgb: oklchToRgb(L, C, h),
    };
  }).sort((a, b) => b.score - a.score);
}

/* ---------------------------------------------------------------------------
 *  Turning the chosen colour into a bar.
 * ------------------------------------------------------------------------- */

/* Palmer & Schloss's disliked band, expressed in OKLCh.
 *
 * Material defines it in HCT as hue 90-111, chroma > 16, tone < 65. HCT and
 * OKLCh number their hue circles differently, so the band was located by
 * sweeping the sRGB cube through Material's own Hct and recording where those
 * colours land here: OKLCh hue 88.5 to 107, median 98. Narrow — it is dark
 * YELLOW-GREEN specifically, not greens. Lime sits at 129 and darkens to a
 * perfectly pleasant forest green, so it must stay outside.
 */
/* 78, not the measured 88.5. The band's low edge is a preference gradient
   rather than a line, and golds sitting just below it darken into mustard all
   the same — a sweep of the sRGB cube found the only survivors clustered at
   84-87. Widening costs little: colours between 78 and 88 are ambers, and the
   rotation target is 68, so they move barely at all. */
const DISLIKE_LO = 78;
const DISLIKE_HI = 110;
const DISLIKE_TONE = 0.66;
const DISLIKE_TARGET_HUE = 68;  // amber; dark amber is brown, which is liked

const MAX_CHROMA = 0.16;
const MIN_LIGHTNESS = 0.16;
const TARGET_LC = 78;
const PREFERRED_LC = 90;

const RAD = Math.PI / 180;

/** Lower lightness until white text reaches the target. Bisection is exact
 *  because contrast against white is monotone in lightness. */
function darkenToLc(L, C, h, target) {
  if (whiteTextLc(oklchToRgb(L, C, h)) >= target) return L;
  let lo = 0;
  let hi = L;
  for (let i = 0; i < 20; i += 1) {
    const mid = (lo + hi) / 2;
    if (whiteTextLc(oklchToRgb(mid, C, h)) >= target) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * Finish a colour for use as the now-playing bar.
 *
 * The important departure from the old barTone(): lightness is NOT pinned.
 * It comes down only as far as the white label needs, so a mid-dark teal
 * arrives almost untouched while a pastel pink comes down to the readability
 * boundary and stops. A pale sleeve still yields a noticeably lighter bar
 * than a black one, which is the information the fixed 0.24 was discarding.
 */
export function toBarColour(rgb, opts = {}) {
  const targetLc = opts.targetLc ?? TARGET_LC;
  const maxChroma = opts.maxChroma ?? MAX_CHROMA;

  const lch = oklabToLch(rgbToOklab(rgb[0], rgb[1], rgb[2]));
  let L = lch[0];
  let C = Math.min(lch[1], maxChroma);
  let h = lch[2];

  L = darkenToLc(L, C, h, targetLc);

  /* The dislike test runs on the DARKENED colour, not the original.
     Checking first was wrong in the case that matters most: a bright yellow
     sleeve is light (lightness 0.89) and therefore not disliked as it stands,
     but yellows are the lightest hues there are — pure yellow has no contrast
     against white at all — so making one readable always drives it deep into
     the mustard range. The colour that needs judging is the one being shipped.

     The remedy is a hue rotation toward amber rather than Material's lift to
     tone 70, which isn't available under white text. Dark amber is brown, and
     brown is simply a dark orange: nowhere near the disliked band, and the
     one dark warm colour people reliably like. Draining chroma instead was
     tried and gives a grey-olive taupe — inoffensive but dead. */
  const hueDeg = degrees(h);
  const disliked = hueDeg >= DISLIKE_LO && hueDeg <= DISLIKE_HI && C > 0.04 && L < DISLIKE_TONE;
  if (disliked) {
    h = DISLIKE_TARGET_HUE * RAD;
    C = Math.min(C, 0.12);
    L = darkenToLc(lch[0], C, h, targetLc); // re-solve: rotating moved the luminance
  }

  /* Floor. A genuinely black sleeve should give a near-black bar, but pure
     black loses the hue entirely and stops looking related to the artwork. */
  if (L < MIN_LIGHTNESS) L = MIN_LIGHTNESS;

  /* The floor can push a colour back under target — only for colours already
     darker than the floor, where the lift is small. Chroma is the cheaper
     thing to give up there. */
  let out = oklchToRgb(L, C, h);
  let guard = 0;
  while (whiteTextLc(out) < targetLc && C > 0.005 && guard < 12) {
    C *= 0.8;
    out = oklchToRgb(L, C, h);
    guard += 1;
  }

  return {
    rgb: out,
    L,
    C,
    hueDeg: degrees(h),
    lc: whiteTextLc(out),
    disliked,
    comfortable: whiteTextLc(out) >= PREFERRED_LC,
  };
}

/* ---------------------------------------------------------------------------
 *  Entry point.
 * ------------------------------------------------------------------------- */

/**
 * Pick the colour of a cover from its pixels.
 *
 * `samples` is an array of [r, g, b]. Returns the chosen source colour, the
 * finished bar colour, and enough diagnostics to explain the choice — the
 * picker UI reads these, and so does the test harness.
 */
export function analyseCover(samples, opts = {}) {
  if (!samples || !samples.length) return null;

  const points = histogram(samples);
  const clusters = kmeans(points, opts.k ?? 16);
  const scored = scoreClusters(clusters);
  const usable = scored.filter((s) => s.usable);

  /* Monochrome sleeves reach here with nothing usable: a black-and-white
     photograph has no hue worth naming. Inventing one would be worse than
     admitting it, so the bar becomes a neutral at the cover's own weighted
     lightness — a bright mono sleeve still gives a lighter bar than a dark
     one, so the surface still responds to the artwork. */
  let source;
  let mono = false;
  if (!usable.length) {
    mono = true;
    const totalW = clusters.reduce((n, c) => n + c.w, 0) || 1;
    const meanL = clusters.reduce((n, c) => n + c.L * c.w, 0) / totalW;
    source = { L: meanL, C: 0, h: 0, share: 1, proportion: 1, rgb: oklchToRgb(meanL, 0, 0) };
  } else {
    /* Merge the winning hue FAMILY rather than taking the single best cluster.
     *
     * Quantization splits one visual colour across several clusters — an
     * olive sleeve came back as six clusters spanning hue 99 to 113 — and
     * scoring them individually lets a sliver outvote the mass: the top
     * cluster held 6% of the image and beat the one holding 51% because
     * their hue-excitation scores were identical and it carried 0.006 more
     * chroma. Every one of those clusters is the same colour to a person
     * looking at the sleeve.
     *
     * So the winner nominates a hue, and the colour returned is the
     * population-weighted centroid of everything within 15 degrees of it —
     * the same neighbourhood width the excitation uses. That is both more
     * representative and far more stable: it no longer matters which
     * fragment of a colour happens to win by a rounding margin.
     */
    const winner = usable[0];
    const FAMILY_DEGREES = 15;
    const near = scored.filter((cand) => {
      if (cand.C < CUTOFF_CHROMA) return false;
      const d = Math.abs(cand.hueDeg - winner.hueDeg);
      return Math.min(d, 360 - d) <= FAMILY_DEGREES;
    });
    const fw = near.reduce((n, cand) => n + cand.w, 0) || 1;
    const merged = [
      near.reduce((n, cand) => n + cand.lab[0] * cand.w, 0) / fw,
      near.reduce((n, cand) => n + cand.lab[1] * cand.w, 0) / fw,
      near.reduce((n, cand) => n + cand.lab[2] * cand.w, 0) / fw,
    ];
    const [mL, mC, mh] = oklabToLch(merged);
    source = {
      L: mL, C: mC, h: mh,
      share: fw / (scored.reduce((n, cand) => n + cand.w, 0) || 1),
      proportion: winner.proportion,
      rgb: oklchToRgb(mL, mC, mh),
      members: near.length,
    };
  }

  const bar = toBarColour(source.rgb, opts);

  return {
    source: source.rgb,
    bar: bar.rgb,
    mono,
    lc: bar.lc,
    disliked: bar.disliked,
    sourceShare: source.share,
    sourceChroma: source.C,
    hueDeg: source.C > 0 ? degrees(source.h) : null,
    palette: scored.slice(0, 6).map((s) => ({
      rgb: s.rgb, share: s.share, chroma: s.C, hue: s.hueDeg, score: s.score, usable: s.usable,
    })),
  };
}
