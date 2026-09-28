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
 * Failures:
 *   - Missing/invalid key    → returns null (falls back to immerse_logo)
 *   - Network error          → not cached, retried on next play
 *   - imgbb error response   → cached as empty string, not retried until
 *     app restart, to avoid hammering the API on every track change
 */

import path from 'path';
import fs from 'fs';
import { app, net } from 'electron';
import { resolveCoverFilePath } from './coverArtStore.js';

const CACHE_FILE = 'imgbb-cover-cache.json';

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
    if (parsed && typeof parsed === 'object') cache = parsed;
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

  // Persistent cache hit — '' means a known failure (imgbb rejected it)
  if (cache[cacheKey] !== undefined) {
    return cache[cacheKey] || null;
  }

  // Already uploading — wait for the same promise instead of double-uploading
  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }

  const uploadPromise = (async () => {
    try {
      const filePath = resolveCoverFilePath(studioUrl);
      if (!filePath) {
        cache[cacheKey] = '';
        persistCache();
        return null;
      }

      let buf;
      try {
        buf = fs.readFileSync(filePath);
      } catch {
        // File unreadable — don't cache; might be transient
        return null;
      }
      if (!buf || buf.length === 0) {
        cache[cacheKey] = '';
        persistCache();
        return null;
      }

      // imgbb expects a URL-encoded POST body with the base64 image.
      // The API key goes in the query string.
      const body = new URLSearchParams();
      body.set('image', buf.toString('base64'));

      const res = await net.fetch(
        `https://api.imgbb.com/1/upload?key=${encodeURIComponent(apiKey.trim())}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        },
      );

      let json;
      try {
        json = await res.json();
      } catch {
        console.log('[discord] imgbb response not JSON for', cacheKey);
        return null;
      }

      if (json?.success && typeof json?.data?.url === 'string') {
        const url = json.data.url;
        cache[cacheKey] = url;
        persistCache();
        console.log(`[discord] imgbb upload OK: ${cacheKey} → ${url}`);
        return url;
      }

      // imgbb returned a structured error — cache as failure to avoid retry spam
      console.log(`[discord] imgbb upload rejected for ${cacheKey}:`,
        JSON.stringify({ status: json?.status, error: json?.error }).slice(0, 200));
      cache[cacheKey] = '';
      persistCache();
      return null;
    } catch (e) {
      // Network or unexpected error — don't cache so it can retry later
      console.log(`[discord] imgbb upload error for ${cacheKey}:`, String(e?.message || e));
      return null;
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, uploadPromise);
  return uploadPromise;
}
