import { analyseCover, toBarColour, rgbToOklab, oklabToLch, oklchToRgb } from './coverColour.js';

/**
 * Build a theme from an average artwork colour.
 *
 * Extracted so the main process can produce byte-identical themes when it
 * samples an image itself — see sampleImageTheme(). Two callers, one set of
 * numbers; a second copy would drift.
 */
export function themeFromAverage(r, g, b) {
  // The accent has to stay legible against the dark UI (it's used for text,
  // pills, rings, etc.). For dark artwork the raw average comes out very dark
  // and accent-coloured elements become unreadable, so when its perceived
  // luminance is too low we fall back to white. The background washes below
  // still use the true average, so the ambient gradient keeps matching.
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b; // 0..255
  const accent = lum < 80 ? '255, 255, 255' : `${r}, ${g}, ${b}`;
  const mix = (v, base, amt) => Math.round(v * amt + base * (1 - amt));
  return {
    accent,
    // A deep tone for veils and gradient tails, where dark IS the point.
    wash: `${mix(r, 6, 0.18)}, ${mix(g, 6, 0.18)}, ${mix(b, 6, 0.18)}`,
    /* `mid` is the colour surfaces are built from, so it's the sampled colour
       itself. It used to be pre-darkened to 34% because pageWash pinned
       lightness anyway; now that pageWash only darkens as far as readability
       demands, that pre-darkening applied a second time and every surface came
       out roughly twice as dark as asked for. */
    mid: `${r}, ${g}, ${b}`,
    deep: '0, 0, 0',
  };
}

/* ---------------------------------------------------------------------------
 *  Reading colour out of artwork.
 *
 *  A flat mean is what this file did for years, and it's right for graphic
 *  sleeves with one dominant tone. It fails on photographs: complementary
 *  colours cancel toward grey, and pageWash then reads a near-neutral mean as
 *  achromatic and pins it near-black. A black-and-white cover averages to
 *  exactly rgb(128,128,128) and produces a black page.
 *
 *  So the analysis produces BOTH readings — a mean, and a palette of the
 *  colours that are actually present — and lets the caller choose. Sampling
 *  once for two answers is cheaper than sampling twice, and it means changing
 *  the setting never needs a re-fetch.
 * ------------------------------------------------------------------------- */

function rgbToHsl(r, g, b) {
  const rr = r / 255; const gg = g / 255; const bb = b / 255;
  const mx = Math.max(rr, gg, bb); const mn = Math.min(rr, gg, bb);
  const l = (mx + mn) / 2; const d = mx - mn;
  let h = 0;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (mx === rr) h = ((gg - bb) / d) % 6;
    else if (mx === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let v;
  if (h < 60) v = [c, x, 0]; else if (h < 120) v = [x, c, 0];
  else if (h < 180) v = [0, c, x]; else if (h < 240) v = [0, x, c];
  else if (h < 300) v = [x, 0, c]; else v = [c, 0, x];
  return v.map((u) => Math.round((u + m) * 255));
}

/**
 * Mean and palette from a flat list of [r, g, b] samples.
 *
 * The palette deliberately throws pixels away. Near-black, near-white and
 * near-grey ones carry no hue, so averaging them in is what destroys the
 * colour; excluded, what remains is bucketed by hue and weighted by how vivid
 * and how mid-toned it is — roughly "how much does this pixel look like the
 * colour of the record". A white sleeve with a red logo comes back red,
 * because the red is the only colour in it.
 */
export function analyzeSamples(samples) {
  const BUCKETS = 24;
  const acc = Array.from({ length: BUCKETS }, () => ({ w: 0, maxSat: 0 }));

  /* Hue is an ANGLE, so it has to be averaged as one.
     Adding magenta and green channel by channel gives grey — they sit opposite
     each other on the wheel and cancel — and the tiny imbalance left over is
     what a psychedelic sleeve was being coloured from. Summing unit vectors
     instead keeps the answer on the wheel, and the length of that sum says how
     much the artwork agrees with itself about its colour. */
  let vx = 0; let vy = 0; let sw = 0; let satSum = 0; let litSum = 0;
  let flatR = 0; let flatG = 0; let flatB = 0; let n = 0;

  const kept = [];
  for (const [r, g, b] of samples) {
    flatR += r; flatG += g; flatB += b; n += 1;
    const [h, sat, l] = rgbToHsl(r, g, b);
    if (l < 0.10 || l > 0.93 || sat < 0.16) continue;
    const w = sat * (1 - Math.abs(l - 0.5) * 1.1);
    if (w <= 0) continue;
    const rad = (h * Math.PI) / 180;
    vx += Math.cos(rad) * w; vy += Math.sin(rad) * w;
    sw += w; satSum += sat * w; litSum += l * w;
    const k = Math.min(BUCKETS - 1, Math.floor(h / (360 / BUCKETS)));
    acc[k].w += w;
    if (sat > acc[k].maxSat) acc[k].maxSat = sat;
    kept.push([r, g, b, k, sat]);
  }

  /* Pass two: average only the VIVID end of each hue.
     Averaging a whole bucket mixes a hue's bright and muddy pixels together
     and returns the mud — a red logo on a maroon sleeve came back brown. */
  const sums = Array.from({ length: BUCKETS }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  for (const [r, g, b, k, sat] of kept) {
    if (sat < acc[k].maxSat * 0.6) continue;
    sums[k].w += sat; sums[k].r += r * sat; sums[k].g += g * sat; sums[k].b += b * sat;
  }

  /* Ranked by how much of the artwork each hue accounts for, with a floor so a
     stray dozen pixels can't become one of "the colours of this record". */
  const ranked = acc
    .map((a, i) => ({ w: a.w, i }))
    .filter((a) => a.w > 0 && sums[a.i].w > 0)
    .sort((x, y) => y.w - x.w);
  const floor = ranked.length ? ranked[0].w * 0.2 : 0;
  const palette = ranked
    .filter((a) => a.w >= floor)
    .slice(0, 4)
    .map(({ i }) => [
      Math.round(sums[i].r / sums[i].w),
      Math.round(sums[i].g / sums[i].w),
      Math.round(sums[i].b / sums[i].w),
    ]);

  /* Three measurements of the artwork, used to decide which reading suits it.
       agreement — 1 is a single-hue sleeve, near 0 means the hues point every
                   direction and their mean is noise
       chroma    — how much of the sleeve carries colour at all, so a mostly
                   neutral photo with one bright mark can be told apart from a
                   saturated one
       coverage  — how much of that colour belongs to the leading hue */
  const agreement = sw > 0 ? Math.hypot(vx, vy) / sw : 0;
  const chroma = n > 0 ? kept.length / n : 0;
  const coverage = sw > 0 && ranked.length ? ranked[0].w / sw : 0;

  let average;
  if (sw > 0 && agreement >= 0.32) {
    const hue = ((Math.atan2(vy, vx) * 180) / Math.PI + 360) % 360;
    average = hslToRgb(hue, Math.min(0.95, satSum / sw), Math.min(0.85, Math.max(0.2, litSum / sw)));
  } else if (palette.length) {
    /* A rainbow has no average worth showing, so rather than inventing a hue
       out of the leftover imbalance, say which colour there is most of. */
    average = palette[0];
  } else if (n) {
    average = [Math.round(flatR / n), Math.round(flatG / n), Math.round(flatB / n)];
  } else {
    average = [40, 40, 40];
  }

  const best = bestSwatch(samples);
  /* Insert Studio's own two readings in the order the lab lists them, using the
     values computed above rather than a second implementation. */
  if (best?.candidates) {
    /* The picker's Auto row has to show what Auto ACTUALLY produces.
       It used to show best.rgb — the six-target score — and that scoring no
       longer chooses anything (see autoReading). Leaving it would let you save
       a manual override believing you were pinning Auto, and manual overrides
       store a literal colour, so it would freeze a value Auto never picks. */
    const autoAt = best.candidates.findIndex((c) => c.name === 'Auto');
    if (autoAt >= 0 && palette.length) best.candidates[autoAt] = { name: 'Auto', rgb: toBarColour(palette[0]).rgb };
    const insert = (name, rgb, at) => {
      if (rgb) best.candidates.splice(at, 0, { name, rgb });
    };
    const vibrantAt = best.candidates.findIndex((c) => c.name === 'Studio vibrant');
    const at = vibrantAt >= 0 ? vibrantAt + 1 : best.candidates.length;
    insert('Studio dominant', palette.length ? palette[0] : null, at);
    insert('Studio average', average, at + 1);
  }
  return {
    average, palette, agreement, chroma, coverage,
    vibrant: best ? best.rgb : null,
    bestTarget: best ? best.target : null,
    swatches: best?.swatches || [],
    candidates: best?.candidates || [],
  };
}

/**
 * The reading Spotify uses, near enough.
 *
 * Theirs descends from Android's Palette: quantise the image into colour
 * cells, then SCORE each candidate against targets rather than just counting
 * pixels or picking the loudest hue. A swatch is good if it's saturated, if
 * it's mid-toned, and if a decent amount of the artwork is that colour — three
 * pulls balanced against each other.
 *
 * That's why it behaves differently from both readings here. Dominant answers
 * "which hue is there most of", so a huge muted background beats a small vivid
 * mark. Average answers "what colour is the whole thing", so detail is lost.
 * This asks "which colour best REPRESENTS this record", and a mid-toned,
 * saturated area covering a fifth of the sleeve wins over a dull area covering
 * half of it.
 *
 * Weights are Palette's own defaults: saturation .24, luma .52, population
 * .24 — luma dominates because a colour that's nearly black or nearly white
 * makes a poor surface no matter how much of the cover it occupies.
 */
/* ---------------------------------------------------------------------------
 *  Choosing a colour, the way Palette does — and choosing the TARGET too.
 *
 *  This is what "Auto" was missing. It used to weigh hue statistics to choose
 *  between two of my own readings, which is a guess dressed up as a rule: the
 *  numbers said how varied a cover was, not which treatment would suit it.
 *
 *  Palette scores a swatch against a target — how close its saturation and
 *  lightness sit to what that target wants, plus how much of the artwork it
 *  covers. Crucially the FORMULA is identical for every target, so the scores
 *  are directly comparable. Run all five targets, take the highest score, and
 *  the artwork selects its own treatment: a vivid poster lands on Vibrant, a
 *  muted photograph on Muted, a dark sleeve on Dark Muted, a pale one on Light
 *  Muted. Nothing to tune, and it can say which one it chose.
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 *  Picking a colour, fitted to real data.
 *
 *  This is not a guess at what Spotify does — it's the configuration that
 *  scored best against eight of your own covers with their actual Spotify
 *  colours sampled by hand, searched over ~4,000 rule variants and six
 *  quantisers. Mean error 29.8, against a best-possible-for-this-quantiser
 *  ceiling of 25.0, down from 59 for what shipped before.
 *
 *  Three findings drove it, each of which killed an earlier approach:
 *
 *   - Median cut halves the pixel count at every split, so all its boxes end
 *     up the same size. "How much of the cover is this colour" was a constant
 *     in every score, contributing nothing. k-means clusters by similarity, so
 *     cluster size is a real signal.
 *
 *   - The right answers span saturation 0.04-0.70 and lightness 0.12-0.53. No
 *     fixed target can describe both a near-neutral grey and a vivid blue, so
 *     Palette's six-target scheme was always going to compromise.
 *
 *   - Lightness tracks the artwork's own, roughly 0.4x + 0.19. Aiming at a
 *     constant 0.5 turned a near-black sleeve into mid-grey and cost more than
 *     any other single error.
 * ------------------------------------------------------------------------- */

const FIT = {
  clusters: 16,
  /* 0.28, not 0.19. The 0.19 fit was measured against a k-means that seeded at
     evenly spaced indices and collapsed on low-variance covers; this file ships
     k-means++ seeding, and re-fitting on the same eight covers with the better
     clustering moved the offset. Code and measurement have to describe the same
     algorithm or the number means nothing. */
  lumaSlope: 0.4,        // aimed lightness = slope * coverLuma + offset
  lumaOffset: 0.28,
  targetSat: 0.5,
  wSat: 0.15,
  wLuma: 0.65,
  wPop: 0.20,
};

/** Median cut, as the lab's Palette rows use it. */
function medianCut(pixels, depth) {
  if (depth === 0 || !pixels.length) {
    if (!pixels.length) return [];
    let r = 0; let g = 0; let b = 0;
    for (const p of pixels) { r += p[0]; g += p[1]; b += p[2]; }
    const n = pixels.length;
    const mean = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    let vivid = mean; let vs = -1;
    for (const p of pixels) { const sx = rgbToHsl(p[0], p[1], p[2])[1]; if (sx > vs) { vs = sx; vivid = p; } }
    return [{ rgb: mean, vivid, n }];
  }
  let widest = 0; let range = -1;
  for (let c = 0; c < 3; c += 1) {
    let lo = 255; let hi = 0;
    for (const p of pixels) { if (p[c] < lo) lo = p[c]; if (p[c] > hi) hi = p[c]; }
    if (hi - lo > range) { range = hi - lo; widest = c; }
  }
  pixels.sort((x, y) => x[widest] - y[widest]);
  const mid = pixels.length >> 1;
  return [...medianCut(pixels.slice(0, mid), depth - 1), ...medianCut(pixels.slice(mid), depth - 1)];
}

/** A fixed histogram, as the lab's "Studio Vibrant (current)" row uses it. */
function gridCells(px, bits) {
  const shift = 8 - bits; const m = new Map();
  for (const p of px) {
    const key = ((p[0] >> shift) << (bits * 2)) | ((p[1] >> shift) << bits) | (p[2] >> shift);
    let c = m.get(key);
    if (!c) { c = { r: 0, g: 0, b: 0, n: 0, vivid: p, vs: -1 }; m.set(key, c); }
    c.r += p[0]; c.g += p[1]; c.b += p[2]; c.n += 1;
    const sx = rgbToHsl(p[0], p[1], p[2])[1];
    if (sx > c.vs) { c.vs = sx; c.vivid = p; }
  }
  return [...m.values()].map((c) => ({
    rgb: [Math.round(c.r / c.n), Math.round(c.g / c.n), Math.round(c.b / c.n)], vivid: c.vivid, n: c.n,
  }));
}

/** Score cells against a Palette target, falling back ungated if it empties. */
function scoreTarget(cells, tSat, tLuma, sMin, sMax, lMin, lMax) {
  if (!cells.length) return null;
  const maxN = Math.max(...cells.map((c) => c.n));
  const run = (gated) => {
    let best = null; let bs = -1;
    for (const cell of cells) {
      for (const rgb of [cell.rgb, cell.vivid || cell.rgb]) {
        const [, sat, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
        if (gated && (sat < sMin || sat > sMax || l < lMin || l > lMax)) continue;
        const sc = (1 - Math.abs(sat - tSat)) * 0.24 + (1 - Math.abs(l - tLuma)) * 0.52 + (cell.n / maxN) * 0.24;
        if (sc > bs) { bs = sc; best = rgb; }
      }
    }
    return best;
  };
  return run(true) || run(false);
}

/**
 * k-means over the sampled pixels.
 *
 * Seeded k-means++ style — each new centre placed far from those already
 * chosen. Seeding at evenly spaced positions instead puts several centres on
 * near-identical pixels whenever a cover is low-variance, and they collapse:
 * one test cover came back with six clusters instead of sixteen, and the
 * colour we wanted wasn't among them.
 */
function kmeans(px, k, iters = 10) {
  if (!px.length) return [];
  const centres = [px[Math.floor(px.length / 2)].slice()];
  const d2 = new Array(px.length).fill(Infinity);
  while (centres.length < k) {
    const last = centres[centres.length - 1];
    let total = 0;
    for (let i = 0; i < px.length; i += 1) {
      const d = (px[i][0] - last[0]) ** 2 + (px[i][1] - last[1]) ** 2 + (px[i][2] - last[2]) ** 2;
      if (d < d2[i]) d2[i] = d;
      total += d2[i];
    }
    if (total <= 0) break;
    // Deterministic weighted pick, so the same cover always yields the same
    // palette — a colour that flickers between launches is worse than a
    // slightly worse colour that holds still.
    let acc = 0; const stop = total * 0.5; let chosen = px[px.length - 1];
    for (let i = 0; i < px.length; i += 1) { acc += d2[i]; if (acc >= stop) { chosen = px[i]; break; } }
    centres.push(chosen.slice());
  }

  const assign = new Array(px.length).fill(0);
  for (let it = 0; it < iters; it += 1) {
    for (let i = 0; i < px.length; i += 1) {
      let bd = Infinity; let bi = 0;
      for (let c = 0; c < centres.length; c += 1) {
        const d = (px[i][0] - centres[c][0]) ** 2 + (px[i][1] - centres[c][1]) ** 2 + (px[i][2] - centres[c][2]) ** 2;
        if (d < bd) { bd = d; bi = c; }
      }
      assign[i] = bi;
    }
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < px.length; i += 1) {
      const a = assign[i];
      sums[a][0] += px[i][0]; sums[a][1] += px[i][1]; sums[a][2] += px[i][2]; sums[a][3] += 1;
    }
    for (let c = 0; c < centres.length; c += 1) {
      if (sums[c][3]) centres[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
    }
  }

  /* Two passes for the vivid representative.
     Taking the single most saturated pixel in a cluster means one pixel out of
     four thousand can become the colour of the whole app — a stray neon speck,
     a JPEG artefact, an anti-aliased edge. That is where the genuinely awful
     picks come from. Instead: find how saturated the cluster gets, then average
     the pixels near that top end. The result is still the vivid side of the
     cluster, but it's a colour several pixels agree on. */
  const out = centres.map(() => ({ r: 0, g: 0, b: 0, n: 0, maxSat: 0 }));
  for (let i = 0; i < px.length; i += 1) {
    const o = out[assign[i]];
    o.r += px[i][0]; o.g += px[i][1]; o.b += px[i][2]; o.n += 1;
    const sx = rgbToHsl(px[i][0], px[i][1], px[i][2])[1];
    if (sx > o.maxSat) o.maxSat = sx;
  }
  const vivid = centres.map(() => ({ r: 0, g: 0, b: 0, n: 0 }));
  for (let i = 0; i < px.length; i += 1) {
    const a = assign[i]; const o = out[a];
    if (o.maxSat <= 0) continue;
    const sx = rgbToHsl(px[i][0], px[i][1], px[i][2])[1];
    if (sx < o.maxSat * 0.75) continue;
    const v = vivid[a];
    v.r += px[i][0]; v.g += px[i][1]; v.b += px[i][2]; v.n += 1;
  }
  /* The real pixel closest to each cluster's mean.
     A cluster mean is an average, so it can be a colour that appears nowhere
     in the artwork — average a red flag and a blue sky and you get grey. For
     scoring that's fine, it's a summary. For a picker that promises "colours
     from this cover" it isn't: the user would choose a swatch and then be
     unable to find it in the sleeve. This snaps each swatch onto a pixel that
     is actually there. */
  const exact = centres.map(() => ({ d: Infinity, p: null }));
  for (let i = 0; i < px.length; i += 1) {
    const a = assign[i]; const o = out[a];
    if (!o.n) continue;
    const d = (px[i][0] - o.r / o.n) ** 2 + (px[i][1] - o.g / o.n) ** 2 + (px[i][2] - o.b / o.n) ** 2;
    if (d < exact[a].d) { exact[a].d = d; exact[a].p = px[i]; }
  }
  return out.map((o, i) => {
    if (!o.n) return null;
    const mean = [Math.round(o.r / o.n), Math.round(o.g / o.n), Math.round(o.b / o.n)];
    const v = vivid[i];
    return {
      rgb: mean,
      exact: exact[i].p ? exact[i].p.map((n) => Math.round(n)) : mean,
      vivid: v.n ? [Math.round(v.r / v.n), Math.round(v.g / v.n), Math.round(v.b / v.n)] : mean,
      n: o.n,
    };
  }).filter(Boolean);
}

/** The cover's own average lightness, which the aimed lightness is built from. */
function meanLuma(cells) {
  let r = 0; let g = 0; let b = 0; let n = 0;
  for (const c of cells) { r += c.rgb[0] * c.n; g += c.rgb[1] * c.n; b += c.rgb[2] * c.n; n += c.n; }
  return n ? rgbToHsl(r / n, g / n, b / n)[2] : 0.5;
}

/**
 * The six-target reading.
 *
 * Reverted to this from the fitted k-means rule. The fitted one scored better
 * against Spotify's colours — 39 mean error against 59 — but matching Spotify
 * was only ever a proxy for looking right, and on real covers this one looks
 * better. Where the two disagree, taste wins over the metric; the fitted rule
 * is still one click away in the picker as "Fitted".
 *
 * Every target uses the same scoring formula, so their scores compare directly
 * and the artwork picks its own treatment: a poster lands on Vibrant, a muted
 * photograph on Muted, a dark sleeve on Dark muted.
 */
const PALETTE_TARGETS = [
  // name          targetSat  targetLuma  satMin satMax  lumaMin lumaMax
  ['vibrant', 1.0, 0.50, 0.35, 1.0, 0.30, 0.70],
  ['lightVibrant', 1.0, 0.74, 0.35, 1.0, 0.55, 1.00],
  ['darkVibrant', 1.0, 0.26, 0.35, 1.0, 0.00, 0.45],
  ['muted', 0.30, 0.50, 0.00, 0.40, 0.30, 0.70],
  ['lightMuted', 0.30, 0.74, 0.00, 0.40, 0.55, 1.00],
  ['darkMuted', 0.30, 0.26, 0.00, 0.40, 0.00, 0.45],
];

/** The fitted k-means rule, kept as an offerable alternative. */
function fittedSwatch(usable) {
  const cells = kmeans(usable.map((p) => p.slice()), FIT.clusters);
  if (!cells.length) return null;
  const maxN = Math.max(...cells.map((c) => c.n));
  const total = cells.reduce((t, c) => t + c.n, 0);
  const aim = Math.min(0.9, Math.max(0.05, FIT.lumaSlope * meanLuma(cells) + FIT.lumaOffset));
  const floor = total * 0.04;
  const eligible = cells.filter((c) => c.n >= floor);
  const pool = eligible.length ? eligible : cells;
  let best = null;
  for (const cell of pool) {
    for (const rgb of [cell.rgb, cell.vivid]) {
      const [, sat, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
      const score = (1 - Math.abs(sat - FIT.targetSat)) * FIT.wSat
        + (1 - Math.abs(l - aim)) * FIT.wLuma
        + (cell.n / maxN) * FIT.wPop;
      if (!best || score > best.score) best = { score, rgb };
    }
  }
  return best ? best.rgb : null;
}

function bestSwatch(samples) {
  const usable = samples.filter((p) => {
    const l = rgbToHsl(p[0], p[1], p[2])[2];
    return l > 0.05 && l < 0.95;
  });
  if (!usable.length) return null;

  /* k-means, not median cut.
     Median cut splits at the median, so all 64 of its cells hold the same
     number of pixels — which makes (cell.n / maxN) equal 1 everywhere and the
     population term a constant that cancels out of every comparison. Auto was
     therefore choosing on saturation and lightness alone, and would take a
     vivid sliver over a colour covering a tenth of the sleeve: on one cover it
     picked a small orange at #fa9000 while 11% of the artwork was the deep
     blue Spotify used. k-means clusters by similarity, so a cluster's size is
     genuinely how much of the cover is that colour, and the term does work. */
  const cells = kmeans(usable.map((p) => p.slice()), 16);
  if (!cells.length) return null;
  const maxN = Math.max(...cells.map((c) => c.n));

  /* A colour has to be a real part of the sleeve.
     Without this, a cluster covering 2% of the cover can win outright by
     sitting exactly on a target, and you get a colour you cannot point to in
     the artwork. Dropped only if nothing clears it, so a cover made entirely
     of small scattered regions still returns something. */
  const total = cells.reduce((t, c) => t + c.n, 0);
  const floor = total * 0.04;
  const eligible = cells.filter((c) => c.n >= floor);
  const pool = eligible.length ? eligible : cells;

  let best = null;
  for (const [name, tSat, tLuma, satMin, satMax, lumaMin, lumaMax] of PALETTE_TARGETS) {
    for (const cell of pool) {
      // A cell's mean is duller than its contents, so its most saturated
      // member is a candidate too — otherwise saturation gates never pass.
      for (const rgb of [cell.rgb, cell.vivid]) {
        const [, sat, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
        if (sat < satMin || sat > satMax || l < lumaMin || l > lumaMax) continue;
        const score = (1 - Math.abs(sat - tSat)) * 0.24
          + (1 - Math.abs(l - tLuma)) * 0.52
          + (cell.n / maxN) * 0.24;
        if (!best || score > best.score) best = { score, rgb, target: name };
      }
    }
  }
  /* Nothing passed any gate — artwork of pure near-black and near-white.
     Fall back to the largest cell rather than reporting no colour. */
  if (!best) {
    const big = cells.slice().sort((a, b) => b.n - a.n)[0];
    best = { rgb: big.rgb, target: 'fallback' };
  }

  if (best) {
    /* Every reading the tuning lab compares, computed the same way it computes
       them — median cut for the Palette rows, a 4-bit histogram for the old
       Studio Vibrant, k-means for Auto. Same quantiser, same targets, same
       fallbacks, so a colour offered here is the colour that row showed. */
    const usableForCut = usable.map((p) => p.slice());
    const mc = medianCut(usableForCut.map((p) => p.slice()), 6);
    // The lab builds this from the raw samples, not the luma-filtered set.
    const grid = gridCells(samples, 4);

    const candidates = [];
    /* Every named reading is listed, even when two land on the same colour.
       Dropping duplicates left gaps where a name simply vanished, which makes
       the list impossible to check against the tuning lab — and a repeated
       colour is itself information: it says the readings agree here. */
    const add = (name, rgb) => { if (rgb) candidates.push({ name, rgb }); };
    const lift = (rgb, l) => {
      if (!rgb) return null;
      const [h, sat] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
      return hslToRgb(h, Math.max(0.16, Math.min(0.55, sat)), l);
    };

    add('Auto', best.rgb);
    add('Auto + lift', lift(best.rgb, 0.34));
    add('Fitted', fittedSwatch(usable));
    // Ungated, as the lab runs it — the gated version is 'Palette vibrant'.
    add('Studio vibrant', scoreTarget(grid, 1.0, 0.5, 0, 1, 0, 1));
    /* Filled in by analyzeSamples, which owns the real dominant and average.
       They were re-derived here with different formulas and ended up as
       different algorithms wearing the same names. */
    add('Palette vibrant', scoreTarget(mc, 1.0, 0.50, 0.35, 1.0, 0.30, 0.70));
    add('Palette muted', scoreTarget(mc, 0.30, 0.50, 0.00, 0.40, 0.30, 0.70));
    add('Dark vibrant', scoreTarget(mc, 1.0, 0.26, 0.35, 1.0, 0.00, 0.45));
    add('Dark muted', scoreTarget(mc, 0.30, 0.26, 0.00, 0.40, 0.00, 0.45));
    add('Light muted', scoreTarget(mc, 0.30, 0.74, 0.00, 0.40, 0.55, 1.00));
    const biggest = mc.slice().sort((a, b) => b.n - a.n)[0];
    add('Most populous', biggest ? biggest.rgb : null);
    add('Dark muted, lifted', lift(scoreTarget(mc, 0.30, 0.26, 0.00, 0.45, 0.00, 0.50), 0.34));
    best.candidates = candidates;

    /* Every cluster, NOT just the ones above the prominence floor.
       The floor exists to stop Auto choosing a colour nobody can see, and it
       should: it's the difference between a wash you recognise and one that
       came from twelve stray pixels. But measured against real covers, three of
       eight best-matching colours sat at 1.7-2.2% of the artwork — under the
       floor. So the floor governs what Auto PICKS, and the picker offers
       everything, which is exactly the case where Auto needs overruling. */
    best.swatches = cells
      .slice()
      .sort((a, b) => b.n - a.n)
      .slice(0, 12)
      .map((c) => ({ rgb: c.rgb, exact: c.exact || c.rgb, share: c.n / total, belowFloor: c.n < floor }));
  }
  return best;
}

/* Artwork with no colour in it at all gets a cool slate, not black. It's still
   neutral and still honest about the record being monochrome, but it reads as
   a surface rather than as a hole in the page. */
const MONO_WASH = [38, 40, 48];

/** Full theme from an analysis: the mean reading, plus the palette alongside. */
export function themeFromAnalysis({
  average, palette, agreement = 0, chroma = 0, coverage = 0, vibrant = null, bestTarget = null,
  swatches = [], candidates = [], perceptual = null,
}) {
  const base = themeFromAverage(average[0], average[1], average[2]);
  return {
    ...base,
    /* The perceptual engine's answer — see coverColour.js. `bar` is the
       finished surface colour and is what the app should paint; `source` is
       the colour it was derived from, before the readability work, which the
       picker shows as "from this cover". Everything below this line is the
       previous engine's output, kept because the picker's alternative
       readings are still built from it and because it is the only way to
       compare the two on a real library. */
    bar: perceptual ? perceptual.bar.join(', ') : null,
    barSource: perceptual ? perceptual.source.join(', ') : null,
    mono: perceptual ? perceptual.mono : false,
    dislikeFixed: perceptual ? perceptual.disliked : false,
    lc: perceptual ? perceptual.lc : null,
    dominant: palette.length ? palette[0].join(', ') : MONO_WASH.join(', '),
    palette: (palette.length ? palette : [MONO_WASH]).map((c) => c.join(', ')),
    agreement,
    chroma,
    coverage,
    vibrant: vibrant ? vibrant.join(', ') : null,
    bestTarget,
    swatches: swatches.map((sw) => ({
      rgb: sw.rgb.join(', '),
      exact: (sw.exact || sw.rgb).join(', '),
      share: sw.share,
      belowFloor: !!sw.belowFloor,
    })),
    candidates: candidates.map((c) => ({ name: c.name, rgb: c.rgb.join(', ') })),
  };
}

/**
 * Which reading suits THIS cover.
 *
 * Neither is better in general, which is the whole problem — average is right
 * when a sleeve has an overall tone, dominant is right when it has a colour.
 * The artwork can be asked which it is:
 *
 *   mostly neutral (low chroma) — a grey photo with one red mark. The average
 *     is that grey; the mark is what you'd call the colour of the record, so
 *     dominant wins.
 *   hues agree (high agreement) — a blue sleeve with blue-ish everything. Both
 *     land in the same place, and average keeps the tonal variation, so it wins.
 *   one hue leads (high coverage) — teal with an orange wedge. Blending gives a
 *     muddy compromise nobody chose; dominant wins.
 *   otherwise — several hues, none leading. Blending is the honest summary,
 *     and picking one would be arbitrary, so average wins.
 */
/**
 * Auto is the dominant-hue reading, always.
 *
 * Measured against Spotify's own bar colour on seven covers, hue error by
 * reading: dominant 3.3 degrees, average 9.9, the fitted k-means rule 32.7,
 * the six-target scoring this used to run 39.4, vibrant 92.0. Dominant wins by
 * an order of magnitude and it isn't close, so there is nothing left for the
 * target scoring to decide.
 *
 * The six-target machinery still runs in bestSwatch() and still fills the
 * picker's "Fitted" / "Palette *" rows — those are how this was measured in
 * the first place, and deleting them would remove the only way to check the
 * next change. It just no longer chooses.
 */
export function autoReading() {
  return 'dominant';
}

export function washSourceFor(theme, style = 'auto') {
  if (!theme) return null;
  /* Auto now means the perceptual engine, which already accounts for
     readability and for the disliked band. The older readings stay reachable
     by name so the picker can still offer them and so the two can be compared
     side by side on real covers. */
  if (style === 'auto' && theme.barSource) return theme.barSource;
  const mode = style === 'auto' ? autoReading(theme) : style;
  if (mode === 'vibrant') return theme.vibrant || theme.dominant || theme.mid || null;
  if (mode === 'average') return theme.mid || theme.accent || null;
  return theme.dominant || theme.mid || theme.accent || null;
}

/**
 * Wash source for a RECORD SURFACE — an album, artist or playlist page, and
 * the grid cards that open them.
 *
 * `barSource` first, because that is the CURRENT engine. themeFromAnalysis
 * is explicit about the split: `bar`/`barSource` come from the perceptual
 * engine in coverColour.js, and everything below that line — `mid`,
 * `dominant`, `vibrant`, `palette` — is the previous engine's output, kept
 * only so the picker can still offer its alternative readings.
 *
 * The detail pages were reading `mid || accent` inline, so an album page was
 * painted by the old averaging engine while the now-playing bar showed the
 * new one's answer for the same artwork. On a cover the average handles
 * badly — near-black with a small bright region, say — the two disagree
 * completely: the engine finds the colour that's actually in the sleeve, the
 * average finds a muddy blue that appears nowhere in it.
 *
 * `barSource` and not `bar`: source is the colour before readability work,
 * and bar is that colour already finished for a thin strip behind small
 * text. A page is a large field with different needs, so it takes the raw
 * source and lets pageWash() do the readability pass for its own context.
 * Painting `bar` here would treat the same colour twice.
 *
 * The old chain stays as fallback for themes with no perceptual result.
 * One function, so a card and the page it opens can't drift apart again.
 */
export function recordWashSource(theme) {
  if (!theme) return null;
  return theme.barSource || theme.dominant || theme.mid || theme.accent || null;
}

/**
 * The dark base a record page's wash sits on.
 *
 * This has to come from the SAME source as the wash, and previously didn't.
 * The page paints `rgba(wash, 0.28–0.85)` over `rgba(deep, 0.72)`, and deep
 * was read straight off `theme.wash` — the old averaging engine's dark tone.
 * So once the top of the gradient moved to the perceptual engine, the page
 * was a blend of two engines' hues, and the further down you looked the more
 * the old one showed through: wash falls to 0.28 alpha by the bottom, so
 * deep is most of what you see there. A near-black sleeve averaging to navy
 * put a navy field under the whole page no matter what the engine said.
 *
 * Lightness is clamped hard and chroma softly: this is a floor for other
 * colour to sit on, so it should carry the record's hue without competing
 * with the artwork or hurting text contrast.
 */
export function recordDeep(theme, fallback = '10, 10, 14') {
  const src = recordWashSource(theme);
  if (!src) return fallback;
  const p = String(src).split(',').map((n) => parseInt(n.trim(), 10));
  if (p.length < 3 || p.some((n) => !Number.isFinite(n))) return fallback;
  const [L, C, h] = oklabToLch(rgbToOklab(p[0], p[1], p[2]));
  return oklchToRgb(Math.min(L, 0.24), Math.min(C, 0.055), h).join(', ');
}

/** Average-color theme from cover art for gradients (renderer-safe). */
export function sampleCoverTheme(src) {
  const fallback = { accent: '48, 48, 48', wash: '10, 10, 10', mid: '12, 12, 12', deep: '0, 0, 0' };
  return new Promise((resolve) => {
    if (!src) {
      resolve(fallback);
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        /* 64x64, matching the tuning lab exactly. It sampled at 64 while the
           renderer used 56 and the main process 48 — three different pictures
           of the same cover, which is why a colour chosen in the lab did not
           appear in the app's list at all. Clusters are sensitive to this:
           a small vivid region survives at 64 and is averaged away at 48. */
        /* 96, up from 64. Clustering is sensitive to the grid: a small vivid
           region — a logo, a jacket, a stripe of sky — survives at 96 and is
           averaged into its surroundings at 64. The whole pipeline costs
           about 3ms at this size, so the old resolution was buying nothing.
           Anything that reads the sampler must use this same size, or two
           runs are looking at different pictures of one cover. */
        const w = 96;
        const h = 96;
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(fallback);
          return;
        }
        /* Nearest-neighbour, matching the main process byte for byte.
           Two reasons. Smoothing INVENTS colours: average a red pixel against
           a blue one and you get a purple that appears nowhere in the artwork,
           and at a boundary-heavy sleeve those invented values are numerous
           enough to form clusters of their own. And the main process samples
           by fixed stride, so any smoothing here guarantees the two sides
           disagree about what the cover looks like — which is exactly the
           failure the comments in main.js record. Picking real pixels at a
           fixed stride is the one downsample two runtimes can agree on. */
        ctx.imageSmoothingEnabled = false;
        /* What was actually sampled, and at what size.
           Two runs can execute identical code and still disagree if they were
           handed different pictures — a 640px CDN jpg and a 300px embedded
           thumbnail of the same artwork downscale to different 64x64 grids.
           This makes that visible instead of leaving it to be inferred. */
        try {
          console.info('[coverTheme] sampled', `${img.naturalWidth}x${img.naturalHeight}`,
            String(src).slice(0, 90));
        } catch { /* logging is never worth failing a sample over */ }
        ctx.drawImage(img, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);
        const samples = [];
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 30) continue;
          samples.push([data[i], data[i + 1], data[i + 2]]);
        }
        if (!samples.length) {
          resolve(fallback);
          return;
        }
        resolve(themeFromAnalysis({
          ...analyzeSamples(samples),
          perceptual: analyseCover(samples),
        }));
      } catch {
        resolve(fallback);
      }
    };
    img.onerror = () => resolve(fallback);
    img.src = src;
  });
}

/* ---------------------------------------------------------------------------
 *  Colour helpers.
 *
 *  These lived in StudioHome.jsx, which made them unreachable from any other
 *  file — the artist page needed all three and copying them would have meant
 *  two colour systems that only resemble each other. They belong beside the
 *  sampler that feeds them.
 * ------------------------------------------------------------------------- */

/** Lift a sampled accent until it reads as text on a dark surface. */
export function readableAccent(accent, minLum = 165) {
  const parts = String(accent || '').split(',').map((s) => parseInt(s.trim(), 10));
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return accent || '150, 150, 150';
  let [r, g, b] = parts;
  const lum = () => 0.299 * r + 0.587 * g + 0.114 * b;
  let guard = 0;
  while (lum() < minLum && guard < 24) { r += (255 - r) * 0.16; g += (255 - g) * 0.16; b += (255 - b) * 0.16; guard += 1; }
  return `${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}`;
}

/** Black or white, whichever reads on top of the given "r, g, b" background. */
export function accentTextColor(accent) {
  const p = String(accent || '').split(',').map((s) => parseInt(s.trim(), 10));
  if (p.length < 3 || p.some((n) => !Number.isFinite(n))) return '#fff';
  return (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) > 165 ? '#0b0b0c' : '#fff';
}

/**
 * Clamp a sampled tone into a page-background wash.
 *
 * Saturation is amplified and lightness pinned, so every record page gets a
 * field of roughly equal weight no matter how dark or washed-out its artwork
 * is. Achromatic art keeps its neutrality — boosting saturation there would
 * invent a hue the cover doesn't have.
 */
/* ---------------------------------------------------------------------------
 *  Colour intensity.
 *
 *  Every number in this file assumes the display shows sRGB as sRGB. A monitor
 *  with a vibrancy or saturation boost does not: it stretches chroma away from
 *  the grey axis, so a surface capped at 0.72 saturation arrives fully clipped
 *  at 1.0, and the faint-text contrast this file works to protect falls by
 *  about a fifth — 3.16 becomes 2.50, under the bar.
 *
 *  Luminance moves much less than chroma under that transform, which is why
 *  the contrast clamp still does most of its job. What it can't do is know
 *  about the monitor, so the ceiling is a setting rather than a guess.
 * ------------------------------------------------------------------------- */
let SATURATION_CAP = 0.56;
let FAINT_TARGET = 3.3;

/**
 * 'muted' | 'balanced' | 'vivid'.
 *
 * Two dials move together, because capping saturation alone doesn't do it:
 * even at 0.24 the worst of six test covers only reached 2.91 once a boosted
 * display had stretched it. A boost shifts luminance a little as well as
 * chroma a lot, so the reliable lever is to darken further — the target ratio
 * is what buys that margin, and the cap keeps the colour from arriving clipped.
 */
/** @param {'off'|'muted'|'balanced'|'vivid'|'full'} level */
export function setColourIntensity(level) {
  /* 'full' is the Spotify-like end of the scale.
     Measured against their album header — about rgb(125, 135, 148) for a pale
     sleeve — Spotify holds roughly 3.6:1 for solid white and 1.9:1 for faint
     text. They don't guarantee faint-text readability at all; they set that
     type heavy and solid instead. Matching their brightness means adopting
     that trade knowingly, so it's the top of the scale rather than the
     default, and secondary lines will be harder to read on it. */
  /* 'off' drains the colour entirely: surfaces still take their LIGHTNESS
     from the sleeve, so a dark record still gives a dark page, but the hue is
     gone. That's different from turning a surface off, which removes the
     cover's influence altogether — here the layout keeps reacting to the
     artwork, just in greyscale. */
  if (level === 'off') { SATURATION_CAP = 0; FAINT_TARGET = 4.5; return; }
  if (level === 'full') { SATURATION_CAP = 0.80; FAINT_TARGET = 1.9; return; }
  if (level === 'vivid') { SATURATION_CAP = 0.72; FAINT_TARGET = 3.1; return; }
  if (level === 'muted') { SATURATION_CAP = 0.30; FAINT_TARGET = 4.1; return; }
  SATURATION_CAP = 0.56; FAINT_TARGET = 3.3;
}

/** Relative luminance, per WCAG. */
function relLuminance([r, g, b]) {
  const f = (v) => { const u = v / 255; return u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Contrast ratio between two rgb triples, 1 (identical) to 21 (black/white). */
function contrastRatio(a, b) {
  const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Turn a colour taken from artwork into a surface you can put text on.
 *
 * The old rule pinned every surface to exactly 30% lightness and forced
 * saturation into a 34-62% band. That made everything the same muddy weight —
 * a pale sleeve and a deep one produced near-identical surfaces — and it read
 * anything under 8% saturation as "no colour" and dropped it to near-black,
 * which is how black-and-white and softly-tinted covers ended up as holes in
 * the page.
 *
 * This keeps the colour's OWN lightness and saturation and only darkens it as
 * far as it has to for text to stay readable against it. A deep blue barely
 * moves; a bright yellow moves a lot, because white text on yellow needs it
 * to. Bright covers stay bright — just not so bright that the app stops
 * working.
 *
 * The contrast it holds is measured against DIMMED text, not full-strength
 * white. Studio sets secondary lines, timestamps and inactive lyrics at around
 * 45% alpha, and white at 45% over a bright surface is barely lighter than the
 * surface — a magenta that cleared 5.3:1 for solid white left those lines at
 * 2.1:1, which is why a hot pink panel was unreadable while the headline on it
 * looked fine.
 *
 * @param rgbStr   "r, g, b" sampled from artwork
 * @param textRgb  the text that will sit on it, default white
 * @param minRatio contrast the FAINTEST text must hold; defaults to the
 *                 current colour-intensity target
 */
export function pageWash(rgbStr, textRgb = [255, 255, 255], minRatio = null) {
  const p = String(rgbStr || '').split(',').map((n) => parseInt(n.trim(), 10));
  if (p.length < 3 || p.some((n) => !Number.isFinite(n))) return '18, 18, 24';

  const [h, s0, l0] = (() => {
    const [r, g, b] = p.map((n) => n / 255);
    const mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
    const l = (mx + mn) / 2; const d = mx - mn;
    let hh = 0;
    const ss = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (d !== 0) {
      if (mx === r) hh = ((g - b) / d) % 6;
      else if (mx === g) hh = (b - r) / d + 2;
      else hh = (r - g) / d + 4;
      hh *= 60; if (hh < 0) hh += 360;
    }
    return [hh, ss, l];
  })();

  const toRgb = (hh, ss, ll) => {
    const c = (1 - Math.abs(2 * ll - 1)) * ss;
    const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
    const m = ll - c / 2;
    let v;
    if (hh < 60) v = [c, x, 0]; else if (hh < 120) v = [x, c, 0];
    else if (hh < 180) v = [0, c, x]; else if (hh < 240) v = [0, x, c];
    else if (hh < 300) v = [x, 0, c]; else v = [c, 0, x];
    return v.map((u) => Math.round((u + m) * 255));
  };

  /* A floor under saturation so a faintly-tinted sample keeps its tint rather
     than being declared colourless — but NOT for something genuinely neutral.
     Below 6% there is no hue to preserve, only rounding noise, and lifting
     that turned a black-and-white sleeve into olive. Grey artwork gets a grey
     surface; that's the honest answer. */
  const s = s0 < 0.06 ? 0 : Math.min(SATURATION_CAP, Math.max(s0, Math.min(0.14, SATURATION_CAP)));
  let l = Math.max(l0, 0.16);

  /* The faintest text Studio puts on a coloured surface. Anything readable at
     this alpha is readable at every heavier one. */
  const FAINT_ALPHA = 0.45;
  const target = minRatio ?? FAINT_TARGET;
  const faintOn = (surface) => surface.map((v, i) => Math.round(textRgb[i] * FAINT_ALPHA + v * (1 - FAINT_ALPHA)));

  // Walk the lightness down until even the faintest text separates from it.
  for (let i = 0; i < 90 && l > 0.04; i += 1) {
    const surface = toRgb(h, s, l);
    if (contrastRatio(faintOn(surface), surface) >= target) break;
    l -= 0.012;
  }
  return toRgb(h, s, l).join(', ');
}

/* ---------------------------------------------------------------------------
 *  The now-playing bar surface.
 *
 *  Spotify does not take a colour's lightness from the artwork. Measured on
 *  seven covers, the cluster their bar lands on sits at lightness 0.16-0.40,
 *  centred near 0.25 — and ranks 15th to 23rd out of 24 by how much of the
 *  cover it occupies. They are selecting a dark, usually SMALL region, not a
 *  prominent one. Fitting the selection directly gave the population term a
 *  weight of exactly zero.
 *
 *  Reproducing that by selection is fragile: it needs a suitable dark cluster
 *  to exist. Taking the dominant hue — which already matches Spotify's to 3.3
 *  degrees — and pinning lightness gets the same answer without the dependency.
 *
 *  Mean error per channel against Spotify, on covers where Studio's own picker
 *  values were read from the real files:
 *
 *      Auto, as it shipped                76.6
 *      dominant, raw                      69.9
 *      dominant + pinned lightness        21.1
 *      dominant + cap 0.60 + pinned       20.1   <- this
 *
 *  The cap is a guard, not a fitted value: it only binds on Brain Fog, where
 *  it's worth 5.7. Saturation is otherwise passed straight through, because it
 *  genuinely tracks the artwork — Spotify's runs 0.00 to 0.81 across this set.
 *
 *  KNOWN GAP. The residual error is almost entirely saturation, and it is
 *  concentrated in two covers. Weep: dominant says 0.45, Spotify says 0.054 —
 *  analyzeSamples keeps only pixels above sat 0.16 and then averages the vivid
 *  end of each hue bucket, which manufactures chroma on a washed-out cover.
 *  Holding: dominant says 0.646, Spotify says 0.812, the other way. That vivid-
 *  end averaging is the next thing to fix; it is a bug, not a knob.
 * ------------------------------------------------------------------------- */

/* Seven covers is thin for a constant. 0.24 and 0.28 scored 21.1 and 21.0 —
   indistinguishable — so this sits at the darker end of a flat minimum rather
   than on a sharp one. Expect it to move once there are twenty covers. */
/* The old fixed-lightness constants, kept only as documentation of what
   changed. barTone() no longer pins lightness — see coverColour.js.

   const BAR_LIGHTNESS = 0.24;  // every cover arrived here, whatever it was
   const BAR_SAT_CAP = 0.60;

   Pinning made the bar carry one bit of information: the hue. A charcoal
   sleeve and a pastel one produced bars of identical weight, and measured
   with APCA that 0.24 sat near Lc 100 while body text needs Lc 75 — so every
   cover was darkened well past the point where anything was gained. */

/**
 * Finish a colour for the now-playing bar and the docked panel.
 *
 * Delegates to the perceptual engine: chroma capped against neon, dark
 * yellow-greens rotated to amber, and lightness lowered only as far as APCA
 * says the white label needs. A colour already dark enough passes through
 * essentially untouched.
 */
export function barTone(rgbStr) {
  const p = String(rgbStr || '').split(',').map((n) => parseInt(n.trim(), 10));
  if (p.length < 3 || p.some((n) => !Number.isFinite(n))) return '18, 18, 24';
  return toBarColour(p).rgb.join(', ');
}

/* How much lighter the library page sits than the chrome under it.
   In OKLab, so the lift is perceptually even across hues — the same numeric
   step looks like the same step whether the colour is yellow or blue, which
   an HSL lift does not manage.

   A LIFT rather than a fixed target: pick something dark and the page stays
   dark, pick something bright and it opens up. A constant would flatten every
   cover to one page tone, which is the mistake the bar used to make. */
const PAGE_LIFT = 0.14;
const PAGE_LIGHTNESS_MAX = 0.92;

/**
 * The page tone that belongs under a given bar colour.
 *
 * Hue and chroma are left alone: those carry whatever the cover, or the
 * person using the picker, actually chose. Only lightness moves.
 */
export function pageTone(rgbStr) {
  const p = String(rgbStr || '').split(',').map((n) => parseInt(n.trim(), 10));
  if (p.length < 3 || p.some((n) => !Number.isFinite(n))) return '18, 18, 24';
  const [L, C, h] = oklabToLch(rgbToOklab(p[0], p[1], p[2]));
  return oklchToRgb(Math.min(PAGE_LIGHTNESS_MAX, L + PAGE_LIFT), C, h).join(', ');
}


/**
 * Did a sample actually read an image, or is this the give-up value?
 *
 * sampleCoverTheme resolves its neutral fallback for every failure — bad URL,
 * blocked request, tainted canvas — and that fallback is a legitimate-looking
 * theme. Callers stored it like any other, so ONE failed read repainted a card
 * near-black and it stayed that way. A caller that can tell the difference can
 * keep the colour it already had.
 */
export function isFallbackTheme(theme) {
  return !theme || (theme.mid === '12, 12, 12' && theme.wash === '10, 10, 10');
}

/**
 * Sample a theme from any image, without the canvas CORS trap.
 *
 * The renderer path taints on remote images in a way that depends on FETCH
 * ORDER, not on the image: a card paints the photo as a CSS background first,
 * that response is cached without CORS approval, and the later
 * `crossOrigin="anonymous"` request reuses the same cache entry — so
 * getImageData throws and the theme silently degrades to neutral grey. Restart
 * the app and the cache now holds the anonymous response, so the identical
 * code works. First run wrong, every run after right, which is the worst way
 * for a bug to behave.
 *
 * So remote images are sampled in the main process, where CORS doesn't exist.
 * Local schemes keep the canvas path — it has no such problem and needs no
 * round trip.
 */
export async function sampleImageTheme(src) {
  const url = String(src || '');
  if (!url) return sampleCoverTheme(null);
  /* Only REMOTE images go to the main process.
     Main decodes with nativeImage, whose resampling kernel is not Chromium's
     canvas kernel and never will be — so a cover sampled there can't produce
     the same pixels, and therefore can't produce the same colour, as the
     tuning lab. Covers are local (studio-cover:// or data:) and now sample in
     the renderer on the same canvas the lab uses, which is what makes the hex
     codes agree. Remote artist portraits still go to main, where the CORS
     cache race that path exists to avoid is a real risk and exact parity with
     the lab is not needed. */
  const remote = /^https?:/i.test(url);
  const bridge = typeof window !== 'undefined' ? window.electronAPI : null;
  if (remote && bridge?.sampleImageTheme) {
    try {
      const res = await bridge.sampleImageTheme(url);
      if (res?.ok && res.theme) return res.theme;
    } catch { /* fall through to the canvas path */ }
  }
  return sampleCoverTheme(url);
}
