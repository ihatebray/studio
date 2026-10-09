/**
 * coverUploader.js — Discord RPC cover-art uploader (main process).
 *
 * Uploads local studio-cover:// art to imgbb so Discord's media proxy can
 * fetch a public URL. Discord's proxy fetches large_image server-side,
 * meaning file://, studio-cover://, and data: URIs are unreachable — only
 * public http(s) URLs work.
 *
 * Strategy:
 *   - Resolve studio-cover:// → on-disk file via coverArtStore
 *   - Upload to imgbb API with user-provided API key (free, no OAuth)
 *   - Cache result in userData/imgbb-cover-cache.json keyed by the
 *     sha1 hash baked into the filename, so identical art is never
 *     uploaded twice across restarts
 *   - Deduplicate concurrent uploads for the same image via in-flight Map
 *
 * imgbb API key: https://api.imgbb.com — sign up and copy the key shown
 * on the dashboard. No OAuth, no callback URL, just a plain string.
 *
 *   - Shrink to 512px JPEG first: Discord shows it small anyway, and a
 *     full-size cover (often several MB, a third bigger again as base64)
 *     made the upload, and so the cover on Discord, take a long time
 *
 * Failures:
 *   - Missing/invalid key    → returns null (falls back to immerse_logo)
 *   - Any failed upload      → not kept on disk; tried again a minute later
 *     (a failure used to be saved for good, so that cover never uploaded)
 *   - An upload that hangs   → given up on after 20 seconds
 */

import path from 'path';
import fs from 'fs';
import { app, nativeImage, net } from 'electron';
import { resolveCoverFilePath } from './coverArtStore.js';

const CACHE_FILE = 'imgbb-cover-cache.json';
const MAX_SIDE = 512;
const UPLOAD_TIMEOUT_MS = 20_000;
const RETRY_AFTER_MS = 60_000;
/* cacheKey → when it last failed (memory only), so a bad moment is retried
   soon, but not on every track change. */
const failedAt = new Map();

let cacheLoaded = false;
let cache = {};

function cacheFilePath() {
  return path.join(app.getPath('userData'), CACHE_FILE);
}

function loadCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = fs.readFileSync(cacheFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      // Failures saved by older versions ('') blocked those covers for good.
      cache = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string' && v));
    }
  } catch {
    cache = {};
  }
}

function persistCache() {
  try {
    fs.writeFileSync(cacheFilePath(), JSON.stringify(cache), 'utf8');
  } catch { /* ignore — best-effort */ }
}

/**
 * Extract the sha1 hash prefix from a studio-cover://local/<hash>.<ext> URL.
 * coverArtStore names files by sha1 of their bytes, making the hash a stable
 * content identity regardless of which track uses the art.
 */
function hashFromStudioUrl(url) {
  const m = /\/([a-f0-9]{20})\.[a-z]+$/i.exec(url);
  return m ? m[1] : null;
}

/** The cover as a JPEG at most MAX_SIDE across; the original when it's
 *  already small or isn't something nativeImage can read. */
function shrink(buf) {
  try {
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return buf;
    const { width, height } = img.getSize();
    const side = Math.max(width, height);
    if (side <= MAX_SIDE && buf.length < 300 * 1024) return buf;
    const scale = Math.min(1, MAX_SIDE / side);
    const out = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' }).toJPEG(88);
    return out.length ? out : buf;
  } catch {
    return buf;
  }
}

/** Deduplicate concurrent uploads — maps cacheKey → Promise<string|null>. */
const inFlight = new Map();

/**
 * Resolve a studio-cover:// URL to a public imgbb URL suitable for Discord RPC.
 *
 * @param {string} studioUrl  A studio-cover://local/<hash>.<ext> URL
 * @param {string} apiKey     imgbb API key
 * @returns {Promise<string|null>} Public https://i.ibb.co/... URL, or null
 */
export async function resolveForDiscord(studioUrl, apiKey) {
  if (!studioUrl || !studioUrl.startsWith('studio-cover://')) return null;
  if (!apiKey || !apiKey.trim()) return null;

  loadCache();

  const hash = hashFromStudioUrl(studioUrl);
  const cacheKey = hash || studioUrl;

  if (cache[cacheKey]) return cache[cacheKey];
  if (Date.now() - (failedAt.get(cacheKey) || 0) < RETRY_AFTER_MS) return null;

  // Already uploading — wait for the same promise instead of double-uploading
  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }

  const uploadPromise = (async () => {
    try {
      const filePath = resolveCoverFilePath(studioUrl);
      if (!filePath) { failedAt.set(cacheKey, Date.now()); return null; }

      let buf;
      try {
        buf = fs.readFileSync(filePath);
      } catch {
        // File unreadable — don't cache; might be transient
        return null;
      }
      if (!buf || buf.length === 0) { failedAt.set(cacheKey, Date.now()); return null; }
      buf = shrink(buf);

      // imgbb expects a URL-encoded POST body with the base64 image.
      // The API key goes in the query string.
      const body = new URLSearchParams();
      body.set('image', buf.toString('base64'));

      // The limit covers the whole exchange, the reply's body included.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), UPLOAD_TIMEOUT_MS);
      let json;
      try {
        const res = await net.fetch(
          `https://api.imgbb.com/1/upload?key=${encodeURIComponent(apiKey.trim())}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
            signal: abort.signal,
          },
        );
        try {
          json = await res.json();
        } catch (e) {
          if (abort.signal.aborted) throw e;
          console.log('[discord] imgbb response not JSON for', cacheKey);
          failedAt.set(cacheKey, Date.now());
          return null;
        }
      } finally {
        clearTimeout(timer);
      }

      if (json?.success && typeof json?.data?.url === 'string') {
        const url = json.data.url;
        cache[cacheKey] = url;
        failedAt.delete(cacheKey);
        persistCache();
        console.log(`[discord] imgbb upload OK: ${cacheKey} → ${url}`);
        return url;
      }

      console.log(`[discord] imgbb upload rejected for ${cacheKey}:`,
        JSON.stringify({ status: json?.status, error: json?.error }).slice(0, 200));
      failedAt.set(cacheKey, Date.now());
      return null;
    } catch (e) {
      console.log(`[discord] imgbb upload error for ${cacheKey}:`, String(e?.message || e));
      failedAt.set(cacheKey, Date.now());
      return null;
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, uploadPromise);
  return uploadPromise;
}
