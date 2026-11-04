import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { slskQuality, groupSlskFiles, fmtSize, normLoose } from '../lib/instantSearch.js';
import { api, fmtSec } from '../lib/format.js';
import { coverAt } from '../lib/coverUrl.js';
import { SoulseekCredsPanel } from './StudioOnboarding.jsx';

/* =========================================================================
 *  studio — Soulseek in the search panel
 *
 *  Two views, both drawn inside InstantSearch so they look and move like the
 *  rest of it:
 *
 *    SoulseekResults  the Soulseek search mode. Asks the network directly and
 *                     streams the answer in as folders and songs. A folder is
 *                     a place you go, not a row you can only grab.
 *
 *    SoulseekFolder   one peer's folder, opened. Asks that peer for the whole
 *                     folder (a search only shows the files whose names
 *                     matched), lists every song with its format, length and
 *                     size, and downloads all of it, a picked few, or one.
 *
 *  Downloads go through the same StudioHome handlers as everywhere else, so
 *  they land in the library, toast and show progress the same way.
 * ========================================================================= */

/* ---------------------------------------------------------------- stores */

/* One live search at a time, kept outside the components so opening a folder
   and coming back finds the list where it was, still filling if peers are
   still answering, instead of asking the network again. */
const live = { id: '', query: '', snap: null, subs: new Set() };
const doneCache = new Map(); // query → finished snapshot (last few)
let liveWired = false;

function emitLive() { live.subs.forEach((fn) => { try { fn(); } catch { /* ignore */ } }); }

function wireLive() {
  if (liveWired || !api()?.onSoulseekSearchUpdate) return;
  liveWired = true;
  api().onSoulseekSearchUpdate((p) => {
    if (!p || p.searchId !== live.id) return;
    live.snap = { ...p, query: live.query };
    if (p.done && !p.error) remember(live.query, live.snap);
    emitLive();
  });
}

function remember(q, snap) {
  doneCache.delete(q);
  doneCache.set(q, snap);
  while (doneCache.size > 6) doneCache.delete(doneCache.keys().next().value);
}

function startLive(q) {
  wireLive();
  const splitting = splitArtist(q).catch(() => null);
  const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const prev = live.snap;
  live.id = id;
  live.query = q;
  // The last list stays up, dimmed, until the first answers for this one land.
  live.snap = { query: q, pending: true, done: false, peers: 0, fileCount: 0,
    results: prev?.results || [], folders: prev?.folders || [], stale: !!(prev?.results?.length || prev?.folders?.length) };
  emitLive();
  splitting.then((split) => (live.id !== id ? null : api()?.soulseekSearchLive?.({ searchId: id, query: q, artist: split?.artist || '', rest: split?.rest || '' }))).then((res) => {
    if (live.id !== id) return;
    if (!res) { live.snap = { query: q, done: true, error: 'Soulseek isn’t available in this build.', results: [], folders: [] }; emitLive(); return; }
    if (res.ok === false) live.snap = { query: q, done: true, error: res.error || 'The search didn’t go through.', results: [], folders: [] };
    else { live.snap = { ...res, query: q, done: true }; remember(q, live.snap); }
    emitLive();
  }).catch((e) => {
    if (live.id !== id) return;
    live.snap = { query: q, done: true, error: String(e?.message || e), results: [], folders: [] };
    emitLive();
  });
}

function useLive() {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    live.subs.add(fn);
    return () => { live.subs.delete(fn); };
  }, []);
  return live.snap;
}

/* Each file's download state, by file id. StudioHome only marks the file you
   clicked: a folder download reports its songs one by one on the progress
   channel, and this keeps what they said so each row can show it. */
const fileStates = new Map(); // id → 'busy' | 'done' | 'failed'
const fileSubs = new Set();
let filesWired = false;
function wireFiles() {
  if (filesWired || !api()?.onSoulseekDownloadProgress) return;
  filesWired = true;
  api().onSoulseekDownloadProgress((p) => {
    if (!p?.id) return;
    const st = p.state === 'done' ? 'done' : p.state === 'failed' ? 'failed' : 'busy';
    if (fileStates.get(p.id) === st) return;
    fileStates.set(p.id, st);
    fileSubs.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  });
}
function useFileStates() {
  const [, bump] = useState(0);
  useEffect(() => {
    wireFiles();
    const fn = () => bump((n) => n + 1);
    fileSubs.add(fn);
    return () => { fileSubs.delete(fn); };
  }, []);
  return fileStates;
}

/* -------------------------------------------------------------- helpers */

const FILTER_KEY = 'studio:slskQuality';

/** The peer's own separator kept: that's the path they'll answer to. */
function rawParent(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i === -1 ? '' : s.slice(0, i);
}
function lastSeg(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

/* Folder names that say where something is kept rather than whose it is. */
const NOT_AN_ARTIST = /^(@@.*|music|musique|musik|mp3s?|flacs?|lossless|albums?|downloads?|complete|completed|incoming|shared?|soulseek|slsk|audio|media|library|my music|various|va|[a-z]:)$/i;

/** "Artist - Album (2017) [FLAC]" or "Artist/Album" → { artist, album }. */
export function parseRecord(displayName, parentName) {
  const name = String(displayName || '');
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(name);
  let artist = m ? m[1] : String(parentName || '');
  let album = m ? m[2] : name;
  if (/^\d{4}$/.test(artist.trim()) && m) { artist = String(parentName || ''); } // "2017 - Album"
  album = album
    .replace(/[([{][^)\]}]*\b(flac|mp3|320|v0|v2|kbps|24|16|bit|khz|web|cd|vinyl|lossless|hi.?res)\b[^)\]}]*[)\]}]/gi, ' ')
    .replace(/[([{]\s*(19|20)\d{2}\s*[)\]}]/g, ' ')
    .replace(/\s+[-–—]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim() || name;
  artist = artist.replace(/[([{][^)\]}]*[)\]}]/g, ' ').replace(/\s+/g, ' ').trim();
  if (NOT_AN_ARTIST.test(artist)) artist = '';
  return { artist, album };
}

/** "03 - Artist - Song Title.flac" → { n: 3, title: 'Song Title' } */
function parseFileName(filename, artist = '') {
  let s = String(filename || '').replace(/\.[a-z0-9]{2,5}$/i, '');
  let n = null;
  const m = /^\s*[[(]?\s*(?:(\d)[-.])?(\d{1,3})\s*[\])]?\s*(?:[-._–]+\s*|\s+)(?=\S)/.exec(s);
  if (m) {
    const v = parseInt(m[2], 10);
    if (v >= 1 && v <= 99) { n = v; s = s.slice(m[0].length); }
  }
  s = s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = s.split(/\s+[-–]\s+/);
  if (parts.length >= 2) {
    const lead = normLoose(parts[0]);
    if (artist && lead && (normLoose(artist).includes(lead) || lead.includes(normLoose(artist)))) s = parts.slice(1).join(' - ');
  }
  return { n, title: s || String(filename || '') };
}

/** The badge for one file: FLAC, FLAC 24/96, 320, 256… */
export function fileQuality(f) {
  const q = slskQuality(f?.ext, f?.bitrate);
  if (q.lossless && (Number(f?.bitDepth) > 16 || Number(f?.sampleRate) > 48000)) {
    const sr = Number(f.sampleRate) ? `/${Math.round(Number(f.sampleRate) / 100) / 10}` : '';
    return { ...q, label: `${q.label} ${Number(f.bitDepth) || 24}${sr}`, hires: true };
  }
  return q;
}
function folderQuality(f) {
  const ext = String(f?.ext || '').toLowerCase();
  if (slskQuality(ext).lossless) return slskQuality(ext);
  if (f?.quality === 'lossless') return slskQuality('flac');
  return slskQuality(ext, f?.bitrate);
}

function runTime(sec) {
  const s = Math.round(Number(sec) || 0);
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} hr ${m} min` : `${m} min`;
}

/* Album art for a folder, from the same album search the rest of the app
   uses. A couple at a time, cached, and only trusted when the album name
   actually matches, a wrong cover being worse than none. */
const artCache = new Map(); // key → url | ''
const artWaiting = [];
let artRunning = 0;
function pumpArt() {
  while (artRunning < 2 && artWaiting.length) {
    const job = artWaiting.shift();
    artRunning += 1;
    job().finally(() => { artRunning -= 1; pumpArt(); });
  }
}
function bareAlbum(name) {
  return normLoose(String(name || '')
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\b(deluxe|remaster(ed)?|edition|expanded|anniversary|version|bonus|tracks?|special|collector'?s)\b/gi, ' '));
}
function lookupArt(artist, album) {
  const key = normLoose(`${artist}|${album}`);
  if (artCache.has(key)) return Promise.resolve(artCache.get(key));
  if (!api()?.spotifySearchAlbums || !album) return Promise.resolve('');
  return new Promise((resolve) => {
    artWaiting.push(async () => {
      let url = '';
      try {
        const list = await api().spotifySearchAlbums(`${artist} ${album}`.trim());
        const want = bareAlbum(album);
        const who = normLoose(artist);
        const fits = (a) => {
          const nm = bareAlbum(a?.name);
          // The same record, give or take "Deluxe" or a year. A live album or a
          // different record that merely starts the same way is not a match.
          if (!nm || !want || nm !== want) return false;
          if (!who) return true;
          const by = normLoose(a?.artists);
          return by.includes(who) || who.includes(by);
        };
        const hit = (Array.isArray(list) ? list : []).find(fits);
        url = hit?.albumArtUrl || '';
      } catch { /* no cover */ }
      artCache.set(key, url);
      resolve(url);
    });
    pumpArt();
  });
}
function useArt(artist, album, enabled = true) {
  const key = normLoose(`${artist}|${album}`);
  const [url, setUrl] = useState(() => artCache.get(key) || '');
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    if (artCache.has(key)) { setUrl(artCache.get(key)); return undefined; }
    setUrl('');
    lookupArt(artist, album).then((u) => { if (alive) setUrl(u); });
    return () => { alive = false; };
  }, [key, enabled]);
  return url;
}

/* ---------------------------------------------------------------- bits */

function Svg({ d, size = 15, w = 2, children, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden>
      {d}{children}
    </svg>
  );
}
const Ico = {
  folder: <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
  note: <path d="M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm12-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  check: <path d="M20 6L9 17l-5-5" />,
  down: <path d="M12 4v12M6 11l6 6 6-6M5 20h14" />,
  retry: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14a6.5 6.5 0 0 1 3 6" /></>,
  wave: <path d="M2 12h2M6 8v8M10 5v14M14 8v8M18 10v4M22 12h0" />,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5v.01" /></>,
};

function Badge({ q }) {
  if (!q || !q.label) return null;
  const style = q.lossless
    ? { background: 'rgba(140,220,160,0.14)', color: 'rgb(140,220,160)', boxShadow: 'inset 0 0 0 1px rgba(140,220,160,0.22)' }
    : q.tier >= 4 ? { background: 'rgba(var(--st-acc-rgb),0.14)', color: 'rgb(var(--st-acc-rgb))', boxShadow: 'inset 0 0 0 1px rgba(var(--st-acc-rgb),0.22)' }
      : { background: 'rgba(var(--st-fg-rgb),0.07)', color: 'rgba(var(--st-fg-rgb),0.55)' };
  return <span className="isx-badge" style={style}>{q.label}</span>;
}

/** One file's download control: get, progress, done or try again. */
function FileGet({ state, progress, onGet, title = 'Download this song' }) {
  if (state === 'busy') {
    const pct = typeof progress?.pct === 'number' ? progress.pct : null;
    return (
      <span className="slk-fprog" title={pct != null ? `${Math.round(pct * 100)}%` : 'Starting'}>
        <span className="isx-prog-bar"><i style={{ width: pct != null ? `${Math.max(4, Math.round(pct * 100))}%` : '30%' }} /></span>
        <span className="slk-fpct">{pct != null ? `${Math.round(pct * 100)}%` : 'Starting'}</span>
      </span>
    );
  }
  if (state === 'done') {
    return <span className="slk-done" title="In your library"><Svg d={Ico.check} size={14} w={2.8} /></span>;
  }
  const retry = state === 'failed';
  return (
    <span role="button" tabIndex={-1} className={`slk-get${retry ? ' is-retry' : ''}`}
      title={retry ? 'That didn’t work. Try again' : title} aria-label={retry ? 'Try again' : title}
      onClick={(e) => { e.stopPropagation(); onGet?.(); }}>
      <Svg d={retry ? Ico.retry : Ico.down} size={14} w={2.3} />
    </span>
  );
}

function FolderArt({ folder, size = 42, art = '' }) {
  return (
    <span className={`slk-art${art ? ' has-art' : ''}`} style={{ width: size, height: size, backgroundImage: art ? `url("${coverAt(art, size > 100 ? 300 : 120)}")` : 'none' }}>
      {art ? null : <Svg d={Ico.folder} size={Math.round(size * 0.4)} w={1.8} />}
      {!art && folderQuality(folder).lossless && size > 60 ? <span className="slk-artq">Lossless</span> : null}
    </span>
  );
}

/* ====================================================== SoulseekResults */

const FOLDERS_SHOWN = 6;
const SONGS_SHOWN = 8;

function words(s) {
  return String(s || '').toLowerCase().split(/\s+/).map(normLoose).filter(Boolean);
}

/**
 * Which words are the artist. Many Soulseek clients hide every file whose
 * path names certain artists, so "lil wayne dedication 5" can find nothing
 * while "dedication 5" finds the record. Knowing "lil wayne" is the artist
 * lets the search also ask for the rest on its own. Spotify knows the names,
 * and "Artist - Title" says it outright. Gives up quickly: the search
 * shouldn't wait on this.
 */
const splitCache = new Map();
async function splitArtist(q) {
  const dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(q);
  if (dash) return { artist: dash[1].trim(), rest: dash[2].trim() };
  const toks = words(q);
  if (toks.length < 2) return null;
  if (splitCache.has(q)) return splitCache.get(q);
  const a = api();
  const ask = Promise.all([
    Promise.resolve(a?.spotifySearchArtists?.(q)).catch(() => []),
    Promise.resolve(a?.spotifySearchAlbums?.(q)).catch(() => []),
    Promise.resolve(a?.spotifySearch?.(q)).catch(() => []),
  ]);
  const got = await Promise.race([ask, new Promise((r) => setTimeout(() => r(null), 1800))]);
  if (!got) return null;
  const [artists, albums, tracks] = got.map((x) => (Array.isArray(x) ? x : []));
  const names = [
    ...artists.slice(0, 5).map((x) => x?.name),
    ...[...albums.slice(0, 6), ...tracks.slice(0, 6)].flatMap((x) => String(x?.artists || '').split(/,\s*/)),
  ].filter(Boolean);
  const raw = q.trim().split(/\s+/);
  let best = null;
  for (const name of names) {
    const nt = words(name);
    if (!nt.length || nt.length >= toks.length) continue;
    const head = nt.every((t, i) => toks[i] === t);
    const tail = nt.every((t, i) => toks[toks.length - nt.length + i] === t);
    if (!head && !tail) continue;
    if (best && best.n >= nt.length) continue;
    best = head
      ? { n: nt.length, artist: raw.slice(0, nt.length).join(' '), rest: raw.slice(nt.length).join(' ') }
      : { n: nt.length, artist: raw.slice(raw.length - nt.length).join(' '), rest: raw.slice(0, raw.length - nt.length).join(' ') };
  }
  const out = best ? { artist: best.artist, rest: best.rest } : null;
  splitCache.set(q, out);
  return out;
}

export function SoulseekResults({
  query = '',
  dlState = {},
  dlProgress = {},
  onGetFile,          // (fileRow)
  onOpenFolder,       // (folder) → open it in the panel
}) {
  const q = String(query || '').trim();
  const snap = useLive();
  const states = useFileStates();
  const [configured, setConfigured] = useState(null);
  const [lossless, setLossless] = useState(() => { try { return localStorage.getItem(FILTER_KEY) === 'lossless'; } catch { return false; } });
  const toggleLossless = () => setLossless((v) => {
    try { localStorage.setItem(FILTER_KEY, v ? 'any' : 'lossless'); } catch { /* ignore */ }
    return !v;
  });
  const [moreFolders, setMoreFolders] = useState(false);
  const [moreSongs, setMoreSongs] = useState(false);
  const [openSong, setOpenSong] = useState(null);

  useEffect(() => {
    let alive = true;
    Promise.resolve(api()?.soulseekGetCredsState?.()).then((st) => { if (alive) setConfigured(!!st?.configured); }).catch(() => { if (alive) setConfigured(false); });
    return () => { alive = false; };
  }, []);

  /* Search when typing pauses, or straight away on Enter. A finished search
     for the same words is reused rather than asked again. */
  const run = useCallback((text, force = false) => {
    if (!text || text.length < 2) return;
    if (!force && live.query === text && live.snap && !live.snap.error) return;
    if (!force && doneCache.has(text)) {
      live.id = doneCache.get(text).searchId || '';
      live.query = text;
      live.snap = doneCache.get(text);
      emitLive();
      return;
    }
    startLive(text);
  }, []);
  useEffect(() => {
    if (!configured) return undefined;
    setMoreFolders(false); setMoreSongs(false); setOpenSong(null);
    if (q.length < 2) return undefined;
    if (live.query === q) return undefined;
    const t = setTimeout(() => run(q), 750);
    return () => clearTimeout(t);
  }, [q, configured, run]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Enter' || e.defaultPrevented || !e.target?.classList?.contains('isx-input')) return;
      if (q.length >= 2) run(q, live.query === q && !!live.snap?.done);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [q, run]);

  const mine = snap && snap.query === q ? snap : null;
  /* What's on screen: this search's answer, or until it has one, the last
     list, dimmed, so typing doesn't blank the panel between searches. */
  const shown = mine && !(mine.stale && !(mine.results?.length || mine.folders?.length)) ? mine : (snap || null);

  const folders = useMemo(() => (shown?.folders || [])
    .map((f) => ({ ...f, _q: folderQuality(f) }))
    .filter((f) => !lossless || f._q.lossless), [shown?.folders, lossless]);

  /* A folder goes with the files this search found in it, so it still has
     songs to show if its owner won't send the full listing. */
  const openFolder = useCallback((target) => {
    const inside = (raw) => raw === target.folderRaw || raw.startsWith(`${target.folderRaw}\\`) || raw.startsWith(`${target.folderRaw}/`);
    const found = (shown?.results || []).filter((r) => r.user === target.user && inside(r.folderRaw || rawParent(r.filePath)));
    const have = new Set((target.tracks || []).map((t) => t.id));
    onOpenFolder?.({ ...target, tracks: [...(target.tracks || []), ...found.filter((r) => !have.has(r.id))] });
  }, [shown?.results, onOpenFolder]);

  const songs = useMemo(() => {
    const rows = (shown?.results || []).map((r) => ({ ...r, _fq: fileQuality(r) })).filter((r) => !lossless || r._fq.lossless);
    return groupSlskFiles(rows).map((g) => ({ ...g, variant: g.best?.variant || '' }));
  }, [shown?.results, lossless]);

  if (configured === false) {
    return (
      <div className="isx-body slk-body">
        <div className="slk-setup">
          <div className="isx-hello" style={{ paddingTop: 22 }}>
            <div className="isx-hello-t">Soulseek Isn’t Set Up</div>
            <div className="isx-hello-l">Add a login to search other people’s shares. Any username and password works, the account is made the first time you sign in.</div>
          </div>
          <div className="slk-creds"><SoulseekCredsPanel compact onSaved={() => setConfigured(true)} /></div>
        </div>
      </div>
    );
  }

  if (!q) {
    return (
      <div className="isx-body slk-body">
        <div className="isx-hello" style={{ padding: '26px 16px 22px' }}>
          <div className="isx-hello-t">Search Soulseek</div>
          <div className="isx-hello-l">Albums and songs from other people’s shares, often in lossless.</div>
        </div>
      </div>
    );
  }

  const searching = !mine || !mine.done;
  const stale = shown !== mine || !!mine?.stale;
  const showFolders = moreFolders ? folders : folders.slice(0, FOLDERS_SHOWN);
  const showSongs = moreSongs ? songs : songs.slice(0, SONGS_SHOWN);
  const nothing = shown === mine && mine?.done && !mine.error && !folders.length && !songs.length;
  const filtered = nothing && lossless && ((mine.folders || []).length || (mine.results || []).length);

  return (
    <>
      <div className="slk-bar">
        <span className="slk-status">
          {mine?.error ? 'Search didn’t go through'
            : searching ? <><span className="isx-spin" />Searching</>
              : `${mine.peers || 0} ${mine.peers === 1 ? 'person' : 'people'} answered`}
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" className={`slk-tog${lossless ? ' on' : ''}`} aria-pressed={lossless} onClick={toggleLossless}>
          <span className="slk-box">{lossless ? <Svg d={Ico.check} size={10} w={3.2} /> : null}</span>
          Lossless Only
        </button>
      </div>

      <div className={`isx-body slk-body${stale ? ' is-stale' : ''}`}>
        {mine?.error ? (
          <div className="isx-empty">
            <div className="isx-emptytitle">Soulseek didn’t answer</div>
            <div className="isx-emptyhint">{mine.error}</div>
            <button type="button" className="isx-ghost" style={{ marginTop: 12 }} onClick={() => run(q, true)}>Try Again</button>
          </div>
        ) : nothing ? (
          <div className="isx-empty">
            <div className="isx-emptytitle">{filtered ? 'Nothing in lossless' : <>Nothing found for “{q}”</>}</div>
            <div className="isx-emptyhint">
              {filtered
                ? 'There are results, just not lossless ones. Turn off Lossless Only to see them.'
                : 'Try the album or song name on its own. Some artists’ names are blocked on Soulseek, so their files only turn up by the album’s name.'}
            </div>
            {!filtered ? <button type="button" className="isx-ghost" style={{ marginTop: 12 }} onClick={() => run(q, true)}>Search Again</button> : null}
          </div>
        ) : !folders.length && !songs.length ? (
          <div className="slk-skels">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="isx-skel"><span className="sk-art" /><span className="sk-lines"><span className="sk-a" /><span className="sk-b" /></span></div>
            ))}
          </div>
        ) : (
          <>
            {folders.length ? (
              <>
                <div className="isx-sec">Albums and Folders</div>
                {showFolders.map((f, i) => (
                  <FolderRow key={f.id} f={f} index={i} onOpen={openFolder} />
                ))}
                {folders.length > FOLDERS_SHOWN ? (
                  <button type="button" className="slk-more" onClick={() => setMoreFolders((v) => !v)}>
                    {moreFolders ? 'Show Fewer' : `Show ${folders.length - FOLDERS_SHOWN} More`}
                  </button>
                ) : null}
              </>
            ) : null}

            {songs.length ? (
              <>
                <div className="isx-sec">Songs</div>
                {showSongs.map((g) => (
                  <SongRow key={g.key} g={g} open={openSong === g.key}
                    onToggle={() => setOpenSong((k) => (k === g.key ? null : g.key))}
                    states={states} dlState={dlState} dlProgress={dlProgress}
                    onGetFile={onGetFile} onOpenFolder={openFolder} />
                ))}
                {songs.length > SONGS_SHOWN ? (
                  <button type="button" className="slk-more" onClick={() => setMoreSongs((v) => !v)}>
                    {moreSongs ? 'Show Fewer' : `Show ${songs.length - SONGS_SHOWN} More`}
                  </button>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

/** A folder as a link to itself: the file it was found by opens it too. */
function folderFromFile(s) {
  const folderRaw = s.folderRaw || rawParent(s.filePath);
  const segs = String(folderRaw).split(/[\\/]+/).filter(Boolean);
  return {
    id: `${s.user}::${folderRaw}`,
    user: s.user,
    folderRaw,
    folder: s.folder,
    displayName: segs[segs.length - 1] || folderRaw,
    parentName: segs.length > 1 ? segs[segs.length - 2] : '',
    ext: s.ext,
    bitrate: s.bitrate,
    slots: s.slots,
    speed: s.speed,
    queue: s.queue,
    tracks: [s],
    focusId: s.id,
  };
}

/** Only worth a word when it's bad news: their uploads are busy. */
function Waits({ free, queue = 0 }) {
  if (free) return null;
  return <span className="slk-wait" title="Their uploads are busy, so a download waits in line">{queue > 0 ? `Queue ${queue}` : 'Queued'}</span>;
}

function FolderRow({ f, index, onOpen }) {
  const rec = parseRecord(f.displayName, f.parentName);
  const art = useArt(rec.artist, rec.album, index < 12);
  const copies = f.copies || [];
  const withSiblings = (target) => {
    const all = [f, ...copies];
    return { ...target, copies: all.filter((x) => x.id !== target.id).map(({ copies: _c, ...rest }) => rest) };
  };
  return (
    <button type="button" className="isx-row slk-row isx-in" onClick={() => onOpen(withSiblings(f))} title={f.displayName}>
      <FolderArt folder={f} art={art} />
      <div className="isx-mid">
        <div className="isx-nm">
          {rec.album || f.displayName}
          {f.variant ? <span className="slk-var">{f.variant}</span> : null}
        </div>
        <div className="isx-meta">
          {rec.artist ? <span className="isx-mi">{rec.artist}</span> : null}
          <span className="isx-mi">{f.trackCount} {f.trackCount === 1 ? 'song' : 'songs'}</span>
          {f.totalSize ? <span className="isx-mi">{fmtSize(f.totalSize)}</span> : null}
        </div>
      </div>
      <Waits free={f.slots} queue={f.queue} />
      <Badge q={f._q || folderQuality(f)} />
      <span className="slk-openic"><Svg d={Ico.chevron} size={14} w={2.4} /></span>
    </button>
  );
}

function SongRow({ g, open, onToggle, states, dlState, dlProgress, onGetFile, onOpenFolder }) {
  const best = g.best;
  const st = (s) => dlState[`t:${s.id}`] || states.get(s.id) || null;
  const folderName = lastSeg(best.folderRaw || best.folder);
  return (
    <div className={`slk-swrap${open ? ' is-open' : ''}`}>
      <button type="button" className="isx-row slk-row isx-in" onClick={onToggle} title={best.filePath}>
        <div className="isx-glyph"><Svg d={Ico.note} size={16} w={1.8} /></div>
        <div className="isx-mid">
          <div className="isx-nm">
            {g.title}
            {g.variant ? <span className="slk-var">{g.variant}</span> : null}
          </div>
          <div className="isx-meta">
            {g.artist ? <span className="isx-mi">{g.artist}</span> : null}
            {folderName ? (
              <span className="isx-mi is-link" role="link" tabIndex={-1} title="Open this folder"
                onClick={(e) => { e.stopPropagation(); onOpenFolder?.(folderFromFile(best)); }}>{folderName}</span>
            ) : null}
            {best.duration ? <span className="isx-mi">{fmtSec(best.duration)}</span> : null}
          </div>
        </div>
        <Waits free={best.slots} queue={best.queue} />
        <Badge q={best._fq || fileQuality(best)} />
        <FileGet state={st(best)} progress={dlProgress[`t:${best.id}`]} onGet={() => onGetFile?.(best)} />
      </button>
      {open ? (
        <div className="slk-copylist">
          {g.sources.map((s) => (
            <div key={s.id} className="slk-src">
              <div className="slk-srcmain">
                <span className="slk-srchead">
                  <Badge q={s._fq || fileQuality(s)} />
                  <b>{s.user}</b>
                  <Waits free={s.slots} queue={s.queue} />
                  {s.size ? <span className="isx-mi">{fmtSize(s.size)}</span> : null}
                </span>
                <span className="isx-path">{s.filePath}</span>
              </div>
              <button type="button" className="isx-ghost" onClick={() => onOpenFolder?.(folderFromFile(s))}>Open Folder</button>
              <FileGet state={st(s)} progress={dlProgress[`t:${s.id}`]} onGet={() => onGetFile?.(s)} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ======================================================= SoulseekFolder */

const folderCache = new Map(); // folder id → browse answer

export function SoulseekFolder({
  folder,
  dlState = {},
  dlProgress = {},
  onGetFile,          // (fileRow)
  onGetFolder,        // ({ id, displayName, tracks })
  onOpenCopy,         // (folder) → open another copy in this frame's place
}) {
  const states = useFileStates();
  const folderRaw = folder.folderRaw || rawParent(folder.tracks?.[0]?.filePath || '');
  const rec = parseRecord(folder.displayName, folder.parentName || lastSeg(rawParent(folderRaw)));
  const art = useArt(rec.artist, rec.album);
  const [view, setView] = useState(() => folderCache.get(folder.id) || { busy: true });
  const [nonce, setNonce] = useState(0);
  const [picked, setPicked] = useState(() => new Set());
  const [showCopies, setShowCopies] = useState(false);
  const [dlKey, setDlKey] = useState(folder.id);
  const focusRef = useRef(null);

  useEffect(() => {
    const cached = folderCache.get(folder.id);
    if (cached && !nonce) { setView(cached); return undefined; }
    let alive = true;
    setView({ busy: true });
    if (!api()?.soulseekFolder || !folderRaw) {
      setView({ ok: true, partial: true, dirs: [{ path: folderRaw, files: (folder.tracks || []).map((t) => ({ ...t, audio: true })) }] });
      return undefined;
    }
    api().soulseekFolder({ user: folder.user, folder: folderRaw }).then((res) => {
      if (!alive) return;
      let v = res || { ok: false, error: 'No answer.' };
      /* The peer didn't send the folder: show what we already know is in it,
         the files the search found, rather than nothing. */
      if (!v.ok || !(v.dirs || []).some((d) => d.files.some((f) => f.audio))) {
        const known = (folder.tracks || []).map((t) => ({ ...t, audio: true }));
        if (known.length) v = { ...v, ok: true, partial: true, dirs: [{ path: folderRaw, files: known }] };
      }
      const out = { ...v, busy: false };
      if (out.ok && !out.partial) folderCache.set(folder.id, out);
      setView(out);
    }).catch((e) => { if (alive) setView({ ok: false, error: String(e?.message || e) }); });
    return () => { alive = false; };
  }, [folder.id, nonce]);

  const dirs = useMemo(() => (view.dirs || []).map((d) => ({
    ...d,
    songs: d.files.filter((f) => f.audio).map((f) => {
      const p = parseFileName(f.filename, rec.artist);
      return { ...f, user: f.user || folder.user, _n: p.n, _title: p.title, _fq: fileQuality(f) };
    }),
    other: d.files.filter((f) => !f.audio),
  })).filter((d) => d.songs.length || d.other.length), [view.dirs]);
  const songs = useMemo(() => dirs.flatMap((d) => d.songs), [dirs]);
  const others = useMemo(() => dirs.flatMap((d) => d.other), [dirs]);

  // A folder opened from one song shows that song picked out.
  useEffect(() => {
    if (!folder.focusId || !songs.length) return;
    const el = focusRef.current;
    if (el) el.scrollIntoView({ block: 'center' });
  }, [songs.length, folder.focusId]);

  const st = (f) => dlState[`t:${f.id}`] || states.get(f.id) || null;
  // What a download would fetch: not what's in, nor what's already coming.
  const left = songs.filter((f) => st(f) !== 'done' && st(f) !== 'busy');
  const totalSize = songs.reduce((s, f) => s + (Number(f.size) || 0), 0);
  const totalSec = songs.reduce((s, f) => s + (Number(f.duration) || 0), 0);
  const pickedRows = songs.filter((f) => picked.has(f.id) && st(f) !== 'done' && st(f) !== 'busy');
  const pickedSize = pickedRows.reduce((s, f) => s + (Number(f.size) || 0), 0);
  const leftSize = left.reduce((s, f) => s + (Number(f.size) || 0), 0);
  const allDone = songs.length > 0 && songs.every((f) => st(f) === 'done');
  const albumBusy = dlState[`ssa:${dlKey}`] === 'busy';
  const albumProg = dlProgress[`ssa:${dlKey}`] || null;

  const quals = [...new Set(songs.map((f) => f._fq.label).filter(Boolean))];
  const headQ = songs.length
    ? (quals.length === 1 ? songs[0]._fq : songs.some((f) => f._fq.lossless) && songs.every((f) => f._fq.lossless) ? songs[0]._fq : { label: 'Mixed', tier: 2 })
    : folderQuality(folder);

  const getAll = () => {
    if (!left.length || albumBusy) return;
    setDlKey(folder.id);
    onGetFolder?.({ id: folder.id, displayName: folder.displayName, tracks: left });
  };
  const getPicked = () => {
    if (!pickedRows.length || albumBusy) return;
    const key = `${folder.id}::pick${Date.now().toString(36)}`;
    setDlKey(key);
    onGetFolder?.({ id: key, displayName: folder.displayName, tracks: pickedRows });
    setPicked(new Set());
  };
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allPicked = left.length > 0 && left.every((f) => picked.has(f.id));

  const copies = folder.copies || [];
  // Formats only get a column when the folder mixes them. Otherwise the header says it once.
  const mixed = new Set(songs.map((f) => f._fq.label)).size > 1;

  return (
    <>
      <div className="isx-peek is-album slk-hero">
        <div className="isx-peekhero">
          <FolderArt folder={folder} size={140} art={art} />
          <div className="isx-mid">
            <div className="isx-eyebrow">From {folder.user}</div>
            <h3 className="isx-peektitle">{rec.album || folder.displayName}</h3>
            <div className="isx-peeksub">
              {[rec.artist,
                songs.length ? `${songs.length} ${songs.length === 1 ? 'song' : 'songs'}` : '',
                fmtSize(totalSize), runTime(totalSec)].filter(Boolean).join(' · ')}
            </div>
            <div className="slk-facts">
              <Badge q={headQ} />
              <Waits free={folder.slots} queue={folder.queue} />
            </div>
            <div className="isx-peekacts">
              {!songs.length && !view.busy ? null : albumBusy ? (
                <div className="slk-albprog">
                  <span className="isx-prog-bar"><i style={{ width: `${Math.max(3, Math.round((albumProg?.pct || 0) * 100))}%` }} /></span>
                  <span className="slk-albtxt">
                    Downloading {Math.min((albumProg?.completed || 0) + 1, albumProg?.total || left.length || 1)} of {albumProg?.total || '…'}
                    {albumProg?.currentFile ? ` · ${parseFileName(albumProg.currentFile, rec.artist).title}` : ''}
                  </span>
                </div>
              ) : allDone ? (
                <span className="slk-alldone"><Svg d={Ico.check} size={14} w={2.6} /> All {songs.length} in Your Library</span>
              ) : pickedRows.length ? (
                <button type="button" className="isx-get is-solid is-big" onClick={getPicked}>
                  <Svg d={Ico.down} size={13} w={2.4} style={{ marginRight: 7 }} />
                  Download {pickedRows.length} Selected{pickedSize ? ` · ${fmtSize(pickedSize)}` : ''}
                </button>
              ) : (
                <button type="button" className="isx-get is-solid is-big" disabled={!left.length || view.busy} onClick={getAll}>
                  <Svg d={Ico.down} size={13} w={2.4} style={{ marginRight: 7 }} />
                  {view.busy ? 'Opening Folder' : !left.length ? 'Downloading' : left.length === songs.length
                    ? `Download All ${songs.length}${leftSize ? ` · ${fmtSize(leftSize)}` : ''}`
                    : `Download the ${left.length} Left${leftSize ? ` · ${fmtSize(leftSize)}` : ''}`}
                </button>
              )}
              {pickedRows.length && !albumBusy ? (
                <button type="button" className="isx-ghost is-big" onClick={() => setPicked(new Set())}>Clear Selection</button>
              ) : null}
              {copies.length ? (
                <button type="button" className={`isx-ghost is-big${showCopies ? ' slk-on' : ''}`} onClick={() => setShowCopies((v) => !v)}>
                  <Svg d={Ico.users} size={13} w={2.1} style={{ marginRight: 7, verticalAlign: -2 }} />
                  {copies.length} Other {copies.length === 1 ? 'Copy' : 'Copies'}
                </button>
              ) : null}
            </div>
          </div>
        </div>
        {showCopies ? (
          <div className="slk-copylist is-hero">
            {copies.map((c) => (
              <button key={c.id} type="button" className="slk-copy" onClick={() => onOpenCopy?.({ ...c, copies: [{ ...folder, copies: undefined }, ...copies.filter((x) => x.id !== c.id)] })}>
                <Badge q={folderQuality(c)} />
                <b>{c.user}</b>
                <Waits free={c.slots} queue={c.queue} />
                {c.totalSize ? <span className="isx-mi">{fmtSize(c.totalSize)}</span> : null}
                <span className="slk-copyname">{c.displayName}</span>
                <span className="slk-copyopen">Open</span>
              </button>
            ))}
          </div>
        ) : null}
        {view.busy ? (
          <div className="isx-cov is-busy"><span className="isx-spin" />Opening the folder</div>
        ) : view.partial && songs.length ? (
          <div className="isx-cov">
            <Svg d={Ico.alert} size={14} w={2.2} style={{ color: 'rgba(240,190,120,0.9)', flexShrink: 0 }} />
            <span>{folder.user} didn’t send the whole folder, so only the songs your search found are shown.</span>
            <button type="button" className="isx-ghost" onClick={() => { folderCache.delete(folder.id); setNonce((n) => n + 1); }}>Try Again</button>
          </div>
        ) : null}
      </div>

      <div className={`isx-body slk-body slk-tracks${picked.size ? ' is-picking' : ''}`}>
        {view.busy ? (
          Array.from({ length: Math.max(3, Math.min(10, folder.trackCount || 6)) }).map((_, i) => (
            <div key={i} className="isx-skel"><span className="sk-art" style={{ width: 22, height: 22 }} /><span className="sk-lines"><span className="sk-a" /><span className="sk-b" /></span></div>
          ))
        ) : !songs.length ? (
          <div className="isx-empty">
            <div className="isx-emptytitle">Couldn’t open this folder</div>
            <div className="isx-emptyhint">{view.error || `${folder.user} didn’t answer. They may be offline right now.`}{copies.length ? ' Try one of the other copies.' : ''}</div>
            <button type="button" className="isx-ghost" style={{ marginTop: 12 }} onClick={() => { folderCache.delete(folder.id); setNonce((n) => n + 1); }}>Try Again</button>
          </div>
        ) : (
          <>
            {picked.size ? (
              <div className="slk-pickbar">
                <span>{pickedRows.length} selected</span>
                <button type="button" className="slk-link" onClick={() => setPicked(allPicked ? new Set() : new Set(left.map((f) => f.id)))}>
                  {allPicked ? 'Clear' : 'Select All'}
                </button>
              </div>
            ) : null}
            {dirs.map((d) => (
              <React.Fragment key={d.path}>
                {dirs.filter((x) => x.songs.length).length > 1 && d.songs.length ? (
                  <div className="isx-sec slk-dir"><Svg d={Ico.folder} size={11} w={2.2} />{d.path === folderRaw ? (folder.displayName || lastSeg(d.path)) : lastSeg(d.path)}<span className="ct">{d.songs.length}</span></div>
                ) : null}
                {d.songs.map((f, i) => {
                  const s = st(f);
                  const on = picked.has(f.id);
                  const focus = folder.focusId === f.id;
                  return (
                    <button key={f.id} type="button" ref={focus ? focusRef : undefined}
                      className={`slk-trk isx-in${mixed ? ' is-mixed' : ''}${on ? ' is-picked' : ''}${focus ? ' is-focus' : ''}${s === 'done' ? ' is-done' : ''}`}
                      onClick={() => { if (s !== 'done') toggle(f.id); }}
                      title={f.filename}>
                      <span className={`slk-check${on ? ' on' : ''}${s === 'done' ? ' is-off' : ''}`}>{on ? <Svg d={Ico.check} size={10} w={3.2} /> : null}</span>
                      <span className="slk-n">{f._n || i + 1}</span>
                      <span className="slk-tt">{f._title}</span>
                      {mixed ? <span className="slk-q"><Badge q={f._fq} /></span> : null}
                      <span className="slk-dur">{f.duration ? fmtSec(f.duration) : ''}</span>
                      <FileGet state={s} progress={dlProgress[`t:${f.id}`]} onGet={() => onGetFile?.({ ...f, user: f.user || folder.user })} />
                    </button>
                  );
                })}
              </React.Fragment>
            ))}
            {others.length ? (
              <div className="slk-others">
                Also in this folder: {others.slice(0, 3).map((f) => f.filename).join(', ')}
                {others.length > 3 ? ` and ${others.length - 3} more` : ''}
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

/* Styles. The panel's own classes (isx-row, isx-badge, isx-peek…) carry most
   of it, so these are only what Soulseek adds. */
const SLK_STYLES = `
.slk-bar { display: flex; align-items: center; gap: 10px; padding: 9px 18px; flex-shrink: 0; flex-wrap: wrap;
  border-bottom: 1px solid rgba(var(--st-fg-rgb), 0.07); }
.slk-status { display: inline-flex; align-items: center; gap: 8px; min-width: 0; font-size: 11.5px; font-weight: 650;
  color: rgba(var(--st-sub-rgb), 0.55); font-variant-numeric: tabular-nums; white-space: nowrap; }
.slk-tog { display: inline-flex; align-items: center; gap: 7px; flex-shrink: 0; height: 26px; padding: 0 10px; border-radius: 8px;
  cursor: pointer; font: inherit; font-size: 11px; font-weight: 700; white-space: nowrap;
  border: 1px solid rgba(var(--st-fg-rgb), 0.08); background: rgba(var(--st-fg-rgb), 0.06); color: rgba(var(--st-fg-rgb), 0.6); }
.slk-tog:hover { color: var(--st-text); }
.slk-tog.on { color: var(--st-text); border-color: rgba(var(--st-acc-rgb), 0.4); background: rgba(var(--st-acc-rgb), 0.12); }
.slk-box, .slk-check { width: 14px; height: 14px; border-radius: 4px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
  border: 1.5px solid rgba(var(--st-fg-rgb), 0.3); color: var(--st-acc-ink, #0d0f1c); box-sizing: border-box; }
.slk-tog.on .slk-box, .slk-check.on { background: rgb(var(--st-acc-rgb)); border-color: rgb(var(--st-acc-rgb)); }
.slk-check { width: 16px; height: 16px; cursor: pointer; }
.slk-check.is-off { opacity: 0.25; }
.slk-body { transition: opacity 0.2s ease; }
.slk-body.is-stale { opacity: 0.45; }
.slk-skels { padding-top: 6px; }
.slk-setup { padding-bottom: 14px; }
.slk-creds { padding: 6px 18px 4px; max-width: 460px; margin: 0 auto; }

.slk-row { position: relative; }
.slk-row:hover { background: rgba(var(--st-fg-rgb), 0.05); }
.slk-row .isx-nm { display: flex; align-items: center; gap: 8px; }
.slk-var { flex-shrink: 0; font-size: 9.5px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; padding: 2px 6px; border-radius: 5px;
  color: rgba(240,190,120,0.95); background: rgba(240,190,120,0.12); }
.slk-user { color: rgba(var(--st-sub-rgb), 0.38); }
.slk-art { flex-shrink: 0; border-radius: 9px; display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden;
  background-color: rgba(var(--st-fg-rgb), 0.05); background-size: cover; background-position: center;
  border: 1px solid rgba(var(--st-fg-rgb), 0.09); color: rgba(var(--st-fg-rgb), 0.45); box-sizing: border-box; }
.slk-art.has-art { border-color: transparent; box-shadow: 0 0 0 1px rgba(var(--st-fg-rgb), 0.08); animation: isx-artin 260ms ease both; }
.slk-hero .slk-art { border-radius: 12px; box-shadow: 0 12px 34px rgba(0,0,0,0.55); }
.slk-artq { position: absolute; left: 8px; bottom: 8px; font-size: 9px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase;
  color: rgb(140,220,160); }
.slk-copies { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; height: 24px; padding: 0 8px; border-radius: 7px; cursor: pointer;
  font-size: 11px; font-weight: 750; font-variant-numeric: tabular-nums; color: rgba(var(--st-fg-rgb), 0.6);
  background: rgba(var(--st-fg-rgb), 0.06); border: 1px solid rgba(var(--st-fg-rgb), 0.08); }
.slk-copies:hover, .slk-copies.on { color: var(--st-text); background: rgba(var(--st-fg-rgb), 0.12); }
.slk-copies.is-static { cursor: default; background: transparent; border-color: transparent; }
.slk-copies.is-static:hover { color: rgba(var(--st-fg-rgb), 0.6); background: transparent; }
.slk-openic { flex-shrink: 0; display: inline-flex; color: rgba(var(--st-fg-rgb), 0.3); transition: transform 0.14s ease, color 0.14s ease; }
.slk-row:hover .slk-openic { color: var(--st-text); transform: translateX(2px); }

.slk-copylist { margin: 2px 10px 8px 63px; padding: 4px; border-radius: 10px; background: rgba(var(--st-fg-rgb), 0.03); border: 1px solid rgba(var(--st-fg-rgb), 0.06); }
.slk-copylist.is-hero { margin: 14px 0 0; }
.slk-copyhead { padding: 6px 8px 4px; font-size: 9.5px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(var(--st-fg-rgb), 0.3); }
.slk-copy { display: flex; align-items: center; gap: 9px; width: 100%; min-width: 0; padding: 8px; border-radius: 8px; border: none; background: transparent;
  cursor: pointer; font: inherit; font-size: 11px; color: rgba(var(--st-sub-rgb), 0.5); text-align: left; }
.slk-copy:hover { background: rgba(var(--st-fg-rgb), 0.06); }
.slk-copy b { font-size: 12px; font-weight: 650; color: var(--st-text); white-space: nowrap; }
.slk-copy .isx-mi { white-space: nowrap; }
.slk-copyname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; color: rgba(var(--st-sub-rgb), 0.32); }
.slk-copyopen { flex-shrink: 0; font-weight: 700; color: rgb(var(--st-acc-rgb)); opacity: 0; transition: opacity 0.12s ease; }
.slk-copy:hover .slk-copyopen { opacity: 1; }
.slk-src { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 8px; }
.slk-src:hover { background: rgba(var(--st-fg-rgb), 0.04); }
.slk-srcmain { flex: 1; min-width: 0; }
.slk-srchead { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; font-size: 11px; color: rgba(var(--st-sub-rgb), 0.5); }
.slk-srchead b { font-size: 12px; font-weight: 650; color: var(--st-text); }
.slk-src .isx-path { margin-top: 4px; }
.slk-more { display: block; margin: 4px 10px 6px; padding: 7px 10px; border-radius: 8px; border: none; background: transparent; cursor: pointer;
  font: inherit; font-size: 11.5px; font-weight: 700; color: rgba(var(--st-fg-rgb), 0.5); }
.slk-more:hover { color: var(--st-text); background: rgba(var(--st-fg-rgb), 0.05); }

.slk-get { width: 28px; height: 28px; flex-shrink: 0; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid rgba(var(--st-acc-rgb), 0.4); background: rgba(var(--st-acc-rgb), 0.16); color: rgb(var(--st-acc-rgb)); box-sizing: border-box; }
.slk-get:hover { background: rgba(var(--st-acc-rgb), 0.28); }
.slk-get.is-retry { border-color: rgba(240,140,130,0.45); background: rgba(240,140,130,0.12); color: rgb(240,150,140); }
.slk-done { width: 28px; height: 28px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; color: rgba(140,220,160,0.95); }
.slk-fprog { width: 64px; flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; }
.slk-fpct { font-size: 9.5px; font-weight: 650; color: rgba(var(--st-sub-rgb), 0.5); font-variant-numeric: tabular-nums; }

.slk-hero .isx-peektitle { overflow-wrap: anywhere; }
.slk-facts { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
.slk-fact { font-size: 11px; font-weight: 650; color: rgba(var(--st-sub-rgb), 0.45); }
.slk-hero .isx-peekacts { display: flex; align-items: center; flex-wrap: wrap; }
.slk-hero .isx-get.is-big { display: inline-flex; align-items: center; }
.slk-hero .isx-get[disabled] { opacity: 0.5; cursor: default; }
.isx-ghost.slk-on { background: rgba(var(--st-fg-rgb), 0.14); color: var(--st-text); }
.slk-albprog { display: flex; flex-direction: column; gap: 6px; min-width: 240px; max-width: 420px; flex: 1; }
.slk-albprog .isx-prog-bar { height: 6px; }
.slk-albtxt { font-size: 12px; font-weight: 650; color: rgba(var(--st-sub-rgb), 0.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.slk-alldone { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 700; color: rgba(140,220,160,0.95); }
.slk-hero .isx-cov .isx-ghost { margin-left: auto; }
.slk-hero .isx-cov > span { flex: 1 1 240px; min-width: 0; line-height: 1.5; }

.slk-trk { display: grid; grid-template-columns: 16px 24px minmax(0,1fr) 46px 64px; gap: 12px; align-items: center; }
.slk-trk.is-mixed { grid-template-columns: 16px 24px minmax(0,1fr) auto 46px 64px; }
.slk-trk { width: 100%; padding: 9px 12px; border-radius: 10px; border: none; background: transparent; color: inherit; text-align: left; cursor: pointer; font-family: inherit; }
.slk-trk:hover { background: rgba(var(--st-fg-rgb), 0.05); }
.slk-trk.is-picked { background: rgba(var(--st-acc-rgb), 0.12); }
.slk-trk.is-focus { box-shadow: inset 0 0 0 1px rgba(var(--st-acc-rgb), 0.45); }
.slk-trk.is-done { cursor: default; }
.slk-trk.is-done .slk-tt { color: rgba(var(--st-text-rgb, 255,255,255), 0.5); font-weight: 500; }
.slk-trk > .slk-get, .slk-trk > .slk-done, .slk-trk > .slk-fprog { justify-self: end; }
/* One download button per song is a lot of buttons: they show on the song
   you point at. A song downloading, done or failed always shows its state. */
.slk-trk > .slk-get:not(.is-retry) { opacity: 0; transition: opacity 0.12s ease; }
.slk-trk:hover > .slk-get, .slk-trk:focus-visible > .slk-get { opacity: 1; }
.slk-tracks .isx-body, .slk-tracks { padding-bottom: 16px; }
/* The box only shows once you point at a song or start picking. */
.slk-trk .slk-check { opacity: 0; transition: opacity 0.12s ease; }
.slk-trk:hover .slk-check, .slk-tracks.is-picking .slk-check, .slk-trk .slk-check.on { opacity: 1; }
.slk-trk:hover .slk-check.is-off, .slk-tracks.is-picking .slk-check.is-off { opacity: 0.25; }
.slk-pickbar { display: flex; align-items: center; gap: 12px; padding: 6px 12px 8px; font-size: 11.5px; font-weight: 650; color: rgba(var(--st-sub-rgb), 0.55); }
.slk-link { border: none; background: none; padding: 0; cursor: pointer; font: inherit; color: rgb(var(--st-acc-rgb)); }
.slk-link:hover { text-decoration: underline; text-underline-offset: 2px; }
.slk-n { text-align: center; font-size: 13px; color: rgba(var(--st-fg-rgb), 0.32); font-variant-numeric: tabular-nums; }
.slk-tt { min-width: 0; font-size: 14px; font-weight: 600; color: var(--st-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.slk-q { display: inline-flex; justify-content: flex-end; }
.slk-dur { text-align: right; font-size: 12.5px; color: rgba(var(--st-sub-rgb), 0.45); font-variant-numeric: tabular-nums; white-space: nowrap; }
.slk-wait { flex-shrink: 0; font-size: 10.5px; font-weight: 700; color: rgba(240,190,120,0.85); white-space: nowrap; }
.slk-dir { padding-top: 14px; }
.slk-dir svg { margin-right: -2px; }
.slk-others { margin: 10px 12px 4px; font-size: 11.5px; line-height: 1.5; color: rgba(var(--st-sub-rgb), 0.35); }

/* Narrow windows: size goes first, then the format column folds into the row. */
@media (max-width: 760px) {
  .slk-trk, .slk-trk.is-mixed { gap: 10px; }
  .slk-copyname { display: none; }
  .slk-bar .isx-lookseg button { padding: 3px 7px; }
}
@media (max-width: 560px) {
  .slk-hero .slk-art { width: 96px !important; height: 96px !important; }
  .slk-hero .isx-peektitle { font-size: 22px; }
}
[data-dark] .slk-tog, [data-dark] .slk-copies:not(.is-static) { background: rgb(21,21,24); border-color: rgba(255,255,255,0.07); }
.isx-panel.has-look .slk-tog { background: rgba(0,0,0,0.18); border-color: rgba(255,255,255,0.1); }
@media (prefers-reduced-motion: reduce) { .slk-art.has-art { animation: none; } .slk-openic { transition: none; } }
`;

export function SoulseekStyles() {
  return <style>{SLK_STYLES}</style>;
}
