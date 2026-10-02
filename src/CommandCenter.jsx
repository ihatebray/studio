import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { formatTime, titleCollator } from './mediaUtils.js';
import { DownloadProgressBar, useDownloadProgress, VideoPicker, PlayIcon } from './sharedUI.jsx';
import { useToast } from './Toasts.jsx';

/* =========================================================================
 *  CommandCenter — the movable, resizable card + its parallax icon rail.
 *
 *  Extracted VERBATIM from CoverFullscreenOverlay so both the overlay and
 *  the expanded Now Playing stage render the identical component rather
 *  than two copies that drift. (Two copies of one piece of lyrics state
 *  already cost us a "saves vanish" bug; this is sixty-four pieces.)
 *
 *  WHAT LIVES HERE: the card, the rail, tab content (Library / Find &
 *  Download / Releases / Stats), the virtualised library list, drag +
 *  resize + their persistence, and every animation that belongs to the
 *  card itself — card in/out, menu in/out, icon cascade, indicator glide,
 *  tab transitions.
 *
 *  WHAT DOESN'T: the surface choreography around it. Opening the card
 *  makes the overlay fly its big cover into a mini header via a ghost-FLIP
 *  that measures that surface's own geometry. The expanded Now Playing
 *  stage has different geometry (380px art column at 44%, lyrics at 56%),
 *  so it supplies its own flight. Hence `open`/`exiting` come in as props.
 * ========================================================================= */

function FsEqBadge({ accent, playing = true }) {
  return (
    <span aria-label="Now playing" title="Now playing"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 2.5, height: 14, flexShrink: 0, verticalAlign: 'middle' }}>
      {[0, 1, 2].map((i) => (
        <span key={i} style={{
          width: 2.5, height: 5, borderRadius: 2,
          background: `rgb(${accent})`,
          boxShadow: `0 0 6px rgba(${accent}, 0.6)`,
          animation: playing ? `immerseFsEqBar 0.9s ease ${i * 0.18}s infinite` : 'none',
        }} />
      ))}
    </span>
  );
}

/**
 * Download button / inline progress bar for the command-center find rows.
 * TOP-LEVEL on purpose: a stable component identity means React updates the
 * existing DOM node across the overlay's frequent playback re-renders instead
 * of remounting it — keeping the progress animation running smoothly and the
 * button clickable mid-render.
 */
function DlBtn({ st, progress, accent, onClick, title: t }) {
  if (st === 'busy') {
    const pct = typeof progress?.pct === 'number' ? progress.pct : null;
    return (
      <div title={progress?.phase === 'processing' ? 'Processing…' : 'Downloading…'} style={{ width: 52, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
        <DownloadProgressBar pct={pct} accent={accent} height={5} />
      </div>
    );
  }
  return (
    <button type="button" title={st === 'failed' ? 'Retry' : t}
      disabled={st === 'done'}
      onClick={onClick}
      style={{
        width: 26, height: 26, borderRadius: 8, flexShrink: 0, border: 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: st === 'done' ? 'default' : 'pointer',
        background: st === 'done' ? `rgba(${accent},0.3)` : 'rgba(255,255,255,0.07)',
        color: st === 'failed' ? '#f0a0a0' : st === 'done' ? '#fff' : 'rgba(255,255,255,0.65)',
        transition: 'background 0.2s ease, color 0.2s ease',
      }}>
      {st === 'done' ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
      )}
    </button>
  );
}

export default function CommandCenter({
  /* ── Host-owned open state ────────────────────────────────────────────
   * `open` lives in the HOST, not here. Opening the command center
   * re-choreographs the surface around it (the overlay flies its cover up
   * into a mini header and reflows the lyrics column), and that
   * choreography measures host geometry. So the host owns open/exiting and
   * its own flight; this component owns everything inside the card. */
  open = false,
  exiting = false,
  onRequestClose,
  variant = 'rail',              // 'rail' | 'centered' — wrapper sizing only
  /* Which tabs the rail shows. Defaults to the four portable ones. The
     overlay's old fifth tab was a settings panel for ITS layout (auto-hide
     dock, centered mode, transition style) — surface config, not card
     config — so it isn't here. A host that needs one supplies it. */
  sections = [
    ['library', 'Library', 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm12-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'],
    ['find', 'Find & Download', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3'],
    ['releases', 'Releases', 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm4.2-14.2l-2.1 6.3-6.3 2.1 2.1-6.3 6.3-2.1z'],
    ['stats', 'Discover', 'M4 20V10M10 20V4M16 20v-7M22 20H2'],
  ],

  /* ── Data ─────────────────────────────────────────────────────────── */
  library = [],
  playEvents = [],
  releases = [],
  releasesRefreshing = false,
  albumCoverOverrides = {},
  currentTrack = null,
  currentTrackId = null,         // id of the playing track — marks the row and
                                 // drives the "already owned" download checks
  isPlaying = false,
  followedArtists = [],

  /* ── Appearance ───────────────────────────────────────────────────── */
  accent = '120, 120, 120',
  reduceMotion = false,
  beat = 0,

  /* ── Callbacks ────────────────────────────────────────────────────── */
  onSelectTrack,
  onPlayTrack,
  onTrackImported,
  onRefreshReleases,
  onFollowArtist,
  onUnfollowArtist,
  onUpdateTrackMetadata,
  onUpdateAlbumMetadata,
  onRemoveFromLibrary,
  /* The card opens the host's dialogs rather than owning them — each
   * surface already has its own metadata editor and confirm chrome. */
  onEditTrackMeta,               // (track) → host opens MetadataEditor
  onEditAlbumMeta,               // (albumData, scope) → host opens AlbumMetadataEditor
  onConfirm,                     // ({ title, body, confirmLabel, onConfirm })
  onMenu,                        // ({ x, y, items }) → host renders a context menu
  onReturnFocus,                 // () → host refocuses its dialog when the card
                                 // closes. Without it focus stays stuck on the
                                 // hidden search field and the host's key
                                 // handlers stop firing until you click back in.
  onResetStats,                  // () → clears all listening history and counts
  notify = () => {},             // (ok, msg) → host's transient toast. The card
                                 // reports download success/failure through this
                                 // rather than owning toast chrome, so each
                                 // surface shows it in its own style.
}) {
  // track without leaving fullscreen.
  // `open` is host-owned (see header). Alias kept so the ~50 internal
  // references below read unchanged from the original.
  const libraryOpen = open;
  const [librarySearch, setLibrarySearch] = useState('');
  const [librarySelIndex, setLibrarySelIndex] = useState(0);
  const librarySearchRef = useRef(null);
  const libraryListRef = useRef(null);
  const prevLibOpenRef = useRef(false);
  const canBrowse = Array.isArray(library) && library.length > 0 && typeof onSelectTrack === 'function';

  // --- Search card tabs -------------------------------------------------
  // The card is a mini command center now: Library (search + full list),
  // Releases (a compact view of the Explore feed), Stats (recent listening
  // pulled from playEvents), Settings (fullscreen layout picker).
  const [cardTab, setCardTab] = useState('library');
  const [resetStatsOpen, setResetStatsOpen] = useState(false);
  const [resettingStats, setResettingStats] = useState(false);
  useEffect(() => { if (libraryOpen) setCardTab('library'); }, [libraryOpen]);
  useEffect(() => {
    if (cardTab !== 'stats') setResetStatsOpen(false);
  }, [cardTab]);

  const handleResetStats = useCallback(async () => {
    if (resettingStats || typeof onResetStats !== 'function') return;
    setResettingStats(true);
    try {
      const result = await onResetStats();
      if (result?.ok) {
        setResetStatsOpen(false);
        notify(true, 'Listening stats reset to zero.');
      } else {
        notify(false, result?.error || 'Could not reset listening stats.');
      }
    } catch (error) {
      notify(false, error?.message || 'Could not reset listening stats.');
    } finally {
      setResettingStats(false);
    }
  }, [notify, onResetStats, resettingStats]);
  // Coming back to Library from another section: the input is a brand-new
  // node, so it needs focus again (and the highlight should start at the top).
  useEffect(() => {
    if (!libraryOpen || cardTab !== 'library') return undefined;
    setLibrarySelIndex(0);
    const id = setTimeout(() => librarySearchRef.current?.focus(), 60);
    return () => clearTimeout(id);
  }, [cardTab, libraryOpen]);
  // Centered mode has no ghost flight to cover the card's exit — keep the
  // card mounted briefly so its Out animation can play. Rail mode needs the
  // same thing: it used to stay mounted only because a cover ghost happened
  // to exist, so any close without a ghost (or with a failed measurement)
  // yanked the card out of the DOM with no exit at all. cardExiting now owns
  // the exit in BOTH modes — the ghost is irrelevant to it.
  const [cardExiting, setCardExiting] = useState(false);
  const cardExitTimerRef = useRef(null);
  useEffect(() => () => { if (cardExitTimerRef.current) clearTimeout(cardExitTimerRef.current); }, []);
  // The close choreography, in reverse order of the entrance (which goes
  // card → menu → icons). Everything lands at 420ms, exactly when the
  // artwork touches back down in the center.
  const CARD_EXIT_MS = 260;

  // --- Movable command center ------------------------------------------
  // The card can be dragged anywhere on screen by its grip strip; the
  // offset persists across sessions. Double-click the grip to snap home
  // (animated). The translate lives on a WRAPPER, not the card itself —
  // the card's enter/exit keyframes fill their transform, which would
  // silently override an inline translate on the same element.
  const [cardOffset, setCardOffset] = useState(() => {
    try {
      const raw = window.localStorage.getItem('immerse:fsCardOffset');
      if (raw) {
        const v = JSON.parse(raw);
        if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) return { x: v.x, y: v.y };
      }
    } catch { /* ignore */ }
    return { x: 0, y: 0 };
  });
  const cardDragRef = useRef(null);
  const persistCardOffset = useCallback((off) => {
    try { window.localStorage.setItem('immerse:fsCardOffset', JSON.stringify(off)); } catch { /* ignore */ }
  }, []);
  const handleCardGripDown = useCallback((e) => {
    if (e.button !== 0) return;
    const cardEl = e.currentTarget.parentElement;
    if (!cardEl) return;
    const rect = cardEl.getBoundingClientRect();
    // Bounds keep the whole card on screen with a 12px margin.
    cardDragRef.current = {
      startX: e.clientX, startY: e.clientY,
      baseX: cardOffset.x, baseY: cardOffset.y,
      // +58: the docked side menu extends left of the card and must stay
      // on screen too.
      minX: cardOffset.x - rect.left + 12 + 58,
      maxX: cardOffset.x + (window.innerWidth - rect.right) - 12,
      minY: cardOffset.y - rect.top + 12,
      maxY: cardOffset.y + (window.innerHeight - rect.bottom) - 12,
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }, [cardOffset]);
  const handleCardGripMove = useCallback((e) => {
    const d = cardDragRef.current;
    if (!d) return;
    setCardOffset({
      x: Math.min(d.maxX, Math.max(d.minX, d.baseX + (e.clientX - d.startX))),
      y: Math.min(d.maxY, Math.max(d.minY, d.baseY + (e.clientY - d.startY))),
    });
  }, []);
  const handleCardGripUp = useCallback(() => {
    if (!cardDragRef.current) return;
    cardDragRef.current = null;
    setCardOffset((off) => { persistCardOffset(off); return off; });
  }, [persistCardOffset]);
  const resetCardOffset = useCallback(() => {
    setCardOffset({ x: 0, y: 0 });
    persistCardOffset({ x: 0, y: 0 });
  }, [persistCardOffset]);

  // --- Resizable command center ------------------------------------------
  // Drag the bottom-right grip to size the card freely; null means "default"
  // (the cover's square). The size persists like the offset does. The slot
  // stays CENTER-anchored, so the rail — which spans the card's height and
  // flex-centers itself — keeps riding the vertical middle at any size.
  const [cardSize, setCardSize] = useState(() => {
    try {
      const raw = window.localStorage.getItem('immerse:fsCardSize');
      if (raw) {
        const v = JSON.parse(raw);
        if (v && Number.isFinite(v.w) && Number.isFinite(v.h)) return { w: v.w, h: v.h };
      }
    } catch { /* ignore */ }
    return null;
  });
  const cardResizeRef = useRef(null);
  const persistCardSize = useCallback((sz) => {
    try {
      if (sz) window.localStorage.setItem('immerse:fsCardSize', JSON.stringify(sz));
      else window.localStorage.removeItem('immerse:fsCardSize');
    } catch { /* ignore */ }
  }, []);
  const handleCardResizeDown = useCallback((e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const cardEl = e.currentTarget.parentElement;
    const rect = cardEl?.getBoundingClientRect();
    if (!rect) return;
    cardResizeRef.current = { startX: e.clientX, startY: e.clientY, baseW: rect.width, baseH: rect.height };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);
  const handleCardResizeMove = useCallback((e) => {
    const d = cardResizeRef.current;
    if (!d) return;
    // The card is center-anchored, so both edges move when it grows — 2×
    // the pointer delta keeps the grip tracking under the cursor.
    setCardSize({
      w: Math.round(Math.min(window.innerWidth - 130, Math.max(300, d.baseW + (e.clientX - d.startX) * 2))),
      h: Math.round(Math.min(window.innerHeight - 60, Math.max(320, d.baseH + (e.clientY - d.startY) * 2))),
    });
  }, []);
  const handleCardResizeUp = useCallback(() => {
    if (!cardResizeRef.current) return;
    cardResizeRef.current = null;
    setCardSize((sz) => { persistCardSize(sz); return sz; });
  }, [persistCardSize]);
  const resetCardSize = useCallback(() => { setCardSize(null); persistCardSize(null); }, [persistCardSize]);

  const listeningStats = useMemo(() => {
    if (!libraryOpen || cardTab !== 'stats') return null;
    const now = Date.now();
    const DAY = 86400000;
    const libMap = new Map(library.map((t) => [t.id, t]));
    const trackCounts = new Map();
    const artistCounts = new Map();
    let plays7 = 0;
    let plays30 = 0;
    let listenMs30 = 0;
    for (const ev of playEvents || []) {
      const age = now - (ev?.at || 0);
      if (age > 30 * DAY) continue;
      plays30 += 1;
      if (age <= 7 * DAY) plays7 += 1;
      const t = libMap.get(ev.id);
      if (t?.duration) listenMs30 += t.duration * 1000;
      trackCounts.set(ev.id, (trackCounts.get(ev.id) || 0) + 1);
      const a = t?.artist;
      if (a) artistCounts.set(a, (artistCounts.get(a) || 0) + 1);
    }
    const topTracks = [...trackCounts.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([id, n]) => ({ track: libMap.get(id), n }))
      .filter((x) => x.track);
    const topArtists = [...artistCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    return { plays7, plays30, hours30: listenMs30 / 3600000, topTracks, topArtists };
  }, [libraryOpen, cardTab, playEvents, library]);


  // --- Find & Download --------------------------------------------------
  // Three modes, same as the main Find tab:
  //   • Songs    — Spotify catalogue tracks, fetched via the yt-dlp matcher.
  //   • Albums   — Spotify catalogue albums; open one for its tracklist and
  //                grab the whole thing or pick songs off it.
  //   • Soulseek — raw peer files, downloaded + imported in the main process.
  // The choice persists so the card opens on whichever you actually use.
  const [findSource, setFindSource] = useState(() => {
    try {
      const v = window.localStorage.getItem('immerse:fsFindSource');
      return (v === 'soulseek' || v === 'albums') ? v : 'spotify';
    } catch { return 'spotify'; }
  });
  const [findQuery, setFindQuery] = useState('');
  const [findBusy, setFindBusy] = useState(false);
  const [findResults, setFindResults] = useState([]);
  const [findError, setFindError] = useState('');
  const [dlState, setDlState] = useState({}); // key → 'busy' | 'done' | 'failed'
  const markDl = useCallback((k, v) => setDlState((m) => ({ ...m, [k]: v })), []);
  const pushToast = useToast();
  const { dlProgress } = useDownloadProgress();
  /** Surface the real reason a download failed, in a toast. */
  const toastError = useCallback((msg, fallback) => {
    pushToast?.({ message: String(msg || fallback || 'Download failed.'), kind: 'error', durationMs: 7000 });
  }, [pushToast]);
  // Manual YouTube video picker for imports that fail automatic matching.
  // Portals above this fullscreen overlay (older builds punted on this).
  const [pick, setPick] = useState(null); // { meta, seed, dlKey } | null
  const openPicker = useCallback((meta, res, dlKey) => {
    // A failed Save (not signed in, no Spotify match) has no video to pick.
    if (res?.noPicker) { toastError(res.error, `Couldn't save "${meta?.title || 'this track'}".`); return; }
    setPick({ meta, seed: res && Array.isArray(res.candidates) ? res.candidates : null, dlKey });
  }, [toastError]);
  // Catalogue-album expansion (Find → Albums)
  const [openFindAlbum, setOpenFindAlbum] = useState(null);
  const [findAlbumTracks, setFindAlbumTracks] = useState({});
  const [findAlbumBusy, setFindAlbumBusy] = useState({});
  const pickFindSource = useCallback((s) => {
    setFindSource(s);
    setFindResults([]); setFindError(''); setOpenFindAlbum(null);
    setFindSsAlbums([]); setOpenFindSsAlbum(null);
    try { window.localStorage.setItem('immerse:fsFindSource', s); } catch { /* ignore */ }
  }, []);

  // "Do I already own this?" — title + primary artist, same normalisation the
  // New Releases tab uses, so ownership ticks agree across the app.
  const primaryArtistOf = (s) => (s ? String(s).split(/,|feat\.|ft\.|&|\bx\b/i)[0].trim().toLowerCase() : '');
  const ownedKeys = useMemo(() => {
    const set = new Set();
    for (const t of library || []) {
      if (t?.title) set.add(`${String(t.title).trim().toLowerCase()}|${primaryArtistOf(t.artist)}`);
    }
    return set;
  }, [library]);
  const alreadyOwned = useCallback(
    (title, artist) => ownedKeys.has(`${String(title || '').trim().toLowerCase()}|${primaryArtistOf(artist)}`),
    [ownedKeys],
  );

  // Soulseek album folders — grouped by soulseekClient in the main process
  // (same uploader + folder, quality-ranked). Expanded/collapsed per id;
  // whole-album downloads stream aggregate progress events.
  const [findSsAlbums, setFindSsAlbums] = useState([]);
  const [openFindSsAlbum, setOpenFindSsAlbum] = useState(null);
  const [findSsAlbumProg, setFindSsAlbumProg] = useState({}); // albumId → { completed, total }
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    const off = api?.onSoulseekAlbumProgress?.((pl) => {
      if (!pl?.albumId) return;
      setFindSsAlbumProg((m) => ({ ...m, [pl.albumId]: pl }));
    });
    return () => { try { off?.(); } catch { /* ignore */ } };
  }, []);

  /** Whole soulseek album folder → sequential download in the main process. */
  const downloadFindSsAlbum = useCallback(async (alb) => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.soulseekDownloadAlbum) return;
    const key = `ssa:${alb.id}`;
    if (dlState[key] === 'busy') return;
    markDl(key, 'busy');
    try {
      const res = await api.soulseekDownloadAlbum({ albumId: alb.id, tracks: alb.tracks });
      const got = Array.isArray(res?.tracks) ? res.tracks : [];
      for (const t of got) onTrackImported?.(t);
      markDl(key, got.length ? 'done' : 'failed');
      notify(got.length > 0, got.length
        ? `Saved “${alb.displayName}” (${got.length} ${got.length === 1 ? 'track' : 'tracks'})`
        : `Couldn’t download “${alb.displayName}”`);
      if (!got.length) toastError(res?.error, `Couldn’t download “${alb.displayName}”.`);
      else if (res?.partial) pushToast?.({ message: res.error || `Some tracks on “${alb.displayName}” couldn’t be downloaded.`, kind: 'warning', durationMs: 7000 });
    } catch (e) {
      markDl(key, 'failed');
      notify(false, 'Album download failed');
      toastError(e?.message || e, `Couldn’t download “${alb.displayName}”.`);
    }
  }, [dlState, markDl, onTrackImported, notify, pushToast, toastError]);

  const runFind = useCallback(async () => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    const q = findQuery.trim();
    if (!q || findBusy) return;
    setFindBusy(true); setFindError(''); setFindResults([]); setOpenFindAlbum(null);
    setFindSsAlbums([]); setOpenFindSsAlbum(null);
    try {
      if (findSource === 'spotify') {
        if (!api?.spotifySearch) { setFindError('Spotify search isn’t available — add your credentials in Settings.'); setFindBusy(false); return; }
        const list = await api.spotifySearch(q);
        const rows = Array.isArray(list) ? list.slice(0, 40) : [];
        setFindResults(rows);
        if (!rows.length) setFindError('No tracks found.');
      } else if (findSource === 'albums') {
        if (!api?.spotifySearchAlbums) { setFindError('Album search isn’t available — add your Spotify credentials in Settings.'); setFindBusy(false); return; }
        const list = await api.spotifySearchAlbums(q);
        const rows = Array.isArray(list) ? list.slice(0, 40) : [];
        setFindResults(rows);
        if (!rows.length) setFindError('No albums found.');
      } else {
        if (!api?.soulseekSearch) { setFindError('Soulseek isn’t available — configure it in Settings.'); setFindBusy(false); return; }
        const res = await api.soulseekSearch(q);
        if (res?.ok === false) { setFindError(res.error || 'Soulseek search failed.'); setFindBusy(false); return; }
        const rows = Array.isArray(res?.results) ? res.results.slice(0, 30) : [];
        const albs = Array.isArray(res?.albums) ? res.albums : [];
        setFindResults(rows);
        setFindSsAlbums(albs);
        if (!rows.length && !albs.length) setFindError('No results — try fewer words.');
      }
    } catch (e) {
      setFindError(String(e?.message || e));
    }
    setFindBusy(false);
  }, [findQuery, findBusy, findSource]);

  /** Spotify row → yt-dlp import. Mirrors FindTab's importSingle. */
  const downloadSpotifyRow = useCallback(async (row, opts = {}) => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.importFromYoutubeSearch) return;
    const key = `s:${row.spotifyId}`;
    const meta = {
      title: row.title, artists: row.artists, album: row.album || '',
      albumArtUrl: row.albumArtUrl || '', durationMs: row.durationMs ?? 0,
      spotifyId: row.spotifyId, trackNumber: row.trackNumber ?? null,
      discNumber: row.discNumber ?? null, explicit: row.explicit,
    };
    markDl(key, 'busy');
    try {
      const res = await api.importFromYoutubeSearch({ ...meta, progressId: key });
      if (res?.ok && res.track) {
        onTrackImported?.(res.track);
        markDl(key, 'done');
        notify(true, `Added “${row.title}” to your library`);
      } else {
        // Automatic matching failed — let the user choose the video. The picker
        // portals above this fullscreen overlay. In a batch we stay quiet and
        // leave the row retryable (retrying opens the picker).
        markDl(key, 'failed');
        if (opts.noPicker) { notify(false, `No clean match for “${row.title}”`); toastError(res?.error, `Couldn’t download “${row.title}”.`); }
        else openPicker(meta, res, key);
      }
    } catch (e) {
      markDl(key, 'failed');
      notify(false, 'Download failed');
      toastError(e?.message || e, `Couldn’t download “${row.title}”.`);
    }
  }, [onTrackImported, markDl, notify, toastError, openPicker]);

  /** Catalogue album → its tracklist (cached per albumId). */
  const toggleFindAlbum = useCallback(async (alb) => {
    const id = alb.albumId;
    setOpenFindAlbum((cur) => (cur === id ? null : id));
    if (findAlbumTracks[id] || findAlbumBusy[id]) return;
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.spotifyGetAlbumTracks) return;
    setFindAlbumBusy((m) => ({ ...m, [id]: true }));
    try {
      const res = await api.spotifyGetAlbumTracks(id);
      setFindAlbumTracks((m) => ({ ...m, [id]: Array.isArray(res?.tracks) ? res.tracks : [] }));
    } catch { /* the row just stays empty rather than exploding */ }
    setFindAlbumBusy((m) => ({ ...m, [id]: false }));
  }, [findAlbumTracks, findAlbumBusy]);

  /** Whole catalogue album — everything you don't already own, one at a time. */
  const downloadFindAlbum = useCallback(async (alb) => {
    const id = alb.albumId;
    const key = `sa:${id}`;
    markDl(key, 'busy');
    let tracks = findAlbumTracks[id];
    if (!tracks) {
      const api = typeof window !== 'undefined' ? window.electronAPI : null;
      try {
        const res = await api?.spotifyGetAlbumTracks?.(id);
        tracks = Array.isArray(res?.tracks) ? res.tracks : [];
        setFindAlbumTracks((m) => ({ ...m, [id]: tracks }));
      } catch { tracks = []; }
    }
    if (!tracks.length) {
      markDl(key, 'failed');
      notify(false, `Couldn’t load “${alb.name}”`);
      return;
    }
    const missing = tracks.filter((t) => !alreadyOwned(t.title, t.artists));
    if (!missing.length) {
      markDl(key, 'done');
      notify(true, 'You already have every track on this one');
      return;
    }
    notify(true, `Downloading “${alb.name}” — ${missing.length} track${missing.length === 1 ? '' : 's'}…`);
    for (const t of missing) {
      // eslint-disable-next-line no-await-in-loop
      await downloadSpotifyRow(t, { noPicker: true });
    }
    markDl(key, 'done');
    notify(true, `Finished “${alb.name}”`);
  }, [findAlbumTracks, alreadyOwned, downloadSpotifyRow, markDl, notify]);

  const downloadSoulseekRow = useCallback(async (row) => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.soulseekDownload) return;
    const key = `t:${row.id}`;
    markDl(key, 'busy');
    try {
      const res = await api.soulseekDownload({
        id: row.id, user: row.user, filePath: row.filePath,
        size: row.size, bitrate: row.bitrate, filename: row.filename,
      });
      if (res?.ok && res.track) {
        onTrackImported?.(res.track);
        markDl(key, 'done');
        notify(true, `Added “${res.track.title || row.filename}” to your library`);
      } else {
        markDl(key, 'failed');
        notify(false, `Couldn’t download “${row.filename}”`);
        toastError(res?.error, `Couldn’t download “${row.filename}”.`);
      }
    } catch (e) {
      markDl(key, 'failed');
      notify(false, 'Download failed');
      toastError(e?.message || e, `Couldn’t download “${row.filename}”.`);
    }
  }, [onTrackImported, markDl, notify, toastError]);

  // --- Library → Albums ---------------------------------------------------
  // The Library section has the same two views as the main library page:
  // Songs (the flat list) and Albums (tiles → album detail). The grouping,
  // sorting and cover-override handling below are lifted from LibraryTab so
  // the two views agree on what an "album" is, right down to which ones are
  // hidden (singles) and what art each tile shows.
  const [libraryView, setLibraryView] = useState('songs'); // 'songs' | 'albums'
  const [openAlbum, setOpenAlbum] = useState(null);        // album key

  const libraryAlbums = useMemo(() => {
    const primaryArtist = (str) => {
      if (!str) return 'Unknown Artist';
      const clean = str.split(/,|feat\.|ft\.|&|\bx\b/i)[0].trim();
      return clean || str.trim();
    };
    // Disc asc → track asc → (both untagged) added-at order → title. Same
    // comparator as the main view, which matters for batch-downloaded albums
    // whose files carry no track tags.
    const compareTracks = (a, b) => {
      const da = a.discNumber != null ? a.discNumber : 1;
      const db = b.discNumber != null ? b.discNumber : 1;
      if (da !== db) return da - db;
      const aHas = a.trackNumber != null;
      const bHas = b.trackNumber != null;
      if (aHas && bHas) {
        if (a.trackNumber !== b.trackNumber) return a.trackNumber - b.trackNumber;
      } else if (aHas !== bHas) {
        return aHas ? -1 : 1;
      } else {
        const aa = Number(a.addedAt) || 0;
        const bb = Number(b.addedAt) || 0;
        if (aa !== bb) return aa - bb;
      }
      return titleCollator.compare(String(a.title || ''), String(b.title || ''));
    };

    const map = new Map();
    for (const t of library || []) {
      const albumName = (t.album || '').trim() || 'Unknown Album';
      const primary = primaryArtist(t.artist);
      const key = `${albumName}__${primary}`;
      if (!map.has(key)) {
        map.set(key, { key, album: albumName, artist: primary, coverArt: null, tracks: [], discSet: new Set() });
      }
      const entry = map.get(key);
      if (!entry.coverArt && t.coverArt) entry.coverArt = t.coverArt;
      entry.discSet.add(t.discNumber != null ? t.discNumber : 1);
      entry.tracks.push(t);
    }
    for (const entry of map.values()) {
      entry.tracks.sort(compareTracks);
      entry.discs = [...entry.discSet].sort((a, b) => a - b);
      entry.hasMultipleDiscs = entry.discs.length >= 2;
      // Pinned album art wins over the track-derived cover — exactly what the
      // album tiles in the main view render.
      entry.displayCover = albumCoverOverrides[entry.key] || entry.coverArt;
      entry.duration = entry.tracks.reduce((n, t) => n + (t.duration || 0), 0);
    }
    return [...map.values()]
      // Singles stay in Songs view only — same rule as the main view.
      .filter((a) => a.tracks.length >= 2)
      .sort((a, b) => titleCollator.compare(a.album, b.album) || titleCollator.compare(a.artist, b.artist));
  }, [library, albumCoverOverrides]);

  const filteredAlbums = useMemo(() => {
    const q = librarySearch.trim().toLowerCase();
    if (!q) return libraryAlbums;
    return libraryAlbums.filter((a) => a.album.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q));
  }, [libraryAlbums, librarySearch]);

  const openAlbumData = useMemo(
    () => (openAlbum ? libraryAlbums.find((a) => a.key === openAlbum) || null : null),
    [libraryAlbums, openAlbum],
  );
  // With an album open, the search box searches WITHIN it — same as the main
  // view ("Search in {album}…").
  const openAlbumTracks = useMemo(() => {
    if (!openAlbumData) return [];
    const q = librarySearch.trim().toLowerCase();
    if (!q) return openAlbumData.tracks;
    return openAlbumData.tracks.filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(q));
  }, [openAlbumData, librarySearch]);

  // An album that disappears underneath us (last track removed) shouldn't
  // strand the detail view.
  useEffect(() => {
    if (openAlbum && !libraryAlbums.some((a) => a.key === openAlbum)) setOpenAlbum(null);
  }, [libraryAlbums, openAlbum]);

  // Switching view or opening an album clears the query, as in the main view.
  const pickLibraryView = useCallback((v) => {
    setLibraryView(v);
    setOpenAlbum(null);
    setLibrarySearch('');
  }, []);

  // --- Releases ----------------------------------------------------------
  // Same pipeline as the New Releases tab: iTunes for the tracklist
  // (lookupReleaseAlbumTracks), yt-dlp for the audio (importFromYoutubeSearch).
  // The old fullscreen version tried to guess an album off Soulseek, which is
  // why it rarely produced anything. Rows expand into their tracklist, each
  // track downloads on its own, and the album button grabs everything you
  // don't already own.
  const [expandedRelease, setExpandedRelease] = useState(null); // collectionId
  const [releaseTracks, setReleaseTracks] = useState({});       // id → track[]
  const [releaseTrackBusy, setReleaseTrackBusy] = useState({}); // id → bool
  const [releaseTrackErr, setReleaseTrackErr] = useState({});   // id → string

  const fetchReleaseTracks = useCallback(async (id) => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.lookupReleaseAlbumTracks) { setReleaseTrackErr((m) => ({ ...m, [id]: 'Track lookup unavailable' })); return null; }
    setReleaseTrackBusy((m) => ({ ...m, [id]: true }));
    try {
      const res = await api.lookupReleaseAlbumTracks(id);
      if (res?.ok && Array.isArray(res.tracks)) {
        setReleaseTracks((m) => ({ ...m, [id]: res.tracks }));
        return res.tracks;
      }
      setReleaseTrackErr((m) => ({ ...m, [id]: res?.error || 'Could not load tracks' }));
      return null;
    } catch (e) {
      setReleaseTrackErr((m) => ({ ...m, [id]: String(e?.message || e) }));
      return null;
    } finally {
      setReleaseTrackBusy((m) => ({ ...m, [id]: false }));
    }
  }, []);

  const toggleRelease = useCallback((r) => {
    const id = Number(r?.collectionId);
    if (!Number.isFinite(id)) return;
    setExpandedRelease((cur) => (cur === id ? null : id));
    if (releaseTracks[id] || releaseTrackBusy[id]) return;
    fetchReleaseTracks(id);
  }, [releaseTracks, releaseTrackBusy, fetchReleaseTracks]);

  const downloadReleaseTrack = useCallback(async (r, tk, opts = {}) => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.importFromYoutubeSearch) return;
    const key = `rt:${r.collectionId}:${tk.trackId}`;
    if (dlState[key] === 'busy' || dlState[key] === 'done') return;
    const meta = {
      title: tk.trackName,
      artists: tk.artistName || r.artistName,
      album: tk.collectionName || r.collectionName,
      albumArtUrl: tk.artworkUrl || r.artworkUrl,
      durationMs: tk.trackTimeMillis || 0,
      spotifyId: `itunes:${tk.trackId}`,
      trackNumber: tk.trackNumber || null,
      discNumber: null,
      explicit: tk.explicit,
    };
    markDl(key, 'busy');
    try {
      const res = await api.importFromYoutubeSearch({ ...meta, progressId: key });
      if (res?.ok && res.track) {
        onTrackImported?.(res.track);
        markDl(key, 'done');
      } else {
        markDl(key, 'failed');
        if (opts.noPicker) toastError(res?.error, `Couldn’t download “${tk.trackName}”.`);
        else openPicker(meta, res, key);
      }
    } catch (e) { markDl(key, 'failed'); toastError(e?.message || e, `Couldn’t download “${tk.trackName}”.`); }
  }, [dlState, markDl, onTrackImported, toastError, openPicker]);

  /** Whole album — fetch the tracklist if needed, then take everything missing,
   *  one at a time (a dozen parallel yt-dlp searches is a bad idea). */
  const downloadRelease = useCallback(async (r) => {
    const id = Number(r?.collectionId);
    const key = `r:${id || r.collectionName}`;
    markDl(key, 'busy');
    const list = releaseTracks[id] || await fetchReleaseTracks(id);
    if (!list?.length) {
      markDl(key, 'failed');
      notify(false, `Couldn’t load “${r.collectionName || r.name}”`);
      toastError(null, `Couldn’t load the tracklist for “${r.collectionName || r.name}”.`);
      return;
    }
    const missing = list.filter((tk) => !alreadyOwned(tk.trackName, tk.artistName || r.artistName));
    if (!missing.length) {
      markDl(key, 'done');
      notify(true, 'You already have every track on this one');
      return;
    }
    notify(true, `Downloading “${r.collectionName || r.name}” — ${missing.length} track${missing.length === 1 ? '' : 's'}…`);
    for (const tk of missing) {
      // eslint-disable-next-line no-await-in-loop
      await downloadReleaseTrack(r, tk, { noPicker: true });
    }
    markDl(key, 'done');
    notify(true, `Finished “${r.collectionName || r.name}”`);
  }, [releaseTracks, fetchReleaseTracks, alreadyOwned, downloadReleaseTrack, markDl, notify, toastError]);

  /** Small reusable download button for card rows. Turns into a live
   *  progress bar while a download is running (determinate once the source
   *  reports a percentage, indeterminate before then). */
  // DlBtn was hoisted to a top-level component (see below the overlay).
  // Defining it inline gave it a fresh component identity every overlay
  // render (which happens constantly during playback), so React REMOUNTED
  // every download button each tick — restarting the progress bar's
  // animation ("broken" bar) and replacing the button's DOM node mid-click
  // (clicks intermittently swallowed).


  /* NOTE: the lyric-share Esc handler and its track-change reset used to sit
   * here. They belong to the SURFACE (they cancel a lyric selection on the
   * host's lyrics panel), not to the card — they were only adjacent in the
   * original file. They stay in the overlay. */
  useEffect(() => {
    if (libraryOpen) {
      setLibrarySearch('');
      setLibrarySelIndex(0);
      prevLibOpenRef.current = true;
      const id = setTimeout(() => librarySearchRef.current?.focus(), 80);
      return () => clearTimeout(id);
    }
    // On close, hand focus back to the dialog. Otherwise it stays stuck on the
    // hidden search field and the dialog's key handler (B, space, arrows) never
    // fires until you click back into the window.
    if (prevLibOpenRef.current) {
      prevLibOpenRef.current = false;
      try { librarySearchRef.current?.blur(); } catch { /* ignore */ }
      onReturnFocus?.();
    }
    return undefined;
  }, [libraryOpen]);
  // The full library, alphabetized by title — the card is a real library
  // view now, not a suggestions popup, so it must show EVERYTHING in an
  // order a human can scan (the raw array arrives in added-at order).
  // 'title' | 'artist' | 'recent' — persisted; title keeps the A–Z rail.
  const [panelSort, setPanelSort] = useState(() => {
    try { const v = localStorage.getItem('studio:panelLibSort'); return ['title', 'artist', 'recent'].includes(v) ? v : 'title'; } catch { return 'title'; }
  });
  const pickPanelSort = useCallback((v) => {
    setPanelSort(v);
    try { localStorage.setItem('studio:panelLibSort', v); } catch { /* ignore */ }
  }, []);
  const sortedLibrary = useMemo(() => {
    if (!canBrowse) return [];
    const list = [...library];
    if (panelSort === 'artist') {
      list.sort((a, b) => titleCollator.compare(a.artist || '', b.artist || '')
        || titleCollator.compare(a.album || '', b.album || '')
        || (a.trackNumber || 0) - (b.trackNumber || 0));
    } else if (panelSort === 'recent') {
      list.sort((a, b) => (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0));
    } else {
      list.sort((a, b) => titleCollator.compare(a.title || '', b.title || ''));
    }
    return list;
  }, [canBrowse, library, panelSort]);

  const filteredLibrary = useMemo(() => {
    const q = librarySearch.trim().toLowerCase();
    if (!q) return sortedLibrary;
    return sortedLibrary.filter((t) =>
      (t.title || '').toLowerCase().includes(q) || (t.artist || '').toLowerCase().includes(q) || (t.album || '').toLowerCase().includes(q));
  }, [sortedLibrary, librarySearch]);

  // No caps: empty query = whole library, a query = every match. The list
  // itself is virtualized (fixed 52px rows), so DOM weight stays constant
  // no matter the library size.
  const spotlightResults = filteredLibrary;

  // A–Z rail — first row index per initial letter. Only meaningful when the
  // full list is title-sorted (no search, title sort); '#' catches digits
  // and symbols, which the collator sorts to the front.
  const azIndex = useMemo(() => {
    if (panelSort !== 'title' || librarySearch.trim()) return null;
    const map = new Map();
    spotlightResults.forEach((t, i) => {
      const ch = (t.title || '').trim().charAt(0).toUpperCase();
      const letter = /[A-Z]/.test(ch) ? ch : '#';
      if (!map.has(letter)) map.set(letter, i);
    });
    return map.size > 1 ? map : null;
  }, [spotlightResults, panelSort, librarySearch]);

  // Keep the highlighted row valid as results change; jump back to the top.
  useEffect(() => {
    setLibrarySelIndex(0);
    if (libraryListRef.current) libraryListRef.current.scrollTop = 0;
  }, [librarySearch]);

  // Virtualized list plumbing — fixed-height rows, absolute-positioned
  // visible slice (same pattern as the queue list).
  const LIB_ROW_H = 52;
  const [libSelByKey, setLibSelByKey] = useState(false);
  const [libScrollTop, setLibScrollTop] = useState(0);
  const [libViewH, setLibViewH] = useState(320);
  const libRoRef = useRef(null);
  // Attached via CALLBACK REF, not an effect keyed on libraryOpen. The list
  // is unmounted whenever you visit another section (Find / Releases /
  // Stats), and two things used to go wrong on the way back:
  //   1. Chromium fires a ResizeObserver notification with a 0×0 rect when
  //      an observed element leaves the DOM — so libViewH was set to 0.
  //   2. The effect only re-ran on libraryOpen, so the observer was never
  //      re-attached to the FRESH list node and 0 stuck.
  // With libViewH = 0 the virtualizer's `last` index collapses to ~4, which
  // is exactly the "library cuts off after four rows" symptom. A callback ref
  // re-measures on every mount, and zero-height readings are ignored.
  const attachLibList = useCallback((el) => {
    libraryListRef.current = el;
    if (libRoRef.current) { libRoRef.current.disconnect(); libRoRef.current = null; }
    if (!el) return;
    const measure = () => {
      const h = el.clientHeight;
      if (h > 0) setLibViewH(h);
    };
    measure();
    // A remounted node always starts at scrollTop 0; stale scroll state would
    // otherwise render a slice from the old offset into a list scrolled to
    // the top (blank rows).
    setLibScrollTop(0);
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      libRoRef.current = ro;
    }
  }, []);
  useEffect(() => () => { if (libRoRef.current) libRoRef.current.disconnect(); }, []);

  // Keep the highlighted row on screen during KEYBOARD nav — computed from
  // the index (scrollIntoView can't work when the row isn't rendered yet).
  // Gated on libSelByKey: hover also moves the selection index, and a
  // half-visible row scrolling itself into view under the cursor feels
  // like the list is fighting the mouse.
  useEffect(() => {
    if (!libraryOpen || !libSelByKey) return;
    const el = libraryListRef.current;
    if (!el) return;
    const rowTop = librarySelIndex * LIB_ROW_H;
    const rowBottom = rowTop + LIB_ROW_H;
    if (rowTop < el.scrollTop) el.scrollTop = rowTop;
    else if (rowBottom > el.scrollTop + el.clientHeight) el.scrollTop = rowBottom - el.clientHeight;
  }, [librarySelIndex, libraryOpen, libSelByKey]);

  // While the search is open, intercept Esc at the window in capture phase so
  // it closes the search and never reaches the parent page's Esc handler
  // (which would otherwise close the whole fullscreen view). Only attached
  // while open, so it can never interfere with opening (Enter, in handleKey).
  useEffect(() => {
    if (!libraryOpen) return undefined;
    const h = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); onRequestClose(false); }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [libraryOpen]);

  // Honour the OS "reduce motion" setting — skip the entrance/scale animations.

  // Parallax side menu — a slim icon rail docked to the command center's
  // left edge (it lives inside the same drag wrapper, so it travels with
  // the card). Emerges from BEHIND the card after it unfolds — smaller
  // travel, later start: that timing offset is the parallax. Icons cascade
  // in individually; the accent indicator GLIDES between sections instead
  // of repainting.
  const CC_SECTIONS = sections;
  const ccActiveIndex = Math.max(0, CC_SECTIONS.findIndex(([id]) => id === cardTab));
  const ccBtn = 36;
  const ccGap = 6;
  // Rail footprint: 36px button + 6px padding either side = 48, plus the
  // 10px gap to the card. CC_NUDGE re-centers the PAIR (rail + card) on the
  // composition — the rail only ever hangs off the left, so without this the
  // whole assembly reads half a rail-width too far left.
  const CC_RAIL_W = ccBtn + 12;
  const CC_GUTTER = CC_RAIL_W + 10;
  const CC_NUDGE = Math.round(CC_GUTTER / 2);
  const commandMenu = (
    // OUTER: pure positioning. Spans the card's full height and centers its
    // child with flexbox — no percentage + translate trick.
    // This split exists because the pill's own keyframes end on
    // `transform: translateX(0) scale(1)`, and with fill-mode `both` that
    // final frame REPLACES any inline transform on the same element. The old
    // `top: 50%` + `translateY(-50%)` therefore lost its -50% the instant the
    // entrance animation settled, dropping the rail half its own height below
    // the card's center. (Same trap the card-drag offset already documents.)
    <div style={{
      position: 'absolute', right: `calc(100% + 10px)`, top: 0, bottom: 0,
      display: 'flex', alignItems: 'center',
      pointerEvents: 'none',
    }}>
    <div style={{
      position: 'relative',
      display: 'flex', flexDirection: 'column', gap: ccGap,
      padding: 6, borderRadius: 13,
      pointerEvents: 'auto',
      background: 'rgba(16,16,20,0.72)',
      border: '1px solid rgba(255,255,255,0.09)',
      backdropFilter: 'blur(26px) saturate(1.5)', WebkitBackdropFilter: 'blur(26px) saturate(1.5)',
      boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
      // Out mirrors In: same 26px slide + 0.94 scale, inverse easing curve
      // (cubic-bezier(0.8,0,0.8,0.2) is the literal time-reverse of the
      // entrance's 0.2,0.8,0.2,1). It retracts BEHIND the card at 80ms —
      // the parallax read backwards.
      animation: reduceMotion ? 'none' : (libraryOpen
        ? 'immerseFullscreenMenuIn 380ms cubic-bezier(0.2, 0.8, 0.2, 1) 240ms both'
        : 'immerseFullscreenMenuOut 200ms cubic-bezier(0.55, 0, 0.55, 0.2) 40ms both'),
    }}>
      {/* Gliding active indicator — sits UNDER the icons, slides between
          slots on a soft spring-ish curve. */}
      <div aria-hidden style={{
        position: 'absolute', left: 6, width: ccBtn, height: ccBtn,
        top: 6 + ccActiveIndex * (ccBtn + ccGap),
        borderRadius: 10,
        background: `rgba(${accent},0.28)`,
        border: `1px solid rgba(${accent},0.4)`,
        transition: reduceMotion ? 'none' : 'top 320ms cubic-bezier(0.3, 0.9, 0.3, 1)',
        pointerEvents: 'none',
      }} />
      {CC_SECTIONS.map(([id, label, path], i) => (
        <button key={id} type="button" title={label}
          onClick={() => setCardTab(id)}
          style={{
            position: 'relative', width: ccBtn, height: ccBtn,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: 'none', borderRadius: 10, cursor: 'pointer',
            background: 'transparent',
            color: cardTab === id ? '#fff' : 'rgba(255,255,255,0.5)',
            transition: 'color 0.2s ease',
            animation: reduceMotion ? 'none' : (libraryOpen
              ? `immerseFullscreenMenuIconIn 260ms cubic-bezier(0.2, 0.8, 0.2, 1) ${300 + i * 45}ms both`
              // Reverse cascade: the LAST icon leaves first, so the rail
              // unzips upward — the entrance run backwards.
              : `immerseFullscreenMenuIconOut 150ms cubic-bezier(0.55, 0, 0.55, 0.2) ${(CC_SECTIONS.length - 1 - i) * 18}ms both`),
          }}
          onMouseEnter={(e) => { if (cardTab !== id) e.currentTarget.style.color = 'rgba(255,255,255,0.85)'; }}
          onMouseLeave={(e) => { if (cardTab !== id) e.currentTarget.style.color = 'rgba(255,255,255,0.5)'; }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d={path} />
          </svg>
        </button>
      ))}
    </div>
    </div>
  );

  // Library browser card — fills the cover's exact square while search is
  // open. Same glass recipe as the rest of the fullscreen chrome.
  const libraryCard = (
    <div style={{
      position: 'absolute', inset: 0, borderRadius: 16, overflow: 'hidden',
      background: 'rgba(16,16,20,0.72)',
      border: '1px solid rgba(255,255,255,0.09)',
      backdropFilter: 'blur(26px) saturate(1.5)', WebkitBackdropFilter: 'blur(26px) saturate(1.5)',
      boxShadow: `0 24px 70px rgba(0,0,0,0.55), 0 0 0 1px rgba(${accent},0.25)`,
      display: 'flex', flexDirection: 'column',
      // Enter: settle up + unfold AFTER the cover has visibly vacated the
      // square (160ms hold). Exit: the card folds away LAST (120ms hold,
      // after the rail has tucked itself behind it), on the inverse of the
      // entrance curve, finishing exactly as the artwork lands home.
      animation: reduceMotion ? 'none' : (libraryOpen
        ? `immerseFullscreenSearchCardIn 360ms cubic-bezier(0.22, 1, 0.36, 1) ${variant === 'centered' ? '50ms' : '140ms'} both`
        : 'immerseFullscreenSearchCardOut 240ms cubic-bezier(0.55, 0, 0.55, 0.2) both'),
    }}>
      {/* Grip — drag to move the command center; double-click snaps home. */}
      <div
        onPointerDown={handleCardGripDown}
        onPointerMove={handleCardGripMove}
        onPointerUp={handleCardGripUp}
        onPointerCancel={handleCardGripUp}
        onDoubleClick={resetCardOffset}
        title="Drag to move · double-click to reset"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          paddingTop: 8, marginBottom: -4, cursor: 'grab',
          flexShrink: 0, touchAction: 'none',
        }}
      >
        <div style={{ width: 36, height: 4, borderRadius: 999, background: 'rgba(255,255,255,0.18)' }} />
      </div>
      {/* Keyed content wrapper: every tab switch replays a soft rise-in, and
          on close the contents sink away a beat before the card itself does,
          so the card doesn't collapse with a frozen list inside it. */}
      <div key={cardTab} style={{
        flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
        animation: reduceMotion ? 'none' : (libraryOpen
          ? 'immerseFullscreenTabIn 240ms cubic-bezier(0.2,0.8,0.2,1) both'
          : 'immerseFullscreenTabOut 200ms cubic-bezier(0.8, 0, 0.8, 0.2) both'),
      }}>
      {cardTab === 'library' ? (<>
      <div style={{ padding: 12, borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        {/* Songs / Albums — the same two views as the main library page. */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 8, padding: 3, borderRadius: 9, background: 'rgba(255,255,255,0.05)' }}>
          {[['songs', 'Songs'], ['albums', 'Albums']].map(([id, label]) => (
            <button key={id} type="button" onClick={() => pickLibraryView(id)}
              style={{
                flex: 1, padding: '6px 0', borderRadius: 7, border: 'none', cursor: 'pointer',
                fontSize: 11.5, fontWeight: 700,
                background: libraryView === id ? `rgba(${accent},0.28)` : 'transparent',
                color: libraryView === id ? '#fff' : 'rgba(255,255,255,0.5)',
                transition: 'background 0.18s ease, color 0.18s ease',
              }}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ position: 'relative' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="2" strokeLinecap="round"
            style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', zIndex: 2 }}>
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            ref={librarySearchRef}
            value={librarySearch}
            onChange={(e) => setLibrarySearch(e.target.value)}
            onKeyDown={(e) => {
              // Arrow-key browsing only means anything in the flat song list.
              if (libraryView === 'songs' && !openAlbumData) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setLibSelByKey(true); setLibrarySelIndex((i) => Math.min(spotlightResults.length - 1, i + 1)); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setLibSelByKey(true); setLibrarySelIndex((i) => Math.max(0, i - 1)); return; }
              }
              // Enter is the OPEN gesture and nothing else: it must not close
              // the card, and it must not play. Swallowed here so it can't
              // bubble up to the host's open handler and immediately reopen
              // what the user is typing into, and so a stray Enter in a
              // search box never fires an unintended action.
              if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); }
            }}
            placeholder={openAlbumData ? `Search in ${openAlbumData.album}…` : libraryView === 'albums' ? 'Search your albums…' : 'Search your library…'}
            style={{
              width: '100%', padding: '10px 12px 10px 36px',
              fontSize: 13.5, fontWeight: 400, color: '#fff',
              background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 10, outline: 'none',
            }}
          />
        </div>
        {/* Sort — songs list only; the album grid has its own order. */}
        {libraryView === 'songs' && !openAlbumData ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 8 }}>
            <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', marginRight: 2 }}>Sort</span>
            {[['title', 'Title'], ['artist', 'Artist'], ['recent', 'Recent']].map(([id, label]) => (
              <button key={id} type="button" onClick={() => pickPanelSort(id)}
                style={{
                  padding: '4px 10px', borderRadius: 7, border: 'none', cursor: 'pointer',
                  fontSize: 10.5, fontWeight: 700,
                  background: panelSort === id ? `rgba(${accent},0.28)` : 'rgba(255,255,255,0.05)',
                  color: panelSort === id ? '#fff' : 'rgba(255,255,255,0.5)',
                  transition: 'background 0.15s ease, color 0.15s ease',
                }}>
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {libraryView === 'songs' ? (
      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}>
      <div
        ref={attachLibList}
        onScroll={(e) => setLibScrollTop(e.currentTarget.scrollTop)}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: azIndex ? '6px 24px 6px 2px' : '6px 6px 6px 2px', scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.15) transparent', position: 'relative' }}
      >
        {spotlightResults.length > 0 ? (
          <div style={{ position: 'relative', height: spotlightResults.length * LIB_ROW_H }}>
          {(() => {
            const first = Math.max(0, Math.floor(libScrollTop / LIB_ROW_H) - 4);
            const last = Math.min(spotlightResults.length, Math.ceil((libScrollTop + libViewH) / LIB_ROW_H) + 4);
            return spotlightResults.slice(first, last).map((tr, k) => {
              const i = first + k;
            const sel = i === librarySelIndex;
            const isCurrent = currentTrackId && tr.id === currentTrackId;
            const canRowActions = !!(onUpdateTrackMetadata || onRemoveFromLibrary);
            return (
              <div
                key={tr.id}
                role="button"
                tabIndex={-1}
                data-sel={sel ? 'true' : 'false'}
                /* Selecting a track no longer closes the card — you're
                   usually queueing up several, and having it slam shut after
                   each pick meant reopening and re-searching every time. */
                onClick={() => { onSelectTrack(tr); }}
                onContextMenu={canRowActions ? (e) => { e.preventDefault(); e.stopPropagation(); onConfirm(null); onMenu({ x: e.clientX, y: e.clientY, track: tr }); } : undefined}
                onMouseEnter={() => { setLibSelByKey(false); setLibrarySelIndex(i); }}
                title={(tr.title || 'Unknown') + ' — ' + (tr.artist || '')}
                className="fs-librow"
                style={{
                  position: 'absolute', top: i * LIB_ROW_H, left: 0, right: 0, height: LIB_ROW_H - 2,
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '0 8px 0 4px', borderRadius: 10, border: 'none', cursor: 'pointer',
                  textAlign: 'left',
                  background: sel && libSelByKey ? `rgba(${accent}, 0.2)` : 'transparent',
                  transition: 'background 0.12s ease',
                }}
              >
                {/* Row number — list position in the current sort. */}
                <span style={{
                  width: 20, textAlign: 'right', flexShrink: 0,
                  fontSize: 10.5, color: isCurrent ? `rgb(${accent})` : 'rgba(255,255,255,0.32)',
                  fontVariantNumeric: 'tabular-nums',
                }}>{i + 1}</span>
                <div style={{
                  width: 38, height: 38, borderRadius: 8, flexShrink: 0,
                  backgroundColor: 'rgba(255,255,255,0.06)',
                  backgroundImage: tr.coverArt ? `url("${tr.coverArt.replace(/"/g, '%22')}")` : 'none',
                  backgroundSize: 'cover', backgroundPosition: 'center',
                }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{
                    fontSize: 13, fontWeight: 500,
                    color: isCurrent ? `rgb(${accent})` : '#fff',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{tr.title || 'Unknown track'}</div>
                  <div style={{
                    fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 1,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{tr.artist || 'Unknown artist'}</div>
                </div>
                {/* Hovered row: pencil + ⋯ — Immerse's row actions. */}
                {canRowActions ? (
                  <div className="fs-librow-acts" style={{ display: 'flex', gap: 5, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                    {onUpdateTrackMetadata ? (
                      <button type="button" title="Edit track info"
                        onClick={() => onEditTrackMeta(tr)}
                        style={{ width: 26, height: 26, borderRadius: 8, border: 'none', cursor: 'pointer', background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>
                      </button>
                    ) : null}
                    <button type="button" title="More"
                      onClick={(e) => { onConfirm(null); onMenu({ x: e.clientX, y: e.clientY, track: tr }); }}
                      style={{ width: 26, height: 26, borderRadius: 8, border: 'none', cursor: 'pointer', background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
                    </button>
                  </div>
                ) : null}
                {isCurrent ? (
                  <span className={canRowActions ? 'fs-librow-time' : undefined} style={{ flexShrink: 0, display: 'flex', alignItems: 'center', height: 14, lineHeight: 0 }}><FsEqBadge accent={accent} playing={isPlaying} /></span>
                ) : tr.duration ? (
                  <span className={canRowActions ? 'fs-librow-time' : undefined} style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.32)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{formatTime(tr.duration)}</span>
                ) : null}
              </div>
            );
            });
          })()}
          </div>
        ) : librarySearch.trim() ? (
          <div style={{ padding: '22px 14px', textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontSize: 12.5 }}>
            No tracks match “{librarySearch}”.
          </div>
        ) : null}
      </div>
      {/* A–Z rail — floats over the right edge (title sort, no search).
          Click a letter to jump; letters absent from the library are dim. */}
      {azIndex ? (
        <div aria-hidden style={{
          position: 'absolute', top: 6, bottom: 6, right: 11, width: 14,
          display: 'flex', flexDirection: 'column', justifyContent: 'center',
          gap: 0, zIndex: 2, pointerEvents: 'auto',
        }}>
          {['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((L) => {
            const idx = azIndex.get(L);
            const has = idx !== undefined;
            return (
              <button key={L} type="button" tabIndex={-1}
                onClick={has ? () => { if (libraryListRef.current) libraryListRef.current.scrollTop = idx * LIB_ROW_H; } : undefined}
                style={{
                  flex: 1, minHeight: 0, padding: 0, border: 'none', background: 'transparent',
                  cursor: has ? 'pointer' : 'default',
                  fontSize: 8, fontWeight: 700, lineHeight: 1,
                  color: has ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.16)',
                  transition: 'color 0.12s ease',
                }}
                onMouseEnter={(e) => { if (has) e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = has ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.16)'; }}
              >{L}</button>
            );
          })}
        </div>
      ) : null}
      </div>
      ) : openAlbumData ? (
        /* Album detail — header, then the tracklist in disc/track order.
           Click any track to play it (the whole album becomes the context via
           onSelectTrack, same as clicking a track in the main album view). */
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 6, scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.15) transparent' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '4px 6px 10px' }}>
            <button type="button" title="Back to albums"
              onClick={() => { setOpenAlbum(null); setLibrarySearch(''); }}
              style={{
                width: 26, height: 26, borderRadius: 8, flexShrink: 0, border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.75)',
              }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <div style={{
              width: 46, height: 46, borderRadius: 9, flexShrink: 0,
              backgroundColor: 'rgba(255,255,255,0.06)',
              backgroundImage: openAlbumData.displayCover ? `url("${openAlbumData.displayCover.replace(/"/g, '%22')}")` : 'none',
              backgroundSize: 'cover', backgroundPosition: 'center',
              boxShadow: `0 0 0 1px rgba(${accent},0.3)`,
            }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{openAlbumData.album}</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {openAlbumData.artist} · {openAlbumData.tracks.length} tracks
                {openAlbumData.duration ? ` · ${Math.round(openAlbumData.duration / 60)} min` : ''}
              </div>
            </div>
            {onUpdateAlbumMetadata ? (
              <button type="button" title="Edit album info"
                onClick={() => onEditAlbumMeta({
                  key: openAlbumData.key,
                  album: openAlbumData.album,
                  artist: openAlbumData.artist,
                  coverArt: openAlbumData.displayCover || null,
                  sampleTrack: openAlbumData.tracks[0] || null,
                  trackIds: openAlbumData.tracks.map((t) => t.id),
                })}
                style={{
                  width: 30, height: 30, borderRadius: 8, flexShrink: 0, border: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.78)',
                }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>
              </button>
            ) : null}
            <button type="button" title="Play album"
              onClick={() => { onSelectTrack?.(openAlbumData.tracks[0]); }}
              style={{
                width: 30, height: 30, borderRadius: '50%', flexShrink: 0, border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: `rgba(${accent},0.32)`, color: '#fff',
              }}>
              <PlayIcon size={12} />
            </button>
          </div>

          {openAlbumTracks.length ? openAlbumTracks.map((t, i) => {
            const isCurrent = currentTrackId && t.id === currentTrackId;
            const prev = openAlbumTracks[i - 1];
            const showDisc = openAlbumData.hasMultipleDiscs
              && (i === 0 || (prev?.discNumber ?? 1) !== (t.discNumber ?? 1));
            return (
              <React.Fragment key={t.id}>
                {showDisc ? (
                  <div style={{
                    fontSize: 9.5, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase',
                    color: 'rgba(255,255,255,0.35)', padding: '8px 8px 4px',
                  }}>
                    Disc {t.discNumber ?? 1}
                  </div>
                ) : null}
                <div role="button" tabIndex={-1} className="fs-albrow"
                  onClick={() => { onSelectTrack?.(t); }}
                  onContextMenu={(onUpdateTrackMetadata || onRemoveFromLibrary) ? (e) => { e.preventDefault(); e.stopPropagation(); onConfirm(null); onMenu({ x: e.clientX, y: e.clientY, track: t }); } : undefined}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                    padding: '7px 10px', borderRadius: 9, border: 'none',
                    background: 'transparent', cursor: 'pointer', textAlign: 'left',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                  <span style={{ width: 18, textAlign: 'right', fontSize: 11, color: 'rgba(255,255,255,0.32)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                    {t.trackNumber ?? '·'}
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{
                      fontSize: 12.5, color: isCurrent ? `rgb(${accent})` : '#fff',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{t.title || 'Untitled'}</div>
                  </div>
                  {(onUpdateTrackMetadata || onRemoveFromLibrary) ? (
                    <span className="fs-albrow-acts" style={{ display: 'flex', gap: 5, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                      {onUpdateTrackMetadata ? (
                        <button type="button" title="Edit track info" onClick={() => onEditTrackMeta(t)}
                          style={{ width: 24, height: 24, borderRadius: 7, border: 'none', cursor: 'pointer', background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>
                        </button>
                      ) : null}
                      <button type="button" title="More" onClick={(e) => { onConfirm(null); onMenu({ x: e.clientX, y: e.clientY, track: t }); }}
                        style={{ width: 24, height: 24, borderRadius: 7, border: 'none', cursor: 'pointer', background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
                      </button>
                    </span>
                  ) : null}
                  {isCurrent ? (
                    <span className="fs-albrow-time" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', height: 14, lineHeight: 0 }}><FsEqBadge accent={accent} playing={isPlaying} /></span>
                  ) : t.duration ? (
                    <span className="fs-albrow-time" style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.35)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                      {formatTime(t.duration)}
                    </span>
                  ) : null}
                </div>
              </React.Fragment>
            );
          }) : (
            <div style={{ padding: '18px 14px', textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontSize: 12.5 }}>
              No tracks match “{librarySearch}”.
            </div>
          )}
        </div>
      ) : (
        /* Album grid — cover-first tiles, exactly the entry point the main
           library's Albums view gives you. */
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8, scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.15) transparent' }}>
          {filteredAlbums.length ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
              {filteredAlbums.map((a) => {
                const isCurrent = currentTrackId && a.tracks.some((t) => t.id === currentTrackId);
                return (
                  <button key={a.key} type="button"
                    onClick={() => { setOpenAlbum(a.key); setLibrarySearch(''); }}
                    title={`${a.album} — ${a.artist}`}
                    style={{
                      display: 'flex', flexDirection: 'column', gap: 6, padding: 6,
                      border: 'none', borderRadius: 12, cursor: 'pointer', textAlign: 'left',
                      background: 'transparent', transition: 'background 0.15s ease',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                    <div style={{
                      width: '100%', aspectRatio: '1', borderRadius: 9,
                      backgroundColor: 'rgba(255,255,255,0.06)',
                      backgroundImage: a.displayCover ? `url("${a.displayCover.replace(/"/g, '%22')}")` : 'none',
                      backgroundSize: 'cover', backgroundPosition: 'center',
                      boxShadow: isCurrent ? `0 0 0 2px rgba(${accent},0.65)` : '0 6px 18px rgba(0,0,0,0.35)',
                    }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{
                        fontSize: 12, fontWeight: 600,
                        color: isCurrent ? `rgb(${accent})` : '#fff',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>{a.album}</div>
                      <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.5)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {a.artist}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div style={{ padding: '22px 14px', textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontSize: 12.5, lineHeight: 1.5 }}>
              {librarySearch.trim() ? `No albums match “${librarySearch}”.` : 'No albums yet — anything with two or more tracks shows up here.'}
            </div>
          )}
        </div>
      )}
      </>) : null}

      {cardTab === 'find' ? (<>
        <div style={{ padding: 12, borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
          {/* Source switch — Spotify (tagged, matched via yt-dlp) or Soulseek
              (raw peer files). Same two sources as the main Find tab. */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 8, padding: 3, borderRadius: 9, background: 'rgba(255,255,255,0.05)' }}>
            {[['spotify', 'Songs'], ['albums', 'Albums'], ['soulseek', 'Soulseek']].map(([id, label]) => (
              <button key={id} type="button" onClick={() => pickFindSource(id)}
                style={{
                  flex: 1, padding: '6px 0', borderRadius: 7, border: 'none', cursor: 'pointer',
                  fontSize: 11.5, fontWeight: 700, letterSpacing: '0.01em',
                  background: findSource === id ? `rgba(${accent},0.28)` : 'transparent',
                  color: findSource === id ? '#fff' : 'rgba(255,255,255,0.5)',
                  transition: 'background 0.18s ease, color 0.18s ease',
                }}>
                {label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="text"
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
              onKeyDown={(e) => {
                // In FIND, Enter searches (Esc still closes the card).
                if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); runFind(); }
              }}
              placeholder={findSource === 'albums' ? 'Search for an album…' : findSource === 'spotify' ? 'Search Spotify… artist and song' : 'Search Soulseek… artist and song'}
              style={{
                flex: 1, padding: '10px 12px', borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.1)',
                background: 'rgba(255,255,255,0.06)',
                color: '#fff', fontSize: 13, outline: 'none',
              }}
            />
            <button type="button" onClick={runFind} disabled={findBusy}
              style={{
                padding: '0 14px', borderRadius: 10, border: 'none',
                background: `rgba(${accent},0.3)`, color: '#fff',
                fontSize: 12, fontWeight: 700, cursor: findBusy ? 'default' : 'pointer',
                opacity: findBusy ? 0.55 : 1,
              }}>
              {findBusy ? '…' : 'Search'}
            </button>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 6, scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.15) transparent' }}>
          {/* Soulseek album folders — the good stuff first, songs after. */}
          {findSource === 'soulseek' && findSsAlbums.length ? (
            <>
              <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', padding: '4px 10px 6px' }}>
                Albums · {findSsAlbums.length}
              </div>
              {findSsAlbums.map((alb) => {
                const open = openFindSsAlbum === alb.id;
                const dl = dlState[`ssa:${alb.id}`];
                const prog = findSsAlbumProg[alb.id];
                const progressText = dl === 'busy' && prog?.total
                  ? `${Math.min(prog.completed ?? 0, prog.total)} / ${prog.total}`
                  : null;
                return (
                  <div key={alb.id} style={{ marginBottom: 2 }}>
                    <div onClick={() => setOpenFindSsAlbum((cur) => (cur === alb.id ? null : alb.id))}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 11, padding: '7px 10px', borderRadius: 10, cursor: 'pointer',
                        background: open ? 'rgba(255,255,255,0.05)' : 'transparent',
                        transition: 'background 0.15s ease',
                      }}>
                      <div style={{
                        width: 40, height: 40, borderRadius: 8, flexShrink: 0,
                        background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{alb.displayName}</div>
                        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {alb.trackCount} tracks
                          {alb.ext && alb.ext !== 'mixed' ? ` · ${String(alb.ext).toUpperCase()}` : ''}
                          {alb.bitrate ? ` · ${alb.bitrate}kbps` : ''}
                          {alb.totalSize ? ` · ${(alb.totalSize / 1048576).toFixed(0)} MB` : ''}
                          {` · ${alb.user}`}
                        </div>
                      </div>
                      {progressText ? (
                        <span style={{ fontSize: 10, color: `rgb(${accent})`, fontVariantNumeric: 'tabular-nums', flexShrink: 0, animation: 'immerseFullscreenIn 0.3s ease both' }}>
                          {progressText}
                        </span>
                      ) : null}
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                        style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 220ms cubic-bezier(0.3,0.9,0.3,1)' }}>
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                      <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexShrink: 0 }}>
                        <DlBtn st={dlState[`ssa:${alb.id}`]} progress={dlProgress[`ssa:${alb.id}`]} accent={accent} title="Download the whole album" onClick={() => downloadFindSsAlbum(alb)} />
                      </div>
                    </div>
                    {open ? (
                      <div style={{
                        margin: '2px 0 6px 12px', paddingLeft: 10,
                        borderLeft: `1px solid rgba(${accent},0.25)`,
                        animation: reduceMotion ? 'none' : 'immerseFullscreenTabIn 220ms cubic-bezier(0.2,0.8,0.2,1) both',
                      }}>
                        {alb.tracks.map((t) => (
                          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 8px 5px 2px', borderRadius: 8 }}>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontSize: 12, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.filename}</div>
                              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {t.bitrate ? `${t.bitrate} kbps · ` : ''}{t.size ? `${(t.size / 1048576).toFixed(1)} MB` : ''}
                              </div>
                            </div>
                            <DlBtn st={dlState[`t:${t.id}`]} progress={dlProgress[`t:${t.id}`]} accent={accent} title="Download this track" onClick={() => downloadSoulseekRow(t)} />
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {findResults.length ? (
                <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', padding: '8px 10px 6px' }}>
                  Songs · {findResults.length}
                </div>
              ) : null}
            </>
          ) : null}
          {(findResults.length || (findSource === 'soulseek' && findSsAlbums.length)) ? findResults.map((row) => (
            findSource === 'albums' ? (() => {
              const open = openFindAlbum === row.albumId;
              const tks = findAlbumTracks[row.albumId];
              return (
                <div key={row.albumId} style={{ marginBottom: 2 }}>
                  <div onClick={() => toggleFindAlbum(row)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 11, padding: '7px 10px', borderRadius: 10, cursor: 'pointer',
                      background: open ? 'rgba(255,255,255,0.05)' : 'transparent',
                      transition: 'background 0.15s ease',
                    }}>
                    <div style={{
                      width: 40, height: 40, borderRadius: 8, flexShrink: 0,
                      backgroundColor: 'rgba(255,255,255,0.06)',
                      backgroundImage: row.albumArtUrl ? `url("${String(row.albumArtUrl).replace(/"/g, '%22')}")` : 'none',
                      backgroundSize: 'cover', backgroundPosition: 'center',
                    }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.name}</div>
                      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {row.artists}
                        {row.releaseDate ? ` · ${String(row.releaseDate).slice(0, 4)}` : ''}
                        {row.totalTracks ? ` · ${row.totalTracks} ${row.totalTracks === 1 ? 'track' : 'tracks'}` : ''}
                      </div>
                    </div>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                      style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 220ms cubic-bezier(0.3,0.9,0.3,1)' }}>
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                    <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexShrink: 0 }}>
                      <DlBtn st={dlState[`sa:${row.albumId}`]} progress={dlProgress[`sa:${row.albumId}`]} accent={accent} title="Download the tracks you don’t have" onClick={() => downloadFindAlbum(row)} />
                    </div>
                  </div>
                  {open ? (
                    <div style={{
                      margin: '2px 0 6px 12px', paddingLeft: 10,
                      borderLeft: `1px solid rgba(${accent},0.25)`,
                      animation: reduceMotion ? 'none' : 'immerseFullscreenTabIn 220ms cubic-bezier(0.2,0.8,0.2,1) both',
                    }}>
                      {findAlbumBusy[row.albumId] ? (
                        <div style={{ padding: '12px 8px', fontSize: 11.5, color: 'rgba(255,255,255,0.45)' }}>Loading tracks…</div>
                      ) : (tks || []).map((t) => {
                        const owned = alreadyOwned(t.title, t.artists);
                        const key = `s:${t.spotifyId}`;
                        return (
                          <div key={t.spotifyId} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 8px 5px 2px', borderRadius: 8 }}>
                            <span style={{ width: 16, textAlign: 'right', fontSize: 10.5, color: 'rgba(255,255,255,0.32)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                              {t.trackNumber || '·'}
                            </span>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontSize: 12, color: owned ? 'rgba(255,255,255,0.5)' : '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {t.title}
                              </div>
                            </div>
                            {t.durationMs ? (
                              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                                {formatTime(Math.round(t.durationMs / 1000))}
                              </span>
                            ) : null}
                            {owned && dlState[key] !== 'done' ? (
                              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', flexShrink: 0 }}>owned</span>
                            ) : (
                              <DlBtn st={dlState[key]} progress={dlProgress[key]} accent={accent} title="Download this track" onClick={() => downloadSpotifyRow(t)} />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })() : findSource === 'spotify' ? (
              <div key={row.spotifyId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 10 }}>
                <div style={{
                  width: 34, height: 34, borderRadius: 7, flexShrink: 0,
                  backgroundColor: 'rgba(255,255,255,0.06)',
                  backgroundImage: row.albumArtUrl ? `url("${String(row.albumArtUrl).replace(/"/g, '%22')}")` : 'none',
                  backgroundSize: 'cover', backgroundPosition: 'center',
                }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {row.title || 'Unknown track'}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.5)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {row.artists || 'Unknown artist'}{row.album ? ` · ${row.album}` : ''}
                  </div>
                </div>
                {alreadyOwned(row.title, row.artists) && dlState[`s:${row.spotifyId}`] !== 'done' ? (
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', flexShrink: 0, marginRight: 2 }}>in library</span>
                ) : null}
                <DlBtn st={dlState[`s:${row.spotifyId}`]} progress={dlProgress[`s:${row.spotifyId}`]} accent={accent} title="Download to library" onClick={() => downloadSpotifyRow(row)} />
              </div>
            ) : (
              <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 10 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {row.filename || 'Unknown file'}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.5)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {row.bitrate ? `${row.bitrate} kbps · ` : ''}{row.size ? `${(row.size / 1048576).toFixed(1)} MB · ` : ''}{row.user}
                  </div>
                </div>
                <DlBtn st={dlState[`t:${row.id}`]} progress={dlProgress[`t:${row.id}`]} accent={accent} title="Download to library" onClick={() => downloadSoulseekRow(row)} />
              </div>
            )
          )) : (
            <div style={{ padding: '24px 16px', textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontSize: 12.5, lineHeight: 1.55 }}>
              {findBusy ? (findSource === 'soulseek' ? 'Searching the network…' : 'Searching Spotify…')
                : findError || (findSource === 'albums'
                  ? 'Search for an album — open it to grab single tracks.'
                  : 'Search for a song — downloads land straight in your library.')}
            </div>
          )}
        </div>
      </>) : null}

      {cardTab === 'releases' ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 6, scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.15) transparent' }}>
          {(releases || []).length ? releases.slice(0, 40).map((r, i) => {
            const cid = Number(r.collectionId);
            const open = expandedRelease === cid;
            const tks = releaseTracks[cid];
            const isSingle = (Number(r.trackCount) || 0) <= 1;
            const albumKey = `r:${cid || r.collectionName}`;
            return (
              <div key={r.collectionId || `${r.artistName}-${r.collectionName}-${i}`} style={{ marginBottom: 2 }}>
                <div
                  onClick={() => { if (!isSingle) toggleRelease(r); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 11, padding: '7px 10px', borderRadius: 10,
                    cursor: isSingle ? 'default' : 'pointer',
                    background: open ? 'rgba(255,255,255,0.05)' : 'transparent',
                    transition: 'background 0.15s ease',
                  }}>
                  <div style={{
                    width: 38, height: 38, borderRadius: 8, flexShrink: 0,
                    backgroundColor: 'rgba(255,255,255,0.06)',
                    backgroundImage: r.artworkUrl ? `url("${String(r.artworkUrl).replace(/"/g, '%22')}")` : 'none',
                    backgroundSize: 'cover', backgroundPosition: 'center',
                  }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.collectionName || r.name || 'Untitled'}</div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {r.artistName || 'Unknown artist'}
                      {(() => {
                        const d = r.releaseDate ? new Date(r.releaseDate) : null;
                        const ds = d && !Number.isNaN(d.getTime())
                          ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                          : null;
                        return ds ? ` · ${ds}` : '';
                      })()}
                      {r.trackCount ? ` · ${r.trackCount} ${r.trackCount === 1 ? 'track' : 'tracks'}` : ''}
                    </div>
                  </div>
                  {/* Chevron rotates open — the affordance for the tracklist. */}
                  {!isSingle ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                      style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 220ms cubic-bezier(0.3,0.9,0.3,1)' }}>
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  ) : null}
                  <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexShrink: 0 }}>
                    <DlBtn st={dlState[albumKey]} progress={dlProgress[albumKey]} accent={accent} title={isSingle ? 'Download' : 'Download the tracks you don’t have'} onClick={() => downloadRelease(r)} />
                  </div>
                </div>

                {open ? (
                  <div style={{
                    margin: '2px 0 6px 10px', paddingLeft: 10,
                    borderLeft: `1px solid rgba(${accent},0.25)`,
                    animation: reduceMotion ? 'none' : 'immerseFullscreenTabIn 220ms cubic-bezier(0.2,0.8,0.2,1) both',
                  }}>
                    {releaseTrackBusy[cid] ? (
                      <div style={{ padding: '12px 8px', fontSize: 11.5, color: 'rgba(255,255,255,0.45)' }}>Loading tracks…</div>
                    ) : releaseTrackErr[cid] && !tks?.length ? (
                      <div style={{ padding: '12px 8px', fontSize: 11.5, color: '#f0a0a0' }}>{releaseTrackErr[cid]}</div>
                    ) : (tks || []).map((tk) => {
                      const owned = alreadyOwned(tk.trackName, tk.artistName || r.artistName);
                      const key = `rt:${cid}:${tk.trackId}`;
                      return (
                        <div key={tk.trackId} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 8px 5px 2px', borderRadius: 8 }}>
                          <span style={{ width: 16, textAlign: 'right', fontSize: 10.5, color: 'rgba(255,255,255,0.32)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                            {tk.trackNumber || '·'}
                          </span>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: 12, color: owned ? 'rgba(255,255,255,0.5)' : '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {tk.trackName || 'Untitled'}
                            </div>
                          </div>
                          {tk.trackTimeMillis ? (
                            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                              {(() => { const s = Math.round(tk.trackTimeMillis / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; })()}
                            </span>
                          ) : null}
                          {owned && dlState[key] !== 'done' ? (
                            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', flexShrink: 0 }}>owned</span>
                          ) : (
                            <DlBtn st={dlState[key]} progress={dlProgress[key]} accent={accent} title="Download this track" onClick={() => downloadReleaseTrack(r, tk)} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          }) : (
            <div style={{ padding: '22px 14px', textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontSize: 12.5, lineHeight: 1.5 }}>
              No releases yet — follow artists in the Explore tab and they’ll show up here.
            </div>
          )}
        </div>
      ) : null}

      {cardTab === 'stats' && listeningStats ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 12px', scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.15) transparent' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            {!resetStatsOpen ? (
              <button
                type="button"
                onClick={() => setResetStatsOpen(true)}
                disabled={typeof onResetStats !== 'function'}
                style={{
                  border: '1px solid rgba(255,110,110,0.28)', borderRadius: 7,
                  background: 'rgba(255,90,90,0.08)', color: 'rgba(255,180,180,0.9)',
                  padding: '5px 9px', fontSize: 10, fontWeight: 700,
                  cursor: typeof onResetStats === 'function' ? 'pointer' : 'default',
                  opacity: typeof onResetStats === 'function' ? 1 : 0.45,
                }}
              >
                Reset stats
              </button>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', justifyContent: 'flex-end' }}>
                <span style={{ fontSize: 10, color: 'rgba(255,190,190,0.85)' }}>Reset all listening history?</span>
                <button
                  type="button"
                  onClick={() => setResetStatsOpen(false)}
                  disabled={resettingStats}
                  style={{ border: '1px solid rgba(255,255,255,0.12)', borderRadius: 7, background: 'transparent', color: 'rgba(255,255,255,0.65)', padding: '5px 8px', fontSize: 10, cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleResetStats}
                  disabled={resettingStats}
                  style={{ border: '1px solid rgba(255,100,100,0.45)', borderRadius: 7, background: 'rgba(255,80,80,0.18)', color: '#ffc0c0', padding: '5px 8px', fontSize: 10, fontWeight: 700, cursor: resettingStats ? 'wait' : 'pointer' }}
                >
                  {resettingStats ? 'Resetting…' : 'Confirm'}
                </button>
              </div>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
            {[[listeningStats.plays7, 'plays · 7d'], [listeningStats.plays30, 'plays · 30d'], [`${listeningStats.hours30.toFixed(1)}h`, 'heard · 30d']].map(([v, l]) => (
              <div key={l} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: '10px 6px', textAlign: 'center' }}>
                <div style={{ fontSize: 17, fontWeight: 800, color: '#fff', fontVariantNumeric: 'tabular-nums' }}>{v}</div>
                <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.45)', marginTop: 2, letterSpacing: '0.05em', textTransform: 'uppercase' }}>{l}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)', marginBottom: 6 }}>Top tracks</div>
          {listeningStats.topTracks.length ? listeningStats.topTracks.map(({ track: t, n }, i) => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 4px' }}>
              <span style={{ width: 16, textAlign: 'right', fontSize: 11, color: 'rgba(255,255,255,0.35)', fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
              <div style={{ width: 30, height: 30, borderRadius: 6, flexShrink: 0, backgroundColor: 'rgba(255,255,255,0.06)', backgroundImage: t.coverArt ? `url("${t.coverArt.replace(/"/g, '%22')}")` : 'none', backgroundSize: 'cover', backgroundPosition: 'center' }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</div>
              </div>
              <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.45)', fontVariantNumeric: 'tabular-nums' }}>{n}×</span>
            </div>
          )) : <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', padding: '8px 4px' }}>Nothing played in the last 30 days.</div>}
          {listeningStats.topArtists.length ? (<>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)', margin: '12px 0 6px' }}>Top artists</div>
            {listeningStats.topArtists.map(([name, n], i) => (
              <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 4px' }}>
                <span style={{ width: 16, textAlign: 'right', fontSize: 11, color: 'rgba(255,255,255,0.35)', fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: i === 0 ? `rgb(${accent})` : '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
                </div>
                <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.45)', fontVariantNumeric: 'tabular-nums' }}>{n} plays</span>
              </div>
            ))}
          </>) : null}
        </div>
      ) : null}

      {/* NOTE: the Settings tab that used to sit here was an OVERLAY-layout
          picker — auto-hide dock, centered vs side mode, transition style.
          Those settings belong to the surface, not the card, and the props
          they need (autoHideDock, pickAutoHideDock, transitionMode,
          onSetTransitionMode) don't exist outside the overlay. Rather than
          drag four host-specific props through the interface, the tab list
          is now host-configurable: `sections` below. A host that wants a
          settings tab passes its own via `extraSections`. */}
      </div>

      <div style={{
        padding: '8px 10px', flexShrink: 0, textAlign: 'center',
        fontSize: 10.5, color: 'rgba(255,255,255,0.4)',
        borderTop: '1px solid rgba(255,255,255,0.06)',
      }}>
        {cardTab === 'library'
          ? (openAlbumData
            ? `${openAlbumTracks.length} ${openAlbumTracks.length === 1 ? 'track' : 'tracks'} · click plays · Esc closes`
            : libraryView === 'albums'
              ? `${filteredAlbums.length} ${filteredAlbums.length === 1 ? 'album' : 'albums'} · click one to open it`
              : `${spotlightResults.length} ${spotlightResults.length === 1 ? 'track' : 'tracks'} · ↑ ↓ browse · click plays · Esc closes`)
          : cardTab === 'find' ? (findSource === 'soulseek'
            ? 'Soulseek · Enter searches · downloads import automatically'
            : findSource === 'albums'
              ? 'Spotify · Enter searches · open an album for single tracks'
              : 'Spotify · Enter searches · downloads import automatically')
          : cardTab === 'releases' ? 'From artists you follow · click an album for its tracks'
            : cardTab === 'stats' ? 'Last 30 days of listening'
              : 'Applies instantly'}
      </div>
      {/* Resize grip — drag to size the card; double-click resets to the
          cover square. Corner-anchored so it never collides with content. */}
      <div
        onPointerDown={handleCardResizeDown}
        onPointerMove={handleCardResizeMove}
        onPointerUp={handleCardResizeUp}
        onPointerCancel={handleCardResizeUp}
        onDoubleClick={resetCardSize}
        title="Drag to resize · double-click to reset"
        style={{
          position: 'absolute', right: 0, bottom: 0, width: 20, height: 20,
          cursor: 'nwse-resize', touchAction: 'none', zIndex: 3,
          display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: 5,
        }}
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1.4" strokeLinecap="round">
          <path d="M9 1L1 9M9 5L5 9" />
        </svg>
      </div>
    </div>
  );

  /* The card's animations. These keyframes previously lived in the OVERLAY's
   * <style> block, so mounting this component anywhere else meant every
   * `animation:` below referenced a name the document had never heard of —
   * no entrance, no exit, and `fill-mode: both` pinning elements into an
   * indeterminate composited state that rendered soft/blurry. Shipping them
   * with the component is the only way it can be self-contained. */
  /* Empty string (→ `none`) when the card sits at its default spot, so the
     wrapper isn't needlessly promoted to a composited layer. A transform —
     even translate(0,0) — makes Chromium rasterise the subtree at CSS rather
     than device resolution, which is what made the artwork inside look soft.
     Once you drag it the transform is unavoidable, but that's a deliberate
     trade for smooth dragging. */
  /* CC_NUDGE (centering compensation for the rail on the left) is applied as
     a LAYOUT margin, not folded into the transform. Folded in, the transform
     was non-zero even at rest, so the layer promotion — and the soft raster
     that comes with it — was permanent. As a margin it's pixel-snapped and
     free. The transform now carries only the drag offset, so a card sitting
     where it opened has no transform at all. */
  const ccDx = Math.round(cardOffset.x);
  const ccDy = Math.round(cardOffset.y);
  const ccShift = (ccDx || ccDy) ? `translate(${ccDx}px, ${ccDy}px)` : '';

  const vw = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 900 : window.innerHeight;

  const ccStyles = (
    <style>{`
      @keyframes immerseFullscreenIn { 0% { opacity: 0; } 100% { opacity: 1; } }
      @keyframes immerseFullscreenSearchCardIn { 0% { opacity: 0; transform: scale(0.96) translateY(10px); } 100% { opacity: 1; transform: none; } }
      @keyframes immerseFullscreenSearchCardOut { 0% { opacity: 1; transform: scale(1) translateY(0); } 100% { opacity: 0; transform: scale(0.965) translateY(4px); } }
      @keyframes immerseFullscreenTabIn { 0% { opacity: 0; transform: translateY(8px); } 100% { opacity: 1; transform: none; } }
      @keyframes immerseFullscreenTabOut { 0% { opacity: 1; transform: translateY(0); } 100% { opacity: 0; transform: translateY(8px); } }
      @keyframes immerseFullscreenMenuIn { 0% { opacity: 0; transform: translateX(26px) scale(0.94); } 100% { opacity: 1; transform: none; } }
      @keyframes immerseFullscreenMenuOut { 0% { opacity: 1; transform: translateX(0) scale(1); } 100% { opacity: 0; transform: translateX(26px) scale(0.94); } }
      @keyframes immerseFullscreenMenuIconIn { 0% { opacity: 0; transform: translateX(10px); } 100% { opacity: 1; transform: none; } }
      @keyframes immerseFullscreenMenuIconOut { 0% { opacity: 1; transform: translateX(0); } 100% { opacity: 0; transform: translateX(10px); } }
      @keyframes immerseFullscreenSpin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    `}</style>
  );

  if (!open && !exiting) return null;

  /* The YouTube source picker. The overlay renders this OUTSIDE its card, but
   * `pick` is set from inside (openPicker), so keeping it here makes the
   * component self-contained — a host that forgets to render it would get a
   * download that silently stalls waiting for a choice nobody can make. */
  const videoPicker = (
    <VideoPicker
      open={!!pick}
      meta={pick?.meta}
      seed={pick?.seed}
      accent={accent}
      pushToast={pushToast}
      onClose={() => setPick(null)}
      onImported={(track) => { if (pick?.dlKey) markDl(pick.dlKey, 'done'); onTrackImported?.(track); }}
    />
  );

  return variant === 'centered' ? (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex',
      alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
    }}>
      <div style={{
        position: 'relative', pointerEvents: 'auto',
        transform: ccShift || 'none',
        marginLeft: CC_NUDGE,
        transition: cardDragRef.current ? 'none' : 'transform 280ms cubic-bezier(0.2, 0.8, 0.2, 1)',
      }}>{ccStyles}{commandMenu}{libraryCard}{videoPicker}</div>
    </div>
  ) : (
    <div style={{
      position: 'relative',
      transform: ccShift || 'none',
      marginLeft: CC_NUDGE,
      transition: cardDragRef.current ? 'none' : 'transform 280ms cubic-bezier(0.2, 0.8, 0.2, 1)',
      /* INTEGER px, never percentages. A percentage width resolves against a
         viewport-derived parent (min(52vh, 42vw)) that is almost always
         fractional — and a fractional-width box carrying a backdrop-filter
         gets its whole layer resampled, which is what made the artwork and
         text inside look soft. Fixed integers rasterise crisply. */
      width: Math.round(Math.min(cardSize ? cardSize.w : 460, vw - 130)),
      height: Math.round(Math.min(cardSize ? cardSize.h : 540, vh - 60)),
      pointerEvents: 'auto',
    }}>
      <div style={{ position: 'relative', width: '100%', height: '100%' }}>
        {ccStyles}
        {commandMenu}
        {libraryCard}
        {videoPicker}
      </div>
    </div>
  );
}
