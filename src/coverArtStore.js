import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { app, net } from 'electron';

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
      const res = await net.fetch(u);
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

