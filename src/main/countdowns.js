/* =========================================================================
 *  studio — countdowns: albums on the way from artists followed in Studio
 *
 *  For each artist you follow in Studio: Spotify's pre-release (the album
 *  page that counts down to release day) and anything in their discography
 *  dated after today, from the artist overview Studio already reads for
 *  artist pages. Apple Music pre-orders already in the New Releases cache
 *  are added for the same artists, matched by name.
 *
 *  An overview is one request per artist, so answers are kept for six hours
 *  in a small JSON file and only stale artists are asked again, two at a
 *  time. A failed lookup keeps the last answer.
 * ========================================================================= */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { listFollows } from './follows.js';
import { artistUpcoming, artistUpcomingDiag, partnerState } from './spotifyPartner.js';
import { itunesSearchArtist, itunesGetArtistAlbums } from './itunesClient.js';
import { loadCachedReleases } from './libraryDb.js';

const TTL_MS = 6 * 60 * 60 * 1000;
/* Nothing found is asked again sooner: it may have been a bad moment. */
const EMPTY_TTL_MS = 30 * 60 * 1000;
/* Bumped when what's stored changes meaning; an older file is dropped. */
const VERSION = 4;
const file = () => path.join(app.getPath('userData'), 'studio-countdowns.json');

let store = null;
function load() {
  if (store) return store;
  try { store = JSON.parse(fs.readFileSync(file(), 'utf8')) || {}; } catch { store = {}; }
  if (store.__v !== VERSION) store = { __v: VERSION };
  return store;
}
function save() {
  try { fs.writeFileSync(file(), JSON.stringify(store)); } catch { /* ignore */ }
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const localDay = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let inflight = null;
async function refresh(force) {
  const spotify = partnerState().connected;
  const cache = load();
  const now = Date.now();
  const todo = listFollows().filter((f) => force || !cache[f.id]
    || now - cache[f.id].at > (cache[f.id].items?.length ? TTL_MS : EMPTY_TTL_MS));
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const f = todo[i++];
      const items = [];
      let answered = false;
      if (spotify) try {
        const found = await artistUpcoming(f.id);
        items.push(...found);
        answered = true;
        if (!found.length) console.log(`[countdowns] ${f.name}: nothing on Spotify. ${await artistUpcomingDiag(f.id).catch(() => '')}`);
      } catch (e) {
        console.warn('[countdowns]', f.name, 'Spotify:', String(e?.message || e));
      }
      /* Apple Music lists pre-orders with their release date, and isn't
         held to Spotify's rate limit. */
      let appleId = cache[f.id]?.appleId || null;
      try {
        if (!appleId) appleId = (await itunesSearchArtist(f.name))?.artistId || null;
        if (appleId) {
          const today = localDay();
          for (const al of await itunesGetArtistAlbums(appleId, 50)) {
            if (!(String(al.releaseDate || '') >= today)) continue;
            if (items.some((x) => norm(x.name) === norm(al.name) || norm(al.name).startsWith(norm(x.name)))) continue;
            items.push({
              id: null, name: al.name, type: al.albumGroup === 'single' ? 'single' : al.albumGroup === 'ep' ? 'ep' : 'album',
              coverUrl: al.albumArtUrl || null, releaseAt: '', releaseDate: String(al.releaseDate).slice(0, 10), countdown: true, apple: true,
            });
          }
        }
        answered = true;
      } catch (e) {
        console.warn('[countdowns]', f.name, 'Apple Music:', String(e?.message || e));
      }
      if (answered) cache[f.id] = { at: Date.now(), items, appleId };
    }
  };
  await Promise.all([worker(), worker()]);
  if (todo.length) {
    save();
    const found = todo.reduce((n, f) => n + (cache[f.id]?.items?.length || 0), 0);
    console.log(`[countdowns] checked ${todo.length} followed artists, ${found} releases on the way`);
  }
}

/**
 * Albums on the way, soonest first:
 * [{ key, artistId, artistName, artistImage, albumId, name, type, coverUrl,
 *    releaseAt, releaseDate, countdown, source }]
 * `releaseAt` is an exact moment when known; otherwise `releaseDate`
 * (YYYY-MM-DD) means local midnight that day.
 */
export async function listCountdowns({ force = false } = {}) {
  if (!inflight) inflight = refresh(force).finally(() => { inflight = null; });
  await inflight;
  const cache = load();
  const follows = listFollows();
  const today = localDay();

  let itunes = [];
  try { itunes = (await loadCachedReleases({ withinDays: 0 })).filter((r) => String(r.releaseDate).slice(0, 10) > today); } catch { /* none */ }

  const out = [];
  for (const f of follows) {
    const mine = [];
    for (const x of cache[f.id]?.items || []) {
      mine.push({
        key: `${f.id}:${x.id || norm(x.name)}`, artistId: f.id, artistName: f.name, artistImage: f.image || null,
        albumId: x.id || null, name: x.name, type: x.type || 'album', coverUrl: x.coverUrl || null,
        releaseAt: x.releaseAt || '', releaseDate: x.releaseDate || '', countdown: !!x.countdown, source: x.apple ? 'apple' : 'spotify',
      });
    }
    const who = norm(f.name);
    for (const r of itunes) {
      if (!String(r.artistName || '').split(/,|&| feat\.? | ft\.? | with | x | and /i).some((n) => norm(n) === who)) continue;
      if (mine.some((m) => norm(m.name) === norm(r.collectionName) || norm(r.collectionName).startsWith(norm(m.name)))) continue;
      mine.push({
        key: `${f.id}:itunes:${r.collectionId}`, artistId: f.id, artistName: f.name, artistImage: f.image || null,
        albumId: null, name: r.collectionName, type: r.trackCount > 1 ? 'album' : 'single',
        coverUrl: r.artworkUrl ? r.artworkUrl.replace(/\/\d+x\d+bb\./, '/1200x1200bb.') : null,
        releaseAt: '', releaseDate: String(r.releaseDate).slice(0, 10), countdown: false, source: 'apple',
      });
    }
    out.push(...mine);
  }
  const at = (x) => (x.releaseAt ? Date.parse(x.releaseAt) : new Date(`${x.releaseDate}T00:00:00`).getTime());
  return out.filter((x) => at(x) > Date.now() - 24 * 60 * 60 * 1000).sort((a, b) => at(a) - at(b));
}

export function registerCountdownsIpc(ipcMain) {
  ipcMain.handle('countdowns:list', async (_e, opts) => {
    try { return { ok: true, items: await listCountdowns(opts || {}) }; } catch (e) {
      return { ok: false, error: String(e?.message || e), items: [] };
    }
  });
}
