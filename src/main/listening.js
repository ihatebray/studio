/* =========================================================================
 *  studio — what you've listened to in Studio (main process)
 *
 *  Spotify never hears about plays in Studio (librespot doesn't report them,
 *  and Sonora doesn't either), so Spotify's own "recently played", top
 *  tracks and home feed only move when you listen in a Spotify app. This is
 *  Studio's own record instead, for My Spotify's Home: every Spotify song
 *  played past the halfway mark (or 30 s), with what it was played from.
 *
 *  Kept as JSON in userData (newest last, capped), written a moment after
 *  each play so a burst of skips is one write.
 * ========================================================================= */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';

const MAX_EVENTS = 20_000;
const DAY = 86_400_000;

const file = () => path.join(app.getPath('userData'), 'studio-listening.json');
let events = null;
let saveTimer = null;

function load() {
  if (events) return events;
  try {
    const v = JSON.parse(fs.readFileSync(file(), 'utf8'));
    events = Array.isArray(v) ? v : [];
  } catch { events = []; }
  return events;
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(file(), JSON.stringify(events)); } catch { /* ignore */ }
  }, 2000);
}

const str = (v) => String(v ?? '').trim();

/** One play. `t`: the track as the player had it; `context` what it was
 *  played from ({ kind, id, name, sub, image }), if anything. */
export function recordListen(t = {}) {
  const spotifyId = str(t.spotifyId);
  if (!/^[0-9A-Za-z]{22}$/.test(spotifyId)) return { ok: false };
  const list = load();
  const ctx = t.context && t.context.kind && t.context.id ? {
    kind: str(t.context.kind), id: str(t.context.id), name: str(t.context.name),
    sub: str(t.context.sub), image: t.context.image || null,
  } : (t.albumId ? {
    kind: 'album', id: str(t.albumId), name: str(t.album), sub: `Album · ${str(t.artists)}`, image: t.albumArtUrl || null,
  } : null);
  list.push({
    at: Date.now(),
    id: spotifyId,
    title: str(t.title),
    artists: str(t.artists),
    artistIds: Array.isArray(t.artistIds) ? t.artistIds.filter((x) => /^[0-9A-Za-z]{22}$/.test(x)) : [],
    album: str(t.album),
    albumId: str(t.albumId) || null,
    art: t.albumArtUrl || null,
    ms: Number(t.durationMs) || 0,
    heard: Number(t.listenedMs) || 0,
    ctx,
  });
  if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
  saveSoon();
  return { ok: true };
}

/** A track row in the pages' shape, from a play. */
const row = (e, extra = {}) => ({
  spotifyId: e.id, title: e.title, artists: e.artists, artistIds: e.artistIds || [],
  album: e.album, albumId: e.albumId, albumArtUrl: e.art, durationMs: e.ms, ...extra,
});

/* A day number in local time, for "today", streaks and the daily mix. */
const dayOf = (t) => {
  const d = new Date(t);
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60_000) / DAY);
};

function counts(list, since, until = Infinity) {
  const m = new Map();
  for (const e of list) {
    if (e.at < since || e.at >= until) continue;
    const c = m.get(e.id);
    if (c) { c.plays += 1; c.last = e; } else m.set(e.id, { plays: 1, last: e, first: e.at });
  }
  return m;
}

/** A seeded shuffle: the same order all day, a new one tomorrow. */
function daily(list, seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Everything Home builds from Studio listening. `liked`: Liked Songs rows,
 * for the daily mix (optional).
 */
export function listeningSummary({ liked = [] } = {}) {
  const list = load();
  const now = Date.now();
  const today = dayOf(now);

  // Recently played: newest first, one row per song.
  const recentTracks = [];
  const seen = new Set();
  for (let i = list.length - 1; i >= 0 && recentTracks.length < 30; i -= 1) {
    const e = list[i];
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    recentTracks.push(row(e, { playedAt: e.at }));
  }

  // Where you left off: the albums, playlists, artists and Liked Songs played from.
  const recentContexts = [];
  const seenCtx = new Set();
  for (let i = list.length - 1; i >= 0 && recentContexts.length < 12; i -= 1) {
    const c = list[i].ctx;
    if (!c) continue;
    const k = `${c.kind}:${c.id}`;
    if (seenCtx.has(k)) continue;
    seenCtx.add(k);
    recentContexts.push({ ...c, playedAt: list[i].at });
  }

  const month = counts(list, now - 30 * DAY);
  const ranked = (m, min = 1) => [...m.values()].filter((c) => c.plays >= min)
    .sort((a, b) => b.plays - a.plays || b.last.at - a.last.at);
  const onRepeat = ranked(month, 2).slice(0, 15).map((c) => row(c.last, { plays: c.plays }));
  const allTime = ranked(counts(list, 0), 2).slice(0, 24).map((c) => row(c.last, { plays: c.plays }));

  // Back then, not lately: played a lot one to six months ago, not in three weeks.
  const lately = counts(list, now - 21 * DAY);
  const rediscover = ranked(counts(list, now - 180 * DAY, now - 30 * DAY), 3)
    .filter((c) => !lately.has(c.last.id))
    .slice(0, 15)
    .map((c) => row(c.last, { plays: c.plays, lastPlayed: c.last.at }));

  // Top artists this month, by plays (first-billed artist).
  const artistPlays = new Map();
  for (const e of list) {
    if (e.at < now - 30 * DAY) continue;
    const name = e.artists.split(', ')[0];
    if (!name) continue;
    const k = name.toLowerCase();
    const a = artistPlays.get(k) || { name, id: e.artistIds?.[0] || null, plays: 0, art: e.art };
    a.plays += 1;
    if (!a.id && e.artistIds?.[0]) a.id = e.artistIds[0];
    artistPlays.set(k, a);
  }
  const topArtists = [...artistPlays.values()].sort((a, b) => b.plays - a.plays).slice(0, 12);

  // Pulse: today, this week, and how many days in a row.
  let todayMs = 0; let todaySongs = 0; let weekMs = 0; let weekSongs = 0;
  const days = new Set();
  for (const e of list) {
    const d = dayOf(e.at);
    days.add(d);
    // A play counts from halfway, so the song's length is near enough.
    const heard = e.ms || e.heard || 0;
    if (d === today) { todayMs += heard; todaySongs += 1; }
    if (d > today - 7) { weekMs += heard; weekSongs += 1; }
  }
  let streak = 0;
  for (let d = days.has(today) ? today : today - 1; days.has(d); d -= 1) streak += 1;

  /* Today's mix: new every day. Your favourites you haven't played this
     week, Liked Songs you haven't played lately, and a couple from what
     you're into right now, in a seeded order so it holds all day. */
  const week = counts(list, now - 7 * DAY);
  const favourites = ranked(counts(list, 0), 2).filter((c) => !week.has(c.last.id)).map((c) => row(c.last));
  const likedFresh = (liked || []).filter((t) => t?.spotifyId && !lately.has(t.spotifyId));
  const current = onRepeat.slice(0, 6);
  const pick = (arr, n) => daily(arr, today * 7919 + arr.length).slice(0, n);
  const mixSeen = new Set();
  const todaysMix = daily([
    ...pick(favourites, 12), ...pick(likedFresh, 15), ...pick(current, 3),
  ], today).filter((t) => (mixSeen.has(t.spotifyId) ? false : (mixSeen.add(t.spotifyId), true))).slice(0, 30);

  /* Mixes, shown on Home like Spotify's own: today's, one for each of your
     top artists this month (their songs you've played here and liked), and
     Rediscover. Each is reshuffled daily. */
  const covers = (rows) => {
    const out = [];
    for (const r of rows) { if (r.albumArtUrl && !out.includes(r.albumArtUrl)) out.push(r.albumArtUrl); if (out.length === 4) break; }
    return out;
  };
  const mix = (id, name, sub, rows) => ({ kind: 'mix', id, name, sub, rows, covers: covers(rows), count: rows.length });
  const mixes = [];
  if (todaysMix.length >= 5) mixes.push(mix('today', 'Today’s Mix', 'New every day', todaysMix));
  const everPlayed = ranked(counts(list, 0)).map((c) => row(c.last, { plays: c.plays }));
  const by = (name) => (t) => String(t?.artists || '').toLowerCase().split(', ').includes(name.toLowerCase());
  for (const a of topArtists.slice(0, 5)) {
    const seenA = new Set();
    const rows = [...everPlayed.filter(by(a.name)), ...(liked || []).filter(by(a.name))]
      .filter((t) => t?.spotifyId && (seenA.has(t.spotifyId) ? false : (seenA.add(t.spotifyId), true)));
    if (rows.length < 6) continue;
    const seed = today * 31 + [...a.name].reduce((n, ch) => (n * 33 + ch.charCodeAt(0)) >>> 0, 5381);
    mixes.push(mix(`artist:${a.id || a.name}`, `${a.name} Mix`, `Your favorites by ${a.name}, reshuffled daily`, daily(rows, seed).slice(0, 40)));
  }
  if (rediscover.length >= 5) mixes.push(mix('rediscover', 'Rediscover', 'Big for you a while back', rediscover));

  return {
    recentTracks, recentContexts, onRepeat, allTime, rediscover, topArtists, todaysMix, mixes,
    pulse: { todayMs, todaySongs, weekMs, weekSongs, streak, total: list.length },
    fetchedAt: now,
  };
}

export function registerListeningIpc(ipcMain) {
  ipcMain.handle('listening:record', (_e, t) => recordListen(t));
}
