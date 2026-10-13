import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { app, net, nativeImage } from 'electron';
import { hiResCover } from '../lib/coverUrl.js';

const COVER_DIR_NAME = 'cover-cache';

/** Absolute path to the cover-cache directory, created lazily on first use. */
function coverDir() {
  const dir = path.join(app.getPath('userData'), COVER_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Map a data-URI mime type to a file extension. */
function extForMime(mime) {
  const m = (mime || '').toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg';
  if (m === 'image/png') return '.png';
  if (m === 'image/webp') return '.webp';
  if (m === 'image/gif') return '.gif';
  if (m === 'image/avif') return '.avif';
  return '.bin';
}

/**
 * Persist a data URI to disk and return its canonical `studio-cover://...` URL.
 * If the input is already a URL (http/https or studio-cover), it's returned as-is.
 * If the input is null/empty, returns null.
 *
 * Files are named by sha1 of their bytes so identical images dedupe automatically.
 */
export function storeCoverFromDataUri(input) {
  if (input == null || input === '') return null;
  if (typeof input !== 'string') return null;

  const u = input.trim();
  if (!u) return null;

  // Already a URL — pass through unchanged
  if (/^https?:\/\//i.test(u)) return u.slice(0, 2048);
  if (u.startsWith('studio-cover://')) return u;

  // Data URI — decode and persist
  if (u.startsWith('data:image/')) {
    const m = /^data:([^;]+);base64,(.+)$/i.exec(u);
    if (!m) return null;
    const mime = m[1];
    const b64 = m[2];
    let buf;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      return null;
    }
    if (!buf || buf.length === 0) return null;

    // Hash-based filename so duplicate uploads dedupe. storeBytes is shared
    // with the remote-mirror path below, so the same JPEG arriving as an
    // embedded tag and as a CDN download lands on ONE filename.
    return storeBytes(buf, extForMime(mime));
  }

  return null;
}

/** Resolve a studio-cover://... URL to the on-disk file. Returns null if invalid. */
export function resolveCoverFilePath(url) {
  if (typeof url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'studio-cover:') return null;
  // Strip leading /
  const rel = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  // Sanitize — no path traversal
  if (!rel || rel.includes('..') || rel.includes('/') || rel.includes('\\')) return null;
  const full = path.join(coverDir(), rel);
  return full;
}

/** MIME type lookup from filename extension, for the HTTP response. */
export function mimeForCoverPath(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.avif') return 'image/avif';
  return 'application/octet-stream';
}

/* =============================================================================
 * Remote covers.
 *
 * An in-app download keeps its cover as the CDN URL it came from
 * (https://i.scdn.co/image/...), while a local file's embedded art gets
 * content-addressed to studio-cover://local/<sha1>. Two names, one picture —
 * and everything downstream that keys on the URL therefore believes it is
 * looking at two different records: the theme sampler samples twice, the
 * per-cover colour override stores twice, the now-playing wash re-derives.
 * Crossing between them mid-playback shows as the colour under the artwork
 * shifting, which reads as the cover itself flickering.
 *
 * Mirroring remote covers into the same store collapses that. The filename is
 * the sha1 of the bytes, so a downloaded track and a local file carrying the
 * SAME image resolve to the SAME URL — byte-identical art becomes literally
 * one identity, not two that happen to look alike.
 *
 * It also means covers survive offline and CDN rotation, which the remote URL
 * did not.
 * ========================================================================== */

const REMOTE_MAP_FILE = 'remote-cover-map.json';

let remoteMapLoaded = false;
let remoteMap = {}; // remote URL → studio-cover:// URL (or '' for a known failure)

function remoteMapPath() {
  return path.join(app.getPath('userData'), REMOTE_MAP_FILE);
}

function loadRemoteMap() {
  if (remoteMapLoaded) return;
  remoteMapLoaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(remoteMapPath(), 'utf8'));
    if (parsed && typeof parsed === 'object') remoteMap = parsed;
  } catch {
    remoteMap = {};
  }
}

let remoteMapDirty = false;
let remoteMapTimer = null;
function persistRemoteMap() {
  originalSizes = null; // the map changed: rebuild the reverse lookup when next asked
  remoteMapDirty = true;
  if (remoteMapTimer) return;
  // Coalesced: a folder import can mirror hundreds of covers, and writing the
  // map once per cover would be hundreds of synchronous writes for no gain.
  remoteMapTimer = setTimeout(() => {
    remoteMapTimer = null;
    if (!remoteMapDirty) return;
    remoteMapDirty = false;
    try { fs.writeFileSync(remoteMapPath(), JSON.stringify(remoteMap), 'utf8'); }
    catch { /* best-effort */ }
  }, 400);
  if (remoteMapTimer.unref) remoteMapTimer.unref();
}

/** Extension from a Content-Type header, falling back to the URL's own suffix. */
function extForResponse(contentType, url) {
  const byMime = extForMime((contentType || '').split(';')[0].trim());
  if (byMime !== '.bin') return byMime;
  const m = /\.(jpe?g|png|webp|gif|avif)(?:\?|$)/i.exec(url);
  if (m) return `.${m[1].toLowerCase().replace('jpeg', 'jpg')}`;
  // Spotify's image CDN serves JPEG with no extension in the path.
  return '.jpg';
}

/** Write bytes into the store under their own sha1. Shared with the data: path. */
function storeBytes(buf, ext) {
  if (!buf || buf.length === 0) return null;
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20);
  const filename = `${hash}${ext}`;
  const full = path.join(coverDir(), filename);
  try {
    if (!fs.existsSync(full)) fs.writeFileSync(full, buf);
  } catch (e) {
    console.error('coverArtStore: write failed', e);
    return null;
  }
  return `studio-cover://local/${encodeURIComponent(filename)}`;
}

/** Deduplicate concurrent mirrors of the same remote URL. */
const remoteInFlight = new Map();

/**
 * Fetch a remote cover once and return its canonical studio-cover:// URL.
 *
 * Returns the ORIGINAL url on any failure rather than null — a cover that
 * can't be mirrored right now should still display, and the next import gets
 * another go. Only hard rejections (non-image, oversized) are remembered.
 */
export async function storeCoverFromUrl(url) {
  if (typeof url !== 'string') return url;
  const u = url.trim();
  if (!u || !/^https?:\/\//i.test(u)) return url;

  loadRemoteMap();
  const known = remoteMap[u];
  if (typeof known === 'string') {
    if (!known) return url;              // known failure — don't retry this session
    // Guard against a cache-cache entry whose file has since been deleted.
    const p = resolveCoverFilePath(known);
    if (p && fs.existsSync(p)) return known;
    delete remoteMap[u];
  }

  if (remoteInFlight.has(u)) return remoteInFlight.get(u);

  const job = (async () => {
    try {
      /* The CDN's largest copy of the picture when it has one (Spotify search
         rows carry the 300 or 640px one), so a cover shown big is sharp. */
      const big = hiResCover(u);
      let res = big !== u ? await net.fetch(big).catch(() => null) : null;
      if (!res || !res.ok) res = await net.fetch(u);
      if (!res.ok) return url;
      const type = res.headers.get('content-type') || '';
      if (type && !/^image\//i.test(type)) { remoteMap[u] = ''; persistRemoteMap(); return url; }
      const buf = Buffer.from(await res.arrayBuffer());
      // 24MB ceiling — album art is never this big, and a mis-resolved URL
      // pointing at something enormous shouldn't sit in the cover cache.
      if (!buf.length || buf.length > 24 * 1024 * 1024) { remoteMap[u] = ''; persistRemoteMap(); return url; }
      const stored = storeBytes(buf, extForResponse(type, u));
      if (!stored) return url;
      remoteMap[u] = stored;
      persistRemoteMap();
      return stored;
    } catch {
      return url; // offline, DNS, cert — transient, so no negative caching
    } finally {
      remoteInFlight.delete(u);
    }
  })();

  remoteInFlight.set(u, job);
  return job;
}


/* =============================================================================
 * Upgrading covers mirrored small.
 *
 * Covers mirrored before the change above were saved at whatever size the
 * CDN link asked for, often 300 or 640px, and a record page shows them far
 * bigger than that. Each one whose CDN has a larger copy is fetched again and
 * written over the SAME file, so its studio-cover:// address doesn't change:
 * album pins, colour picks and everything else keyed on it keep working, and
 * the picture is simply sharper. One at a time in the background, once each
 * (remembered in hires-covers.json); an offline launch tries again next time.
 * ========================================================================== */
const UPGRADED_FILE = 'hires-covers.json';

export async function upgradeMirroredCovers() {
  loadRemoteMap();
  const donePath = path.join(app.getPath('userData'), UPGRADED_FILE);
  let done = {};
  try { done = JSON.parse(fs.readFileSync(donePath, 'utf8')) || {}; } catch { done = {}; }
  const todo = [];
  const seen = new Set();
  for (const [remote, local] of Object.entries(remoteMap)) {
    if (!local || done[local] || seen.has(local) || hiResCover(remote) === remote) continue;
    seen.add(local);
    todo.push([remote, local]);
  }
  if (!todo.length) return;
  console.log(`[cover hires] upgrading ${todo.length} cover(s)…`);
  let upgraded = 0;
  let sinceSave = 0;
  const save = () => { try { fs.writeFileSync(donePath, JSON.stringify(done), 'utf8'); } catch { /* next run */ } };
  for (const [remote, local] of todo) {
    const file = resolveCoverFilePath(local);
    if (!file || !fs.existsSync(file)) continue;
    try {
      const res = await net.fetch(hiResCover(remote));
      const type = res.headers.get('content-type') || '';
      if (!res.ok || (type && !/^image\//i.test(type))) {
        done[local] = 'none'; // the CDN has nothing bigger
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > fs.statSync(file).size && buf.length < 24 * 1024 * 1024) {
          const tmp = `${file}.hires`;
          fs.writeFileSync(tmp, buf);
          fs.renameSync(tmp, file);
          upgraded += 1;
        }
        done[local] = 'done';
      }
    } catch {
      break; // offline: the rest wait for the next launch
    }
    if (++sinceSave >= 20) { save(); sinceSave = 0; }
    await new Promise((r) => setTimeout(r, 150));
  }
  save();
  console.log(`[cover hires] done: ${upgraded} upgraded`);
}

/* =============================================================================
 * The size a cover's colors are read at.
 *
 * Cover palettes are worked out from a small grid of the picture's own pixels
 * (coverTheme.js), so the same artwork at 640px and at 2000px can give
 * different colors: a detailed cover at 2000px offers different pixels to the
 * grid and can land on another main color. Covers saved from Spotify or
 * iTunes used to be the 300 or 640px copy, and their colors were read from
 * that; now they're the large copy (for sharpness), so their colors moved.
 *
 * So colors are read from the cover at the size it was first saved at:
 * `?for=color` on a studio-cover:// address asks for that copy, made once
 * from the large file and kept beside it. Covers that were always this size
 * (your own files' art) are served as they are.
 * ========================================================================== */
const SPOTIFY_SIZES = { '00001e02': 300, '0000b273': 640, '00004851': 64 };
function originalSizeOf(remote) {
  const sp = /i\.scdn\.co\/image\/ab67616d([0-9a-f]{8})/i.exec(remote);
  if (sp) return SPOTIFY_SIZES[sp[1].toLowerCase()] || 0;
  const it = /\/(\d+)x\d+bb\.(?:jpg|png|webp)$/i.exec(remote);
  return it ? Number(it[1]) : 0;
}
let originalSizes = null; // studio-cover:// address → the size it was first saved at
function originalSizeFor(local) {
  loadRemoteMap();
  if (!originalSizes) {
    originalSizes = new Map();
    for (const [remote, stored] of Object.entries(remoteMap)) {
      if (!stored) continue;
      const n = originalSizeOf(remote);
      if (n && (!originalSizes.has(stored) || n < originalSizes.get(stored))) originalSizes.set(stored, n);
    }
  }
  return originalSizes.get(local) || 0;
}

/** The file to read a cover's colors from (see above). */
export function colorFilePath(url) {
  const file = resolveCoverFilePath(url);
  if (!file) return null;
  const size = originalSizeFor(String(url).split('?')[0]);
  if (!size) return file;
  const out = `${file}.color.jpg`;
  try {
    const src = fs.statSync(file);
    if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= src.mtimeMs) return out;
    const img = nativeImage.createFromPath(file);
    const { width, height } = img.getSize();
    if (!width || width <= size * 1.1) return file; // never upgraded: already that size
    const small = img.resize({ width: size, height: Math.round((height / width) * size), quality: 'best' });
    fs.writeFileSync(out, small.toJPEG(92));
    return out;
  } catch {
    return file;
  }
}
