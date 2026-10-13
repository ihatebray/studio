/* Where a cover's subject sits, left to right, so a page that shows a narrow
 * slice of a square cover (Poster) can show the slice with the subject in it
 * instead of always the middle.
 *
 * Faces win when the system can find them (Chromium's FaceDetector, where it
 * exists). Otherwise each column of a small copy of the cover is scored by
 * how much is going on in it: edges, and color that stands out from the
 * cover's average. The page then picks the slice with the most in it, with a
 * pull toward the middle so a cover with nothing in particular stays centered.
 *
 * Results are kept per cover for the session.
 */

const N = 48;
const cache = new Map(); // src → Promise<profile | null>

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/* Faces, as weights per column (0..1 across), or null. */
async function faceColumns(img) {
  const FD = typeof window !== 'undefined' ? window.FaceDetector : undefined;
  if (typeof FD !== 'function') return null;
  try {
    const faces = await new FD({ fastMode: true, maxDetectedFaces: 4 }).detect(img);
    if (!faces?.length) return null;
    const w = img.naturalWidth || 1;
    const cols = new Float32Array(N);
    for (const f of faces) {
      const b = f.boundingBox;
      // Weight by size: the big face is the subject.
      const weight = b.width * b.height;
      const from = Math.max(0, Math.floor((b.x / w) * N));
      const to = Math.min(N - 1, Math.ceil(((b.x + b.width) / w) * N));
      for (let x = from; x <= to; x++) cols[x] += weight;
    }
    return cols;
  } catch {
    return null;
  }
}

function interestColumns(img) {
  const c = document.createElement('canvas');
  c.width = N; c.height = N;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, N, N);
  let d;
  try { d = ctx.getImageData(0, 0, N, N).data; } catch { return null; }
  const L = new Float32Array(N * N);
  let mr = 0; let mg = 0; let mb = 0;
  for (let i = 0; i < N * N; i++) {
    const r = d[i * 4]; const g = d[i * 4 + 1]; const b = d[i * 4 + 2];
    L[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    mr += r; mg += g; mb += b;
  }
  mr /= N * N; mg /= N * N; mb /= N * N;
  const cols = new Float32Array(N);
  // The band the title sits on (the bottom ~40%): how bright and how busy
  // each column of it is, so the page can shade it as much as it needs.
  const lumCols = new Float32Array(N);
  const busyCols = new Float32Array(N);
  const bandFrom = Math.floor(N * 0.58);
  for (let y = 1; y < N - 1; y++) {
    // The bottom quarter sits under the title and the fade: it counts less.
    const rowW = y > N * 0.75 ? 0.4 : 1;
    for (let x = 1; x < N - 1; x++) {
      const i = y * N + x;
      const edge = Math.abs(L[i + 1] - L[i - 1]) + Math.abs(L[i + N] - L[i - N]);
      const dr = d[i * 4] - mr; const dg = d[i * 4 + 1] - mg; const db = d[i * 4 + 2] - mb;
      const stand = Math.sqrt(dr * dr + dg * dg + db * db);
      cols[x] += (edge * 0.6 + stand * 0.4) * rowW;
      if (y >= bandFrom) { lumCols[x] += L[i] / 255; busyCols[x] += edge; }
    }
  }
  const rows = N - 1 - bandFrom;
  for (let x = 0; x < N; x++) { lumCols[x] /= rows; busyCols[x] /= rows; }
  return { cols, lumCols, busyCols };
}

/** A cover's reading: `cols`, per-column interest (faces dominating), and
 *  `lumCols` / `busyCols`, the brightness (0..1) and detail of the bottom
 *  band per column. Null if the cover can't be read. */
export function coverProfile(src) {
  if (!src) return Promise.resolve(null);
  if (cache.has(src)) return cache.get(src);
  const p = (async () => {
    const img = await loadImage(src);
    if (!img) return null;
    const read = interestColumns(img);
    if (!read) return null;
    const base = read.cols;
    const faces = await faceColumns(img);
    if (!faces) return read;
    // A face outweighs everything else on the cover.
    let bt = 0; let ft = 0;
    for (let x = 0; x < N; x++) { bt += base[x]; ft += faces[x]; }
    const cols = new Float32Array(N);
    for (let x = 0; x < N; x++) cols[x] = base[x] / (bt || 1) + 3 * (faces[x] / (ft || 1));
    return { ...read, cols };
  })();
  cache.set(src, p);
  return p;
}

/**
 * Where to put a slice `visible` wide (a share of the cover's width, 0..1),
 * as a CSS object-position x (0..100). 50 when the whole cover fits, when
 * there's no profile, or when nothing on the cover stands out.
 */
export function slicePosition(reading, visible) {
  const profile = reading?.cols;
  if (!profile || !(visible > 0) || visible >= 0.98) return 50;
  const n = profile.length;
  const win = Math.max(1, Math.round(visible * n));
  let total = 0;
  for (let x = 0; x < n; x++) total += profile[x];
  if (!total) return 50;
  let best = 50; let bestScore = -Infinity;
  for (let s = 0; s + win <= n; s++) {
    let sum = 0;
    for (let x = s; x < s + win; x++) sum += profile[x];
    const center = (s + win / 2) / n;
    /* The pull toward the middle, scaled to how far this slice can move: going
       all the way to an edge has to win at least 8% more of the cover's
       interest, however narrow or wide the column. */
    const reach = Math.max(1e-3, (n - win) / (2 * n));
    const score = sum / total - 0.08 * (Math.abs(center - 0.5) / reach);
    if (score > bestScore) { bestScore = score; best = n - win > 0 ? (s / (n - win)) * 100 : 50; }
  }
  return Math.round(best);
}

/**
 * How much shade the title needs, 0..1, for the part of the cover from `from`
 * to `to` (shares of its width): more on a bright band, a little more on a
 * busy one, little on a dark, calm one. Null without a reading.
 */
export function titleShade(reading, from, to) {
  if (!reading?.lumCols) return null;
  const n = reading.lumCols.length;
  const a = Math.max(0, Math.min(n - 1, Math.floor(from * n)));
  const b = Math.max(a + 1, Math.min(n, Math.ceil(to * n)));
  let lum = 0; let busy = 0;
  for (let x = a; x < b; x++) { lum += reading.lumCols[x]; busy += reading.busyCols[x]; }
  lum /= b - a; busy /= b - a;
  const bright = Math.max(0, Math.min(1, (lum - 0.18) / 0.55));
  const detail = Math.max(0, Math.min(1, busy / 45));
  return Math.max(0.12, Math.min(0.72, 0.12 + 0.48 * bright + 0.16 * detail));
}
