import React, { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { LyricsEditor, SyncedLyrics, PlainLyrics } from './Lyrics.jsx';
/* The DOCK's editor. LyricsEditor stays where it is — the fullscreen stage it
   was designed for is unchanged — but a full-height textarea and two
   side-by-side actions don't shrink into a 360px column, so the panel gets its
   own. Same props, same onSave contract. See PanelLyricsEditor. */
import PanelLyricsEditor from './PanelLyricsEditor.jsx';
import { AnimatedGradientBg } from './VisualEffects.jsx';
import { MetadataEditor, AlbumMetadataEditor } from './MetadataEditor.jsx';
import { SpotifyCredsPanel, SoulseekCredsPanel, StudioMotionStyles } from './StudioOnboarding.jsx';
import { useToast, setToastLayout, ToastPositionPicker } from './Toasts.jsx';
import { DownloadProgressBar, useDownloadProgress, VideoPicker, ExplicitBadge, PlayIcon, PauseIcon } from './sharedUI.jsx';
import CommandCenter from './CommandCenter.jsx';
import InstantSearch from './InstantSearch.jsx';
import LyricShare from './LyricShare.jsx';
import { LyricsPickerButton } from './LyricsPicker.jsx';
import useCoverFlight from './useCoverFlight.js';
import { sampleCoverTheme, washSourceFor, recordWashSource, recordDeep, setColourIntensity, pageWash, pageTone, barTone, readableAccent, accentTextColor } from './coverTheme.js';
import { getFileFormatLabel, formatTime, formatDurationMs, formatTotalMs, titleCollator, parseGenres } from './mediaUtils.js';
import { songKey } from './instantSearch.js';
import ArtistPage from './ArtistPage.jsx';
import { setPreviewHooks, isPreviewing, stop as stopPreview } from './previewPlayer.jsx';
import ArtistGrid from './ArtistGrid.jsx';
import { hoverPreload, spotifyIdOf } from './spotifyMediaElement.js';
import { CompactVizContext, CompactVizSlot, CompactVizPicker, COMPACT_VIZ_KEY, COMPACT_VIZ_COVER_KEY } from './CompactVisualizer.jsx';
import { VIZ_IDS } from './compactVizStyles.js';
import { SpotifyHome, SpotifyReleases } from './MySpotify.jsx';
import NotificationsButton from './Notifications.jsx';
import { useStudioFollows, isStudioFollowed, followArtist, unfollowArtist } from './studioFollows.js';
import { notePlayContext } from './playContext.js';
import { deriveAccent, applyAccent, accentSourceFromTheme, lastAccentSource, rememberAccentSource, NEUTRAL_ACCENT, TOKENS_CSS } from './accentTokens.js';

/* =========================================================================
 *  studio — home  (redesign #3: the side menu)
 *
 *  The homescreen is now a small app with a navigation rail:
 *
 *    my spotify — Home and New Releases from the signed-in Spotify
 *               account (MySpotify.jsx), playable in place.
 *    library  — Songs and Albums views. Albums group the library into
 *               real album pages: a cover grid that opens into a detail
 *               view with a numbered tracklist, play-album, and removal.
 *    find     — the search pill + Spotify / Albums / Soulseek results,
 *               moved out of library into its own room.
 *    stats    — in-depth listening stats from the play-event log: totals,
 *               daily activity, hour-of-day, top tracks and artists.
 *    settings — playback (gapless) + credentials.
 *
 *  The rail mirrors the overlay's command-center language: a gliding
 *  active indicator, glassy chrome, pill shapes. All plumbing (IPC
 *  protocol, download states, soulseek album progress, metadata editing,
 *  removal, the resume pill) is carried over unchanged.
 * ========================================================================= */

const api = () => (typeof window !== 'undefined' ? window.electronAPI : null);

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb.toFixed(0)}MB`;
}

function fmtDur(s) {
  if (!s || !Number.isFinite(s)) return '';
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}

/* ---------------------------------------------------------------------------
 *  Soulseek result shaping.
 *
 *  soulseekSearch returns one row per (peer × file) — a search for one album
 *  routinely comes back as 90+ rows that are really 12 songs offered by 30
 *  people. These helpers turn that flat list into "songs, each with sources",
 *  which is the shape the Find view renders and, more importantly, the shape
 *  of the decision: you're not picking a file, you're picking who to get it
 *  from.
 * ------------------------------------------------------------------------- */

const LOSSLESS_EXTS = new Set(['flac', 'alac', 'wav', 'aiff', 'aif', 'ape', 'wv']);

/**
 * Badge label + rank for one file. The tiers mirror bitrateTier() in
 * soulseekClient.js, so what the badge says and the order results arrive in
 * can't disagree.
 */
function slskQuality(ext, bitrate) {
  const e = String(ext || '').toLowerCase();
  if (e === 'mixed') return { label: 'Mixed', tier: 2 };
  if (LOSSLESS_EXTS.has(e)) return { label: e === 'flac' ? 'FLAC' : e.toUpperCase(), tier: 5, lossless: true };
  const br = Number(bitrate) || 0;
  if (br >= 320) return { label: '320', tier: 4 };
  if (br >= 256) return { label: '256', tier: 3 };
  if (br >= 192) return { label: '192', tier: 2 };
  if (br > 0) return { label: String(br), tier: 1 };
  return { label: e ? e.toUpperCase() : '—', tier: 0 };
}

/** Peer upload speed (bytes/s) → "4.8 MB/s". Empty when the peer didn't say. */
function fmtSpeed(bytesPerSec) {
  const n = Number(bytesPerSec) || 0;
  if (n <= 0) return '';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${Math.round(n / 1024)} kB/s`;
}

/**
 * "03 - Tool - Schism.flac" → { title: "Tool - Schism", lead: "Tool", rest: "Schism" }
 *
 * Only the parts that are reliably noise get stripped here: the extension and
 * a leading track number in any of the shapes peers actually use. The
 * "Artist - Title" split is NOT applied — it's genuinely ambiguous ("Ticks &
 * Leeches - Live" is one title, not an artist and a song) so the candidate
 * halves are handed back and groupSlskFiles decides using the whole result
 * set, where an artist prefix repeats and a title's first half doesn't.
 */
function parseSlskName(filename) {
  const noExt = String(filename || '').replace(/\.[a-z0-9]{2,5}$/i, '');
  let s = noExt;
  s = s.replace(/^\s*[[(]\s*\d{1,3}\s*[\])]\s*[-._–]*\s*/, '');  // "[06] " / "(06)-"
  s = s.replace(/^\s*\d{1,3}\s*[-._–]+\s*/, '');                    // "06 - " / "06." / "06_"
  s = s.replace(/^\s*\d{1,3}\s+(?=\S)/, '');                        // "06 Schism"
  s = s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  // A name that was nothing but a number ("12.mp3") loses everything to the
  // strippers above — better to show the raw name than an empty row.
  if (!s || /^\d+$/.test(s)) s = noExt.replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || String(filename || '');
  const parts = s.split(/\s+[-–]\s+/);
  const lead = parts.length >= 2 ? parts[0].trim() : '';
  const rest = parts.length >= 2 ? parts.slice(1).join(' - ').trim() : '';
  return { title: s, lead, rest };
}

/**
 * Flat peer files → one entry per song, sources ranked best-first.
 * `order` keeps each group's position in the incoming (relevance-ranked) list
 * so the default sort can put relevance back.
 */
function groupSlskFiles(rows) {
  const parsed = (rows || []).filter(Boolean).map((r) => ({ r, n: parseSlskName(r.filename) }));
  /* Decide once, for the whole result set, whether a leading "X - " is an
     artist. It is if X fronts two or more files, or if the folder it lives in
     is named after X as well — both true of an artist, neither true of a song
     whose title happens to contain a dash. */
  const leadCount = new Map();
  for (const { n } of parsed) {
    if (!n.lead) continue;
    const k = n.lead.toLowerCase();
    leadCount.set(k, (leadCount.get(k) || 0) + 1);
  }
  const map = new Map();
  parsed.forEach(({ r, n }, i) => {
    const lead = n.lead.toLowerCase();
    const inFolder = !!n.lead && String(r.folder || r.filePath || '').toLowerCase().includes(lead);
    const split = !!n.lead && !!n.rest && ((leadCount.get(lead) || 0) >= 2 || inFolder);
    const title = split ? n.rest : n.title;
    const artist = split ? n.lead : '';
    const key = title.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!key) return;
    const src = { ...r, _q: slskQuality(r.ext, r.bitrate), _title: title, _artist: artist };
    const cur = map.get(key);
    if (cur) {
      cur.sources.push(src);
      if (!cur.artist && artist) cur.artist = artist;
    } else {
      map.set(key, { key, title, artist, order: i, sources: [src] });
    }
  });
  const out = [...map.values()];
  for (const g of out) {
    // Same precedence the client ranks by: format, then a free upload slot,
    // then how fast that peer actually is, then bitrate.
    g.sources.sort((a, b) => (b._q.tier - a._q.tier)
      || (Number(!!b.slots) - Number(!!a.slots))
      || ((b.speed || 0) - (a.speed || 0))
      || ((b.bitrate || 0) - (a.bitrate || 0)));
    g.best = g.sources[0];
    g.duration = (g.sources.find((x) => Number(x.duration) > 0) || {}).duration || 0;
    g.freeCount = g.sources.filter((x) => x.slots).length;
  }
  return out.sort((a, b) => a.order - b.order);
}

/** "4h 32m" / "37m" / "45s" — for listening-time totals. */
function fmtSpan(totalSec) {
  const s = Math.max(0, Math.round(totalSec || 0));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtRelDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** 0–23 → "9 PM" / "12 AM"; empty window → "—". */
function fmtHour(h) {
  if (h == null || h < 0) return '—';
  const ap = h < 12 ? 'AM' : 'PM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${ap}`;
}

/**
 * The cover-derived accent can be very dark or muddy, which makes accent-
 * colored text and thin bars hard to read on the dark UI. This returns a
 * version of the "r, g, b" accent lifted toward white until it clears a
 * minimum perceived brightness — preserving hue while guaranteeing contrast.
 * Used on the stats page (numbers, bars, tab underline, etc.).
 */
/* readableAccent() and accentTextColor() moved to coverTheme.js — the artist
   page needs them too, and a copy per file is how two colour systems start. */

/* Now Playing bar surface presets. Blue-grey first because that's what the
   reference uses; the rest span neutral-to-warm so there's something that sits
   right against any accent. */
const NP_BAR_DEFAULT = '#20242f';
const NP_BAR_PRESETS = [
  ['#20242f', 'Slate'],
  ['#16171b', 'Graphite'],
  ['#0a0a0b', 'Black'],
  ['#1b2430', 'Steel'],
  ['#241f2b', 'Plum'],
  ['#1f2a26', 'Pine'],
  ['#2a2320', 'Umber'],
];

/* Height of the top bar. Module scope because both StudioHome (which lays the
   content column out beneath it) and NowPlayingPanelDock (a sibling of the bar,
   which has to inset itself past it) need the same number. */
/* 62 = the 46px tabs plus 8px of breathing room either side. It was 72, which
   left 13px of dead bar above and below the tabs and cost the content wrapper
   the same height for nothing. */
/* ---- Theme ---------------------------------------------------------------
 * Defaults reproduce the app exactly as it looked before theming existed, so
 * an untouched install sees no change.
 *
 * Colours are stored as "r, g, b" triples rather than hex because most of the
 * UI needs them at partial alpha — rgba(var(--st-fg-rgb), 0.4) and friends —
 * and you can't take a channel out of a hex string in CSS.
 */
const THEME_DEFAULTS = {
  /* Fixed. These were editable and it made the app impossible to reason about:
     five colours feeding hundreds of rules, any of which could be nudged into
     something unreadable, on top of three surfaces that ALSO take colour. The
     surfaces are where colour belongs; this is the frame around them. */
  bg: '0, 0, 0',            // app background
  text: '255, 255, 255',    // primary text
  sub: '255, 255, 255',     // secondary text (alpha comes from each use site)
  fg: '255, 255, 255',      // panels, borders, dividers, hover fills
  accent: null,             // unused; the accent is white — see `const accent`
  detailMode: 'cover',      // 'cover' | 'fixed' — album/playlist page wash
  detailColor: '70, 84, 190',
  /* How the now-playing wash reads colour out of the cover, and how far it
     reaches. See coverTheme.js for what each extraction actually does. */
  /* ---- Surfaces -------------------------------------------------------
   * Three surfaces, three settings, no cross-talk. Each says where its own
   * colour comes from and nothing else reaches into it.
   *
   * This replaces washStyle / washExtent / washMatchBar / npPanelSurface /
   * barGradientFrom / npBarImmerseStyle, which between them let one control
   * change two surfaces and left three ways to say "use the cover".
   */
  /* 'auto' asks each cover which reading suits it — see autoReading() in
     coverTheme.js. Neither average nor dominant wins in general, which is why
     picking one globally always looked wrong on half the library, and why the
     picker was removed rather than given a better default. Fixed at 'auto';
     the theme loader coerces older saved values. */
  coverColour: 'auto',
  /* How saturated cover-derived surfaces are allowed to get. Displays with a
     vibrancy boost push everything toward fully clipped colour, so this is a
     setting rather than a constant — see setColourIntensity(). */
  colourIntensity: 'balanced',  // 'off' | 'muted' | 'balanced' | 'vivid' | 'full'
  pageSurface: 'cover',     // 'off' | 'colour' | 'cover' | 'coverFull'
  pageColour: '14, 13, 18',
  panelSurface: 'cover',    // 'black' | 'colour' | 'cover' | 'bar'
  panelColour: '14, 13, 18',
  barSurface: 'colour',     // 'colour' | 'cover'
};

function rgbToHex(rgb) {
  const p = String(rgb || '').split(',').map((n) => Math.max(0, Math.min(255, parseInt(n.trim(), 10) || 0)));
  return `#${p.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

const TOPBAR_H = 62;

/* Library rail. 'recent' first because that's the view you want after an
   import, which is when you open the library most. */
/* Sidebar order, per the mockup. 'recent' is kept as a view id — Home's empty
   state and the import flow both navigate to it — but it isn't a sidebar row:
   Songs already sorts by date added, so a separate entry duplicated it. */
const LIB_VIEWS = [
  ['songs', 'Songs', 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm12-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'],
  ['albums', 'Albums', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  ['artists', 'Artists', 'M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM21 21v-2a4 4 0 0 0-3-3.87'],
];

/* Sidebar, above Library: the signed-in Spotify account's own pages
   (MySpotify.jsx). They replaced the old Home and Stats tabs in the top bar. */
const MY_SPOTIFY = [
  ['sp-home', 'Home', 'M3 11l9-8 9 8M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5'],
  ['sp-releases', 'New Releases', 'M12 3l1.9 5.6L19.5 10.5 13.9 12.4 12 18l-1.9-5.6L4.5 10.5l5.6-1.9L12 3zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z'],
];
const MY_SPOTIFY_IDS = new Set(MY_SPOTIFY.map(([id]) => id));
/* Sections that no longer exist, from stored nav state and old callers. */
const LEGACY_SECTIONS = new Set(['home', 'stats', 'discover', 'find']);

/* Library width. The sidebar is a permanent column beside the content, not a
   tab you switch to — so the wrapper starts after it rather than under it. */
const SIDEBAR_W = 236;

export default function StudioHome({
  library = [],
  onImportFiles,         // () → App: file picker, tag read, DB write
  onImportFolder,        // () → App: folder picker, recursive scan
  onImportSpotify,       // () → App: opens the Spotify playlist importer
  importing = false,     // an import is in flight — disable the buttons
  queue = [],
  queueIndex = -1,
  onReorderQueue,
  albumCoverOverrides = {},
  currentTrack = null,
  isPlaying = false,
  onPlayTrack,           // (track, sortedList) → engine
  onTrackImported,       // (track) → App merges into library
  onResumeOverlay,       // reopen the fullscreen overlay
  onSpotifyCredsSaved,
  onUpdateTrackMetadata, // (id, fields) → App: DB write, tag write, reload
  onUpdateAlbumMetadata, // (albumKey, fields, scope) → App: bulk album write
  onRemoveFromLibrary,   // (ids[]) → App: removal + queue fallout
  onToggleFavorite,      // (id) → App: optimistic favourite toggle + DB write
  onPlayNext,            // (tracks) → App: insert after the current track
  onAddToQueue,          // (tracks) → App: append to the queue
  // Transport + volume, for the Now Playing panel's inline controls
  volume = 1,
  onSetVolume,
  onTogglePlay,
  onPrev,
  onNext,
  lyricsData,            // { synced, plain, instrumental } | null
  playlists = [],        // [{ id, name, coverArt, trackIds }]
  onCreatePlaylist,      // ({name}) → App: create, returns { ok, id }
  onDeletePlaylist,
  onAddTracksToPlaylist, // (playlistId, trackIds)
  onRenamePlaylist,      // (id, name)
  onRemoveFromPlaylist,  // (playlistId, trackId)
  onSetAlbumCover,       // (albumKey, dataUrl|null) → App: cover override
  onUpdatePlaylist,      // (id, {coverArt}) → App: playlist fields
  onClearLibrary,        // ({deleteFiles}) → App: wipe the library. Play
                         // history deliberately survives (see libraryDb).
  onClearEverything,     // () → StudioShell: wipe library + listening stats
                         // AND reset the onboarded flag → first-run setup.
  onPickLyrics,          // (candidate) → StudioShell: persist + apply a chosen
                         // lyrics version from the browser
  onLyricsSaved,         // (synced, plain) → StudioShell: the ONLY owner of
                         // lyrics state. Every editor mount reports here.
  currentTime = 0,       // playback position in seconds, for synced-lyric highlight
  onSeek,                // (seconds) → App: scrub playback
  duration = 0,          // current track length in seconds (compact visualizer)
  analyserRef = null,    // App's Web Audio analyser, for local files
  onNeedAnalyser,        // () → App builds the analyser if it isn't yet
  shuffleOn = false,
  repeat = 'off',
  onToggleShuffle,
  onToggleRepeat,
  // Discover (owned by App.jsx — same plumbing as Immerse's Releases tab)
  playEvents = [],
  releases = [],
  releasesRefreshing = false,
  onRefreshReleases,
  followedArtists = [],
  onFollowArtist,        // (artistName, itunesArtistId) → App
  onUnfollowArtist,      // (artistName) → App
  // Playback (owned by App.jsx)
  transitionMode = 'off',
  onSetTransitionMode,
  // Discord rich presence (owned by App.jsx)
  discordPresenceEnabled = false,
  onSetDiscordPresenceEnabled,
  discordAppId = '',
  onSetDiscordAppId,
  discordPresenceDetail = 'full',
  onSetDiscordPresenceDetail,
  imgbbApiKey = '',
  onSetImgbbApiKey,
  /** Re-runs first-launch setup. Temporary, for reviewing the flow. */
  onReplayOnboarding,
  discordHideWhenPaused = true,
  onSetDiscordHideWhenPaused,
  themeRgb,              // { accent, mid, wash } from last cover, for the bg
}) {
  const rawAccent = themeRgb?.accent || '120, 120, 120';

  /* ---- Theme (persisted) ---- */
  /* Base colours are no longer editable, so any saved overrides are discarded
     on load rather than left painting an app that has no control to undo them.
     Only the three surface settings survive. */
  const BASE_COLOUR_KEYS = ['bg', 'fg', 'text', 'sub', 'accent'];
  const [theme, setTheme] = useState(() => {
    try {
      const raw = localStorage.getItem('studio:theme');
      const saved = raw ? JSON.parse(raw) : {};
      for (const k of BASE_COLOUR_KEYS) delete saved[k];
      /* The cover-reading picker is gone and Auto is the only mode now, so a
         saved 'dominant' / 'average' / 'aurora' would otherwise stick forever
         with no UI left to change it. Coerced on load rather than deleted, so
         the key keeps its documented shape for the code that reads it. */
      delete saved.coverColour;
      const next = { ...THEME_DEFAULTS, ...saved, coverColour: 'auto' };
      if (raw) { try { localStorage.setItem('studio:theme', JSON.stringify(next)); } catch { /* ignore */ } }
      return next;
    } catch { return { ...THEME_DEFAULTS }; }
  });
  const setThemeKey = useCallback((k, v) => {
    setTheme((t) => {
      const next = { ...t, [k]: v };
      try { localStorage.setItem('studio:theme', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const resetTheme = useCallback(() => {
    setTheme({ ...THEME_DEFAULTS });
    try { localStorage.removeItem('studio:theme'); } catch { /* ignore */ }
  }, []);

  const themeCustomAccent = theme.accent;

  /* Theme variables go on <html>, NOT on this component's root div.
     Modals portal to document.body, which is OUTSIDE that div — so every
     `rgb(var(--st-bg-rgb))` in a dialog resolved to nothing and the panels
     rendered fully transparent. Setting them at the document root means
     anything anywhere can read them. */
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const r = document.documentElement.style;
    r.setProperty('--st-bg-rgb', theme.bg);
    r.setProperty('--st-text-rgb', theme.text);
    r.setProperty('--st-sub-rgb', theme.sub);
    r.setProperty('--st-fg-rgb', theme.fg || theme.text);
    r.setProperty('--st-text', `rgb(${theme.text})`);
  }, [theme.bg, theme.text, theme.sub, theme.fg]);

  /* ---------- Appearance settings (persisted) ------------------------------ */
  const [navStyle, setNavStyle] = useState(() => { try { return localStorage.getItem('studio:navStyle') || 'chip'; } catch { return 'chip'; } });
  const setNavStylePref = useCallback((v) => { setNavStyle(v); try { localStorage.setItem('studio:navStyle', v); } catch { /* ignore */ } }, []);

  /* ---------- Settings page shell ----------------------------------------
   * Which settings category is showing.
   *
   * The live preview that used to sit beside this was removed: the real
   * surfaces are one click away and always accurate, which a miniature of
   * them can only approximate. */
  const [setCat, setSetCat] = useState('colour');

  /* Date added column. Defaults ON — it's been visible since the table
     existed, and a preference that silently removes a column on upgrade is a
     bug report. Stored as the string 'off' so the absent key reads as on. */
  const [showDateAdded, setShowDateAdded] = useState(() => {
    try { return localStorage.getItem('studio:showDateAdded') !== 'off'; } catch { return true; }
  });
  const toggleDateAdded = useCallback(() => {
    setShowDateAdded((v) => {
      const next = !v;
      try { localStorage.setItem('studio:showDateAdded', next ? 'on' : 'off'); } catch { /* ignore */ }
      return next;
    });
  }, []);
  /* The accent is white, always.
     It used to be cover-derived, then overridable, then switchable off — three
     sources for one colour, and it fed roughly sixty places including surfaces
     it had no business painting. White is legible on every surface Studio can
     produce, and it takes the guessing out of the one colour that appears
     everywhere. Colour now comes from the three surfaces that ask for it. */
  /* Settings → Library → Play counts in lists. Off by default (brief); adds a
     PLAYS column to album and artist pages. Stats counts plays either way. */
  const [showPlayCounts, setShowPlayCounts] = useState(() => {
    try { return localStorage.getItem('studio:showPlayCounts') === 'on'; } catch { return false; }
  });
  const toggleShowPlayCounts = useCallback(() => {
    setShowPlayCounts((v) => { const n = !v; try { localStorage.setItem('studio:showPlayCounts', n ? 'on' : 'off'); } catch { /* ignore */ } return n; });
  }, []);
  /* Settings → Layout → List density. Row height for every song table. */
  /* Compact bar visualizer (CompactVisualizer.jsx): 'off' or a style id. */
  const [compactViz, setCompactViz] = useState(() => {
    try { const v = localStorage.getItem(COMPACT_VIZ_KEY); return v && (v === 'off' || VIZ_IDS.has(v)) ? v : 'off'; } catch { return 'off'; }
  });
  const pickCompactViz = useCallback((v) => { setCompactViz(v); try { localStorage.setItem(COMPACT_VIZ_KEY, v); } catch { /* ignore */ } }, []);
  /* Whether it takes the playing cover's colours (default) or draws in white. */
  const [compactVizCover, setCompactVizCover] = useState(() => { try { return localStorage.getItem(COMPACT_VIZ_COVER_KEY) !== '0'; } catch { return true; } });
  const toggleCompactVizCover = useCallback(() => {
    setCompactVizCover((on) => { const next = !on; try { localStorage.setItem(COMPACT_VIZ_COVER_KEY, next ? '1' : '0'); } catch { /* ignore */ } return next; });
  }, []);
  const [listDensity, setListDensity] = useState(() => { try { return localStorage.getItem('studio:listDensity') || 'default'; } catch { return 'default'; } });
  const pickListDensity = useCallback((v) => { setListDensity(v); try { localStorage.setItem('studio:listDensity', v); } catch { /* ignore */ } }, []);
  /* Compact mode. The content card takes the whole window (10px gutters) and
     the Now Playing bar runs edge to edge beneath it. The top bar and the
     library sidebar aren't gone — they slide in over the card when the
     pointer touches the top or left edge of the window (`chromePeek`), so
     navigation, search, settings and window dragging all still work without
     reserving any space. Ctrl/Cmd+Shift+C toggles it from anywhere. */
  const [compactMode, setCompactMode] = useState(() => { try { return localStorage.getItem('studio:compact') === '1'; } catch { return false; } });
  const pickCompactMode = useCallback((on) => {
    const n = !!on;
    setCompactMode(n);
    try { localStorage.setItem('studio:compact', n ? '1' : '0'); } catch { /* ignore */ }
  }, []);
  const [chromePeek, setChromePeek] = useState(null); // null | 'top' | 'side'
  /* When the compact top bar tucks away, whatever dropped down from it goes
     too, rather than waiting open and invisible for the next peek. */
  useEffect(() => {
    if (compactMode && chromePeek !== 'top') window.dispatchEvent(new Event('studio:topbar-hidden'));
  }, [compactMode, chromePeek]);
  /* Fullscreen Now Playing. Takes the whole window (10px edges) over the
     top bar, sidebar, content card and Now Playing bar; the side panel is
     unavailable while it's up, so lyrics / queue / info live in the view's
     own panel (`npFullTab`, null = closed, cover centred alone). Not
     persisted across launches — opening the app straight into a player
     with nothing loaded would be a dead screen. The tab choice is. */
  const [npFull, setNpFull] = useState(false);
  const [npFullTab, setNpFullTab] = useState(() => {
    try { const v = localStorage.getItem('studio:npFullTab'); return v === 'lyrics' || v === 'queue' || v === 'info' ? v : null; } catch { return null; }
  });
  const pickNpFullTab = useCallback((t) => {
    setNpFullTab((cur) => {
      const n = cur === t ? null : t; // clicking the open tab closes the panel
      try { localStorage.setItem('studio:npFullTab', n || ''); } catch { /* ignore */ }
      return n;
    });
  }, []);
  /* Settings → Color → Accent. 'artwork' follows whatever is playing; 'fixed'
     pins one colour of your choosing (one of four swatches). */
  /* Back to white by default. The cover-derived accent is still here and
     still correct — it's one choice down in Settings → Color → Accent — but
     white is what the app looked right in, and a tinted page under a tinted
     accent muddies both. */
  const [accentMode, setAccentMode] = useState(() => { try { return localStorage.getItem('studio:accentMode') || 'white'; } catch { return 'white'; } });
  const [accentFixed, setAccentFixed] = useState(() => { try { return localStorage.getItem('studio:accentFixed') || '255, 122, 89'; } catch { return '255, 122, 89'; } });
  const pickAccentMode = useCallback((m) => { setAccentMode(m); try { localStorage.setItem('studio:accentMode', m); } catch { /* ignore */ } }, []);
  const pickAccentFixed = useCallback((c) => { setAccentFixed(c); try { localStorage.setItem('studio:accentFixed', c); } catch { /* ignore */ } }, []);
  /* Connections status pills — the first question anyone opening that page has. */
  const [connState, setConnState] = useState({ spotify: null, soulseek: null });
  /* The accent follows the music (implementation brief, Tokens).
     The source colour is set further down, once the playing cover has been
     sampled; this state holds the LAST source so an idle app keeps the last
     track's colour and a cold start falls back to a neutral rather than
     rendering colourless. `accent` stays an "r, g, b" string so every
     existing call site (readableAccent(accent), rgba(${accent}, a)) keeps
     working — it's now the clamped FILL variant. */
  const [accentSrc, setAccentSrc] = useState(() => lastAccentSource() || NEUTRAL_ACCENT);
  const accentTokens = useMemo(() => deriveAccent(accentSrc, theme.colourIntensity), [accentSrc, theme.colourIntensity]);
  const accent = accentTokens.fill;
  useEffect(() => { applyAccent(accentTokens); }, [accentTokens]);

  /* ---------- Navigation --------------------------------------------------- */
  const [section, setSection] = useState(() => {
    try {
      const v = localStorage.getItem('studio:homeSection');
      /* 'library' lives in the sidebar; the My Spotify pages too. Anything
         else stored (the old Home and Stats tabs, and before them Find and
         Discover) lands on My Spotify's Home. */
      return (v === 'library' || MY_SPOTIFY_IDS.has(v)) ? v : 'sp-home';
    } catch { return 'sp-home'; }
  });
  const pickSection = useCallback((s) => {
    const target = LEGACY_SECTIONS.has(s) ? 'sp-home' : s;
    setSection(target);
    try { localStorage.setItem('studio:homeSection', target); } catch { /* ignore */ }
  }, []);

  /* ---------- Row menu + metadata editor (shared by library views) --------- */
  const [rowMenu, setRowMenu] = useState(null); // { x, y, track }
  const [confirmKey, setConfirmKey] = useState(null);
  const [editingTrack, setEditingTrack] = useState(null);
  /* Clearing is irreversible, so it's gated behind a typed confirmation rather
     than a single click — this is the one action in Settings that can't be
     undone with an Undo toast. */
  /* The docked Now Playing panel. Persisted — the whole reason it's a dock
     rather than a popout is that it stays put, so reopening it on every
     navigation would defeat the point. */
  const [npPanelOpen, setNpPanelOpen] = useState(() => {
    try { return localStorage.getItem('studio:npPanelOpen') === '1'; } catch { return false; }
  });
  const [npPanelTab, setNpPanelTab] = useState(() => {
    try { return localStorage.getItem('studio:npPanelTab') || 'queue'; } catch { return 'queue'; }
  });
  const setPanel = useCallback((open, tab) => {
    setNpPanelOpen(open);
    try { localStorage.setItem('studio:npPanelOpen', open ? '1' : '0'); } catch { /* ignore */ }
    if (tab) {
      setNpPanelTab(tab);
      try { localStorage.setItem('studio:npPanelTab', tab); } catch { /* ignore */ }
    }
  }, []);
  /* A bar button opens the panel on its tab; pressing the same one again
     closes it. Pressing a DIFFERENT one while open switches tab instead of
     closing — that's the behaviour the two mutually-exclusive popouts
     couldn't have. */
  const toggleNpPanel = useCallback((tab) => {
    if (npPanelOpen && npPanelTab === tab) setPanel(false);
    else setPanel(true, tab);
  }, [npPanelOpen, npPanelTab, setPanel]);
  /* Now Playing bar surface colour. Persisted here rather than derived from
     the cover, because it's the colour you see when immerse is OFF — the
     whole point of that state is that it doesn't move with the artwork. */
  const [npBarColor, setNpBarColor] = useState(() => {
    try { return localStorage.getItem('studio:npBarColor') || NP_BAR_DEFAULT; } catch { return NP_BAR_DEFAULT; }
  });
  // Immerse can either animate sampled artwork colours or use the same stable
  // cover-derived wash as the album, playlist, and Songs library views.
  /* npBarImmerseStyle is gone: 'art' vs 'wash' was a third way to say where the
     bar's colour comes from, alongside Immerse and the bar's own setting. One
     control decides that now. */
  const pickNpBarColor = useCallback((hex) => {
    setNpBarColor(hex);
    try { localStorage.setItem('studio:npBarColor', hex); } catch { /* ignore */ }
  }, []);
  const [clearConfirm, setClearConfirm] = useState(null);   // { deleteFiles } | null
  const [clearing, setClearing] = useState(false);
  const [clearPhrase, setClearPhrase] = useState('');
  useEffect(() => { if (!clearConfirm) setClearPhrase(''); }, [clearConfirm]);


  /* Delete-everything — one rung above Clear library. Wipes library + stats
     AND drops the onboarded flag, so the app returns to first-run setup. */
  const [clearAllConfirm, setClearAllConfirm] = useState(null);   // { deleteFiles } | null
  const [clearingAll, setClearingAll] = useState(false);
  const [clearAllPhrase, setClearAllPhrase] = useState('');
  useEffect(() => { if (!clearAllConfirm) setClearAllPhrase(''); }, [clearAllConfirm]);

  /* ---------- Lyric share ------------------------------------------------
   * `lyricSel` is an inclusive {start,end} range of line indices. Selection
   * lives here rather than in NpLyricsView because the share overlay is a
   * sibling of the fullscreen portal, and because a selection has to survive
   * the lyrics view re-rendering underneath it. */
  /* Bumping this counter opens the lyrics browser. LyricsPickerButton has its
     own hover trigger, but here the button lives in the lyrics pane's toolbar
     instead, so the built-in one is suppressed and it's driven by request —
     the same arrangement the overlay uses. */
  const [lyricsPickReq, setLyricsPickReq] = useState(0);
  const [lyricSel, setLyricSel] = useState(null);
  const [lyricShareOpen, setLyricShareOpen] = useState(false);
  const startLyricSel = useCallback((idx) => setLyricSel({ start: idx, end: idx }), []);
  const extendLyricSel = useCallback((idx) => {
    setLyricSel((sel) => {
      if (!sel) return { start: idx, end: idx };
      // Clicking inside the range trims to it; outside extends. Anchored on
      // whichever end is further away so dragging either direction feels
      // symmetric rather than always growing downward.
      if (idx < sel.start) return { start: idx, end: sel.end };
      if (idx > sel.end) return { start: sel.start, end: idx };
      return { start: sel.start, end: idx };
    });
  }, []);
  const clearLyricSel = useCallback(() => { setLyricSel(null); setLyricShareOpen(false); }, []);
  // A selection is meaningless once the song changes underneath it.
  useEffect(() => { clearLyricSel(); }, [currentTrack?.id, clearLyricSel]);
  // Esc cancels the selection before anything else acts on it.
  useEffect(() => {
    if (!lyricSel || lyricShareOpen) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      clearLyricSel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [lyricSel, lyricShareOpen, clearLyricSel]);

  const selectedLyricLines = useMemo(() => {
    if (!lyricSel) return [];
    const synced = lyricsData?.synced;
    if (synced?.length) return synced.slice(lyricSel.start, lyricSel.end + 1).map((l) => l.text);
    const plain = (lyricsData?.plain || '').split('\n').filter((l) => l.trim());
    return plain.slice(lyricSel.start, lyricSel.end + 1);
  }, [lyricSel, lyricsData]);

  /* ---------- Command center (fullscreen Now Playing) --------------------
   * `open` lives here rather than inside CommandCenter because opening it
   * re-choreographs the stage around it: the cover flies up into a mini
   * header and the card takes over the cover's exact square, so the
   * transport below never moves. Same contract the overlay uses.
   *
   * ccExiting keeps the card mounted for its 260ms exit. Without it the
   * card is yanked from the DOM the instant `open` flips and there's no
   * out-animation at all — the overlay learned this the hard way and its
   * CARD_EXIT_MS is the number we match. */
  const CC_EXIT_MS = 260;
  const [ccOpen, setCcOpen] = useState(false);
  const [ccExiting, setCcExiting] = useState(false);
  const ccExitTimerRef = useRef(null);
  const npBigCoverRef = useRef(null);
  const npMiniCoverRef = useRef(null);
  const npReduceMotion = typeof window !== 'undefined'
    && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coverFlight = useCoverFlight({
    open: ccOpen,
    bigRef: npBigCoverRef,
    miniRef: npMiniCoverRef,
    radiusBig: 16,
    radiusMini: 12,
    disabled: npReduceMotion,
  });
  useEffect(() => () => { if (ccExitTimerRef.current) clearTimeout(ccExitTimerRef.current); }, []);
  const toggleCc = useCallback(() => {
    // capture() must run BEFORE the layout changes — it measures the source
    // rect that the ghost flies from.
    coverFlight.capture();
    setCcOpen((wasOpen) => {
      if (wasOpen) {
        setCcExiting(true);
        if (ccExitTimerRef.current) clearTimeout(ccExitTimerRef.current);
        ccExitTimerRef.current = setTimeout(() => setCcExiting(false), CC_EXIT_MS);
      }
      return !wasOpen;
    });
  }, [coverFlight]);

  const closeMenu = useCallback(() => { setRowMenu(null); setConfirmKey(null); }, []);

  /* The click-away listener must IGNORE presses inside the menu.
     `mousedown` on window fires BEFORE a button's `onClick`, so an unguarded
     handler closed the menu — unmounting the button — before its own click
     could run. Every menu action that opened something else therefore did
     nothing: the menu vanished and no dialog appeared. Also why the
     "Add to playlist" submenu never expanded. */
  useEffect(() => {
    if (!rowMenu) return undefined;
    const onDown = (e) => {
      if (e?.target?.closest?.('[data-rowmenu]')) return;
      closeMenu();
    };
    /* Resize and wheel close unconditionally — the menu is pinned to a fixed
       point, so either would strand it away from the row it belongs to. The
       submenu scrolls internally, so its own wheel events are stopped at the
       list rather than reaching window. */
    const onAway = () => closeMenu();
    const onKey = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); closeMenu(); } };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onAway);
    window.addEventListener('wheel', onAway, { passive: true });
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onAway);
      window.removeEventListener('wheel', onAway);
    };
  }, [rowMenu, closeMenu]);

  /* Stable identity so LibRow's memo can actually skip — an inline arrow would
     be a new function every render and defeat the comparison entirely. The
     refs let the callback stay dependency-free while still seeing the current
     handler and row list. */
  /* ---- Library table virtualisation ------------------------------------
   * Songs and Artists mount every track in the library — hundreds of rows —
   * which is the lag on tab switch. Albums never had it because it's a grid of
   * ~60 cards. Only the visible window plus an overscan margin is rendered;
   * spacer divs above and below preserve the true scroll height so the
   * scrollbar still behaves. */
  const LIB_ROW_H = 50;
  const LIB_OVERSCAN = 10;
  const [libScrollTop, setLibScrollTop] = useState(0);
  const [libViewH, setLibViewH] = useState(700);
  /* Keeps the scrolling node so the A–Z rail can drive scrollTop directly.
     The rows are virtualised, so scrollIntoView is not an option — the target
     row usually isn't mounted; jumping by index x row height is.

     Also disconnects the previous observer. The old version created one on
     every mount and never released it, so switching tabs repeatedly left a
     stack of live observers all writing the same state. */
  const libScrollElRef = useRef(null);
  const libScrollRoRef = useRef(null);
  const libScrollRef = useCallback((el) => {
    if (libScrollRoRef.current) { libScrollRoRef.current.disconnect(); libScrollRoRef.current = null; }
    libScrollElRef.current = el;
    if (!el) return;
    /* Adopt the real scroll position on attach.
       A fresh element is at scrollTop 0, but libScrollTop still held the offset
       from the last time this list was mounted — so the virtualiser computed a
       slice for a position the element wasn't at and pushed it below the fold
       behind a first * LIB_ROW_H spacer. The list looked empty until any
       scroll fired onScroll and resynced the two. */
    setLibScrollTop(el.scrollTop || 0);
    if (typeof ResizeObserver === 'undefined') return;
    setLibViewH(el.clientHeight || 700);
    const ro = new ResizeObserver(() => setLibViewH(el.clientHeight || 700));
    ro.observe(el);
    libScrollRoRef.current = ro;
  }, []);
  useEffect(() => () => { if (libScrollRoRef.current) libScrollRoRef.current.disconnect(); }, []);
  const onPlayTrackRef = useRef(onPlayTrack);
  const libRowsRef = useRef(null);
  useEffect(() => { onPlayTrackRef.current = onPlayTrack; }, [onPlayTrack]);
  const playFromLibRows = useCallback((t) => {
    onPlayTrackRef.current?.(t, libRowsRef.current || undefined, 'list');
  }, []);

  const openRowMenu = useCallback((e, track) => {
    e.preventDefault();
    e.stopPropagation();
    setConfirmKey(null);
    setRowMenu({ x: e.clientX, y: e.clientY, track });
  }, []);

  const canManage = !!(onUpdateTrackMetadata || onRemoveFromLibrary);

  /* ---------- Download bookkeeping (shared by find + discover) ------------- */
  const pushToast = useToast();
  const setDiscordPresenceDetailSafely = useCallback((detail) => {
    try {
      const result = onSetDiscordPresenceDetail?.(detail);
      if (result?.catch) result.catch((e) => {
        console.error('[discordPresenceDetail]', e);
        pushToast?.({ message: 'Could not save the Discord profile detail.', kind: 'error' });
      });
    } catch (e) {
      // A parent integration mismatch must not crash Settings. The parent should
      // still be corrected to pass its dedicated Discord detail setter.
      console.error('[discordPresenceDetail]', e);
      pushToast?.({ message: 'Could not save the Discord profile detail.', kind: 'error' });
    }
  }, [onSetDiscordPresenceDetail, pushToast]);

  /* ---- Share ------------------------------------------------------------
   * Local tracks carry no Spotify id — the library never stored one, not even
   * for tracks downloaded from a Spotify search — so the link has to be looked
   * up by "title artist" at the moment you ask for it.
   *
   * The match is verified before copying: Spotify's search is fuzzy and will
   * happily return a cover or a same-titled song by someone else, and silently
   * copying the wrong link is worse than saying it wasn't found.
   */
  const [sharing, setSharing] = useState(null);   // track id being looked up

  // navigator.clipboard is unavailable or permission-gated in some embedded
  // browser shells. Try it first, then use the still-supported selection-based
  // copy path so sharing works consistently in the desktop app as well.
  const writeClipboardText = useCallback(async (value) => {
    const text = String(value || '').trim();
    if (!text) return false;
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch { /* fall through to the selection-based fallback */ }
    }
    if (typeof document === 'undefined' || !document.body) return false;
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.setAttribute('aria-hidden', 'true');
    field.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;padding:0;border:0;opacity:0;';
    document.body.appendChild(field);
    field.select();
    field.setSelectionRange(0, text.length);
    let copied = false;
    try { copied = document.execCommand?.('copy') === true; } catch { copied = false; }
    document.body.removeChild(field);
    return copied;
  }, []);

  const copySpotifyLink = useCallback(async (t) => {
    if (!t) return;
    const directId = String(t.spotifyId || '').match(/(?:spotify:track:|open\.spotify\.com\/track\/)?([A-Za-z0-9]{22})(?:[/?].*)?$/)?.[1] || null;
    const directUrl = /^https:\/\/open\.spotify\.com\/track\//i.test(String(t.spotifyUrl || ''))
      ? String(t.spotifyUrl)
      : (directId ? `https://open.spotify.com/track/${directId}` : null);
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    setSharing(t.id);
    try {
      let spotifyUrl = directUrl;
      if (!spotifyUrl) {
        if (!api?.spotifySearch) {
          pushToast?.({ message: 'Spotify isn\'t connected.', kind: 'error' });
          return;
        }
        const result = await api.spotifySearch(`${t.title || ''} ${t.artist || ''}`.trim());
        const rows = Array.isArray(result) ? result : (Array.isArray(result?.tracks) ? result.tracks : (Array.isArray(result?.results) ? result.results : []));
        const norm = (v) => String(v || '').toLowerCase().replace(/\s*\(.*?\)\s*/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
        const wantT = norm(t.title);
        const wantA = norm(t.artist).split(' ')[0];
        const hit = rows.find((r) => {
          const rt = norm(r.title);
          const ra = norm(r.artists || r.artist);
          return r.spotifyUrl && (rt === wantT || rt.startsWith(wantT) || wantT.startsWith(rt))
            && (!wantA || ra.includes(wantA));
        });
        if (!hit) {
          pushToast?.({ message: `Couldn't find "${t.title}" on Spotify.`, kind: 'error', durationMs: 5000 });
          return;
        }
        spotifyUrl = hit.spotifyUrl;
      }
      if (!await writeClipboardText(spotifyUrl)) {
        throw new Error('Clipboard access was unavailable.');
      }
      pushToast?.({ message: 'Spotify link copied', kind: 'success' });
    } catch (e) {
      console.error('[copySpotifyLink]', e);
      pushToast?.({ message: 'Could not copy the link. Please try again.', kind: 'error' });
    } finally {
      setSharing(null);
    }
  }, [pushToast, writeClipboardText]);
  const { dlProgress } = useDownloadProgress();
  const [dlState, setDlState] = useState({}); // key → 'busy' | 'done' | 'failed'
  const markDl = useCallback((key, state) => setDlState((m) => ({ ...m, [key]: state })), []);
  /** Surface the real reason a download failed. */
  const toastError = useCallback((msg, fallback) => {
    pushToast?.({ message: String(msg || fallback || 'Download failed.'), kind: 'error', durationMs: 7000 });
  }, [pushToast]);

  // Manual YouTube video picker — opened when an automatic import fails so the
  // user can choose the right video themselves. `pick` carries the import meta
  // plus any candidates the failed import already surfaced (no-tier-match).
  const [pick, setPick] = useState(null); // { meta, seed, dlKey } | null
  const openPicker = useCallback((meta, res, dlKey) => {
    // A failed Save (not signed in, no Spotify match) has no video to pick.
    if (res?.noPicker) { toastError(res.error, `Couldn't save "${meta?.title || 'this track'}".`); return; }
    const seed = res && Array.isArray(res.candidates) ? res.candidates : null;
    setPick({ meta, seed, dlKey });
  }, [toastError]);

  /* Ownership is keyed by songKey, not by raw strings.
     Raw equality meant a library cleaned the way most people clean one —
     "(feat. X)" moved into the artist field, "- Bonus Track" deleted — stopped
     matching the catalogue rows it came from, and the app offered to download
     songs already sitting on disk. songKey folds those labels away while
     KEEPING version qualifiers distinct, so a studio take never hides the Get
     on a live one. See instantSearch.js for why that asymmetry is deliberate. */
  const owned = useMemo(() => {
    const set = new Set();
    for (const t of library) set.add(songKey(t.title, t.artist));
    return set;
  }, [library]);
  const alreadyOwned = useCallback((title, artists) => owned.has(songKey(title, artists)), [owned]);
  /* Same key, but returns the track — for surfaces that need to PLAY the copy
     you own rather than just know it exists (the artist page's Popular list). */
  const ownedByKey = useMemo(() => {
    const m = new Map();
    for (const t of library) { const k = songKey(t.title, t.artist); if (!m.has(k)) m.set(k, t); }
    return m;
  }, [library]);
  const ownedTrackFor = useCallback((title, artists) => ownedByKey.get(songKey(title, artists)) || null, [ownedByKey]);

  /* Resolve a track to the artwork the app should SHOW for it.
   *
   * The key here has to be albumKeyOf — the exact key the pins are written
   * under. It used to build its own from the FULL artist string, which is a
   * different key the moment a track carries more than one credit: a download
   * tagged "Drake" hit the pin, the same record's local file tagged
   * "Drake, 21 Savage" (music-metadata joins artist arrays with ", ") missed
   * it and fell through to its own coverArt. Two URLs for one record is what
   * made the cover visibly re-load when playback crossed between them. */
  const coverFor = useCallback((t) => {
    if (!t) return null;
    return albumCoverOverrides[albumKeyOf(t)] || t.coverArt || null;
  }, [albumCoverOverrides]);

  /* The palette is the search surface. The Find page it used to hand off
     to is gone, and with it source / query / results / findAlbums / ssAlbums
     / busy / error / ranQuery / findSel and the runFind protocol that fed
     them — every one of those existed only to render that page. */
  const [paletteOpen, setPaletteOpen] = useState(false);
  /* Seeds the palette's query when something else starts a search on your
     behalf. Replaces jumpToFind, which did the same job by navigating away
     from whatever you were looking at. */
  const [paletteSeed, setPaletteSeed] = useState('');
  const openPalette = useCallback((q = '') => { setPaletteSeed(q); setPaletteOpen(true); }, []);
  /* Results aren't a section any more, so nothing overrides the tab. */
  const sec = section;

  const inputRef = useRef(null);
  /* Deliberately NOT auto-focusing the search field. Focusing on entry would
     put a cursor in the search box on every launch and make stray keystrokes
     start a search. Press / (or click it) to focus instead.

     No section gate: this used to bail unless section === 'discover', a value
     nothing sets any more since Discover folded into Home — so the shortcut
     had quietly stopped working everywhere. The search box lives in the top
     bar and is reachable from every section, so its shortcut should be too. */
  /* Both shortcuts open the palette rather than focusing the top bar — the
     bar is a door now, and the palette owns typing, so there is never a
     moment where two inputs are competing for the same keystrokes. */
  useEffect(() => {
    const onKey = (e) => {
      const el = e.target;
      const tag = el && el.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable;
      /* Cmd/Ctrl-K works even from a text field — it's the universal "open
         the thing" chord and people press it mid-sentence. */
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (typing) return;
      e.preventDefault();
      setPaletteOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* Compact mode: Ctrl/Cmd+Shift+C toggles it, from anywhere including a text
     field — same reasoning as Ctrl-K. The toast only fires on the way in, and
     says how to get the hidden chrome back, since nothing on screen does. */
  const compactRef = useRef(compactMode);
  useEffect(() => { compactRef.current = compactMode; }, [compactMode]);
  const toggleCompactMode = useCallback(() => {
    const n = !compactRef.current;
    pickCompactMode(n);
    if (n) pushToast?.({ message: 'Compact mode on. Touch the top or left edge for navigation. Ctrl+Shift+C to exit.', durationMs: 5000 });
  }, [pickCompactMode, pushToast]);
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
      if (e.key !== 'c' && e.key !== 'C') return;
      e.preventDefault();
      toggleCompactMode();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleCompactMode]);

  /* Fullscreen keys. Ctrl/Cmd+Shift+F toggles. Inside the view, Esc leaves
     and L / Q / I switch the panel — but only when nothing else owns the
     key: a menu, a dialog, a lyric selection or the lyric card each handle
     their own Esc, and closing the whole view underneath them would be the
     wrong thing to undo. `blockers` is read through a ref so the listener
     isn't re-bound on every state change. */
  /* Track previews (previewPlayer.jsx) and the main player share the
     speakers: a preview pauses what's playing and resumes it when it ends;
     starting real playback ends the preview. `resumeAfterPreview` is only set
     when the preview itself did the pausing, so a song you'd paused stays
     paused. */
  const playingRef = useRef(isPlaying);
  const toggleRef = useRef(onTogglePlay);
  const resumeAfterPreview = useRef(false);
  const previewPausing = useRef(false);
  useEffect(() => { playingRef.current = isPlaying; toggleRef.current = onTogglePlay; });
  useEffect(() => {
    setPreviewHooks({
      onStart: () => {
        if (playingRef.current && toggleRef.current) {
          resumeAfterPreview.current = true;
          previewPausing.current = true;
          toggleRef.current();
        }
      },
      onEnd: () => {
        if (resumeAfterPreview.current && !playingRef.current && toggleRef.current) toggleRef.current();
        resumeAfterPreview.current = false;
      },
    });
  }, []);
  useEffect(() => {
    if (isPlaying && isPreviewing() && !previewPausing.current) {
      resumeAfterPreview.current = false; // you chose to play something; don't toggle it back off
      stopPreview();
    }
    if (!isPlaying) previewPausing.current = false;
  }, [isPlaying, currentTrack?.id]);

  const npFullBlockers = useRef(false);
  // Nothing loaded, nothing to show: the view closes itself rather than
  // leaving an empty stage over the app.
  useEffect(() => { if (!currentTrack) setNpFull(false); }, [currentTrack]);
  const npFullRef = useRef(npFull);
  useEffect(() => { npFullRef.current = npFull; }, [npFull]);
  useEffect(() => {
    const onKey = (e) => {
      const el = e.target;
      const tag = el && el.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        setNpFull((v) => !v);
        return;
      }
      if (!npFullRef.current || npFullBlockers.current || e.defaultPrevented) return;
      if (e.key === 'Escape') { e.preventDefault(); setNpFull(false); return; }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const t = k === 'l' ? 'lyrics' : k === 'q' ? 'queue' : k === 'i' ? 'info' : null;
      if (t) { e.preventDefault(); pickNpFullTab(t); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickNpFullTab]);

  /* Edge peek. Only the window's outermost 8px opens anything, so ordinary
     movement over the card never does. Once open, the top bar stays until
     the pointer is clearly below it, the sidebar until it's clearly right of
     it. Ignored while a button is held so scrubbing or dragging a row across
     an edge doesn't throw chrome over the thing being dragged. The pointer
     over the revealed top bar is inside a drag region and generates no
     mousemove at all — which is exactly the state that should hold it open. */
  useEffect(() => {
    if (!compactMode || npFull) { setChromePeek(null); return undefined; }
    const EDGE = 8;
    const onMove = (e) => {
      if (e.buttons) return;
      const x = e.clientX; const y = e.clientY;
      /* Anything that drops down from the top bar (notifications) hangs
         below it; the bar stays out while the pointer is over one. */
      const overDropdown = !!e.target?.closest?.('[data-topbar-dropdown]');
      setChromePeek((p) => {
        if (p === 'top') return y > TOPBAR_H + 16 && !overDropdown ? null : p;
        if (p === 'side') return x > SIDEBAR_W + 28 ? null : p;
        if (y <= EDGE) return 'top';
        if (x <= EDGE) return 'side';
        return p;
      });
    };
    const onKey = (e) => { if (e.key === 'Escape') setChromePeek(null); };
    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('keydown', onKey);
    };
  }, [compactMode, npFull]);



  /* The search control in the top bar. A door, nothing more.
     It used to close over a dozen pieces of find state — query, busy,
     results, the album lists — so it could show what you'd last searched and
     offer to clear it. With the Find page gone there is no lingering search
     to describe, so the pill holds no value and needs no clear button. */
  const topbarSearch = (
    <div className="sth-searchbar" onMouseDown={(e) => { e.preventDefault(); openPalette(); }}>
      <svg aria-hidden className="sth-searchbar-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round">
        <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
      </svg>
      <input
        ref={inputRef}
        className="sth-searchbar-input"
        placeholder="Search for a song, album or artist"
        value=""
        readOnly
        /* Anything that focuses this — the / shortcut, a tab, a stray click
           the mousedown handler didn't catch — opens the palette instead of
           parking a cursor in a field that can no longer be typed into. */
        onFocus={() => openPalette()}
        spellCheck={false}
        aria-label="Search"
      />
      <div className="sth-searchbar-end">
        <span className="sth-kbd sth-searchbar-slash">/</span>
      </div>
    </div>
  );

  const downloadSpotifyRow = useCallback(async (row, opts = {}) => {
    if (!api()?.importFromYoutubeSearch) return null;
    const key = `s:${row.spotifyId}`;
    const meta = {
      title: row.title, artists: row.artists, album: row.album || '',
      albumArtUrl: row.albumArtUrl || '', durationMs: row.durationMs ?? 0,
      spotifyId: row.spotifyId, trackNumber: row.trackNumber ?? null,
      discNumber: row.discNumber ?? null, explicit: row.explicit,
    };
    markDl(key, 'busy');
    try {
      const res = await api().importFromYoutubeSearch({ ...meta, progressId: key });
      if (res?.ok && res.track) { onTrackImported?.(res.track); markDl(key, 'done'); return res.track; }
      markDl(key, 'failed');
      // In a "download all" batch the picker stays closed — the row goes
      // retryable and retrying it individually opens the picker.
      if (opts.noPicker) toastError(res?.error, `Couldn't download "${row.title}".`);
      else openPicker(meta, res, key);
    } catch (e) { markDl(key, 'failed'); toastError(e?.message || e, `Couldn't download "${row.title}".`); }
    return null;
  }, [onTrackImported, markDl, toastError, openPicker]);

  const downloadSoulseekRow = useCallback(async (row) => {
    if (!api()?.soulseekDownload) return null;
    const key = `t:${row.id}`;
    markDl(key, 'busy');
    try {
      const res = await api().soulseekDownload({
        id: row.id, user: row.user, filePath: row.filePath,
        size: row.size, bitrate: row.bitrate, filename: row.filename,
      });
      if (res?.ok && res.track) { onTrackImported?.(res.track); markDl(key, 'done'); return res.track; }
      markDl(key, 'failed');
      toastError(res?.error, `Couldn't download "${row.filename}".`);
    } catch (e) { markDl(key, 'failed'); toastError(e?.message || e, `Couldn't download "${row.filename}".`); }
    return null;
  }, [onTrackImported, markDl, toastError]);

  const downloadSsAlbum = useCallback(async (alb) => {
    if (!api()?.soulseekDownloadAlbum) return;
    const key = `ssa:${alb.id}`;
    if (dlState[key] === 'busy') return;
    markDl(key, 'busy');
    try {
      const res = await api().soulseekDownloadAlbum({ albumId: alb.id, tracks: alb.tracks });
      const got = Array.isArray(res?.tracks) ? res.tracks : [];
      for (const t of got) onTrackImported?.(t);
      if (got.length) {
        markDl(key, 'done');
        if (res?.partial) pushToast?.({ message: res.error || `Some tracks on "${alb.displayName || 'this album'}" couldn't be downloaded.`, kind: 'warning', durationMs: 7000 });
      } else {
        markDl(key, 'failed');
        toastError(res?.error, `Couldn't download "${alb.displayName || 'this album'}".`);
      }
    } catch (e) { markDl(key, 'failed'); toastError(e?.message || e, `Couldn't download "${alb.displayName || 'this album'}".`); }
  }, [dlState, markDl, onTrackImported, pushToast, toastError]);

  /* downloadAlbumMissing and ensureAlbumTracks went with the Find page's
     album panel — their state (albumTracks / albumBusy) went with the find
     block above. InstantSearch's album frame does the same job against its
     own tracklist, so there is no second copy left to keep in step. */

  /* ---------- Discover: charts + release expansion + follow manager -------- */
  const [charts, setCharts] = useState(null);      // { songs, albums } | null
  const [chartsError, setChartsError] = useState('');
  const chartsRequestedRef = useRef(false);
  useEffect(() => {
    if (section !== 'discover' || chartsRequestedRef.current) return;
    chartsRequestedRef.current = true;
    const a = api();
    if (!a?.fetchCharts) { setChartsError('Charts unavailable in this build.'); return; }
    a.fetchCharts().then((res) => {
      if (res?.ok) setCharts({ songs: res.songs || [], albums: res.albums || [] });
      else setChartsError(res?.error || 'Could not load charts.');
    }).catch((e) => setChartsError(String(e?.message || e)));
  }, [section]);

  /** Chart song → iTunes lookup for full meta → yt-dlp import. */
  const downloadChartSong = useCallback(async (song) => {
    const a = api();
    if (!a?.lookupChartSong || !a?.importFromYoutubeSearch) return;
    const key = `c:${song.id}`;
    if (dlState[key] === 'busy' || dlState[key] === 'done') return;
    markDl(key, 'busy');
    try {
      const lk = await a.lookupChartSong(song.id);
      const tk = lk?.ok ? lk.track : null;
      const meta = {
        title: tk?.trackName || song.name,
        artists: tk?.artistName || song.artistName,
        album: tk?.collectionName || '',
        albumArtUrl: tk?.artworkUrl || song.artworkUrl || '',
        durationMs: tk?.trackTimeMillis || 0,
        spotifyId: `itunes:${tk?.trackId || song.id}`,
        trackNumber: tk?.trackNumber || null,
        discNumber: null,
        explicit: !!tk?.explicit,
      };
      const res = await a.importFromYoutubeSearch({ ...meta, progressId: key });
      if (res?.ok && res.track) { onTrackImported?.(res.track); markDl(key, 'done'); return; }
      markDl(key, 'failed');
      openPicker(meta, res, key);
    } catch (e) { markDl(key, 'failed'); toastError(e?.message || e, `Couldn't download "${song.name}".`); }
  }, [dlState, markDl, onTrackImported, toastError, openPicker]);

  /* ---------- Library views ------------------------------------------------ */
  const [libView, setLibView] = useState(() => {
    try {
      const v = localStorage.getItem('studio:libView');
      // 'recent' and 'pl:<id>' joined the list; anything unknown falls back
      // rather than leaving the rail with nothing selected.
      if (v && ['songs', 'albums', 'artists', 'recent'].includes(v)) return v;
      return 'songs';
    } catch { return 'songs'; }
  });
  /* Reset the virtualiser to the top when the view changes, or you land
     mid-list in a different one. Placed AFTER libView's declaration — as part
     of the windowing block above it referenced libView ~500 lines before the
     useState, which is a temporal dead zone crash on mount. The same applies
     to libFilter and libRowSort below, which is why this effect lives here
     rather than beside the ref it touches.

     Resets the ELEMENT as well as the state. State alone left the node
     scrolled; the node alone relies on onScroll, which never fires when
     scrollTop is already 0. Either one on its own leaves the two disagreeing,
     and a virtualiser that disagrees with its scroll container renders a slice
     nobody can see. */
  useEffect(() => { setLibScrollTop(0); }, [libView]);

  const pickLibView = useCallback((v) => {
    setLibView(v);
    try { localStorage.setItem('studio:libView', v); } catch { /* ignore */ }
  }, []);
  const [libSort, setLibSort] = useState(() => {
    try { const v = localStorage.getItem('studio:libSort'); return ['recent', 'title', 'artist'].includes(v) ? v : 'recent'; } catch { return 'recent'; }
  });
  const [libFilter, setLibFilter] = useState('');
  /* A search belongs to the view it was typed in.
   *
   * The filter box is one piece of state shared by Songs, Albums and Artists,
   * so typing "heaven" in Songs and then clicking Albums silently filtered the
   * albums too — and the box sits far enough from the grid that the empty
   * result reads as a missing library rather than an active search. Switching
   * views clears it, the same way changing views already resets scroll. */
  useEffect(() => { setLibFilter(''); }, [libView]);

  const pickLibSort = useCallback((v) => {
    setLibSort(v);
    try { localStorage.setItem('studio:libSort', v); } catch { /* ignore */ }
  }, []);

  /* Sort order for the songs table.
   *
   * Null means "follow the view" — Songs sorts by title, Albums by album,
   * Artists by artist, Recent by date added — which is the behaviour that was
   * implicit before and the only sensible default when you've just switched
   * views. Picking an order explicitly overrides it until you pick another.
   *
   * Separate from libSort, which orders a different list (the search results
   * pane) and only knows three of these values. Reusing it would have tied
   * two unrelated lists to one control. */
  const [libRowSort, setLibRowSort] = useState(() => {
    try {
      const v = localStorage.getItem('studio:libRowSort');
      return ['title', 'artist', 'album', 'recent'].includes(v) ? v : null;
    } catch { return null; }
  });
  const pickLibRowSort = useCallback((v) => {
    setLibRowSort(v);
    try {
      if (v) localStorage.setItem('studio:libRowSort', v);
      else localStorage.removeItem('studio:libRowSort');
    } catch { /* ignore */ }
  }, []);

  /* Keep the virtualiser and its scroll container in agreement.
   *
   * Filtering, re-sorting or switching views can leave the viewport scrolled
   * past the end of a now-shorter list, which renders a slice positioned below
   * the fold behind a first * LIB_ROW_H spacer — the list looks empty until
   * some scroll fires onScroll and resyncs the two.
   *
   * Resets the ELEMENT as well as the state. State alone leaves the node
   * scrolled; the node alone relies on onScroll, which never fires when
   * scrollTop is already 0.
   *
   * Lives here, well below its own dependencies, for the same reason the
   * libView reset does: dependency arrays are evaluated during render, so
   * naming libFilter or libRowSort before their useState is a temporal dead
   * zone crash on mount. */
  useEffect(() => {
    setLibScrollTop(0);
    if (libScrollElRef.current) libScrollElRef.current.scrollTop = 0;
  }, [libView, libFilter, libRowSort]);
  // Detail-pane selections — one per two-pane view. The right pane shows the
  // selected album (Albums), track's album context (Songs), or artist (Artists).
  const [openLibAlbumKey, setOpenLibAlbumKey] = useState(null);
  const [openLibArtistKey, setOpenLibArtistKey] = useState(null);
  const [albumRemoveArmed, setAlbumRemoveArmed] = useState(false);
  useEffect(() => { setAlbumRemoveArmed(false); }, [openLibAlbumKey]);

  // Now Playing panel options, persisted so they survive restarts.
  const [npAnimatedBg, setNpAnimatedBg] = useState(() => {
    try { return localStorage.getItem('studio:npAnimatedBg') === '1'; } catch { return false; }
  });
  const [npShowLyrics, setNpShowLyrics] = useState(() => {
    try { return localStorage.getItem('studio:npShowLyrics') === '1'; } catch { return false; }
  });
  const [npShowCredits, setNpShowCredits] = useState(() => {
    try { return localStorage.getItem('studio:npShowCredits') === '1'; } catch { return false; }
  });
  // Expanded library: the fullscreen button on the Now Playing panel no
  // longer opens the stage overlay — it grows the library grid to fill the
  // content area, hiding the page header (title + totals). The nav rail and
  // the Now Playing pane stay.
  /* Retired: the new fullscreen view (`npFull`) replaces this. Always starts
     false and nothing sets it, so the old portal and the gates keyed on it
     are inert. The stale localStorage value is ignored rather than read,
     since a leftover '1' used to hide the Now Playing bar on every launch. */
  const [libExpanded, setLibExpanded] = useState(false);
  // Floating Now Playing bar: collapses the panel to a slim bar pinned at the
  // bottom (Spotify-mobile style), giving the library list the full width.
  const [npBar, setNpBar] = useState(() => {
    try { return localStorage.getItem('studio:npBar') === '1'; } catch { return false; }
  });
  const toggleLibExpanded = useCallback(() => {
    setLibExpanded((v) => { const n = !v; try { localStorage.setItem('studio:libExpanded', n ? '1' : '0'); } catch { /* ignore */ } if (n) { setNpBar(false); try { localStorage.setItem('studio:npBar', '0'); } catch { /* ignore */ } } return n; });
  }, []);


  // Leaving fullscreen with the card up would strand it open on return.
  // Declared here rather than beside the rest of the command-center state
  // because libExpanded isn't in scope yet up there (temporal dead zone).
  useEffect(() => {
    if (!libExpanded) { setCcOpen(false); setCcExiting(false); }
  }, [libExpanded]);

  /* Keyboard: Enter OPENS the command center, Esc closes it.
   *
   * Enter is open-only and deliberately not a toggle — the card's own search
   * field is focused the moment it opens, so a toggling Enter would close it
   * again the first time you pressed Enter while typing. Esc is the single
   * close gesture.
   *
   * Both are captured (third arg true) so they resolve before the overlay's
   * own Esc-closes-fullscreen handler further down the tree. */
  useEffect(() => {
    if (!libExpanded) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (!ccOpen) return;              // let Esc fall through to close fullscreen
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleCc();
        return;
      }
      if (e.key !== 'Enter') return;
      if (ccOpen) return;                  // already open — Enter does nothing
      // Never hijack Enter out of a field the user is typing in.
      const el = e.target;
      const tag = el && el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
        || (el && el.isContentEditable)) return;
      // Enter on a focused button/link should activate it, not open the card.
      if (tag === 'BUTTON' || tag === 'A') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      toggleCc();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [libExpanded, ccOpen, toggleCc]);

  const toggleNpBar = useCallback(() => {
    setNpBar((v) => { const n = !v; try { localStorage.setItem('studio:npBar', n ? '1' : '0'); } catch { /* ignore */ } if (n) { setLibExpanded(false); try { localStorage.setItem('studio:libExpanded', '0'); } catch { /* ignore */ } } return n; });
  }, []);

  const toggleNpAnimatedBg = useCallback(() => {
    setNpAnimatedBg((v) => { const n = !v; try { localStorage.setItem('studio:npAnimatedBg', n ? '1' : '0'); } catch { /* ignore */ } return n; });
  }, []);
  const toggleNpShowLyrics = useCallback(() => {
    setNpShowLyrics((v) => { const n = !v; try { localStorage.setItem('studio:npShowLyrics', n ? '1' : '0'); } catch { /* ignore */ } if (n) setNpShowCredits(false); return n; });
  }, []);
  const toggleNpShowCredits = useCallback(() => {
    setNpShowCredits((v) => { const n = !v; try { localStorage.setItem('studio:npShowCredits', n ? '1' : '0'); } catch { /* ignore */ } if (n) setNpShowLyrics(false); return n; });
  }, []);

  /* ---------- Songs list virtualisation -----------------------------------
   * The library can hold thousands of tracks; rendering them all is what made
   * this list stutter while the command center's stayed smooth. Same fix as
   * the command center: fixed-height rows, absolute-positioned visible slice,
   * so DOM weight stays constant no matter the library size.
   *
   * Attached via a CALLBACK REF rather than an effect — the list unmounts
   * whenever you switch tabs, and Chromium fires a 0x0 ResizeObserver
   * notification on the way out. Zero readings are ignored (a zero viewport
   * collapses the slice to ~4 rows, i.e. "the list cuts off"), and a freshly
   * mounted node always starts at scrollTop 0.
   */
  const SONG_ROW_H = 56;
  const [songScrollTop, setSongScrollTop] = useState(0);
  const [songViewH, setSongViewH] = useState(420);
  const songRoRef = useRef(null);
  const songListRef = useRef(null);
  const attachSongList = useCallback((el) => {
    songListRef.current = el;
    if (songRoRef.current) { songRoRef.current.disconnect(); songRoRef.current = null; }
    if (!el) return;
    const measure = () => { const h = el.clientHeight; if (h > 0) setSongViewH(h); };
    measure();
    setSongScrollTop(0);
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      songRoRef.current = ro;
    }
  }, []);
  useEffect(() => () => { if (songRoRef.current) songRoRef.current.disconnect(); }, []);

  // A narrowed filter can leave the viewport scrolled past the end of the new
  // result set, which would render an empty slice. Jump back to the top.
  useEffect(() => {
    setSongScrollTop(0);
    if (songListRef.current) songListRef.current.scrollTop = 0;
  }, [libFilter, libSort, libView, libRowSort]);

  const sortedSongs = useMemo(() => {
    const list = [...library];
    if (libSort === 'title') list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    else if (libSort === 'artist') list.sort((a, b) => (a.artist || '').localeCompare(b.artist || '') || (a.album || '').localeCompare(b.album || '') || (a.trackNumber || 0) - (b.trackNumber || 0));
    else list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return list;
  }, [library, libSort]);

  /** Group the library into albums, keyed by album name + PRIMARY artist.
   * The primary artist is the first name before any comma / feat / ft / & / x
   * separator — mirroring App.jsx's album grouping — so a collab track like
   * "Drake, Sexyy Redd" lands in the same album as the rest of Drake's tracks
   * instead of spawning its own tile. Tracks with no album gather under
   * "Singles". */
  const albums = useMemo(() => {
    const primaryOf = (str) => {
      if (!str) return '';
      const clean = String(str).split(/,|feat\.|ft\.|&|\bx\b/i)[0].trim();
      return clean || String(str).trim();
    };
    const map = new Map();
    for (const t of library) {
      const albName = (t.album || '').trim();
      const primary = primaryOf(t.artist);
      const key = albName ? `${albName.toLowerCase()}::${primary.toLowerCase()}` : '::singles';
      let g = map.get(key);
      if (!g) {
        g = { key, name: albName || 'Singles', artist: albName ? primary : 'Loose tracks', tracks: [], newest: 0, isSingles: !albName };
        map.set(key, g);
      }
      g.tracks.push(t);
      g.newest = Math.max(g.newest, t.addedAt || 0);
    }
    for (const g of map.values()) {
      g.tracks.sort((a, b) => (a.discNumber || 1) - (b.discNumber || 1) || (a.trackNumber || 0) - (b.trackNumber || 0) || (a.title || '').localeCompare(b.title || ''));
      g.art = albumCoverOverrides[g.key] || g.tracks.find((t) => t.coverArt)?.coverArt || null;
      g.year = g.tracks.find((t) => t.year)?.year || null;
      g.totalSec = g.tracks.reduce((s, t) => s + (Number.isFinite(t.duration) ? t.duration : 0), 0);
    }
    return [...map.values()].sort((a, b) => b.newest - a.newest);
  }, [library, albumCoverOverrides]);

  const openLibAlbum = openLibAlbumKey ? albums.find((g) => g.key === openLibAlbumKey) || null : null;

  /** Group the library into artists, keyed by primary artist name. Each entry
   * carries the artist's albums (reusing the album grouping) and a flat track
   * list, so the Artists detail pane can show either. Mirrors the album
   * primary-artist rule so collabs fold into the lead artist. */
  const artists = useMemo(() => {
    const primaryOf = (str) => {
      if (!str) return '';
      const clean = String(str).split(/,|feat\.|ft\.|&|\bx\b/i)[0].trim();
      return clean || String(str).trim();
    };
    const map = new Map();
    for (const g of albums) {
      if (g.isSingles) {
        // Singles get bucketed under each track's own primary artist rather
        // than a shared "Loose tracks" pseudo-artist.
        for (const t of g.tracks) {
          const primary = primaryOf(t.artist) || 'Unknown';
          const key = primary.toLowerCase();
          let a = map.get(key);
          if (!a) { a = { key, name: primary, albums: [], tracks: [], newest: 0, art: null }; map.set(key, a); }
          a.tracks.push(t);
          a.newest = Math.max(a.newest, t.addedAt || 0);
        }
        continue;
      }
      const primary = g.artist || 'Unknown';
      const key = primary.toLowerCase();
      let a = map.get(key);
      if (!a) { a = { key, name: primary, albums: [], tracks: [], newest: 0, art: null }; map.set(key, a); }
      a.albums.push(g);
      a.tracks.push(...g.tracks);
      a.newest = Math.max(a.newest, g.newest || 0);
    }
    for (const a of map.values()) {
      a.albums.sort((x, y) => (y.year || 0) - (x.year || 0) || y.newest - x.newest);
      a.tracks.sort((x, y) => (x.artist || '').localeCompare(y.artist || '') || (x.album || '').localeCompare(y.album || '') || (x.trackNumber || 0) - (y.trackNumber || 0));
      // Prefer the newest album's art as the artist's face.
      a.art = a.albums.find((g) => g.art)?.art || a.tracks.find((t) => t.coverArt)?.coverArt || null;
      a.albumCount = a.albums.length;
      a.totalSec = a.tracks.reduce((s, t) => s + (Number.isFinite(t.duration) ? t.duration : 0), 0);
    }
    return [...map.values()].sort((x, y) => (x.name || '').localeCompare(y.name || '', undefined, { sensitivity: 'base' }));
  }, [albums]);

  const openLibArtist = openLibArtistKey ? artists.find((a) => a.key === openLibArtistKey) || null : null;

  // Local quick-filter over the library — matches title, artist, or album.
  const filteredSongs = useMemo(() => {
    const q = libFilter.trim().toLowerCase();
    if (!q) return sortedSongs;
    return sortedSongs.filter((t) => (
      (t.title || '').toLowerCase().includes(q)
      || (t.artist || '').toLowerCase().includes(q)
      || (t.album || '').toLowerCase().includes(q)
    ));
  }, [sortedSongs, libFilter]);
  const filteredAlbums = useMemo(() => {
    const q = libFilter.trim().toLowerCase();
    // The albums grid reads alphabetically (Singles group sinks to the end).
    const alpha = [...albums].sort((a, b) => (a.isSingles ? 1 : 0) - (b.isSingles ? 1 : 0) || (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
    if (!q) return alpha;
    return alpha.filter((g) => (
      (g.name || '').toLowerCase().includes(q) || (g.artist || '').toLowerCase().includes(q)
    ));
  }, [albums, libFilter]);
  const filteredArtists = useMemo(() => {
    const q = libFilter.trim().toLowerCase();
    if (!q) return artists;
    return artists.filter((a) => (a.name || '').toLowerCase().includes(q));
  }, [artists, libFilter]);

  // A–Z rail index — first row per initial letter. Only meaningful when the
  // list is actually alphabetical, so it's null for "recently added" (jumping
  // to "M" in a date-ordered list would land somewhere arbitrary). Filtering
  // does NOT disable it: a filtered title-sorted list is still alphabetical.
  // Keys off whichever field the sort uses; '#' catches digits and symbols.
  const azIndex = useMemo(() => {
    if (libSort !== 'title' && libSort !== 'artist') return null;
    const map = new Map();
    filteredSongs.forEach((t, i) => {
      const src = libSort === 'artist' ? t.artist : t.title;
      const ch = (src || '').trim().charAt(0).toUpperCase();
      const letter = /[A-Z]/.test(ch) ? ch : '#';
      if (!map.has(letter)) map.set(letter, i);
    });
    return map.size > 1 ? map : null;
  }, [filteredSongs, libSort]);

  // Clicking a letter while on a non-alphabetical sort switches to Title sort
  // and then jumps — so the rail always does something. The jump has to wait
  // for azIndex to exist, which is one render later.
  const [pendingAz, setPendingAz] = useState(null);
  useEffect(() => {
    if (!pendingAz || !azIndex) return;
    const idx = azIndex.get(pendingAz);
    if (idx !== undefined && songListRef.current) songListRef.current.scrollTop = idx * SONG_ROW_H;
    setPendingAz(null);
  }, [pendingAz, azIndex]);

  // When the filter narrows past the current selection, drop it (back to Now
  // Playing) rather than forcing a new one — the right pane defaults to the
  // Now Playing panel, and detail only opens when the user clicks an item.
  useEffect(() => {
    if (section !== 'library') return;
    if (libView === 'albums' && openLibAlbumKey && !filteredAlbums.some((g) => g.key === openLibAlbumKey)) setOpenLibAlbumKey(null);
    if (libView === 'artists' && openLibArtistKey && !filteredArtists.some((a) => a.key === openLibArtistKey)) setOpenLibArtistKey(null);
  }, [section, libView, filteredAlbums, filteredArtists, openLibAlbumKey, openLibArtistKey]);

  /* ---------- Discord connection status (settings page) -------------------- */
  const [discordStatus, setDiscordStatus] = useState(null); // { connected, appId, lastError } | null
  useEffect(() => {
    if (section !== 'settings' || !discordPresenceEnabled) { setDiscordStatus(null); return undefined; }
    const a = api();
    if (!a?.discordStatus) { setDiscordStatus({ unavailable: true }); return undefined; }
    let alive = true;
    const poll = () => a.discordStatus().then((st) => { if (alive) setDiscordStatus(st || null); }).catch(() => { if (alive) setDiscordStatus(null); });
    poll();
    const iv = setInterval(poll, 4000);
    return () => { alive = false; clearInterval(iv); };
  }, [section, discordPresenceEnabled]);

  /* ---------- Home dashboard data ------------------------------------------ */

  /* ---------- Draggable resume pill ---------------------------------------- */
  const [pillPos, setPillPos] = useState(() => {
    try { const v = JSON.parse(localStorage.getItem('studio:pillPos') || 'null'); return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? v : null; } catch { return null; }
  });
  const pillRef = useRef(null);

  // The saved position is only valid for the window size it was dragged in.
  // Re-clamp on mount and every resize so the pill can never sit off-screen
  // (drag at maximized → relaunch at 1400×776 previously lost it).
  useEffect(() => {
    const clampPill = () => setPillPos((p) => {
      if (!p) return p;
      const el = pillRef.current;
      const w = el?.offsetWidth || 280;
      const h = el?.offsetHeight || 48;
      const x = Math.min(Math.max(6, p.x), Math.max(6, window.innerWidth - w - 6));
      const y = Math.min(Math.max(6, p.y), Math.max(6, window.innerHeight - h - 6));
      if (x === p.x && y === p.y) return p;
      const next = { x, y };
      try { localStorage.setItem('studio:pillPos', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    clampPill();
    window.addEventListener('resize', clampPill);
    return () => window.removeEventListener('resize', clampPill);
  }, []);
  const pillDragRef = useRef({ moved: false });
  const onPillPointerDown = useCallback((e) => {
    const el = pillRef.current;
    if (!el || e.button !== 0) return;
    const rect = el.getBoundingClientRect();
    const start = { px: e.clientX, py: e.clientY, x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    pillDragRef.current = { moved: false };
    const onMove = (ev) => {
      const dx = ev.clientX - start.px;
      const dy = ev.clientY - start.py;
      if (!pillDragRef.current.moved && Math.hypot(dx, dy) < 5) return; // click, not drag
      pillDragRef.current.moved = true;
      const x = Math.min(Math.max(6, start.x + dx), window.innerWidth - start.w - 6);
      const y = Math.min(Math.max(6, start.y + dy), window.innerHeight - start.h - 6);
      setPillPos({ x, y });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (pillDragRef.current.moved) {
        setPillPos((p) => { try { localStorage.setItem('studio:pillPos', JSON.stringify(p)); } catch { /* ignore */ } return p; });
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);
  // window.prompt is a no-op in Electron, so rename is an inline edit instead.

  /* ---- Now Playing panel data ------------------------------------------
   * Fetched only while the Info tab is actually visible, and cached per
   * artist / track — these are network calls and the panel is persistent, so
   * without the gate they'd fire on every track change whether or not anyone
   * was looking at them. */
  const [artistInfo, setArtistInfo] = useState(null);
  const [panelCredits, setPanelCredits] = useState(null);
  const artistCacheRef = useRef(new Map());
  const creditsCacheRef2 = useRef(new Map());

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!npPanelOpen || npPanelTab !== 'info' || !currentTrack) return undefined;
    const artist = (currentTrack.artist || '').trim();
    const key = artist.toLowerCase();
    let dead = false;

    if (artist && api?.spotifyArtistInfo) {
      if (artistCacheRef.current.has(key)) setArtistInfo(artistCacheRef.current.get(key));
      else {
        setArtistInfo(null);
        api.spotifyArtistInfo(artist).then((r) => {
          if (dead) return;
          artistCacheRef.current.set(key, r || null);
          setArtistInfo(r || null);
        }).catch(() => { if (!dead) setArtistInfo(null); });
      }
    } else setArtistInfo(null);

    const ck = `${artist}::${currentTrack.title || ''}`.toLowerCase();
    if (api?.geniusCredits) {
      if (creditsCacheRef2.current.has(ck)) setPanelCredits(creditsCacheRef2.current.get(ck));
      else {
        setPanelCredits(null);
        api.geniusCredits({ title: currentTrack.title, artist }).then((r) => {
          if (dead) return;
          /* geniusCredits returns an OBJECT ({ writers, producers,
             performances, ... }), not a flat list — flatten it into
             role/name rows for display. */
          const c = r?.ok ? r.credits : null;
          /* Merge EVERY source into one label→names map before rendering.
             Grouping only c.writers wasn't enough: Genius also returns
             custom_performances, and it emits one entry PER PERSON — four
             writers arrive as four separate performances all labelled
             "Written By", so the list still showed four "Written by" rows.
             Labels are matched case-insensitively for the same reason
             ("Written By" vs "Written by" would otherwise split). */
          const byRole = new Map();
          const add = (label, names) => {
            const role = String(label || '').trim();
            if (!role || !names.length) return;
            const k = role.toLowerCase();
            const cur = byRole.get(k) || { role, names: [] };
            for (const n of names) if (n && !cur.names.includes(n)) cur.names.push(n);
            byRole.set(k, cur);
          };
          if (c) {
            add('Written by', c.writers || []);
            add('Produced by', c.producers || []);
            for (const perf of (c.performances || [])) {
              const names = Array.isArray(perf?.artists) ? perf.artists.map((a) => a?.name || a).filter(Boolean) : [];
              add(perf?.label, names);
            }
          }
          const rows = [...byRole.values()].map((v) => ({ role: v.role, name: v.names.join(', ') }));
          const list = rows.length ? rows : null;
          creditsCacheRef2.current.set(ck, list);
          setPanelCredits(list);
        }).catch(() => { if (!dead) setPanelCredits(null); });
      }
    }
    return () => { dead = true; };
  }, [npPanelOpen, npPanelTab, currentTrack?.id, currentTrack?.artist, currentTrack?.title]);

  /* ---- Library rows ----------------------------------------------------
   * One list, sorted per view. Albums and Artists sort so that a record's
   * tracks stay together and in disc order — a flat title sort scatters them,
   * which is what the old card grid existed to avoid. */
  /* ---- Album / playlist detail -----------------------------------------
   * `libDetail` is what you drilled INTO, kept separate from `libView` (the
   * rail selection) so closing the detail returns you to the same list rather
   * than resetting the rail. */
  /* ---- Profile & library artwork ----------------------------------------
   * Both are purely local presentation, so localStorage is the right home —
   * no schema change, and clearing the library shouldn't wipe your name. */
  const [profile, setProfile] = useState(() => {
    try { return JSON.parse(localStorage.getItem('studio:profile') || '{}') || {}; } catch { return {}; }
  });
  const saveProfile = useCallback((next) => {
    setProfile(next);
    try { localStorage.setItem('studio:profile', JSON.stringify(next)); } catch { /* ignore */ }
  }, []);
  const [editProfile, setEditProfile] = useState(null);   // { name, avatar } | null


  /* Sampled theme for the library wash. Same sampler + pageWash() clamp the
     album and playlist pages use, so the library's colour is produced the same
     way theirs is rather than by a second method that only looks similar. */
  const [npWashTheme, setNpWashTheme] = useState(null);
  const npWashSrc = currentTrack ? coverFor(currentTrack) : null;
  useEffect(() => {
    if (!npWashSrc) { setNpWashTheme(null); return undefined; }
    let dead = false;
    sampleCoverTheme(npWashSrc).then((t) => { if (!dead) setNpWashTheme(t || null); }).catch(() => {});
    return () => { dead = true; };
  }, [npWashSrc]);
  /* The bar's colour, from the same sampled artwork and the same extraction
     the page uses. It read `.mid` directly before, which is the flat average —
     so with any extraction other than Average, the bar and the page behind it
     pulled different colours out of the same cover. */
  setColourIntensity(theme.colourIntensity);
  /* Per-cover overrides, loaded once. An override wins over extraction for
     every surface that takes its colour from the artwork — the point is that
     one correction fixes the record everywhere, not just where you made it.

     Keyed by the cover image rather than the album — see nowAlbumKey below. */
  // The removed reading-preference tally, cleared so it doesn't sit in storage.
  useEffect(() => { try { localStorage.removeItem('studio:readingPrefs'); } catch { /* ignore */ } }, []);

  const [coverColours, setCoverColours] = useState({});
  useEffect(() => {
    let dead = false;
    const a = window.electronAPI;
    if (!a?.loadCoverColours) return undefined;
    a.loadCoverColours().then((r) => { if (!dead) setCoverColours(r?.colours || {}); }).catch(() => {});
    return () => { dead = true; };
  }, []);

  /* Keyed by the COVER, not the album name.
     Album name plus artist collides: a deluxe edition, a reissue and the
     original all tag the same album, so setting a colour on one silently set
     it on the others with no way to separate them. The artwork is what the
     colour is derived FROM, so it's the honest identity — two releases with
     different covers get different keys, and two that genuinely share artwork
     share a colour, which is what you'd want. */
  const nowAlbumKey = useMemo(() => {
    const src = currentTrack ? coverFor(currentTrack) : null;
    if (!src) return null;
    /* Content hash where the URL carries one. Two names for one picture — a
       CDN URL and a mirrored studio-cover:// copy — must not key to two
       different colour overrides, or correcting the colour on one leaves the
       other uncorrected and playback across them shifts hue. */
    const m = /^studio-cover:\/\/[^/]*\/([a-f0-9]{16,})\./i.exec(src);
    if (m) return `img:sha:${m[1].toLowerCase()}`;
    // A data: URI is the image itself and far too long for a key, so hash it.
    if (src.startsWith('data:')) {
      let h = 0x811c9dc5;
      for (let i = 0; i < src.length; i += 1) {
        h ^= src.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return `img:${src.length.toString(36)}:${h.toString(36)}`;
    }
    return `img:${src}`;
  }, [currentTrack, coverFor]);
  const coverOverride = nowAlbumKey ? coverColours[nowAlbumKey] : null;

  /* Enlarged cover art. Holds the URL rather than the track so that what the
     lightbox exports is exactly what the bar was showing — resolving coverFor
     a second time later could pick up a pin that changed in between. */
  const [coverZoom, setCoverZoom] = useState(null);
  const openCoverZoom = useCallback((url) => { if (url) setCoverZoom(url); }, []);
  const closeCoverZoom = useCallback(() => setCoverZoom(null), []);

  /* Pin, then reflect it locally so the change is visible immediately rather
     than after the next library load. */
  const pinAlbumCover = useCallback(async (albumKey, url) => {
    if (!albumKey || !url) return;
    await onSetAlbumCover?.(albumKey, url);
  }, [onSetAlbumCover]);

  const [colourTrayOpen, setColourTrayOpen] = useState(false);
  // A tray for one record shouldn't still be open over the next one.
  useEffect(() => { setColourTrayOpen(false); }, [nowAlbumKey]);

  const setCoverColourFor = useCallback((rgb) => {
    if (!nowAlbumKey) return;
    setCoverColours((c) => {
      const next = { ...c };
      if (rgb) next[nowAlbumKey] = rgb; else delete next[nowAlbumKey];
      return next;
    });
    window.electronAPI?.setCoverColour?.(nowAlbumKey, rgb || null);
  }, [nowAlbumKey]);

  /* A chosen colour is used EXACTLY as chosen.
     Everything derived still goes through pageWash, which darkens until faint
     text stays readable — but running a manual pick through it too meant the
     swatch you clicked and the surface you got were different colours, and the
     whole point of the picker is to say "this one". The cost is that a very
     light pick will make secondary text harder to read; that's yours to make. */
  const autoRgb = npWashTheme ? washSourceFor(npWashTheme, theme.coverColour) : null;
  /* barTone() before pageWash(), for the BAR only.
     The sampled colour carries the artwork's own lightness, and Spotify's bar
     doesn't — measured across seven covers theirs sits near 0.24 regardless of
     how dark or bright the sleeve is. barTone pins that and caps saturation;
     pageWash still runs afterwards as the text-contrast and colour-intensity
     guard, it just rarely has anything left to do at this lightness.
     Page washes deliberately do NOT go through this — a full-page field at low
     alpha is a different problem from a small solid bar under white text. */
  /* A chosen colour reaches the bar and the panel EXACTLY as chosen.
     This is a bar-colour picker — the swatches are the tones Studio would use
     for the bar — so the pick has to land there untouched or the swatch is
     lying about what it does. The library page is the surface that adapts to
     it; see npWashRgb. */
  /* No pageWash() on this any more.
     barTone() now guarantees the white label's readability itself, measured
     with APCA, and stops at the point where it's satisfied. pageWash is the
     old contrast guard and it darkens on its own terms — running both meant
     the colour was pulled down twice, which is how every bar ended up at
     roughly the same weight regardless of the sleeve. One guard, applied
     once, at the place that knows what it's guarding. */
  const npBarSolidWash = coverOverride || barTone(autoRgb || accent);

  /* ---- Immerse ------------------------------------------------------------
   * A single mode, not a modifier. When it's on, the bar, the docked panel and
   * the library pages are all the artwork, and every other surface setting
   * stands down — no tints layered on top, no accent mixed in, nothing to
   * reconcile. It was previously just the bar, and it still ran the page and
   * panel settings underneath, which is where the muddy result came from:
   * a cover gradient with a black veil and an accent-derived tint over it.
   *
   * The colours come straight from the sleeve's palette rather than from one
   * sampled value scaled up and down, so the gradient is the record's own
   * colours instead of three shades of a single average. */
  const immerse = npAnimatedBg && !!currentTrack;
  const immersePalette = useMemo(() => {
    const pal = (npWashTheme?.palette || []).filter(Boolean);
    if (coverOverride) {
      const dimTo = (c, k) => c.split(',').map((n) => Math.round(Number(n) * k)).join(', ');
      return { accent: coverOverride, mid: dimTo(coverOverride, 0.72), wash: dimTo(coverOverride, 0.42) };
    }
    if (!pal.length) return null;
    const dim = (c, k) => c.split(',').map((n) => Math.round(Number(n) * k)).join(', ');
    return {
      accent: pal[0],
      mid: pal[1] || dim(pal[0], 0.72),
      wash: pal[2] || dim(pal[1] || pal[0], 0.42),
    };
  }, [npWashTheme, coverOverride]);



  /* Feed the accent from the playing cover. Same sampler as the page tint so
     the two agree; a per-cover colour override wins, as it does everywhere. */
  useEffect(() => {
    if (accentMode === 'white') { setAccentSrc('255, 255, 255'); return; }
    if (accentMode === 'fixed') { setAccentSrc(accentFixed); return; }
    if (!currentTrack) return; // idle: hold the last track's accent
    const src = accentSourceFromTheme(npWashTheme, coverOverride);
    if (!src) return;
    setAccentSrc(src);
    rememberAccentSource(src);
  }, [currentTrack, npWashTheme, coverOverride, accentMode, accentFixed]);

  const [playlistsOpen, setPlaylistsOpen] = useState(true);
  const [libDetail, setLibDetail] = useState(null);   // { kind:'album'|'playlist', key } | null
  const [detailFilter, setDetailFilter] = useState('');
  const [detailSearchOpen, setDetailSearchOpen] = useState(false);
  const [detailMore, setDetailMore] = useState(false);
  /* Play counts per track, for the optional PLAYS column on detail pages. */
  const playCountByTrack = useMemo(() => {
    const m = new Map();
    for (const e of (playEvents || [])) {
      if (!e?.id) continue;
      m.set(e.id, (m.get(e.id) || 0) + 1);
    }
    return m;
  }, [playEvents]);
  const playCountFor = useCallback((id) => playCountByTrack.get(id) || 0, [playCountByTrack]);
  /* Vertical alignment of the header text against the cover. Persisted and
     switchable in Settings so the three options can be compared on real
     records rather than by rebuilding each time. */
  const [detailAlign, setDetailAlign] = useState(() => {
    try {
      const v = localStorage.getItem('studio:detailAlign');
      return ['flex-start', 'center', 'flex-end'].includes(v) ? v : 'center';
    } catch { return 'center'; }
  });
  const pickDetailAlign = useCallback((v) => {
    setDetailAlign(v);
    try { localStorage.setItem('studio:detailAlign', v); } catch { /* ignore */ }
  }, []);
  const [renamePl, setRenamePl] = useState(null);     // { id, name } | null
  const [deletePl, setDeletePl] = useState(null);     // { id, name } | null
  const [albumEditScope, setAlbumEditScope] = useState(null);  // AlbumMetadataEditor scope
  const [plCoverFor, setPlCoverFor] = useState(null); // playlist id whose cover is being set
  const [addSongsTo, setAddSongsTo] = useState(null); // playlist id we're adding tracks to
  const [addSongsQuery, setAddSongsQuery] = useState('');
  /* The playlist picker — the inverse of addSongsTo. That sheet picks SONGS
     for one playlist; this one picks PLAYLISTS for one song.
     { track, initial: [plId], sel: [plId] } — `initial` is which playlists
     already held the song when the sheet opened, so Done can work out the
     difference rather than blindly re-adding everything ticked. */
  const [plPicker, setPlPicker] = useState(null);
  const [plPickerQuery, setPlPickerQuery] = useState('');
  const [plPickerNew, setPlPickerNew] = useState(null); // typed name while creating, or null
  const [plPickerBusy, setPlPickerBusy] = useState(false);
  // Clear the filter when you open a different record — carrying it over makes
  // a full album look half-empty.
  useEffect(() => { setDetailFilter(''); setDetailSearchOpen(false); }, [libDetail?.key]);
  /**
   * Primary artist — the credit before any feature.
   *
   * Tags spell the same record's artist differently per track: "slayr" on one,
   * "slayr, dexelz" on the next. Keying albums on the full string split a
   * single record into several cards, one per distinct credit line. Keying on
   * the first credit keeps them together.
   */
  /* primaryArtistOf and albumKeyOf are now module-level functions declared above
     this component — they take no state and closed over nothing, so being
     useCallbacks bought nothing and cost ordering: anything earlier in the
     component that needed them crashed, because a const is not hoisted. */

  /** Albums as cards: one entry per (album, artist), newest addition first. */
  const libAlbums = useMemo(() => {
    const m = new Map();
    for (const t of library) {
      const name = (t.album || '').trim();
      if (!name) continue;
      const k = albumKeyOf(t);
      const cur = m.get(k) || { key: k, name, artist: '', art: null, tracks: [], addedAt: 0 };
      cur.tracks.push(t);
      if (!cur.art) cur.art = coverFor(t);
      cur.addedAt = Math.max(cur.addedAt, Number(t.addedAt) || 0);
      m.set(k, cur);
    }
    /* Singles are excluded. A one-track "album" is almost always a loose
       download whose tag happens to carry an album name, and they crowd out
       the real records — the track itself is still in Songs and Recently
       Added, so nothing is actually hidden from the library. */
    const out = [...m.values()].filter((a) => a.tracks.length > 1);
    for (const a of out) {
      a.tracks.sort((x, y) => (x.discNumber || 1) - (y.discNumber || 1) || (x.trackNumber || 0) - (y.trackNumber || 0));
      /* Display the SHORTEST full credit on the record, not the split primary.
         Splitting is right for grouping but wrong for a name: it turns
         "Tyler, The Creator" into "Tyler" and "Earth, Wind & Fire" into
         "Earth". The shortest real credit is the album artist without any
         features — and for a band whose name contains a comma, it's the only
         credit there is, so it survives intact. */
      a.artist = a.tracks
        .map((t) => String(t.artist || '').trim())
        .filter(Boolean)
        .sort((x, y) => x.length - y.length)[0] || primaryArtistOf(a.tracks[0]);
    }
    out.sort((a, b) => titleCollator.compare(a.name, b.name));
    return out;
  }, [library, coverFor]);

  /** Artists, as pages rather than a sort order.
   *
   * Built from `libAlbums` and not the older `albums` memo: an album card here
   * has to open the SAME album page the Albums grid opens, and that page
   * resolves its key against libAlbums. Grouping twice with two key schemes is
   * how a card ends up opening nothing.
   *
   * Four buckets per artist, because a catalogue isn't one list:
   *   albums     — records they lead
   *   singles    — everything libAlbums drops (loose tracks, one-off rips)
   *   appearsOn  — records where they're credited but someone else leads
   *   tracks     — the flat list, for play-all and the top-tracks section
   */
  const libArtists = useMemo(() => {
    /* The primary-artist splitter's separators, with the "feat." case fixed.
       Its `\bfeat\.?\b` can't match the trailing dot — a word boundary needs a
       word character on one side, and "." followed by a space has neither — so
       "Lil Peep feat. XXXTENTACION" split into "Lil Peep" and ". XXXTENTACION",
       and the guest silently failed to match any known artist. It never showed
       there because that splitter only ever reads element [0]. A lookahead for
       whitespace does the job, and still won't fire inside "Feature".

       A comma only separates when a space follows it. Tags write a list as
       "A, B" and a name as written — "nothing,nowhere." has a comma and no
       space, and splitting there invented an artist called "nothing". The
       space is the only thing in the string that distinguishes punctuation
       inside a name from punctuation between names. */
    const SEP = /\s*(?:,(?=\s)|;|&|\bwith\b|\bx\b|\b(?:feat|ft|featuring)\.?(?=\s|$))\s*/i;

    /* Names that appear ALONE on at least one track. This is the whole trick
       for reading collaborations.
       "Future, Juice WRLD" and "waera, vax" are the same shape, and no amount
       of staring at either string tells you who the record actually belongs
       to. The library does: "Juice WRLD" is a credit on 57 other tracks by
       itself, so that's whose song it is. */
    const soloNames = new Map(); // lowercased -> display casing
    for (const t of library) {
      const raw = String(t?.artist || '').trim();
      if (!raw || raw.split(SEP).length > 1) continue;
      const k = raw.toLowerCase();
      if (!soloNames.has(k)) soloNames.set(k, raw);
    }

    /* How much of the library each exact credit string accounts for. Used
       below to tell a NAME containing a comma from a collaboration: an
       artist's own name is on everything they've released, a collab line is on
       a song or two. */
    const creditWeight = new Map(); // lowercased credit -> { tracks, albums:Set }
    for (const t of library) {
      const raw = String(t?.artist || '').trim();
      if (!raw) continue;
      const k = raw.toLowerCase();
      const w = creditWeight.get(k) || { tracks: 0, albums: new Set() };
      w.tracks += 1;
      const alb = (t.album || '').trim().toLowerCase();
      if (alb) w.albums.add(alb);
      creditWeight.set(k, w);
    }

    /**
     * Everyone credited on a track, in credit order. The FIRST name returned
     * owns the song.
     *
     * Order of preference, and why:
     *   1. Segments the library knows standing alone. "Future, Juice WRLD"
     *      lands on Juice WRLD even though Future is written first, because
     *      Juice WRLD is the artist you actually collect.
     *   2. Failing that, the first segment. "waera, vax" and "waera, imnot..."
     *      are both just waera — a one-off collaborator should never split a
     *      catalogue into one-song shards.
     *   3. Unless the whole string carries real weight, in which case the comma
     *      is part of a name rather than a separator. "Tyler, The Creator" is
     *      on three albums and forty tracks; no collab line looks like that.
     */
    const creditNames = (credit) => {
      const raw = String(credit || '').trim();
      if (!raw) return [];
      const parts = raw.split(SEP).map((x) => x.trim()).filter(Boolean);
      if (parts.length <= 1) return [raw];

      const known = parts.filter((x) => soloNames.has(x.toLowerCase()));
      if (known.length) return known.map((x) => soloNames.get(x.toLowerCase()));

      const w = creditWeight.get(raw.toLowerCase());
      const looksLikeAName = w && (w.albums.size >= 2 || w.tracks >= 8);
      return looksLikeAName ? [raw] : [parts[0]];
    };

    const map = new Map();
    const entry = (nameRaw) => {
      const k = nameRaw.toLowerCase();
      let a = map.get(k);
      if (!a) {
        a = {
          key: k, name: nameRaw, credits: [], albums: [], singles: [], appearsOn: [],
          tracks: [], seen: new Set(), art: null, newest: 0,
        };
        map.set(k, a);
      }
      return a;
    };
    const addTrack = (a, t, credit, at) => {
      if (a.seen.has(t.id)) return;
      a.seen.add(t.id);
      a.tracks.push(t);
      a.credits.push(String(credit || ''));
      a.newest = Math.max(a.newest, Number(at) || 0);
    };

    // Records first, so an artist's identity comes from what they released.
    const inAlbum = new Set();
    for (const g of libAlbums) {
      /* Whoever leads most of the record owns it — one guest-heavy opener
         shouldn't hand someone else's album away. */
      const tally = new Map();
      for (const t of g.tracks) {
        const lead = creditNames(t.artist)[0];
        if (lead) tally.set(lead, (tally.get(lead) || 0) + 1);
      }
      const owner = [...tally.entries()]
        .sort((x, y) => y[1] - x[1] || x[0].length - y[0].length)[0]?.[0];
      if (!owner) continue;

      const oa = entry(owner);
      oa.albums.push(g);

      const guests = new Map(); // name -> tracks they're on
      for (const t of g.tracks) {
        inAlbum.add(t.id);
        // The owner gets every track, credited on it or not — it's their record.
        addTrack(oa, t, t.artist, g.addedAt);
        for (const n of creditNames(t.artist)) {
          if (n.toLowerCase() === owner.toLowerCase()) continue;
          addTrack(entry(n), t, t.artist, g.addedAt);
          guests.set(n, (guests.get(n) || 0) + 1);
        }
      }
      for (const [n, count] of guests) {
        entry(n).appearsOn.push({ key: g.key, name: g.name, artist: g.artist, art: g.art, count });
      }
    }

    // Anything libAlbums excluded — no album tag, or a one-track "album".
    for (const t of library) {
      if (inAlbum.has(t.id)) continue;
      const names = creditNames(t.artist);
      if (!names.length) continue;
      const [owner, ...guests] = names;

      const oa = entry(owner);
      const albName = (t.album || '').trim();
      /* Keyed by album NAME, not albumKeyOf. The key carries the primary
         artist, so a release credited "Future, Juice WRLD" on one track and
         "Juice WRLD, Future" on the next produced two separate cards with the
         same title. These groups are already scoped to one artist, so the name
         alone identifies the release and the ragged halves merge. */
      const gk = albName ? `single::${albName.toLowerCase()}` : `track::${t.id}`;
      let grp = oa.singles.find((x) => x.key === gk);
      if (!grp) {
        grp = { key: gk, name: albName || t.title || 'Untitled', art: coverFor(t), year: t.year || null, tracks: [] };
        oa.singles.push(grp);
      }
      grp.tracks.push(t);
      addTrack(oa, t, t.artist, t.addedAt);
      /* A guest on a loose track gets the song but no singles entry — it isn't
         their release, and a card for it would say otherwise. */
      for (const n of guests) addTrack(entry(n), t, t.artist, t.addedAt);
    }

    for (const a of map.values()) {
      /* Display name: the credit they lead with MOST OFTEN, ties going to the
         shorter one — counting ONLY credits with nobody else on them.
         A startsWith test isn't enough: "waera, vax" starts with "waera", so
         an artist whose every track is a collaboration got named after one of
         their collaborations, and two such tracks made two differently-named
         tiles. A credit only votes on a name if it IS a name. */
      const tally = new Map();
      for (const c of a.credits) {
        const c2 = String(c || '').trim();
        if (!c2 || c2.split(SEP).length > 1) continue;
        if (!c2.toLowerCase().startsWith(a.key)) continue;
        tally.set(c2, (tally.get(c2) || 0) + 1);
      }
      const lead = [...tally.entries()].sort((x, y) => y[1] - x[1] || x[0].length - y[0].length)[0];
      if (lead) [a.name] = lead;

      a.albums.sort((x, y) => (y.tracks[0]?.year || 0) - (x.tracks[0]?.year || 0) || (y.addedAt || 0) - (x.addedAt || 0));
      for (const g of a.albums) g.year = g.year || g.tracks.find((t) => t.year)?.year || null;
      a.singles.sort((x, y) => (y.year || 0) - (x.year || 0) || titleCollator.compare(x.name, y.name));
      a.appearsOn.sort((x, y) => y.count - x.count || titleCollator.compare(x.name, y.name));
      a.art = a.albums.find((g) => g.art)?.art || a.singles.find((g) => g.art)?.art || null;
      a.albumCount = a.albums.length;
      a.totalSec = a.tracks.reduce((n, t) => n + (Number.isFinite(t.duration) ? t.duration : 0), 0);
      delete a.seen;
    }

    return [...map.values()].sort((x, y) => titleCollator.compare(x.name, y.name));
  }, [libAlbums, library, coverFor]);

  const filteredLibArtists = useMemo(() => {
    const q = libFilter.trim().toLowerCase();
    const list = q ? libArtists.filter((a) => a.name.toLowerCase().includes(q)) : libArtists;
    /* Sorting defaults to most played (brief, Artists). */
    const plays = (a) => (a.tracks || []).reduce((n, t) => n + playCountFor(t.id), 0);
    return [...list].sort((a, b) => plays(b) - plays(a) || titleCollator.compare(a.name, b.name));
  }, [libArtists, libFilter, playCountFor]);

  /* An artist page can now be ANY artist, not only ones in the library. With
     the Spotify account connected the page is built from Spotify, so an
     artist you have nothing from still gets a full page; one you do have
     carries your tracks and records alongside. */
  const openArtist = useMemo(() => {
    if (libDetail?.kind !== 'artist') return null;
    /* By key, or by name for a page opened before they were in the library
       (key `sp:<id>`): saving one of their songs then fills the page in
       place instead of leaving it an empty shell. */
    const byName = libDetail.name ? String(libDetail.name).trim().toLowerCase() : null;
    const hit = libArtists.find((a) => a.key === libDetail.key) || (byName ? libArtists.find((a) => a.key === byName) : null);
    if (hit) return libDetail.spotifyId ? { ...hit, spotifyId: libDetail.spotifyId } : hit;
    if (!libDetail.name) return null;
    return {
      key: libDetail.key, name: libDetail.name, spotifyId: libDetail.spotifyId || null,
      art: libDetail.image || null, tracks: [], albums: [], singles: [], appearsOn: [], totalSec: 0,
    };
  }, [libDetail, libArtists]);

  /* The artist object a page or the search panel's artist view renders from:
     your library's entry when you have them (with the Spotify ID attached if
     known), otherwise an empty shell the Spotify data fills. */
  const artistRefFor = useCallback(({ name, spotifyId = null, image = null } = {}) => {
    const n = String(name || '').trim();
    const key = n.toLowerCase();
    const sid = /^[0-9A-Za-z]{22}$/.test(String(spotifyId || '')) ? spotifyId : null;
    const hit = libArtists.find((a) => a.key === key);
    if (hit) return sid ? { ...hit, spotifyId: sid } : hit;
    return {
      key: `sp:${sid || key}`, name: n, spotifyId: sid, art: image || null,
      tracks: [], albums: [], singles: [], appearsOn: [], totalSec: 0,
    };
  }, [libArtists]);

  const openArtistAnywhere = useCallback(({ name, spotifyId = null, image = null } = {}) => {
    const n = String(name || '').trim();
    if (!n) return;
    const key = n.toLowerCase();
    const sid = /^[0-9A-Za-z]{22}$/.test(String(spotifyId || '')) ? spotifyId : null;
    pickSection('library');
    if (libArtists.some((a) => a.key === key)) setLibDetail({ kind: 'artist', key, spotifyId: sid });
    else setLibDetail({ kind: 'artist', key: `sp:${sid || key}`, name: n, spotifyId: sid, image });
  }, [libArtists, pickSection]);

  /* Jump from a songs-list row to the artist or album it belongs to.
   *
   * Both resolve through the SAME keys the detail views are indexed by —
   * primaryArtistOf for artists, albumKeyOf for albums — rather than the
   * row's raw tag text. A track credited "Drake, 21 Savage" has to land on
   * Drake's page, and its album has to be the one the rest of the record
   * groups under; matching on the full credit string would miss both.
   *
   * Silently does nothing when there's no page to open (a compilation whose
   * artist owns no other tracks). Navigating to an empty page is worse than
   * not navigating: it costs the user their place in the list to show them
   * nothing.
   */
  const openArtistFromRow = useCallback((t) => {
    const key = String(primaryArtistOf(t) || '').toLowerCase();
    if (!key || !libArtists.some((a) => a.key === key)) return;
    setLibDetail({ kind: 'artist', key });
  }, [libArtists]);

  const openAlbumFromRow = useCallback((t) => {
    const key = albumKeyOf(t);
    if (!key || key === '::' || !libAlbums.some((a) => a.key === key)) return;
    setLibDetail({ kind: 'album', key });
  }, [libAlbums]);

  /** Follow state for an artist page: Studio's own follows (studioFollows.js),
   *  the list New Releases reads. Following here doesn't touch Spotify. */
  const studioFollows = useStudioFollows();
  const isFollowing = useCallback((artist) => isStudioFollowed(artist, studioFollows), [studioFollows]);
  const toggleFollow = useCallback(async (artist) => {
    if (!artist) return;
    if (isStudioFollowed(artist, studioFollows)) {
      await unfollowArtist(artist);
      pushToast?.({ message: `Unfollowed ${artist.name}`, kind: 'info', durationMs: 3000, log: false });
      return;
    }
    const r = await followArtist({ spotifyId: artist.spotifyId, name: artist.name, image: artist.art || artist.image });
    if (r?.ok) pushToast?.({ message: `Following ${artist.name}`, kind: 'success', durationMs: 3500, detail: 'Their new albums and singles show up in My Spotify → New Releases. This is Studio’s own follow; nothing changes on Spotify.', log: false });
    else pushToast?.({ message: r?.error || `Couldn’t follow ${artist.name}`, kind: 'error', source: 'Follow' });
  }, [studioFollows, pushToast]);

  /** The open album or playlist, normalised so the detail view renders one shape. */
  const detailData = useMemo(() => {
    if (!libDetail) return null;
    if (libDetail.kind === 'album') {
      const a = libAlbums.find((x) => x.key === libDetail.key);
      if (!a) return null;
      return { kind: 'album', title: a.name, by: a.artist, art: a.art, tracks: a.tracks };
    }
    const pl = playlists.find((x) => x.id === libDetail.key);
    if (!pl) return null;
    const ids = Array.isArray(pl.trackIds) ? pl.trackIds : [];
    const byId = new Map(library.map((t) => [t.id, t]));
    // Playlist order is the stored order, not the library's — that's the point
    // of a playlist.
    const tracks = ids.map((id) => byId.get(id)).filter(Boolean);
    return { kind: 'playlist', title: pl.name, by: 'You', art: pl.coverArt || tracks[0] ? (pl.coverArt || coverFor(tracks[0])) : null, tracks };
  }, [libDetail, libAlbums, playlists, library, coverFor]);

  /* Page wash, sampled from the open record's cover. Same sampler the
     fullscreen stage and miniplayer use, so there's no second colour system —
     and it means a record page carries the record's identity instead of the
     flat black every other view uses. */
  const [detailTheme, setDetailTheme] = useState(null);
  useEffect(() => {
    const art = detailData?.art;
    if (!art) { setDetailTheme(null); return undefined; }
    let dead = false;
    sampleCoverTheme(art).then((t) => { if (!dead) setDetailTheme(t || null); }).catch(() => {});
    return () => { dead = true; };
  }, [detailData?.art]);

  /** Tracks after the in-page filter. */
  const detailTracks = useMemo(() => {
    const list = detailData?.tracks || [];
    const q = detailFilter.trim().toLowerCase();
    if (!q) return list;
    return list.filter((t) => `${t.title || ''} ${t.artist || ''} ${t.album || ''}`.toLowerCase().includes(q));
  }, [detailData, detailFilter]);

  /** Genres present on the open record, for the pill row. One pill per genre:
   *  a track tagged "Emo Rap; Alternative Rock" contributes two, rather than
   *  rendering the raw delimited string inside a single pill. */
  const detailGenres = useMemo(() => {
    if (!detailData) return [];
    const seen = new Map();
    for (const t of detailData.tracks) {
      for (const g of parseGenres(t.genre)) {
        const k = g.toLowerCase();
        seen.set(k, (seen.get(k) || { g, n: 0 }));
        seen.get(k).n += 1;
      }
    }
    return [...seen.values()].sort((a, b) => b.n - a.n).slice(0, 6).map((x) => x.g);
  }, [detailData]);

  const libTitle = useMemo(() => {
    if (libView.startsWith('pl:')) {
      const pl = playlists.find((x) => x.id === libView.slice(3));
      return pl?.name || 'Playlist';
    }
    return (LIB_VIEWS.find(([id]) => id === libView) || [, 'Library'])[1];
  }, [libView, playlists]);

  const libRows = useMemo(() => {
    let list = library;
    if (libView.startsWith('pl:')) {
      const pl = playlists.find((x) => x.id === libView.slice(3));
      const ids = new Set(Array.isArray(pl?.trackIds) ? pl.trackIds : []);
      list = library.filter((t) => ids.has(t.id));
    }
    const q = libFilter.trim().toLowerCase();
    if (q) {
      list = list.filter((t) => `${t.title || ''} ${t.artist || ''} ${t.album || ''}`.toLowerCase().includes(q));
    }
    const out = [...list];
    const byTrack = (a, b) => (a.discNumber || 1) - (b.discNumber || 1) || (a.trackNumber || 0) - (b.trackNumber || 0);
    /* An explicit choice wins; otherwise the view decides, which is what it
       always did. Album and artist orders keep their disc/track tiebreak so a
       record still reads in its own running order inside the group. */
    const by = libRowSort || (libView === 'albums' ? 'album'
      : libView === 'artists' ? 'artist'
        : libView === 'recent' ? 'recent' : 'title');
    if (by === 'recent') out.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    else if (by === 'album') out.sort((a, b) => titleCollator.compare(a.album || '', b.album || '') || byTrack(a, b));
    else if (by === 'artist') out.sort((a, b) => titleCollator.compare(a.artist || '', b.artist || '') || titleCollator.compare(a.album || '', b.album || '') || byTrack(a, b));
    else out.sort((a, b) => titleCollator.compare(a.title || '', b.title || ''));
    return out;
  }, [library, libView, libFilter, playlists, libRowSort]);

  /* Resync the mirrored scroll offset whenever the list's length changes.
     The ref callback covers a remount, but switching between views that reuse
     the same scroll node leaves the element in place with its old scrollTop
     while the rows underneath it change — and if the new list is shorter, the
     browser clamps scrollTop without React hearing about it until the next
     real scroll. Layout effect, so it lands before paint rather than after. */
  useLayoutEffect(() => {
    const el = libScrollElRef.current;
    if (!el) return;
    const actual = el.scrollTop || 0;
    setLibScrollTop((prev) => (Math.abs(prev - actual) > 1 ? actual : prev));
  }, [libRows.length]);

  /** The field libRows is actually ordered by — the A–Z rail has to agree. */
  const libSortField = useMemo(() => (libRowSort || (libView === 'albums' ? 'album'
    : libView === 'artists' ? 'artist'
      : libView === 'recent' ? 'recent' : 'title')), [libRowSort, libView]);

  /* A–Z index over the songs list.
   *
   * Keyed on whatever field the list is CURRENTLY sorted by, not always the
   * title — a rail that jumps to "M" by title while the list is ordered by
   * artist would land somewhere arbitrary, which is worse than having no rail.
   * Suppressed entirely for date-ordered and filtered views, where letters
   * carry no positional meaning at all.
   *
   * Stores the first row index per letter; '#' collects digits and symbols,
   * which the collator sorts to the front.
   */
  const libAzIndex = useMemo(() => {
    if (libFilter.trim()) return null;
    // Follows the effective sort. Keyed to the view instead, the rail would
    // jump to "M" by title while the list was ordered by artist.
    const field = libSortField === 'recent' ? null : libSortField;
    if (!field) return null;
    const map = new Map();
    libRows.forEach((t, i) => {
      const ch = String(t?.[field] || '').trim().charAt(0).toUpperCase();
      const letter = /[A-Z]/.test(ch) ? ch : '#';
      if (!map.has(letter)) map.set(letter, i);
    });
    // One letter means every row starts the same way — a rail with a single
    // live target is just clutter.
    return map.size > 1 ? map : null;
  }, [libRows, libSortField, libFilter]);

  /** Relative "date added" — absolute dates read as noise in a dense table.
   *  added_at is stored by SQLite as strftime('%s','now'), i.e. SECONDS. Read
   *  as milliseconds every row lands in 1970 and reports "56 yr ago". Values
   *  below ~1e11 are unambiguously seconds (that ceiling is year 5138 in
   *  seconds, but only 1973 in ms), so scale those up. */
  const fmtAdded = useCallback((raw) => {
    if (!raw) return '—';
    const ms = raw < 1e11 ? raw * 1000 : raw;
    const d = Math.floor((Date.now() - ms) / 86400000);
    if (d <= 0) return 'Today';
    if (d === 1) return 'Yesterday';
    if (d < 30) return `${d} days ago`;
    if (d < 365) return `${Math.floor(d / 30)} mo ago`;
    return `${Math.floor(d / 365)} yr ago`;
  }, []);

  const [newPlaylist, setNewPlaylist] = useState(null);   // { name } | null
  const [addToPl, setAddToPl] = useState(null);           // { trackIds } | null

  /* The same menu, opened from a button rather than a right-click.
   *
   * It is deliberately the SAME menu and not a second one built for the bar.
   * Every option in it — play next, add to queue, playlists, favourite, copy
   * link, edit info, remove — already exists here and already knows how to
   * handle the album-wide cases; a parallel bar menu would be a second copy
   * to keep in step, and the two would drift the first time an option was
   * added to one of them.
   *
   * Anchored to the button's own box instead of the pointer, so it lines up
   * with the control whether it was opened by mouse or keyboard, and flagged
   * `above` because the bar sits on the bottom edge.
   */
  const openBarMenu = useCallback((e, track) => {
    if (!track) return;
    const r = e.currentTarget.getBoundingClientRect();
    setConfirmKey(null);
    // Right-aligned to the button: the cluster is hard against the right edge
    // of the bar, so a left-aligned menu would immediately hit the clamp and
    // stop tracking the button it came from.
    setRowMenu({ x: r.right - 236, y: r.top - 10, track, above: true, bar: true });
  }, []);

  /* ---------- Playlist picker ------------------------------------------
   *
   * Filing a song used to be a submenu inside the row menu: a scrolling
   * strip of playlists, one click per playlist, and the menu closing on the
   * first pick so filing a song in three lists meant opening the menu three
   * times. It also had no way to say "actually, not that one" — the only
   * route back out was the playlist's own detail page.
   *
   * A sheet with checkboxes fixes both. Ticks are STAGED and applied on
   * Done, which is what makes multi-select worth having: one confirmation,
   * one toast, and Cancel genuinely cancels.
   *
   * `initial` is the set of playlists that already held the song when the
   * sheet opened. Done diffs against it, so a box you tick and untick again
   * costs nothing, and unticking one that was already ticked REMOVES the
   * song — which is what a checkbox promises and the old submenu couldn't
   * honour.
   */
  const openPlaylistPicker = useCallback((track, anchor) => {
    if (!track) return;
    const inPl = (playlists || [])
      .filter((p) => (p.trackIds || []).includes(track.id))
      .map((p) => p.id);
    setPlPickerQuery('');
    setPlPickerNew(null);
    /* Anchored, not centred. This is a menu — it belongs beside the control
       that opened it, the way the row menu does. A centred dialog over a
       dimmed screen is the right shape for something that interrupts you;
       filing a song does not, and the backdrop hid the very library you were
       filing it from. `anchor` is { x, y, above }, in the same terms the row
       menu uses, so a picker opened FROM that menu lands exactly where it
       was standing. */
    setPlPicker({ track, initial: inPl, sel: inPl, ...(anchor || {}) });
  }, [playlists]);

  // Escape closes the picker. Registered on the window rather than the panel
  // so it works before anything inside has been focused.
  useEffect(() => {
    if (!plPicker) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // The inline "new playlist" field handles its own Escape and stops the
      // event; if it reaches here, nothing is being typed.
      e.preventDefault();
      setPlPicker(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [plPicker]);

  const togglePlPick = useCallback((id) => {
    setPlPicker((cur) => {
      if (!cur) return cur;
      const has = cur.sel.includes(id);
      return { ...cur, sel: has ? cur.sel.filter((x) => x !== id) : [...cur.sel, id] };
    });
  }, []);

  const commitPlaylistPicker = useCallback(async () => {
    const cur = plPicker;
    if (!cur) return;
    const add = cur.sel.filter((id) => !cur.initial.includes(id));
    const remove = cur.initial.filter((id) => !cur.sel.includes(id));
    if (!add.length && !remove.length) { setPlPicker(null); return; }
    setPlPickerBusy(true);
    let failed = 0;
    try {
      /* Sequential, not Promise.all. Each write goes through IPC to a
         SQLite handle in the main process that serialises anyway, and
         firing them together only makes a failure harder to attribute. */
      for (const id of add) {
        const r = await onAddTracksToPlaylist?.(id, [cur.track.id]);
        if (r && r.ok === false) failed += 1;
      }
      for (const id of remove) {
        const r = await onRemoveFromPlaylist?.(id, cur.track.id);
        if (r && r.ok === false) failed += 1;
      }
    } catch { failed += 1; } finally {
      setPlPickerBusy(false);
      setPlPicker(null);
    }
    const nameOf = (id) => (playlists || []).find((p) => p.id === id)?.name || 'playlist';
    if (failed) {
      pushToast?.({ message: 'Some playlists could not be updated.', kind: 'error' });
    } else if (add.length === 1 && !remove.length) {
      pushToast?.({ message: `Added to ${nameOf(add[0])}.` });
    } else if (remove.length === 1 && !add.length) {
      pushToast?.({ message: `Removed from ${nameOf(remove[0])}.` });
    } else {
      // Mixed, or several of one kind — a count says more than a list of
      // names that would run off the end of the toast.
      const n = add.length + remove.length;
      pushToast?.({ message: `Updated ${n} playlist${n === 1 ? '' : 's'}.` });
    }
  }, [plPicker, playlists, onAddTracksToPlaylist, onRemoveFromPlaylist, pushToast]);

  /* Creating from inside the sheet commits the PLAYLIST immediately, then
     ticks it. The song still isn't filed until Done — the two are separate
     actions, and a new empty playlist surviving Cancel is correct. */
  const createFromPlPicker = useCallback(async () => {
    const name = (plPickerNew || '').trim();
    if (!name) return;
    const r = await onCreatePlaylist?.({ name });
    if (r?.ok && r.id) {
      setPlPickerNew(null);
      setPlPicker((cur) => (cur ? { ...cur, sel: [...cur.sel, r.id] } : cur));
    } else {
      pushToast?.({ message: 'Could not create that playlist.', kind: 'error' });
    }
  }, [plPickerNew, onCreatePlaylist, pushToast]);
  const createPlaylistNow = useCallback(async () => {
    const name = (newPlaylist?.name || '').trim();
    if (!name || !onCreatePlaylist) return;
    const r = await onCreatePlaylist({ name });
    setNewPlaylist(null);
    // Jump straight to the new playlist — creating one and being left on the
    // previous view makes it feel like nothing happened.
    if (r?.ok && r.id) pickLibView(`pl:${r.id}`);
  }, [newPlaylist, onCreatePlaylist, pickLibView]);

  /* ---- Home rows -------------------------------------------------------
   * Both derive from the play log rather than being stored: the log is the
   * single source of truth for listening, and anything cached alongside it
   * would need invalidating on every play, import and library clear.
   *
   * Events are matched by id, so a track whose history hasn't reattached yet
   * (deleted, not re-imported) simply doesn't appear — better than showing a
   * row of blanks.
   */
  const recentlyPlayed = useMemo(() => {
    const byId = new Map(library.map((t) => [t.id, t]));
    const seen = new Set();
    const out = [];
    const evs = [...(playEvents || [])]
      .filter((e) => e && Number.isFinite(e.at))
      .sort((a, b) => b.at - a.at);
    for (const e of evs) {
      if (seen.has(e.id)) continue;
      const t = byId.get(e.id);
      if (!t) continue;
      seen.add(e.id);
      out.push(t);
      if (out.length >= 20) break;
    }
    return out;
  }, [library, playEvents]);

  /* Most-played artists, with a representative cover for each. Counts come
     from the log rather than tracks.play_count so the row reflects the same
     window as everything else on this page. */
  const favoriteArtists = useMemo(() => {
    const byId = new Map(library.map((t) => [t.id, t]));
    const tally = new Map();
    for (const e of (playEvents || [])) {
      const t = byId.get(e?.id);
      if (!t) continue;
      const name = (t.artist || '').trim();
      if (!name || name.toLowerCase() === 'unknown artist') continue;
      const k = name.toLowerCase();
      const cur = tally.get(k) || { artist: name, plays: 0, art: null };
      cur.plays += 1;
      if (!cur.art) cur.art = coverFor(t);
      tally.set(k, cur);
    }
    return [...tally.values()].sort((a, b) => b.plays - a.plays).slice(0, 20);
  }, [library, playEvents, coverFor]);


  // Recently played — most-recent-first, de-duplicated by track, resolved
  // from the play-event log against the current library.

  /* ========================================================================
   *  Render
   * ======================================================================== */
  const NAV_BTN = 40;
  const NAV_GAP = 4;
  // Anything that owns Esc (or the letter keys) while fullscreen is up.
  npFullBlockers.current = !!(rowMenu || plPicker || coverZoom || editingTrack || lyricSel || lyricShareOpen);

  /* The shell's geometry, for wherever notifications are set to dock (the
     stack lives in App, outside this root). Same numbers as the variables on
     the root below. */
  /* ---------- My Spotify bridge (MySpotify.jsx) ---------------------------
     Rows on those pages are Spotify tracks, not library rows. Playing one
     plays your library's copy when you have it (a Saved row, or a local file
     of the same song); otherwise a stream-only track the helper plays
     straight away, with nothing saved. Save adds it for good. */
  const libBySpotifyId = useMemo(() => {
    const m = new Map();
    for (const t of library) { const sid = spotifyIdOf(t); if (sid) m.set(sid, t); }
    return m;
  }, [library]);
  const spotifyPlayable = useCallback((row) => libBySpotifyId.get(row.spotifyId)
    || ownedTrackFor(row.title, row.artists)
    || {
      id: `spotify:track:${row.spotifyId}`,
      filePath: `spotify:track:${row.spotifyId}`,
      title: row.title || '',
      artist: row.artists || '',
      album: row.album || '',
      coverArt: row.albumArtUrl || null,
      duration: (Number(row.durationMs) || 0) / 1000,
      explicit: !!row.explicit,
      trackNumber: row.trackNumber || null,
      streamOnly: true,
    }, [libBySpotifyId, ownedTrackFor]);
  const mySpotifyBridge = useMemo(() => {
    const saveState = (row) => {
      if (libBySpotifyId.has(row.spotifyId) || ownedTrackFor(row.title, row.artists)) return 'saved';
      const st = dlState[`s:${row.spotifyId}`];
      return st === 'busy' ? 'busy' : st === 'done' ? 'saved' : null;
    };
    const currentSid = spotifyIdOf(currentTrack);
    return {
      playRows(rows, index = 0, { shuffle = false, context = null } = {}) {
        const spotifyRows = (rows || []).filter((r) => r?.spotifyId);
        notePlayContext(spotifyRows, context);
        const list = spotifyRows.map(spotifyPlayable);
        if (!list.length) return;
        if (shuffle) {
          const mixed = [...list].sort(() => Math.random() - 0.5);
          onPlayTrack?.(mixed[0], mixed);
        } else {
          onPlayTrack?.(list[Math.min(index, list.length - 1)] || list[0], list);
        }
      },
      saveRow(row) { if (!saveState(row)) downloadSpotifyRow(row, { noPicker: true }); },
      saveState,
      isCurrent: (row) => !!currentSid && currentSid === row.spotifyId,
      isPlaying: !!isPlaying,
      hoverProps: (row) => hoverPreload(spotifyPlayable(row)) || {},
      onOpenArtist: openArtistAnywhere,
      onConnect: () => { pickSection('settings'); setSetCat('connections'); },
    };
  }, [libBySpotifyId, ownedTrackFor, dlState, currentTrack, isPlaying, spotifyPlayable, onPlayTrack, downloadSpotifyRow, openArtistAnywhere, pickSection]);

  const barShown = !!currentTrack && !libExpanded;
  useEffect(() => {
    const gutter = compactMode ? 10 : 16;
    const gap = compactMode ? 10 : 12;
    setToastLayout({
      gutter, gap,
      reserve: barShown ? gutter + 86 + gap : gutter,
      barLeft: compactMode ? gutter : SIDEBAR_W,
      sidebarW: compactMode ? 0 : SIDEBAR_W,
      shellTop: compactMode ? gutter : TOPBAR_H,
      barShown, barH: 86,
    });
  }, [compactMode, barShown]);

  const compactVizCtx = useMemo(() => ({
    enabled: compactMode, style: compactViz,
    analyserRef, onNeedAnalyser, currentTrack, isPlaying, currentTime, duration, onSeek,
    palette: npWashTheme?.palette || null, accent: rawAccent, coverColours: compactVizCover,
  }), [compactMode, compactViz, analyserRef, onNeedAnalyser, currentTrack, isPlaying, currentTime, duration, onSeek, npWashTheme, rawAccent, compactVizCover]);

  return (
    /* Flat black behind everything. The radial gradient that used to lift the
       top of the window read as a seam once the content became its own panel —
       the panel floated on a lighter patch instead of on the shell. */
    <CompactVizContext.Provider value={compactVizCtx}>
    <div className={compactMode ? 'sth-root is-compact' : 'sth-root'} style={{
      position: 'absolute', inset: 0, overflow: 'hidden',
      /* Every themed colour resolves from these four. Defined once on the root
         so the whole tree — including the class-based styles below — picks them
         up without any prop threading. */
      '--st-bg-rgb': theme.bg,
      '--st-text-rgb': theme.text,
      '--st-sub-rgb': theme.sub,
      // Falls back to `text` so themes saved before fg existed still resolve.
      '--st-fg-rgb': theme.fg || theme.text,
      '--st-text': `rgb(${theme.text})`,
      /* --st-acc-rgb / --st-acc-ink are NOT set here any more: accentTokens
         writes them on :root and cross-fades them on track change. Setting
         them inline on this div shadowed the fade and snapped the colour. */
      background: `rgb(${theme.bg})`,
      '--np-bar-bg': npBarColor,
      '--np-bar-left': compactMode ? 'var(--gutter)' : `${SIDEBAR_W}px`,
      /* Where the content card and the side panel start. Compact drops the
         top bar out of the layout, so both begin one gutter from the top. */
      '--shell-top': compactMode ? 'var(--gutter)' : `${TOPBAR_H}px`,
      /* The height bug (brief, App shell): the card used to reserve the Now
         Playing bar's space whether or not the bar was showing. Now it only
         does when the bar is actually mounted — 16 gutter + 86 bar + 12 gap. */
      /* One spacing system for the whole shell, stated once:
           --gutter  window edge (right, bottom, and the sidebar's left inset)
           --gap     between two surfaces (card ↔ bar, card ↔ side panel)
           --np-reserve  what the card and the side panel leave at the bottom:
                     the gutter alone, or gutter + bar + gap while the bar is up.
         Every surface below reads these instead of carrying its own number,
         which is what let the card, the bar and the panel drift apart. */
      '--gutter': compactMode ? '10px' : '16px',
      '--gap': compactMode ? '10px' : '12px',
      /* + the notification lane, when notifications are set to take one
         (Toasts.jsx sets it on :root and eases it). */
      '--np-reserve': `calc(${currentTrack && !libExpanded
        ? (compactMode ? `${10 + 86 + 10}px` : `${16 + 86 + 12}px`)
        : (compactMode ? '10px' : '16px')} + var(--st-toast-lane, 0px))`,
      '--row-h': listDensity === 'compact' ? '40px' : listDensity === 'roomy' ? '64px' : '54px',
      '--row-art': listDensity === 'compact' ? '30px' : listDensity === 'roomy' ? '48px' : '40px',
    }}>
      <StudioMotionStyles />
      <style>{`
        /* Redefine stFadeUp to settle at transform: none rather than
           translateY(0). A lingering identity transform keeps the element (and
           .sth-scroll, which wraps all content) on a composited GPU layer, and
           that layer + backdrop-filter is what renders text subtly blurry in
           Chromium. Ending at "none" declassifies the layer so text stays crisp
           while the fade-up motion is unchanged. */
        @keyframes stFadeUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
        /* Inset panel: the content sits in its own rounded surface rather
           than bleeding to the window edges, so the shell reads as chrome and
           this reads as the thing you're looking at. margin (not padding) on
           the outside, because the rounded corners have to clip the scrolling
           content — padding would let it run under them. */
        /* Bottom margin is 104, not 12: the Now Playing bar is position: fixed
           at bottom 12 and 84 tall, so the panel has to end above it (96) plus
           a gap, or the last row of content sits underneath.
           Pure black, exactly like the bar and the shell — so the panel is
           defined by its BORDER, not by a difference in fill. The border
           carries all the weight here, which is why it's 0.11 rather than the
           0.05 hairline used elsewhere: at 0.05 against an identical
           background the edge simply disappears. */
        .sth-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 26px 90px; margin: 0 12px 104px; border-radius: 16px; background: rgb(var(--st-bg-rgb)); border: 1px solid rgba(var(--st-fg-rgb), 0.11); scrollbar-width: none; -ms-overflow-style: none; }
        /* Album / playlist page fills the wrapper edge to edge.
           The wrapper's own 18/26/90 padding is right for a scrolling page of
           sections, but here it inset the page inside the panel — visible as a
           second rounded rectangle and ~90px of dead space at the bottom. The
           page scrolls its own tracklist, so this container mustn't scroll too
           or the two fight each other. */
        /* Album / playlist page fills the wrapper exactly.
           A flex:1 rule on every child wasn't enough: the scroller has several children
           (one per section) and the ones that render null still left the flex
           maths splitting space, so the page came up short and the wrapper's
           black showed underneath. Absolute inset removes the flex chain from
           the equation entirely — the page is pinned to all four edges. */
        .sth-scroll.is-page { padding: 0; overflow: hidden; position: relative; }
        .sth-scroll.is-page > .sth-libpage, .sth-scroll.is-page > .sth-find, .sth-scroll.is-page > .sth-setpage, .sth-scroll.is-page > .sth-statspage { position: absolute; inset: 0; }
        /* Scrollbar hidden — the panel has rounded corners and a visible
           gutter running down the inside of them looked like a defect. */
        .sth-scroll::-webkit-scrollbar { width: 0; height: 0; display: none; }
        .sth-scroll::-webkit-scrollbar { width: 6px; }
        .sth-scroll::-webkit-scrollbar-thumb { background: rgba(var(--st-fg-rgb), 0.14); border-radius: 999px; }
        .sth-row { display: flex; align-items: center; gap: 12px; width: 100%; padding: 7px 10px; border-radius: 12px; border: none; background: transparent; cursor: pointer; text-align: left; color: inherit; transition: background 0.14s ease; }
        .sth-row:hover { background: rgba(var(--st-fg-rgb), 0.055); }
        .sth-row.is-active { background: rgba(var(--st-fg-rgb), 0.08); }
        .sth-seg { cursor: pointer; padding: 6px 13px; border-radius: 8px; font-size: 11.5px; font-weight: 600; letter-spacing: 0.02em; border: none; background: transparent; color: rgba(var(--st-fg-rgb), 0.42); transition: background 0.18s ease, color 0.18s ease; }
        .sth-seg:hover { color: rgba(var(--st-fg-rgb), 0.72); }
        .sth-seg.on { background: rgba(var(--st-fg-rgb), 0.14); color: #fff; }
        .sth-card { border-radius: 16px; overflow: hidden; background: rgba(var(--st-fg-rgb), 0.045); border: 1px solid rgba(var(--st-fg-rgb), 0.07); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); }
        /* --- library song table --- */
        .sth-thead, .sth-trow { display: grid; grid-template-columns: 30px 44px minmax(0,1fr) minmax(0,0.6fr) 132px; gap: 12px; align-items: center; padding: 6px 14px; }
        .sth-thead { padding: 10px 14px 8px; font-size: 9.5px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: rgba(var(--st-fg-rgb), 0.32); border-bottom: 1px solid rgba(var(--st-fg-rgb), 0.06); }
        .sth-trow { border-top: 1px solid rgba(var(--st-fg-rgb), 0.04); cursor: pointer; transition: background 0.13s ease; color: inherit; width: 100%; text-align: left; background: transparent; border-left: none; border-right: none; border-bottom: none; }
        .sth-trow:hover { background: rgba(var(--st-fg-rgb), 0.05); }
        .sth-trow.is-active { background: rgba(var(--st-fg-rgb), 0.08); }
        .sth-num { display: block; font-variant-numeric: tabular-nums; }
        .sth-playg { display: none; }
        .sth-trow:hover .sth-num { display: none; }
        .sth-trow:hover .sth-playg { display: block; }
        .sth-hact { display: flex; gap: 5px; opacity: 0; pointer-events: none; transition: opacity 0.14s ease; }
        .sth-trow:hover .sth-hact, .sth-arow:hover .sth-hact { opacity: 1; pointer-events: auto; }
        .sth-iconbtn { width: 25px; height: 25px; border-radius: 7px; border: none; cursor: pointer; background: rgba(var(--st-fg-rgb), 0.09); color: rgba(var(--st-fg-rgb), 0.78); display: flex; align-items: center; justify-content: center; padding: 0; transition: background 0.13s ease, color 0.13s ease; }
        .sth-iconbtn:hover { background: rgba(var(--st-fg-rgb), 0.18); color: #fff; }
        @media (max-width: 980px) {
          .sth-thead, .sth-trow { grid-template-columns: 30px 44px minmax(0,1fr) 132px; }
          .sth-albcell { display: none; }
        }
        /* =================== Find: results split view ====================
           One surface, not two. An earlier pass gave each column the
           .sth-libpanel treatment (fill + border + radius) and the result was
           a card inside the content panel's card — a box in a box. Here the
           columns sit directly on the page and are told apart by ONE device,
           chosen in Settings → Appearance:
             rule  — a 1px hairline, same weight as the table dividers
             wash  — no rules; the detail side carries a cover-accent gradient
             gap   — nothing but space
           The page header spans both columns. Giving each column its own
           header is the other half of what made them read as two widgets. */
        .sth-find { position: absolute; inset: 0; display: flex; flex-direction: column; }
        .sth-find-head { flex-shrink: 0; padding: 18px 26px 13px; }
        .sth-find-split { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(0, 1fr); }
        .sth-find-col { min-width: 0; min-height: 0; overflow-y: auto; scrollbar-width: thin; scrollbar-color: rgba(var(--st-fg-rgb), 0.13) transparent; }
        .sth-find-col::-webkit-scrollbar { width: 6px; }
        .sth-find-col::-webkit-scrollbar-thumb { background: rgba(var(--st-fg-rgb), 0.13); border-radius: 999px; }
        .sth-find-list { padding: 0 14px 26px 20px; }
        .sth-find-det { padding: 0 22px 26px 22px; position: relative; }
        .sth-find.v-rule .sth-find-head { border-bottom: 1px solid rgba(var(--st-fg-rgb), 0.07); }
        .sth-find.v-rule .sth-find-det { border-left: 1px solid rgba(var(--st-fg-rgb), 0.07); }
        .sth-find.v-wash .sth-find-head { border-bottom: 1px solid rgba(var(--st-fg-rgb), 0.05); }
        .sth-find.v-wash .sth-find-det { padding-left: 26px; }
        /* Falls off over 280px so it reads as light on the surface rather than
           a panel with a coloured top. Behind everything (z-index on content). */
        .sth-find.v-wash .sth-find-det::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 280px; pointer-events: none;
          background: linear-gradient(180deg, rgba(var(--st-acc-rgb), 0.13), rgba(var(--st-acc-rgb), 0) 78%); }
        .sth-find.v-gap .sth-find-split { grid-template-columns: minmax(0, 1fr) 44px minmax(0, 1.06fr); }
        .sth-find.v-gap .sth-find-det { padding-left: 0; padding-right: 26px; }

        /* Section labels stick to the top of their own column. Solid bg, not
           translucent: rows scrolling under a blurred label is the one place
           backdrop-filter reliably looks like a smear. */
        .sth-fsec { position: sticky; top: 0; z-index: 2; background: rgb(var(--st-bg-rgb)); padding: 14px 6px 8px; margin-bottom: 2px;
          font-size: 10px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(var(--st-fg-rgb), 0.32);
          display: flex; align-items: center; gap: 8px; }
        .sth-fsec::after { content: ''; position: absolute; left: 6px; right: 6px; bottom: 0; height: 1px; background: rgba(var(--st-fg-rgb), 0.05); }
        .sth-fsec .ct { color: rgba(var(--st-fg-rgb), 0.22); letter-spacing: 0; font-weight: 700; }

        .sth-frow { position: relative; display: flex; align-items: center; gap: 11px; width: 100%; padding: 8px 10px; border-radius: 10px;
          border: none; background: transparent; color: inherit; text-align: left; cursor: pointer; transition: background 0.13s ease; }
        .sth-frow:hover { background: rgba(var(--st-fg-rgb), 0.05); }
        .sth-frow.on { background: rgba(var(--st-acc-rgb), 0.10); }
        /* The selected row points AT the detail column instead of being
           outlined — an outline on a row sitting on a flat page just draws a
           small card again, which is the thing this layout removed. */
        .sth-frow.on::before { content: ''; position: absolute; left: -14px; top: 6px; bottom: 6px; width: 2.5px; border-radius: 999px; background: rgb(var(--st-acc-rgb)); }
        .sth-fart { width: 42px; height: 42px; border-radius: 9px; flex-shrink: 0; background-size: cover; background-position: center;
          background-color: rgba(var(--st-fg-rgb), 0.06); box-shadow: 0 0 0 1px rgba(var(--st-fg-rgb), 0.08); }
        .sth-fglyph { width: 42px; height: 42px; border-radius: 9px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
          background: rgba(var(--st-fg-rgb), 0.05); border: 1px solid rgba(var(--st-fg-rgb), 0.09); color: rgba(var(--st-fg-rgb), 0.45); }
        .sth-fnm { font-size: 13px; font-weight: 650; color: var(--st-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sth-fmeta { display: flex; align-items: center; gap: 7px; margin-top: 3px; min-width: 0; font-size: 10.5px; color: rgba(var(--st-sub-rgb), 0.45); }
        .sth-fmeta > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        /* Plain facts get dot separators; badges and the slot tag don't, since
           they're already visually bounded and a dot in front of a pill reads
           as a bullet list. Only .sth-fmi carries the dot, and only when it
           follows another .sth-fmi — so "keshi · 2025 · 3 tracks" gets them
           while "[FLAC] keshi · 3 sources ●Free slot" doesn't get a stray one
           after the badge. */
        .sth-fmi + .sth-fmi::before { content: '·'; margin-right: 7px; color: rgba(var(--st-sub-rgb), 0.3); font-weight: 700; }

        .sth-fbadge { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; font-size: 9.5px; font-weight: 800; letter-spacing: 0.05em;
          padding: 3px 7px; border-radius: 6px; text-transform: uppercase; white-space: nowrap; }
        .sth-favail { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; font-size: 10.5px; font-weight: 650; white-space: nowrap; }
        .sth-fdot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }

        .sth-ftab { border: none; background: transparent; cursor: pointer; color: rgba(var(--st-fg-rgb), 0.42); font-size: 12.5px; font-weight: 700;
          padding: 6px 11px; border-radius: 9px; font-family: inherit; transition: background 0.14s ease, color 0.14s ease; }
        .sth-ftab:hover { color: rgba(var(--st-fg-rgb), 0.78); background: rgba(var(--st-fg-rgb), 0.04); }
        .sth-ftab.on { color: #fff; background: rgba(var(--st-fg-rgb), 0.09); }
        /* Filter chips. The old ones were flat dark pills with a label and no
           other signal — you couldn't tell a toggle from a button, or on from
           off at a glance. Now: a state box on the left that fills and checks
           when active, and a count of what the filter is actually doing, so
           the chip reports as well as controls. */
        .sth-fchip { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-family: inherit; font-size: 11.5px; font-weight: 650;
          padding: 6px 12px 6px 8px; border-radius: 999px; border: 1px solid rgba(var(--st-fg-rgb), 0.1); background: rgba(var(--st-fg-rgb), 0.04);
          color: rgba(var(--st-fg-rgb), 0.62); transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease; }
        .sth-fchip:hover { border-color: rgba(var(--st-fg-rgb), 0.22); color: rgba(var(--st-fg-rgb), 0.92); background: rgba(var(--st-fg-rgb), 0.07); }
        .sth-fchip.on { background: rgba(var(--st-acc-rgb), 0.14); border-color: rgba(var(--st-acc-rgb), 0.42); color: rgb(var(--st-acc-rgb)); }
        .sth-fchip.on:hover { background: rgba(var(--st-acc-rgb), 0.2); color: rgb(var(--st-acc-rgb)); }
        .sth-fchip-box { position: relative; width: 15px; height: 15px; flex-shrink: 0; border-radius: 5px;
          border: 1.5px solid rgba(var(--st-fg-rgb), 0.22); transition: background 0.15s ease, border-color 0.15s ease; }
        .sth-fchip:hover .sth-fchip-box { border-color: rgba(var(--st-fg-rgb), 0.34); }
        .sth-fchip.on .sth-fchip-box { background: rgb(var(--st-acc-rgb)); border-color: rgb(var(--st-acc-rgb)); }
        /* Drawn rather than a glyph so it scales with the box and inherits the
           accent's contrast colour. */
        .sth-fchip.on .sth-fchip-box::after { content: ''; position: absolute; left: 4.5px; top: 1px; width: 3.5px; height: 8px;
          border: solid var(--st-acc-ink, #14100a); border-width: 0 2px 2px 0; transform: rotate(45deg); }
        .sth-fchip-ct { font-size: 10.5px; font-weight: 700; padding: 1px 6px; border-radius: 999px; font-variant-numeric: tabular-nums;
          background: rgba(var(--st-fg-rgb), 0.09); color: rgba(var(--st-fg-rgb), 0.45); }
        .sth-fchip.on .sth-fchip-ct { background: rgba(var(--st-acc-rgb), 0.22); color: rgb(var(--st-acc-rgb)); }
        .sth-fsort { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; font-family: inherit; font-size: 11.5px; font-weight: 700;
          padding: 6px 11px; border-radius: 9px; border: 1px solid rgba(var(--st-fg-rgb), 0.1); background: rgba(var(--st-fg-rgb), 0.04); color: rgba(var(--st-sub-rgb), 0.7); }
        .sth-fsort:hover { color: #fff; }
        .sth-fsort b { color: #fff; font-weight: 700; }

        /* Detail column */
        .sth-fdet-hero { display: flex; gap: 18px; align-items: flex-end; padding: 22px 0 16px; position: relative; z-index: 1; }
        .sth-fdet-art { width: 120px; height: 120px; border-radius: 12px; flex-shrink: 0; background-size: cover; background-position: center;
          background-color: rgba(var(--st-fg-rgb), 0.06); box-shadow: 0 14px 40px rgba(0,0,0,0.55); }
        .sth-fdet-title { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; color: var(--st-text); margin-top: 7px; line-height: 1.1;
          overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
        .sth-fdet-sub { font-size: 12.5px; color: rgba(var(--st-sub-rgb), 0.5); margin-top: 7px; }
        .sth-fdet-acts { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; padding-bottom: 16px; position: relative; z-index: 1; }
        .sth-fdetrow { display: grid; grid-template-columns: 28px minmax(0, 1fr) 54px 86px; gap: 10px; align-items: center; padding: 7px 10px; border-radius: 8px; }
        .sth-fdetrow:hover { background: rgba(var(--st-fg-rgb), 0.05); }
        /* One peer offering one song. Stretched rather than tabular: the path
           needs a full line of its own and the numbers are all short. */
        .sth-fsrc { display: flex; align-items: flex-start; gap: 12px; width: 100%; padding: 11px 10px; border-radius: 11px; border: none;
          background: transparent; color: inherit; text-align: left; cursor: pointer; transition: background 0.13s ease; }
        .sth-fsrc:hover { background: rgba(var(--st-fg-rgb), 0.05); }
        .sth-fsrc.on { background: rgba(var(--st-acc-rgb), 0.09); }
        .sth-fpick { width: 15px; height: 15px; border-radius: 50%; flex-shrink: 0; margin-top: 3px; border: 1.5px solid rgba(var(--st-fg-rgb), 0.22); }
        .sth-fsrc.on .sth-fpick { border-color: rgb(var(--st-acc-rgb)); box-shadow: inset 0 0 0 3.5px rgb(var(--st-acc-rgb)); }
        /* rtl keeps the END of a long path visible — the filename matters, the
           first 40 characters of someone's directory tree do not. */
        .sth-fpath { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; color: rgba(var(--st-sub-rgb), 0.32);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
        .sth-fhint { font-size: 11px; color: rgba(var(--st-sub-rgb), 0.3); line-height: 1.6; padding: 14px 10px 0; }
        .sth-fempty { padding: 54px 20px; text-align: center; }

        /* Below 1120 there isn't room for two columns — the list becomes the
           page and picking something swaps to the detail, with a back button
           that only exists at this width. Matches .sth-lib2's behaviour. */
        .sth-fback { display: none; }
        @media (max-width: 1120px) {
          .sth-find-split { grid-template-columns: 1fr !important; }
          .sth-find-det { display: none; border-left: none !important; }
          .sth-find.is-detail .sth-find-list { display: none; }
          .sth-find.is-detail .sth-find-det { display: block; }
          .sth-fback { display: inline-flex; }
        }

        /* ===================== Top bar search =========================
           A real field at rest, not an invisible one that appears on focus.
           It's the only input in the chrome and the way into the whole Find
           view, so it reads as a control you can aim at — but the fill is low
           enough (0.05) that it still sits behind the active nav tab.
           Pill, not the 11–13px radius used elsewhere: nothing else in the app
           is a text field, and the shape is what says "type here" before you
           read anything. */
        .sth-searchbar { display: flex; align-items: center; gap: 10px; width: 100%; height: 40px; padding: 0 10px 0 14px; box-sizing: border-box;
          border-radius: 11px; cursor: text; background: rgba(var(--st-fg-rgb), 0.055); border: 1px solid rgba(var(--st-fg-rgb), 0.07);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
          transition: background 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease; }
        .sth-searchbar:hover { background: rgba(var(--st-fg-rgb), 0.08); border-color: rgba(var(--st-fg-rgb), 0.12); }
        .sth-searchbar:focus-within { background: rgba(var(--st-fg-rgb), 0.08); border-color: rgba(var(--st-acc-rgb), 0.45); box-shadow: 0 0 0 3px rgba(var(--st-acc-rgb), 0.1); }
        .sth-searchbar.is-dirty { border-color: rgba(var(--st-acc-rgb), 0.32); }
        .sth-searchbar-icon { flex-shrink: 0; color: rgba(var(--st-fg-rgb), 0.4); transition: color 0.18s ease; }
        .sth-searchbar:focus-within .sth-searchbar-icon { color: rgb(var(--st-acc-rgb)); }
        .sth-searchbar-input { flex: 1; min-width: 0; background: transparent; border: none; outline: none; font-family: inherit;
          color: var(--st-text); font-size: 13.5px; font-weight: 500; padding: 0; cursor: text; }
        .sth-searchbar-input::placeholder { color: rgba(var(--st-sub-rgb), 0.38); font-weight: 500; }
        .sth-searchbar-end { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
        .sth-searchbar-hint { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; font-size: 10.5px; font-weight: 650; color: rgba(var(--st-sub-rgb), 0.42); }
        .sth-kbd { display: inline-flex; align-items: center; justify-content: center; min-width: 17px; height: 17px; padding: 0 4px; border-radius: 5px;
          background: rgba(var(--st-fg-rgb), 0.09); border: 1px solid rgba(var(--st-fg-rgb), 0.1); font-size: 10px; font-weight: 700;
          color: rgba(var(--st-fg-rgb), 0.5); font-family: inherit; line-height: 1; }
        /* The / hint is a whisper — it disappears the moment you engage. */
        .sth-searchbar-slash { opacity: 0.6; transition: opacity 0.18s ease; }
        .sth-searchbar:hover .sth-searchbar-slash { opacity: 1; }
        /* Bare glyph, no filled square. The old X sat in its own grey tile at
           the field's edge and read as a separate widget parked next to the
           search rather than part of it. */
        .sth-searchbar-x { width: 26px; height: 26px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; padding: 0;
          border: none; border-radius: 50%; cursor: pointer; background: transparent; color: rgba(var(--st-fg-rgb), 0.42);
          transition: background 0.14s ease, color 0.14s ease; }
        .sth-searchbar-x:hover { background: rgba(var(--st-fg-rgb), 0.12); color: #fff; }

        /* Listening calendar. 13px cells + 3px gutters = 16px per week column,
           which the month labels index against. */
        .sth-hm { display: flex; gap: 3px; }
        .sth-hm-col { display: flex; flex-direction: column; gap: 3px; }
        .sth-hm-cell { width: 13px; height: 13px; border-radius: 3.5px; flex-shrink: 0; transition: outline-color 0.12s ease; outline: 1.5px solid transparent; }
        .sth-hm-cell:hover { outline-color: rgba(var(--st-fg-rgb), 0.45); }

        /* --- library album cards --- */
        .sth-alb { border: none; background: transparent; padding: 0; cursor: pointer; text-align: left; color: inherit; min-width: 0; }
        /* Album art stays clean and flush with the grid. The old multi-layer
           black halo created visible bands above and below the first row. */
        .sth-albart { position: relative; aspect-ratio: 1; border-radius: 13px; overflow: hidden; background: rgba(var(--st-fg-rgb), 0.05); border: 1px solid rgba(var(--st-fg-rgb), 0.07); box-shadow: none; transition: transform 0.22s cubic-bezier(0.2,0.9,0.3,1), border-color 0.2s ease, filter 0.2s ease; }
        /* A short lift and gentle brightness change keep hover feedback without
           enlarging or clipping the artwork at the scroll container's edge. */
        .sth-alb:hover .sth-albart { transform: translateY(-2px); border-color: rgba(var(--st-fg-rgb), 0.16); filter: brightness(1.045); }
        .sth-albimg { position: absolute; inset: 0; background-position: center; background-size: cover; transition: filter 0.22s ease; }

        /* ---- Library two-pane layout (Songs / Albums / Artists) ---- */
        /* Both columns are fixed to the viewport height and scroll INTERNALLY,
           so the page itself never scrolls — you scroll within whichever panel
           has more content. Sized for the 1400px default window. */
        .sth-lib2 { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 16px; align-items: stretch; height: calc(100vh - 148px); min-height: 360px; }
        /* Expanded: the fullscreen button on the Now Playing panel hides the
           library list entirely and lets the detail/Now Playing pane span the
           whole grid. The page header above is hidden too, so the panel claims
           that height as well. */
        .sth-lib2.is-max { grid-template-columns: 1fr; height: 100vh; }
        .sth-lib2.is-max .sth-lib2-list { display: none; }
        /* Edge to edge: no rounding or border when it fills the whole area. */
        .sth-lib2.is-max > .sth-lib2-detail > .sth-libpanel { border-radius: 0; border: none; }
        /* Bar mode: the opposite of expanded — the Now Playing pane collapses
           into a floating bar (rendered separately), so the list takes the
           whole grid. Extra bottom room is left for the bar to float over. */
        .sth-lib2.is-bar { grid-template-columns: 1fr; height: calc(100vh - 148px - 80px); }
        .sth-lib2.is-bar .sth-lib2-detail { display: none; }

        /* Now Playing bar.
           Left edge is SIDEBAR_W + 12 so the bar starts where the content
           wrapper starts — it used to run the full window width and extend
           under the library sidebar, which the reference doesn't do.
           12px gutters elsewhere — the SAME value as the content panel's
           margin, so the two line up exactly. At 8px the bar overhung the
           panel by 4px a side, which is what made it look wider.
           Driven by --np-bar-bg, set on the root from Settings → Appearance.
           Solid rather than #000: with no border, an all-black bar on
           an all-black shell had nothing to separate it — it read as a hole
           rather than a surface. A slightly lifted neutral does the job the
           border used to, which is how the reference handles it.
           When immerse is on, the gradient layers paint over this, so it only
           shows in the off state.
           No border: the panel needs one because it encloses scrolling
           content, but the bar sits against the window edge and the reference
           has none. Drop shadow gone with it — there's nothing behind it to
           cast onto. The pointer cursor is gone too: the bar stopped being
           click-to-expand, so the hand cursor was promising an action that
           no longer exists. */
        .sth-npbar { position: fixed; left: var(--np-bar-left, 238px); right: 12px; bottom: 12px; height: 84px; z-index: 30; border-radius: 14px; overflow: hidden; background: var(--np-bar-bg, #20242f); border: none; animation: sthBarIn 0.28s cubic-bezier(0.22,1,0.36,1) both; }
        @keyframes sthPanelIn { from { opacity: 0; transform: translateX(18px); } to { opacity: 1; transform: none; } }
        /* Popovers grow from the control that opened them, rather than sliding
           in from the right the way the docked panel does. */
        @keyframes sthPopIn { from { opacity: 0; transform: translateY(-4px) scale(0.97); } to { opacity: 1; transform: none; } }
        /* Chevron nudge: two peeks out from behind the bar, then a rest.
           Continuous motion turns into jitter you learn to ignore; the pause
           is what makes it read as a gesture being repeated. Runs on transform
           so it composites off the main thread and cannot fight the
           left transition the button already uses for its resting position. */
        /* Hint exit: wind up left, then run right and in behind the tab.
           The backswing is anticipation — a move that starts by going the wrong
           way reads as gathering itself, and it makes the launch feel driven
           rather than merely fast. Travel comes in on --suck-x so the distance
           stays derived in JS instead of hard-coded here.
           Opacity carries a midpoint at 70%: left to the accelerating curve it
           would sit at full brightness and then blink off near the end, which
           is the thing that looked wrong before. */
        @keyframes sthHintSuck {
          0%   { transform: translateX(0) scale(1); opacity: 1;
                 animation-timing-function: cubic-bezier(0.25, 0, 0.25, 1); }
          24%  { transform: translateX(-15px) scale(1); opacity: 1;
                 animation-timing-function: cubic-bezier(0.5, 0, 0.85, 0.4); }
          70%  { opacity: 0.34; }
          100% { transform: translateX(var(--suck-x, 104px)) scale(0.92); opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes sthHintSuck { 0% { opacity: 1; } 100% { opacity: 0; } }
        }
        @keyframes sthChevNudge {
          0%   { transform: translateX(0); }
          9%   { transform: translateX(-6px); }
          19%  { transform: translateX(0); }
          28%  { transform: translateX(-6px); }
          38%  { transform: translateX(0); }
          100% { transform: translateX(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes sthChevNudge { 0%, 100% { transform: translateX(0); } }
        }
        @keyframes sthBarIn { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
        .sth-npbar-play { width: 38px; height: 38px; display: flex; align-items: center; justify-content: center; border-radius: 50%; border: none; cursor: pointer; flex-shrink: 0; transition: filter 0.14s ease, transform 0.1s ease; }
        .sth-npbar-play:hover { filter: brightness(1.1); }
        .sth-npbar-play:active { transform: scale(0.94); }
        @media (max-width: 900px) { .sth-npbar-vol { display: none !important; } }

        /* Bottom-edge seek bar. Thin at rest, thicker on hover; the fill and a
           handle track playback, and the whole strip is click/drag-to-scrub.
           Sits inside the bar's rounded bottom corners. */
        /* Inline in the transport column, not pinned to the bar's bottom edge.
           As an absolute full-width strip it ran under the artwork, which is
           what put the duration label on top of the cover. */
        .sth-npbar-seek { position: relative; flex: 1; min-width: 0; height: 14px; display: flex; align-items: center; cursor: pointer; touch-action: none; }
        .sth-npbar-seek::before { content: ''; position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%); height: 4px; border-radius: 999px; background: rgba(var(--st-fg-rgb), 0.16); transition: height 0.12s ease; }
        .sth-npbar-seek:hover::before, .sth-npbar-seek:focus-visible::before { height: 6px; }
        .sth-npbar-seek-fill { position: absolute; left: 0; top: 50%; transform: translateY(-50%); height: 4px; border-radius: 999px; z-index: 1; transition: width 0.25s linear, height 0.12s ease; }
        .sth-npbar-seek:hover .sth-npbar-seek-fill, .sth-npbar-seek:focus-visible .sth-npbar-seek-fill { height: 6px; }
        .sth-npbar-seek-knob { position: absolute; right: -6px; top: 50%; margin-top: -6px; width: 12px; height: 12px; border-radius: 50%; box-shadow: 0 1px 4px rgba(0,0,0,0.5); opacity: 0; transform: scale(0.6); transition: opacity 0.12s ease, transform 0.12s ease; }
        .sth-npbar-seek:hover .sth-npbar-seek-knob, .sth-npbar-seek:focus-visible .sth-npbar-seek-knob { opacity: 1; transform: scale(1); }
        .sth-npbar-time { position: absolute; bottom: 7px; font-size: 9px; font-weight: 600; color: rgba(var(--st-fg-rgb), 0.7); font-variant-numeric: tabular-nums; opacity: 0; transition: opacity 0.12s ease; pointer-events: none; text-shadow: 0 1px 3px rgba(0,0,0,0.7); }
        .sth-npbar-seek:hover .sth-npbar-time, .sth-npbar-seek:focus-visible .sth-npbar-time { opacity: 1; }
        .sth-npbar-time-l { left: 10px; }
        .sth-npbar-time-r { right: 10px; }
        @media (max-width: 1120px) { .sth-lib2 { grid-template-columns: 1fr; } .sth-lib2 .sth-lib2-detail { display: none; } .sth-lib2.is-detail .sth-lib2-list { display: none; } .sth-lib2.is-detail .sth-lib2-detail { display: flex; } .sth-lib2.is-max .sth-lib2-list { display: none; } .sth-lib2.is-max .sth-lib2-detail { display: flex; } .sth-lib2.is-bar .sth-lib2-detail { display: none; } .sth-lib2.is-bar .sth-lib2-list { display: flex; } }
        /* Each pane is a solid panel matching Stats/Find, not the glassy card. */
        .sth-libpanel { background: rgba(16,16,18,0.92); border: 1px solid rgba(var(--st-fg-rgb), 0.09); border-radius: 16px; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
        .sth-lib2-list, .sth-lib2-detail { min-width: 0; min-height: 0; display: flex; }
        .sth-lib2-list > .sth-libpanel, .sth-lib2-detail > .sth-libpanel { flex: 1; }
        /* The scrolling region inside a panel */
        /* ---- Header/body column alignment ---------------------------------
           The header row is a SIBLING of this scroller, not a child. So the
           body loses width to the scrollbar and the header doesn't, and every
           body column sits a scrollbar-width left of the header above it —
           which reads as "the duration is misaligned" but is really the whole
           grid being offset.

           Two halves to the fix, and they must agree:
             1. Pin the scrollbar to a KNOWN width, so the offset isn't at the
                mercy of the OS (Windows ~17px, overlay scrollbars 0).
             2. Reserve exactly that much on the header's right edge.
           --lib-sbw is the single source for both, so they can't drift apart.
           scrollbar-gutter: stable keeps the space reserved even on short
           lists, so columns don't shift when a scrollbar appears. */
        .sth-ltable { --lib-sbw: 10px; }
        .sth-libscroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; }
        /* Fallback matters: .sth-libscroll is also used outside .sth-ltable
           (the lyrics pane, for one), where the variable isn't in scope. An
           unresolved var() would invalidate the declaration and drop those
           back to the OS scrollbar, so the default is spelled out. */
        .sth-libscroll::-webkit-scrollbar { width: var(--lib-sbw, 10px); }
        .sth-libscroll::-webkit-scrollbar-track { background: transparent; }
        .sth-libscroll::-webkit-scrollbar-thumb { background: rgba(var(--st-fg-rgb), 0.16); border-radius: 999px; border: 3px solid transparent; background-clip: content-box; }
        .sth-libscroll::-webkit-scrollbar-thumb:hover { background: rgba(var(--st-fg-rgb), 0.26); background-clip: content-box; }
        /* Fade the last few pixels instead of slicing a row in half.
           A scroll container almost never ends on a row boundary, so at rest
           there's a sliver of the next row pinned to the bottom edge — it reads
           as a rendering fault rather than "there's more below". The mask makes
           the same information look intentional, and the extra bottom padding
           lets the final row scroll fully clear of the edge. */
        .sth-lfade {
          -webkit-mask-image: linear-gradient(180deg, #000 calc(100% - 26px), transparent 100%);
          mask-image: linear-gradient(180deg, #000 calc(100% - 26px), transparent 100%);
        }
        .sth-lfade > :last-child { margin-bottom: 26px; }
        .sth-mi { display: flex; align-items: center; gap: 11px; width: 100%; text-align: left; padding: 8px 11px; border-radius: 8px; border: none; cursor: pointer; background: transparent; color: rgba(var(--st-fg-rgb), 0.86); font-size: 12.5px; font-weight: 550; font-family: inherit; transition: background 0.12s ease; }
        .sth-mi:hover { background: rgba(var(--mi-accent), 0.14); }
        .sth-mi.is-danger { color: rgb(238,124,124); }
        .sth-mi.is-danger:hover { background: rgba(230,90,90,0.13); }
        .sth-mi-sub { display: block; font-size: 10.5px; color: rgba(var(--st-fg-rgb), 0.4); font-weight: 500; margin-top: 1px; }
        /* Hero entry — text rises and fades as the track changes. Short and
           small: a big move here reads as the page reloading rather than the
           header updating. */
        @keyframes sthHeroIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        .sth-heroin { animation: sthHeroIn 0.42s cubic-bezier(0.22,1,0.3,1) both; }
        /* ---- Compact library header (52px, one row) ---- */
        /* The now-playing wash is absolutely positioned with z-index 0, and the
           header and lists are static. CSS paints in-flow non-positioned boxes
           BEFORE positioned ones, so the wash landed on top of the content
           regardless of DOM order — an 85%-opaque layer over white text, which
           is why the header read as grey and its avatar looked desaturated. It
           faded downward, so rows further down looked fine and the cause looked
           like blur rather than an overlay. Lifting the real content into the
           positioned layer puts the decoration back underneath it. */
        .sth-libpage > *:not([aria-hidden="true"]) { position: relative; z-index: 1; }
        /* ---- Settings: grouped rows ----
           Cards gave a one-line toggle the same visual weight as a five-option
           picker, so nothing was ranked. Rows put every control on the same
           left edge with its label, and weight follows what a setting needs
           rather than how it's marked up. */
        .sth-set { max-width: 720px; margin: 0 auto; padding-bottom: 40px; }
        /* ---- Settings shell: category rail + body + optional preview -------
           Replaces one 760px scroll containing every group. Six groups is
           already past the point where a single column is browsable, and the
           rail means adding a seventh costs one row instead of making the
           scroll longer. */
        /* Fills the page and owns its own scrolling, so the rail and the
           category heading stay put while only the settings move. Previously
           the whole page scrolled as one block: the rail slid away with the
           content, which is the one thing a persistent nav must not do. */
        .sth-set-wrap { display: flex; gap: 0; align-items: stretch; position: absolute; inset: 0; min-height: 0; }
        .sth-set-rail { width: 196px; flex: 0 0 196px; display: flex; flex-direction: column; gap: 2px;
          padding: 22px 18px 22px 26px; overflow-y: auto; scrollbar-width: none; }
        .sth-set-rail::-webkit-scrollbar { width: 0; display: none; }
        .sth-set-rail .lbl { font-size: 9.5px; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(var(--st-fg-rgb), 0.24); font-weight: 800; padding: 14px 10px 5px; }
        .sth-set-navi { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 9px; font-size: 12.5px; font-weight: 700; color: rgba(var(--st-sub-rgb), 0.62); text-align: left; background: none; border: 0; cursor: pointer; transition: background 140ms, color 140ms; width: 100%; }
        .sth-set-navi:hover { background: rgba(var(--st-fg-rgb), 0.05); color: var(--st-text); }
        .sth-set-navi.on { background: rgba(var(--st-fg-rgb), 0.09); color: var(--st-text); }
        .sth-set-navi svg { width: 15px; height: 15px; flex: 0 0 15px; stroke: currentColor; fill: none; stroke-width: 1.9; }
        /* Solid glyphs (the play triangle, the Discord mark) are shapes, not
           outlines — the rail's stroke default turns them into mush. */
        .sth-set-navi svg.is-solid { fill: currentColor; stroke: none; }
        .sth-set-body { flex: 1; min-width: 0; padding: 22px 26px 60px; overflow-y: auto;
          border-left: 1px solid rgba(var(--st-fg-rgb), 0.07); scrollbar-width: thin;
          scrollbar-color: rgba(var(--st-fg-rgb), 0.14) transparent; }
        .sth-set-body::-webkit-scrollbar { width: 10px; }
        .sth-set-body::-webkit-scrollbar-thumb { background: rgba(var(--st-fg-rgb), 0.14); border-radius: 999px; border: 3px solid transparent; background-clip: content-box; }
        .sth-set-prev { width: 288px; flex: 0 0 288px; padding: 22px 22px 22px 0; overflow-y: auto; scrollbar-width: none; }
        .sth-set-prev::-webkit-scrollbar { width: 0; display: none; }
        /* Below this the three columns can't all hold their minimums, so the
           preview is the one that goes — it's the optional part. */
        @media (max-width: 1180px) { .sth-set-prev { display: none; } }

        .sth-set-sec { margin-top: 34px; }
        /* The first group in a category shouldn't be pushed down by a margin
           that exists to separate it from the group ABOVE it — and there
           isn't one. :first-child stopped matching once the category
           heading became the body's first element, so this targets the
           first section wherever it lands instead. */
        .sth-set-body .sth-set-sec:first-of-type { margin-top: 0; }
        /* A section heading was 10.5px uppercase at 34% — quieter than the row
           labels underneath it, so the thing meant to introduce a group was the
           least visible text in it. Full-size and full-strength now, with the
           explanation on its own line beneath rather than trailing off the end
           of it. */
        /* .sth-set-h removed: each category gets ONE heading now, rendered by
           the body from SET_CATS. The per-section version printed the same
           title a second time directly beneath it. Deleted rather than left
           unused so nobody re-adds a heading by reaching for the class. */
        /* NO CONTAINER. This was a filled, rounded, outlined box wrapping every
           group, so each setting read as a card sitting on the page — six
           stacked panels competing with the rail beside them for the role of
           "the structure". With a category rail doing the grouping, the box is
           saying the same thing twice, and boxing content that's already
           inside a bordered page wrapper is a box in a box.
           Rows now sit on the page and are separated by a hairline, which is
           the least ink that still says "these are separate settings". */
        .sth-set-list { border-radius: 0; overflow: visible; background: none; box-shadow: none; }
        .sth-set-r { display: flex; align-items: center; gap: 24px; padding: 15px 2px;
          box-shadow: inset 0 -1px 0 rgba(var(--st-fg-rgb), 0.06); }
        .sth-set-r:last-child { box-shadow: none; }
        .sth-set-r > .txt { flex: 1; min-width: 0; }
        .sth-set-r .txt b { display: block; font-size: 13px; font-weight: 700; color: var(--st-text); letter-spacing: -0.005em; }
        /* Capped at ~58 characters. Some of these notes run four lines, and a
           measure that wide is genuinely harder to read — it also drags the
           row tall enough that its control floats away from its label. */
        .sth-set-r .txt p { margin: 4px 0 0; font-size: 11.5px; font-weight: 500; line-height: 1.5;
          color: rgba(var(--st-sub-rgb), 0.45); max-width: 58ch; }
        .sth-set-r > .ctl { flex-shrink: 0; display: flex; align-items: center; gap: 8px; }
        /* Stacks the control under its label when a row gets tight, instead of
           squeezing a three-option picker into 90px. */
        @media (max-width: 900px) {
          .sth-set-r { flex-direction: column; align-items: stretch; gap: 10px; }
          .sth-set-r > .ctl { justify-content: flex-start; }
        }
        .sth-seg { display: inline-flex; gap: 3px; background: rgba(var(--st-fg-rgb), 0.06); padding: 3px;
          border-radius: 9px; }
        .sth-seg button { border: none; cursor: pointer; font: inherit; font-size: 11.5px; font-weight: 700;
          padding: 5px 11px; border-radius: 7px; background: transparent; color: rgba(var(--st-sub-rgb), 0.5);
          white-space: nowrap; transition: background 0.15s ease, color 0.15s ease; }
        .sth-seg button:hover { color: var(--st-text); }
        .sth-seg button.on { background: rgba(var(--st-fg-rgb), 0.14); color: var(--st-text); }
        .sth-set-link { border: none; background: transparent; cursor: pointer; font: inherit; font-size: 11.5px;
          font-weight: 700; color: rgba(var(--st-sub-rgb), 0.45); padding: 4px 2px; white-space: nowrap; }
        .sth-set-link:hover { color: var(--st-text); }
        /* No fixed height. A 52px height plus align-items:center is what put ~17px
           of empty band above a 17px title and made it read as off-centre —
           the row was sized to a number, not to its contents. Now the content
           sets the height and min-height only stops it collapsing when a view
           passes no meta. */
        /* Two tiers: identity, then controls.
           One row meant the actions had to be pinned somewhere, and pinned
           right they sat across a span of empty header that grew with the
           window — worst with the side panels closed, which is exactly when
           there's most width. Neither row here has anything at a far edge, so
           widening the window adds margin instead of a gap.
           It also gives the title its own line, which is what the 44px
           single-row version never had: 41px of content in a 44px box left
           about 1.5px of air and read as crammed however the type was set. */
        .sth-libhead { display: flex; flex-direction: column; align-items: stretch; gap: 18px;
          flex-shrink: 0; padding: 8px 0 16px;
          margin-bottom: 10px; box-shadow: inset 0 -1px 0 rgba(var(--st-fg-rgb), 0.08); }
        .sth-libhead-r2 { display: flex; align-items: center; gap: 8px; min-width: 0; }
        /* Albums and Artists have no playback or sort controls — their second
           tier held one 32px search icon and an 18px gap above it, so the
           header was mostly reserved space for a row that had nothing in it.
           With one control there's nothing to separate, so it collapses to a
           single row and the search sits inline. Same title size; only the
           empty tier goes. */
        .sth-libhead.is-single { flex-direction: row; align-items: center; gap: 14px;
          padding: 10px 0 14px; }
        /* Title and meta share the top line on a common baseline. Stacking
           them was what let the title grow inside a single-row header; with
           its own tier there's no height to save, and side by side the meta
           reads as a caption to the title rather than a second heading.
           min-width: 0 so a long meta string ellipsises instead of widening
           the row. */
        .sth-libhead-tw { display: flex; align-items: baseline; gap: 12px;
          min-height: 32px; min-width: 0; flex-shrink: 1; }
        /* 850 at -0.022em was heavy AND tight — the letters were pressed
           together at the same moment the box was, which is most of why this
           looked unfinished. 700 at -0.014em is still emphatic but the
           counters open up; 25px reads as deliberate without being a banner. */
        .sth-libhead-t { font-size: 25px; font-weight: 700; letter-spacing: -0.014em; color: var(--st-text);
          line-height: 1.2; white-space: nowrap; flex-shrink: 0; }
        /* The active-filter tag. Only ever on screen when a filter is set,
           so it needs no collapsed state and no width animation — the old
           icon-to-field transition existed to hide a control nobody had
           asked for yet. Accent-tinted because it reports STATE, not a
           control you operate. */
        /* Icon at rest, field when opened.
           The version before this returned null until a filter was already
           set, so the page offered no way to search until you had searched —
           the control only announced itself after you had found it some other
           way. An always-visible icon fixes that without a bar sitting there
           permanently.
           ONE element animates: the container's width, with overflow hidden.
           The input is always flex:1 inside it and simply gets clipped when
           collapsed, so there's no flex-basis transition to go wrong and no
           second tree to swap in. */
        /* Icon at rest, field when opened.
           The version before this returned null until a filter was already
           set, so the page offered no way to search until you had searched —
           the control only announced itself after you had found it some other
           way. An always-visible icon fixes that without a bar sitting there
           permanently.

           Shaped like .sth-libact, its neighbour in this row: 8px radius, no
           border, a fill that only appears on hover. A 999px bordered pill was
           the odd one out in a UI whose controls are all soft rectangles — it
           read as borrowed from somewhere else, and the ring stayed visible
           when collapsed.

           ONE element animates: the container's width, with overflow hidden.
           The input is always flex:1 inside and simply gets clipped when
           collapsed, so there's no flex-basis transition to go wrong and no
           second tree to swap in. */
        .sth-libtag { display: flex; align-items: center; flex-shrink: 0;
          height: 32px; width: 32px; padding: 0; border-radius: 8px; overflow: hidden;
          border: none; background: rgba(var(--st-fg-rgb), 0.05);
          color: rgba(var(--st-sub-rgb), 0.62);
          transition: width 0.22s cubic-bezier(0.22, 1, 0.36, 1), padding 0.22s cubic-bezier(0.22, 1, 0.36, 1),
                      background 0.15s ease, color 0.15s ease; }
        .sth-libtag:hover { background: rgba(var(--st-fg-rgb), 0.07); color: var(--st-text); }
        .sth-libtag.is-open { width: 200px; padding: 0 6px 0 9px;
          background: rgba(var(--st-fg-rgb), 0.07); color: var(--st-text); }
        .sth-libtag.is-on { background: rgba(var(--st-acc-rgb), 0.16); }
        /* Scoped to is-open. Unscoped, clicking the icon focused the button and
           that focus survived the collapse, so a closed control kept painting a
           ring — the circle that wouldn't go away. */
        .sth-libtag.is-open:focus-within { box-shadow: inset 0 0 0 1px rgba(var(--st-acc-rgb), 0.45); }
        .sth-libtag-btn { flex: none; width: 30px; height: 30px; padding: 0; border: none;
          background: transparent; color: inherit; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          transition: width 0.22s cubic-bezier(0.22, 1, 0.36, 1); }
        .sth-libtag.is-open .sth-libtag-btn { width: 15px; cursor: text; }
        .sth-libtag-in { flex: 1; min-width: 0; margin-left: 8px; border: none; outline: none;
          background: transparent; opacity: 0; pointer-events: none;
          font: inherit; font-size: 12.5px; font-weight: 500; color: var(--st-text); padding: 0;
          transition: opacity 0.16s ease; }
        .sth-libtag.is-open .sth-libtag-in { opacity: 1; pointer-events: auto; }
        .sth-libtag-in::placeholder { color: rgba(var(--st-fg-rgb), 0.3); font-weight: 500; }
        .sth-libtag-x { width: 17px; height: 17px; flex-shrink: 0; padding: 0; border: none;
          border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center;
          background: rgba(var(--st-fg-rgb), 0.16); color: rgba(var(--st-fg-rgb), 0.75); }
        .sth-libtag-x:hover { background: rgba(var(--st-fg-rgb), 0.3); color: #fff; }
        /* Lighter and one step further from the title. At 650 it was competing
           with a 700 title for the same job; a count is supporting text. */
        .sth-libhead-m { font-size: 12px; font-weight: 500; color: rgba(var(--st-sub-rgb), 0.42);
          white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        /* A dark well rather than a white veil.
           A 5%-white fill over the now-playing wash just tints itself with
           whatever is playing, so the field vanished into a red page and
           glowed on a pale one. Black at low alpha reads as a recess against
           any wash, and the hairline stays white so the edge holds. */
        /* .sth-libhead-s and its input rules went with the filter box.
           The chip above replaces it: same state, no text entry. */
        /* The bar has to survive the now-playing panel taking a third of the
           width. Meta goes first (a count is nice, not needed), then the
           action labels, leaving icons that still work. */
        /* The meta used to be dropped below 1180px because it shared a row
           with the actions and was the first thing to give. On its own tier
           it has the full width to itself and fits at any size the app runs
           at, so hiding it would only be deleting information. */
        @media (max-width: 980px) { .sth-libact-label { display: none; } }

        /* Equaliser — three 2.5px bars, glow, centred. Matches the overlay's
           badge. Animates scaleY (not height) so it composites on the GPU and
           never triggers layout: this can be on screen while a 500-row list is
           being scrolled. transform-origin is centre so it grows both ways and
           stays optically centred in the column. */
        .sth-eq { display: inline-flex; align-items: center; gap: 2.5px; height: 14px; flex-shrink: 0; vertical-align: middle; }
        .sth-eq i { display: block; width: 2.5px; height: 11px; border-radius: 2px; background: currentColor; box-shadow: 0 0 6px currentColor; transform-origin: center; animation: sthEq 0.9s ease infinite; }
        .sth-eq i:nth-child(1) { animation-delay: 0s; }
        .sth-eq i:nth-child(2) { animation-delay: 0.18s; }
        .sth-eq i:nth-child(3) { animation-delay: 0.36s; }
        .sth-eq.is-paused i { animation: none; transform: scaleY(0.36); }
        @keyframes sthEq { 0%, 100% { transform: scaleY(0.36); } 50% { transform: scaleY(1); } }
        .sth-libact { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-radius: 8px; border: none; cursor: pointer; background: transparent; color: rgba(var(--st-sub-rgb), 0.62); font-size: 12.5px; font-weight: 600; font-family: inherit; transition: color 0.15s ease, background 0.15s ease; }
        .sth-libact:hover { color: var(--st-text); background: rgba(var(--st-fg-rgb), 0.07); }
        /* Play all is the primary action; Shuffle is an alternative to it.
           Rendered identically they read as a pair of equals and you have to
           read the labels to tell which is which. A quiet accent tint is
           enough of a difference to skip that step — no size change, so the
           cluster still aligns. */
        .sth-libsortmenu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 40;
          min-width: 176px; padding: 5px; border-radius: 11px;
          background: rgba(22, 22, 24, 0.98); border: 1px solid rgba(var(--st-fg-rgb), 0.11);
          box-shadow: 0 14px 38px rgba(0, 0, 0, 0.5);
          display: flex; flex-direction: column; gap: 1px; }
        .sth-libsortitem { display: block; width: 100%; text-align: left; padding: 8px 11px;
          border: none; border-radius: 7px; cursor: pointer; background: transparent;
          font: inherit; font-size: 12.5px; font-weight: 600; color: rgba(var(--st-fg-rgb), 0.72); }
        .sth-libsortitem:hover { background: rgba(var(--st-fg-rgb), 0.08); color: #fff; }
        .sth-libsortitem.is-on { color: #fff; background: rgba(var(--st-acc-rgb), 0.2); }
        .sth-libsortitem-reset { margin-top: 4px; padding-top: 10px; font-weight: 500;
          color: rgba(var(--st-fg-rgb), 0.5); border-top: 1px solid rgba(var(--st-fg-rgb), 0.08);
          border-radius: 0 0 7px 7px; }
        .sth-libact-primary { color: var(--st-text); background: rgba(var(--st-acc-rgb), 0.16); }
        .sth-libact-primary:hover { background: rgba(var(--st-acc-rgb), 0.26); }
        .sth-plcover-veil { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #fff; background: rgba(0,0,0,0.55); opacity: 0; transition: opacity 0.16s ease; }
        .sth-plcover:hover .sth-plcover-veil { opacity: 1; }


        /* Selectable rows in the left list pane */
        .sth-selrow { display: flex; align-items: center; gap: 8px; padding: 7px 8px; cursor: pointer; border-radius: 10px; transition: background 0.14s ease; text-align: left; border: none; background: transparent; width: 100%; color: inherit; }
        .sth-selrow:hover { background: rgba(var(--st-fg-rgb), 0.05); }
        .sth-selrow.on { background: rgba(var(--st-fg-rgb), 0.09); }
        .sth-selrow .sth-selart { width: 42px; height: 42px; border-radius: 9px; flex-shrink: 0; background-size: cover; background-position: center; box-shadow: 0 0 0 1px rgba(var(--st-fg-rgb), 0.08); position: relative; overflow: hidden; }
        .sth-selrow.round .sth-selart { border-radius: 50%; }
        /* Play button removed from rows — actions live on the right instead.
           The heart persists once set; the others reveal on hover. */
        .sth-rowact { flex-shrink: 0; width: 26px; height: 26px; padding: 0; display: flex; align-items: center; justify-content: center; color: rgba(var(--st-fg-rgb), 0.45); }
        .sth-rowact:hover { color: #fff; }
        .sth-rowact.is-fav { color: rgb(240,90,120); opacity: 1; }
        .sth-hoveract { opacity: 0; pointer-events: none; transition: opacity 0.13s ease; }
        .sth-selrow:hover .sth-hoveract { opacity: 1; pointer-events: auto; }
        .sth-selrow:hover .sth-seltime { display: none; }


        /* Panel actions: icon-only shuffle, filled Play */
        .sth-actbtn { width: 30px; height: 30px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: 9px; border: 1px solid rgba(var(--st-fg-rgb), 0.12); background: rgba(var(--st-fg-rgb), 0.05); color: rgba(var(--st-fg-rgb), 0.72); cursor: pointer; transition: background 0.14s ease, color 0.14s ease, transform 0.1s ease; }
        .sth-actbtn:hover { background: rgba(var(--st-fg-rgb), 0.1); color: #fff; }
        .sth-actbtn:active { transform: scale(0.94); }
        .sth-playbtn { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 14px; flex-shrink: 0; border-radius: 9px; border: none; cursor: pointer; font-size: 11.5px; font-weight: 700; transition: filter 0.14s ease, transform 0.1s ease; }
        .sth-playbtn:hover { filter: brightness(1.1); }
        .sth-playbtn:active { transform: scale(0.96); }

        /* A–Z jump rail */
        .sth-azkey { flex: 1; min-height: 0; padding: 0; border: none; background: transparent; font-size: 8px; font-weight: 700; line-height: 1; transition: color 0.12s ease; }
        .sth-azkey:not(:disabled):hover { color: #fff !important; }

        /* Now Playing transport + volume */
                /* 32, not 26: the bar is 84px tall now and the icons went to 16–17px,
           so the old hit area barely contained them. */
        /* Now-playing title as a copy control. Inherits the bar's text colour
           and carries no button chrome at rest, so it reads as the title it
           replaced until you point at it. */
        .sth-nplink { display: flex; align-items: center; gap: 6px; max-width: 100%; padding: 0; border: none;
          background: none; font: inherit; font-size: 13px; font-weight: 650; color: var(--st-text);
          cursor: pointer; text-align: left; border-radius: 4px; }
        .sth-nplink > span { white-space: nowrap; }
        .sth-nplink:disabled { cursor: default; }
        .sth-nplink:not(:disabled):hover > span { text-decoration: underline; text-underline-offset: 2px; }
        .sth-nplink-ic { flex-shrink: 0; opacity: 0; transition: opacity 0.14s ease; }
        .sth-nplink:hover .sth-nplink-ic, .sth-nplink:focus-visible .sth-nplink-ic { opacity: 0.6; }
        .sth-nplink:focus-visible { outline: 2px solid rgba(var(--st-fg-rgb), 0.5); outline-offset: 3px; }
        .sth-npspin { flex-shrink: 0; width: 10px; height: 10px; border-radius: 50%;
          border: 1.6px solid rgba(var(--st-fg-rgb), 0.25); border-top-color: rgba(var(--st-fg-rgb), 0.8);
          animation: sthSpin 0.7s linear infinite; }
        /* flex-shrink: 0 is load-bearing, not tidiness. These sit in the
           now-playing bar's flex row, and without it a crowded bar squeezes
           them horizontally: the height stays 32px, the width drops, and a
           border-radius:50% box becomes a visible OVAL. Invisible while the
           background is transparent, obvious the moment a toggle goes active
           and paints its accent circle — which is why lyrics-on looked wrong
           and nothing else did. The rule divider beside them already had it. */
        .sth-npbtn { width: 32px; height: 32px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: 50%; border: none; background: transparent; color: rgba(var(--st-fg-rgb), 0.62); cursor: pointer; transition: color 0.14s ease, background 0.14s ease, transform 0.1s ease; }
        /* :hover / :active for .sth-npbtn are defined further down the sheet
           and would win on cascade order regardless — not duplicated here. */
        /* Large transport buttons that flank the artwork in fullscreen. */
        .sth-npside { width: 52px; height: 52px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: 50%; border: none; background: rgba(var(--st-fg-rgb), 0.05); color: rgba(var(--st-fg-rgb), 0.7); cursor: pointer; transition: color 0.14s ease, background 0.14s ease, transform 0.1s ease; }
        .sth-npside:hover { background: rgba(var(--st-fg-rgb), 0.12); color: #fff; }
        .sth-npside:active { transform: scale(0.92); }
        /* Fullscreen transport — a compact centered dock (matches the overlay),
           with the view toggles and exit tucked in the corners. */
        .sth-npfull-bar { position: relative; z-index: 7; padding: 0 32px 26px; display: flex; align-items: center; justify-content: center; }
        .sth-npfull-toggles { position: absolute; bottom: 30px; left: 32px; display: flex; align-items: center; gap: 6px; }
        .sth-npfull-toggles:last-child { left: auto; right: 32px; }
        .sth-npfull-dock { display: grid; grid-template-columns: auto minmax(200px, 300px) auto; align-items: center; gap: 16px; padding: 8px 16px; border-radius: 16px; background: rgba(18,18,20,0.62); backdrop-filter: blur(30px) saturate(1.6); -webkit-backdrop-filter: blur(30px) saturate(1.6); border: 1px solid rgba(var(--st-fg-rgb), 0.1); box-shadow: 0 24px 60px rgba(0,0,0,0.5), inset 0 1px 0 rgba(var(--st-fg-rgb), 0.07); }
        .sth-npfull-transport { display: flex; align-items: center; gap: 4px; }
        .sth-npt-btn { width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; border-radius: 8px; border: none; background: transparent; color: rgba(var(--st-fg-rgb), 0.6); cursor: pointer; padding: 0; transition: color 0.15s ease, transform 0.15s ease; }
        .sth-npt-btn:hover { color: #fff; transform: scale(1.08); }
        .sth-npt-btn:active { transform: scale(0.94); }
        .sth-npt-play { width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 50%; border: none; background: transparent; color: rgba(var(--st-fg-rgb), 0.85); cursor: pointer; padding: 0; transition: color 0.15s ease, transform 0.15s ease; }
        .sth-npt-play:hover { color: #fff; transform: scale(1.08); }
        .sth-npt-play:active { transform: scale(0.95); }
        .sth-npfull-seek { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .sth-npfull-time { font-size: 10px; font-weight: 600; color: rgba(var(--st-fg-rgb), 0.55); font-variant-numeric: tabular-nums; flex-shrink: 0; min-width: 28px; }
        .sth-npfull-time:last-child { text-align: left; }
        .sth-npfull-track { position: relative; flex: 1; height: 12px; display: flex; align-items: center; cursor: pointer; touch-action: none; min-width: 0; }
        .sth-npfull-track::before { content: ''; position: absolute; left: 0; right: 0; height: 3px; border-radius: 2px; background: rgba(var(--st-fg-rgb), 0.16); transition: height 0.12s ease; }
        .sth-npfull-track:hover::before, .sth-npfull-track:focus-visible::before { height: 5px; }
        .sth-npfull-fill { position: absolute; left: 0; height: 3px; border-radius: 2px; z-index: 1; transition: width 0.25s linear, height 0.12s ease; }
        .sth-npfull-track:hover .sth-npfull-fill, .sth-npfull-track:focus-visible .sth-npfull-fill { height: 5px; }
        .sth-npfull-knob { position: absolute; right: -5px; top: 50%; transform: translateY(-50%); width: 11px; height: 11px; border-radius: 50%; box-shadow: 0 1px 5px rgba(0,0,0,0.5); opacity: 0; transition: opacity 0.12s ease; }
        .sth-npfull-track:hover .sth-npfull-knob, .sth-npfull-track:focus-visible .sth-npfull-knob { opacity: 1; }
        .sth-npfull-vol { display: flex; align-items: center; justify-content: flex-end; }
        /* Credits/Up-next dock cards float just above the transport bar. */
        .sth-npfull-dockrow { position: absolute; left: 0; right: 0; bottom: 0; display: flex; justify-content: center; pointer-events: none; z-index: 6; }
        .sth-npfull-dockwrap { width: min(620px, 88vw); position: relative; height: 0; pointer-events: auto; }
        /* Fullscreen credits — accent-bordered cards in a centered grid. */
        .sth-fscredit-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 24px; align-content: center; height: 100%; overflow-y: auto; padding: 10px 14px; }
        .sth-fscredit { min-width: 0; padding: 3px 0 3px 13px; opacity: 0; animation: sthCreditIn 0.4s cubic-bezier(0.22, 1, 0.3, 1) both; }
        @keyframes sthCreditIn { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: translateX(0); } }
        @media (prefers-reduced-motion: reduce) { .sth-fscredit { animation-duration: 0.01ms; } }
        .sth-fscredit-label { font-size: 9.5px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(var(--st-fg-rgb), 0.42); margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sth-fscredit-names { font-size: 15px; font-weight: 500; color: rgba(var(--st-fg-rgb), 0.9); line-height: 1.45; }
        .sth-fscredit-state { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 10px; height: 100%; color: rgba(var(--st-fg-rgb), 0.4); }
        /* Fullscreen library list. */
        .sth-fslib { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 0 6px; }
        .sth-fslib-head { flex-shrink: 0; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(var(--st-fg-rgb), 0.5); padding: 2px 10px 12px; display: flex; align-items: baseline; gap: 8px; }
        .sth-fslib-head span { font-size: 11px; font-weight: 600; letter-spacing: 0; color: rgba(var(--st-fg-rgb), 0.32); }
        .sth-fslib-list { flex: 1; min-height: 0; overflow-y: auto; }
        .sth-fslib-row { display: flex; align-items: center; gap: 11px; width: 100%; padding: 7px 10px; border: none; background: transparent; border-radius: 10px; cursor: pointer; transition: background 0.13s ease; }
        .sth-fslib-row:hover { background: rgba(var(--st-fg-rgb), 0.06); }
        .sth-fslib-row.is-active { background: rgba(var(--st-fg-rgb), 0.05); }
        .sth-fslib-art { width: 38px; height: 38px; border-radius: 7px; flex-shrink: 0; position: relative; box-shadow: 0 0 0 1px rgba(var(--st-fg-rgb), 0.08); display: flex; align-items: center; justify-content: center; }
        .sth-fslib-title { display: block; font-size: 13.5px; font-weight: 600; color: rgba(var(--st-fg-rgb), 0.92); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sth-fslib-sub { display: block; font-size: 11px; color: rgba(var(--st-fg-rgb), 0.44); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
        .sth-fslib-eq { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 2px; background: rgba(0,0,0,0.42); border-radius: 7px; }
        .sth-fslib-eq i { width: 2.5px; height: 8px; background: currentColor; border-radius: 1px; animation: sthEqBar 0.9s ease-in-out infinite; }
        .sth-fslib-eq i:nth-child(2) { animation-delay: 0.3s; height: 12px; }
        .sth-fslib-eq i:nth-child(3) { animation-delay: 0.15s; }
        @keyframes sthEqBar { 0%, 100% { transform: scaleY(0.5); } 50% { transform: scaleY(1); } }
        /* Add-lyrics UI (shown when a track has no lyrics). */
        .sth-lyrics-pane { position: relative; height: 100%; min-height: 0; display: flex; flex-direction: column; animation: sthLyricsFadeIn 0.4s ease both; }
        @keyframes sthLyricsFadeIn { from { opacity: 0; } to { opacity: 1; } }
        .sth-lyrics-pane > * { flex: 1; min-height: 0; }
        .sth-lyrics-editor { height: 100%; min-height: 0; display: flex; flex-direction: column; animation: sthCreditIn 0.35s cubic-bezier(0.22,1,0.3,1) both; }
        .sth-lyrtools { position: absolute; top: 6px; right: 6px; z-index: 3; display: flex; gap: 6px; opacity: 0; transform: translateY(-4px); transition: opacity 0.16s ease, transform 0.16s ease; }
        .sth-lyrics-pane:hover .sth-lyrtools { opacity: 1; transform: translateY(0); }
        .sth-lyrtool { width: 28px; height: 28px; border-radius: 8px; padding: 0; border: 1px solid rgba(var(--st-fg-rgb), 0.08); cursor: pointer; background: rgba(0,0,0,0.45); color: rgba(var(--st-fg-rgb), 0.75); display: flex; align-items: center; justify-content: center; transition: background 0.15s ease, color 0.15s ease; }
        .sth-lyrtool:hover { background: rgba(0,0,0,0.7); color: #fff; }
        .sth-lyrics-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; height: 100%; padding: 20px; text-align: center; }
        .sth-lyrics-btn { padding: 9px 18px; border-radius: 10px; border: none; cursor: pointer; font-size: 12.5px; font-weight: 700; transition: filter 0.14s ease, transform 0.1s ease; }
        .sth-lyrics-btn:hover { filter: brightness(1.08); }
        .sth-lyrics-btn:active { transform: scale(0.97); }
        .sth-lyrics-btn.ghost { background: rgba(var(--st-fg-rgb), 0.08); color: rgba(var(--st-fg-rgb), 0.8); }
        .sth-lyrics-btn.ghost:hover { background: rgba(var(--st-fg-rgb), 0.14); filter: none; }
        .sth-lyrics-add { display: flex; flex-direction: column; gap: 10px; width: 100%; max-width: 460px; }
        .sth-lyrics-ta { width: 100%; box-sizing: border-box; height: 44vh; max-height: 360px; resize: none; border-radius: 12px; background: rgba(var(--st-fg-rgb), 0.05); border: 1px solid rgba(var(--st-fg-rgb), 0.12); color: #fff; font-size: 13.5px; line-height: 1.6; padding: 14px 16px; outline: none; font-family: inherit; transition: border-color 0.15s ease; }
        .sth-lyrics-ta:focus { border-color: rgba(var(--st-fg-rgb), 0.24); background: rgba(var(--st-fg-rgb), 0.07); }
        .sth-npbtn:hover { color: #fff; background: rgba(var(--st-fg-rgb), 0.08); }
        .sth-npbtn:active { transform: scale(0.92); }
        /* Divider between the song actions and the view toggles. Inset top
           and bottom so it's shorter than the buttons either side — a rule
           the same height as its neighbours reads as a wall between two
           toolbars rather than a seam inside one. */
        .sth-npbtn-rule { width: 1px; height: 18px; flex-shrink: 0; margin: 0 5px; background: rgba(var(--st-fg-rgb), 0.14); border-radius: 1px; }
        /* Playlist picker rows. Hover and selection are CSS rather than
           inline styles written from JS handlers — the sheet re-renders on
           every tick, and inline hover state gets wiped on each pass. */
        .sth-plpick { width: 100%; display: flex; align-items: center; gap: 9px; padding: 6px 7px; border-radius: 9px; border: none; background: transparent; color: inherit; text-align: left; cursor: pointer; font-family: inherit; transition: background 0.13s ease; }
        .sth-plpick:hover { background: rgba(var(--st-fg-rgb), 0.06); }
        .sth-plpick.is-editing { cursor: default; }
        .sth-plpick.is-editing:hover { background: transparent; }
        .sth-plpick-art { width: 32px; height: 32px; border-radius: 5px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: rgba(var(--st-fg-rgb), 0.08); color: var(--st-text); overflow: hidden; }
        .sth-plpick-art.is-new { background: transparent; border: 1px dashed rgba(var(--st-fg-rgb), 0.22); }
        .sth-plpick-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
        .sth-plpick-name { font-size: 12px; font-weight: 600; color: var(--st-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sth-plpick-sub { font-size: 10px; color: rgba(var(--st-sub-rgb), 0.45); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        /* The pending-change note rides the accent so it reads as a
           consequence of the tick rather than more metadata. */
        .sth-plpick-sub em { font-style: normal; font-weight: 650; color: rgb(var(--pl-acc, 255, 255, 255)); }
        /* A square, not a circle. Circles are for one-of-many; this is
           several independent yes/nos, and the shape should say so. */
        .sth-plpick-box { width: 18px; height: 18px; border-radius: 5px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border: 1.5px solid rgba(var(--st-fg-rgb), 0.22); color: transparent; transition: background 0.13s ease, border-color 0.13s ease, color 0.13s ease; }
        .sth-plpick.is-on .sth-plpick-box { background: rgb(var(--pl-acc, 255, 255, 255)); border-color: rgb(var(--pl-acc, 255, 255, 255)); color: var(--pl-acc-fg, #000); }
        .sth-plpick:hover .sth-plpick-box { border-color: rgba(var(--st-fg-rgb), 0.4); }
        .sth-plpick.is-on:hover .sth-plpick-box { border-color: rgb(var(--pl-acc, 255, 255, 255)); }
        /* Click-to-play cover: the veil only appears on hover, so at rest the
           artwork is completely unobstructed. */
        .sth-npcover-veil { opacity: 0; transition: opacity 0.16s ease; }
        .sth-npcover:hover .sth-npcover-veil { opacity: 1; }
        .sth-npcover:focus-visible .sth-npcover-veil { opacity: 1; }
        .sth-npcover:active { transform: scale(0.985); }
        .sth-npcover { transition: transform 0.12s ease; outline: none; }
        .sth-npmute { width: 24px; height: 24px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: 7px; border: none; background: transparent; color: rgba(var(--st-fg-rgb), 0.5); cursor: pointer; transition: color 0.14s ease, background 0.14s ease; }
        .sth-npmute:hover { color: #fff; background: rgba(var(--st-fg-rgb), 0.08); }
        .sth-npmute.is-on { color: #fff; background: rgba(var(--st-fg-rgb), 0.14); }
        /* Fullscreen Now Playing overlay (portaled to body) — covers the app
           content and nav rail, but sits BELOW the window controls and drag
           strip (z99/z101 in App) so they stay clickable. */
        .sth-npfull { position: fixed; inset: 0; z-index: 40; display: flex; background: #0a0a0c; animation: sthNpFullIn 0.34s cubic-bezier(0.22, 1, 0.3, 1) both; }
        .sth-npfull > .sth-libpanel { flex: 1; border-radius: 0; border: none; animation: none; }
        @keyframes sthNpFullIn { from { opacity: 0; } to { opacity: 1; } }
        /* Now Playing stage — artwork column, and a lyrics column that grows in
           beside it (expanded mode). flex-basis + opacity transitions carry the
           whole thing: the artwork slides left as the lyrics take their space. */
        /* Geometry matched 1:1 to the overlay's fullscreen stage (side-lyrics
           mode) so the command center and its cover flight port across
           without re-deriving anything.

           The overlay sizes the pair off the VIEWPORT, not off percentages of
           a padded container: cover is min(52vh, 42vw) square, the lyrics
           column is min(36vw, 460px) wide at exactly the cover's height, and
           the two are centered as a unit with a clamp(20px, 3.5vw, 56px) gap.
           Percentage flex-basis inside a 6vw-padded row gave a different
           cover size at every window width, which is why the two surfaces
           never quite matched. */
        .sth-np-stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; gap: 0; padding: 0; max-width: 100vw; }
        .sth-np-stage.has-lyrics { gap: clamp(20px, 3.5vw, 56px); }
        .sth-np-artcol { flex: 0 0 auto; min-width: 0; min-height: 0; }
        /* No lyrics: the overlay lets the cover breathe wider. */
        /* ONE cover size, always. The overlay grows its cover when lyrics are
           off (58vh/46vw vs 52vh/42vw) but that means toggling lyrics resizes
           the artwork under you, and the command center — which takes over
           this exact square — would resize with it. Fixed at the with-lyrics
           size so the square is stable no matter what's toggled. */
        .sth-np-artcol .sth-np-cover { width: min(52vh, 42vw); }
        .sth-np-lyriccol { flex: 0 0 auto; width: 0; min-width: 0; overflow: hidden; opacity: 0; display: flex; flex-direction: column; align-self: center; height: min(52vh, 42vw); transition: width 0.45s cubic-bezier(0.22, 1, 0.3, 1), opacity 0.4s ease; }
        .sth-np-stage.has-lyrics .sth-np-lyriccol { width: min(36vw, 460px); opacity: 1; }
        /* Only the lyrics body flexes. This used to be a bare child selector, which also hit
           the mini-header slot and stretched it from 88px to fill the column —
           pushing the lyrics far down the screen. */
        .sth-np-lyriccol > .sth-np-lyricbody { flex: 1; min-height: 0; }
        .sth-np-lyriccol > .sth-np-minislot { flex: 0 0 auto; }
        @media (prefers-reduced-motion: reduce) { .sth-np-artcol, .sth-np-lyriccol { transition-duration: 0.01ms; } }
        .sth-spinner { width: 22px; height: 22px; border-radius: 50%; border: 2px solid rgba(var(--st-fg-rgb), 0.14); border-top-color: #fff; animation: sthSpin 0.7s linear infinite; }
        @keyframes sthSpin { to { transform: rotate(360deg); } }
        .sth-vol { -webkit-appearance: none; appearance: none; height: 3px; border-radius: 2px; outline: none; cursor: pointer; }
        .sth-vol::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 11px; height: 11px; border-radius: 50%; background: #fff; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.5); transition: transform 0.12s ease; }
        .sth-vol:hover::-webkit-slider-thumb { transform: scale(1.15); }

        /* Detail-pane track rows (compact, numbered) */
        .sth-drow { display: grid; grid-template-columns: 26px minmax(0,1fr) 46px 30px; gap: 12px; align-items: center; padding: 8px 14px; cursor: pointer; border-radius: 8px; transition: background 0.14s ease; }
        .sth-drow:hover { background: rgba(var(--st-fg-rgb), 0.045); }
        .sth-drow.is-active { background: rgba(var(--st-fg-rgb), 0.06); }
        .sth-drow:hover .sth-drow-more { opacity: 1; }
        .sth-drow-more { opacity: 0; transition: opacity 0.14s ease; display: flex; justify-content: flex-end; }
        .sth-drow .sth-dnum { display: inline; }
        .sth-drow .sth-dplay { display: none; }
        .sth-drow:hover .sth-dnum { display: none; }
        .sth-drow:hover .sth-dplay { display: inline; }
        .sth-explicit { display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; border-radius: 3px; background: rgba(var(--st-fg-rgb), 0.28); color: #000; font-size: 8.5px; font-weight: 800; flex-shrink: 0; }
        .sth-alb:hover .sth-albimg { filter: saturate(1.04); }
        .sth-albplay { position: absolute; bottom: 9px; right: 9px; width: 34px; height: 34px; border-radius: 10px; border: 1px solid rgba(var(--st-fg-rgb), 0.25); cursor: pointer; background: rgba(0,0,0,0.78); color: #fff; display: flex; align-items: center; justify-content: center; opacity: 0; transform: translateY(5px); transition: opacity 0.18s ease, transform 0.18s ease, background 0.15s ease; }
        .sth-alb:hover .sth-albplay { opacity: 1; transform: translateY(0); }
        .sth-albplay:hover { background: rgba(0,0,0,0.85); }
        /* --- redesign: hero band (discover feature + library collection) --- */
        /* --- redesign: discover release cards --- */
        /* ---- Library table ----
           One grid template shared by the header and every row, so the columns
           can't drift apart — the header is a row with different styling
           rather than a separate layout. */
        /* Fixed 56px for duration, not 64 with a min-content squeeze: at
           narrow widths the grid was shrinking that track and clipping "3:52"
           to "3". A fixed column can't be compressed by its neighbours. */
        /* height is FIXED, not derived from content: the virtualiser converts
           scrollTop to a row index by division, so a variable row height would
           make the window drift out of sync with the scrollbar. */
        .sth-lrow { display: grid; grid-template-columns: 44px minmax(160px, 2.2fr) minmax(110px, 1.4fr) minmax(110px, 1.6fr) 108px 56px 40px; align-items: center; gap: 12px; padding: 6px 8px; border-radius: 8px; height: 50px; box-sizing: border-box; }
        /* Shed columns as the TABLE narrows (container query, not viewport):
           the side panel takes 372px out of this column while the window stays
           the same size, so a media query would never fire. Album goes first,
           then Date added — the two you can infer from context. */
        .sth-ltable { container-type: inline-size; }
        @container (max-width: 720px) {
          .sth-lrow { grid-template-columns: 44px minmax(150px, 2.4fr) minmax(110px, 1.5fr) 108px 56px 40px; }
          .sth-lrow > .sth-lcol-album { display: none; }
        }
        @container (max-width: 560px) {
          .sth-lrow { grid-template-columns: 44px minmax(140px, 1fr) minmax(100px, 1fr) 56px 40px; }
          .sth-lrow > .sth-lcol-date { display: none; }
        }

        /* Date added hidden by preference (Settings → Library).
           The COLUMN TRACK has to go, not just the cell: display:none on the
           child leaves its 108px track in the template, so the row keeps a
           hole where the dates were and everything stays put. Dropping the
           track lets Title/Artist/Album absorb the width, which is the point
           of hiding it. Same technique the container queries above use.
           Written as its own rule after them so it wins at any width. */
        .sth-ltable.no-date .sth-lrow { grid-template-columns: 44px minmax(160px, 2.2fr) minmax(110px, 1.4fr) minmax(110px, 1.8fr) 56px 40px; }
        .sth-ltable.no-date .sth-lrow > .sth-lcol-date { display: none; }
        @container (max-width: 720px) {
          .sth-ltable.no-date .sth-lrow { grid-template-columns: 44px minmax(150px, 2.4fr) minmax(110px, 1.5fr) 56px 40px; }
        }
        @container (max-width: 560px) {
          .sth-ltable.no-date .sth-lrow { grid-template-columns: 44px minmax(140px, 1fr) minmax(100px, 1fr) 56px 40px; }
        }
        /* Right padding = row padding + the reserved scrollbar gutter. See
           the .sth-libscroll block above for why. */
        /* height: 28px, because this shares .sth-lrow with the data rows and
           was inheriting their 50px — a 12px label sitting in a 50px box, plus
           10px padding and a 6px margin, for a ~66px band of mostly nothing
           between the title and the first song. Labels don't need a track
           height; only rows with 38px artwork in them do. */
        .sth-lrow-head { height: 28px; padding: 0 calc(8px + var(--lib-sbw, 0px)) 8px 8px; font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: rgba(var(--st-fg-rgb), 0.32); border-bottom: 1px solid rgba(var(--st-fg-rgb), 0.06); margin-bottom: 4px; position: sticky; top: 0; z-index: 1; }
        /* The header already reserves the scrollbar's width so its columns
           line up with the rows beneath. The rail takes another 16px out of
           the same row width, so the header has to account for that too or
           every column heading drifts left of its data. */
        .sth-ltable.has-az .sth-lrow-head { padding-right: calc(8px + var(--lib-sbw, 0px) + 16px); }
        .sth-lrow:not(.sth-lrow-head):hover { background: rgba(var(--st-fg-rgb), 0.05); }
        .sth-lrow.is-playing { background: rgba(var(--st-fg-rgb), 0.04); }
        /* Cell links. Underline on hover only — a permanently underlined
           album column would read as a page full of links and compete with
           the title for attention. Inherits colour so it sits in the row
           rather than on top of it. */
        .sth-lcell-link { display: block; width: 100%; text-align: left; padding: 0; border: none; background: none;
          font: inherit; color: inherit; cursor: pointer; min-width: 0;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          transition: color 0.12s ease; }
        .sth-lcell-link:hover { color: rgba(var(--st-fg-rgb), 0.95); text-decoration: underline; text-underline-offset: 2px; }
        .sth-lcell-link:focus-visible { outline: 2px solid rgba(var(--st-fg-rgb), 0.4); outline-offset: 2px; border-radius: 3px; }

        /* A–Z rail. A flex column beside the scroll area — NOT absolute, and
           not overlapping the scrollbar, which is what put the letters on top
           of it. justify-content is flex-start with each letter flexing, so
           the strip fills the list's height exactly rather than floating
           centred in a taller box. */
        .sth-azrail { flex-shrink: 0; width: 16px; padding: 2px 0 6px;
          display: flex; flex-direction: column;
          user-select: none; }
        .sth-azrail button { flex: 1; min-height: 0; padding: 0; border: none; background: transparent;
          font-size: 8.5px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums;
          transition: color 0.1s ease, transform 0.1s ease; }
        .sth-azrail button.has { color: rgba(var(--st-fg-rgb), 0.5); cursor: pointer; }
        .sth-azrail button.no { color: rgba(var(--st-fg-rgb), 0.14); cursor: default; }
        .sth-azrail button.has:hover { color: rgb(var(--st-fg-rgb)); transform: scale(1.35); }
        .sth-lrow-dim { font-size: 13.5px; color: rgba(var(--st-fg-rgb), 0.5); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        /* LEFT, not centre. The header "#" is left-aligned in this track, so
           centring the numbers under it put every row a few px right of its
           own label — the wider the track, the more obviously off. Aligning
           both to the same edge is what makes the column read as a column.
           justify-content:flex-start rather than text-align because this is a
           flex row (the number and the hover play button share the cell). */
        .sth-lrow-n { position: relative; display: flex; align-items: center; justify-content: flex-start; height: 38px; }
        .sth-lrow-num { font-size: 12px; color: rgba(var(--st-fg-rgb), 0.35); font-variant-numeric: tabular-nums; }
        /* The play button replaces the index on hover rather than sitting
           beside it, so the column stays 44px wide either way. */
        /* Left, matching .sth-lrow-n. The old inset:0 + margin:auto centred it in
           the track, which was right while the number was centred too — now
           the number sits left, so a centred button would make the two swap
           places the instant the pointer arrives. Pinned left, centred only
           vertically. */
        .sth-lrow-play { position: absolute; left: -6px; top: 0; bottom: 0; margin: auto 0; width: 26px; height: 26px; border-radius: 50%; border: none; background: transparent; color: #fff; cursor: pointer; display: none; align-items: center; justify-content: center; }
        /* Hover hides whatever occupies the index slot — number OR equaliser —
           so the play button can take its place. Without the .sth-eq rule the
           bars stayed put and the button appeared on top of them. */
        .sth-lrow:hover .sth-lrow-num, .sth-lrow:hover .sth-eq { opacity: 0; }
        .sth-lrow:hover .sth-lrow-play { display: flex; }
        .sth-lrow-more { width: 28px; height: 28px; border-radius: 7px; border: none; background: transparent; color: rgba(var(--st-fg-rgb), 0.4); cursor: pointer; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.14s ease, color 0.14s ease; }
        .sth-lrow:hover .sth-lrow-more { opacity: 1; }
        .sth-lrow-more:hover { color: #fff; background: rgba(var(--st-fg-rgb), 0.08); }
        .sth-homerow::-webkit-scrollbar { display: none; }
        /* Discover section headers — accent rule + source eyebrow + title. */
        .sth-dsc-head { position: relative; display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin: 26px 0 16px; padding-left: 15px; }
        .sth-dsc-head::before { content: ''; position: absolute; left: 0; top: 3px; bottom: 3px; width: 3px; border-radius: 2px; background: linear-gradient(rgba(var(--st-fg-rgb), 0.34), rgba(var(--st-fg-rgb), 0.05)); }
        .sth-dsc-eyebrow { font-size: 9.5px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; }
        .sth-dsc-title { font-size: 20px; font-weight: 600; letter-spacing: -0.012em; color: #fff; margin-top: 4px; }
        .sth-dsc-meta { font-size: 11px; color: rgba(var(--st-fg-rgb), 0.4); flex-shrink: 0; padding-bottom: 3px; white-space: nowrap; }
        .sth-relbadge { position: absolute; top: 9px; left: 9px; padding: 3px 9px; border-radius: 999px; font-size: 9.5px; font-weight: 700; letter-spacing: 0.03em; color: #fff; background: rgba(0,0,0,0.52); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border: 1px solid rgba(var(--st-fg-rgb), 0.16); }
        /* --- redesign: detail drawer (release tracklist) --- */
        /* Inline release expansion — height animated in JS (ReleaseExpansion).
           The bottom breathing space lives in the padding wrapper so it's part
           of the measured height, and clips to nothing when collapsed. */
        .sth-relexp { grid-column: 1 / -1; }
        .sth-relexp-pad { padding-bottom: 26px; }
        .sth-relexp-inner { border-radius: 16px; background: rgba(var(--st-fg-rgb), 0.028); border: 1px solid rgba(var(--st-fg-rgb), 0.08); }
        .sth-relexp-head { display: flex; align-items: center; gap: 15px; padding: 15px 16px; }
        .sth-relexp-art { width: 62px; height: 62px; border-radius: 11px; flex-shrink: 0; box-shadow: inset 0 1px 0 rgba(var(--st-fg-rgb), 0.16), 0 0 0 1px rgba(var(--st-fg-rgb), 0.08); }
        .sth-relexp-eyebrow { font-size: 9px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; }
        .sth-relexp-title { font-size: 16px; font-weight: 650; letter-spacing: -0.01em; color: #fff; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sth-relexp-sub { font-size: 11.5px; color: rgba(var(--st-fg-rgb), 0.5); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sth-relexp-actions { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
        .sth-relexp-getall { display: inline-flex; align-items: center; gap: 7px; padding: 8px 15px; border-radius: 10px; border: none; cursor: pointer; font-size: 12px; font-weight: 700; white-space: nowrap; transition: filter 0.14s ease, transform 0.1s ease; }
        .sth-relexp-getall:hover { filter: brightness(1.08); }
        .sth-relexp-getall:active { transform: scale(0.97); }
        .sth-relexp-have { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: rgb(140,255,185); white-space: nowrap; }
        .sth-relexp-close { width: 30px; height: 30px; flex-shrink: 0; border-radius: 9px; border: 1px solid rgba(var(--st-fg-rgb), 0.12); cursor: pointer; background: rgba(var(--st-fg-rgb), 0.05); color: rgba(var(--st-fg-rgb), 0.65); display: flex; align-items: center; justify-content: center; padding: 0; transition: background 0.14s ease, color 0.14s ease; }
        .sth-relexp-close:hover { background: rgba(var(--st-fg-rgb), 0.1); color: #fff; }
        .sth-relexp-tracks { border-top: 1px solid rgba(var(--st-fg-rgb), 0.06); padding: 8px 10px 10px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px 24px; }
        @media (max-width: 1040px) { .sth-relexp-tracks { grid-template-columns: 1fr; } }
        .sth-relexp-state { grid-column: 1 / -1; padding: 18px 12px; font-size: 12.5px; color: rgba(var(--st-fg-rgb), 0.45); }
        /* --- redesign: chart song grid --- */
        .sth-songgrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 28px; margin-bottom: 26px; }
        .sth-chartrow { display: flex; align-items: center; gap: 14px; padding: 8px 12px 8px 6px; border-radius: 12px; transition: background 0.14s ease; }
        .sth-chartrow:hover { background: rgba(var(--st-fg-rgb), 0.055); }
        .sth-chartrank { width: 30px; flex-shrink: 0; text-align: center; font-variant-numeric: tabular-nums; font-weight: 600; font-size: 14px; color: rgba(var(--st-fg-rgb), 0.28); }
        .sth-chartrank.top { font-size: 20px; font-weight: 700; }
        @media (max-width: 1040px) { .sth-songgrid { grid-template-columns: 1fr; } }
        /* --- redesign: library collection hero + control bar --- */
        .sth-libhero { position: relative; display: flex; align-items: center; gap: 24px; padding: 28px 30px; border-radius: 24px; margin-bottom: 24px; overflow: hidden; border: 1px solid rgba(var(--st-fg-rgb), 0.09); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); background: rgba(var(--st-fg-rgb), 0.04); animation: stFadeUp 0.5s cubic-bezier(0.2,0.9,0.3,1) both; }
        .sth-libbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 18px; }
        .sth-pill { display: inline-flex; align-items: center; gap: 8px; padding: 9px 18px; border-radius: 11px; border: none; cursor: pointer; font-size: 12px; font-weight: 700; letter-spacing: 0.01em; transition: transform 0.12s ease, filter 0.16s ease, background 0.16s ease; }
        .sth-pill:hover { filter: brightness(1.08); }
        .sth-pill:active { transform: scale(0.97); }
        .sth-fan { position: relative; flex-shrink: 0; width: 208px; height: 132px; }
        .sth-fancard { position: absolute; top: 50%; width: 116px; height: 116px; border-radius: 15px; background-size: cover; background-position: center; box-shadow: 0 0 0 1px rgba(var(--st-fg-rgb), 0.12), 0 20px 44px rgba(0,0,0,0.6); transform: translateY(-50%) rotate(var(--r, 0deg)); transition: transform 0.45s cubic-bezier(0.2,0.9,0.3,1); }
        .sth-libhero:hover .sth-fancard { transform: translateY(-50%) rotate(var(--r, 0deg)) translate(var(--sx, 0px), var(--sy, 0px)); }
        .sth-statgrid { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 16px; align-items: start; }
        .sth-hscroll { scrollbar-width: thin; scrollbar-color: rgba(var(--st-fg-rgb), 0.14) transparent; }
        .sth-hscroll::-webkit-scrollbar { height: 5px; }
        .sth-hscroll::-webkit-scrollbar-track { background: transparent; }
        .sth-hscroll::-webkit-scrollbar-thumb { background: rgba(var(--st-fg-rgb), 0.14); border-radius: 999px; }
        .sth-hscroll::-webkit-scrollbar-thumb:hover { background: rgba(var(--st-fg-rgb), 0.24); }
        .sth-vscroll { scrollbar-width: thin; scrollbar-color: rgba(var(--st-fg-rgb), 0.14) transparent; }
        .sth-vscroll::-webkit-scrollbar { width: 5px; }
        .sth-vscroll::-webkit-scrollbar-track { background: transparent; }
        .sth-vscroll::-webkit-scrollbar-thumb { background: rgba(var(--st-fg-rgb), 0.14); border-radius: 999px; }
        .sth-vscroll::-webkit-scrollbar-thumb:hover { background: rgba(var(--st-fg-rgb), 0.24); }
        /* Album detail panel entrance — slides in from the right, settling at
           transform: none so panel text stays crisp (no lingering GPU layer). */
        @keyframes sthPanelIn { from { opacity: 0; transform: translateX(18px); } to { opacity: 1; transform: none; } }
        /* Rows inside the panel's scroller slide in HORIZONTALLY: a vertical
           slide temporarily extends the scrollable area and flashes the
           scrollbar; sideways overflow is simply clipped (overflowX hidden). */
        @keyframes sthRowIn { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: none; } }

        /* ---- Now Playing swap transitions ----
           STRICTLY transform + opacity. Both are composited on the GPU, so
           these never trigger layout or paint. (The previous version animated
           filter: blur(), which forces a full repaint every frame — that was
           the lag.) translate3d pins each element to its own layer.

           New character: the text slides sideways (out to the left, in from
           the right) while the artwork cross-dissolves with a gentle scale —
           crisp and directional on the small type, calm on the big element. */
        @keyframes sthNpTxtOut { 0% { opacity: 1; transform: translate3d(0,0,0); } 100% { opacity: 0; transform: translate3d(-22px,0,0); } }
        @keyframes sthNpTxtIn  { 0% { opacity: 0; transform: translate3d(22px,0,0); } 100% { opacity: 1; transform: translate3d(0,0,0); } }
        @keyframes sthCoverZoomIn { 0% { opacity: 0; } 100% { opacity: 1; } }
        @keyframes sthNpArtOut { 0% { opacity: 1; transform: scale3d(1,1,1); } 100% { opacity: 0; transform: scale3d(0.94,0.94,1); } }
        @keyframes sthNpArtIn  { 0% { opacity: 0; transform: scale3d(1.05,1.05,1); } 100% { opacity: 1; transform: scale3d(1,1,1); } }
        @keyframes sthNpMetaIn { 0% { opacity: 0; transform: translate3d(0,7px,0); } 100% { opacity: 1; transform: translate3d(0,0,0); } }
        @media (prefers-reduced-motion: reduce) {
          .sth-np-art, .sth-np-ghost, .sth-np-line, .sth-np-meta { animation: none !important; }
        }

        /* ---- Library scroll performance ----
           content-visibility lets Chromium skip layout AND paint for tiles
           that are off-screen, which is what keeps the album grid and artist
           list cheap without hand-rolling grid virtualisation. The
           intrinsic-size hint stops the scrollbar jumping as tiles resolve. */
        .sth-albcell { content-visibility: auto; contain-intrinsic-size: auto 180px; }
        .sth-artcell { content-visibility: auto; contain-intrinsic-size: auto 56px; }
        .sth-findtile { transition: transform 0.18s ease; }
        .sth-findtile:hover { transform: translateY(-3px); }
        .sth-findtile:active { transform: translateY(-1px); }
        /* Manage follows — solid panel, search, artist cards. */
        .sth-fm { background: rgba(16,16,18,0.96); border: 1px solid rgba(var(--st-fg-rgb), 0.08); border-radius: 18px; padding: 18px 20px 20px; margin-bottom: 26px; animation: stFadeUp 0.28s cubic-bezier(0.2,0.9,0.3,1) both; }
        .sth-fm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 15px; }
        .sth-fm-title { font-size: 15px; font-weight: 650; color: #fff; letter-spacing: -0.01em; }
        .sth-fm-sub { font-size: 11px; color: rgba(var(--st-fg-rgb), 0.42); margin-top: 3px; line-height: 1.4; }
        .sth-fm-count { flex-shrink: 0; font-size: 10.5px; font-weight: 600; color: rgba(var(--st-fg-rgb), 0.55); background: rgba(var(--st-fg-rgb), 0.06); border: 1px solid rgba(var(--st-fg-rgb), 0.09); border-radius: 999px; padding: 4px 11px; white-space: nowrap; }
        .sth-fm-search { position: relative; }
        .sth-fm-search > svg { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); pointer-events: none; }
        .sth-fm-search input { width: 100%; box-sizing: border-box; padding: 11px 38px 11px 40px; border-radius: 12px; background: rgba(var(--st-fg-rgb), 0.05); border: 1px solid rgba(var(--st-fg-rgb), 0.1); color: #fff; font-size: 13px; outline: none; transition: border-color 0.15s ease, background 0.15s ease; }
        .sth-fm-search input:focus { border-color: rgba(var(--st-fg-rgb), 0.22); background: rgba(var(--st-fg-rgb), 0.07); }
        .sth-fm-clear { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); width: 22px; height: 22px; border-radius: 6px; border: none; cursor: pointer; background: rgba(var(--st-fg-rgb), 0.08); color: rgba(var(--st-fg-rgb), 0.55); display: flex; align-items: center; justify-content: center; padding: 0; transition: background 0.14s ease, color 0.14s ease; }
        .sth-fm-clear:hover { background: rgba(var(--st-fg-rgb), 0.14); color: #fff; }
        .sth-fm-res { margin-top: 10px; border-radius: 13px; border: 1px solid rgba(var(--st-fg-rgb), 0.08); background: rgba(var(--st-fg-rgb), 0.022); overflow: hidden; }
        .sth-fm-resrow { display: flex; align-items: center; gap: 12px; padding: 10px 12px; transition: background 0.14s ease; }
        .sth-fm-resrow:hover { background: rgba(var(--st-fg-rgb), 0.05); }
        .sth-fm-resrow + .sth-fm-resrow { border-top: 1px solid rgba(var(--st-fg-rgb), 0.05); }
        .sth-fm-note { padding: 9px 13px; font-size: 10px; color: rgba(var(--st-fg-rgb), 0.35); line-height: 1.5; border-top: 1px solid rgba(var(--st-fg-rgb), 0.05); background: rgba(var(--st-fg-rgb), 0.015); }
        .sth-fm-divider { height: 1px; background: rgba(var(--st-fg-rgb), 0.06); margin: 20px 0; }
        .sth-fm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(176px, 1fr)); gap: 10px; }
        .sth-fm-card { position: relative; display: flex; align-items: center; gap: 11px; padding: 10px 11px; border-radius: 13px; background: rgba(var(--st-fg-rgb), 0.04); border: 1px solid rgba(var(--st-fg-rgb), 0.07); min-width: 0; transition: background 0.15s ease, border-color 0.15s ease, transform 0.12s ease; }
        .sth-fm-card:hover { background: rgba(var(--st-fg-rgb), 0.07); border-color: rgba(var(--st-fg-rgb), 0.14); transform: translateY(-1px); }
        .sth-fm-pill { display: inline-flex; align-items: center; margin-top: 4px; font-size: 8.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 2px 7px; border-radius: 5px; }
        .sth-fm-x { position: absolute; top: 7px; right: 7px; width: 21px; height: 21px; border-radius: 6px; border: none; cursor: pointer; background: rgba(0,0,0,0.45); color: rgba(var(--st-fg-rgb), 0.6); display: flex; align-items: center; justify-content: center; padding: 0; opacity: 0; transform: scale(0.8); transition: opacity 0.14s ease, transform 0.14s ease, background 0.14s ease, color 0.14s ease; }
        .sth-fm-card:hover .sth-fm-x { opacity: 1; transform: scale(1); }
        .sth-fm-x:hover { background: rgba(240,110,110,0.25); color: rgb(250,160,160); }
        .sth-fm-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px; padding: 30px 20px; }
        .sth-libov { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.45fr); gap: 16px; align-items: start; }
        @media (max-width: 1080px) { .sth-libov { grid-template-columns: minmax(0, 1fr); } }
        /* Leaderboard rows. Fixed columns shared by the tracks and artists
           views so switching tabs doesn't shift anything sideways. */
        .sth-lb-row { display: grid; grid-template-columns: 22px 30px minmax(0, 1fr) 58px 62px; gap: 11px; align-items: center;
          padding: 4px 12px; height: 38px; border-radius: 9px; }
        .sth-lb-row:not(.sth-lb-head):hover { background: rgba(var(--st-fg-rgb), 0.05); }
        .sth-lb-head { height: 26px; font-size: 9.5px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase;
          color: rgba(var(--st-fg-rgb), 0.28); border-radius: 0; }
        /* --- Streak badge -------------------------------------------------
           Three layered motions, all cheap: the badge breathes, a halo behind
           it pulses, and the flame itself flickers on a deliberately odd
           duration so the two never sync into an obvious loop. Only the
           streak card gets .is-flame — the other two habit cards use the same
           component but stay still, since constant motion on three tiles at
           once is noise rather than emphasis. */
        .sth-streak-badge { position: relative; width: 40px; height: 40px; border-radius: 11px; flex-shrink: 0;
          display: flex; align-items: center; justify-content: center;
          background: rgba(var(--tone), 0.14); color: rgb(var(--tone));
          transition: background 0.5s ease, color 0.5s ease, box-shadow 0.5s ease; }
        /* Halo sits behind, never intercepts the pointer, and scales with the
           tier's own colour so a hotter streak glows harder. */
        .sth-streak-badge.is-flame::before { content: ''; position: absolute; inset: -4px; border-radius: 14px; pointer-events: none;
          background: radial-gradient(closest-side, rgba(var(--tone), 0.34), rgba(var(--tone), 0) 72%);
          animation: sthStreakGlow 2.6s ease-in-out infinite; }
        .sth-streak-badge.is-flame svg { animation: sthStreakFlicker 1.9s ease-in-out infinite; transform-origin: 50% 78%; }
        @keyframes sthStreakGlow { 0%, 100% { opacity: 0.45; transform: scale(0.94); } 50% { opacity: 1; transform: scale(1.06); } }
        /* Anchored at the base like a real flame: the tip moves, the foot doesn't. */
        @keyframes sthStreakFlicker {
          0%, 100% { transform: scale(1) translateY(0); }
          28%      { transform: scale(1.07, 1.11) translateY(-0.6px); }
          52%      { transform: scale(0.97, 1.03) translateY(0.3px); }
          76%      { transform: scale(1.04, 1.07) translateY(-0.3px); }
        }
        /* One-shot when a new tier is reached — fires on the badge, not the
           card, so the text stays readable while it plays. */
        .sth-streak-badge.is-new { animation: sthStreakPop 1.1s cubic-bezier(0.2, 0.9, 0.3, 1) 1; }
        @keyframes sthStreakPop {
          0%   { transform: scale(1); box-shadow: 0 0 0 0 rgba(var(--tone), 0.55); }
          35%  { transform: scale(1.16); }
          100% { transform: scale(1); box-shadow: 0 0 0 16px rgba(var(--tone), 0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .sth-streak-badge.is-flame::before,
          .sth-streak-badge.is-flame svg,
          .sth-streak-badge.is-new { animation: none; }
          /* The colour still changes — that's information, not decoration. */
          .sth-streak-badge.is-flame::before { opacity: 0.7; }
        }

        /* Wrong code — a shake rather than a message, since the field is only
           76px wide and there's nowhere to put a sentence. */
        .sth-codebad { animation: sthCodeShake 0.32s ease; }
        @keyframes sthCodeShake {
          0%, 100% { transform: translateX(0); }
          20%      { transform: translateX(-4px); }
          45%      { transform: translateX(3px); }
          70%      { transform: translateX(-2px); }
        }
        @media (prefers-reduced-motion: reduce) { .sth-codebad { animation: none; } }

        /* The three habit figures. */
        .sth-statstreaks { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 16px; }
        @media (max-width: 1080px) { .sth-statgrid { grid-template-columns: minmax(0, 1fr); } }
        @media (max-width: 820px) { .sth-statstreaks { grid-template-columns: minmax(0, 1fr); } }

        /* ==================================================================
           REDESIGN (implementation brief) — overrides for the shared shell.
           Kept together at the end of the sheet so they win on cascade order
           and are easy to find.
           ================================================================== */
        /* Content card: one rounded card on the black window, 16px gutter at
           right and bottom, and only reserves the bar's space when it's up. */
        .sth-scroll { margin: 0 var(--gutter) var(--np-reserve) 0; border-radius: var(--r-card); background: var(--surface); border: 1px solid var(--border); padding: 28px 28px 32px; }
        .sth-scroll.is-page { padding: 0; }
        /* Now Playing bar — detached card aligned to the content card. */
        .sth-npbar { left: var(--np-bar-left); right: var(--gutter); bottom: var(--gutter); height: 86px; border-radius: var(--r-card); background: var(--np-bar-bg, var(--surface)); border: 1px solid var(--border); }
        .sth-npbar-grid { position: relative; z-index: 1; height: 100%; display: grid; grid-template-columns: 282px minmax(0, 1fr) 282px; align-items: center; padding: 0 16px; gap: 16px; }
        .sth-npbar-left { display: flex; align-items: center; gap: 12px; min-width: 0; transition: opacity 0.24s ease, transform 0.36s cubic-bezier(0.22,1,0.36,1); }
        /* A notification docked in the bar sits over the song info. */
        :root[data-st-toast-in-bar] .sth-npbar-left { opacity: 0; transform: translateX(-10px); pointer-events: none; }
        .sth-npbar-art { width: 52px; height: 52px; border-radius: var(--r-art); flex-shrink: 0; padding: 0; border: none; box-shadow: 0 0 0 1px rgba(255,255,255,0.06); }
        .sth-npbar-title { font-size: 14px; font-weight: 700; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        /* Title doubles as the Spotify link: click to copy. */
        .sth-npbar-title.is-link { display: block; max-width: 100%; padding: 0; margin: 0; border: 0; background: none; font-family: inherit; line-height: inherit; text-align: left; cursor: pointer; }
        .sth-npbar-title.is-link:hover { text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; }
        .sth-npbar-title.is-link:disabled { cursor: progress; opacity: 0.6; }
        /* ---- Fullscreen Now Playing (NowPlayingFullView) ---- */
        .sth-full { position: absolute; inset: 10px; z-index: 42; border-radius: var(--r-card); overflow: hidden; background: #0a0a0b; border: 1px solid var(--border); display: flex; flex-direction: column; animation: sthFullIn 0.28s cubic-bezier(0.22,1,0.36,1) both; }
        @keyframes sthFullIn { from { opacity: 0; transform: scale(0.985); } to { opacity: 1; transform: none; } }
        .sth-full-bg { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
        .sth-full-top { position: relative; z-index: 1; flex-shrink: 0; height: 52px; display: flex; align-items: center; gap: 10px; padding: 0 12px 0 20px; -webkit-app-region: drag; }
        .sth-full-top button { -webkit-app-region: no-drag; }
        .sth-full-eyebrow { font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255,255,255,0.5); }
        .sth-full-tabs { display: flex; gap: 2px; padding: 3px; border-radius: 999px; background: rgba(0,0,0,0.28); -webkit-app-region: no-drag; }
        .sth-full-tab { height: 28px; padding: 0 14px; border-radius: 999px; border: none; cursor: pointer; background: transparent; color: rgba(255,255,255,0.6); font-family: inherit; font-size: 12.5px; font-weight: 600; transition: background 0.15s ease, color 0.15s ease; }
        .sth-full-tab:hover { color: #fff; }
        .sth-full-tab.on { background: rgba(255,255,255,0.14); color: #fff; font-weight: 700; }
        .sth-full-body { position: relative; z-index: 1; flex: 1; min-height: 0; display: flex; gap: 14px; padding: 0 14px 14px; }
        .sth-full-stage { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0; padding: 8px 24px 20px; }
        .sth-full-cover { flex-shrink: 1; width: min(46vh, 460px, 72%); aspect-ratio: 1 / 1; min-height: 0; border-radius: 14px; border: none; padding: 0; background-color: rgba(255,255,255,0.06); background-size: cover; background-position: center; box-shadow: 0 30px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06); transition: width 0.3s cubic-bezier(0.22,1,0.36,1); }
        .sth-full.has-panel .sth-full-cover { width: min(40vh, 400px, 80%); }
        .sth-full-meta { width: 100%; max-width: 560px; margin-top: 26px; text-align: center; min-width: 0; }
        .sth-full-title { display: block; max-width: 100%; margin: 0 auto; font-size: clamp(22px, 3.2vh, 32px); font-weight: 800; letter-spacing: -0.02em; line-height: 1.2; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sth-full-title.is-link { padding: 0; border: 0; background: none; font-family: inherit; cursor: pointer; }
        .sth-full-title.is-link:hover { text-decoration: underline; text-underline-offset: 4px; text-decoration-thickness: 2px; }
        .sth-full-title.is-link:disabled { cursor: progress; opacity: 0.6; }
        .sth-full-sub { margin-top: 6px; font-size: 15px; color: rgba(255,255,255,0.66); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sth-full-scrub { width: 100%; max-width: 520px; margin-top: 22px; display: grid; grid-template-columns: 40px minmax(0, 1fr) 40px; align-items: center; gap: 10px; }
        .sth-full-transport { margin-top: 12px; display: flex; align-items: center; gap: 14px; }
        .sth-full-skip { width: 42px; height: 42px; }
        .sth-full-play { width: 58px; height: 58px; border-radius: 50%; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; background: #fff; color: #0a0a0b; box-shadow: 0 8px 24px rgba(0,0,0,0.35); transition: transform 0.1s ease, filter 0.14s ease; }
        .sth-full-play:hover { filter: brightness(0.92); }
        .sth-full-play:active { transform: scale(0.95); }
        .sth-full-actions { margin-top: 14px; display: flex; align-items: center; gap: 4px; }
        .sth-full-panel { position: relative; flex-shrink: 0; width: clamp(340px, 36%, 520px); min-height: 0; display: flex; flex-direction: column; border-radius: var(--r-card); overflow: hidden; background: rgba(0,0,0,0.34); border: 1px solid rgba(255,255,255,0.07); animation: sthPanelIn 0.26s cubic-bezier(0.22,1,0.3,1) both; }
        @media (max-height: 640px) { .sth-full-meta { margin-top: 16px; } .sth-full-scrub { margin-top: 14px; } }
        @media (prefers-reduced-motion: reduce) { .sth-full, .sth-full-panel { animation: none; } .sth-full-cover { transition: none; } }
        /* Compact mode: no page title in the library views. Tier one (title +
           count) goes; the controls row and table move up to the top of the
           card. Single-row headers (Albums, Artists) keep their search and
           Import, pushed right by the existing spacer. */
        .sth-root.is-compact .sth-libhead-tw { display: none; }
        .sth-root.is-compact .sth-libhead { gap: 0; padding-top: 0; }
        .sth-root.is-compact .sth-libhead.is-single { padding-top: 0; min-height: 34px; }
        /* Compact mode: the top bar slides down over the card on edge peek. */
        .sth-topbar.is-compact { transform: translateY(-100%); visibility: hidden; pointer-events: none; transition: transform 0.18s ease, visibility 0s linear 0.18s; }
        .sth-topbar.is-compact.is-peek { transform: none; visibility: visible; pointer-events: auto; box-shadow: 0 12px 36px rgba(0,0,0,0.45); transition: transform 0.22s cubic-bezier(0.22,1,0.36,1); }
        .sth-npbar-artist { font-size: 12.5px; color: var(--text-dim); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sth-npbar-mid { display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; }
        .sth-npbar-transport { display: flex; align-items: center; gap: 10px; }
        /* The original treatment: a plain white glyph, no filled plate behind
           it. Same size as the rest of the transport, just brighter. */
        .sth-npbar-play { width: 40px; height: 40px; border-radius: var(--r-ctl-m); background: transparent; color: #fff; }
        .sth-npbar-play:hover { background: rgba(255,255,255,0.08); filter: none; }
        .sth-npbar-scrub { display: grid; grid-template-columns: 36px 420px 36px; align-items: center; gap: 10px; max-width: 100%; }
        @media (max-width: 1180px) { .sth-npbar-scrub { grid-template-columns: 36px minmax(120px, 1fr) 36px; width: 100%; } }
        .sth-npbar-t { font-size: 11px; color: var(--text-faint); }
        .sth-npbar-seek::before { border-radius: 2px; background: rgba(255,255,255,0.14); }
        .sth-npbar-seek-fill { border-radius: 2px; background: var(--accent-line); }
        .sth-npbar-seek-knob { background: #fff; }
        .sth-npbar-right { display: flex; align-items: center; justify-content: flex-end; gap: 4px; min-width: 0; }
        .sth-npbar-cluster { display: flex; align-items: center; gap: 2px; }
        /* White, not the flat grey token — these sit on a colour wash that
           turns #A1A1AA muddy. */
        .sth-npbtn { width: 32px; height: 32px; border-radius: var(--r-ctl-s); color: rgba(255,255,255,0.68); }
        .sth-npbtn:hover { color: #fff; background: rgba(255,255,255,0.08); }
        .sth-npbtn.is-on { color: #fff; }
        .sth-npbar-title { color: #fff; }
        .sth-npbar-artist { color: rgba(255,255,255,0.6); }
        .sth-npbar-t { color: rgba(255,255,255,0.55); }
        .sth-npbar-seek-fill { background: #fff; }
        .sth-npbtn-rule { background: rgba(255,255,255,0.16); }
        .sth-npbtn-rule { height: 20px; margin: 0 6px; background: rgba(255,255,255,0.1); }
        @media (max-width: 1100px) { .sth-npbar-grid { grid-template-columns: 220px minmax(0, 1fr) auto; } }

        /* Sidebar */
        .sth-side-eyebrow { display: flex; align-items: center; justify-content: space-between; padding: 0 12px; height: 28px; margin-top: 4px; }
        .sth-side-item { display: flex; align-items: center; gap: 14px; width: 100%; text-align: left; height: 40px; padding: 0 12px; border-radius: var(--r-ctl-m); border: none; cursor: pointer; background: transparent; color: var(--text-dim); font: inherit; font-size: 14.5px; font-weight: 500; transition: background 140ms ease, color 140ms ease; position: relative; }
        .sth-side-item:hover { background: rgba(255,255,255,0.04); color: var(--text); }
        .sth-side-item.on { color: var(--text); font-weight: 700; }
        .sth-side-item.on.m-chip { background: rgba(255,255,255,0.08); }
        .sth-side-item.on.m-bar::before { content: ''; position: absolute; left: 0; top: 10px; bottom: 10px; width: 3px; border-radius: 2px; background: var(--accent-line); }
        .sth-side-item.on.m-underline span.lbl { text-decoration: underline; text-decoration-color: var(--accent-line); text-decoration-thickness: 2px; text-underline-offset: 5px; }
        .sth-side-item.on.m-dot::after { content: ''; position: absolute; right: 12px; top: 50%; margin-top: -3px; width: 6px; height: 6px; border-radius: 50%; background: var(--accent-line); }
        .sth-side-pl { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; padding: 7px 12px; border-radius: var(--r-ctl-m); border: none; cursor: pointer; background: transparent; font: inherit; transition: background 140ms ease; }
        .sth-side-pl:hover { background: rgba(255,255,255,0.04); }
        .sth-side-pl.on { background: rgba(255,255,255,0.08); }
        .sth-side-pl .art { width: 34px; height: 34px; border-radius: var(--r-art-s); flex-shrink: 0; background-size: cover; background-position: center; }
        .sth-side-pl .nm { font-size: 13.5px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sth-side-pl .ct { font-size: 11.5px; color: var(--text-faint); margin-top: 1px; }
        /* Top bar tabs */
        .sth-toptab { display: flex; align-items: center; gap: 10px; height: 38px; padding: 0 16px; border-radius: var(--r-ctl-m); border: none; background: transparent; cursor: pointer; color: var(--text-dim); font: inherit; font-size: 14.5px; font-weight: 600; transition: background 140ms ease, color 140ms ease; }
        .sth-toptab:hover { color: var(--text); background: rgba(255,255,255,0.04); }
        .sth-toptab.on { color: var(--text); background: rgba(255,255,255,0.08); font-weight: 700; }
        .sth-searchbar { border-radius: var(--r-ctl-m); background: var(--surface); border-color: var(--border-control); }


        /* ---- Song table (shared by Songs, album, playlist, artist) ---- */
        .sth-lrow { height: var(--row-h, 54px); border-radius: var(--r-ctl-s); }
        .sth-lrow.sth-lrow-head { height: 30px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: rgba(255,255,255,0.4); border-bottom: 1px solid rgba(255,255,255,0.08); }
        .sth-lrow > div:nth-child(2) > div > div:first-child { border-radius: var(--r-art-s); }
        .sth-lrow-dim { font-size: 13px; color: var(--text-dim); }
        .sth-lrow-num, .sth-lrow-dim.st-num { font-variant-numeric: tabular-nums; }
        .sth-findfield { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px; width: 220px;
          border-radius: var(--r-ctl-m); background: rgba(0,0,0,0.25); border: 1px solid var(--border-control); color: var(--text-faint); }
        .sth-findfield:focus-within { border-color: rgba(var(--accent-rgb), 0.55); }
        .sth-findfield input { flex: 1; min-width: 0; background: transparent; border: none; outline: none; color: var(--text); font: inherit; font-size: 13px; }
        .sth-findfield input::placeholder { color: var(--text-faint); }

        /* ---- Library headers, album + artist grids ---- */
        .sth-libhead-t { font-size: 32px; font-weight: 800; letter-spacing: -0.02em; }
        .sth-libhead-m { font-size: 13px; color: var(--text-faint); }
        /* No outlines. Borders on these read as boxes floating on the page's
           colour wash — the original borderless treatment is right, and only
           Play all is emphasised, by fill rather than by an edge. */
        .sth-libact { height: 34px; border-radius: var(--r-ctl-m); border: none; color: rgba(255,255,255,0.68); font-size: 13px; font-weight: 600; background: transparent; }
        .sth-libact:hover { background: rgba(255,255,255,0.08); color: #fff; }
        .sth-libact-primary { background: rgba(255,255,255,0.14); color: #fff; }
        .sth-libact-primary:hover { background: rgba(255,255,255,0.22); color: #fff; filter: none; }
        .sth-alb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 28px 20px; }
        .sth-albart { border-radius: var(--r-art); }
        .sth-alb-play { position: absolute; right: 10px; bottom: 10px; width: 40px; height: 40px; border-radius: var(--r-ctl-m);
          display: flex; align-items: center; justify-content: center; border: none; cursor: pointer;
          background: var(--accent); color: var(--accent-ink); opacity: 0; transform: translateY(6px);
          transition: opacity 150ms ease, transform 150ms ease; }
        .sth-alb:hover .sth-alb-play, .sth-alb:focus-within .sth-alb-play { opacity: 1; transform: translateY(0); }
        @media (prefers-reduced-motion: reduce) { .sth-alb-play { transition: none; } }

        /* ---- Radius pass (brief, Tokens and primitives) --------------------
           8px for controls up to 30px tall, 10px from 32 to 42, 12px above.
           Circular icon buttons become rounded squares at the same radii.
           Two exceptions, both deliberate: toggle switches keep their capsule,
           and artist artwork stays circular because it's a portrait. */
        .sth-iconbtn, .sth-rowact, .sth-actbtn, .sth-lrow-play, .sth-lrow-more,
        .sth-searchbar-x, .sth-npside { border-radius: var(--r-ctl-s) !important; }
        .sth-searchbar, .sth-fchip, .sth-libtag, .sth-relexp-getall, .sth-relexp-close,
        .sth-libact, .sth-libact-primary, .sth-set-navi { border-radius: var(--r-ctl-m) !important; }
        .sth-libact, .sth-libact-primary, .sth-libtag { border: none !important; }
        .sth-card, .sth-libpanel, .sth-npbar, .sth-scroll { border-radius: var(--r-card); }
        .sth-albart, .sth-selrow .sth-selart, .sth-relexp-art { border-radius: var(--r-art) !important; }
        /* Scrollbar thumbs and progress bars keep their pill shape — they are
           rails, not controls. */

        /* ---- Icons and focus ---- */
        .sth-npbtn svg, .sth-side-item svg, .sth-toptab svg, .sth-set-navi svg,
        .sth-libact svg, .st-btn svg, .st-icon-btn svg { stroke-width: 1.5; }
        .sth-lrow, .sth-nr-row, .sth-side-pl, .sth-jump button, .sth-repeat button,
        .sth-alb, .stag-tile { -webkit-user-select: none; user-select: none; }

        /* ---- Alphabet rail ----
           24px hit targets with a visible label, rather than 10px of
           near-invisible glyphs pressed against the window edge. */
        .sth-azrail { width: 24px; padding: 2px 4px 6px; }
        .sth-azkey { min-height: 18px; font-size: 10.5px; color: var(--text-faint); border-radius: 6px; }
        .sth-azkey:not(:disabled):hover { color: var(--text) !important; background: rgba(255,255,255,0.1); }
        /* ---- Settings ---- */
        .sth-set-rail { width: 206px; flex: 0 0 206px; padding: 24px 14px; border-right: 1px solid var(--border); }
        .sth-set-rail .lbl { padding: 14px 12px 6px; }
        .sth-set-rail .lbl:first-child { padding-top: 0; }
        .sth-set-navi { height: 38px; padding: 0 12px; border-radius: var(--r-ctl-m); font-size: 14px; font-weight: 600; color: var(--text-dim); gap: 12px; }
        .sth-set-navi.on { background: rgba(255,255,255,0.08); color: var(--text); }
        .sth-set-navi svg { width: 17px; height: 17px; flex: 0 0 17px; stroke-width: 1.5; }
        .sth-set-body { padding: 28px 28px 48px; border-left: none; }
        .sth-set-body > * { max-width: 880px; }
        .sth-set-list { border-top: 1px solid var(--border); }
        .sth-set-r { display: grid; grid-template-columns: minmax(0, 1fr) 320px; align-items: center; gap: 32px; padding: 20px 0; box-shadow: none; border-bottom: 1px solid var(--border); }
        .sth-set-r:last-child { border-bottom: 1px solid var(--border); }
        .sth-set-r .txt b { font-size: 14.5px; font-weight: 700; color: var(--text); }
        .sth-set-r .txt p { font-size: 13px; color: var(--text-dim); max-width: 60ch; margin-top: 4px; }
        .sth-set-r > .ctl { display: flex; flex-direction: column; align-items: stretch; gap: 10px; min-width: 0; }
        .sth-set-r > .ctl:not(.is-col) { align-items: flex-end; }
        .sth-set-sub { display: flex; justify-content: flex-end; }
        .sth-set-subhead { padding-bottom: 10px; }
        @media (max-width: 1000px) { .sth-set-r { grid-template-columns: minmax(0, 1fr); gap: 12px; } .sth-set-r > .ctl:not(.is-col) { align-items: flex-start; } }
        .sth-danger { display: flex; align-items: center; gap: 24px; padding: 18px 20px; margin-bottom: 12px; border-radius: var(--r-panel); background: rgba(255,139,139,0.03); border: 1px solid rgba(255,139,139,0.14); }
        .sth-danger b { display: block; font-size: 14px; font-weight: 700; color: var(--text); }
        .sth-danger p { margin: 4px 0 0; font-size: 13px; line-height: 1.5; color: var(--text-dim); }
        .sth-conn { padding: 20px 22px; border-radius: var(--r-panel); background: var(--surface-raised); border: 1px solid var(--border); }
        .sth-conn-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
        .sth-conn h2 { font-size: 16px; font-weight: 800; color: var(--text); margin: 0; }
        .sth-conn p { font-size: 13px; color: var(--text-dim); margin: 4px 0 0; }
        .st-fields { display: flex; flex-direction: column; gap: 12px; }
        .st-field { display: flex; flex-direction: column; gap: 6px; }
        .st-field-lbl { font-size: 10.5px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: var(--text-faint); }
        .st-input { height: 40px; padding: 0 14px; border-radius: var(--r-ctl-m); background: rgba(255,255,255,0.02); border: 1px solid var(--border-control); color: var(--text); font-size: 13.5px; }
        .st-input:focus { border-color: rgba(var(--accent-rgb), 0.6); background: rgba(255,255,255,0.03); }
      `}</style>
      {/* Album wash — when viewing an album, its cover bleeds across the top
          (behind the translucent nav rail and the content) as an immersive
          backdrop. There's no ambient accent glow underneath anymore, so the
          wash is the only colour source here and never clashes. */}
      {/* (Library ambient backdrop removed — the section now uses the same flat
          background as every other tab.) */}

      {/* ============ Navigation rail ============ */}
      {/* ============ Top bar =============================================
          Replaces the 210px left sidebar. Tabs, search and utilities share
          one line, which hands the full window width back to the content —
          the release grid gains a column at most sizes.
          64px tall: enough to clear the frameless window's 36px invisible
          drag strip without eating into the content. */}
      <header className={`sth-topbar${compactMode ? ' is-compact' : ''}${compactMode && chromePeek === 'top' ? ' is-peek' : ''}`}
        aria-hidden={compactMode && chromePeek !== 'top' ? true : undefined}
        style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: TOPBAR_H, zIndex: compactMode ? 46 : 3,
        /* No left padding: the "My Library" block below is exactly SIDEBAR_W
           wide, so the tabs after it line up with the content wrapper's left
           edge rather than floating somewhere before it. */
        /* Grid, not flex-with-spacers. Equal flex spacers centre the search
           between the tabs and the settings button — and since the left side
           carries a 210px label plus two tabs while the right carries one
           36px icon, "between them" sat a long way right of the window's
           centre. Two minmax(0, 1fr) columns are exactly equal regardless of
           what's in them, so the middle column lands on the true centre. */
        /* The search sits on the WINDOW's centre line. Two equal outer
           columns (minmax(0, 1fr) each, whatever they hold: the wordmark on
           the left, the buttons on the right) put the middle column exactly
           in the middle. With `auto` outer columns the middle one was
           pulled toward the narrower side. */
        display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
        // No side padding: it would be uneven (the wordmark brings its own),
        // and uneven padding moves the centre. The buttons pad themselves.
        alignItems: 'center', gap: 16, padding: 0,
        background: `rgb(${theme.bg})`,
        borderBottom: 'none',
        animation: compactMode ? 'none' : 'stFadeIn 0.6s ease both',
        /* Hidden in compact: no drag region at all. A transformed-away drag
           element can still claim its untransformed box at the OS hit-test,
           which would swallow clicks across the top of the card. */
        WebkitAppRegion: compactMode && chromePeek !== 'top' ? 'no-drag' : 'drag',
      }}>
        {/* My Library belongs on the same visual baseline as Home and Discover.
            It still reserves the full sidebar column, so the primary tabs begin
            exactly at the content wrapper's left edge. */}
        {/* Column 1: everything left of the search. min-width 0 lets it be
            narrower than its content on a small window rather than shoving the
            centre column off-centre; the tabs clip before the search moves. */}
        <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 18, overflow: 'hidden' }}>
        {/* Shrinks before the tabs do. Both of these used to be flexShrink: 0,
            so when column 1 outgrew its grid track nothing yielded and the
            clip fell on whatever sat last — the tab row. The wordmark is the
            safer thing to lose a few pixels of on a narrow window. */}
        {/* Wordmark. Brief, App shell: the studio wordmark heads the sidebar
            column; Home and Stats stay as tabs at the left of the top bar. */}
        <div style={{ width: SIDEBAR_W, flexShrink: 1, minWidth: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 20 }}>
          <span aria-hidden style={{ width: 26, height: 26, borderRadius: 8, flexShrink: 0, background: 'linear-gradient(135deg, var(--accent-line), var(--accent))' }} />
          <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text)' }}>studio</span>
        </div>

        </div>

        {/* Column 2: the search, on the window's centre line. Width is clamped
            so it neither shrinks to a slot nor stretches into a text area on a
            wide monitor. */}
        <div style={{ width: 'clamp(260px, 34vw, 480px)', WebkitAppRegion: 'no-drag' }}>{topbarSearch}</div>

        {/* Column 3: mirrors column 1's width, so whatever sits here can't
            pull the search off centre. */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, minWidth: 0, paddingRight: 16, WebkitAppRegion: 'no-drag' }}>
          <ReloadButton />
          <NotificationsButton />
          <button
            type="button"
            onClick={() => pickSection('settings')}
            title="Settings"
            aria-label="Settings"
            style={{
              width: 34, height: 34, borderRadius: 10, border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: section === 'settings' ? 'rgba(var(--st-fg-rgb), 0.09)' : 'transparent',
              color: section === 'settings' ? '#fff' : 'rgba(var(--st-fg-rgb), 0.5)',
              transition: 'background 0.16s ease, color 0.16s ease',
            }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

      {/* ============ Library sidebar =====================================
          Was a tab in the top bar with its own internal rail. As a permanent
          left column the library's views are one click from anywhere, and the
          content wrapper keeps its full width for the album and playlist
          pages rather than surrendering 232px to a nested rail. */}
      <aside aria-label="Library" style={{
        /* Runs to the window floor: the Now Playing bar starts at the content
           column's left edge now, so nothing sits underneath the sidebar. */
        position: 'absolute', top: TOPBAR_H, left: 0, bottom: 'var(--np-reserve)', width: SIDEBAR_W,
        zIndex: 2, display: 'flex', flexDirection: 'column',
        /* Left inset = the window gutter; right inset = the gap to the card. */
        padding: '0 var(--gap) 0 var(--gutter)',
        WebkitAppRegion: 'no-drag',
        /* Compact: a floating card over the content, parked off the left edge
           until the pointer touches it. Same background as the shell so it
           reads as the sidebar you already know, lifted. */
        ...(compactMode ? {
          top: 'var(--gutter)', left: 'var(--gutter)', bottom: 'var(--np-reserve)',
          width: SIDEBAR_W - 16, zIndex: 45, padding: '6px 8px 8px',
          background: `rgb(${theme.bg})`, border: '1px solid var(--border)', borderRadius: 'var(--r-card)',
          boxShadow: '0 18px 48px rgba(0,0,0,0.5)',
          transform: chromePeek === 'side' ? 'none' : 'translateX(calc(-100% - 24px))',
          visibility: chromePeek === 'side' ? 'visible' : 'hidden',
          transition: chromePeek === 'side'
            ? 'transform 0.22s cubic-bezier(0.22,1,0.36,1)'
            : 'transform 0.18s ease, visibility 0s linear 0.18s',
        } : null),
      }}
      aria-hidden={compactMode && chromePeek !== 'side' ? true : undefined}>
        {/* LIBRARY heading — the point of the change: the sidebar reads as one
            category rather than the leftovers of a split navigation. */}
        <div className="sth-side-eyebrow"><span className="st-eyebrow">My Spotify</span></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {MY_SPOTIFY.map(([id, label, path]) => {
            const on = section === id;
            return (
              <button key={id} type="button" aria-current={on ? 'page' : undefined}
                className={`sth-side-item m-${navStyle === 'glow' ? 'chip' : navStyle}${on ? ' on' : ''}`}
                onClick={() => { pickSection(id); setLibDetail(null); }}>
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
                  <path d={path} />
                </svg>
                <span className="lbl">{label}</span>
              </button>
            );
          })}
        </div>

        <div className="sth-side-eyebrow" style={{ marginTop: 20 }}><span className="st-eyebrow">Library</span></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {LIB_VIEWS.map(([id, label, path]) => {
            const on = section === 'library' && libView === id && !libDetail;
            return (
              <button key={id} type="button" aria-current={on ? 'page' : undefined}
                className={`sth-side-item m-${navStyle === 'glow' ? 'chip' : navStyle}${on ? ' on' : ''}`}
                onClick={() => { pickSection('library'); pickLibView(id); setLibDetail(null); }}>
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
                  <path d={path} />
                </svg>
                <span className="lbl">{label}</span>
              </button>
            );
          })}
        </div>

        <div className="sth-side-eyebrow" style={{ marginTop: 20 }}>
          <span className="st-eyebrow">Playlists</span>
          {onCreatePlaylist ? (
            <button type="button" className="st-icon-btn is-sm" onClick={() => setNewPlaylist({ name: '' })}
              title="New playlist" aria-label="New playlist" style={{ width: 24, height: 24, background: 'rgba(255,255,255,0.07)' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
            </button>
          ) : null}
        </div>
        <div className="sth-libscroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 4 }}>
          {playlists.length === 0 ? (
            <div style={{ padding: '6px 12px', fontSize: 12.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
              No playlists yet. Use + to start one.
            </div>
          ) : null}
          {playlists.map((pl) => {
            const on = libDetail?.kind === 'playlist' && libDetail.key === pl.id;
            const n = Array.isArray(pl.trackIds) ? pl.trackIds.length : 0;
            const firstArt = !pl.coverArt && n ? (() => {
              const t0 = library.find((t) => t.id === pl.trackIds[0]);
              return t0 ? coverFor(t0) : null;
            })() : null;
            const artUrl = pl.coverArt || firstArt;
            return (
              <button key={pl.id} type="button" className={`sth-side-pl${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined}
                onClick={() => { pickSection('library'); setLibDetail({ kind: 'playlist', key: pl.id }); }}>
                <span className="art" aria-hidden style={{
                  backgroundImage: artUrl ? `url("${artUrl}")` : 'linear-gradient(135deg, rgba(var(--accent-rgb),0.55), rgba(var(--accent-rgb),0.2))',
                }} />
                <span style={{ minWidth: 0 }}>
                  <span className="nm" style={{ display: 'block' }}>{pl.name}</span>
                  <span className="ct st-num" style={{ display: 'block' }}>{n} song{n === 1 ? '' : 's'}</span>
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      {/* ============ Content column ============ */}
      <div style={{
        // Full width now — the sidebar is gone. `top` clears the bar rather
        // than padding the content, so the scroller's own top edge is the
        // first pixel below the bar and sticky children align to it.
        /* Always below the top bar. This used to collapse to top: 0 when
           `libExpanded` was set — a leftover from the OLD fullscreen library,
           which no longer exists. The flag is still persisted in localStorage,
           so anyone who ever opened that view had the content wrapper stripped
           and slid under the tabs on every launch since. */
        position: 'absolute', top: 'var(--shell-top)',
        bottom: 0, left: compactMode ? 'var(--gutter)' : SIDEBAR_W, right: 0, zIndex: 1,
        display: 'flex', flexDirection: 'column',
        /* Reserve the dock's width so the content narrows instead of being
           covered. The shelves re-measure through HomeRow's ResizeObserver, so
           the carousel arrows stay accurate at the new width. */
        /* The panel's own width plus the gap between it and the card. The
           card's --gutter margin sits outside this, so the card ends exactly
           one gap from the panel's edge. */
        paddingRight: (npPanelOpen && currentTrack && !libExpanded) ? NP_PANEL_W + 12 : 0,
        transition: 'padding-right 0.26s cubic-bezier(0.22,1,0.3,1)',
      }}>
        {/* ---- Search bar ----------------------------------------------------
            Lifted out of the scrolling content into a persistent bar at the
            top of the content column. It used to sit inline below the
            greeting, which meant it scrolled away the moment you looked at
            releases, and left the page with two stacked headers competing for
            the top of the view.

            Constrained width rather than full-bleed: a search field spanning
            a 1400px window reads as a text area, not a control. */}

        {/* No is-bleed: that variant stripped the wrapper's margin, radius,
            background and border for the retired fullscreen library. Nothing
            reaches it any more, and while it did the panel simply vanished. */}
        {/* NO per-section padding overrides.
            There were four here — paddingBottom varying between 90 / 10 / 14
            depending on the tab, plus three keyed on `libExpanded`, the flag
            from the retired fullscreen library that nothing sets any more.
            The net effect was the wrapper visibly changing size when moving
            between Home, Songs and Discover. The panel's geometry is fixed in
            .sth-scroll; only the `is-page` variant (album / playlist) alters
            it, and that one is deliberate. */}
        {/* is-page for the WHOLE library section, not just album/playlist
            pages. The library's table scrolls internally, but the wrapper was
            also scrolling and carrying 90px of bottom padding — so the list
            was sized to 100% of a box 108px taller than what's visible, cutting
            off mid-row with dead space below and scrolling past the end. */}
        <div key={sec} className={`sth-scroll${sec === 'library' || sec === 'settings' || MY_SPOTIFY_IDS.has(sec) ? ' is-page' : ''}`} style={{
          position: 'relative', zIndex: 1, animation: 'stFadeUp 0.35s cubic-bezier(0.2,0.9,0.3,1) both',
        }}>

          {/* ================= MY SPOTIFY =================
              Home and New Releases, from the signed-in Spotify account
              (MySpotify.jsx). Each page scrolls itself. */}
          {sec === 'sp-home' ? <SpotifyHome bridge={mySpotifyBridge} /> : null}
          {sec === 'sp-releases' ? <SpotifyReleases bridge={mySpotifyBridge} /> : null}

          {/* ================= LIBRARY =================
              Rebuilt to the mockup: a fixed left rail of views + playlists,
              and a dense track table on the right. The old version was a
              toolbar over a card grid with an inline detail panel — good for
              browsing albums, poor for the "find one song among 500" job a
              library actually gets used for. */}
          {sec === 'library' ? (() => {
            const view = libView;
            /* The hero shows the LIBRARY, always — not the playing track. The
               Now Playing bar already reports that, and two places saying the
               same thing is what made this feel off. */
            /* Album, playlist AND artist pages all own the whole wrapper: they
               paint their own wash to the corners and supply their own inset.
               Keyed on detailData alone this missed the artist page, which then
               rendered inside the list view's 26px inset with the library's
               now-playing wash bleeding through behind it. */
            const detailPage = !!detailData || !!openArtist;
            /* Colour follows the music; the header doesn't.
               Which colour depends on the chosen extraction — the mean of the
               whole cover, or the most prominent colour actually in it. */
            /* 'fixed' skips sampling entirely — the page is the colour you
               chose, whatever is playing. */
            /* Immerse is the bar and the panel — the chrome around the music.
               The library pages stay black under it: they're a list you read,
               and a moving gradient behind three hundred rows competes with
               the thing it's meant to frame. */
            const pageMode = detailPage || immerse ? 'off' : theme.pageSurface;
            const wrapperFixed = pageMode === 'colour';
            const usesCover = pageMode === 'cover' || pageMode === 'coverFull';
            const npWashOn = currentTrack && usesCover && npWashTheme;
            /* The page follows the chrome, not the other way round.
               On auto these are two views of one sampled colour: the bar gets
               barTone() and sits pinned at 0.24 lightness, the page keeps the
               sleeve's own lightness and lands well above it. That gap is the
               whole effect — the surfaces read as related rather than as one
               flat field.
               A manual pick has no sampled source behind it. The pick IS the
               bar, so the page is derived from it with pageTone(), which lifts
               lightness while leaving hue and saturation alone. Using the pick
               raw here (what it did before) gave the page and the chrome the
               same value and collapsed the gap. */
            const npWashRgb = wrapperFixed
              ? theme.pageColour
              : (coverOverride
                ? pageWash(pageTone(coverOverride))
                : (npWashOn ? pageWash(autoRgb) : null));
            /* Aurora needs several colours at once. Any cover that yielded only
               one falls back to a single bloom rather than an empty layer. */
            const npAurora = (npWashOn && theme.coverColour === 'aurora'
              ? (npWashTheme.palette || []).slice(0, 4).map((c) => pageWash(c))
              : []);
            const rows = libRows;
            /* The docked Queue / Lyrics / Info panel used to force the search
               onto a row of its own, because the old header couldn't fit a
               title, a profile line, a search field and two actions side by
               side. The 52px bar can: it drops the count first, then the
               action labels, and keeps working down to a very narrow column —
               so the second layout is gone rather than maintained. */
            // playFromLibRows reads this so the queue matches what's on screen.
            libRowsRef.current = rows;
            const totalMs = rows.reduce((n, t) => n + (Number(t.duration) || 0) * 1000, 0);
            const acc = readableAccent(accent);
            return (
              <div className="sth-libpage" style={{
                display: 'flex', gap: 16, minHeight: 0, height: '100%',
                position: 'relative',
                /* Detail pages paint edge-to-edge (their own wash reaches the
                   corners); list views need the inset the wrapper used to
                   provide before is-page zeroed it. */
                /* 10px, not 18px. With the header no longer padding itself out
                   to 52px, the wrapper's own inset was the remaining source of
                   the gap above the title. */
                /* Compact drops the page title (see .is-compact .sth-libhead-tw),
                   so the top inset tightens with it and the controls row
                   becomes the first thing in the card. */
                padding: detailPage ? 0 : (compactMode ? '14px 24px 16px' : '28px 28px 20px'),
                boxSizing: 'border-box',
              }}>

                {/* ---- Now-playing wash ----
                    A SOLID colour gradient, exactly like the album and playlist
                    pages — not the blurred artwork. Same pageWash() treatment
                    of the same sampled tone, so all three surfaces are the same
                    colour system rather than two that resemble each other.
                    Fades out by the tracklist since this is a list, not a
                    record page that owns its whole background. */}
                {npWashRgb ? (
                  <>
                    {/* The constant tint. The gradient above it used to stop
                        dead at 430px — a line unrelated to anything on screen —
                        so the colour now continues underneath at low strength
                        and the fade reads as a falloff rather than an edge.
                        'full' turns this up and drops the gradient, which is
                        how the album and artist pages paint. */}
                    <div key={`tint-${npWashRgb}`} aria-hidden style={{
                      position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
                      background: wrapperFixed
                        ? `rgb(${npWashRgb})`
                        /* Full colour is the wash at full strength, not 62% of
                           it. The bar paints the same wash solid, so anything
                           under 1 guaranteed the page sat darker than the bar
                           showing the identical colour — 62% of a colour over
                           black is 62% of its brightness. Fade stays a trace,
                           because that one is meant to read as a hint. */
                        : `rgba(${npWashRgb},${pageMode === 'coverFull' ? 1 : 0.16})`,
                      animation: 'stFadeIn 0.6s ease both',
                    }} />
                    {pageMode !== 'coverFull' && !wrapperFixed ? (
                      <div key={npWashRgb} aria-hidden style={{
                        position: 'absolute', top: 0, left: 0, right: 0, height: 430, zIndex: 0, pointerEvents: 'none',
                        background: npAurora.length > 1
                          ? npAurora.map((c, i) => {
                            const spots = ['12% 0%', '86% 10%', '34% 46%', '96% 62%'];
                            const sizes = ['62% 58%', '54% 52%', '58% 48%', '48% 44%'];
                            return `radial-gradient(${sizes[i]} at ${spots[i]}, rgba(${c},0.80) 0%, rgba(${c},0) 100%)`;
                          }).join(', ')
                          : `linear-gradient(180deg, rgba(${npWashRgb},0.85) 0%, rgba(${npWashRgb},0.55) 26%, rgba(${npWashRgb},0.30) 58%, rgba(${npWashRgb},0) 100%)`,
                        WebkitMaskImage: npAurora.length > 1 ? 'linear-gradient(180deg, #000 0%, #000 46%, transparent 100%)' : 'none',
                        maskImage: npAurora.length > 1 ? 'linear-gradient(180deg, #000 0%, #000 46%, transparent 100%)' : 'none',
                        animation: 'stFadeIn 0.6s ease both',
                      }} />
                    ) : null}
                  </>
                ) : null}

                {/* ---- Rail ---- */}
                {/* Hairline between the rail and the table — without it the two
                    columns read as one loose block of text. */}
                {/* The library's own rail was removed — the persistent
                    sidebar on the left of the app replaces it, so the
                    content wrapper keeps its full width here. */}

                {/* ---- Content ---- */}
                {openArtist ? (
                  /* ---- Artist page ----
                     Full-bleed like the album page, and for the same reason:
                     it owns the whole content wrapper rather than sharing it
                     with a list it came from. */
                  <ArtistPage
                    artist={openArtist}
                    accent={accent}
                    theme={theme}
                    playEvents={playEvents}
                    currentTrack={currentTrack}
                    isPlaying={isPlaying}
                    onPlayTrack={onPlayTrack}
                    onTogglePlay={onTogglePlay}
                    onOpenAlbum={(key) => setLibDetail({ kind: 'album', key })}
                    onJumpToFind={openPalette}
                    spotifyBridge={mySpotifyBridge}
                    onBack={() => setLibDetail(null)}
                    following={isFollowing(openArtist)}
                    onToggleFollow={() => toggleFollow(openArtist)}
                    hasArtist={(n) => libArtists.some((a) => a.key === String(n || '').toLowerCase())}
                    onConnectSpotify={() => { pickSection('settings'); setSetCat('connections'); }}
                    onOpenRelated={(r) => openArtistAnywhere({ name: r.name, spotifyId: r.id, image: r.image })}
                    dlState={dlState}
                    dlProgress={dlProgress}
                    onGetTrack={downloadSpotifyRow}
                    ownedTrackFor={ownedTrackFor}
                  />
                ) : detailData ? (
                  /* ---- Album / playlist page ----
                     FULL-BLEED: the library rail hides while this is open, so
                     the page owns the whole content wrapper. It used to be a
                     third column beside the rail, which squeezed the tracklist
                     and left the artwork no room — that's why it read as
                     cramped next to the reference. */
                  (() => {
                    const dt = detailTheme;
                    /* The page's colour comes from the RECORD being viewed, not
                       from `accent` — that's sampled from whatever is currently
                       playing, so opening an album while a different song ran
                       painted the page in the wrong record's colour. */
                    /* 'fixed' uses the colour you chose; 'cover' samples the
                       artwork. Both go through pageWash so a fixed pick gets
                       the same saturation/lightness treatment and can't be set
                       to something unreadable. */
                    const wash = theme.detailMode === 'fixed'
                      ? pageWash(theme.detailColor)
                      /* Was `dt.mid || dt.accent` — the PREVIOUS colour
                         engine's average, written out inline here while the
                         now-playing bar had long since moved to the
                         perceptual one. On artwork the average handles badly
                         the two disagree completely, which is how a
                         near-black sleeve ended up on a muddy blue page.
                         recordWashSource takes the current engine's answer
                         and is shared with the grid cards. */
                      : pageWash(dt ? recordWashSource(dt) : accent);
                    /* Derived from the wash source, not from dt.wash. The
                       page lays the wash over this at 0.28 alpha by the
                       bottom, so `deep` is most of what's visible down there
                       — reading it off the old engine's average while the
                       wash came from the new one left the lower half of every
                       page painted in the wrong colour. */
                    const deep = dt ? recordDeep(dt) : '10, 10, 14';
                    const pageAcc = dt ? dt.accent : accent;
                    const pageAccUI = readableAccent(pageAcc);
                    /* Same columns for both kinds now. The album name earns a
                       column once the artwork is stated once in the header
                       instead of repeated on every row. */
                    /* Brief, Detail pages: stop repeating what the page already
                       said. On an album the ALBUM column goes entirely, and the
                       per-row artist goes when every track shares one; the freed
                       space becomes a PLAYS column when that setting is on. A
                       playlist genuinely needs artist and album, so it keeps both. */
                    const oneArtist = detailData.kind === 'album'
                      && new Set(detailData.tracks.map((t) => (t.artist || '').toLowerCase())).size <= 1;
                    const showAlbumCol = detailData.kind !== 'album';
                    const showPlaysCol = showPlayCounts && detailData.kind === 'album';
                    const cols = [
                      '44px',
                      'minmax(200px,2.4fr)',
                      showAlbumCol ? 'minmax(140px,1.5fr)' : null,
                      showPlaysCol ? '72px' : null,
                      '72px',
                      '52px',
                    ].filter(Boolean).join(' ');
                    const totalMs = detailData.tracks.reduce((n, t) => n + (Number(t.duration) || 0) * 1000, 0);
                    return (
                      <div style={{
                        position: 'relative', flex: 1, minWidth: 0, minHeight: 0, height: '100%',
                        display: 'flex', flexDirection: 'column', overflow: 'hidden',
                        /* No radius of its own — the wrapper already rounds the
                           corners, and a second one drew a panel inside a panel. */
                      }}>
                        {/* The wash. Full strength at the top, settling as it
                            descends — the reference is a real colour field, not
                            a tint, so this never resolves to black. */}
                        <div aria-hidden style={{
                          position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
                          /* Stronger and no black veil over the top. The veil
                             that used to sit here dragged every colour toward
                             brown-grey, which is why the page never looked like
                             the reference's saturated field. Contrast for the
                             text comes from `deep` at the bottom instead. */
                          /* Holds colour the whole way down. It used to land on
                             `deep` at 0.96 by the bottom, which is effectively
                             black — the reference stays a blue field behind the
                             entire tracklist, only settling slightly. */
                          background: `linear-gradient(180deg, rgba(${wash},0.85) 0%, rgba(${wash},0.55) 26%, rgba(${wash},0.34) 58%, rgba(${wash},0.28) 100%), rgba(${deep},0.72)`,
                        }} />

                        {/* Back floats in the top-RIGHT corner. Out of flow
                            either way — in the column it pushed the artwork and
                            title down by its own height for a control that
                            isn't part of the record. */}
                        <button type="button" onClick={() => setLibDetail(null)} title="Back" aria-label="Back"
                          style={{
                            position: 'absolute', top: 14, right: 16, zIndex: 3,
                            width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            borderRadius: '50%', border: 'none', cursor: 'pointer',
                            background: 'rgba(0,0,0,0.34)', color: 'rgba(var(--st-text-rgb), 0.85)',
                          }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
                        </button>

                        <div style={{ position: 'relative', zIndex: 1, /* 22px top, not 54: that clearance existed for the arrow when it sat
                           in the top-LEFT. It's on the right now, so the header
                           can start near the top of the page. */
                        display: 'flex', gap: 26, padding: '22px 22px 0', minHeight: 0, flex: 1 }}>
                          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>

                            {/* Artwork sits WITH the title. It used to float in a
                                card on the right while every track row repeated
                                the same 42px thumbnail — the art belongs to the
                                record, so it's stated once, here. */}
                            {/* Alignment is a setting while we compare. The text
                                block is shorter than the 150px cover, so the
                                leftover height has to land somewhere: flex-end
                                puts it above (label mid-artwork), flex-start
                                below, centre splits it. */}
                            <div style={{ display: 'flex', alignItems: detailAlign, gap: 24 }}>
                              {/* On a playlist the artwork IS the cover control —
                                  clicking it opens the picker. Discoverable
                                  where you'd actually reach for it, rather than
                                  as one icon among five in the action row. */}
                              <div
                                onClick={detailData.kind === 'playlist' ? () => setPlCoverFor(libDetail.key) : undefined}
                                title={detailData.kind === 'playlist' ? 'Change cover' : undefined}
                                className={detailData.kind === 'playlist' ? 'sth-plcover' : undefined}
                                style={{
                                  position: 'relative', width: 190, height: 190, borderRadius: 9, flexShrink: 0, overflow: 'hidden',
                                  cursor: detailData.kind === 'playlist' ? 'pointer' : 'default',
                                  background: detailData.art ? `url("${detailData.art}") center/cover` : `linear-gradient(140deg, rgba(${wash},0.7), rgba(${wash},0.25))`,
                                  /* The fullscreen stage's artBoxShadow, exactly.
                                     I'd used an OFFSET drop shadow last time —
                                     the stage uses two centred halos with no
                                     offset (tight 5px, then 13px spread 7),
                                     which radiates evenly on all sides instead
                                     of pooling below. That's the glow, and the
                                     zero-blur ring is what stops it banding on
                                     a dark background. */
                                  /* Softened from the stage's values. There the
                                     artwork is the whole screen against a dark
                                     backdrop and can carry a heavy halo; here
                                     it sits beside text on a coloured wash, so
                                     the same opacities read as a dark smear
                                     around it. Same geometry, lighter. */
                                  /* No white ring or lit top edge. Those help on
                                     the fullscreen stage, where the artwork
                                     floats alone — but on art that's already
                                     light at the edges, or has a white border of
                                     its own, they read as a stray outline. The
                                     halo alone separates it from the wash. */
                                  boxShadow: [
                                    '0 0 5px 1px rgba(0,0,0,0.52)',
                                    '0 0 14px 6px rgba(0,0,0,0.48)',
                                  ].join(', '),
                                }}>
                                {detailData.kind === 'playlist' ? (
                                  <div className="sth-plcover-veil">
                                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
                                    </svg>
                                    <span style={{ fontSize: 11.5, fontWeight: 650, marginTop: 7 }}>Change cover</span>
                                  </div>
                                ) : null}
                              </div>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(var(--st-sub-rgb), 0.6)' }}>
                                  {detailData.kind === 'album' ? 'Album' : 'Playlist'}
                                </div>
                                {/* Scales with the cover: at 35px against 190px
                                    artwork the title read as a caption beside a
                                    picture rather than the page's subject. */}
                                <div style={{ fontSize: 44, fontWeight: 800, color: 'var(--st-text)', letterSpacing: '-0.025em', lineHeight: 1.05, marginTop: 7 }}>{detailData.title}</div>
                                <div style={{ fontSize: 14, color: 'rgba(var(--st-sub-rgb), 0.62)', marginTop: 11 }}>
                                  By{' '}
                                  {/* The credit is a link, not a caption — an
                                      artist name should be a way to their page
                                      from wherever it appears. Falls back to
                                      plain text for playlists and for credits
                                      that don't resolve to a library artist. */}
                                  {(() => {
                                    const who = detailData.kind === 'album' ? String(detailData.by || '') : '';
                                    const hit = who
                                      ? libArtists.find((a) => who.toLowerCase().startsWith(a.key))
                                      : null;
                                    if (!hit) return <span style={{ color: 'var(--st-text)', fontWeight: 600 }}>{detailData.by}</span>;
                                    return (
                                      <button type="button" onClick={() => setLibDetail({ kind: 'artist', key: hit.key })}
                                        title={`Go to ${hit.name}`}
                                        style={{ border: 'none', background: 'transparent', padding: 0, font: 'inherit', fontSize: 14, fontWeight: 600, color: 'var(--st-text)', cursor: 'pointer', textDecorationColor: 'rgba(var(--st-fg-rgb), 0.4)', textUnderlineOffset: 3 }}
                                        onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
                                        onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}>
                                        {detailData.by}
                                      </button>
                                    );
                                  })()}
                                  {` · ${detailData.tracks.length} songs${formatTotalMs(totalMs) ? ` · ${formatTotalMs(totalMs)}` : ''}`}
                                </div>
                                {detailGenres.length ? (
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 11 }}>
                                    {detailGenres.map((g) => (
                                      <span key={g} style={{ fontSize: 12, padding: '6px 14px', borderRadius: 999, background: 'rgba(var(--st-fg-rgb), 0.10)', border: '1px solid rgba(var(--st-fg-rgb), 0.08)', color: 'rgba(var(--st-text-rgb), 0.78)' }}>{g}</span>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '16px 0 14px' }}>
                              {/* 48px, 12px radius — a rounded square like every
                                  other control (brief, radius scale). */}
                              <button type="button" onClick={() => onPlayTrack?.(detailData.tracks[0], detailData.tracks)}
                                title="Play" aria-label={`Play ${detailData.title}`}
                                style={{
                                  width: 48, height: 48, borderRadius: 12, border: 'none', cursor: 'pointer',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                                  background: 'var(--accent)', color: 'var(--accent-ink)',
                                }}>
                                <PlayIcon size={18} />
                              </button>
                              <DetailAction title="Shuffle" onClick={() => { const sh = [...detailData.tracks].sort(() => Math.random() - 0.5); onPlayTrack?.(sh[0], sh); }}>
                                <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
                              </DetailAction>
                              {/* Add-to-playlist and Add-songs removed from this
                                  row. Adding is per-track work and now lives in
                                  the right-click menu, where you're already
                                  pointing at the track you mean. */}
                              {detailData.kind === 'album' && onUpdateAlbumMetadata ? (
                                /* Opens the SAME AlbumMetadataEditor the overlay
                                   uses — album name, artist, year, genre, cover,
                                   explicit — applied across every track on the
                                   record. It was built and only ever wired to
                                   the overlay. */
                                <DetailAction title="Edit album details" onClick={() => setAlbumEditScope({
                                  key: libDetail.key,
                                  album: detailData.title,
                                  artist: detailData.by,
                                  coverArt: detailData.art,
                                  sampleTrack: detailData.tracks[0],
                                  trackIds: detailData.tracks.map((t) => t.id),
                                  discNumber: null,
                                })}>
                                  <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
                                </DetailAction>
                              ) : null}
                              {detailData.kind === 'playlist' ? (
                                <>
                                  <DetailAction title="Edit playlist" onClick={() => setRenamePl({ id: libDetail.key, name: detailData.title })}>
                                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
                                  </DetailAction>
                                  {/* Destructive delete moved into the overflow —
                                      it used to sit two icons from Play. */}
                                  <DetailAction title="More" onClick={() => setDetailMore((v) => !v)}>
                                    <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="2.6" />
                                  </DetailAction>
                                  {detailMore ? (
                                    <span style={{ position: 'relative' }}>
                                      <span style={{ position: 'absolute', top: 6, left: -60, zIndex: 20, width: 210, padding: 5, borderRadius: 12, background: '#000', border: '1px solid var(--border)', boxShadow: '0 22px 60px rgba(0,0,0,0.7)' }}>
                                        <button type="button" className="sth-mi" style={{ color: 'var(--danger)' }}
                                          onClick={() => { setDetailMore(false); setDeletePl({ id: libDetail.key, name: detailData.title }); }}>
                                          Delete playlist
                                        </button>
                                      </span>
                                    </span>
                                  ) : null}
                                </>
                              ) : null}
                              <div style={{ flex: 1 }} />
                              {/* An icon, not a permanent field. The reference
                                  keeps a bare magnifier here; a bordered input
                                  made filtering look like the loudest control on
                                  a page whose job is the tracklist. Expands on
                                  click, collapses when emptied and blurred. */}
                              {/* A labelled field, not a bare magnifier floating
                                  at the right of the row (brief). */}
                              <label className="sth-findfield">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
                                <input value={detailFilter}
                                  onChange={(e) => setDetailFilter(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === 'Escape') setDetailFilter(''); }}
                                  placeholder={`Find in ${detailData.kind === 'album' ? 'album' : 'playlist'}`}
                                  aria-label={`Find in ${detailData.kind === 'album' ? 'album' : 'playlist'}`} />
                              </label>
                            </div>

                            <div className="sth-ltable" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                              <div className="sth-lrow sth-lrow-head" style={{ gridTemplateColumns: cols }}>
                                <div>#</div>
                                <div>Title</div>
                                {showAlbumCol ? <div className="sth-lcol-album">Album</div> : null}
                                {showPlaysCol ? <div style={{ textAlign: 'right' }}>Plays</div> : null}
                                <div style={{ textAlign: 'right' }}>Time</div>
                                <div />
                              </div>
                              <div className="sth-libscroll sth-lfade" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                                {detailTracks.map((t, i) => {
                                  const playing = currentTrack?.id === t.id;
                                  return (
                                    <div key={t.id} className={`sth-lrow${playing ? ' is-playing' : ''}`}
                                      /* 40px art + 7px padding ≈ 56px rows. I had
                                         tightened these to 38px against a much
                                         smaller screenshot; measured against the
                                         full-size reference and scaled to this
                                         window, 57px is the real figure. */
                                      style={{ gridTemplateColumns: cols, padding: '7px 8px' }}
                                      onDoubleClick={() => onPlayTrack?.(t, detailTracks)}
                                      onContextMenu={canManage ? (e) => openRowMenu(e, t) : undefined}>
                                      <div className="sth-lrow-n" style={{ height: 42 }} {...hoverPreload(t)}>
                                        {playing
                                          ? <PlayingBars acc={pageAccUI} playing={isPlaying} />
                                          : <span className="sth-lrow-num">{detailData.kind === 'album' ? (t.trackNumber || i + 1) : i + 1}</span>}
                                        <RowPlayButton
                                          playing={playing} isPlaying={isPlaying} title={t.title}
                                          onPlay={() => onPlayTrack?.(t, detailTracks)} onTogglePlay={onTogglePlay}
                                        />
                                      </div>
                                      {/* No per-row artwork: on an album every
                                          thumbnail is the same image, and the
                                          header states it once at 150px. */}
                                      <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                                        <div style={{ minWidth: 0 }}>
                                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                                            <span style={{ fontSize: 15, fontWeight: 600, color: playing ? `rgb(${pageAccUI})` : '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
                                            {t.explicit ? <ExplicitBadge /> : null}
                                          </div>
                                          {oneArtist ? null : (
                                            <div style={{ fontSize: 13, color: 'rgba(var(--st-sub-rgb), 0.5)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.artist}</div>
                                          )}
                                        </div>
                                      </div>
                                      {showAlbumCol ? <div className="sth-lrow-dim sth-lcol-album">{t.album}</div> : null}
                                      {showPlaysCol ? <div className="sth-lrow-dim st-num" style={{ textAlign: 'right' }}>{playCountFor(t.id)}</div> : null}
                                      <div className="sth-lrow-dim st-num" style={{ textAlign: 'right' }}>{formatTime(t.duration)}</div>
                                      <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
                                        {onToggleFavorite ? (
                                          /* Always visible — a heart you can't see
                                             is a heart whose state you can't read. */
                                          <button type="button" className="sth-lrow-more" onClick={() => onToggleFavorite(t.id)}
                                            title={t.isFavorite ? 'Remove from favourites' : 'Add to favourites'}
                                            style={{ opacity: 1, color: t.isFavorite ? `rgb(${pageAccUI})` : 'rgba(var(--st-fg-rgb), 0.4)' }}>
                                            <svg width="15" height="15" viewBox="0 0 24 24" fill={t.isFavorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                              <path d="M20.8 8.6a5 5 0 0 0-8.8-2.6A5 5 0 0 0 3.2 8.6c0 4.2 5.5 7.6 8.8 10.4 3.3-2.8 8.8-6.2 8.8-10.4z" />
                                            </svg>
                                          </button>
                                        ) : null}
                                        {detailData.kind === 'playlist' && onRemoveFromPlaylist ? (
                                          <button type="button" className="sth-lrow-more" onClick={() => onRemoveFromPlaylist(libDetail.key, t.id)}
                                            title="Remove from playlist">
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                                          </button>
                                        ) : null}
                                      </div>
                                    </div>
                                  );
                                })}
                                <div style={{ height: 14 }} />
                              </div>
                            </div>
                          </div>

                        </div>
                      </div>
                    );
                  })()
                ) : view === 'artists' ? (
                  /* ---- Artist grid ----
                     Portraits of people, in tiles shaped for portraits. See
                     ArtistGrid.jsx for why this stopped being album art in
                     circles. */
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                    <LibHeader
                      title="Artists"
                      meta={`${libArtists.length} in your library`}
                      filter={libFilter}
                      onFilter={setLibFilter}
                      searchPlaceholder="Search artists"
                      acc={acc}
                      onImportFiles={onImportFiles}
                      onImportFolder={onImportFolder}
                      onImportSpotify={onImportSpotify}
                      importing={importing}
                    />
                    <div className="sth-libscroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                      <ArtistGrid
                        artists={filteredLibArtists}
                        accent={acc}
                        playEvents={playEvents}
                        onOpen={(k) => setLibDetail({ kind: 'artist', key: k })}
                        onPlay={(a) => { if (a.tracks?.length) onPlayTrack?.(a.tracks[0], a.tracks); }}
                        emptyNote={libFilter.trim() ? `No artists match \u201C${libFilter.trim()}\u201D.` : undefined}
                      />
                      <div style={{ height: 16 }} />
                    </div>
                  </div>
                ) : view === 'albums' ? (
                  /* ---- Album grid ----
                     The albums view was a flat track list sorted by album name,
                     which made a record's identity invisible. Cards, then drill
                     in. */
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                    <LibHeader
                      title="Albums"
                      meta={`${libAlbums.length} in your library`}
                      filter={libFilter}
                      onFilter={setLibFilter}
                      searchPlaceholder="Search albums"
                      acc={acc}
                      onImportFiles={onImportFiles}
                      onImportFolder={onImportFolder}
                      onImportSpotify={onImportSpotify}
                      importing={importing}
                    />
                    <div className="sth-libscroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                      {/* auto-fill, so a wider window gains columns rather than
                          gaps (brief, Albums). */}
                      <div className="sth-alb-grid" style={{ padding: '4px 3px 18px' }}>
                        {libAlbums.map((a) => (
                          <button key={a.key} type="button" className="sth-alb" style={{ textAlign: 'left' }}
                            onClick={() => setLibDetail({ kind: 'album', key: a.key })}>
                            <div className="sth-albart" style={{ width: '100%', aspectRatio: '1' }}>
                              {a.art ? <div className="sth-albimg" style={{ backgroundImage: `url("${a.art}")` }} /> : null}
                              {/* Fades in over the artwork's lower right. */}
                              <span className="sth-alb-play" title={`Play ${a.name}`} aria-hidden
                                onClick={(e) => { e.stopPropagation(); if (a.tracks?.length) onPlayTrack?.(a.tracks[0], a.tracks); }}>
                                <PlayIcon size={16} />
                              </span>
                            </div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginTop: 12, lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</div>
                            <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-faint)', marginTop: 4, lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {a.artist} · {a.tracks.length} track{a.tracks.length === 1 ? '' : 's'}
                            </div>
                          </button>
                        ))}
                      </div>
                      <div style={{ height: 16 }} />
                    </div>
                  </div>
                ) : (
                <div style={{ flex: 1, minWidth: 0, width: '100%', maxWidth: 1240, margin: '0 auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                  {/* Capped and centred.
                      Uncapped, the table's fr ratios hand the title column far
                      more width than its content needs, so past roughly 1200px
                      the gap between Title and Artist opens up while the rows
                      themselves stay the same — the list looks sparse and the
                      header looks stretched. Both get worse with the queue and
                      lyrics panels closed, which is exactly when there's most
                      width to absorb. 1240px is about where the columns stop
                      improving; past it the extra space becomes margin. */}
                  {/* One compact bar for every library view — see LibHeader. */}
                  <LibHeader
                    title={libTitle}
                    meta={`${rows.length} song${rows.length === 1 ? '' : 's'}${formatTotalMs(totalMs) ? ` · ${formatTotalMs(totalMs)}` : ''}`}
                    filter={libFilter}
                    onFilter={setLibFilter}
                    searchPlaceholder="Search songs"
                    sortValue={libRowSort}
                    sortField={libSortField}
                    onPickSort={pickLibRowSort}
                    onPlayAll={rows.length ? () => onPlayTrack?.(rows[0], rows) : null}
                    onShuffle={rows.length ? () => { const sh = [...rows].sort(() => Math.random() - 0.5); onPlayTrack?.(sh[0], sh); } : null}
                    acc={acc}
                    onImportFiles={onImportFiles}
                    onImportFolder={onImportFolder}
                    onImportSpotify={onImportSpotify}
                    importing={importing}
                  />

                  {rows.length ? (
                    <div className={`sth-ltable${showDateAdded ? '' : ' no-date'}${libAzIndex ? ' has-az' : ''}`} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                      <div className="sth-lrow sth-lrow-head">
                        <div>#</div>
                        <div>Title</div>
                        <div>Artist</div>
                        <div className="sth-lcol-album">Album</div>
                        <div className="sth-lcol-date">Date added</div>
                        <div style={{ textAlign: 'center' }}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: 'middle' }}>
                            <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
                          </svg>
                        </div>
                        <div />
                      </div>
                      {(() => {
                        /* Clamp the scroll offset to what this list can
                           actually scroll to before slicing.
                           libScrollTop is React state mirroring the element's
                           scrollTop, and the two can disagree for a frame or
                           more: on remount, when the list changes length
                           underneath a reused node, or when a re-render lands
                           before onScroll has reported. An offset larger than
                           the new content means `first` runs past the end,
                           slice() returns nothing, and the table renders as a
                           tall empty spacer — blank until any scroll resyncs
                           the two. Clamping means the worst case is showing
                           the wrong page, never no page. */
                        const maxTop = Math.max(0, rows.length * LIB_ROW_H - libViewH);
                        const top = Math.min(Math.max(0, libScrollTop), maxTop);
                        const first = Math.max(0, Math.floor(top / LIB_ROW_H) - LIB_OVERSCAN);
                        const last = Math.min(rows.length, Math.ceil((top + Math.max(libViewH, LIB_ROW_H)) / LIB_ROW_H) + LIB_OVERSCAN);
                        const slice = rows.slice(first, last);
                        return (
                          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row' }}>
                          <div
                            ref={libScrollRef}
                            className="sth-libscroll sth-lfade"
                            style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto' }}
                            onScroll={(e) => setLibScrollTop(e.currentTarget.scrollTop)}
                          >
                            {/* Spacers stand in for the rows that aren't mounted,
                                so the scrollbar reflects the whole list. */}
                            <div style={{ height: first * LIB_ROW_H }} />
                            {slice.map((t, i) => (
                              <LibRow
                                key={t.id}
                                t={t}
                                index={first + i}
                                playing={currentTrack?.id === t.id}
                                isPlaying={isPlaying}
                                acc={acc}
                                art={coverFor(t)}
                                added={fmtAdded(t.addedAt)}
                                canManage={canManage}
                                onPlay={playFromLibRows}
                                onTogglePlay={onTogglePlay}
                                onMenu={openRowMenu}
                                onOpenArtist={openArtistFromRow}
                                onOpenAlbum={openAlbumFromRow}
                              />
                            ))}
                            <div style={{ height: Math.max(0, (rows.length - last) * LIB_ROW_H) + 12 }} />
                          </div>

                      {/* A–Z rail — a flex SIBLING of the scroll area, not an
                          overlay on it. Absolute positioning inside .sth-ltable
                          meant it spanned the header row as well (so the rail
                          started level with "TITLE" instead of the first song)
                          and sat on top of the scrollbar. As a sibling it gets
                          its own column beside the scrollbar and inherits
                          exactly the scrolling area's height, which is the
                          range the letters actually address.

                          Scrolls by row index rather than scrollIntoView: the
                          rows are virtualised, so the target row usually isn't
                          mounted to scroll to. */}
                      {libAzIndex ? (
                        <div className="sth-azrail" role="navigation" aria-label="Jump to letter">
                          {['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((L) => {
                            const at = libAzIndex.get(L);
                            const has = at !== undefined;
                            return (
                              <button
                                key={L}
                                type="button"
                                tabIndex={-1}
                                className={has ? 'has' : 'no'}
                                aria-hidden={!has}
                                title={has ? `Jump to ${L}` : undefined}
                                onClick={has ? () => {
                                  const el = libScrollElRef.current;
                                  if (!el) return;
                                  const top = at * LIB_ROW_H;
                                  el.scrollTop = top;
                                  // onScroll will fire too, but setting it
                                  // here means the correct slice renders on
                                  // this frame rather than the next one.
                                  setLibScrollTop(top);
                                } : undefined}
                              >{L}</button>
                            );
                          })}
                        </div>
                      ) : null}
                          </div>
                        );
                      })()}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12.5, color: 'rgba(var(--st-sub-rgb), 0.4)', lineHeight: 1.6, paddingTop: 8 }}>
                      {library.length
                        ? (view === 'songs' && libFilter.trim()
                          ? `No songs match “${libFilter.trim()}”.`
                          : 'Nothing here yet.')
                        : 'Your library is empty. Import music from Home, or drag files onto the window.'}
                    </div>
                  )}
                </div>
                )}
              </div>
            );
          })() : null}



          {/* ================= SETTINGS ================= */}
          {sec === 'settings' ? (() => {
            /* Brief, Settings: Playback and Discord merged into one System page
               (a navigation change — flagged in the brief for confirmation).
               Old stored categories map onto it. */
            const cat = setCat === 'playback' || setCat === 'discord' ? 'system' : setCat;
            const CATS = {
              colour: ['Color', 'Which surfaces take their colour from the artwork, and how strongly.'],
              layout: ['Layout', 'How pages and lists are arranged.'],
              library: ['Library', 'What the song table shows, and managing the library itself.'],
              system: ['System', 'Playback behaviour and what studio shares with Discord.'],
              connections: ['Connections', 'Services studio uses for search, metadata and downloads.'],
            };
            const navBtn = (id, label, icon) => (
              <button key={id} type="button" className={`sth-set-navi${cat === id ? ' on' : ''}`} aria-current={cat === id ? 'page' : undefined} onClick={() => setSetCat(id)}>
                <svg viewBox="0 0 24 24" aria-hidden>{icon}</svg>{label}
              </button>
            );
            const dim = npAnimatedBg ? { opacity: 0.4, pointerEvents: 'none' } : undefined;
            const ACCENT_SWATCHES = [['255, 122, 89', 'Coral'], ['120, 170, 255', 'Blue'], ['123, 224, 176', 'Mint'], ['214, 150, 255', 'Violet']];
            return (
              <div className="sth-set-wrap">
                <nav className="sth-set-rail" aria-label="Settings categories">
                  <div className="lbl st-eyebrow">Appearance</div>
                  {navBtn('colour', 'Color', <><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 0 18" /></>)}
                  {navBtn('layout', 'Layout', <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>)}
                  {navBtn('library', 'Library', <path d="M4 6h16M4 12h16M4 18h10" />)}
                  <div className="lbl st-eyebrow">System</div>
                  {navBtn('system', 'System', <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>)}
                  {navBtn('connections', 'Connections', <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>)}
                </nav>

                <div className="sth-set-body">
                  <div style={{ marginBottom: 20 }}>
                    <h1 className="st-page-title">{CATS[cat]?.[0]}</h1>
                    <p style={{ fontSize: 14, color: 'var(--text-dim)', margin: '8px 0 0' }}>{CATS[cat]?.[1]}</p>
                  </div>

                  {cat === 'colour' ? (
                    <div className="sth-set-list">
                      <SetRow title="Immerse" note="A slow gradient made from the artwork, behind the Now Playing bar and side panel. Overrides both settings below." wide={false}>
                        <SetToggle label="Immerse" on={npAnimatedBg} onToggle={toggleNpAnimatedBg} />
                      </SetRow>
                      <SetRow title="Library pages" note="Background for Songs, Albums and Artists. Cover Art tints the top of the list; Full Color carries it all the way down.">
                        <SetSeg label="Library pages" value={theme.pageSurface} onPick={(v) => setThemeKey('pageSurface', v)}
                          options={[['off', 'Off'], ['colour', 'Color'], ['cover', 'Cover art'], ['coverFull', 'Full color']]} />
                        {theme.pageSurface === 'colour' ? (
                          <span className="sth-set-sub"><StudioColorPicker title="Library page color" value={rgbToHex(theme.pageColour)}
                            onChange={(hex) => { const v = hexToRgb(hex); if (v) setThemeKey('pageColour', v); }}
                            onReset={() => setThemeKey('pageColour', THEME_DEFAULTS.pageColour)} /></span>
                        ) : null}
                      </SetRow>
                      <SetRow title="Side panel" note={npAnimatedBg ? 'Immerse is showing the artwork here.' : 'Background for the Queue, Lyrics and Info panel. Match Bar reuses the Now Playing bar surface so the two read as one piece.'}>
                        <span style={{ display: 'contents', ...dim }}>
                          <SetSeg label="Side panel" value={theme.panelSurface} onPick={(v) => setThemeKey('panelSurface', v)}
                            options={[['black', 'Black'], ['colour', 'Color'], ['cover', 'Cover art'], ['bar', 'Match bar']]} />
                        </span>
                        {theme.panelSurface === 'colour' && !npAnimatedBg ? (
                          <span className="sth-set-sub"><StudioColorPicker title="Panel color" value={rgbToHex(theme.panelColour)}
                            onChange={(hex) => { const v = hexToRgb(hex); if (v) setThemeKey('panelColour', v); }}
                            onReset={() => setThemeKey('panelColour', THEME_DEFAULTS.panelColour)} /></span>
                        ) : null}
                      </SetRow>
                      <SetRow title="Now Playing bar" note={npAnimatedBg ? 'Immerse is showing the artwork here.' : 'Background for the bar along the bottom. Cover Art follows whatever is playing; Color stays fixed.'}>
                        <span style={{ display: 'contents', ...dim }}>
                          <SetSeg label="Now Playing bar" value={theme.barSurface} onPick={(v) => setThemeKey('barSurface', v)}
                            options={[['colour', 'Color'], ['cover', 'Cover art']]} />
                        </span>
                        {theme.barSurface === 'colour' && !npAnimatedBg ? (
                          <span className="sth-set-sub"><StudioColorPicker title="Now Playing bar color" value={npBarColor}
                            onChange={pickNpBarColor} onReset={() => pickNpBarColor(NP_BAR_DEFAULT)} /></span>
                        ) : null}
                      </SetRow>
                      <SetRow title="Colour intensity" note="How saturated cover colours get. Off is greyscale; Full is the strongest and makes faint text harder to read.">
                        <SetSeg label="Colour intensity" value={theme.colourIntensity} onPick={(v) => setThemeKey('colourIntensity', v)}
                          options={[['off', 'Off'], ['muted', 'Muted'], ['balanced', 'Balanced'], ['vivid', 'Vivid'], ['full', 'Full']]} />
                      </SetRow>
                      <SetRow title="Accent" note="The colour used for buttons, toggles, the scrubber and focus rings. White is the default and reads on every surface; Follow artwork matches it to whatever is playing; Fixed pins one colour of your choosing.">
                        <SetSeg label="Accent" value={accentMode} onPick={pickAccentMode}
                          options={[['white', 'White'], ['artwork', 'Follow artwork'], ['fixed', 'Fixed']]} />
                        {accentMode === 'fixed' ? (
                          <span className="sth-set-sub" role="radiogroup" aria-label="Fixed accent colour" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                            {ACCENT_SWATCHES.map(([rgb, name]) => (
                              <button key={rgb} type="button" role="radio" aria-checked={accentFixed === rgb} aria-label={name} title={name}
                                onClick={() => pickAccentFixed(rgb)}
                                style={{ height: 30, borderRadius: 8, border: 'none', cursor: 'pointer', background: `rgb(${rgb})`,
                                  boxShadow: accentFixed === rgb ? '0 0 0 2px var(--surface), 0 0 0 4px #fff' : 'none' }} />
                            ))}
                          </span>
                        ) : null}
                      </SetRow>
                    </div>
                  ) : null}

                  {cat === 'layout' ? (
                    <div className="sth-set-list">
                      <SetRow title="Album and playlist pages" note="Where these pages take their background. Cover Art follows each release; Fixed uses one shade for all of them.">
                        <SetSeg label="Album and playlist pages" value={theme.detailMode} onPick={(v) => setThemeKey('detailMode', v)}
                          options={[['cover', 'Cover art'], ['fixed', 'Fixed']]} />
                        {theme.detailMode === 'fixed' ? (
                          <span className="sth-set-sub"><StudioColorPicker title="Page color" value={rgbToHex(theme.detailColor)}
                            onChange={(hex) => { const v = hexToRgb(hex); if (v) setThemeKey('detailColor', v); }} /></span>
                        ) : null}
                      </SetRow>
                      <SetRow title="Album header alignment" note="Where the title and artist sit relative to the cover art.">
                        <SetSeg label="Album header alignment" value={detailAlign} onPick={pickDetailAlign}
                          options={[['flex-start', 'Top'], ['center', 'Center'], ['flex-end', 'Bottom']]} />
                      </SetRow>
                      <SetRow title="Active tab marker" note="How the sidebar shows which library tab you are on.">
                        <SetSeg label="Active tab marker" value={navStyle === 'glow' ? 'chip' : navStyle} onPick={setNavStylePref}
                          options={[['chip', 'Chip'], ['bar', 'Bar'], ['underline', 'Underline'], ['dot', 'Dot']]} />
                      </SetRow>
                      <SetRow title="Window layout" note="Compact gives the whole window to the page you're on, with the Now Playing bar full width underneath. Touch the top or left edge to bring back the top bar or the library. Ctrl+Shift+C switches.">
                        <SetSeg label="Window layout" value={compactMode ? 'compact' : 'standard'} onPick={(v) => pickCompactMode(v === 'compact')}
                          options={[['standard', 'Standard'], ['compact', 'Compact']]} />
                      </SetRow>
                      <SetRow title="Compact bar visualizer" note="Fills the empty middle of the library bar in compact mode. Follows local files and Saved Spotify songs alike, and stays still when paused or when reduced motion is on.">
                        <CompactVizPicker value={compactViz} onPick={pickCompactViz} palette={npWashTheme?.palette} accent={rawAccent} coverColours={compactVizCover} />
                      </SetRow>
                      <SetRow title="Visualizer colours from the cover" note="On, the visualizer takes its colours from the album playing. Off, it's drawn in white, whatever the album." wide={false}>
                        <SetToggle label="Visualizer colours from the cover" on={compactVizCover} onToggle={toggleCompactVizCover} />
                      </SetRow>
                      <SetRow title="Notifications" note="Where notifications appear. Own lane makes room for them so they never cover anything; the player bar option shows them over the song info for a moment. Hover a notification to hold it.">
                        <ToastPositionPicker />
                      </SetRow>
                      <SetRow title="List density" note="Row height in Songs, albums and playlists. Compact fits about half again as many rows on screen.">
                        <SetSeg label="List density" value={listDensity} onPick={pickListDensity}
                          options={[['compact', 'Compact'], ['default', 'Default'], ['roomy', 'Roomy']]} />
                      </SetRow>
                    </div>
                  ) : null}

                  {cat === 'library' ? (
                    <>
                      <div className="sth-set-list">
                        <SetRow title="Date added column" note="Shows when each track joined your library. Hiding it gives the space to Title, Artist and Album." wide={false}>
                          <SetToggle label="Date added column" on={showDateAdded} onToggle={toggleDateAdded} />
                        </SetRow>
                        <SetRow title="Play counts in lists" note="Adds a plays column to album and artist pages. Stats always counts plays either way." wide={false}>
                          <SetToggle label="Play counts in lists" on={showPlayCounts} onToggle={toggleShowPlayCounts} />
                        </SetRow>
                      </div>
                      {onClearLibrary || onClearEverything ? (
                        <>
                          <h2 className="st-section-title" style={{ fontSize: 16, margin: '36px 0 12px' }}>Danger zone</h2>
                          {onClearLibrary ? (
                            <div className="sth-danger">
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <b>Clear library</b>
                                <p>Removes every track, playlist and album note from studio. Your listening history is kept, so re-importing a song brings its play count back.</p>
                              </div>
                              <button type="button" className="st-btn st-btn-danger" disabled={clearing} onClick={() => setClearConfirm({ deleteFiles: false })}>
                                {clearing ? 'Clearing…' : 'Clear library'}
                              </button>
                            </div>
                          ) : null}
                          {onClearEverything ? (
                            <div className="sth-danger">
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <b>Delete everything</b>
                                <p>Wipes the library, playlists, album notes and all listening history, then returns studio to its first-run setup screen.</p>
                              </div>
                              <button type="button" className="st-btn st-btn-danger" disabled={clearingAll} onClick={() => setClearAllConfirm({ deleteFiles: false })}>
                                {clearingAll ? 'Deleting…' : 'Delete everything'}
                              </button>
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </>
                  ) : null}

                  {cat === 'system' ? (
                    <>
                      <div className="st-eyebrow sth-set-subhead">Playback</div>
                      <div className="sth-set-list">
                        {onSetTransitionMode ? (
                          <SetRow title="Gapless playback" note="Removes the silence between tracks. Best on live albums and continuous mixes." wide={false}>
                            <SetToggle label="Gapless playback" on={transitionMode === 'gapless'}
                              onToggle={() => onSetTransitionMode(transitionMode === 'gapless' ? 'none' : 'gapless')} />
                          </SetRow>
                        ) : null}
                      </div>
                      {onSetDiscordPresenceEnabled ? (
                        <>
                          <div className="st-eyebrow sth-set-subhead" style={{ marginTop: 32 }}>Discord</div>
                          <div className="sth-set-list">
                            <SetRow title="Rich presence" wide={false}
                              note={discordPresenceEnabled
                                ? (discordStatus?.unavailable ? 'Enabled, but this build is missing the Discord module.'
                                  : discordStatus?.connected ? 'Connected. Your profile shows what studio is playing.'
                                    : 'Waiting for the Discord desktop app.')
                                : 'Show the playing track on your Discord profile. Requires the Discord desktop app.'}>
                              <SetToggle label="Rich presence" on={discordPresenceEnabled} onToggle={() => onSetDiscordPresenceEnabled(!discordPresenceEnabled)} />
                            </SetRow>
                            {onSetDiscordHideWhenPaused ? (
                              <SetRow title="Hide when paused" note="Clears your Discord status while playback is stopped." wide={false}>
                                <SetToggle label="Hide when paused" on={discordHideWhenPaused} onToggle={() => onSetDiscordHideWhenPaused(!discordHideWhenPaused)} />
                              </SetRow>
                            ) : null}
                            {discordPresenceEnabled && onSetDiscordPresenceDetail ? (
                              <SetRow title="Show on your profile" note="The album still appears when you hover the cover art on Discord either way.">
                                <SetSeg label="Show on your profile" value={discordPresenceDetail} onPick={setDiscordPresenceDetailSafely}
                                  options={[['full', 'Title, artist, album'], ['basic', 'Title, artist']]} />
                              </SetRow>
                            ) : null}
                            {discordPresenceEnabled ? (
                              <SetRow title="Application ID" note="Optional. Use your own Discord application to change the name shown on your profile.">
                                <input className="st-input" placeholder="e.g. 1123581321345589" value={discordAppId}
                                  onChange={(e) => onSetDiscordAppId?.(e.target.value)} spellCheck={false} aria-label="Discord application ID" />
                                <span className="sth-set-sub">
                                  <SetHowTo label="How do I get an Application ID?">
                                    <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.85 }}>
                                      <li>Open the{' '}<button type="button" className="sth-set-link" onClick={() => api()?.openExternal?.('https://discord.com/developers/applications')}>Discord Developer Portal</button>{' '}and sign in.</li>
                                      <li>Click <SetLit>New Application</SetLit>. Its name is what Discord shows on your profile.</li>
                                      <li>Copy the <SetLit>Application ID</SetLit> from General Information and paste it here.</li>
                                      <li>For artwork, upload images named <SetLit>immerse_logo</SetLit>, <SetLit>play</SetLit> and <SetLit>pause</SetLit> under Rich Presence, Art Assets.</li>
                                    </ol>
                                  </SetHowTo>
                                </span>
                              </SetRow>
                            ) : null}
                            {discordPresenceEnabled ? (
                              <SetRow title="imgbb API key" note="Optional. Lets custom local cover art appear on Discord by uploading it once to imgbb.">
                                <input className="st-input" placeholder="From api.imgbb.com" value={imgbbApiKey}
                                  onChange={(e) => onSetImgbbApiKey?.(e.target.value)} spellCheck={false} aria-label="imgbb API key" />
                              </SetRow>
                            ) : null}
                          </div>
                          {discordStatus?.lastError ? (
                            <div role="status" style={{ fontSize: 12, color: 'var(--danger)', marginTop: 8 }}>{String(discordStatus.lastError)}</div>
                          ) : null}
                        </>
                      ) : null}
                    </>
                  ) : null}

                  {cat === 'connections' ? (
                    <div style={{ display: 'grid', gap: 16 }}>
                      {/* The account does the work (playback, My Spotify, artist
                          pages, search); the developer keys are a backup. */}
                      <SpotifyAccountPanel />
                      <section className="sth-conn">
                        <div className="sth-conn-head">
                          <div>
                            <h2>Spotify developer keys <span style={{ fontWeight: 600, color: 'var(--text-faint)', fontSize: '0.8em' }}>· optional</span></h2>
                            <p>A backup for search and song details when your Spotify sign-in is busy or rate-limited. Any free developer app works.</p>
                          </div>
                          {connState.spotify != null ? (
                            <span className={`st-status ${connState.spotify ? 'ok' : 'off'}`}>{connState.spotify ? 'Saved' : 'Not set'}</span>
                          ) : null}
                        </div>
                        <SpotifyCredsPanel compact onSaved={onSpotifyCredsSaved}
                          onStatus={(v) => setConnState((c2) => ({ ...c2, spotify: v }))} />
                      </section>
                      <section className="sth-conn">
                        <div className="sth-conn-head">
                          <div>
                            <h2>Soulseek</h2>
                            <p>Optional. A second download source, usually higher quality. Pick any username; the account is made on first login.</p>
                          </div>
                          {connState.soulseek != null ? (
                            <span className={`st-status ${connState.soulseek ? 'ok' : 'off'}`}>{connState.soulseek ? 'Connected' : 'Not connected'}</span>
                          ) : null}
                        </div>
                        <SoulseekCredsPanel compact onStatus={(v) => setConnState((c2) => ({ ...c2, soulseek: v }))} />
                      </section>
                      {onReplayOnboarding ? (
                        <section className="sth-conn" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <h2>Run setup again</h2>
                            <p style={{ marginBottom: 0 }}>Replays the first-launch walkthrough. Your credentials and library are not touched.</p>
                          </div>
                          <button type="button" className="st-btn st-btn-outline" onClick={onReplayOnboarding}>Replay setup</button>
                        </section>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })() : null}
        </div>
      </div>

      {/* Row menu — Edit info / Remove track / Remove album. */}
      {/* ---- Row context menu ----
           Rebuilt: sectioned, with the track it applies to named at the top and
           the destructive actions separated. The old version was a flat stack
           where "Remove album · 4 tracks" sat directly below "Remove from
           library" in the same red — an easy misclick between two very
           different outcomes. */}
      {rowMenu ? (() => {
        const t = rowMenu.track;
        const albumTracks = t?.album
          ? library.filter((x) => (x.album || '').toLowerCase() === (t.album || '').toLowerCase()
              && primaryArtistOf(x).toLowerCase() === primaryArtistOf(t).toLowerCase())
          : [];
        const close = () => { setRowMenu(null); setConfirmKey(null); };
        return createPortal(
          <>
            <div onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }}
              style={{ position: 'fixed', inset: 0, zIndex: 400 }} />
            <div
              data-rowmenu=""
              style={{
                position: 'fixed', zIndex: 401,
                /* Clamped so the menu never opens off-screen near an edge.
                   Math.max as well as Math.min: the min alone kept the menu
                   off the RIGHT edge and let it go negative on the left, so
                   a right-click near the window edge of a narrow window put
                   the first few options past x=0 where they couldn't be
                   clicked. */
                left: Math.max(8, Math.min(rowMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 1400) - 252)),
                /* Two anchorings, because the menu now has two kinds of
                   trigger. A library row is somewhere in the middle of the
                   screen and the menu drops from the cursor. A now-playing
                   bar button is pinned to the bottom edge, and a menu that
                   drops from there would open underneath the window — so it
                   grows UP from the button instead, with `bottom` rather than
                   `top` so the submenu expanding doesn't push it off-screen. */
                ...(rowMenu.above
                  ? { bottom: Math.max(8, (typeof window !== 'undefined' ? window.innerHeight : 900) - rowMenu.y) }
                  : { top: Math.min(rowMenu.y, (typeof window !== 'undefined' ? window.innerHeight : 900) - 320) }),
                /* #000 with a hairline, matching the content wrapper and the
                   Now Playing panel. rgb(20,20,24) was lighter than every other
                   surface in the app, so the menu read as borrowed from
                   somewhere else. */
                width: 236, padding: 5, borderRadius: 12,
                background: '#000', border: '1px solid rgba(var(--st-fg-rgb), 0.11)',
                boxShadow: '0 22px 60px rgba(0,0,0,0.7)',
                animation: 'stFadeUp 0.13s ease both',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px 10px' }}>
                <div style={{ width: 34, height: 34, borderRadius: 6, flexShrink: 0, background: coverFor(t) ? `url("${coverFor(t)}") center/cover` : 'rgba(var(--st-fg-rgb), 0.08)' }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--st-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t?.title}</div>
                  <div style={{ fontSize: 10.5, color: 'rgba(var(--st-sub-rgb), 0.45)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t?.artist}</div>
                </div>
              </div>
              <div style={{ height: 1, background: 'rgba(var(--st-fg-rgb), 0.08)', margin: '0 3px 4px' }} />

              {onPlayTrack ? (
                <MenuItem accentRgb={readableAccent(accent)} onClick={() => { onPlayTrack(t, library, 'list'); close(); }}
                  icon={<path d="M8 6.5v11l9.5-5.5z" />} label="Play" />
              ) : null}
              {/* Queue actions sit directly under Play — they're the same
                  verb deferred, and grouping them means the three ways to
                  start a track are in one place instead of scattered down
                  the menu.
                  Both confirm with a toast: the queue panel is often closed,
                  and an action with no visible effect reads as a no-op that
                  people then repeat. */}
              {onPlayNext ? (
                <MenuItem accentRgb={readableAccent(accent)}
                  onClick={() => {
                    onPlayNext(t);
                    pushToast?.({ message: `Playing next: ${t?.title || 'track'}` });
                    close();
                  }}
                  icon={<><path d="M4 6h10M4 12h10M4 18h6" /><path d="M17.5 14.5v6M14.5 17.5h6" /></>}
                  label="Play next" />
              ) : null}
              {onAddToQueue ? (
                <MenuItem accentRgb={readableAccent(accent)}
                  onClick={() => {
                    onAddToQueue(t);
                    pushToast?.({ message: `Added to queue: ${t?.title || 'track'}` });
                    close();
                  }}
                  icon={<><path d="M4 6h16M4 12h16M4 18h9" /><path d="M17 15.5v5.5" /><path d="M14.2 18.2h5.6" /></>}
                  label="Add to queue" />
              ) : null}
              {/* Playlists inline, NOT a second dialog.
                  The separate sheet never appeared: it renders inside the
                  library panel, and `.sth-scroll` animates on mount while its
                  is-page variant is overflow:hidden — an animated ancestor
                  becomes the containing block for position:fixed, so the sheet
                  was clipped out of sight. This menu is already portalled to
                  document.body and visibly works, so the list goes here and
                  depends on nothing new. */}
              {onAddTracksToPlaylist ? (
                <MenuItem accentRgb={readableAccent(accent)}
                  onClick={() => {
                    /* Take over the menu's exact position. The picker is a
                       continuation of this menu, not a new surface arriving
                       from somewhere else, so it should appear where the
                       menu was rather than jumping. */
                    const at = { x: rowMenu.x, y: rowMenu.y, above: rowMenu.above };
                    close();
                    openPlaylistPicker(t, at);
                  }}
                  icon={<><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M12 8.5v7M8.5 12h7" /></>}
                  label="Add to playlist"
                  sub={(() => {
                    /* How many lists already hold it, stated up front. The
                       submenu made you open it to find that out. */
                    const n = (playlists || []).filter((p) => (p.trackIds || []).includes(t.id)).length;
                    return n ? `In ${n} playlist${n === 1 ? '' : 's'}` : undefined;
                  })()}
                  trailing={(
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                  )} />
              ) : null}
              {onToggleFavorite ? (
                <MenuItem accentRgb={readableAccent(accent)} onClick={() => { onToggleFavorite(t.id); close(); }}
                  icon={<path d="M20.8 8.6a5 5 0 0 0-8.8-2.6A5 5 0 0 0 3.2 8.6c0 4.2 5.5 7.6 8.8 10.4 3.3-2.8 8.8-6.2 8.8-10.4z" />}
                  label={t?.isFavorite ? 'Remove from favourites' : 'Add to favourites'} />
              ) : null}
              <MenuItem accentRgb={readableAccent(accent)}
                onClick={async () => { await copySpotifyLink(t); close(); }}
                icon={<><path d="M4 12v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" /><path d="M16 6l-4-4-4 4" /><path d="M12 2v14" /></>}
                label="Copy Spotify link"
                sub={sharing === t.id ? 'Looking up…' : undefined} />
              {onUpdateTrackMetadata ? (
                <MenuItem accentRgb={readableAccent(accent)} onClick={() => { setEditingTrack(t); close(); }}
                  icon={<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />}
                  label="Edit info" />
              ) : null}

              {/* Moved here out of the Now Playing bar (brief): expanded
                  player, immerse and the per-record colour. */}
              {rowMenu.bar ? (
                <>
                  <div style={{ height: 1, background: 'rgba(var(--st-fg-rgb), 0.08)', margin: '4px 3px' }} />
                  <MenuItem accentRgb={readableAccent(accent)} onClick={() => { close(); setNpFull((v) => !v); }}
                    icon={<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />}
                    label={npFull ? 'Exit fullscreen' : 'Fullscreen'} sub="Ctrl+Shift+F" />
                  <MenuItem accentRgb={readableAccent(accent)} onClick={() => { close(); toggleNpAnimatedBg(); }}
                    icon={<path d="M12 3.2c3.4 3.6 5.4 6.2 5.4 8.9a5.4 5.4 0 1 1-10.8 0c0-2.7 2-5.3 5.4-8.9z" />}
                    label={npAnimatedBg ? 'Turn Immerse off' : 'Turn Immerse on'} />
                  {/* The colour tray hangs off the Now Playing bar, which isn't
                      mounted in fullscreen — so the item goes with it. */}
                  {!npFull ? (
                  <MenuItem accentRgb={readableAccent(accent)} onClick={() => { close(); setColourTrayOpen(true); }}
                      icon={<><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" /></>}
                      label="Colour for this record" sub={coverOverride ? 'Custom colour set' : 'Picked from the artwork'} />
                  ) : null}
                  <MenuItem accentRgb={readableAccent(accent)} onClick={() => { close(); toggleCompactMode(); }}
                    icon={<><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 15h18" /></>}
                    label={compactMode ? 'Exit compact mode' : 'Compact mode'} sub="Ctrl+Shift+C" />
                </>
              ) : null}
              {onRemoveFromLibrary && !rowMenu.bar ? (
                <>
                  <div style={{ height: 1, background: 'rgba(var(--st-fg-rgb), 0.08)', margin: '4px 3px' }} />
                  <MenuItem accentRgb={readableAccent(accent)} danger onClick={() => { onRemoveFromLibrary([t.id]); close(); }}
                    icon={<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />}
                    label="Remove song" />
                  {albumTracks.length > 1 ? (
                    <MenuItem accentRgb={readableAccent(accent)} danger onClick={() => { onRemoveFromLibrary(albumTracks.map((x) => x.id)); close(); }}
                      icon={<><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M9 15l6-6M9 9l6 6" /></>}
                      label="Remove whole album"
                      sub={`${t.album} · ${albumTracks.length} tracks`} />
                  ) : null}
                </>
              ) : null}
            </div>
          </>,
          document.body,
        );
      })() : null}

      {/* Clear-library confirmation. Typed phrase, not a yes/no — a
          misclicked "Clear everything" has no undo path. */}
      {clearConfirm ? (
        <div
          onClick={() => { if (!clearing) setClearConfirm(null); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 300, display: 'flex',
            alignItems: 'center', justifyContent: 'center', padding: 30,
            background: 'rgba(4,4,6,0.82)',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(430px, 92vw)', borderRadius: 16, padding: '20px 22px',
              background: 'rgb(16,16,19)', border: '1px solid rgba(var(--st-fg-rgb), 0.09)',
              boxShadow: '0 26px 80px rgba(0,0,0,0.65)',
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--st-text)' }}>Clear your library?</div>
            <div style={{ fontSize: 12, color: 'rgba(var(--st-sub-rgb), 0.6)', marginTop: 8, lineHeight: 1.6 }}>
              This removes <strong style={{ color: 'var(--st-text)' }}>{library.length} track{library.length === 1 ? '' : 's'}</strong>,
              along with your playlists and album notes. It can't be undone.
            </div>
            <div style={{
              marginTop: 12, padding: '9px 11px', borderRadius: 9,
              background: 'rgba(120,220,150,0.08)', border: '1px solid rgba(120,220,150,0.22)',
              fontSize: 11, color: 'rgba(170,230,190,0.95)', lineHeight: 1.5,
            }}>
              Listening history is kept. Re-import a song later and its play count and
              last-played date come back automatically.
            </div>

            <button
              type="button"
              onClick={() => setClearConfirm((c) => ({ ...c, deleteFiles: !c.deleteFiles }))}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                marginTop: 12, padding: '10px 11px', borderRadius: 10, cursor: 'pointer',
                border: `1px solid ${clearConfirm.deleteFiles ? 'rgba(230,90,90,0.45)' : 'rgba(var(--st-fg-rgb), 0.1)'}`,
                background: clearConfirm.deleteFiles ? 'rgba(230,90,90,0.12)' : 'rgba(var(--st-fg-rgb), 0.035)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--st-text)' }}>Also move downloaded files to the trash</div>
                <div style={{ fontSize: 10.5, color: 'rgba(var(--st-sub-rgb), 0.45)', marginTop: 2, lineHeight: 1.45 }}>
                  Only files studio downloaded itself. Music you imported from elsewhere on
                  your computer is never touched.
                </div>
              </div>
              <span aria-hidden style={{
                width: 34, height: 20, borderRadius: 999, position: 'relative', flexShrink: 0,
                background: clearConfirm.deleteFiles ? 'rgb(230,90,90)' : 'rgba(var(--st-fg-rgb), 0.16)',
                border: '1px solid rgba(var(--st-fg-rgb), 0.18)',
              }}>
                <span style={{
                  position: 'absolute', top: 2, left: clearConfirm.deleteFiles ? 15 : 2,
                  width: 14, height: 14, borderRadius: '50%', background: '#fff',
                  transition: 'left 0.16s cubic-bezier(0.3,0.9,0.3,1)',
                }} />
              </span>
            </button>

            <div style={{ marginTop: 14, fontSize: 11, color: 'rgba(var(--st-sub-rgb), 0.5)' }}>
              Type <strong style={{ color: 'var(--st-text)', fontFamily: 'ui-monospace, monospace' }}>clear</strong> to confirm
            </div>
            <input
              value={clearPhrase}
              onChange={(e) => setClearPhrase(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && !clearing) setClearConfirm(null); }}
              placeholder="clear"
              autoFocus
              spellCheck={false}
              style={{
                width: '100%', boxSizing: 'border-box', marginTop: 6,
                padding: '9px 11px', borderRadius: 9, outline: 'none',
                border: '1px solid rgba(var(--st-fg-rgb), 0.12)', background: 'rgba(0,0,0,0.35)',
                color: 'var(--st-text)', fontSize: 12.5, fontFamily: 'inherit',
              }}
            />

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button
                type="button"
                onClick={() => setClearConfirm(null)}
                disabled={clearing}
                style={{
                  flex: 1, padding: '10px 14px', borderRadius: 10, cursor: 'pointer',
                  border: '1px solid rgba(var(--st-fg-rgb), 0.12)', background: 'rgba(var(--st-fg-rgb), 0.05)',
                  color: 'var(--st-text)', fontSize: 12, fontWeight: 700,
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={clearing || clearPhrase.trim().toLowerCase() !== 'clear'}
                onClick={async () => {
                  setClearing(true);
                  try {
                    const r = await onClearLibrary?.({ deleteFiles: !!clearConfirm.deleteFiles });
                    if (r?.ok) {
                      const bits = [`Cleared ${r.cleared ?? 0} track${(r.cleared ?? 0) === 1 ? '' : 's'}`];
                      if (r.deleted) bits.push(`${r.deleted} file${r.deleted === 1 ? '' : 's'} trashed`);
                      if (r.skipped) bits.push(`${r.skipped} left on disk`);
                      pushToast?.({ message: `${bits.join(' · ')}. Listening history kept.`, kind: 'success', durationMs: 6000 });
                      setClearConfirm(null);
                    } else {
                      pushToast?.({ message: r?.error || 'Couldn’t clear the library.', kind: 'error', durationMs: 7000 });
                    }
                  } finally {
                    setClearing(false);
                  }
                }}
                style={{
                  flex: 1, padding: '10px 14px', borderRadius: 10,
                  cursor: (clearing || clearPhrase.trim().toLowerCase() !== 'clear') ? 'default' : 'pointer',
                  border: '1px solid rgba(230,90,90,0.5)', background: 'rgba(230,90,90,0.22)',
                  color: 'rgb(245,160,160)', fontSize: 12, fontWeight: 700,
                  opacity: (clearing || clearPhrase.trim().toLowerCase() !== 'clear') ? 0.45 : 1,
                }}
              >
                {clearing ? 'Clearing…' : 'Clear library'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Delete-everything confirmation. One rung above Clear library — it
          also wipes listening stats and drops the onboarded flag, so the app
          returns to its first-run setup. Typed phrase, same rule as above. */}
      {clearAllConfirm ? (
        <div
          onClick={() => { if (!clearingAll) setClearAllConfirm(null); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 300, display: 'flex',
            alignItems: 'center', justifyContent: 'center', padding: 30,
            background: 'rgba(4,4,6,0.82)',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(430px, 92vw)', borderRadius: 16, padding: '20px 22px',
              background: 'rgb(16,16,19)', border: '1px solid rgba(var(--st-fg-rgb), 0.09)',
              boxShadow: '0 26px 80px rgba(0,0,0,0.65)',
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--st-text)' }}>Delete everything?</div>
            <div style={{ fontSize: 12, color: 'rgba(var(--st-sub-rgb), 0.6)', marginTop: 8, lineHeight: 1.6 }}>
              This removes <strong style={{ color: 'var(--st-text)' }}>{library.length} track{library.length === 1 ? '' : 's'}</strong>,
              every playlist, album note, and{' '}
              <strong style={{ color: 'var(--st-text)' }}>all listening history</strong> — then
              returns studio to its first-run setup screen. It can't be undone.
            </div>
            <div style={{
              marginTop: 12, padding: '9px 11px', borderRadius: 9,
              background: 'rgba(230,90,90,0.08)', border: '1px solid rgba(230,90,90,0.22)',
              fontSize: 11, color: 'rgba(245,150,150,0.95)', lineHeight: 1.5,
            }}>
              This is the nuclear option: not even listening stats survive. Clear library,
              by contrast, keeps your play history.
            </div>

            <button
              type="button"
              onClick={() => setClearAllConfirm((c) => ({ ...c, deleteFiles: !c.deleteFiles }))}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                marginTop: 12, padding: '10px 11px', borderRadius: 10, cursor: 'pointer',
                border: `1px solid ${clearAllConfirm.deleteFiles ? 'rgba(230,90,90,0.45)' : 'rgba(var(--st-fg-rgb), 0.1)'}`,
                background: clearAllConfirm.deleteFiles ? 'rgba(230,90,90,0.12)' : 'rgba(var(--st-fg-rgb), 0.035)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--st-text)' }}>Also move downloaded files to the trash</div>
                <div style={{ fontSize: 10.5, color: 'rgba(var(--st-sub-rgb), 0.45)', marginTop: 2, lineHeight: 1.45 }}>
                  Only files studio downloaded itself. Music you imported from elsewhere on
                  your computer is never touched.
                </div>
              </div>
              <span aria-hidden style={{
                width: 34, height: 20, borderRadius: 999, position: 'relative', flexShrink: 0,
                background: clearAllConfirm.deleteFiles ? 'rgb(230,90,90)' : 'rgba(var(--st-fg-rgb), 0.16)',
                border: '1px solid rgba(var(--st-fg-rgb), 0.18)',
              }}>
                <span style={{
                  position: 'absolute', top: 2, left: clearAllConfirm.deleteFiles ? 15 : 2,
                  width: 14, height: 14, borderRadius: '50%', background: '#fff',
                  transition: 'left 0.16s cubic-bezier(0.3,0.9,0.3,1)',
                }} />
              </span>
            </button>

            <div style={{ marginTop: 14, fontSize: 11, color: 'rgba(var(--st-sub-rgb), 0.5)' }}>
              Type <strong style={{ color: 'var(--st-text)', fontFamily: 'ui-monospace, monospace' }}>delete everything</strong> to confirm
            </div>
            <input
              value={clearAllPhrase}
              onChange={(e) => setClearAllPhrase(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && !clearingAll) setClearAllConfirm(null); }}
              placeholder="delete everything"
              autoFocus
              spellCheck={false}
              style={{
                width: '100%', boxSizing: 'border-box', marginTop: 6,
                padding: '9px 11px', borderRadius: 9, outline: 'none',
                border: '1px solid rgba(var(--st-fg-rgb), 0.12)', background: 'rgba(0,0,0,0.35)',
                color: 'var(--st-text)', fontSize: 12.5, fontFamily: 'inherit',
              }}
            />

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button
                type="button"
                onClick={() => setClearAllConfirm(null)}
                disabled={clearingAll}
                style={{
                  flex: 1, padding: '10px 14px', borderRadius: 10, cursor: 'pointer',
                  border: '1px solid rgba(var(--st-fg-rgb), 0.12)', background: 'rgba(var(--st-fg-rgb), 0.05)',
                  color: 'var(--st-text)', fontSize: 12, fontWeight: 700,
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={clearingAll || clearAllPhrase.trim().toLowerCase() !== 'delete everything'}
                onClick={async () => {
                  setClearingAll(true);
                  try {
                    const r = await onClearEverything?.({ deleteFiles: !!clearAllConfirm.deleteFiles });
                    if (r?.ok) {
                      pushToast?.({ message: 'Everything deleted. Back to a fresh install.', kind: 'success', durationMs: 5000 });
                      setClearAllConfirm(null);
                    } else {
                      pushToast?.({ message: r?.error || 'Couldn’t delete everything.', kind: 'error', durationMs: 7000 });
                    }
                  } finally {
                    setClearingAll(false);
                  }
                }}
                style={{
                  flex: 1, padding: '10px 14px', borderRadius: 10,
                  cursor: (clearingAll || clearAllPhrase.trim().toLowerCase() !== 'delete everything') ? 'default' : 'pointer',
                  border: '1px solid rgba(255,110,110,0.6)', background: 'rgba(230,70,70,0.22)',
                  color: 'rgb(255,160,160)', fontSize: 12, fontWeight: 700,
                  opacity: (clearingAll || clearAllPhrase.trim().toLowerCase() !== 'delete everything') ? 0.45 : 1,
                }}
              >
                {clearingAll ? 'Deleting…' : 'Delete everything'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Metadata editor — same floating glass modal the overlay uses. */}
      {editingTrack && onUpdateTrackMetadata ? (
        <MetadataEditor
          track={editingTrack}
          accent={accent}
          onSave={async (fields) => {
            const r = await onUpdateTrackMetadata(editingTrack.id, fields);
            if (r?.ok) setEditingTrack(null);
            return r;
          }}
          onClose={() => setEditingTrack(null)}
        />
      ) : null}

      {/* Now-playing resume pill — draggable anywhere; position persists.
          A small drag (under 5px) still counts as a click to reopen the
          overlay. Default spot is bottom-center (pillPos = null). */}
      {/* Hidden in the Library, where the Now Playing panel already shows
          the track and its controls — two now-playing affordances on the
          same screen is redundant. Shown everywhere else. */}
      {/* Return-to-stage pill removed — the Now Playing bar's fullscreen
          button does the same job from a fixed, findable place, and the
          draggable pill floated over content. Its drag state (pillPos,
          pillRef, onPillPointerDown) is left above for now. */}

      {/* Now Playing bar. Rendered at the ROOT so it persists across every
          section — it used to be mounted inside the library branch, so it
          vanished the moment you left that tab. Hidden while the fullscreen
          panel is up, since that owns its own transport. */}
      {/* Enlarged cover art. Rendered outside the bar's own conditional so it
          survives the bar being hidden underneath it (fullscreen, library
          expanded) rather than unmounting mid-view. */}
      {coverZoom ? (
        <CoverLightbox
          url={coverZoom}
          track={currentTrack}
          accent={accent}
          albumKey={currentTrack ? albumKeyOf(currentTrack) : null}
          onPin={pinAlbumCover}
          onClose={closeCoverZoom}
        />
      ) : null}

      {currentTrack && !libExpanded && !npFull ? (
        <>
          {/* Colour override for this record.
              The handle is a chevron tucked behind the left edge of the Now
              Playing bar — the colour it changes is right there, so the control
              belongs against it rather than parked in the sidebar where it read
              as a navigation item. */}
          <CoverColourTab
            open={colourTrayOpen}
            setOpen={setColourTrayOpen}
            swatches={npWashTheme?.swatches || []}
            current={coverOverride}
            accent={accent}
            onPick={(rgb) => setCoverColourFor(rgb)}
            onReset={() => { setCoverColourFor(null); setColourTrayOpen(false); }}
            coverSrc={currentTrack ? coverFor(currentTrack) : null}
            exportName={currentTrack ? `${currentTrack.artist || 'unknown'} - ${currentTrack.album || currentTrack.title || 'cover'}` : 'cover'}
            headless
          />

        <NowPlayingBar
          track={currentTrack}
          isPlaying={isPlaying}
          art={currentTrack ? coverFor(currentTrack) : null}
          accent={accent}
          onZoomCover={openCoverZoom}
          onCopyLink={copySpotifyLink}
          copyBusy={!!currentTrack && sharing === currentTrack.id}
          onTogglePlay={onTogglePlay}
          onPrev={onPrev}
          onNext={onNext}
          volume={volume}
          onSetVolume={onSetVolume}
          animatedBg={npAnimatedBg}
          /* Immerse off: the bar is its own colour, or the cover's, per the
             one setting that governs it. Immerse on: the animated artwork
             gradient takes over and nothing else applies. */
          solidWash={!immerse && theme.barSurface === 'cover' ? npBarSolidWash : null}
          immersePalette={immersePalette}
          immerseOn={npAnimatedBg}
          onToggleImmerse={toggleNpAnimatedBg}
          onFullscreen={() => setNpFull(true)}
          onToggleQueue={() => toggleNpPanel('queue')}
          queueOpen={npPanelOpen && npPanelTab === 'queue'}
          onToggleLyrics={() => toggleNpPanel('lyrics')}
          lyricsOpen={npPanelOpen && npPanelTab === 'lyrics'}
          /* Track actions. All three are gated on the capability actually
             being wired: the bar drops the button rather than showing one
             that does nothing, the same way it drops the cover zoom when
             there's no artwork. */
          onToggleFavorite={onToggleFavorite}
          onAddToPlaylist={onAddTracksToPlaylist ? (e, t) => {
            const r = e.currentTarget.getBoundingClientRect();
            // Right-aligned to the button and growing upward — the bar sits
            // on the bottom edge, so a downward menu would open off-screen.
            openPlaylistPicker(t, { x: r.right - 288, y: r.top - 10, above: true });
          } : null}
          onMore={openBarMenu}
          shuffleOn={shuffleOn}
          repeat={repeat}
          onToggleShuffle={onToggleShuffle}
          onToggleRepeat={onToggleRepeat}
          currentTime={currentTime}
          onSeek={onSeek}
        />
        </>
      ) : null}

      <NowPlayingPanelDock
        open={npPanelOpen && !!currentTrack && !libExpanded && !npFull}
        tab={npPanelTab}
        onTab={(t) => setPanel(true, t)}
        onClose={() => setPanel(false)}
        track={currentTrack}
        art={currentTrack ? coverFor(currentTrack) : null}
        accent={accent}
        coverFor={coverFor}
        isPlaying={isPlaying}
        onReorderQueue={onReorderQueue}
        /* "Up next" starts one past the current track, and reorder works in
           absolute queue positions — this is the offset between the two. */
        queueOffset={queueIndex >= 0 ? queueIndex + 1 : 0}
        surface={immerse ? 'immerse' : theme.panelSurface}
        immersePalette={immersePalette}
        barWash={npBarSolidWash}
        customColor={theme.panelColour}
        upNext={queueIndex >= 0 ? queue.slice(queueIndex + 1) : []}
        onSelectTrack={(t) => onPlayTrack?.(t, queue)}
        lyricsData={lyricsData}
        onLyricsSaved={onLyricsSaved}
        /* Lyric browser + share, driven by the SAME state the fullscreen
           stage uses. The dock is hidden whenever the expanded view is open
           (see `open=` above), so the two surfaces can never both be driving
           a selection — which is why one set of state serves both. */
        onBrowseLyrics={onPickLyrics && currentTrack ? () => setLyricsPickReq((n2) => n2 + 1) : null}
        lyricSelection={lyricSel}
        onLyricSelectStart={startLyricSel}
        onLyricSelectLine={extendLyricSel}
        currentTime={currentTime}
        onSeek={onSeek}
        /* Opens fullscreen on the tab the dock was showing, so the thing
           you were reading carries over instead of disappearing. */
        onExpand={() => { setNpFullTab(npPanelTab); try { localStorage.setItem('studio:npFullTab', npPanelTab || ''); } catch { /* ignore */ } setNpFull(true); }}
        artistInfo={artistInfo}
        credits={panelCredits}
      />

      {npFull && currentTrack ? (
        <NowPlayingFullView
          track={currentTrack}
          art={coverFor(currentTrack)}
          accent={accent}
          isPlaying={isPlaying}
          currentTime={currentTime}
          onSeek={onSeek}
          onTogglePlay={onTogglePlay}
          onPrev={onPrev}
          onNext={onNext}
          shuffleOn={shuffleOn}
          repeat={repeat}
          onToggleShuffle={onToggleShuffle}
          onToggleRepeat={onToggleRepeat}
          volume={volume}
          onSetVolume={onSetVolume}
          onToggleFavorite={onToggleFavorite}
          onAddToPlaylist={onAddTracksToPlaylist ? (e, t) => {
            const r = e.currentTarget.getBoundingClientRect();
            openPlaylistPicker(t, { x: Math.max(12, r.left + r.width / 2 - 144), y: r.top - 10, above: true });
          } : null}
          onMore={openBarMenu}
          onCopyLink={copySpotifyLink}
          copyBusy={sharing === currentTrack.id}
          onZoomCover={openCoverZoom}
          animatedBg={npAnimatedBg}
          immersePalette={immersePalette}
          tab={npFullTab}
          onTab={pickNpFullTab}
          onClose={() => setNpFull(false)}
          coverFor={coverFor}
          upNext={queueIndex >= 0 ? queue.slice(queueIndex + 1) : []}
          onSelectTrack={(t) => onPlayTrack?.(t, queue)}
          onReorderQueue={onReorderQueue}
          queueOffset={queueIndex >= 0 ? queueIndex + 1 : 0}
          lyricsData={lyricsData}
          onLyricsSaved={onLyricsSaved}
          onBrowseLyrics={onPickLyrics ? () => setLyricsPickReq((n2) => n2 + 1) : null}
          lyricSelection={lyricSel}
          onLyricSelectStart={startLyricSel}
          onLyricSelectLine={extendLyricSel}
          artistInfo={artistInfo}
          credits={panelCredits}
        />
      ) : null}

      {/* ---- Lyric browser + share, for the DOCK ---------------------------
       * The pair inside the fullscreen portal above is gated on `libExpanded`,
       * so from the dock the browse button had nothing to open and a selection
       * had nothing to render. These are the same components driven by the
       * same state, mounted for the other case.
       *
       * Gated on `!libExpanded` precisely so the two never coexist: they share
       * `lyricsPickReq`, `lyricSel` and `lyricShareOpen`, and two live copies
       * would each answer the same request — two modals, two cards. */}
      {!libExpanded && onPickLyrics && currentTrack ? (
        <LyricsPickerButton
          currentTrack={currentTrack}
          accent={accent}
          visible={false}
          hideTrigger
          openRequest={lyricsPickReq}
          onApply={onPickLyrics}
          appliedText={lyricsData
            ? (lyricsData.synced?.length
              ? lyricsData.synced.map((l) => l.text).join('\n')
              : (lyricsData.plain || ''))
            : ''}
          appliedId={lyricsData?.lyricId ?? null}
        />
      ) : null}

      {/* Selection confirm bar. position:fixed and centred at the top, so it
          reads the same whether the lines were picked in the dock or the
          fullscreen stage. */}
      {!libExpanded && lyricSel && !lyricShareOpen ? (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed', left: '50%', top: 26, transform: 'translateX(-50%)',
            zIndex: 45, display: 'flex', alignItems: 'center', gap: 12,
            padding: '9px 11px 9px 15px', borderRadius: 13,
            background: 'rgba(16,16,20,0.9)',
            border: '1px solid rgba(var(--st-fg-rgb), 0.09)',
            boxShadow: '0 12px 44px rgba(0,0,0,0.55)',
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(var(--st-text-rgb), 0.72)', fontVariantNumeric: 'tabular-nums' }}>
            {lyricSel.end - lyricSel.start + 1} line{lyricSel.end === lyricSel.start ? '' : 's'} selected
          </span>
          <button type="button" onClick={() => setLyricShareOpen(true)}
            style={{
              padding: '7px 16px', borderRadius: 9,
              border: `1px solid rgba(${readableAccent(accent)},0.45)`,
              background: `rgba(${readableAccent(accent)},0.28)`,
              color: 'var(--st-text)', fontSize: 12, fontWeight: 700, cursor: 'pointer',
            }}
          >
            Make card
          </button>
          <button type="button" onClick={clearLyricSel} title="Cancel selection (Esc)"
            style={{
              width: 26, height: 26, borderRadius: 8, border: 'none',
              background: 'rgba(var(--st-fg-rgb), 0.06)', color: 'rgba(var(--st-sub-rgb), 0.55)',
              fontSize: 15, lineHeight: 1, cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>
      ) : null}

      {!libExpanded && lyricShareOpen && selectedLyricLines.length ? (
        <LyricShare
          lines={selectedLyricLines}
          track={currentTrack}
          coverUrl={currentTrack ? coverFor(currentTrack) : null}
          startTime={lyricSel && lyricsData?.synced?.length
            ? lyricsData.synced[lyricSel.start]?.time ?? null : null}
          accent={accent}
          onClose={() => setLyricShareOpen(false)}
          onNotify={(ok, msg) => {
            pushToast?.({ message: msg, kind: ok ? 'success' : 'error', durationMs: ok ? 3000 : 6500 });
            if (ok) clearLyricSel();
          }}
        />
      ) : null}

      {/* Album metadata — the editor the overlay already used, now reachable
          from the album page. */}
      {albumEditScope && onUpdateAlbumMetadata ? (
        <AlbumMetadataEditor
          scope={albumEditScope}
          accent={accent}
          onSave={async (fields) => {
            const r = await onUpdateAlbumMetadata(albumEditScope.trackIds, fields);
            if (r?.ok) {
              // The cover override is keyed separately from track tags, so a
              // new cover has to be written there too or the change reverts on
              // the next library reload.
              if ('coverArt' in fields && albumEditScope.key) onSetAlbumCover?.(albumEditScope.key, fields.coverArt || null);
              setAlbumEditScope(null);
            }
            return r;
          }}
          onClose={() => setAlbumEditScope(null)}
        />
      ) : null}

      {/* Playlist cover. A file picker rather than a full editor — name is
          already handled by Rename, and cover is the only other field. */}
      {plCoverFor ? (
        <Modal>
        <div onClick={() => setPlCoverFor(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(4,4,6,0.8)' }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(360px, 92vw)', borderRadius: 15, padding: '18px 20px', background: 'rgb(16,16,19)', border: '1px solid rgba(var(--st-fg-rgb), 0.1)' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--st-text)' }}>Playlist cover</div>
            <div style={{ fontSize: 11.5, color: 'rgba(var(--st-sub-rgb), 0.5)', marginTop: 6, lineHeight: 1.5 }}>
              Choose an image, or clear it to fall back to the first track&rsquo;s artwork.
            </div>
            <label style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', height: 96, marginTop: 14,
              borderRadius: 11, cursor: 'pointer', border: '1px dashed rgba(var(--st-fg-rgb), 0.22)',
              color: 'rgba(var(--st-sub-rgb), 0.6)', fontSize: 12, fontWeight: 600,
            }}>
              Choose image…
              <input type="file" accept="image/*" style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const rd = new FileReader();
                  rd.onload = async () => {
                    await onUpdatePlaylist?.(plCoverFor, { coverArt: String(rd.result) });
                    setPlCoverFor(null);
                  };
                  rd.readAsDataURL(f);
                }} />
            </label>
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button type="button" onClick={() => setPlCoverFor(null)}
                style={{ flex: 1, padding: '9px 14px', borderRadius: 9, cursor: 'pointer', border: '1px solid rgba(var(--st-fg-rgb), 0.12)', background: 'rgba(var(--st-fg-rgb), 0.05)', color: 'var(--st-text)', fontSize: 12, fontWeight: 650 }}>Cancel</button>
              <button type="button" onClick={async () => { await onUpdatePlaylist?.(plCoverFor, { coverArt: null }); setPlCoverFor(null); }}
                style={{ flex: 1, padding: '9px 14px', borderRadius: 9, cursor: 'pointer', border: '1px solid rgba(var(--st-fg-rgb), 0.12)', background: 'transparent', color: 'rgba(var(--st-text-rgb), 0.7)', fontSize: 12, fontWeight: 650 }}>Clear</button>
            </div>
          </div>
        </div>
        </Modal>
      ) : null}

      {/* Add songs to a playlist. Searchable, because picking from a 500-track
          library with a plain list is unusable. Already-added tracks show as
          such rather than being hidden — hiding them makes you wonder whether
          the search is broken. */}
      {addSongsTo ? (() => {
        const pl = playlists.find((x) => x.id === addSongsTo);
        const have = new Set(pl?.trackIds || []);
        const q = addSongsQuery.trim().toLowerCase();
        const rows = (q
          ? library.filter((t) => `${t.title || ''} ${t.artist || ''} ${t.album || ''}`.toLowerCase().includes(q))
          : library
        ).slice(0, 80);
        return (
          <Modal>
          <div onClick={() => setAddSongsTo(null)}
            style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(4,4,6,0.82)' }}>
            <div onClick={(e) => e.stopPropagation()}
              style={{ width: 'min(560px, 94vw)', maxHeight: '76vh', display: 'flex', flexDirection: 'column', borderRadius: 15, background: 'rgb(15,15,18)', border: '1px solid rgba(var(--st-fg-rgb), 0.1)', overflow: 'hidden' }}>
              <div style={{ padding: '16px 18px 10px' }}>
                <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--st-text)' }}>Add to {pl?.name || 'playlist'}</div>
                <input autoFocus value={addSongsQuery} onChange={(e) => setAddSongsQuery(e.target.value)}
                  placeholder="Search your library…"
                  style={{ width: '100%', boxSizing: 'border-box', marginTop: 12, padding: '10px 12px', borderRadius: 9, outline: 'none', border: '1px solid rgba(var(--st-fg-rgb), 0.12)', background: 'rgba(0,0,0,0.4)', color: 'var(--st-text)', fontSize: 13, fontFamily: 'inherit' }} />
              </div>
              <div className="sth-libscroll" style={{ overflowY: 'auto', padding: '0 10px 12px', minHeight: 0 }}>
                {rows.map((t) => {
                  const added = have.has(t.id);
                  return (
                    <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '7px 9px', borderRadius: 9 }}>
                      <div style={{ width: 36, height: 36, borderRadius: 5, flexShrink: 0, background: coverFor(t) ? `url("${coverFor(t)}") center/cover` : 'rgba(var(--st-fg-rgb), 0.08)' }} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--st-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</div>
                        <div style={{ fontSize: 10.5, color: 'rgba(var(--st-sub-rgb), 0.45)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.artist}</div>
                      </div>
                      <button type="button" disabled={added}
                        onClick={() => onAddTracksToPlaylist?.(addSongsTo, [t.id])}
                        style={{
                          padding: '5px 13px', borderRadius: 8, flexShrink: 0,
                          cursor: added ? 'default' : 'pointer', fontSize: 11, fontWeight: 650,
                          border: `1px solid ${added ? 'rgba(var(--st-fg-rgb), 0.1)' : `rgba(${readableAccent(accent)},0.4)`}`,
                          background: added ? 'transparent' : `rgba(${readableAccent(accent)},0.16)`,
                          color: added ? 'rgba(140,220,160,0.85)' : `rgb(${readableAccent(accent)})`,
                        }}>
                        {added ? 'Added' : 'Add'}
                      </button>
                    </div>
                  );
                })}
                {!rows.length ? <div style={{ fontSize: 12, color: 'rgba(var(--st-sub-rgb), 0.4)', padding: '8px 10px' }}>No matches.</div> : null}
              </div>
              <div style={{ padding: '10px 14px', borderTop: '1px solid rgba(var(--st-fg-rgb), 0.07)' }}>
                <button type="button" onClick={() => setAddSongsTo(null)}
                  style={{ width: '100%', padding: '9px 14px', borderRadius: 9, cursor: 'pointer', border: '1px solid rgba(var(--st-fg-rgb), 0.12)', background: 'rgba(var(--st-fg-rgb), 0.05)', color: 'var(--st-text)', fontSize: 12, fontWeight: 650 }}>Done</button>
              </div>
            </div>
          </div>
          </Modal>
        );
      })() : null}

      {/* ---- Playlist picker -------------------------------------------
          The inverse of the sheet above: that one picks songs for a
          playlist, this one picks playlists for a song. Same shell
          deliberately — same width, same header/scroll/footer split, same
          surfaces — because they are two directions of one idea and should
          not look like two different features. */}
      {plPicker ? (() => {
        const t = plPicker.track;
        const acc = readableAccent(accent);
        const q = plPickerQuery.trim().toLowerCase();
        const all = playlists || [];
        const rows = q ? all.filter((p) => (p.name || '').toLowerCase().includes(q)) : all;
        /* Search appears only once the list is long enough to need it. A
           search box above three playlists is furniture. */
        const showSearch = all.length > 7;
        const added = plPicker.sel.filter((id) => !plPicker.initial.includes(id)).length;
        const removed = plPicker.initial.filter((id) => !plPicker.sel.includes(id)).length;
        const dirty = added + removed;
        /* The primary button states the OUTCOME rather than saying "Done".
           With staged multi-select the whole risk is losing track of what
           you ticked, and a button that reads "Add to 3 playlists" closes
           that gap without a summary line. */
        const doneLabel = !dirty ? 'Done'
          : (removed && !added) ? `Remove from ${removed} playlist${removed === 1 ? '' : 's'}`
            : (added && !removed) ? `Add to ${added} playlist${added === 1 ? '' : 's'}`
              : `Update ${dirty} playlists`;
        const W = 288;
        const vw = typeof window !== 'undefined' ? window.innerWidth : 1400;
        const vh = typeof window !== 'undefined' ? window.innerHeight : 900;
        /* Same clamping the row menu uses, for the same reason: max as well
           as min, or the panel goes negative near the left edge and its
           first column of ticks lands past x=0 where it can't be clicked. */
        const left = Math.max(8, Math.min(plPicker.x != null ? plPicker.x : (vw - W) / 2, vw - W - 8));
        const vpos = plPicker.above
          ? { bottom: Math.max(8, vh - (plPicker.y != null ? plPicker.y : vh - 100)) }
          : { top: Math.max(8, Math.min(plPicker.y != null ? plPicker.y : 120, vh - 400)) };
        return (
          <Modal>
            {/* Invisible catcher rather than a dimming backdrop. It still
                makes the panel modal to the mouse — one click anywhere
                dismisses — without blacking out the library underneath. */}
            <div onClick={() => setPlPicker(null)}
              onContextMenu={(e) => { e.preventDefault(); setPlPicker(null); }}
              style={{ position: 'fixed', inset: 0, zIndex: 400 }} />
            <div onClick={(e) => e.stopPropagation()}
              style={{
                position: 'fixed', zIndex: 401, left, ...vpos,
                width: W, maxHeight: 392, display: 'flex', flexDirection: 'column',
                /* #000 with a hairline — the row menu's surface exactly. The
                   picker is usually opened from that menu, and a different
                   background would make it look like it came from somewhere
                   else. */
                borderRadius: 12, background: '#000',
                border: '1px solid rgba(var(--st-fg-rgb), 0.11)',
                boxShadow: '0 22px 60px rgba(0,0,0,0.7)',
                animation: 'stFadeUp 0.13s ease both',
                overflow: 'hidden',
              }}>

              {/* Header, matching the row menu's: artwork, title, artist,
                  hairline. The picker opens from the now-playing bar, from a
                  library row, and from a row inside a playlist — three
                  different songs — so it names the one being filed. */}
              <div style={{ padding: '9px 11px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 0 9px' }}>
                  <div style={{ width: 34, height: 34, borderRadius: 6, flexShrink: 0, background: coverFor(t) ? `url("${coverFor(t)}") center/cover` : 'rgba(var(--st-fg-rgb), 0.08)' }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--st-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t?.title}</div>
                    <div style={{ fontSize: 10.5, color: 'rgba(var(--st-sub-rgb), 0.45)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t?.artist}</div>
                  </div>
                </div>
                <div style={{ height: 1, background: 'rgba(var(--st-fg-rgb), 0.08)' }} />
                {showSearch ? (
                  <input autoFocus value={plPickerQuery} onChange={(e) => setPlPickerQuery(e.target.value)}
                    placeholder="Search playlists…"
                    style={{ width: '100%', boxSizing: 'border-box', marginTop: 9, padding: '7px 10px', borderRadius: 8, outline: 'none', border: '1px solid rgba(var(--st-fg-rgb), 0.12)', background: 'rgba(255,255,255,0.04)', color: 'var(--st-text)', fontSize: 12, fontFamily: 'inherit' }} />
                ) : null}
              </div>

              <div className="sth-libscroll" style={{ overflowY: 'auto', padding: '5px 5px 6px', minHeight: 0 }}>
                {/* New playlist, at the top. It expands into a name field in
                    place rather than opening a dialog on top of the picker —
                    a second layer is where people lose the ticks they
                    already made. */}
                {onCreatePlaylist ? (
                  plPickerNew == null ? (
                    <button type="button" className="sth-plpick" onClick={() => setPlPickerNew('')}>
                      <span className="sth-plpick-art is-new" style={{ color: `rgb(${acc})` }}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
                      </span>
                      <span className="sth-plpick-txt"><span className="sth-plpick-name">New playlist</span></span>
                    </button>
                  ) : (
                    <div className="sth-plpick is-editing">
                      <span className="sth-plpick-art is-new" style={{ color: `rgb(${acc})` }}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
                      </span>
                      <input autoFocus value={plPickerNew}
                        onChange={(e) => setPlPickerNew(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); createFromPlPicker(); }
                          /* Escape backs out of the NAME FIELD, not the
                             picker — stopPropagation keeps it from reaching
                             the window handler and throwing away the ticks. */
                          if (e.key === 'Escape') { e.stopPropagation(); setPlPickerNew(null); }
                        }}
                        placeholder="Playlist name"
                        style={{ flex: 1, minWidth: 0, padding: '6px 9px', borderRadius: 7, outline: 'none', border: '1px solid rgba(var(--st-fg-rgb), 0.14)', background: 'rgba(255,255,255,0.04)', color: 'var(--st-text)', fontSize: 12, fontFamily: 'inherit' }} />
                      <button type="button" disabled={!plPickerNew.trim()} onClick={createFromPlPicker}
                        style={{ padding: '5px 10px', borderRadius: 7, flexShrink: 0, cursor: plPickerNew.trim() ? 'pointer' : 'default', border: 'none', background: `rgb(${acc})`, color: accentTextColor(acc), fontSize: 11, fontWeight: 700, opacity: plPickerNew.trim() ? 1 : 0.4 }}>
                        Create
                      </button>
                    </div>
                  )
                ) : null}

                {rows.map((pl) => {
                  const on = plPicker.sel.includes(pl.id);
                  const was = plPicker.initial.includes(pl.id);
                  const count = (pl.trackIds || []).length;
                  return (
                    <button type="button" key={pl.id} className={`sth-plpick${on ? ' is-on' : ''}`}
                      onClick={() => togglePlPick(pl.id)}
                      aria-pressed={on}
                      style={{ '--pl-acc': acc, '--pl-acc-fg': accentTextColor(acc) }}>
                      <span className="sth-plpick-art"
                        style={{ background: pl.coverArt ? `url("${pl.coverArt}") center/cover` : undefined }}>
                        {pl.coverArt ? null : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.45 }}>
                            <path d="M9 17V6.5l9-1.8V15" /><circle cx="6.6" cy="17.4" r="2.6" /><circle cx="15.6" cy="15.4" r="2.6" />
                          </svg>
                        )}
                      </span>
                      <span className="sth-plpick-txt">
                        <span className="sth-plpick-name">{pl.name}</span>
                        <span className="sth-plpick-sub">
                          {count} song{count === 1 ? '' : 's'}
                          {/* Says what Done will do to THIS row. Without it a
                              tick means either "already in here" or "about to
                              go in here", and those are not the same. */}
                          {on && !was ? <em> · adding</em> : null}
                          {!on && was ? <em> · removing</em> : null}
                        </span>
                      </span>
                      <span className="sth-plpick-box" aria-hidden>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6.5L9.2 17.3 4 12.1" />
                        </svg>
                      </span>
                    </button>
                  );
                })}

                {!rows.length ? (
                  <div style={{ fontSize: 12, color: 'rgba(var(--st-sub-rgb), 0.42)', padding: '14px 10px', textAlign: 'center' }}>
                    {all.length ? 'No playlists match that.' : 'You have no playlists yet.'}
                  </div>
                ) : null}
              </div>

              <div style={{ display: 'flex', gap: 6, padding: '8px 9px', borderTop: '1px solid rgba(var(--st-fg-rgb), 0.08)' }}>
                <button type="button" onClick={() => setPlPicker(null)} disabled={plPickerBusy}
                  style={{ flex: 1, padding: '7px 10px', borderRadius: 8, cursor: 'pointer', border: '1px solid rgba(var(--st-fg-rgb), 0.12)', background: 'transparent', color: 'rgba(var(--st-sub-rgb), 0.7)', fontSize: 11.5, fontWeight: 650 }}>
                  Cancel
                </button>
                <button type="button" onClick={commitPlaylistPicker} disabled={plPickerBusy}
                  style={{ flex: 1.7, padding: '7px 10px', borderRadius: 8, cursor: 'pointer', border: 'none', background: dirty ? `rgb(${acc})` : 'rgba(var(--st-fg-rgb), 0.09)', color: dirty ? accentTextColor(acc) : 'rgba(var(--st-sub-rgb), 0.55)', fontSize: 11.5, fontWeight: 700, opacity: plPickerBusy ? 0.5 : 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', transition: 'background 0.15s ease, color 0.15s ease' }}>
                  {plPickerBusy ? 'Saving…' : doneLabel}
                </button>
              </div>
            </div>
          </Modal>
        );
      })() : null}

      {/* Edit profile — name and avatar. Local only; nothing is uploaded. */}
      {editProfile ? (
        <Modal>
        <div onClick={() => setEditProfile(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(4,4,6,0.82)' }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(400px, 92vw)', borderRadius: 15, padding: '18px 20px', background: 'rgb(var(--st-bg-rgb))', border: '1px solid rgba(var(--st-fg-rgb), 0.11)', boxShadow: '0 24px 70px rgba(0,0,0,0.65)' }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--st-text)' }}>Your profile</div>
            <div style={{ display: 'flex', gap: 14, marginTop: 14 }}>
              <label className="sth-plcover" style={{
                position: 'relative', width: 92, height: 92, borderRadius: '50%', flexShrink: 0, overflow: 'hidden', cursor: 'pointer',
                background: editProfile.avatar ? `url("${editProfile.avatar}") center/cover` : `rgba(${readableAccent(accent)},0.25)`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 30, fontWeight: 700, color: 'var(--st-text)',
              }}>
                {!editProfile.avatar ? (editProfile.name || 'You').trim().charAt(0).toUpperCase() : null}
                <div className="sth-plcover-veil">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="M21 16l-5-5-8 8" />
                  </svg>
                </div>
                <input type="file" accept="image/*" style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const rd = new FileReader();
                    rd.onload = () => setEditProfile((r) => ({ ...r, avatar: String(rd.result) }));
                    rd.readAsDataURL(f);
                  }} />
              </label>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'rgba(var(--st-sub-rgb), 0.4)' }}>Name</div>
                <input autoFocus value={editProfile.name}
                  onChange={(e) => setEditProfile((r) => ({ ...r, name: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setEditProfile(null);
                    if (e.key === 'Enter') { saveProfile({ name: editProfile.name.trim(), avatar: editProfile.avatar }); setEditProfile(null); }
                  }}
                  placeholder="Your name"
                  style={{ width: '100%', boxSizing: 'border-box', marginTop: 6, padding: '10px 12px', borderRadius: 9, outline: 'none', border: '1px solid rgba(var(--st-fg-rgb), 0.12)', background: 'rgba(0,0,0,0.35)', color: 'var(--st-text)', fontSize: 13, fontFamily: 'inherit' }} />
                {editProfile.avatar ? (
                  <button type="button" onClick={() => setEditProfile((r) => ({ ...r, avatar: null }))}
                    style={{ marginTop: 10, padding: '5px 11px', borderRadius: 8, cursor: 'pointer', border: '1px solid rgba(var(--st-fg-rgb), 0.12)', background: 'transparent', color: 'rgba(var(--st-sub-rgb), 0.6)', fontSize: 11, fontWeight: 600 }}>
                    Remove picture
                  </button>
                ) : null}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => setEditProfile(null)}
                style={{ flex: 1, padding: '9px 14px', borderRadius: 9, cursor: 'pointer', border: '1px solid rgba(var(--st-fg-rgb), 0.12)', background: 'rgba(var(--st-fg-rgb), 0.05)', color: 'var(--st-text)', fontSize: 12, fontWeight: 650 }}>Cancel</button>
              <button type="button" onClick={() => { saveProfile({ name: editProfile.name.trim(), avatar: editProfile.avatar }); setEditProfile(null); }}
                style={{ flex: 1, padding: '9px 14px', borderRadius: 9, cursor: 'pointer', border: 'none', background: `rgb(${readableAccent(accent)})`, color: accentTextColor(readableAccent(accent)), fontSize: 12, fontWeight: 700 }}>Save</button>
            </div>
          </div>
        </div>
        </Modal>
      ) : null}

      {/* Edit playlist — name AND cover in one dialog. They were two separate
          entry points ("Rename" plus a cover icon) for what is really one
          "edit this playlist" intent. */}
      {renamePl ? (() => {
        const pl = playlists.find((x) => x.id === renamePl.id);
        const art = renamePl.coverArt !== undefined ? renamePl.coverArt : (pl?.coverArt || null);
        const save = async () => {
          const name = renamePl.name.trim();
          if (name && name !== pl?.name) await onRenamePlaylist?.(renamePl.id, name);
          if (renamePl.coverArt !== undefined) await onUpdatePlaylist?.(renamePl.id, { coverArt: renamePl.coverArt });
          setRenamePl(null);
        };
        return (
          <Modal>
          <div onClick={() => setRenamePl(null)}
            style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(4,4,6,0.82)' }}>
            <div onClick={(e) => e.stopPropagation()}
              style={{ width: 'min(400px, 92vw)', borderRadius: 15, padding: '18px 20px', background: '#0b0b0d', border: '1px solid rgba(var(--st-fg-rgb), 0.1)', boxShadow: '0 24px 70px rgba(0,0,0,0.65)' }}>
              <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--st-text)' }}>Edit playlist</div>

              <div style={{ display: 'flex', gap: 14, marginTop: 14 }}>
                <label className="sth-plcover" style={{
                  position: 'relative', width: 104, height: 104, borderRadius: 9, flexShrink: 0, overflow: 'hidden', cursor: 'pointer',
                  background: art ? `url("${art}") center/cover` : 'rgba(var(--st-fg-rgb), 0.07)',
                  border: art ? 'none' : '1px dashed rgba(var(--st-fg-rgb), 0.2)',
                }}>
                  <div className="sth-plcover-veil" style={{ opacity: art ? undefined : 1, background: art ? undefined : 'transparent' }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="M21 16l-5-5-8 8" />
                    </svg>
                    <span style={{ fontSize: 10.5, fontWeight: 650, marginTop: 6 }}>{art ? 'Replace' : 'Add cover'}</span>
                  </div>
                  <input type="file" accept="image/*" style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      const rd = new FileReader();
                      rd.onload = () => setRenamePl((r) => ({ ...r, coverArt: String(rd.result) }));
                      rd.readAsDataURL(f);
                    }} />
                </label>

                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'rgba(var(--st-sub-rgb), 0.4)' }}>Name</div>
                  <input autoFocus value={renamePl.name}
                    onChange={(e) => setRenamePl((r) => ({ ...r, name: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Escape') setRenamePl(null); if (e.key === 'Enter' && renamePl.name.trim()) save(); }}
                    style={{ width: '100%', boxSizing: 'border-box', marginTop: 6, padding: '10px 12px', borderRadius: 9, outline: 'none', border: '1px solid rgba(var(--st-fg-rgb), 0.12)', background: 'rgba(0,0,0,0.4)', color: 'var(--st-text)', fontSize: 13, fontFamily: 'inherit' }} />
                  {art ? (
                    <button type="button" onClick={() => setRenamePl((r) => ({ ...r, coverArt: null }))}
                      style={{ alignSelf: 'flex-start', marginTop: 10, padding: '5px 11px', borderRadius: 8, cursor: 'pointer', border: '1px solid rgba(var(--st-fg-rgb), 0.12)', background: 'transparent', color: 'rgba(var(--st-sub-rgb), 0.6)', fontSize: 11, fontWeight: 600 }}>
                      Remove cover
                    </button>
                  ) : null}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <button type="button" onClick={() => setRenamePl(null)}
                  style={{ flex: 1, padding: '9px 14px', borderRadius: 9, cursor: 'pointer', border: '1px solid rgba(var(--st-fg-rgb), 0.12)', background: 'rgba(var(--st-fg-rgb), 0.05)', color: 'var(--st-text)', fontSize: 12, fontWeight: 650 }}>Cancel</button>
                <button type="button" disabled={!renamePl.name.trim()} onClick={save}
                  style={{ flex: 1, padding: '9px 14px', borderRadius: 9, cursor: 'pointer', border: 'none', background: `rgb(${readableAccent(accent)})`, color: accentTextColor(readableAccent(accent)), fontSize: 12, fontWeight: 700, opacity: renamePl.name.trim() ? 1 : 0.45 }}>Save</button>
              </div>
            </div>
          </div>
          </Modal>
        );
      })() : null}

      {/* Delete playlist. Confirmed, but no typed phrase — unlike clearing the
          library this removes a list, not the music itself. */}
      {deletePl ? (
        <Modal>
        <div onClick={() => setDeletePl(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(4,4,6,0.8)' }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(370px, 92vw)', borderRadius: 15, padding: '18px 20px', background: 'rgb(16,16,19)', border: '1px solid rgba(var(--st-fg-rgb), 0.1)', boxShadow: '0 24px 70px rgba(0,0,0,0.6)' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--st-text)' }}>Delete “{deletePl.name}”?</div>
            <div style={{ fontSize: 12, color: 'rgba(var(--st-sub-rgb), 0.55)', marginTop: 8, lineHeight: 1.55 }}>
              The playlist is removed. The songs stay in your library.
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => setDeletePl(null)}
                style={{ flex: 1, padding: '9px 14px', borderRadius: 9, cursor: 'pointer', border: '1px solid rgba(var(--st-fg-rgb), 0.12)', background: 'rgba(var(--st-fg-rgb), 0.05)', color: 'var(--st-text)', fontSize: 12, fontWeight: 650 }}>Cancel</button>
              <button type="button"
                onClick={async () => { await onDeletePlaylist?.(deletePl.id); setDeletePl(null); setLibDetail(null); }}
                style={{ flex: 1, padding: '9px 14px', borderRadius: 9, cursor: 'pointer', border: '1px solid rgba(230,90,90,0.5)', background: 'rgba(230,90,90,0.2)', color: 'rgb(245,160,160)', fontSize: 12, fontWeight: 700 }}>Delete</button>
            </div>
          </div>
        </div>
        </Modal>
      ) : null}

      {/* Pick a playlist to add to. A sheet rather than a submenu: this can be
          reached with one track or a whole album selected, and a hover menu
          would close the moment the pointer left the row. */}
      {addToPl ? (
        <Modal>
        <div onClick={() => setAddToPl(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(4,4,6,0.8)' }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(360px, 92vw)', maxHeight: '70vh', display: 'flex', flexDirection: 'column', borderRadius: 15, background: 'rgb(16,16,19)', border: '1px solid rgba(var(--st-fg-rgb), 0.1)', boxShadow: '0 24px 70px rgba(0,0,0,0.6)', overflow: 'hidden' }}>
            <div style={{ padding: '16px 18px 10px', fontSize: 14, fontWeight: 700, color: 'var(--st-text)' }}>
              Add {addToPl.trackIds.length} song{addToPl.trackIds.length === 1 ? '' : 's'} to…
            </div>
            <div className="sth-libscroll" style={{ overflowY: 'auto', padding: '0 8px 12px' }}>
              {playlists.length ? playlists.map((pl) => (
                <button key={pl.id} type="button"
                  onClick={async () => { await onAddTracksToPlaylist?.(pl.id, addToPl.trackIds); setAddToPl(null); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left',
                    padding: '8px 10px', borderRadius: 9, border: 'none', cursor: 'pointer', background: 'transparent',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(var(--st-fg-rgb), 0.06)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                  <div style={{ width: 30, height: 30, borderRadius: 6, flexShrink: 0, background: pl.coverArt ? `url("${pl.coverArt}") center/cover` : `rgba(${readableAccent(accent)},0.28)` }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--st-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pl.name}</div>
                    <div style={{ fontSize: 10.5, color: 'rgba(var(--st-sub-rgb), 0.42)' }}>{(pl.trackIds || []).length} songs</div>
                  </div>
                </button>
              )) : null}
              {/* Create-and-add in one step. With no playlists the sheet was a
                  dead end: it said "No playlists yet" and offered nothing, so
                  "Add to playlist" appeared broken rather than empty. */}
              {onCreatePlaylist ? (
                <button type="button"
                  onClick={async () => {
                    const ids = addToPl.trackIds;
                    const r = await onCreatePlaylist({ name: 'New playlist' });
                    if (r?.ok && r.id) {
                      await onAddTracksToPlaylist?.(r.id, ids);
                      setAddToPl(null);
                      setRenamePl({ id: r.id, name: 'New playlist' });
                    }
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left',
                    padding: '8px 10px', borderRadius: 9, border: 'none', cursor: 'pointer',
                    background: 'transparent', color: `rgb(${readableAccent(accent)})`, fontSize: 12.5, fontWeight: 650,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = `rgba(${readableAccent(accent)},0.12)`; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                  <span style={{ width: 30, height: 30, borderRadius: 6, flexShrink: 0, background: `rgba(${readableAccent(accent)},0.16)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                  </span>
                  New playlist
                </button>
              ) : null}
            </div>
          </div>
        </div>
        </Modal>
      ) : null}

      {/* New playlist. A dialog rather than an inline row: the name is the
          only field, and an inline editor in the rail would shift the list
          under the pointer as you type. */}
      {newPlaylist ? (
        <div onClick={() => setNewPlaylist(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(4,4,6,0.8)' }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(380px, 92vw)', borderRadius: 15, padding: '18px 20px', background: 'rgb(16,16,19)', border: '1px solid rgba(var(--st-fg-rgb), 0.1)', boxShadow: '0 24px 70px rgba(0,0,0,0.6)' }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--st-text)' }}>New playlist</div>
            <input
              autoFocus
              value={newPlaylist.name}
              onChange={(e) => setNewPlaylist({ name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setNewPlaylist(null);
                if (e.key === 'Enter' && newPlaylist.name.trim()) createPlaylistNow();
              }}
              placeholder="Playlist name"
              style={{
                width: '100%', boxSizing: 'border-box', marginTop: 12, padding: '10px 12px',
                borderRadius: 9, outline: 'none', border: '1px solid rgba(var(--st-fg-rgb), 0.12)',
                background: 'rgba(0,0,0,0.35)', color: 'var(--st-text)', fontSize: 13, fontFamily: 'inherit',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button type="button" onClick={() => setNewPlaylist(null)}
                style={{ flex: 1, padding: '9px 14px', borderRadius: 9, cursor: 'pointer', border: '1px solid rgba(var(--st-fg-rgb), 0.12)', background: 'rgba(var(--st-fg-rgb), 0.05)', color: 'var(--st-text)', fontSize: 12, fontWeight: 650 }}>
                Cancel
              </button>
              <button type="button" disabled={!newPlaylist.name.trim()} onClick={createPlaylistNow}
                style={{
                  flex: 1, padding: '9px 14px', borderRadius: 9, cursor: newPlaylist.name.trim() ? 'pointer' : 'default',
                  border: 'none', background: `rgb(${readableAccent(accent)})`, color: accentTextColor(readableAccent(accent)),
                  fontSize: 12, fontWeight: 700, opacity: newPlaylist.name.trim() ? 1 : 0.45,
                }}>
                Create
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <VideoPicker
        open={!!pick}
        meta={pick?.meta}
        seed={pick?.seed}
        accent={accent}
        pushToast={pushToast}
        onClose={() => setPick(null)}
        onImported={(track) => { if (pick?.dlKey) markDl(pick.dlKey, 'done'); onTrackImported?.(track); }}
      />
      {/* Fullscreen Now Playing — portaled to <body> so it escapes the content
          column and covers the entire window, nav rail included. */}
      {libExpanded && section === 'library' && currentTrack ? createPortal(
        <div className="sth-npfull">
          <NowPlayingPanel
            track={currentTrack} isPlaying={isPlaying} art={currentTrack ? coverFor(currentTrack) : null} accent={accent}
            onOpenFullscreen={toggleLibExpanded} onCollapseToBar={toggleNpBar} expanded
            volume={volume} onSetVolume={onSetVolume} onTogglePlay={onTogglePlay} onPrev={onPrev} onNext={onNext}
            shuffleOn={shuffleOn} repeat={repeat} onToggleShuffle={onToggleShuffle} onToggleRepeat={onToggleRepeat}
            animatedBg={npAnimatedBg} onToggleAnimatedBg={toggleNpAnimatedBg}
            showLyrics={npShowLyrics} onToggleLyrics={toggleNpShowLyrics}
            showCredits={npShowCredits} onToggleCredits={toggleNpShowCredits}
            lyricsData={lyricsData} onLyricsSaved={onLyricsSaved} currentTime={currentTime} onSeek={onSeek}
            library={library} onPlayTrack={onPlayTrack}
            upNext={queueIndex >= 0 ? queue.slice(queueIndex + 1) : []}
            onSelectTrack={(tr) => onPlayTrack?.(tr, queue)}
            lyricSelection={lyricSel} onLyricSelectStart={startLyricSel} onLyricSelectLine={extendLyricSel}
            onBrowseLyrics={onPickLyrics ? () => setLyricsPickReq((n) => n + 1) : null}
            ccOpen={ccOpen} ccExiting={ccExiting} onToggleCc={toggleCc}
            bigCoverRef={npBigCoverRef} miniCoverRef={npMiniCoverRef}
            coverInFlight={coverFlight.inFlight}
            commandCenter={(
              <CommandCenter
                open={ccOpen}
                exiting={ccExiting}
                onRequestClose={toggleCc}
                variant="rail"
                library={library}
                playEvents={playEvents}
                releases={releases}
                releasesRefreshing={releasesRefreshing}
                albumCoverOverrides={albumCoverOverrides}
                currentTrack={currentTrack}
                currentTrackId={currentTrack?.id || null}
                isPlaying={isPlaying}
                followedArtists={followedArtists}
                accent={accent}
                reduceMotion={npReduceMotion}
                /* `library`, NOT `queue`. playTrack() looks the clicked track
                   up inside the list it's given; passing the CURRENT queue
                   meant any track not already queued came back as index -1,
                   fell through to 0, and played whatever happened to be first.
                   The overlay passes library here for exactly this reason. */
                onSelectTrack={(tr) => onPlayTrack?.(tr, library, 'list')}
                onPlayTrack={onPlayTrack}
                onTrackImported={onTrackImported}
                onRefreshReleases={onRefreshReleases}
                onFollowArtist={onFollowArtist}
                onUnfollowArtist={onUnfollowArtist}
                onUpdateTrackMetadata={onUpdateTrackMetadata}
                onUpdateAlbumMetadata={onUpdateAlbumMetadata}
                onRemoveFromLibrary={onRemoveFromLibrary}
                /* The card opens the HOST's dialogs — StudioHome already has
                   a MetadataEditor, so there's no second copy of that chrome. */
                onEditTrackMeta={(tr) => setEditingTrack(tr)}
                onEditAlbumMeta={() => { /* album editor lives in the overlay only for now */ }}
                onConfirm={(cfg) => { if (cfg?.onConfirm) cfg.onConfirm(); }}
                onMenu={() => { /* no fullscreen context menu on this surface yet */ }}
                onReturnFocus={() => { try { document.querySelector('.sth-npfull')?.focus?.(); } catch { /* ignore */ } }}
                notify={(ok, msg) => pushToast?.({ message: String(msg || ''), kind: ok ? 'success' : 'error', durationMs: ok ? 3200 : 7000 })}
              />
            )}
          />
          {/* Lyrics browser. Trigger suppressed — it's driven by the toolbar
              button via openRequest, same as the overlay. Its modal portals to
              document.body so it lands above the fullscreen layer. */}
          {onPickLyrics && currentTrack ? (
            <LyricsPickerButton
              currentTrack={currentTrack}
              accent={accent}
              visible={false}
              hideTrigger
              openRequest={lyricsPickReq}
              onApply={onPickLyrics}
              appliedText={lyricsData
                ? (lyricsData.synced?.length
                  ? lyricsData.synced.map((l) => l.text).join('\n')
                  : (lyricsData.plain || ''))
                : ''}
              appliedId={lyricsData?.lyricId ?? null}
            />
          ) : null}

          {/* Selection action bar. Top-centre deliberately: the bottom band is
              the transport and the dock cards, and a bar that covers those is
              worse than one you have to look up for. */}
          {lyricSel && !lyricShareOpen ? (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'fixed', left: '50%', top: 26, transform: 'translateX(-50%)',
                zIndex: 45, display: 'flex', alignItems: 'center', gap: 12,
                padding: '9px 11px 9px 15px', borderRadius: 13,
                background: 'rgba(16,16,20,0.9)',
                border: '1px solid rgba(var(--st-fg-rgb), 0.09)',
                boxShadow: '0 12px 44px rgba(0,0,0,0.55)',
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(var(--st-text-rgb), 0.72)', fontVariantNumeric: 'tabular-nums' }}>
                {lyricSel.end - lyricSel.start + 1} line{lyricSel.end === lyricSel.start ? '' : 's'} selected
              </span>
              <button type="button" onClick={() => setLyricShareOpen(true)}
                style={{
                  padding: '7px 16px', borderRadius: 9,
                  border: `1px solid rgba(${readableAccent(accent)},0.45)`,
                  background: `rgba(${readableAccent(accent)},0.28)`,
                  color: 'var(--st-text)', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                }}>
                Make card
              </button>
              <button type="button" onClick={clearLyricSel}
                title="Cancel selection (Esc)"
                style={{
                  width: 26, height: 26, borderRadius: 8, border: 'none',
                  background: 'rgba(var(--st-fg-rgb), 0.06)', color: 'rgba(var(--st-sub-rgb), 0.55)',
                  fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                ×
              </button>
            </div>
          ) : null}

          {lyricShareOpen && selectedLyricLines.length ? (
            <LyricShare
              lines={selectedLyricLines}
              track={currentTrack}
              coverUrl={currentTrack ? coverFor(currentTrack) : null}
              startTime={lyricSel && lyricsData?.synced?.length
                ? lyricsData.synced[lyricSel.start]?.time ?? null : null}
              accent={accent}
              onClose={() => setLyricShareOpen(false)}
              onNotify={(ok, msg) => {
                pushToast?.({ message: msg, kind: ok ? 'success' : 'error', durationMs: ok ? 3000 : 6500 });
                if (ok) clearLyricSel();
              }}
            />
          ) : null}

          {/* Cover ghost — fixed-position, flies between the big cover and the
              mini header. Rendered at the portal root so it isn't clipped by
              the stage's overflow. */}
          {coverFlight.ghost ? (
            <div
              aria-hidden
              onTransitionEnd={coverFlight.handleTransitionEnd}
              style={{ ...coverFlight.ghostStyle(accent), zIndex: 8, overflow: 'hidden' }}
            >
              {/* <img> rather than a background, for the same reason as the
                  mini header: the ghost SHRINKS from ~400px to 72px over the
                  flight, so it spends most of the animation heavily
                  downscaled. A background-image gets one bilinear step and
                  goes soft on the way down; an <img> is resampled properly at
                  each size. */}
              {currentTrack && coverFor(currentTrack) ? (
                <img
                  src={coverFor(currentTrack)}
                  alt=""
                  draggable={false}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              ) : null}
            </div>
          ) : null}
        </div>,
        document.body,
      ) : null}

      {/* ============ Instant search ======================================
          Last child of the root, so it renders above every other surface
          here and inherits the --st-* variables set on the root — the
          palette takes the current theme and cover accent without being
          handed either. Its own scrim/panel are position: fixed, so where
          it sits in the tree only decides paint order. */}
      <InstantSearch
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        library={library}
        alreadyOwned={alreadyOwned}
        coverFor={coverFor}
        dlState={dlState}
        dlProgress={dlProgress}
        onGetSpotifyTrack={downloadSpotifyRow}
        onGetSlskFile={downloadSoulseekRow}
        onGetSlskAlbum={downloadSsAlbum}
        onPlayTrack={(t) => onPlayTrack?.(t, library, 'list')}
        seed={paletteSeed}
        onFilterLibrary={(q) => {
          setLibFilter(q);
          pickSection('library');
        }}
        onOpenLibraryAlbum={(t) => { pickSection('library'); openAlbumFromRow(t); }}
        onOpenArtist={(artist) => {
          /* "Open full page" from the panel's artist view. */
          setPaletteOpen(false);
          openArtistAnywhere({ name: artist?.name, spotifyId: artist?.id, image: artist?.imageUrl || artist?.image || null });
        }}
        /* The artist view, rendered inside the search panel. Same component
           as the full page, so the two can't drift apart; `nav` keeps
           everything it opens inside the panel. */
        renderArtist={(ref, nav) => {
          const art = artistRefFor(ref);
          return (
            <ArtistPage
              /* By name, not art.key: that flips from `sp:<id>` to the name
                 when you save one of their songs, which remounted the whole
                 view mid-visit. */
              key={String(art.name || '').trim().toLowerCase() || art.key}
              embedded
              artist={art}
              accent={accent}
              theme={theme}
              playEvents={playEvents}
              currentTrack={currentTrack}
              isPlaying={isPlaying}
              onPlayTrack={onPlayTrack}
              onTogglePlay={onTogglePlay}
              onOpenAlbum={(key) => { setPaletteOpen(false); pickSection('library'); setLibDetail({ kind: 'album', key }); }}
              onOpenRelease={nav.openAlbum}
              onJumpToFind={(q) => nav.search(q)}
              onOpenFullPage={nav.openPage}
              following={isFollowing(art)}
              onToggleFollow={() => toggleFollow(art)}
              hasArtist={(n) => libArtists.some((a) => a.key === String(n || '').toLowerCase())}
              onConnectSpotify={() => { setPaletteOpen(false); pickSection('settings'); setSetCat('connections'); }}
              onOpenRelated={(r) => nav.openArtist(r)}
              dlState={dlState}
              dlProgress={dlProgress}
              onGetTrack={downloadSpotifyRow}
              ownedTrackFor={ownedTrackFor}
            />
          );
        }}
      />
    </div>
    </CompactVizContext.Provider>
  );
}

/* =========================================================================
 *  Pieces
 * ========================================================================= */

/** Section page header: lowercase display title + muted subline + actions. */
function PageHead({ title, sub, actions = null }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 26, flexWrap: 'wrap' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 30, fontWeight: 650, letterSpacing: '-0.015em', color: 'var(--st-text)', lineHeight: 1.05 }}>{title}</div>
        {sub ? <div style={{ fontSize: 12.5, color: 'rgba(var(--st-sub-rgb), 0.42)', marginTop: 8 }}>{sub}</div> : null}
      </div>
      <div style={{ flex: 1 }} />
      {actions ? <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{actions}</div> : null}
    </div>
  );
}

/** A titled section on the Home dashboard, with a "view all →" affordance. */

/** A stat tile for the Home dashboard, with a mini sparkline. */
function HomeStatCard({ icon, value, label, spark = [], accent, delta = null }) {
  const glyph = {
    notes: <path d="M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm12-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />,
    artist: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 12 0v1" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    disc: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.5" /></>,
  }[icon];
  return (
    <div className="sth-card" style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '16px 18px' }}>
      <div style={{
        width: 38, height: 38, borderRadius: 10, flexShrink: 0,
        background: `rgba(${accent}, 0.16)`, border: `1px solid rgba(${accent}, 0.3)`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={`rgb(${accent})`} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{glyph}</svg>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--st-text)', letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{value}</div>
          {Number.isFinite(delta) ? <DeltaChip pct={delta} /> : null}
        </div>
        <div style={{ fontSize: 11, color: 'rgba(var(--st-sub-rgb), 0.45)', marginTop: 3 }}>{label}</div>
      </div>
      <div style={{ flex: 1 }} />
      <Sparkline data={spark} accent={accent} />
    </div>
  );
}

/** Small ▲/▼ change chip vs the previous 7 days. */
function DeltaChip({ pct }) {
  const flat = Math.round(pct) === 0;
  const up = pct >= 0;
  const color = flat ? 'rgba(var(--st-fg-rgb), 0.5)' : up ? 'rgb(120,220,150)' : 'rgb(240,150,150)';
  return (
    <span title="vs previous 7 days" style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 10.5, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
      {flat ? (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
      ) : (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ transform: up ? 'none' : 'scaleY(-1)' }}><polyline points="5 15 12 8 19 15" /></svg>
      )}
      {Math.abs(Math.round(pct))}%
    </span>
  );
}

/** Compact insight tile — icon chip + label + value + accent context line. */
/** Mockup-style headline stat card: label + corner icon, big value, delta line. */
function StatCard2({ icon, label, value, delta = null, deltaLabel = '', accent }) {
  const glyph = {
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    notes: <path d="M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm12-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />,
    artist: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 12 0v1" /></>,
    disc: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.5" /></>,
  }[icon];
  const hasDelta = Number.isFinite(delta);
  const up = (delta || 0) >= 0;
  const flat = hasDelta && Math.round(delta) === 0;
  const dColor = flat ? 'rgba(var(--st-fg-rgb), 0.5)' : up ? 'rgb(120,220,150)' : 'rgb(240,150,150)';
  return (
    <div className="sth-card" style={{ padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(var(--st-sub-rgb), 0.6)' }}>{label}</div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(var(--st-fg-rgb), 0.4)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>{glyph}</svg>
      </div>
      <div style={{ fontSize: 27, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--st-text)', marginTop: 8, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {hasDelta ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 8, fontSize: 11 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: dColor, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
            {flat ? (
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
            ) : (
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ transform: up ? 'none' : 'scaleY(-1)' }}><polyline points="5 15 12 8 19 15" /></svg>
            )}
            {Math.abs(Math.round(delta))}%
          </span>
          <span style={{ color: 'rgba(var(--st-sub-rgb), 0.4)' }}>vs {deltaLabel}</span>
        </div>
      ) : null}
    </div>
  );
}

/** Date-range pill with a small presets popover (7 / 30 / 90 days). */
function DateRangePill({ range, onPick, label, accent }) {
  const [open, setOpen] = useState(false);
  const presets = [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days']];
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen((v) => !v)} style={{
        display: 'inline-flex', alignItems: 'center', gap: 9, padding: '8px 12px', borderRadius: 10,
        border: '1px solid rgba(var(--st-fg-rgb), 0.12)', background: 'rgba(var(--st-fg-rgb), 0.05)', cursor: 'pointer', color: 'var(--st-text)', fontSize: 12, fontWeight: 600,
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(var(--st-fg-rgb), 0.55)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="16" y1="2" x2="16" y2="6" /></svg>
        {label}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(var(--st-fg-rgb), 0.5)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }}><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open ? (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 41, minWidth: 162, padding: 5, borderRadius: 12, background: 'rgba(22,22,24,0.97)', border: '1px solid rgba(var(--st-fg-rgb), 0.12)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', boxShadow: '0 20px 50px rgba(0,0,0,0.5)' }}>
            {presets.map(([v, lbl]) => (
              <button key={v} type="button" onClick={() => { onPick(v); setOpen(false); }} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 10, padding: '8px 10px', borderRadius: 8, border: 'none', cursor: 'pointer',
                background: range === v ? `rgba(${accent}, 0.16)` : 'transparent', color: range === v ? '#fff' : 'rgba(var(--st-fg-rgb), 0.75)', fontSize: 12, fontWeight: 600, textAlign: 'left',
              }}
                onMouseEnter={(e) => { if (range !== v) e.currentTarget.style.background = 'rgba(var(--st-fg-rgb), 0.06)'; }}
                onMouseLeave={(e) => { if (range !== v) e.currentTarget.style.background = 'transparent'; }}
              >
                {lbl}
                {range === v ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={`rgb(${accent})`} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Compact labelled dropdown (library view + sort). */
/** Chrome that lives INSIDE a list panel: the view tabs and the
 *  Shuffle / Play all actions on one row, search and sort on the next. Keeping
 *  it in the panel means the library reads as a single surface rather than
 *  controls floating above a card. */
/** Chrome that lives INSIDE a list panel: the view picker on the left, the
 *  search field filling the centre, and sort / shuffle / play on the right —
 *  all on one row, so the panel keeps as much height as possible for content. */
function LibPanelHeader({ value, onChange, placeholder, sort, view, onPickView, accent, onShuffle, onPlayAll, onImportFiles, onImportFolder, importing = false }) {
  const acc = readableAccent(accent);
  const [importOpen, setImportOpen] = useState(false);
  return (
    <div style={{ flexShrink: 0, borderBottom: '1px solid rgba(var(--st-fg-rgb), 0.06)', display: 'flex', alignItems: 'center', gap: 8, padding: '11px 12px' }}>
      <LibMenu
        compact
        value={view}
        options={[['songs', 'Songs'], ['albums', 'Albums'], ['artists', 'Artists']]}
        onPick={onPickView}
        accent={accent}
        align="left"
      />
      {/* Search takes the whole middle, so it reads as centred between the
          view picker and the actions. */}
      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(var(--st-fg-rgb), 0.4)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
          <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35" />
        </svg>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') onChange(''); }}
          placeholder={placeholder}
          spellCheck={false}
          style={{ width: '100%', height: 30, padding: '0 12px 0 32px', borderRadius: 9, background: 'rgba(var(--st-fg-rgb), 0.05)', border: '1px solid rgba(var(--st-fg-rgb), 0.09)', outline: 'none', color: 'var(--st-text)', fontSize: 12, boxSizing: 'border-box' }}
        />
      </div>
      {sort || null}
      {onImportFiles || onImportFolder ? (
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            type="button"
            className="sth-actbtn"
            onClick={() => setImportOpen((o) => !o)}
            disabled={importing}
            title="Import music from this computer"
            aria-label="Import music from this computer"
            style={importing ? { opacity: 0.5, cursor: 'default' } : undefined}
          >
            {importing ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <path d="M12 3a9 9 0 1 0 9 9">
                  <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite" />
                </path>
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 16V4" /><polyline points="7 9 12 4 17 9" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
              </svg>
            )}
          </button>
          {importOpen && !importing ? (
            <>
              {/* Click-away catcher — cheaper and more reliable here than a
                  document listener that has to dodge the button's own click. */}
              <div
                onClick={() => setImportOpen(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 40 }}
              />
              <div style={{
                position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 41,
                minWidth: 178, padding: 5, borderRadius: 11,
                background: 'rgb(18, 18, 21)',
                border: '1px solid rgba(var(--st-fg-rgb), 0.1)',
                boxShadow: '0 14px 38px rgba(0,0,0,0.6)',
              }}>
                <ImportMenuItem
                  label="Add files…"
                  hint="Pick individual tracks"
                  onClick={() => { setImportOpen(false); onImportFiles?.(); }}
                />
                <ImportMenuItem
                  label="Add folder…"
                  hint="Scans subfolders too"
                  onClick={() => { setImportOpen(false); onImportFolder?.(); }}
                />
                <div style={{
                  padding: '7px 9px 4px', fontSize: 10, lineHeight: 1.45,
                  color: 'rgba(var(--st-sub-rgb), 0.35)', borderTop: '1px solid rgba(var(--st-fg-rgb), 0.07)', marginTop: 4,
                }}>
                  Or drag files and folders anywhere onto the window.
                </div>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      <button type="button" className="sth-actbtn" onClick={onShuffle} title="Shuffle the whole library" aria-label="Shuffle the whole library">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></svg>
      </button>
      <button type="button" className="sth-playbtn" onClick={onPlayAll} title="Play everything" style={{ background: `rgb(${acc})`, color: accentTextColor(acc) }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21" /></svg>
        Play
      </button>
    </div>
  );
}

function ImportMenuItem({ label, hint, onClick }) {
  const [h, setH] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: '7px 9px', borderRadius: 8, border: 'none', cursor: 'pointer',
        background: h ? 'rgba(var(--st-fg-rgb), 0.08)' : 'transparent',
        transition: 'background 0.13s ease',
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--st-text)' }}>{label}</div>
      <div style={{ fontSize: 10, color: 'rgba(var(--st-sub-rgb), 0.42)', marginTop: 1 }}>{hint}</div>
    </button>
  );
}

/** Credits view for the Now Playing panel. Fetches from Genius on demand
 *  (handled by the parent) and renders grouped roles. */
/* --- Ported from the overlay (Overlays.jsx) so credits/queue behave identically. --- */
function DockCard({ side, label, open, onToggle, accent, layout = 'lane', meta = null, dockBarH = 48, children }) {
  const [hov, setHov] = useState(false);
  const spring = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const TUCK = 6;          // how much of the chip hides behind the dock
  const VISIBLE = 27;      // the label band you can actually see
  const chipH = VISIBLE + TUCK;
  // 'wrap' sizes itself to its content: a ResizeObserver on an inner,
  // never-clipped wrapper reports the grid's TRUE height — re-wraps from
  // window resizes or late data loads re-measure automatically. Numeric
  // px, so the open/close morph still animates.
  const measureRef = useRef(null);
  const [wrapH, setWrapH] = useState(null);
  useLayoutEffect(() => {
    if (layout !== 'wrap') return undefined;
    const el = measureRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h > 0) setWrapH(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout]);
  // 34 header + 4/10 body padding + 2 safety.
  const openH = layout === 'wrap'
    ? Math.min(Math.max((wrapH || 112) + 50, 96), 260)
    : 176;
  return (
    <div
      role={open ? 'dialog' : 'button'}
      aria-label={label}
      tabIndex={open ? -1 : 0}
      onClick={open ? undefined : onToggle}
      onKeyDown={open ? undefined : (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        position: 'absolute', bottom: dockBarH - TUCK, [side]: 14, zIndex: open ? 2 : 1,
        pointerEvents: 'auto',
        width: open ? 'calc(100% - 28px)' : 128,
        height: open ? openH : chipH,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        borderRadius: open ? 16 : '10px 10px 0 0',
        border: '1px solid rgba(var(--st-fg-rgb), 0.1)',
        background: open ? 'rgba(18,18,20,0.78)' : (hov ? 'rgba(26,26,30,0.72)' : 'rgba(18,18,20,0.62)'),
        backdropFilter: 'blur(30px) saturate(1.6)', WebkitBackdropFilter: 'blur(30px) saturate(1.6)',
        boxShadow: open
          ? `0 24px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(${accent},0.22)`
          : '0 -8px 24px rgba(0,0,0,0.35)',
        cursor: open ? 'default' : 'pointer',
        transform: !open && hov ? 'translateY(-4px)' : 'translateY(0)',
        transition: [
          `width 360ms ${spring}`,
          `height 360ms ${spring}`,
          `border-radius 360ms ${spring}`,
          `transform 200ms ${spring}`,
          'background 180ms ease',
          'box-shadow 360ms ease',
        ].join(', '),
      }}
    >
      {/* Header — the same text is chip label and strip title. Centered in
          the chip, slides to the leading edge as the strip stretches. */}
      <div
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        style={{
          position: 'relative', display: 'flex', alignItems: 'center', flexShrink: 0, cursor: 'pointer',
          height: open ? 34 : VISIBLE, padding: open ? '4px 84px 0 16px' : 0,
          transition: `padding 360ms ${spring}, height 360ms ${spring}`,
        }}
      >
        {/* Label — the ONLY element in flow, so the closed chip centers it
            perfectly; open slides it to the leading edge. */}
        <div style={{
          flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          textAlign: open ? 'left' : 'center',
          fontSize: open ? 11 : 9.5, fontWeight: 800, lineHeight: open ? '34px' : `${VISIBLE}px`,
          letterSpacing: '0.12em', textTransform: 'uppercase',
          color: open || hov ? '#fff' : 'rgba(var(--st-fg-rgb), 0.55)',
          transition: `font-size 360ms ${spring}, color 0.15s ease`,
        }}>
          {label}
        </div>
        {/* Right cluster — meta + × float absolutely so they never shove the
            label off-center; they only materialize once the strip is open. */}
        <div style={{
          position: 'absolute', right: 12, top: 0, bottom: 0,
          display: 'flex', alignItems: 'center', gap: 10,
          opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none',
          transition: open ? 'opacity 180ms ease 180ms' : 'opacity 100ms ease',
        }}>
          {meta ? (
            <span style={{ fontSize: 9, letterSpacing: '0.06em', color: 'rgba(var(--st-sub-rgb), 0.32)', whiteSpace: 'nowrap' }}>{meta}</span>
          ) : null}
          <button
            type="button" title="Close"
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            style={{
              width: 22, height: 22, borderRadius: 7, border: 'none', cursor: 'pointer',
              background: 'rgba(var(--st-fg-rgb), 0.08)', color: 'rgba(var(--st-text-rgb), 0.7)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, flexShrink: 0,
            }}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      </div>
      {/* Body — fades/rises in once the strip has mostly stretched; leaves
          first on close so the box collapses empty. 'wrap' flows groups into
          rows so everything fits one page; 'lane' is a column-flow grid. */}
      <div style={{
        flex: 1, minHeight: 0,
        padding: '4px 14px 10px',
        ...(layout === 'wrap' ? {
          display: 'block', overflow: 'hidden',
        } : {
          display: 'grid', gridTemplateRows: 'repeat(3, 1fr)', gridAutoFlow: 'column',
          gridAutoColumns: 'minmax(210px, 250px)', gap: '1px 20px',
          overflowX: 'auto', overflowY: 'hidden',
        }),
        opacity: open ? 1 : 0,
        transform: open ? 'translateY(0)' : 'translateY(10px)',
        pointerEvents: open ? 'auto' : 'none',
        transition: open
          ? `opacity 220ms ease 150ms, transform 340ms ${spring} 130ms`
          : 'opacity 110ms ease, transform 150ms ease',
        scrollbarWidth: 'thin', scrollbarColor: 'rgba(var(--st-fg-rgb), 0.15) transparent',
      }}>
        {layout === 'wrap' ? (
          <div ref={measureRef} style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
            gridAutoRows: 'auto', alignContent: 'start', gap: '10px 16px',
          }}>
            {children}
          </div>
        ) : children}
      </div>
    </div>
  );
}

/** One labelled group inside the Credits card. */
function CreditGroup({ label, names, accent = '160,160,160', style }) {
  return (
    <div style={{
      minWidth: 0, minHeight: 42, overflow: 'hidden', padding: '2px 0 2px 10px',
      borderLeft: `2px solid rgba(${accent}, 0.4)`,
      display: 'flex', flexDirection: 'column', justifyContent: 'flex-start',
      ...style,
    }}>
      <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(var(--st-sub-rgb), 0.4)', marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      <div style={{
        fontSize: 11.5, fontWeight: 500, color: 'rgba(var(--st-text-rgb), 0.9)', lineHeight: 1.4,
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }} title={names.join(', ')}>{names.join(', ')}</div>
    </div>
  );
}

/** Tiny 3-bar equalizer marking the playing row in the library panel.
 *  Animates while playing, freezes as short bars when paused. */

/** Fullscreen library list — the song library as a scrollable list you can
 *  play from without leaving fullscreen. The current track is highlighted. */
function NpLibraryView({ library, currentId, onPlayTrack, accent }) {
  const acc = readableAccent(accent);
  if (!library || !library.length) {
    return <div className="sth-fscredit-state"><div style={{ fontSize: 13, color: 'rgba(var(--st-sub-rgb), 0.5)' }}>Your library is empty.</div></div>;
  }
  return (
    <div className="sth-fslib">
      <div className="sth-fslib-head">Library <span>{library.length}</span></div>
      <div className="sth-fslib-list sth-vscroll">
        {library.map((tk) => {
          const active = currentId != null && tk.id === currentId;
          return (
            <button
              key={tk.id}
              type="button"
              className={`sth-fslib-row${active ? ' is-active' : ''}`}
              onClick={() => onPlayTrack?.(tk, library)}
              title={`${tk.title} — ${tk.artist || ''}`}
            >
              <span className="sth-fslib-art" style={{ background: tk.coverUrl ? `url("${tk.coverUrl}") center/cover` : 'rgba(var(--st-fg-rgb), 0.07)' }}>
                {active ? <span className="sth-fslib-eq" style={{ color: `rgb(${acc})` }}><i /><i /><i /></span> : null}
              </span>
              <span style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
                <span className="sth-fslib-title" style={active ? { color: `rgb(${acc})` } : undefined}>{tk.title}</span>
                <span className="sth-fslib-sub">{tk.artist}{tk.album ? ` · ${tk.album}` : ''}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Fullscreen credits — the overlay's accent-bordered card grid, sized for the
 *  fullscreen side column. */
function NpFsCredits({ credits, state, accent }) {
  const acc = readableAccent(accent);
  /* Declared inside the component, so it's a new type on every render and the
     cards remount. They animate in on mount, so that means the entrance
     replays whenever anything above re-renders. Harmless while this overlay is
     static; it would become a flicker the moment it isn't. Left as-is rather
     than restructured, but noted — the queue row had the same shape and it
     cost the list its hover state. */
  const Group = ({ label, names, i = 0 }) => (
    names && names.length ? (
      <div className="sth-fscredit" style={{ borderLeft: `2px solid rgba(${acc}, 0.45)`, animationDelay: `${0.05 + i * 0.05}s` }}>
        <div className="sth-fscredit-label">{label}</div>
        <div className="sth-fscredit-names" title={names.join(', ')}>{names.join(', ')}</div>
      </div>
    ) : null
  );
  if (state === 'loading') {
    return (
      <div className="sth-fscredit-state">
        <div className="sth-spinner" style={{ borderTopColor: `rgb(${acc})` }} />
        <div style={{ fontSize: 12 }}>Looking up credits…</div>
      </div>
    );
  }
  if (state === 'error' || !credits) {
    return (
      <div className="sth-fscredit-state">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="rgba(var(--st-fg-rgb), 0.28)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></svg>
        <div style={{ fontSize: 13, color: 'rgba(var(--st-sub-rgb), 0.5)' }}>No credits found</div>
        <div style={{ fontSize: 11.5, color: 'rgba(var(--st-sub-rgb), 0.34)' }}>Genius didn't have a confident match.</div>
      </div>
    );
  }
  return (
    <div className="sth-fscredit-grid">
      <Group label="Performed by" names={credits.primary} i={0} />
      <Group label="Written by" names={credits.writers} i={1} />
      <Group label="Produced by" names={credits.producers} i={2} />
      {(credits.performances || []).map((p, i) => (
        <Group key={`${p.label}-${i}`} label={p.label} names={Array.isArray(p.names) ? p.names : [p.names]} i={3 + i} />
      ))}
    </div>
  );
}

function NpCreditsView({ credits, state, accent, track }) {
  const acc = readableAccent(accent);
  const Group = ({ label, names }) => (
    names && names.length ? (
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.13em', textTransform: 'uppercase', color: `rgb(${acc})`, marginBottom: 6 }}>{label}</div>
        {names.map((n, i) => (
          <div key={`${n}-${i}`} style={{ fontSize: 13, color: 'rgba(var(--st-text-rgb), 0.82)', lineHeight: 1.5 }}>{n}</div>
        ))}
      </div>
    ) : null
  );
  return (
    <div className="sth-libscroll sth-vscroll" style={{ padding: '24px 24px 34px', animation: 'sthNpTxtIn 380ms cubic-bezier(0.22,1,0.36,1) both' }}>
      {state === 'loading' ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, color: 'rgba(var(--st-sub-rgb), 0.4)' }}>
          <div className="sth-spinner" style={{ borderTopColor: `rgb(${acc})` }} />
          <div style={{ fontSize: 11.5 }}>Looking up credits…</div>
        </div>
      ) : state === 'error' || !credits ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, textAlign: 'center', color: 'rgba(var(--st-sub-rgb), 0.4)' }}>
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="rgba(var(--st-fg-rgb), 0.28)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></svg>
          <div style={{ fontSize: 12.5, color: 'rgba(var(--st-sub-rgb), 0.5)' }}>No credits found</div>
          <div style={{ fontSize: 11, color: 'rgba(var(--st-sub-rgb), 0.34)' }}>Genius didn't have a confident match for this track.</div>
        </div>
      ) : (
        <>
          <Group label="Performed by" names={credits.primary} />
          <Group label="Written by" names={credits.writers} />
          <Group label="Produced by" names={credits.producers} />
          {credits.performances && credits.performances.length ? (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.13em', textTransform: 'uppercase', color: `rgb(${acc})`, marginBottom: 6 }}>Credits</div>
              {credits.performances.map((perf, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12.5, color: 'rgba(var(--st-text-rgb), 0.72)', lineHeight: 1.55, padding: '1px 0' }}>
                  <span style={{ color: 'rgba(var(--st-sub-rgb), 0.48)', flexShrink: 0 }}>{perf.label}</span>
                  <span style={{ textAlign: 'right' }}>{Array.isArray(perf.names) ? perf.names.join(', ') : perf.names}</span>
                </div>
              ))}
            </div>
          ) : null}
          {credits.releaseDate ? (
            <div style={{ fontSize: 11.5, color: 'rgba(var(--st-sub-rgb), 0.4)', marginTop: 4 }}>Released {credits.releaseDate}</div>
          ) : null}
          {credits.url ? (
            <a href={credits.url} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 12, fontSize: 11, color: `rgb(${acc})`, textDecoration: 'none', opacity: 0.85 }}>View on Genius ↗</a>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Lyrics view for the Now Playing panel. Synced lyrics highlight and
 *  auto-scroll to the current line; plain lyrics render as a static block. */
function NpLyricsView({ lyricsData, currentTime, accent, onSeek, fontSize = 15, track, onLyricsSaved,
  selection = null, onSelectStart, onSelectLine, onBrowseLyrics }) {
  const acc = readableAccent(accent);
  /* This view used to keep an optimistic `local` copy of freshly-saved
   * lyrics. That shadowed the real owner and lost the save two ways:
   *
   *   - This component is mounted TWICE (collapsed panel and expanded
   *     panel), each with its own `local`. Saving in the expanded one and
   *     then leaving fullscreen unmounted the instance holding the result;
   *     the collapsed instance still had `local === null` and fell back to
   *     the stale `lyricsData` prop.
   *   - StudioShell caches lyrics per track id and was never told about the
   *     save, so switching tracks and coming back served the stale entry.
   *
   * The lyrics were always safely in the DB — they were just being hidden by
   * caches that never heard about the write. Now the save reports up to
   * StudioShell, the single owner, exactly as the overlay's editor does. */
  const [editing, setEditing] = useState(false);
  useEffect(() => { setEditing(false); }, [track ? track.id : null]);

  const synced = lyricsData?.synced || null;
  const plain = lyricsData?.plain || null;
  const hasLyrics = !!((synced && synced.length) || plain);

  if (editing) {
    return (
      <div className="sth-lyrics-editor">
        <LyricsEditor
          track={track}
          currentTime={currentTime}
          existingSynced={synced}
          existingPlain={plain}
          accent={accent}
          onSeek={onSeek}
          onSave={(newSynced, newPlain) => { onLyricsSaved?.(newSynced, newPlain, track?.id); setEditing(false); }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  if (!hasLyrics) {
    return (
      <div className="sth-lyrics-empty">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="rgba(var(--st-fg-rgb), 0.28)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h11M4 10h9M4 14h11M4 18h7" /></svg>
        <div style={{ fontSize: 13.5, color: 'rgba(var(--st-sub-rgb), 0.6)', fontWeight: 600 }}>No lyrics for this track</div>
        {track ? (
          <button type="button" className="sth-lyrics-btn" onClick={() => setEditing(true)} style={{ background: `rgb(${acc})`, color: accentTextColor(acc) }}>Add lyrics</button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="sth-lyrics-pane">
      {synced && synced.length ? (
        /* lineHeight passed explicitly to match the overlay — SyncedLyrics
           defaults to 1.55, the overlay's fullscreen stage uses 1.5, and the
           difference compounds visibly over a screen's worth of lines. */
        <SyncedLyrics lines={synced} currentTime={currentTime} accent={accent} onSeek={onSeek} fontSize={fontSize} lineHeight={1.5}
          selection={selection} onSelectStart={onSelectStart} onSelectLine={onSelectLine} />
      ) : (
        <div className="sth-libscroll sth-vscroll" style={{ height: '100%', padding: '10px 12px' }}>
          <PlainLyrics text={plain} accent={accent} fontSize={Math.max(13, fontSize - 1)} lineHeight={1.7} />
        </div>
      )}
      {/* Pencil = edit + tap-to-sync, lines = browse other versions. Same
          pair, icons and geometry as the overlay's LyricTools so the two
          surfaces don't disagree about what these buttons look like. */}
      {track ? (
        <div className="sth-lyrtools">
          <button type="button" className="sth-lyrtool" onClick={() => setEditing(true)}
            title="Edit lyrics · tap-to-sync" aria-label="Edit lyrics">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>
          </button>
          {onBrowseLyrics ? (
            <button type="button" className="sth-lyrtool" onClick={onBrowseLyrics}
              title="Browse lyrics versions" aria-label="Browse lyrics versions">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Floating Now Playing bar — the collapsed form of the panel, pinned to the
 *  bottom of the library content area (Spotify-mobile style). Keeps the
 *  animated background when that option is on. Clicking the body (not a
 *  control) expands back to the full panel. */

/* Width of the docked Now Playing panel. Exported as a constant because the
   content wrapper has to reserve exactly this much when it's open — a
   mismatch shows up as either a gap or a clipped panel. */
const NP_PANEL_W = 360;

/* Category titles for the settings body heading. Kept beside the rail's own
   labels so the two can't drift — the rail says "Colour", the heading says
   "Colour", and neither is a hardcoded string in the middle of the JSX. */
/**
 * SetHowTo — the settings-surface twin of onboarding's HowTo.
 *
 * Separate component rather than a shared one because the two live on
 * different surfaces: onboarding is fixed white-on-black, settings follows
 * the cover-derived theme variables.
 */
function SetHowTo({ label, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 9 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, padding: 0,
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'rgba(var(--st-sub-rgb), 0.72)', fontSize: 11.5, fontWeight: 700,
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.18s ease' }}>
          <path d="M9 6l6 6-6 6" />
        </svg>
        {label}
      </button>
      <div style={{
        display: 'grid', gridTemplateRows: open ? '1fr' : '0fr',
        opacity: open ? 1 : 0,
        transition: 'grid-template-rows 0.26s cubic-bezier(0.22,1,0.36,1), opacity 0.18s ease',
      }}>
        <div style={{ overflow: 'hidden' }}>
          <div style={{ paddingTop: 9, fontSize: 11.5, color: 'rgba(var(--st-sub-rgb), 0.62)' }}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A value that has to be typed or copied exactly. */
function SetLit({ children }) {
  return (
    <span style={{
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 11, color: 'var(--st-text)',
      background: 'rgba(var(--st-fg-rgb), 0.09)', borderRadius: 5, padding: '1px 5px',
    }}>{children}</span>
  );
}

const SET_CATS = {
  colour: { title: 'Color', sub: 'Which surfaces take their color from the artwork, and how strongly.' },
  layout: { title: 'Layout', sub: 'How pages and lists are arranged.' },
  library: { title: 'Library', sub: 'What the song table shows, and managing the library itself.' },
  playback: { title: 'Playback', sub: 'How one track gives way to the next.' },
  discord: { title: 'Discord', sub: 'What Studio shows on your Discord profile.' },
  connections: { title: 'Connections', sub: 'Services Studio uses for search, metadata and downloads.' },
};

const NP_PANEL_TABS = [
  ['queue', 'Queue'],
  ['lyrics', 'Lyrics'],
  ['info', 'Info'],
];

/**
 * NowPlayingPanelDock — the persistent right-hand column.
 *
 * Replaces the two floating popouts. They were transient overlays, which meant
 * you couldn't browse and read lyrics at once, and the two fought over the same
 * corner (opening one had to close the other). A docked panel that the content
 * makes room for solves both, and matches how the reference behaves.
 *
 * Open state is persisted by the caller, so the layout is stable across
 * navigation rather than re-shifting every time you come back to a page.
 */
/**
 * Fullscreen Now Playing.
 *
 * One card over the whole window, 10px from every edge — the same inset
 * compact mode uses, so the two read as one family. The cover, the song and
 * the transport sit centred on their own; opening Lyrics, Queue or Info
 * slides a panel in on the right and the stage re-centres in what's left.
 * The panel is this view's own, not the side dock: the dock is suppressed
 * while this is up, and its three tab bodies (QueueTab, LyricsTab, InfoTab)
 * are reused here unchanged, so lyric editing, queue reordering and lyric
 * selection behave identically in both places.
 *
 * The strip across the top is the window's drag region — the top bar is
 * covered, and a frameless window needs something to hold.
 */
const NP_FULL_TABS = [
  ['lyrics', 'Lyrics', 'L'],
  ['queue', 'Queue', 'Q'],
  ['info', 'Info', 'I'],
];

function NowPlayingFullView({
  track, art, accent, isPlaying = false, currentTime = 0, onSeek,
  onTogglePlay, onPrev, onNext, shuffleOn = false, repeat = 'off', onToggleShuffle, onToggleRepeat,
  volume = 1, onSetVolume, onToggleFavorite, onAddToPlaylist, onMore,
  onCopyLink, copyBusy = false, onZoomCover,
  animatedBg = false, immersePalette = null,
  tab = null, onTab, onClose,
  coverFor, upNext = [], onSelectTrack, onReorderQueue, queueOffset = 0,
  lyricsData, onLyricsSaved, onBrowseLyrics,
  lyricSelection = null, onLyricSelectStart, onLyricSelectLine,
  artistInfo, credits,
}) {
  const acc = readableAccent(accent);
  const dur = Number.isFinite(track.duration) && track.duration > 0 ? track.duration : 0;

  /* Scrubbing — same contract as the bar: follow the pointer while held,
     seek once on release. */
  const [scrub, setScrub] = useState(null);
  const seekRef = useRef(null);
  const posFrom = (x) => {
    const el = seekRef.current; if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (x - r.left) / r.width));
  };
  const beginScrub = (e) => {
    if (!onSeek || !dur) return;
    e.preventDefault();
    setScrub(posFrom(e.clientX));
    const move = (ev) => setScrub(posFrom(ev.clientX));
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setScrub(null);
      onSeek(posFrom(ev.clientX) * dur);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onSeekKey = (e) => {
    if (!onSeek || !dur) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); onSeek(Math.min(dur, currentTime + 5)); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); onSeek(Math.max(0, currentTime - 5)); }
  };
  const shownTime = scrub != null ? scrub * dur : currentTime;
  const pct = dur ? Math.min(100, Math.max(0, (shownTime / dur) * 100)) : 0;
  const fmt = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  };

  const lastVol = useRef(volume > 0 ? volume : 0.6);
  useEffect(() => { if (volume > 0) lastVol.current = volume; }, [volume]);
  const muted = volume <= 0.001;

  const gradBase = immersePalette?.accent || accent;
  const gradMid = immersePalette?.mid || gradBase.split(',').map((n) => Math.round(Number(n) * 0.82)).join(', ');
  const gradWash = immersePalette?.wash || gradBase.split(',').map((n) => Math.round(Number(n) * 0.45)).join(', ');

  const meta2 = [track.artist, track.album].filter(Boolean);

  return (
    <div className={`sth-full${tab ? ' has-panel' : ''}`} role="dialog" aria-modal="true" aria-label="Now playing, fullscreen">
      {/* Backdrop: Immerse's moving gradient when that's on, otherwise the
          artwork blurred under a scrim — the dock's cover treatment, scaled
          up. Both sit behind everything and take no pointer events. */}
      {animatedBg ? (
        <div aria-hidden className="sth-full-bg">
          <AnimatedGradientBg accent={gradBase} mid={gradMid} wash={gradWash} coverUrl={art} isPlaying={isPlaying} vignette={false} brightness={1} />
        </div>
      ) : art ? (
        <div aria-hidden className="sth-full-bg" style={{
          inset: -80, backgroundImage: `url("${art}")`, backgroundSize: 'cover', backgroundPosition: 'center',
          filter: 'blur(80px) saturate(1.6)', opacity: 0.55,
        }} />
      ) : null}
      <div aria-hidden className="sth-full-bg" style={{
        background: `linear-gradient(180deg, rgba(0,0,0,0.30) 0%, rgba(0,0,0,0.46) 55%, rgba(0,0,0,0.62) 100%), linear-gradient(135deg, rgba(${acc},0.10), transparent 60%)`,
      }} />

      {/* ---- Top strip: drag region, panel tabs, exit ---- */}
      <div className="sth-full-top">
        <span className="sth-full-eyebrow">Now playing</span>
        <span style={{ flex: 1 }} />
        <div className="sth-full-tabs" role="tablist" aria-label="Side panel">
          {NP_FULL_TABS.map(([id, label, key]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id}
              className={`sth-full-tab${tab === id ? ' on' : ''}`}
              onClick={() => onTab?.(id)} title={`${label} (${key})`}>
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="sth-npbtn sth-full-exit" onClick={onClose}
          title="Exit fullscreen (Esc)" aria-label="Exit fullscreen">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
          </svg>
        </button>
      </div>

      <div className="sth-full-body">
        {/* ---- Stage: cover, song, transport — centred ---- */}
        <section className="sth-full-stage">
          {art && onZoomCover ? (
            <button type="button" className="sth-full-cover" onClick={() => onZoomCover(art)}
              title="View cover art" aria-label="View cover art full size"
              style={{ backgroundImage: `url("${art}")`, cursor: 'zoom-in' }} />
          ) : (
            <div className="sth-full-cover" style={{ backgroundImage: art ? `url("${art}")` : undefined }} />
          )}

          <div className="sth-full-meta">
            {onCopyLink ? (
              <button type="button" className="sth-full-title is-link" onClick={() => onCopyLink(track)} disabled={copyBusy}
                title={copyBusy ? 'Looking up on Spotify…' : 'Click to copy Spotify link'}
                aria-label={`Copy Spotify link for ${track.title}`}>{track.title}</button>
            ) : (
              <div className="sth-full-title">{track.title}</div>
            )}
            {meta2.length ? <div className="sth-full-sub" title={meta2.join(' · ')}>{meta2.join(' · ')}</div> : null}
          </div>

          <div className="sth-full-scrub">
            <span className="sth-npbar-t st-num" style={{ textAlign: 'right' }}>{fmt(shownTime)}</span>
            <div className="sth-npbar-seek" ref={seekRef}
              onPointerDown={onSeek && dur ? beginScrub : undefined} onKeyDown={onSeekKey}
              role="slider" aria-label="Seek" tabIndex={0}
              aria-valuemin={0} aria-valuemax={Math.round(dur) || 0} aria-valuenow={Math.round(shownTime)}
              aria-valuetext={`${fmt(shownTime)} of ${fmt(dur)}`}>
              <div className="sth-npbar-seek-fill" style={{ width: `${pct}%`, transition: scrub != null ? 'none' : 'width 0.25s linear' }}>
                <span className="sth-npbar-seek-knob" />
              </div>
            </div>
            <span className="sth-npbar-t st-num">{fmt(dur)}</span>
          </div>

          <div className="sth-full-transport">
            {onToggleShuffle ? (
              <button type="button" className={`sth-npbtn${shuffleOn ? ' is-on' : ''}`} onClick={onToggleShuffle}
                title={shuffleOn ? 'Shuffle on' : 'Shuffle off'} aria-label="Shuffle" aria-pressed={shuffleOn}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 3h5v5" /><path d="M4 20L21 3" /><path d="M21 16v5h-5" /><path d="M15 15l6 6" /><path d="M4 4l5 5" />
                </svg>
              </button>
            ) : null}
            {onPrev ? (
              <button type="button" className="sth-npbtn sth-full-skip" onClick={onPrev} title="Previous" aria-label="Previous">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
              </button>
            ) : null}
            {onTogglePlay ? (
              <button type="button" className="sth-full-play" onClick={onTogglePlay}
                title={isPlaying ? 'Pause' : 'Play'} aria-label={isPlaying ? 'Pause' : 'Play'}>
                {isPlaying ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
              </button>
            ) : null}
            {onNext ? (
              <button type="button" className="sth-npbtn sth-full-skip" onClick={onNext} title="Next" aria-label="Next">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7" /></svg>
              </button>
            ) : null}
            {onToggleRepeat ? (
              <button type="button" className={`sth-npbtn${repeat !== 'off' ? ' is-on' : ''}`} onClick={onToggleRepeat}
                title={repeat === 'one' ? 'Repeat this track' : repeat === 'all' ? 'Repeat queue' : 'Repeat off'}
                aria-label={repeat === 'one' ? 'Repeat: this track' : repeat === 'all' ? 'Repeat: queue' : 'Repeat: off'} aria-pressed={repeat !== 'off'}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
                  <polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
                  {repeat === 'one' ? <text x="12" y="15" textAnchor="middle" fontSize="9" fontWeight="700" fill="currentColor" stroke="none">1</text> : null}
                </svg>
              </button>
            ) : null}
          </div>

          <div className="sth-full-actions">
            {onToggleFavorite ? (
              <button type="button" className={`sth-npbtn${track.isFavorite ? ' is-on' : ''}`} onClick={() => onToggleFavorite(track.id)}
                title={track.isFavorite ? 'Remove from favourites' : 'Add to favourites'}
                aria-label={track.isFavorite ? 'Remove from favourites' : 'Add to favourites'} aria-pressed={!!track.isFavorite}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill={track.isFavorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20.8 8.6a5 5 0 0 0-8.8-2.6A5 5 0 0 0 3.2 8.6c0 4.2 5.5 7.6 8.8 10.4 3.3-2.8 8.8-6.2 8.8-10.4z" />
                </svg>
              </button>
            ) : null}
            {onAddToPlaylist ? (
              <button type="button" className="sth-npbtn" onClick={(e) => onAddToPlaylist(e, track)}
                title="Add to playlist" aria-label="Add to playlist" aria-haspopup="menu">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="8.5" /><path d="M12 8.5v7M8.5 12h7" />
                </svg>
              </button>
            ) : null}
            {onMore ? (
              <button type="button" className="sth-npbtn" onClick={(e) => onMore(e, track)}
                title="More" aria-label="More actions" aria-haspopup="menu">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                  <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
                </svg>
              </button>
            ) : null}
            {onSetVolume ? (
              <>
                <span aria-hidden className="sth-npbtn-rule" />
                <button type="button" className="sth-npbtn" onClick={() => onSetVolume(muted ? (lastVol.current || 0.6) : 0)}
                  title={muted ? 'Unmute' : 'Mute'} aria-label={muted ? 'Unmute' : 'Mute'} aria-pressed={muted}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
                    {muted ? <path d="M16 9.5l5 5M21 9.5l-5 5" /> : <><path d="M15.5 9a4 4 0 0 1 0 6" />{volume > 0.5 ? <path d="M18.5 6.5a8 8 0 0 1 0 11" /> : null}</>}
                  </svg>
                </button>
                <input type="range" min={0} max={1} step={0.01} value={volume}
                  onChange={(e) => onSetVolume(Number(e.target.value))}
                  className="sth-vol" aria-label="Volume"
                  style={{ width: 96, background: `linear-gradient(to right, #fff 0%, #fff ${volume * 100}%, rgba(255,255,255,0.16) ${volume * 100}%, rgba(255,255,255,0.16) 100%)` }} />
              </>
            ) : null}
          </div>
        </section>

        {/* ---- Panel: lyrics / queue / info ---- */}
        {tab ? (
          <aside className="sth-full-panel" aria-label={tab === 'lyrics' ? 'Lyrics' : tab === 'queue' ? 'Queue' : 'Info'}>
            {tab === 'queue' ? (
              <QueueTab current={track} upNext={upNext} acc={acc} coverFor={coverFor}
                onSelectTrack={onSelectTrack} currentTime={currentTime} isPlaying={isPlaying}
                onReorder={onReorderQueue} queueOffset={queueOffset} />
            ) : tab === 'lyrics' ? (
              <LyricsTab lyricsData={lyricsData} onLyricsSaved={onLyricsSaved} track={track}
                onBrowseLyrics={onBrowseLyrics}
                selection={lyricSelection} onSelectStart={onLyricSelectStart} onSelectLine={onLyricSelectLine}
                currentTime={currentTime} accent={accent} onSeek={onSeek} />
            ) : (
              <InfoTab track={track} art={art} acc={acc} artistInfo={artistInfo} credits={credits} />
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function NowPlayingPanelDock({
  open, tab, onTab, onClose,
  track, art, accent, coverFor,
  surface = 'cover', barWash = null, customColor = null, immersePalette = null,
  upNext = [], onSelectTrack,
  lyricsData, onLyricsSaved, onBrowseLyrics,
  lyricSelection = null, onLyricSelectStart, onLyricSelectLine,
  currentTime = 0, isPlaying = false, onSeek, onExpand,
  onReorderQueue, queueOffset = 0,
  artistInfo, credits,
}) {
  if (!open) return null;
  const acc = readableAccent(accent);

  return (
    <aside style={{
      /* Inset to match .sth-scroll's BOX, not the window.
         This is mounted at StudioHome's root — a sibling of the top bar, not a
         child of the content column — so `top: 0` was the top of the app and
         the panel ran up behind the tabs. The wrapper it should line up with
         starts at TOPBAR_H + the column's 4px padding, and ends 104px from the
         bottom (the Now Playing bar's clearance). */
      position: 'absolute', top: 'var(--shell-top, 62px)', right: 'var(--gutter)', bottom: 'var(--np-reserve)', width: NP_PANEL_W,
      zIndex: 5, display: 'flex', flexDirection: 'column',
      borderRadius: 'var(--r-card)', overflow: 'hidden',
      /* `bar` paints the Now Playing bar's own colour, undimmed, so the two
         surfaces are the same. The cover treatment below is a blurred photo
         under a 52-62% black scrim, which is why it always landed darker than
         the bar however bright the artwork was. */
      background: surface === 'custom' && customColor
        ? `rgb(${customColor})`
        : (surface === 'bar' && barWash ? `rgb(${barWash})` : '#0a0a0b'),
      transition: 'background 0.5s ease',
      animation: 'sthPanelIn 0.26s cubic-bezier(0.22,1,0.3,1) both',
    }}>
      {/* Cover wash — the same treatment the popouts had, which is what stops
          this reading as a flat card bolted to the side. */}
      {surface === 'immerse' && art ? (
        <div aria-hidden style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}>
          <AnimatedGradientBg
            accent={immersePalette?.accent || acc}
            mid={immersePalette?.mid || acc}
            wash={immersePalette?.wash || acc}
            coverUrl={art} isPlaying vignette={false} brightness={1}
          />
        </div>
      ) : null}
      {/* Just enough to hold text, and only down the left where it sits. */}
      {surface === 'immerse' ? (
        <div aria-hidden style={{
          position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
          background: 'linear-gradient(180deg, rgba(0,0,0,0.34) 0%, rgba(0,0,0,0.14) 26%, rgba(0,0,0,0.30) 100%)',
        }} />
      ) : null}

      {art && surface === 'cover' ? (
        <div aria-hidden style={{
          position: 'absolute', inset: -60, zIndex: 0, pointerEvents: 'none',
          backgroundImage: `url("${art}")`, backgroundSize: 'cover', backgroundPosition: 'center',
          filter: 'blur(64px) saturate(1.7)', opacity: 0.5,
        }} />
      ) : null}
      {surface === 'cover' ? (
        <div aria-hidden style={{
          position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
          /* Was rgba(0,0,0,0.84) at the bottom, which drained the cover colour
             away to flat black over the lower two-thirds. Held at 0.62 with a
             faint accent underneath so the tint carries the full height. */
          background: `linear-gradient(165deg, rgba(${acc},0.16) 0%, rgba(0,0,0,0.52) 38%, rgba(0,0,0,0.62) 100%), linear-gradient(180deg, rgba(${acc},0.05), rgba(${acc},0.10))`,
        }} />
      ) : null}
      {/* On the bar surface the only overlay is a whisper of depth — anything
          heavier reintroduces the very gap this option exists to close. */}
      {(surface === 'bar' && barWash) || surface === 'custom' ? (
        <div aria-hidden style={{
          position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
          background: 'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(0,0,0,0.10) 100%)',
        }} />
      ) : null}

      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
        {/* Tabs. One panel with switchable content, rather than one panel per
            thing — the three are alternate views of the same track. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '11px 10px 9px' }}>
          {NP_PANEL_TABS.map(([id, label]) => {
            const on = tab === id;
            return (
              <button key={id} type="button" onClick={() => onTab(id)}
                style={{
                  padding: '6px 12px', borderRadius: 999, border: 'none', cursor: 'pointer',
                  background: on ? 'rgba(var(--st-fg-rgb), 0.11)' : 'transparent',
                  color: on ? '#fff' : 'rgba(var(--st-fg-rgb), 0.5)',
                  fontSize: 12, fontWeight: on ? 700 : 600,
                  transition: 'background 0.15s ease, color 0.15s ease',
                }}>
                {label}
              </button>
            );
          })}
          <div style={{ flex: 1 }} />
          {onExpand ? (
            <button type="button" onClick={onExpand} title="Open fullscreen" aria-label="Open fullscreen"
              style={{ width: 26, height: 26, borderRadius: 8, border: 'none', background: 'rgba(var(--st-fg-rgb), 0.07)', color: 'rgba(var(--st-sub-rgb), 0.6)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17L17 7M9 7h8v8" /></svg>
            </button>
          ) : null}
          <button type="button" onClick={onClose} title="Close panel" aria-label="Close panel"
            style={{ width: 26, height: 26, borderRadius: 8, border: 'none', background: 'rgba(var(--st-fg-rgb), 0.07)', color: 'rgba(var(--st-sub-rgb), 0.6)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        {tab === 'queue' ? (
          <QueueTab current={track} upNext={upNext} acc={acc} coverFor={coverFor}
            onSelectTrack={onSelectTrack} currentTime={currentTime} isPlaying={isPlaying}
            onReorder={onReorderQueue} queueOffset={queueOffset} />
        ) : tab === 'lyrics' ? (
          <LyricsTab lyricsData={lyricsData} onLyricsSaved={onLyricsSaved} track={track}
            onBrowseLyrics={onBrowseLyrics}
            selection={lyricSelection} onSelectStart={onLyricSelectStart} onSelectLine={onLyricSelectLine}
            currentTime={currentTime} accent={accent} onSeek={onSeek} />
        ) : (
          <InfoTab track={track} art={art} acc={acc} artistInfo={artistInfo} credits={credits} />
        )}
      </div>
    </aside>
  );
}

/**
 * The queue.
 *
 * It was two flat lists of title-and-artist and nothing else: no position, no
 * durations, no sense of how much music is actually lined up, and no way to
 * tell where you are in the current track without looking at the bar. All of
 * that is already in hand — it just wasn't being shown.
 */
/**
 * One queue row.
 *
 * Module-level on purpose. It used to be declared inside QueueTab, which means
 * a NEW component type on every render — and QueueTab re-renders on every tick
 * of currentTime. React sees a different type and remounts the whole list each
 * second, throwing away each row's hover state, so hovering appeared not to
 * work at all. Declared out here the type is stable and the rows just update.
 */
function QueueRow({
  t, index, playing = false, onClick, acc, coverFor, progress = 0, isPlaying = false,
  onReorder, queueOffset = 0, dragFrom, dragOver, setDragFrom, setDragOver, dur,
}) {
  const [hot, setHot] = useState(false);
    return (
      /* A div, not a button, for two reasons.
         Chromium will not reliably begin an HTML5 drag from a <button> — the
         element's own mousedown handling swallows it, which is why dragging
         did nothing. And a <button> does NOT inherit font-family from its
         ancestors; it falls back to the UA default, which is why the queue was
         set in a different typeface from the rest of the app while every other
         row here sets `font: inherit` explicitly. */
      <div role="button" tabIndex={0} onClick={onClick}
        onKeyDown={(e) => { if (onClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); } }}
        onMouseEnter={() => setHot(true)} onMouseLeave={() => setHot(false)}
        draggable={!!onReorder && !playing}
        onDragStart={(e) => {
          if (!onReorder || playing) return;
          setDragFrom(index - 1);
          e.dataTransfer.effectAllowed = 'move';
          // Firefox refuses to start a drag without payload.
          try { e.dataTransfer.setData('text/plain', String(index - 1)); } catch { /* ignore */ }
        }}
        onDragOver={(e) => {
          if (dragFrom === null || playing) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (dragOver !== index - 1) setDragOver(index - 1);
        }}
        onDrop={(e) => {
          if (dragFrom === null || playing) return;
          e.preventDefault();
          if (dragFrom !== index - 1) onReorder(queueOffset + dragFrom, queueOffset + (index - 1));
          setDragFrom(null); setDragOver(null);
        }}
        onDragEnd={() => { setDragFrom(null); setDragOver(null); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left',
          padding: '7px 9px', borderRadius: 9, border: 'none', font: 'inherit',
          userSelect: 'none',
          cursor: onReorder && !playing ? 'grab' : (onClick ? 'pointer' : 'default'),
          background: playing ? `rgba(${acc},0.16)` : (hot ? 'rgba(var(--st-fg-rgb), 0.07)' : 'transparent'),
          /* The gap opens where the row would land, so the drop is a preview
             rather than a guess. */
          boxShadow: dragOver === index - 1 && dragFrom !== null && dragFrom !== index - 1
            ? `inset 0 2px 0 rgb(${acc})` : 'none',
          opacity: dragFrom === index - 1 ? 0.4 : 1,
          transition: 'background 0.14s ease, opacity 0.14s ease',
        }}>
        {/* Position, replaced on hover by the thing clicking will do. */}
        <span style={{
          width: 16, flexShrink: 0, textAlign: 'right', fontSize: 11, fontWeight: 700,
          fontVariantNumeric: 'tabular-nums',
          color: playing ? `rgb(${acc})` : `rgba(var(--st-sub-rgb), ${hot ? 0.85 : 0.32})`,
        }}>
          {playing
            ? <PlayingBars acc={acc} playing={isPlaying} />
            /* Was the text character U+25B6 — a glyph from the system font,
               with hard corners and no relation to the play button drawn
               everywhere else. */
            : (hot ? <PlayIcon size={11} nudge={false} /> : index)}
        </span>

        <span style={{
          position: 'relative', width: 38, height: 38, borderRadius: 6, flexShrink: 0,
          background: coverFor?.(t) ? `url("${coverFor(t)}") center/cover` : 'rgba(var(--st-fg-rgb), 0.1)',
          boxShadow: 'inset 0 0 0 1px rgba(var(--st-fg-rgb), 0.1)',
        }}>
          {/* The current track carries its own progress, so the queue answers
              "how far in are we" without a trip back to the bar. */}
          {playing && progress > 0 ? (
            <span style={{
              position: 'absolute', left: 3, right: 3, bottom: 3, height: 2.5, borderRadius: 2,
              background: 'rgba(0,0,0,0.5)', overflow: 'hidden',
            }}>
              <span style={{
                display: 'block', height: '100%', width: `${progress * 100}%`,
                background: `rgb(${acc})`, transition: 'width 0.4s linear',
              }} />
            </span>
          ) : null}
        </span>

        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{
            display: 'block', fontSize: 12.5, fontWeight: 650,
            color: playing ? `rgb(${acc})` : 'var(--st-text)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{t.title}</span>
          <span style={{
            display: 'block', fontSize: 10.5, color: 'rgba(var(--st-sub-rgb), 0.5)', marginTop: 1,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{t.artist}</span>
        </span>

        <span style={{
          flexShrink: 0, fontSize: 10.5, fontWeight: 650, fontVariantNumeric: 'tabular-nums',
          color: 'rgba(var(--st-sub-rgb), 0.38)',
        }}>{dur(t.duration)}</span>

        {onReorder && !playing ? (
          <span aria-hidden style={{
            flexShrink: 0, width: 10, marginLeft: -3, color: 'rgba(var(--st-sub-rgb), 0.42)',
            opacity: hot ? 1 : 0, transition: 'opacity 0.14s ease',
          }}>
            <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor">
              <circle cx="3" cy="2" r="1" /><circle cx="7" cy="2" r="1" />
              <circle cx="3" cy="6" r="1" /><circle cx="7" cy="6" r="1" />
              <circle cx="3" cy="10" r="1" /><circle cx="7" cy="10" r="1" />
            </svg>
          </span>
        ) : null}
      </div>
    );
}

function QueueTab({
  current, upNext, acc, coverFor, onSelectTrack, currentTime = 0, isPlaying = false,
  onReorder, queueOffset = 0,
}) {
  /* Which row is being dragged, and where it would land. Local so the list
     reflows under the cursor without committing anything until you let go —
     a drop that lands where the preview showed it. */
  const [dragFrom, setDragFrom] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  /* How long the queue runs, so "12 tracks" becomes something you can plan
     around. Tracks missing a duration are skipped rather than counted as zero,
     and the total says "at least" when any were. */
  const { total, partial } = useMemo(() => {
    let secs = 0; let missing = false;
    for (const t of upNext) {
      if (Number.isFinite(t?.duration) && t.duration > 0) secs += t.duration;
      else missing = true;
    }
    return { total: secs, partial: missing };
  }, [upNext]);

  const runtime = (() => {
    if (!total) return null;
    const h = Math.floor(total / 3600);
    const m = Math.round((total % 3600) / 60);
    const text = h >= 1 ? `${h} hr ${m} min` : `${Math.max(1, m)} min`;
    return partial ? `${text}+` : text;
  })();

  const dur = (secs) => {
    if (!Number.isFinite(secs) || secs <= 0) return '';
    const m = Math.floor(secs / 60);
    const ss = Math.floor(secs % 60);
    return `${m}:${String(ss).padStart(2, '0')}`;
  };

  const progress = current && Number.isFinite(current.duration) && current.duration > 0
    ? Math.min(1, Math.max(0, currentTime / current.duration))
    : 0;

  const rowProps = {
    acc, coverFor, isPlaying, dur, onReorder, queueOffset,
    dragFrom, dragOver, setDragFrom, setDragOver,
  };

  return (
    <div className="sth-libscroll" style={{ overflowY: 'auto', padding: '0 8px 14px', minHeight: 0, flex: 1 }}>
      {current ? (
        <>
          <PanelLabel>Now playing</PanelLabel>
          <QueueRow {...rowProps} t={current} playing index={0} progress={progress} />
        </>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '0 9px' }}>
        <PanelLabel>{`Next up${upNext.length ? ` \u00b7 ${upNext.length}` : ''}`}</PanelLabel>
        {runtime ? (
          <span style={{ fontSize: 10.5, fontWeight: 650, color: 'rgba(var(--st-sub-rgb), 0.3)', marginLeft: 'auto' }}>
            {runtime}
          </span>
        ) : null}
      </div>

      {upNext.length ? upNext.map((t, i) => (
        <QueueRow {...rowProps} key={`${t.id}-${i}`} t={t} index={i + 1} onClick={() => onSelectTrack?.(t)} />
      )) : (
        <div style={{ fontSize: 11.5, color: 'rgba(var(--st-sub-rgb), 0.4)', padding: '6px 9px', lineHeight: 1.5 }}>
          Nothing queued after this track.
        </div>
      )}
    </div>
  );
}

/** Shared geometry for the lyric tab's floating tools. */
const toolBtn = {
  width: 26, height: 26, borderRadius: 8, border: 0, cursor: 'pointer',
  background: 'transparent', color: 'rgba(var(--st-text-rgb), 0.66)',
  display: 'grid', placeItems: 'center',
};

function LyricsTab({
  lyricsData, onLyricsSaved, track, currentTime, accent, onSeek,
  onBrowseLyrics, selection = null, onSelectStart, onSelectLine,
}) {
  const synced = lyricsData?.synced?.length ? lyricsData.synced : null;
  const plain = lyricsData?.plain || null;
  const hasLyrics = !!(synced || plain);
  const acc = readableAccent(accent);

  /* Editing lives HERE, not only in the expanded view.
   *
   * NpLyricsView (the fullscreen stage) has had an edit pencil for a while;
   * this tab is a different component and never got one, so from the dock —
   * which is where most people actually read lyrics — there was no way to fix
   * a bad line or time an untimed sheet. Same editor, same save contract, just
   * reachable from the surface you're already looking at. */
  const [editing, setEditing] = useState(false);
  // A new track means a new set of words; staying in the editor would apply
  // the previous song's edits to it.
  useEffect(() => { setEditing(false); }, [track ? track.id : null]);

  if (editing) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <PanelLyricsEditor
          track={track}
          currentTime={currentTime}
          existingSynced={synced}
          existingPlain={plain}
          accent={acc}
          onSeek={onSeek}
          onSave={(newSynced, newPlain) => { onLyricsSaved?.(newSynced, newPlain, track?.id); setEditing(false); }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  /* Instrumental is a fact about the track, not a gap to fill — offering
     "Add lyrics" there invites work that shouldn't be done. */
  if (!hasLyrics) {
    return (
      <div style={{
        flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 12, padding: '20px 22px', textAlign: 'center',
      }}
      >
        <div style={{ fontSize: 12.5, color: 'rgba(var(--st-sub-rgb), 0.5)', lineHeight: 1.55, fontWeight: 600 }}>
          {lyricsData?.instrumental ? 'This track is instrumental.' : 'No lyrics for this track yet.'}
        </div>
        {track && !lyricsData?.instrumental ? (
          <button type="button" onClick={() => setEditing(true)}
            style={{
              padding: '8px 15px', borderRadius: 99, border: 0, cursor: 'pointer',
              background: `rgb(${acc})`, color: accentTextColor(acc), fontSize: 12.5, fontWeight: 800,
            }}
          >
            Add lyrics
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', padding: '0 4px 12px', position: 'relative' }}>
      {synced ? (
        /* Selection props make the lines shareable — click one, drag to
           extend. The confirm bar and the card overlay are rendered once at
           the StudioHome level and are position:fixed, so they serve the dock
           and the fullscreen stage without either owning them. */
        <SyncedLyrics lines={synced} currentTime={currentTime} accent={accent} onSeek={onSeek} fontSize={16} lineHeight={1.5}
          selection={selection} onSelectStart={onSelectStart} onSelectLine={onSelectLine} />
      ) : (
        <div className="sth-libscroll" style={{ flex: 1, overflowY: 'auto', padding: '4px 12px' }}>
          {/* Untimed lyrics don't scroll with the song, which looks broken
              rather than incomplete. Say so, and make the fix one click. */}
          <button type="button" onClick={() => setEditing(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
              margin: '0 0 10px', padding: '8px 10px', borderRadius: 10, cursor: 'pointer',
              background: `rgba(${acc}, 0.13)`, border: `1px solid rgba(${acc}, 0.26)`,
            }}
          >
            <span style={{ flex: 1, fontSize: 11.5, fontWeight: 700, color: 'rgba(var(--st-text-rgb), 0.92)' }}>
              These lyrics aren’t timed
              <span style={{ display: 'block', fontSize: 10.5, fontWeight: 600, color: 'rgba(var(--st-sub-rgb), 0.55)', marginTop: 1 }}>
                They won’t follow the song
              </span>
            </span>
            <span style={{ fontSize: 10.5, fontWeight: 800, color: `rgb(${acc})`, flexShrink: 0 }}>Add timing</span>
          </button>
          <PlainLyrics text={plain} accent={accent} fontSize={15} lineHeight={1.7} />
        </div>
      )}

      {/* Floating toolbar, bottom-right, out of the reading column. Same pair
          and same icons as the fullscreen stage's LyricTools, so the two
          surfaces don't disagree about what these buttons look like. */}
      {track ? (
        <div style={{
          position: 'absolute', right: 12, bottom: 8, display: 'flex', gap: 5,
          padding: 3, borderRadius: 11,
          background: 'rgba(0,0,0,0.42)', backdropFilter: 'blur(14px)',
          border: '1px solid rgba(var(--st-fg-rgb), 0.10)',
        }}
        >
          <button type="button" onClick={() => setEditing(true)} style={toolBtn}
            title="Edit lyrics · tap to sync" aria-label="Edit lyrics">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
            </svg>
          </button>
          {onBrowseLyrics ? (
            <button type="button" onClick={onBrowseLyrics} style={toolBtn}
              title="Pick a different version" aria-label="Browse lyrics versions">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Discoverability, not decoration: line selection has no affordance of
          its own, so the one hint says how to start it. Hidden once a
          selection exists — the confirm bar takes over from there. */}
      {synced && onSelectStart && !selection ? (
        <div style={{
          position: 'absolute', left: 14, bottom: 15, fontSize: 10, fontWeight: 700,
          color: 'rgba(var(--st-sub-rgb), 0.34)', pointerEvents: 'none',
        }}
        >
          Click a line to share it
        </div>
      ) : null}
    </div>
  );
}

/**
 * InfoTab — everything known about the current track and its artist.
 *
 * Deliberately shows only what studio can actually source. Spotify's Web API
 * does NOT expose monthly listeners or the artist bio — those come from an
 * internal service their own clients use — so followers is shown instead, and
 * labelled as followers rather than dressed up as listeners.
 */
function InfoTab({ track, art, acc, artistInfo, credits }) {
  const fmtNum = (n) => (Number.isFinite(n) ? n.toLocaleString() : null);

  /* Details as compact pairs. Album is omitted deliberately — it's already the
     first thing under the artist card, and repeating it here was half the
     reason the old list felt padded. */
  const details = [
    ['Album', track?.album],
    ['Year', track?.year],
    /* Rendered by the pair list below, which now takes an array for genres so
       each one gets its own pill instead of the delimiter showing through. */
    ['Genre', parseGenres(track?.genre)],
    ['Track', Number.isFinite(track?.trackNumber) ? `${track.trackNumber}${track.trackTotal ? `/${track.trackTotal}` : ''}` : null],
    ['Format', track?.filePath ? getFileFormatLabel(track.filePath) : null],
    ['Length', track?.duration ? formatTime(track.duration) : null],
  ].filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0));

  return (
    <div className="sth-libscroll" style={{ overflowY: 'auto', minHeight: 0, flex: 1, padding: '0 12px 16px' }}>

      {/* Artist card first — it's the one block with real presence, and it's
          where this panel will grow (bio, top tracks, related). Everything
          below is reference material you scan rather than look at. */}
      {artistInfo ? (
        <div style={{ borderRadius: 12, overflow: 'hidden', background: 'rgba(var(--st-fg-rgb), 0.045)' }}>
          {artistInfo.image ? (
            <div style={{ height: 128, backgroundImage: `url("${artistInfo.image}")`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
          ) : null}
          <div style={{ padding: '11px 13px 13px' }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--st-text)' }}>{artistInfo.name}</div>
            {Number.isFinite(artistInfo.followers) ? (
              <div style={{ fontSize: 11.5, color: 'rgba(var(--st-sub-rgb), 0.55)', marginTop: 3 }}>
                {fmtNum(artistInfo.followers)} followers on Spotify
              </div>
            ) : null}
            {artistInfo.genres?.length ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 9 }}>
                {artistInfo.genres.slice(0, 4).map((g) => (
                  <span key={g} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 999, background: 'rgba(var(--st-fg-rgb), 0.08)', color: 'rgba(var(--st-text-rgb), 0.68)' }}>{g}</span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div style={{ borderRadius: 12, background: 'rgba(var(--st-fg-rgb), 0.045)', padding: '13px', fontSize: 11.5, color: 'rgba(var(--st-sub-rgb), 0.42)', lineHeight: 1.55 }}>
          Connect Spotify in Settings to show artist details here.
        </div>
      )}

      {/* Artwork at 34px, inline with the title rather than above it. Big
          enough to identify the record, small enough that it reads as part of
          the label row instead of a second hero — the full-bleed version cost
          a third of the panel and duplicated the Now Playing bar 40px below.
          No artist line for the same reason: the bar always shows it. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginTop: 18 }}>
        <div style={{
          width: 34, height: 34, borderRadius: 6, flexShrink: 0,
          background: art ? `url("${art}") center/cover` : 'rgba(var(--st-fg-rgb), 0.08)',
          boxShadow: '0 0 0 1px rgba(var(--st-fg-rgb), 0.08)',
        }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(var(--st-sub-rgb), 0.36)' }}>Song</div>
          <div style={{ fontSize: 13.5, fontWeight: 650, color: 'var(--st-text)', marginTop: 2, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={track?.title}>{track?.title}</div>
        </div>
      </div>

      {/* Details and credits share ONE block. They're the same kind of thing —
          flat facts about the track — and splitting them into two labelled
          sections put a heading and a gap between "Year 2021" and "Written by",
          which is most of why this panel felt long.
          Short values sit two-per-row; credits run full width because names
          are long and wrap. */}
      {(details.length || credits?.length) ? (
        <div style={{ marginTop: 13 }}>
          {details.length ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '11px 12px' }}>
              {details.map(([k, v]) => (
                <div key={k} style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'rgba(var(--st-sub-rgb), 0.36)' }}>
                    {/* "Genre" pluralises itself rather than being two labels. */}
                    {k === 'Genre' && Array.isArray(v) && v.length > 1 ? 'Genres' : k}
                  </div>
                  {/* A list value wraps to as many lines as it needs — these
                      sit in a 1fr column, and a nowrap ellipsis would hide the
                      second and third genre entirely. */}
                  {Array.isArray(v) ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                      {v.map((item) => (
                        <span key={item} style={{
                          maxWidth: '100%', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                          background: 'rgba(var(--st-fg-rgb), 0.08)', color: 'rgba(var(--st-text-rgb), 0.82)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }} title={item}>{item}</span>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: 'rgba(var(--st-text-rgb), 0.88)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={String(v)}>{v}</div>
                  )}
                </div>
              ))}
            </div>
          ) : null}

          {credits?.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 11, marginTop: details.length ? 13 : 0 }}>
              {credits.map((c, i) => (
                <div key={`${c.role}-${i}`}>
                  <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'rgba(var(--st-sub-rgb), 0.36)' }}>{c.role}</div>
                  <div style={{ fontSize: 12, color: 'rgba(var(--st-text-rgb), 0.88)', marginTop: 3, lineHeight: 1.45 }}>{c.name}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}


/** Flat icon action for the album/playlist header row. */
/**
 * Turn a sampled cover colour into a page wash.
 *
 * sampleCoverTheme's `accent` is a flat average of the artwork, and it force-
 * substitutes pure white when the average is dark (so accent-coloured TEXT
 * stays legible). Both behaviours are wrong for a full-page field: an average
 * is desaturated by definition, and white produces the pale grey wash that
 * made every monochrome cover look identical.
 *
 * So: work in HSL, push saturation up, and pin lightness into a narrow dark
 * band. A cover with any hue at all becomes a deep, saturated field; a
 * genuinely achromatic cover stays near-black rather than mid-grey, which is
 * what it should have been in the first place.
 */
/* pageWash() moved to coverTheme.js, beside the sampler that feeds it. */

/**
 * Render a modal at document.body.
 *
 * These sheets are position:fixed, which normally escapes every ancestor — but
 * NOT one that establishes a containing block, which `transform`, `filter` and
 * a running `animation` all do. `.sth-scroll` animates on mount and its
 * `is-page` variant is overflow:hidden, so a sheet rendered inside the library
 * was clipped to the panel rather than covering the window. It opened; you
 * just couldn't see it. Portalling removes the whole class of problem instead
 * of chasing which ancestor caused it.
 */
function Modal({ children }) {
  if (typeof document === 'undefined') return null;   // SSR / tests
  return createPortal(children, document.body);
}

/**
 * MenuItem — a row in the track context menu.
 *
 * MODULE SCOPE, deliberately. It used to be declared inside StudioHome's
 * render, which makes a NEW component type on every render — React can't match
 * it to the previous one, so it unmounts and remounts the whole subtree. With
 * playback running, `currentTime` re-renders StudioHome several times a second,
 * so the menu was being rebuilt continuously: inline hover styles were wiped
 * on each pass and the pointer never appeared to be over anything.
 *
 * Hover is CSS now rather than onMouseEnter/onMouseLeave writing to
 * element.style, so it survives a re-render regardless.
 */
const MenuItem = React.memo(function MenuItem({ icon, label, sub, danger, onClick, trailing, accentRgb }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`sth-mi${danger ? ' is-danger' : ''}`}
      style={{ '--mi-accent': accentRgb }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.85 }}>
        {icon}
      </svg>
      <span style={{ flex: 1, minWidth: 0 }}>
        {label}
        {sub ? <span className="sth-mi-sub">{sub}</span> : null}
      </span>
      {trailing}
    </button>
  );
});

/**
 * LibRow — one row of the library table.
 *
 * React.memo at module scope. The table renders every track in the library
 * (hundreds of rows), and StudioHome re-renders several times a second while
 * something is playing because `currentTime` is a prop. Without memoisation
 * that rebuilt every row's JSX on every tick, which is the scrolling and
 * tab-switching lag.
 *
 * Handlers are passed pre-bound from a useCallback in the parent so the props
 * are referentially stable — otherwise memo compares new function identities
 * each render and never skips anything.
 */
/**
 * PlayingBars — the equaliser that replaces the index on the playing row.
 *
 * Three short bars with a soft glow, matching the fullscreen overlay's badge.
 * The previous version was four full-height bars, which at row scale looked
 * like a chart rather than an indicator.
 *
 * Deliberately NOT audio-driven: a real analyser would mean an animation frame
 * per row, inside a virtualised table where rows mount and unmount as you
 * scroll. Staggered delays are enough to read as "this one is playing".
 */
/**
 * Human-readable total for a whole list.
 *
 * formatDurationMs is mm:ss — right for one track, wrong for a collection:
 * 573 songs came out as "1839:51", which nobody can read as thirty hours. This
 * switches unit with magnitude, the way you'd say it out loud.
 */
/* formatTotalMs() moved to mediaUtils.js — the artist page states a
   catalogue's runtime the same way an album states its own. */

const PlayingBars = React.memo(function PlayingBars({ acc, playing = true }) {
  return (
    <span className={`sth-eq${playing ? '' : ' is-paused'}`} aria-label="Now playing" title="Now playing"
      style={{ color: `rgb(${acc})` }}>
      <i /><i /><i />
    </span>
  );
});

/* ---------------------------------------------------------------------------
 *  Colour picking, in Studio's own language.
 *
 *  `<input type="color">` opens the browser's dialog, which is drawn by the OS
 *  outside the page — no stylesheet can reach it, so it arrives as a grey
 *  system box in the middle of a dark app. This is the same job done in the
 *  document: a saturation/value field, a hue rail, a hex box and the presets
 *  Studio actually uses.
 * ------------------------------------------------------------------------- */

const PICKER_PRESETS = [
  '#000000', '#0e0e12', '#20242f', '#3b3f52',
  '#7a6ae0', '#a84ab4', '#e2506a', '#e0803c',
  '#d8c04a', '#4ca86a', '#3f9fd0', '#ffffff',
];

function hexToHsv(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const n = m ? parseInt(m[1], 16) : 0;
  const r = ((n >> 16) & 255) / 255; const g = ((n >> 8) & 255) / 255; const b = (n & 255) / 255;
  const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: mx ? d / mx : 0, v: mx };
}

function hsvToHex({ h, s, v }) {
  const c = v * s; const x = c * (1 - Math.abs(((h / 60) % 2) - 1)); const m = v - c;
  let rgb;
  if (h < 60) rgb = [c, x, 0]; else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x]; else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c]; else rgb = [c, 0, x];
  return `#${rgb.map((u) => Math.round((u + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A swatch that opens Studio's own colour picker.
 *
 * @param value  current colour as #rrggbb
 * @param onChange called with #rrggbb as the user drags — live, so the app
 *        recolours under the picker and you judge the colour in place rather
 *        than against a dialog's white background.
 */
function StudioColorPicker({ value, onChange, onReset, title, size = 24 }) {
  const [open, setOpen] = useState(false);
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const [hexText, setHexText] = useState(value);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  // Follow the value while closed; while open the drag state is the truth.
  useEffect(() => { if (!open) { setHsv(hexToHsv(value)); setHexText(value); } }, [value, open]);

  useEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const W = 232; const H = 286;
      // Flip above / pull inside the viewport rather than opening off-screen.
      const left = Math.min(Math.max(8, r.left + r.width / 2 - W / 2), window.innerWidth - W - 8);
      const below = r.bottom + 8;
      const top = below + H > window.innerHeight - 8 ? Math.max(8, r.top - H - 8) : below;
      setPos({ top, left });
    };
    place();
    const onDown = (e) => {
      if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  const push = (next) => { setHsv(next); const hex = hsvToHex(next); setHexText(hex); onChange(hex); };

  /* One drag handler for both the field and the rail: press, move, release,
     with the pointer captured on the window so a fast drag off the edge keeps
     tracking instead of dropping the colour where the cursor left. */
  const drag = (e, compute) => {
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    const apply = (ev) => push(compute(ev, box));
    apply(e);
    const move = (ev) => apply(ev);
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const clamp01 = (n) => Math.min(1, Math.max(0, n));
  const hex = /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : '#000000';

  return (
    <>
      <button ref={btnRef} type="button" title={title} aria-label={title} onClick={() => setOpen((o) => !o)}
        style={{
          width: size, height: size, borderRadius: 7, padding: 0, cursor: 'pointer', display: 'block',
          border: 'none', background: hex,
          boxShadow: `inset 0 0 0 1px rgba(var(--st-fg-rgb), ${open ? 0.5 : 0.22})`,
        }} />

      {/* Portalled to <body>.
          `position: fixed` is only fixed relative to the nearest ancestor that
          has a transform, filter or running animation — and the settings
          scroller has one. That made a stacking context the popover couldn't
          escape, so it sat behind the docked Queue/Lyrics panel no matter how
          high its z-index went. Out here it has no ancestor to be trapped by. */}
      {open ? createPortal((
        <div ref={popRef} role="dialog" aria-label={title}
          style={{
            position: 'fixed', top: pos.top, left: pos.left, width: 232, zIndex: 200,
            borderRadius: 14, padding: 12,
            /* Black, like the rest of Studio's surfaces. The near-black grey it
               had was a hair lighter than the panels around it, which is the
               kind of difference that reads as a mistake rather than a choice. */
            background: '#000',
            boxShadow: 'inset 0 0 0 1px rgba(var(--st-fg-rgb), 0.14), 0 24px 60px rgba(0,0,0,0.7)',
            transformOrigin: 'top center',
            animation: 'sthPopIn 0.15s cubic-bezier(0.22,1,0.3,1) both',
          }}>
          {/* Saturation and value */}
          <div
            onMouseDown={(e) => drag(e, (ev, box) => ({
              ...hsv,
              s: clamp01((ev.clientX - box.left) / box.width),
              v: 1 - clamp01((ev.clientY - box.top) / box.height),
            }))}
            style={{
              position: 'relative', height: 122, borderRadius: 9, cursor: 'crosshair',
              background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hsvToHex({ h: hsv.h, s: 1, v: 1 })})`,
              boxShadow: 'inset 0 0 0 1px rgba(var(--st-fg-rgb), 0.1)',
            }}>
            <span style={{
              position: 'absolute', left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`,
              width: 13, height: 13, marginLeft: -6.5, marginTop: -6.5, borderRadius: '50%',
              border: '2px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,0.5), 0 2px 6px rgba(0,0,0,0.5)',
              pointerEvents: 'none',
            }} />
          </div>

          {/* Hue */}
          <div
            onMouseDown={(e) => drag(e, (ev, box) => ({ ...hsv, h: clamp01((ev.clientX - box.left) / box.width) * 360 }))}
            style={{
              position: 'relative', height: 12, borderRadius: 999, marginTop: 11, cursor: 'ew-resize',
              background: 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)',
              boxShadow: 'inset 0 0 0 1px rgba(var(--st-fg-rgb), 0.1)',
            }}>
            <span style={{
              position: 'absolute', left: `${(hsv.h / 360) * 100}%`, top: '50%',
              width: 16, height: 16, marginLeft: -8, marginTop: -8, borderRadius: '50%',
              background: hsvToHex({ h: hsv.h, s: 1, v: 1 }),
              border: '2px solid #fff', boxShadow: '0 1px 5px rgba(0,0,0,0.55)', pointerEvents: 'none',
            }} />
          </div>

          {/* Hex, typed */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 11 }}>
            <span style={{ width: 26, height: 26, borderRadius: 7, flexShrink: 0, background: hex,
              boxShadow: 'inset 0 0 0 1px rgba(var(--st-fg-rgb), 0.2)' }} />
            <input
              value={hexText}
              onChange={(e) => {
                const v = e.target.value;
                setHexText(v);
                const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
                if (m) { const h = `#${m[1]}`; setHsv(hexToHsv(h)); onChange(h); }
              }}
              onBlur={() => setHexText(hex)}
              spellCheck={false}
              style={{
                flex: 1, minWidth: 0, height: 26, borderRadius: 7, border: 'none', outline: 'none',
                background: 'rgba(0,0,0,0.35)', boxShadow: 'inset 0 0 0 1px rgba(var(--st-fg-rgb), 0.12)',
                color: 'var(--st-text)', font: 'inherit', fontSize: 12, fontWeight: 700,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', padding: '0 9px', textTransform: 'lowercase',
              }} />
            {onReset ? (
              <button type="button" onClick={() => { onReset(); setOpen(false); }} className="sth-set-link">Reset</button>
            ) : null}
          </div>

          {/* Studio's own palette, so the common choices are one click. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6, marginTop: 11 }}>
            {PICKER_PRESETS.map((c) => (
              <button key={c} type="button" title={c}
                onClick={() => { setHsv(hexToHsv(c)); setHexText(c); onChange(c); }}
                style={{
                  height: 22, borderRadius: 6, border: 'none', cursor: 'pointer', background: c,
                  boxShadow: `inset 0 0 0 1px rgba(var(--st-fg-rgb), ${c.toLowerCase() === hex.toLowerCase() ? 0.7 : 0.16})`,
                }} />
            ))}
          </div>
        </div>
      ), document.body) : null}
    </>
  );
}

/**
 * Pick the colour for the record that's playing.
 *
 * A card in the sidebar column, not a popover on the bar. The sidebar is
 * mostly empty below the playlists, the column is tall, and a vertical list
 * gives every reading its full name and hex without anything running off the
 * edge — which is what a wide row of tiles couldn't do at any width.
 */
/* Once per app session, not once per mount. The component remounts on every
   track change, so component state would re-announce on every song — which is
   nagging, not introducing. */
let hintAnnounced = false;

/**
 * Colour override for the playing record.
 *
 * TWO RULES ABOUT WHAT THIS OFFERS.
 *
 * Only colours from the artwork. It used to list the named readings too —
 * Auto, Fitted, Palette vibrant, Dark muted and the rest. Those are diagnostics
 * for comparing algorithms, not choices: "Palette muted" tells you nothing
 * about what you'd be looking at, and picking one saves a LITERAL colour, so a
 * reading chosen today freezes forever even after the algorithm improves. What
 * a person actually wants here is "use that red, the one in the sleeve".
 *
 * And the swatches are real pixels, not cluster means — see the exact field in
 * coverTheme's kmeans(). A mean can be a colour that appears nowhere in the
 * cover, which makes a picker that promises colours from the cover a liar.
 *
 * The handle is a chevron behind the left edge of the Now Playing bar, at a
 * lower z-index than the bar so it reads as tucked underneath. It's deliberately
 * quiet: Auto is right most of the time now, and this should look like a thing
 * you can reach for rather than a thing asking to be used.
 */
function CoverColourTab({
  open, setOpen, swatches = [], current, onPick, onReset, accent,
  coverSrc = null, exportName = 'cover', headless = false,
}) {
  /* Above the hooks on purpose: it is a const, so a hook body reading it from
     further up the component hits the temporal dead zone at render time. */
  const HINT = 'Hey! Don’t like this color?';
  const tick = useRef(null);

  const [hover, setHover] = useState(false);

  /* Announce once per app SESSION, not per mount: the component remounts on
     every track change, so component state would re-announce every song.
     The flag is spent when the hint actually appears, not when this effect
     runs — an unmount inside the delay (a null blip in currentTrack while
     metadata resolves, or StrictMode's dev double-mount) would otherwise burn
     the announce without ever drawing it, and the remount would bail forever. */
  const [announce, setAnnounce] = useState(false);
  useEffect(() => {
    if (headless || hintAnnounced) return undefined;
    const on = setTimeout(() => {
      if (hintAnnounced) return;
      hintAnnounced = true;
      setAnnounce(true);
    }, 900);
    /* Visible for 10s: in at 900ms, out at 10900ms. */
    const off = setTimeout(() => setAnnounce(false), 10900);
    return () => { clearTimeout(on); clearTimeout(off); };
  }, []);

  /* Typed out on the first-run announce only. On every hover it would be a
     delay you sit through after you already know what it says. */
  const [typed, setTyped] = useState(HINT.length);
  useEffect(() => {
    if (!announce) { setTyped(HINT.length); return undefined; }
    setTyped(0);
    let n = 0;
    /* Starts after the swing lands — typing mid-swing is two motions at once. */
    const begin = setTimeout(() => {
      const id = setInterval(() => {
        n += 1;
        setTyped(n);
        if (n >= HINT.length) clearInterval(id);
      }, 34);
      tick.current = id;
    }, 380);
    return () => { clearTimeout(begin); if (tick.current) clearInterval(tick.current); };
  }, [announce]);

  /* Open by default. The panel exists because Auto is a guess, and someone
     opening it for the first time is usually asking why it got this wrong —
     answering that up front beats hiding it behind a button they have to
     think to press. The toggle stays so it can be collapsed. */
  const [info, setInfo] = useState(true);

  /* Hover wins: reaching for it mid-announce should not fight the timer. */
  const hintOn = (hover || announce) && !open;

  /* The exit animation is keyed off hintOn going false — but it starts false,
     so without this the box would fly across the screen once on mount. Only
     arms after it has actually been shown.
     MUST sit below hintOn: the [hintOn] dependency array is evaluated during
     render, so declaring this above it is a temporal dead zone hit. */
  const [everShown, setEverShown] = useState(false);
  useEffect(() => { if (hintOn) setEverShown(true); }, [hintOn]);
  const [saveNote, setSaveNote] = useState('');
  useEffect(() => { setSaveNote(''); }, [coverSrc]);

  /* Vertically centred on the 84px bar, which sits at bottom:12. */
  const TAB_H = 54;
  /* Kept short enough to stay on one line inside the column. */
  const barLeft = 'var(--np-bar-left, 238px)';

  /* Even margins between the window edge and the content area.
     The sidebar is SIDEBAR_W wide and content starts 12px past it, so the
     usable span is 0..SIDEBAR_W+12 and the panel is centred inside it. Anchored
     at left:12 the gaps came out 12 and 24 — visibly off-centre. */
  const COL_W = SIDEBAR_W - 24;
  const COL_LEFT = (SIDEBAR_W + 12 - COL_W) / 2;
  /* Both the hint and the panel occupy this one slot: the panel unfolds out of
     exactly where the prompt was, so the prompt reads as the thing that opened. */
  const SLOT_BOTTOM = 34;
  /* The chevron's midline. Bar is 84 tall at bottom:12, tab is centred on it,
     so both resolve to the same number — the hint hangs off this rather than a
     bottom edge, which keeps it centred on the tab at any text height. */
  const CHEV_MID = 12 + 84 / 2;
  /* How far the hint's centre has to travel to land on the chevron's visible
     sliver. --np-bar-left is SIDEBAR_W + 12, and the tab pokes 15px out of it
     with its right half hidden behind the bar, so the visible centre is 7.5px
     left of the bar edge. Derived, not measured, so it survives a sidebar
     resize. */
  const SUCK_X = (SIDEBAR_W + 12 - 15 / 2) - (COL_LEFT + COL_W / 2);
  /* One surface for the tab and the hint. As two literals they drifted; as one
     constant they cannot. */
  const SURFACE = 'rgba(10, 10, 12, 0.97)';
  const SURFACE_RING = 'rgba(var(--st-fg-rgb), 0.14)';

  /* Drop chips too close to one already shown. Clustering regularly returns
     two cells a few RGB units apart — string equality won't catch those, and
     they render as what looks like the same colour twice, which makes the grid
     read as padded. 28 is roughly where two chips stop being distinguishable
     side by side. */
  const kept = [];
  const chips = swatches.filter((sw) => {
    const v = String(sw.exact || sw.rgb || '').split(',').map((n) => parseInt(n.trim(), 10));
    if (v.length < 3 || v.some((n) => !Number.isFinite(n))) return false;
    if (kept.some((k) => Math.hypot(k[0] - v[0], k[1] - v[1], k[2] - v[2]) < 28)) return false;
    kept.push(v);
    return true;
  });

  return (
    <>
      {/* Brief, Now Playing bar: the "Hey! Don't like this color?" toast is
          removed, and the handle with it. The tray now opens from the bar's
          overflow menu ("Colour for this record"), so `headless` is how it's
          mounted. The old handle stays available behind the prop. */}
      {!headless ? (<>
      {/* ---- The hint ----
          Hangs off the bottom edge of the sidebar, in the horizontal band the
          Now Playing bar occupies, so it reads as part of that row rather than
          floating in the library.

          Hinged at TOP CENTRE and swung down like a sign on a bracket — the
          1.52 in the easing overshoots and settles, which is what sells it as
          an object with weight instead of a tooltip fading in. Out is slow with
          the bounce; back is quick and eased, because a bounce on the way in
          looks like it can't decide. */}
      {/* Outer node does nothing but centring, inner does nothing but the swing.
          On one node the centring translate has to be restated inside every
          animated transform, and it drops the moment one state forgets — which
          is why the box hung off the left edge and shifted with phrase length.
          Split, they cannot interfere: centred once, centred at any width. */}
      <div aria-hidden style={{
        position: 'fixed', left: COL_LEFT + COL_W / 2, bottom: CHEV_MID, zIndex: 28,
        /* Capped by geometry, not by the column: centred at the column's midpoint,
           the box can grow until its left edge nears the window edge, which is
           wider than COL_W and still clear of the content area at SIDEBAR_W+12.
           At COL_W the longer phrase clipped. */
        /* translateY(50%) against a bottom anchor puts the box's own centre on
           CHEV_MID whatever its height, so it stays aligned if the copy grows. */
        transform: 'translate(-50%, 50%)', width: 'fit-content',
        maxWidth: 2 * (COL_LEFT + COL_W / 2 - 8),
        pointerEvents: 'none',
      }}>
      <div style={{
        whiteSpace: 'nowrap', position: 'relative',
        padding: '9px 11px', borderRadius: 10,
        /* Centre, not the right edge. Pivoting at the right edge held that edge
           still and only walked the left one in — the box collapsed where it
           stood instead of going anywhere, which is why it read as a blink.
           From the centre it can both travel and shrink. */
        transformOrigin: 'center center',
        background: SURFACE,
        boxShadow: `inset 0 0 0 1px ${SURFACE_RING}, 0 10px 26px rgba(0,0,0,0.5)`,
        fontSize: 11.5, fontWeight: 650, lineHeight: 1.3,
        color: 'rgba(var(--st-text-rgb), 0.9)',
        opacity: hintOn ? 1 : 0,
        /* Resting hidden state is the keyframe's END state, deliberately. When
           the animation is dropped on re-show the element falls back to this,
           and if the two disagreed it would snap a frame before the entry ran.
           Matching them makes the handoff invisible — and it means the entry
           slides out of the tab, mirroring the exit. */
        '--suck-x': `${SUCK_X}px`,
        transform: hintOn
          ? 'translateX(0) scale(1)'
          : `translateX(${SUCK_X}px) scale(0.92)`,
        /* Entry is a transition; exit is the keyframe, because a transition
           cannot go left before it goes right. */
        transition: hintOn
          ? 'opacity 0.16s ease, transform 0.44s cubic-bezier(0.34, 1.52, 0.42, 1)'
          : 'none',
        animation: !hintOn && everShown ? 'sthHintSuck 0.52s forwards' : 'none',
      }}>
        {/* The full string holds the box width even when only part is shown.
            Without it a fit-content, centre-anchored box would grow and drift
            sideways on every character. */}
        <span style={{ position: 'relative', display: 'inline-block' }}>
          <span aria-hidden style={{ visibility: 'hidden' }}>{HINT}</span>
          <span style={{ position: 'absolute', left: 0, top: 0, whiteSpace: 'nowrap' }}>
            {HINT.slice(0, typed)}
          </span>
        </span>
      </div>
      </div>

      {/* ---- The handle ----
          z-index 29 against the bar's 30, so the bar paints over its right
          half and it reads as tucked behind rather than floating beside. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        /* No title attribute: the OS tooltip fired on top of the hint, saying
           the same thing twice in two different styles. aria-label still names
           the control for screen readers. */
        aria-label="Color for this record"
        aria-expanded={open}
        style={{
          position: 'fixed', left: `calc(${barLeft} - 15px)`, bottom: 12 + (84 - TAB_H) / 2,
          zIndex: 29, width: 30, height: TAB_H, padding: 0, border: 'none', cursor: 'pointer',
          borderRadius: '9px 0 0 9px', font: 'inherit',
          /* Same fill and ring as the hint, so the tab reads as the edge of the
             thing that swings out of it rather than as bar chrome. Only the
             glyph responds to state — moving the fill as well made it flash
             against the bar's colour wash. */
          background: SURFACE,
          boxShadow: `inset 0 0 0 1px ${SURFACE_RING}`,
          color: open || hover || announce ? 'rgba(var(--st-text-rgb), 0.9)' : 'rgba(var(--st-text-rgb), 0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'flex-start', paddingLeft: 3,
          transition: 'background 0.16s ease, color 0.16s ease, left 0.2s cubic-bezier(0.22,0.9,0.3,1)',
          /* Only while introducing itself, and it stops the moment you reach
             for it — something still asking for attention under the cursor is
             the fastest way to make a control feel broken. */
          animation: announce && !hover && !open ? 'sthChevNudge 2.6s ease-in-out infinite' : 'none',
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.26s cubic-bezier(0.22,0.9,0.3,1)' }}>
          <path d="M15 6l-6 6 6 6" />
        </svg>
      </button>

      </>) : null}

      {/* ---- The panel ----
          Opens out of the prompt's own slot — same left, same width, same
          bottom edge — so it grows from where you were just looking instead of
          appearing somewhere else. Never crosses into the content area. */}
      <div aria-hidden={!open} style={{
        position: 'fixed', left: COL_LEFT, width: COL_W,
        bottom: SLOT_BOTTOM, transformOrigin: 'bottom center', zIndex: 31,
        borderRadius: 14, background: 'rgba(8, 8, 10, 0.98)',
        /* Symmetric now that it floats mid-column; the old -12px cast the shadow
           upward, which only made sense when it sat on top of the bar. */
        boxShadow: 'inset 0 0 0 1px rgba(var(--st-fg-rgb), 0.12), 0 -10px 40px rgba(0,0,0,0.55)',
        /* Grid-rows 0fr -> 1fr rather than max-height. max-height needs a number
           picked in advance, and any number that clears the tallest case (info
           open, twelve swatches) is far taller than the usual one — so it
           either clips and needs an inner scroller, or overshoots and the close
           animation stalls while it unwinds empty space. This animates to
           whatever the content actually is, so there is nothing to scroll. */
        display: 'grid', gridTemplateRows: open ? '1fr' : '0fr', overflow: 'hidden',
        opacity: open ? 1 : 0,
        pointerEvents: open ? 'auto' : 'none',
        /* Deliberately NOT the hint's animation. The hint swings on a hinge with
           an overshoot because it is a small object being flicked into view; a
           panel doing that would wobble. This unfolds upward out of the prompt's
           slot — anchored bottom-centre, easing straight to rest with no bounce,
           scale barely under 1 so the edges settle rather than snap. */
        transform: open ? 'scale(1)' : 'scale(0.94)',
        transition: 'grid-template-rows 0.3s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.17s ease, transform 0.3s cubic-bezier(0.22, 1, 0.36, 1)',
      }}>
        {/* The single grid row. Children keep their old flex-column layout. */}
        <div style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: '11px 11px 8px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontSize: 10.5, fontWeight: 800, letterSpacing: '0.11em',
            textTransform: 'uppercase', color: 'rgba(var(--st-sub-rgb), 0.4)', flex: 1,
          }}>
            From this cover
          </span>
          <button type="button" onClick={() => setInfo((v) => !v)}
            aria-label="Why is this here?" aria-expanded={info}
            style={{
              width: 17, height: 17, flexShrink: 0, padding: 0, borderRadius: '50%',
              border: 'none', cursor: 'pointer', font: 'inherit',
              fontSize: 10, fontWeight: 800, lineHeight: '17px', textAlign: 'center',
              background: info ? 'rgba(var(--st-fg-rgb), 0.22)' : 'rgba(var(--st-fg-rgb), 0.09)',
              color: info ? 'var(--st-text)' : 'rgba(var(--st-text-rgb), 0.5)',
              transition: 'background 0.14s ease, color 0.14s ease',
            }}>?</button>
          {/* Only offered once something is overridden — with nothing to undo it
              is a button that does nothing, which reads as broken. */}
          {current ? (
            <button type="button" className="sth-set-link" onClick={onReset}>Auto</button>
          ) : null}
        </div>

        {/* Collapsed by default. Someone who opened this panel wants swatches,
            not an essay — but the honest answer to "why can I even change this"
            is that the automatic pick is a guess, and that is worth being able
            to find. Grid-rows rather than max-height so it animates to its real
            height whatever the copy length. */}
        <div aria-hidden={!info} style={{
          display: 'grid', flexShrink: 0,
          gridTemplateRows: info ? '1fr' : '0fr',
          opacity: info ? 1 : 0,
          transition: 'grid-template-rows 0.26s cubic-bezier(0.22,1,0.36,1), opacity 0.2s ease',
        }}>
          <div style={{ overflow: 'hidden' }}>
            <p style={{
              margin: '0 11px 10px', fontSize: 10.5, lineHeight: 1.5,
              color: 'rgba(var(--st-sub-rgb), 0.62)',
            }}>
              Studio reads the bar color off the artwork by itself. It&rsquo;s tuned
              against real covers and lands close most of the time &mdash; but there
              isn&rsquo;t one true color in an image, and on busy or washed-out
              sleeves it can pick something you wouldn&rsquo;t have. Everything below
              is an actual color from this cover, so you can overrule it. Auto puts
              it back.
            </p>
          </div>
        </div>

        <div style={{ padding: '0 11px 8px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 7 }}>
            {chips.map((sw) => {
              const rgb = sw.exact || sw.rgb;
              const on = current === rgb;
              const pct = sw.share < 0.01 ? '<1%' : `${Math.round(sw.share * 100)}%`;
              return (
                <button key={rgb} type="button" onClick={() => onPick(rgb)}
                  title={`rgb(${rgb}) — ${pct} of the cover`}
                  style={{
                    padding: 0, border: 'none', background: 'transparent',
                    cursor: 'pointer', font: 'inherit', display: 'block',
                  }}>
                  <span style={{
                    display: 'block', width: '100%', aspectRatio: '1 / 1', borderRadius: 8,
                    background: `rgb(${rgb})`,
                    boxShadow: `inset 0 0 0 ${on ? 2.5 : 1}px rgba(var(--st-fg-rgb), ${on ? 0.95 : 0.16})`,
                    transition: 'box-shadow 0.14s ease',
                  }} />
                  <span style={{
                    display: 'block', marginTop: 3, fontSize: 8.5, lineHeight: 1.2, textAlign: 'center',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    color: `rgba(var(--st-sub-rgb), ${on ? 0.66 : 0.32})`,
                  }}>{pct}</span>
                </button>
              );
            })}
          </div>

          {!chips.length ? (
            <div style={{ fontSize: 11, color: 'rgba(var(--st-sub-rgb), 0.4)', padding: '4px 0 8px' }}>
              No colors read from this cover yet.
            </div>
          ) : null}

          {/* Kept as the last resort, not the first option — a free colour
              picker has nothing to do with the artwork, so it sits under the
              swatches rather than above them. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 11, paddingTop: 9, boxShadow: 'inset 0 1px 0 rgba(var(--st-fg-rgb), 0.08)' }}>
            <StudioColorPicker title="Any color" size={20}
              value={rgbToHex(current || accent)}
              onChange={(hexv) => { const v = hexToRgb(hexv); if (v) onPick(v); }} />
            <span style={{ fontSize: 10.5, fontWeight: 650, color: 'rgba(var(--st-sub-rgb), 0.4)', flex: 1 }}>
              or any color
            </span>
          </div>

          {/* The exact bytes these colours were read from — a separately
              downloaded jpg of the same artwork is a different encoding at a
              different size and gives different colours from identical code. */}
          {coverSrc ? (
            <button type="button" className="sth-set-link"
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 0 4px', fontSize: 9.5 }}
              title="Write the exact image these colors were read from into your Downloads folder"
              onClick={async () => {
                setSaveNote('saving…');
                try {
                  const r = await window.electronAPI?.exportCover?.(coverSrc, exportName || 'cover');
                  setSaveNote(r?.ok ? `saved to Downloads (${Math.round((r.bytes || 0) / 1024)} KB)` : (r?.error || 'could not save'));
                } catch (e) {
                  setSaveNote(String(e?.message || e));
                }
              }}>
              {saveNote || 'save this cover to Downloads'}
            </button>
          ) : null}
        </div>
        </div>
      </div>
    </>
  );
}

/**
 * The first credited artist on a track.
 *
 * Module-level: it reads no state and closes over nothing, so as a useCallback
 * inside the component it only served to make everything declared above it
 * unable to use it. Function declarations hoist, so call order stops mattering.
 */
function primaryArtistOf(t) {
  const raw = String(t?.artist || '').trim();
  if (!raw) return '';
  return raw.split(/\s*(?:,|&|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bx\b)\s*/i)[0].trim() || raw;
}

/** The (album, primary artist) pair that identifies a record. */
function albumKeyOf(t) {
  return `${(t.album || '').toLowerCase()}::${primaryArtistOf(t).toLowerCase()}`;
}

/** One settings row: a label, an explanation, and its control on the right. */
/**
 * SettingsPreview — a miniature of the app that reflects the current values.
 *
 * Deliberately a DIAGRAM, not a screenshot. It shows the three things the
 * appearance settings actually change — how much cover colour bleeds into a
 * page, where the active-tab marker sits, and whether the table has a date
 * column — as blocks and bars rather than real content. Real content would
 * invite reading it, and it isn't accurate enough to be read; abstracted, it
 * answers the only question being asked, which is "what will this look like".
 *
 * Cheap on purpose: no portal, no canvas, no live app instance. A handful of
 * divs re-rendering on a value change costs nothing, so the preview can be
 * open the whole time without being something you notice.
 */
function SettingsPreview({
  accent, animatedBg, pageSurface = 'cover', intensity = 'balanced', navStyle = 'chip', showDate = true,
}) {
  const acc = readableAccent(accent);
  /* Values mirror the real option sets exactly — pageSurface is
     off | colour | cover | coverFull, intensity is muted | balanced | vivid |
     full. A preview that invents its own scale stops being a preview. */
  const tint = pageSurface === 'off' ? 0
    : pageSurface === 'coverFull' ? 0.30
      : pageSurface === 'colour' ? 0.16 : 0.13;
  const wash = pageSurface === 'off' ? 0.05 : pageSurface === 'coverFull' ? 0.72 : 0.5;
  const k = { muted: 0.45, balanced: 0.72, vivid: 0.9, full: 1 }[intensity] ?? 0.72;
  // Immerse fills the bar and panel, not the page — shown as a lit strip
  // along the bottom rather than by tinting the list.
  const barLit = !!animatedBg;

  const marker = (on) => {
    if (!on) return {};
    if (navStyle === 'bar') return { boxShadow: `inset 3px 0 0 rgb(${acc})`, background: 'rgba(var(--st-fg-rgb), 0.06)' };
    if (navStyle === 'underline') return { borderBottom: `2px solid rgb(${acc})`, background: 'transparent' };
    if (navStyle === 'dot') return { background: 'transparent', boxShadow: `inset 5px 0 0 -1.5px rgb(${acc})` };
    if (navStyle === 'glow') return { background: `rgba(${acc}, ${0.16 * k})`, boxShadow: `0 0 10px rgba(${acc}, ${0.3 * k})` };
    return { background: `rgba(${acc}, ${0.3 * k})` };   // chip
  };

  const bar = (w, o = 0.09) => (
    <div style={{ height: 5, width: w, borderRadius: 3, background: `rgba(var(--st-fg-rgb), ${o})` }} />
  );

  return (
    <div>
      <div style={{
        fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase',
        color: 'rgba(var(--st-fg-rgb), 0.28)', fontWeight: 800, marginBottom: 10,
      }}
      >
        Preview
      </div>
      <div style={{
        borderRadius: 13, overflow: 'hidden',
        border: '1px solid rgba(var(--st-fg-rgb), 0.09)',
        background: 'rgb(var(--st-bg-rgb))',
      }}
      >
        {/* title bar */}
        <div style={{
          height: 22, display: 'flex', alignItems: 'center', gap: 4, padding: '0 9px',
          background: 'rgba(var(--st-fg-rgb), 0.04)',
          borderBottom: '1px solid rgba(var(--st-fg-rgb), 0.06)',
        }}
        >
          {[0, 1, 2].map((i) => (
            <span key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: 'rgba(var(--st-fg-rgb), 0.14)' }} />
          ))}
        </div>

        <div style={{ display: 'flex', minHeight: 148 }}>
          {/* nav rail — shows the active-tab marker */}
          <div style={{ width: 46, flex: '0 0 46px', padding: 7, display: 'flex', flexDirection: 'column', gap: 4, borderRight: '1px solid rgba(var(--st-fg-rgb), 0.06)' }}>
            {[true, false, false, false].map((on, i) => (
              <div key={i} style={{ height: 11, borderRadius: 4, background: 'rgba(var(--st-fg-rgb), 0.05)', ...marker(on) }} />
            ))}
          </div>

          {/* page — shows immerse + page tint */}
          <div style={{ flex: 1, minWidth: 0, position: 'relative', padding: 9 }}>
            <div style={{
              position: 'absolute', inset: 0,
              background: `linear-gradient(180deg, rgba(${acc}, ${wash * k}) 0%, rgba(${acc}, ${tint * k}) 45%, transparent 78%)`,
              pointerEvents: 'none',
            }}
            />
            <div style={{ position: 'relative', display: 'flex', gap: 8, marginBottom: 10 }}>
              <div style={{
                width: 38, height: 38, borderRadius: 5, flex: '0 0 38px',
                background: `linear-gradient(140deg, rgba(${acc}, 0.85), rgba(${acc}, 0.28))`,
              }}
              />
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5, justifyContent: 'center' }}>
                {bar('72%', 0.2)}
                {bar('44%')}
              </div>
            </div>

            {/* table — shows the date column on/off */}
            <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[0, 1, 2].map((i) => (
                <div key={i} style={{
                  display: 'grid',
                  gridTemplateColumns: showDate ? '1.9fr 1.1fr 0.9fr' : '2.3fr 1.4fr',
                  gap: 7, alignItems: 'center',
                }}
                >
                  {bar('90%', i === 0 ? 0.18 : 0.09)}
                  {bar('80%')}
                  {showDate ? bar('70%', 0.06) : null}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Now Playing bar — where Immerse actually shows up. */}
        <div style={{
          height: 24, display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px',
          borderTop: '1px solid rgba(var(--st-fg-rgb), 0.07)',
          background: barLit
            ? `linear-gradient(90deg, rgba(${acc}, ${0.42 * k}), rgba(${acc}, ${0.14 * k}) 60%, rgba(var(--st-fg-rgb), 0.03))`
            : 'rgba(var(--st-fg-rgb), 0.035)',
        }}
        >
          <span style={{ width: 13, height: 13, borderRadius: 3, background: `rgba(${acc}, 0.8)`, flex: '0 0 13px' }} />
          <span style={{ height: 4, width: 40, borderRadius: 2, background: 'rgba(var(--st-fg-rgb), 0.16)' }} />
          <span style={{ flex: 1 }} />
          <span style={{ height: 3, width: 54, borderRadius: 2, background: 'rgba(var(--st-fg-rgb), 0.12)' }} />
        </div>
      </div>
      <div style={{
        fontSize: 10, color: 'rgba(var(--st-fg-rgb), 0.3)', textAlign: 'center',
        marginTop: 9, fontWeight: 600, lineHeight: 1.5,
      }}
      >
        Approximate — colour, marker, columns
      </div>
    </div>
  );
}

/* Brief, Settings: every row is a description on the left and a fixed 320px
   right-aligned control column. Segmented controls fill that column at equal
   segment widths, so every row on a page ends at the same right edge. */
/**
 * Settings → Connections → Spotify account.
 *
 * The full sign-in (spotifyPartner.js): play counts, monthly listeners, bios
 * and related artists on artist pages, and your own Spotify library. Separate
 * from the Client ID panel above, which keeps powering search either way.
 * "Test connection" walks sign-in → web player scan → client token → a real
 * artist query and shows where it stops, because this rides an unofficial
 * interface and "it's blank" needs to come with a reason.
 */
function SpotifyAccountPanel() {
  const a = typeof window !== 'undefined' ? window.electronAPI : null;
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [steps, setSteps] = useState(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!a?.spotifyPartnerState) return undefined;
    a.spotifyPartnerState().then(setSt).catch(() => setSt({ connected: false }));
    const off = a.onSpotifyPartnerChanged?.((next) => {
      setBusy(false);
      setSt(next);
      if (next?.error) setErr(String(next.error));
      else setErr('');
    });
    return () => off?.();
  }, [a]);

  if (!a?.spotifyPartnerState) return null;

  const signIn = async () => {
    setErr(''); setSteps(null); setBusy(true);
    const r = await a.spotifyPartnerSignIn().catch((e) => ({ ok: false, error: String(e) }));
    if (!r?.ok) { setBusy(false); setErr(r?.error || 'Could not start sign-in.'); }
  };
  const signOut = async () => { await a.spotifyPartnerSignOut(); setSteps(null); };
  const test = async () => {
    setTesting(true); setSteps(null);
    const r = await a.spotifyPartnerDiagnose().catch((e) => ({ ok: false, error: String(e) }));
    setSteps(r?.ok ? r.data : [{ step: 'Test', ok: false, detail: r?.error || 'failed' }]);
    setTesting(false);
  };

  return (
    <section className="sth-conn">
      <div className="sth-conn-head">
        <div>
          <h2>Spotify account</h2>
          <p>
            Plays Spotify songs right in Studio (Premium), and powers My Spotify, search and artist
            pages (play counts, listeners, bios, discography) on any account. Save also hearts a song
            on Spotify. This uses Spotify&apos;s private web player interface, which is unofficial and
            can change without notice.
          </p>
        </div>
        {st ? (
          <span className={`st-status ${st.connected ? 'ok' : 'off'}`}>{st.connected ? 'Connected' : 'Not connected'}</span>
        ) : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {st?.connected ? (
          <>
            <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--text)' }}>
              {st.displayName || 'Signed in'}
              {st.product ? <span style={{ color: 'var(--text-faint)', fontWeight: 600 }}> · {st.product}</span> : null}
            </span>
            <span style={{ flex: 1 }} />
            <button type="button" className="st-btn st-btn-outline" onClick={test} disabled={testing}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <button type="button" className="st-btn st-btn-outline" onClick={signOut}>Sign out</button>
          </>
        ) : (
          <>
            <button type="button" className="st-btn st-btn-primary" onClick={signIn} disabled={busy}>
              {busy ? 'Waiting for your browser…' : 'Sign in with Spotify'}
            </button>
            {busy ? <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Finish in the browser tab that opened.</span> : null}
          </>
        )}
      </div>
      {err ? <div role="status" style={{ fontSize: 12, color: 'var(--danger)', marginTop: 10 }}>{err}</div> : null}
      {steps ? (
        <div style={{ display: 'grid', gap: 6, marginTop: 14 }}>
          {steps.map((x) => (
            <div key={x.step} style={{ display: 'grid', gridTemplateColumns: '16px 150px minmax(0, 1fr)', gap: 10, alignItems: 'baseline', fontSize: 12.5 }}>
              <span style={{ color: x.ok ? 'rgb(140,220,160)' : 'var(--danger)', fontWeight: 800 }}>{x.ok ? '✓' : '×'}</span>
              <span style={{ fontWeight: 700, color: 'var(--text)' }}>{x.step}</span>
              <span style={{ color: 'var(--text-faint)', overflowWrap: 'anywhere' }}>{x.detail}</span>
            </div>
          ))}
        </div>
      ) : null}
      {st?.connected ? <SpotifyPlaybackCheck needsReauth={st.canStream === false} onReauth={signIn} /> : null}
    </section>
  );
}

/**
 * Settings → Connections → Spotify account → Playback.
 *
 * Stage one of Spotify playback: the studio-spotify helper, on its own,
 * before the player bar and library are routed through it. Shows whether the
 * helper is built and signed in, and plays any track you paste so the whole
 * chain (helper → librespot → your speakers) can be checked end to end.
 */
function SpotifyPlaybackCheck({ needsReauth, onReauth }) {
  const a = typeof window !== 'undefined' ? window.electronAPI : null;
  const [snap, setSnap] = useState(null);
  const [link, setLink] = useState('');
  const [pb, setPb] = useState({ state: 'idle', id: null, positionMs: 0 });
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!a?.spotifyPlayerState) return undefined;
    a.spotifyPlayerState().then((s2) => { setSnap(s2); if (s2?.playback) setPb(s2.playback); }).catch(() => {});
    const off = a.onSpotifyPlayerEvent?.((ev) => {
      if (ev.event === 'status') { setSnap(ev); return; }
      if (['loading', 'playing', 'paused', 'ended', 'stopped', 'unavailable'].includes(ev.event)) {
        setPb((p) => ({ ...p, id: ev.id, state: ev.event, positionMs: ev.positionMs ?? p.positionMs }));
        if (ev.event === 'unavailable') setNote('Spotify says this track can’t be played on this account.');
      } else if (ev.event === 'position' || ev.event === 'seeked') {
        setPb((p) => ({ ...p, id: ev.id, positionMs: ev.positionMs }));
      } else if (ev.event === 'error') {
        setNote(String(ev.message || 'The helper reported an error.'));
      }
    });
    return () => off?.();
  }, [a]);

  if (!a?.spotifyPlayerState) return null;

  // Accepts a track link, a spotify:track: URI, or a bare ID.
  const trackId = (() => {
    const v = link.trim();
    const m = v.match(/track[/:]([0-9A-Za-z]{22})/) || v.match(/^([0-9A-Za-z]{22})$/);
    return m ? m[1] : null;
  })();
  const status = snap?.status || 'stopped';
  const statusText = !snap?.installed ? 'Helper not built'
    : status === 'ready' ? `Ready${snap.account?.account ? ` · ${snap.account.account}` : ''}`
      : status === 'starting' ? 'Starting…'
        : status === 'signingIn' ? 'Signing in…'
          : status === 'error' ? 'Not available' : 'Idle — starts when you play';
  const fmt = (ms) => { const t = Math.floor((ms || 0) / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  const act = async (fn) => {
    setNote('');
    const r = await fn().catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (r && r.ok === false) setNote(r.error || 'That didn’t work.');
  };

  return (
    <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 750, color: 'var(--text)' }}>Playback</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: status === 'error' || !snap?.installed ? 'var(--danger)' : 'var(--text-faint)' }}>{statusText}</span>
        <span style={{ flex: 1 }} />
        {snap?.installed && status === 'error' ? (
          <button type="button" className="st-btn st-btn-outline" onClick={() => act(() => a.spotifyPlayerConnect())}>Retry</button>
        ) : null}
      </div>

      {needsReauth ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text-faint)' }}>
            Your sign-in is from before playback existed. Sign in once more to allow it.
          </span>
          <button type="button" className="st-btn st-btn-primary" onClick={onReauth}>Sign in again</button>
        </div>
      ) : null}

      {!snap?.installed ? (
        <p style={{ margin: '8px 0 0', fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-faint)' }}>
          Build it once from the project folder with <code>npm run setup:spotify</code> (needs Rust from rustup.rs), then restart Studio.
        </p>
      ) : snap?.error?.message && status === 'error' ? (
        <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--danger)' }}>{snap.error.message}</p>
      ) : null}

      {snap?.installed && !needsReauth ? (
        <>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <input className="st-input" style={{ flex: 1, minWidth: 0 }} value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="Paste a Spotify track link to test playback"
              aria-label="Spotify track link" spellCheck={false} />
            <button type="button" className="st-btn st-btn-primary" disabled={!trackId}
              onClick={() => act(() => a.spotifyPlayerLoad(trackId, { play: true }))}>Play</button>
            <button type="button" className="st-btn st-btn-outline" disabled={pb.state !== 'playing' && pb.state !== 'paused'}
              onClick={() => act(() => (pb.state === 'playing' ? a.spotifyPlayerPause() : a.spotifyPlayerPlay()))}>
              {pb.state === 'paused' ? 'Resume' : 'Pause'}
            </button>
            <button type="button" className="st-btn st-btn-outline" disabled={pb.state !== 'playing' && pb.state !== 'paused'}
              onClick={() => act(() => a.spotifyPlayerStop())}>Stop</button>
          </div>
          {pb.id ? (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>
              {pb.state === 'loading' ? 'Loading…' : pb.state === 'playing' ? `Playing · ${fmt(pb.positionMs)}`
                : pb.state === 'paused' ? `Paused · ${fmt(pb.positionMs)}` : pb.state === 'ended' ? 'Finished' : pb.state}
            </div>
          ) : null}
          {note ? <div role="status" style={{ marginTop: 8, fontSize: 12, color: 'var(--danger)' }}>{note}</div> : null}
        </>
      ) : null}
    </div>
  );
}

/** Top bar, beside Settings: pick up changes without quitting the app. The
 *  main process decides how much that takes (main.js, reloadApp): a window
 *  reload for screen changes, a full restart when the main process was
 *  rebuilt. Shift+click always restarts. Ctrl+R / Ctrl+Shift+R do the same. */
function ReloadButton() {
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(false);
  const api = typeof window !== 'undefined' ? window.electronAPI : null;
  if (!api?.appReload) return null;
  const run = (e) => {
    if (busy) return;
    setBusy(true);
    api.appReload({ full: e.shiftKey }).catch(() => setBusy(false));
  };
  return (
    <button
      type="button"
      onClick={run}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Reload (Ctrl+R) · Shift+click to restart Studio (Ctrl+Shift+R)"
      aria-label="Reload Studio"
      style={{
        width: 34, height: 34, borderRadius: 10, border: 'none', cursor: busy ? 'progress' : 'pointer', marginLeft: 'auto',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: hover ? 'rgba(var(--st-fg-rgb), 0.07)' : 'transparent',
        color: hover || busy ? '#fff' : 'rgba(var(--st-fg-rgb), 0.5)',
        transition: 'background 0.16s ease, color 0.16s ease',
      }}
    >
      <style>{'@keyframes sthReloadSpin { to { transform: rotate(360deg); } }'}</style>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        style={{ animation: busy ? 'sthReloadSpin 0.7s linear infinite' : 'none' }}>
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <polyline points="21 3 21 9 15 9" />
      </svg>
    </button>
  );
}

function SetRow({ title, note, children, wide = true }) {
  return (
    <div className="sth-set-r">
      <span className="txt"><b>{title}</b>{note ? <p>{note}</p> : null}</span>
      <span className={`ctl${wide ? ' is-col' : ''}`}>{children}</span>
    </div>
  );
}

/** A segmented picker. Options are [value, label] pairs. Fills its column. */
function SetSeg({ value, options, onPick, label }) {
  return (
    <span className="st-segs" role="radiogroup" aria-label={label}>
      {options.map(([id, lbl]) => (
        <button key={String(id)} type="button" role="radio" aria-checked={value === id}
          className={value === id ? 'on' : ''} onClick={() => onPick(id)}>
          {lbl}
        </button>
      ))}
    </span>
  );
}

/* Toggle switches keep their capsule (the one radius exception) and take the
   accent when on — the stock green they used to carry is gone. */
function SetToggle({ on, onToggle, label }) {
  return (
    <button type="button" role="switch" aria-checked={!!on} aria-label={label}
      className={`st-toggle${on ? ' on' : ''}`} onClick={onToggle} />
  );
}

/**
 * The header every library view wears.
 *
 * Replaces three near-identical blocks that each stacked an eyebrow, a 44px
 * title and a profile row — about 120px spent before any music appeared, on a
 * page whose whole job is showing music. It also put your name and a song
 * count in the same sentence, which are unrelated facts.
 *
 * One 52px row instead: what you're looking at, how much of it there is, and
 * the things you can do to it. The eyebrow is gone because the sidebar already
 * says Library, and the title shrinks to list-item scale because you just
 * clicked the tab that says the same word.
 *
 * Search now appears on EVERY view. It only rendered on Songs before, while
 * the filter it writes to was shared by all three — so a query typed in Songs
 * quietly filtered Albums with no visible box to explain why.
 */
/**
 * The active filter, shown only while there IS one.
 *
 * There's no search control here any more — not a bar, not an icon. Queries
 * are typed in the palette and Enter hands them over. What can't go away is
 * the STATE: a table showing eight of your four hundred songs, with nothing
 * on screen explaining why, reads as a library that has lost songs. That is
 * a worse bug than the clutter this replaces.
 *
 * So it renders nothing at rest and appears filled when a filter arrives.
 * It stays a live input rather than a static chip because refining a filter
 * you can already see ("keshi" to "keshi d") shouldn't need a round trip
 * back out to the palette.
 */
/**
 * Search: an icon at rest, a field once you open it.
 *
 * Open state is derived, not just stored — `open || !!filter` — so a view that
 * arrives with a filter already applied (switching tabs, restoring a session)
 * shows the query rather than an innocent-looking icon hiding an active
 * filter. That was the real hazard in the always-collapsed version: a list
 * silently showing a subset with nothing on screen to say so.
 *
 * Closing on blur only happens when the field is empty. Blurring away from a
 * typed query would either discard it or hide it, and both are worse than
 * leaving the field open.
 */
function LibFilterTag({ filter, onFilter, label = 'Search' }) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);
  const expanded = open || !!filter;

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  /* Blur on the way out. Without it focus stays on an input that is now
     clipped to zero width and tabIndex -1 — invisible, unreachable by tab,
     and still holding the caret. */
  const close = useCallback(() => {
    setOpen(false);
    onFilter('');
    inputRef.current?.blur();
  }, [onFilter]);

  return (
    <div className={`sth-libtag${expanded ? ' is-open' : ''}${filter ? ' is-on' : ''}`}>
      <button
        type="button"
        className="sth-libtag-btn"
        aria-label={expanded ? label : `${label} — open`}
        aria-expanded={expanded}
        title={label}
        onClick={() => {
          if (expanded) inputRef.current?.focus();
          else setOpen(true);
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.8-3.8" />
        </svg>
      </button>
      <input
        ref={inputRef}
        type="text"
        className="sth-libtag-in"
        value={filter}
        aria-label={label}
        placeholder={label}
        /* Unreachable by keyboard while collapsed — it's clipped, not hidden,
           so without this you could tab into an invisible field. */
        tabIndex={expanded ? 0 : -1}
        onChange={(e) => onFilter(e.target.value)}
        onBlur={() => { if (!filter) setOpen(false); }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          close();
        }}
      />
      {filter ? (
        <button type="button" className="sth-libtag-x" title="Clear search (esc)" aria-label="Clear search"
          onClick={close}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      ) : null}
    </div>
  );
}

const SORT_LABELS = { title: 'Title', artist: 'Artist', album: 'Album', recent: 'Recently added' };

/**
 * Sort picker for the songs table.
 *
 * A menu rather than a button that cycles: with four options, cycling makes
 * you click through the ones you don't want and never shows you what's
 * available. The current order is in the label, so the control reports state
 * as well as setting it.
 */
function LibSortMenu({ value, field, onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button type="button" className="sth-libact" onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu" aria-expanded={open}
        title="Change sort order"
        style={{ whiteSpace: 'nowrap' }}>
        <span className="sth-libact-label">{SORT_LABELS[field] || 'Title'}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open ? (
        <div role="menu" className="sth-libsortmenu">
          {Object.keys(SORT_LABELS).map((k) => (
            <button key={k} type="button" role="menuitemradio" aria-checked={field === k}
              className={`sth-libsortitem${field === k ? ' is-on' : ''}`}
              onClick={() => { onPick(k); setOpen(false); }}>
              {SORT_LABELS[k]}
            </button>
          ))}
          {/* Only offered once you've overridden — "follow the view" isn't a
              sort you pick, it's the absence of one. */}
          {value ? (
            <button type="button" role="menuitem" className="sth-libsortitem sth-libsortitem-reset"
              onClick={() => { onPick(null); setOpen(false); }}>
              Match the view
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LibHeader({
  title, meta, filter, onFilter, searchPlaceholder,
  onPlayAll, onShuffle, sortValue, sortField, onPickSort, acc,
  onImportFiles, onImportFolder, onImportSpotify, importing = false,
}) {
  const [importOpen, setImportOpen] = useState(false);
  const canImport = !!(onImportFiles || onImportFolder || onImportSpotify);
  /* Two tiers only when the second one earns its height. Albums and Artists
     pass no playback or sort handlers, so theirs would carry a lone search
     icon — a row of reserved space with one thing in it. */
  const hasControls = !!(onPlayAll || onShuffle || onPickSort);

  return (
    <div className={`sth-libhead${hasControls ? '' : ' is-single'}`}>
      {/* Tier one — what this is. */}
      <span className="sth-libhead-tw">
        <span className="sth-libhead-t">{title}</span>
        {meta ? <span className="sth-libhead-m">{meta}</span> : null}
      </span>

      {!hasControls ? (
        <>
          <CompactVizSlot />
          <LibFilterTag filter={filter} onFilter={onFilter} label={searchPlaceholder} />
          {/* Also on the single-tier branch. Albums and Artists pass no
              playback or sort handlers and so take this path — without it,
              "Add" appeared in Songs and silently vanished in the other two
              views, which reads as a bug rather than a layout. */}
          {canImport ? (
            <LibImportMenu
              open={importOpen} onOpen={setImportOpen} importing={importing}
              onImportFiles={onImportFiles} onImportFolder={onImportFolder} onImportSpotify={onImportSpotify}
            />
          ) : null}
        </>
      ) : (
      /* Tier two — what you can do to it.
         Playback anchored left, list controls anchored right. Both ends are
         pinned, so the space between them can grow to any width without
         reading as a hole — that's the property single-row never had. */
      <span className="sth-libhead-r2">
        {onPlayAll ? (
          <button type="button" className="sth-libact sth-libact-primary" onClick={onPlayAll} style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
            <PlayIcon size={13} />
            <span className="sth-libact-label">Play all</span>
          </button>
        ) : null}
        {onShuffle ? (
          <button type="button" className="sth-libact" onClick={onShuffle} style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
            </svg>
            <span className="sth-libact-label">Shuffle</span>
          </button>
        ) : null}

        {/* The empty middle; in compact mode, the visualizer if one is picked. */}
        <CompactVizSlot />

        <LibFilterTag filter={filter} onFilter={onFilter} label={searchPlaceholder} />
        {onPickSort ? (
          <LibSortMenu value={sortValue} field={sortField} onPick={onPickSort} />
        ) : null}
        {canImport ? (
          <LibImportMenu
            open={importOpen} onOpen={setImportOpen} importing={importing}
            onImportFiles={onImportFiles} onImportFolder={onImportFolder} onImportSpotify={onImportSpotify}
          />
        ) : null}
      </span>
      )}
    </div>
  );
}

/**
 * Import menu for the library header.
 *
 * This is a restoration as much as an addition. The only import UI in the
 * app lived in LibPanelHeader, which nothing renders — so onImportFiles and
 * onImportFolder were threaded all the way down from App.jsx to a dead
 * component, and adding music by any route other than dragging it onto the
 * window was impossible. Putting the menu on the live header fixes that and
 * gives the Spotify importer somewhere to hang.
 */
function LibImportMenu({ open, onOpen, importing, onImportFiles, onImportFolder, onImportSpotify }) {
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button type="button" className="sth-libact" onClick={() => onOpen(!open)} disabled={importing}
        title="Import music" aria-label="Import music" aria-haspopup="menu" aria-expanded={open}
        style={{ flexShrink: 0, whiteSpace: 'nowrap', opacity: importing ? 0.5 : 1 }}>
        {importing ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M12 3a9 9 0 1 0 9 9">
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite" />
            </path>
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
        )}
        <span className="sth-libact-label">Import</span>
      </button>
      {open && !importing ? (
        <>
          {/* Click-away catcher rather than a document listener — a listener
              here has to dodge the button's own click, which is where that
              pattern usually goes wrong. */}
          <div onClick={() => onOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div role="menu" style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 41,
            minWidth: 196, padding: 5, borderRadius: 11,
            background: 'rgb(18, 18, 21)',
            border: '1px solid rgba(var(--st-fg-rgb), 0.1)',
            boxShadow: '0 14px 38px rgba(0,0,0,0.6)',
          }}>
            {onImportFiles ? (
              <ImportMenuItem label="Import files…" hint="Pick individual tracks"
                onClick={() => { onOpen(false); onImportFiles(); }} />
            ) : null}
            {onImportFolder ? (
              <ImportMenuItem label="Import folder…" hint="Scans subfolders too"
                onClick={() => { onOpen(false); onImportFolder(); }} />
            ) : null}
            {/* Ruled off: the two above read files you already have, this one
                goes and fetches them. Same menu because it's the same intent
                — get music into studio — but not the same operation. */}
            {onImportSpotify ? (
              <>
                {(onImportFiles || onImportFolder) ? (
                  <div style={{ height: 1, background: 'rgba(var(--st-fg-rgb), 0.07)', margin: '4px 6px' }} />
                ) : null}
                <ImportMenuItem label="From Spotify…" hint="Pick a playlist, choose tracks"
                  onClick={() => { onOpen(false); onImportSpotify(); }} />
              </>
            ) : null}
            <div style={{
              padding: '7px 9px 4px', fontSize: 10, lineHeight: 1.45,
              color: 'rgba(var(--st-sub-rgb), 0.35)',
              borderTop: '1px solid rgba(var(--st-fg-rgb), 0.07)', marginTop: 4,
            }}>
              Or drag files and folders anywhere onto the window.
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The play and pause glyphs, defined once.
 *
 * The triangle has rounded corners the way the Now Playing bar draws it: a
 * <polygon> has hard points, so the same path is stroked with a round linejoin
 * AND filled, which grows the shape by half the stroke on every side and
 * rounds all three corners evenly. Row buttons were drawing a sharp triangle
 * with a different stroke width, so the same control looked like two controls
 * depending where you found it.
 */
/* PlayGlyph / PauseGlyph now live in sharedUI.jsx as PlayIcon / PauseIcon, so
   every file draws the same shape rather than each keeping a copy. */
const PlayGlyph = PlayIcon;
const PauseGlyph = PauseIcon;

/**
 * The play control that replaces a row's index on hover.
 *
 * It has to answer "what will clicking do", and for the row that's currently
 * playing the answer is pause — every row was hard-coded to a play triangle
 * that restarted the track instead. Three different row layouts each drew
 * their own copy of this, which is how they all had the same bug; there's one
 * copy now.
 *
 * The row being CURRENT and the row being AUDIBLE are different questions:
 * the current track paused shows play (clicking resumes), and only the
 * current track actually playing shows pause.
 */
function RowPlayButton({ playing, isPlaying, title, onPlay, onTogglePlay, style }) {
  const showPause = playing && isPlaying;
  const label = showPause ? 'Pause' : 'Play';
  return (
    <button
      type="button"
      className="sth-lrow-play"
      style={style}
      onClick={(e) => {
        e.stopPropagation();
        // Resuming or pausing the current track must not restart it.
        if (playing && onTogglePlay) onTogglePlay();
        else onPlay();
      }}
      title={label}
      aria-label={title ? `${label} ${title}` : label}
    >
      {showPause ? <PauseGlyph size={12} /> : <PlayGlyph size={12} />}
    </button>
  );
}

const LibRow = React.memo(function LibRow({ t, index, playing, isPlaying, acc, art, added, canManage, onPlay, onTogglePlay, onMenu,
  onOpenArtist, onOpenAlbum,
}) {
  return (
    <div
      className={`sth-lrow${playing ? ' is-playing' : ''}`}
      onDoubleClick={() => onPlay(t)}
      onContextMenu={canManage ? (e) => onMenu(e, t) : undefined}
    >
      <div className="sth-lrow-n" {...hoverPreload(t)}>
        {playing
          ? <PlayingBars acc={acc} playing={isPlaying} />
          : <span className="sth-lrow-num">{index + 1}</span>}
        <RowPlayButton
          playing={playing} isPlaying={isPlaying} title={t.title}
          onPlay={() => onPlay(t)} onTogglePlay={onTogglePlay}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <div style={{ width: 38, height: 38, borderRadius: 5, flexShrink: 0, background: art ? `url("${art}") center/cover` : 'rgba(var(--st-fg-rgb), 0.08)' }} />
        <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: playing ? `rgb(${acc})` : '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
          {t.explicit ? <ExplicitBadge /> : null}
        </div>
      </div>
      {/* Artist and album are navigation, not decoration.
          Buttons rather than divs with onClick: these are the only way to
          reach a record from the songs list, and a mouse-only route there
          would be no route at all for anyone tabbing. stopPropagation keeps
          a click off the row's own play/select behaviour — the row still
          plays on double-click, the cell still navigates on single. */}
      <div className="sth-lrow-dim" style={{ minWidth: 0 }}>
        {onOpenArtist && t.artist ? (
          <button type="button" className="sth-lcell-link"
            onClick={(e) => { e.stopPropagation(); onOpenArtist(t); }}
            onDoubleClick={(e) => e.stopPropagation()}
            title={`Go to ${t.artist}`}>
            {t.artist}
          </button>
        ) : t.artist}
      </div>
      <div className="sth-lrow-dim sth-lcol-album" style={{ minWidth: 0 }}>
        {onOpenAlbum && t.album ? (
          <button type="button" className="sth-lcell-link"
            onClick={(e) => { e.stopPropagation(); onOpenAlbum(t); }}
            onDoubleClick={(e) => e.stopPropagation()}
            title={`Go to ${t.album}`}>
            {t.album}
          </button>
        ) : t.album}
      </div>
      <div className="sth-lrow-dim sth-lcol-date">{added}</div>
      {/* Centred in its track, matching the clock in the header. Right-aligned
          with 6px padding put the digits' visual mass left of the icon above
          them, because the icon is 13px wide and "3:26" is nearer 28 — both
          ended at the same x, which is not the same as looking aligned. */}
      <div className="sth-lrow-dim" style={{ textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{formatTime(t.duration)}</div>
      <div>
        {canManage ? (
          <button type="button" className="sth-lrow-more" onClick={(e) => onMenu(e, t)} title="More" aria-label="More">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
          </button>
        ) : null}
      </div>
    </div>
  );
});

function DetailAction({ title, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        width: 30, height: 30, borderRadius: 8, border: 'none', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'transparent', color: 'rgba(var(--st-sub-rgb), 0.62)',
        transition: 'color 0.15s ease, background 0.15s ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.background = 'rgba(var(--st-fg-rgb), 0.09)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(var(--st-fg-rgb), 0.62)'; e.currentTarget.style.background = 'transparent'; }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

function PanelLabel({ children, inset = false }) {
  return (
    <div style={{
      fontSize: 9.5, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase',
      color: 'rgba(var(--st-sub-rgb), 0.4)', padding: inset ? '18px 0 8px' : '10px 9px 6px',
    }}>{children}</div>
  );
}


/**
 * CoverLightbox — the artwork, big, with the two things you'd want from it.
 *
 * "Save to Downloads" writes the EXACT bytes the app is displaying, via the
 * existing covers:export handler — not a re-encode, not a re-fetch, the same
 * file the cover store holds. That matters: a separately downloaded jpg of the
 * same artwork is a different encoding at a different size, and the whole
 * class of bug this came out of was two encodings of one picture being treated
 * as two different records.
 *
 * "Use for this whole album" is the one that actually prevents a recurrence.
 * Exporting gives you a file; pinning makes every track on the record resolve
 * to ONE cover URL through coverFor, regardless of what each individual file
 * happens to carry in its tags. A local rip and an in-app download of the same
 * album stop being able to disagree, because neither is asked.
 */
function CoverLightbox({ url, track, accent, albumKey, onPin, onClose }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const acc = readableAccent(accent);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const exportName = [track?.artist, track?.album || track?.title]
    .filter(Boolean).join(' - ') || 'cover';

  const save = async (saveAs) => {
    if (busy) return;
    setBusy(true);
    setNote('saving…');
    try {
      const api = window.electronAPI;
      const fn = saveAs ? api?.exportCoverSaveAs : api?.exportCover;
      if (!fn) { setNote('export unavailable in this build'); return; }
      const r = await fn(url, exportName);
      if (r?.ok) {
        const kb = Math.round((r.bytes || 0) / 1024);
        setNote(saveAs ? `saved (${kb} KB)` : `saved to Downloads (${kb} KB)`);
      } else {
        setNote(r?.error || 'could not save');
      }
    } catch (e) {
      setNote(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const pin = async () => {
    if (busy || !albumKey || !onPin) return;
    setBusy(true);
    setNote('applying…');
    try {
      await onPin(albumKey, url);
      setNote('this cover now applies to the whole album');
    } catch (e) {
      setNote(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const btn = {
    padding: '9px 14px', borderRadius: 10, cursor: busy ? 'default' : 'pointer',
    border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.06)',
    color: busy ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.9)',
    fontSize: 12, fontWeight: 650, whiteSpace: 'nowrap',
    transition: 'background 0.15s ease, color 0.15s ease',
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Cover art"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 20,
        background: 'rgba(0,0,0,0.82)',
        backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)',
        animation: 'sthCoverZoomIn 200ms cubic-bezier(0.22, 1, 0.36, 1) both',
        padding: 32,
      }}
    >
      {/* Stop clicks on the artwork itself from dismissing — only the
          backdrop closes, which is what every image viewer does. */}
      <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, maxWidth: '100%' }}>
        {url ? (
          <img
            src={url}
            alt={track?.album || track?.title || 'Cover art'}
            draggable={false}
            style={{
              width: 'min(72vh, 72vw)', height: 'min(72vh, 72vw)',
              objectFit: 'cover', borderRadius: 14, display: 'block',
              boxShadow: `0 30px 90px rgba(0,0,0,0.7), 0 0 0 1px rgba(${acc},0.35)`,
            }}
          />
        ) : null}

        <div style={{ textAlign: 'center', minWidth: 0, maxWidth: '80vw' }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {track?.album || track?.title || ''}
          </div>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {track?.artist || ''}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button type="button" style={btn} disabled={busy} onClick={() => save(false)}
            title="Write the exact image being displayed into your Downloads folder">
            Save to Downloads
          </button>
          <button type="button" style={btn} disabled={busy} onClick={() => save(true)}
            title="Choose where to write the exact image being displayed">
            Save as…
          </button>
          {albumKey && onPin ? (
            <button type="button" disabled={busy} onClick={pin}
              style={{ ...btn, background: `rgba(${acc},0.22)`, borderColor: `rgba(${acc},0.4)` }}
              title="Make every track on this album use this exact cover">
              Use for this whole album
            </button>
          ) : null}
        </div>

        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', minHeight: 15, textAlign: 'center' }}>
          {note || 'Esc or click outside to close'}
        </div>
      </div>
    </div>
  );
}

/* The action cluster is two groups, not one row of five.
 *
 * Left of the rule: things done TO THE SONG — favourite, add to a playlist,
 * and the overflow menu, which is the same menu a right-click on any library
 * row opens. Right of the rule: things done to the VIEW — which panel is
 * showing, how the bar is coloured, whether the stage is up. They were
 * interleaved before, so "queue" and "add to playlist" sat next to each other
 * looking like a pair when one queues a song for now and the other files it
 * forever.
 *
 * The "Song & artist info" toggle is gone from here. It was a third way to
 * open a panel whose own tab strip already switches between info, lyrics and
 * queue — three buttons for a two-button job. Lyrics and queue stay because
 * they're the two people reach for mid-song; info is one tab away once either
 * is open.
 */
/* The early return lives out here: the bar's body calls hooks, and a return
   above them changes how many run the moment playback stops (React throws). */
function NowPlayingBar(props) {
  return props.track ? <NowPlayingBarBody {...props} /> : null;
}

function NowPlayingBarBody({ track, isPlaying, art, accent, immersePalette = null, onZoomCover, onCopyLink, copyBusy = false, onTogglePlay, onPrev, onNext, volume = 1, onSetVolume, animatedBg = false, solidWash = null, currentTime = 0, onSeek, onExpand, onToggleImmerse, immerseOn = false, onFullscreen, onToggleQueue, queueOpen = false, onToggleLyrics, lyricsOpen = false, onToggleFavorite, onAddToPlaylist, onMore, shuffleOn = false, repeat = 'off', onToggleShuffle, onToggleRepeat }) {
  const acc = readableAccent(accent);
  /* 0.82 / 0.45, not 0.55 / 0.22. These feed AnimatedGradientBg's mid and
     wash stops; at the old values the gradient started dark before anything
     else touched it. The fullscreen stage keeps the darker pair because it
     fills the screen behind large type — an 84px bar doesn't have that
     problem. */
  /* Immerse shows the RECORD. Its three colours are three colours FROM the
     sleeve, not one value scaled to 82% and 45% of itself — that only ever
     produced three shades of the same thing, which is what made it look like
     a tint rather than the artwork. */
  const gradBase = immersePalette?.accent || accent;
  const gradMid = immersePalette?.mid || gradBase.split(',').map((n) => Math.round(Number(n) * 0.82)).join(', ');
  const gradWash = immersePalette?.wash || gradBase.split(',').map((n) => Math.round(Number(n) * 0.45)).join(', ');
  const dur = Number.isFinite(track.duration) && track.duration > 0 ? track.duration : 0;
  // While dragging the seek bar, show the dragged position instead of the
  // live one so the handle tracks the cursor smoothly; commit on release.
  const [scrub, setScrub] = useState(null); // 0..1 while dragging, else null
  const seekTrackRef = useRef(null);
  const shownPct = scrub != null ? scrub * 100 : (dur ? Math.min(100, Math.max(0, (currentTime / dur) * 100)) : 0);
  const fmtT = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60); const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };
  const posFromEvent = (clientX) => {
    const el = seekTrackRef.current; if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  const beginScrub = (e) => {
    if (!onSeek || !dur) return;
    e.stopPropagation(); e.preventDefault();
    const frac = posFromEvent(e.clientX);
    setScrub(frac);
    const move = (ev) => setScrub(posFromEvent(ev.clientX));
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const f = posFromEvent(ev.clientX);
      setScrub(null);
      onSeek(f * dur);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  /* Mute remembers where it was, so unmuting returns to the same level. */
  const lastVol = useRef(volume > 0 ? volume : 0.6);
  useEffect(() => { if (volume > 0) lastVol.current = volume; }, [volume]);
  const muted = volume <= 0.001;
  const toggleMute = () => onSetVolume?.(muted ? (lastVol.current || 0.6) : 0);
  const shownTime = scrub != null ? scrub * dur : currentTime;
  const onSeekKey = (e) => {
    if (!onSeek || !dur) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); onSeek(Math.min(dur, currentTime + 5)); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); onSeek(Math.max(0, currentTime - 5)); }
  };
  return (
    /* Implementation brief, Now Playing bar: a detached card — same left and
       right edges as the content card, a 12px gap above it, 16px radius on all
       four corners, 86px tall. Three zones: 282 | flexible | 282. The scrubber
       sits directly under the transport at 420px instead of spanning the bar,
       which is what made the old bar read as two storeys that didn't line up.
       Copy-link, colour and fullscreen moved into the overflow menu. */
    <div className="sth-npbar" role="region" aria-label="Now playing" style={
      solidWash ? { background: `rgb(${solidWash})` } : (animatedBg ? { background: '#000' } : undefined)
    }>
      {animatedBg && !solidWash ? (
        <>
          <div aria-hidden style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}>
            <AnimatedGradientBg accent={gradBase} mid={gradMid} wash={gradWash} coverUrl={art} isPlaying={isPlaying} vignette={false} brightness={1} />
          </div>
          <div aria-hidden style={{
            position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
            background: 'linear-gradient(90deg, rgba(0,0,0,0.42) 0%, rgba(0,0,0,0.16) 22%, rgba(0,0,0,0) 38%)',
          }} />
        </>
      ) : null}

      <div className="sth-npbar-grid">
        {/* ---- Left, 282px: what's playing ---- */}
        <div className="sth-npbar-left">
          {art && onZoomCover ? (
            <button type="button" className="sth-npbar-art" onClick={() => onZoomCover(art)}
              title="View cover art" aria-label="View cover art full size"
              style={{ background: `url("${art}") center/cover`, cursor: 'zoom-in' }} />
          ) : (
            <div className="sth-npbar-art" style={{ background: art ? `url("${art}") center/cover` : 'rgba(255,255,255,0.08)' }} />
          )}
          <div style={{ minWidth: 0 }}>
            {onCopyLink ? (
              <button type="button" className="sth-npbar-title is-link" onClick={() => onCopyLink(track)} disabled={copyBusy}
                title={copyBusy ? 'Looking up on Spotify…' : `${track.title} · click to copy Spotify link`}
                aria-label={`Copy Spotify link for ${track.title}`}>{track.title}</button>
            ) : (
              <div className="sth-npbar-title" title={track.title}>{track.title}</div>
            )}
            <div className="sth-npbar-artist" title={track.artist}>{track.artist}</div>
          </div>
        </div>

        {/* ---- Centre: transport, scrubber directly beneath ---- */}
        <div className="sth-npbar-mid">
          <div className="sth-npbar-transport">
            {onToggleShuffle ? (
              <button type="button" className={`sth-npbtn${shuffleOn ? ' is-on' : ''}`} onClick={onToggleShuffle}
                title={shuffleOn ? 'Shuffle on' : 'Shuffle off'} aria-label="Shuffle" aria-pressed={shuffleOn}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 3h5v5" /><path d="M4 20L21 3" /><path d="M21 16v5h-5" /><path d="M15 15l6 6" /><path d="M4 4l5 5" />
                </svg>
              </button>
            ) : null}
            {onPrev ? (
              <button type="button" className="sth-npbtn" onClick={onPrev} title="Previous" aria-label="Previous">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 5l-7 7 7 7" />
                </svg>
              </button>
            ) : null}
            {onTogglePlay ? (
              <button type="button" className="sth-npbar-play" onClick={onTogglePlay}
                title={isPlaying ? 'Pause' : 'Play'} aria-label={isPlaying ? 'Pause' : 'Play'}>
                {isPlaying ? <PauseGlyph size={17} /> : <PlayGlyph size={17} />}
              </button>
            ) : null}
            {onNext ? (
              <button type="button" className="sth-npbtn" onClick={onNext} title="Next" aria-label="Next">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 5l7 7-7 7" />
                </svg>
              </button>
            ) : null}
            {onToggleRepeat ? (
              <button type="button" className={`sth-npbtn${repeat !== 'off' ? ' is-on' : ''}`} onClick={onToggleRepeat}
                title={repeat === 'one' ? 'Repeat this track' : repeat === 'all' ? 'Repeat queue' : 'Repeat off'}
                aria-label={repeat === 'one' ? 'Repeat: this track' : repeat === 'all' ? 'Repeat: queue' : 'Repeat: off'} aria-pressed={repeat !== 'off'}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
                  <polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
                  {repeat === 'one' ? <text x="12" y="15" textAnchor="middle" fontSize="9" fontWeight="700" fill="currentColor" stroke="none">1</text> : null}
                </svg>
              </button>
            ) : null}
          </div>

          <div className="sth-npbar-scrub">
            <span className="sth-npbar-t st-num" style={{ textAlign: 'right' }}>{fmtT(shownTime)}</span>
            <div
              className="sth-npbar-seek"
              ref={seekTrackRef}
              onPointerDown={onSeek && dur ? beginScrub : undefined}
              onKeyDown={onSeekKey}
              role="slider"
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={Math.round(dur) || 0}
              aria-valuenow={Math.round(shownTime)}
              aria-valuetext={`${fmtT(shownTime)} of ${fmtT(dur)}`}
              tabIndex={0}
            >
              <div className="sth-npbar-seek-fill" style={{ width: `${shownPct}%`, transition: scrub != null ? 'none' : 'width 0.25s linear' }}>
                <span className="sth-npbar-seek-knob" />
              </div>
            </div>
            <span className="sth-npbar-t st-num">{fmtT(dur)}</span>
          </div>
        </div>

        {/* ---- Right, 282px: three clusters ---- */}
        <div className="sth-npbar-right">
          <div className="sth-npbar-cluster">
            {onToggleFavorite ? (
              <button type="button" className={`sth-npbtn${track.isFavorite ? ' is-on' : ''}`} onClick={() => onToggleFavorite(track.id)}
                title={track.isFavorite ? 'Remove from favourites' : 'Add to favourites'}
                aria-label={track.isFavorite ? 'Remove from favourites' : 'Add to favourites'}
                aria-pressed={!!track.isFavorite}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill={track.isFavorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20.8 8.6a5 5 0 0 0-8.8-2.6A5 5 0 0 0 3.2 8.6c0 4.2 5.5 7.6 8.8 10.4 3.3-2.8 8.8-6.2 8.8-10.4z" />
                </svg>
              </button>
            ) : null}
            {onAddToPlaylist ? (
              <button type="button" className="sth-npbtn" onClick={(e) => onAddToPlaylist(e, track)}
                title="Add to playlist" aria-label="Add to playlist" aria-haspopup="menu">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="8.5" /><path d="M12 8.5v7M8.5 12h7" />
                </svg>
              </button>
            ) : null}
          </div>
          <span aria-hidden className="sth-npbtn-rule" />
          <div className="sth-npbar-cluster">
            {onToggleQueue ? (
              <button type="button" className={`sth-npbtn${queueOpen ? ' is-on' : ''}`} onClick={onToggleQueue}
                title="Queue" aria-label="Queue" aria-pressed={queueOpen}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h12M3 11h12M3 16h7" /><path d="M21 5v9.2" /><circle cx="19" cy="15.4" r="2.1" />
                </svg>
              </button>
            ) : null}
            {onToggleLyrics ? (
              <button type="button" className={`sth-npbtn${lyricsOpen ? ' is-on' : ''}`} onClick={onToggleLyrics}
                title="Lyrics" aria-label="Lyrics" aria-pressed={lyricsOpen}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 6h16M4 11h16M4 16h10" />
                </svg>
              </button>
            ) : null}
            {onFullscreen ? (
              <button type="button" className="sth-npbtn" onClick={onFullscreen}
                title="Fullscreen" aria-label="Open fullscreen player">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
                </svg>
              </button>
            ) : null}
            {onMore ? (
              <button type="button" className="sth-npbtn" onClick={(e) => onMore(e, track)}
                title="More" aria-label="More actions" aria-haspopup="menu">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                  <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
                </svg>
              </button>
            ) : null}
          </div>
          {onSetVolume ? (
            <>
              <span aria-hidden className="sth-npbtn-rule sth-npbar-vol" />
              <div className="sth-npbar-cluster sth-npbar-vol">
                <button type="button" className="sth-npbtn" onClick={toggleMute}
                  title={muted ? 'Unmute' : 'Mute'} aria-label={muted ? 'Unmute' : 'Mute'} aria-pressed={muted}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
                    {muted ? <path d="M16 9.5l5 5M21 9.5l-5 5" /> : <><path d="M15.5 9a4 4 0 0 1 0 6" />{volume > 0.5 ? <path d="M18.5 6.5a8 8 0 0 1 0 11" /> : null}</>}
                  </svg>
                </button>
                <input
                  type="range" min={0} max={1} step={0.01} value={volume}
                  onChange={(e) => onSetVolume(Number(e.target.value))}
                  className="sth-vol" aria-label="Volume"
                  style={{ width: 72, background: `linear-gradient(to right, #fff 0%, #fff ${volume * 100}%, rgba(255,255,255,0.16) ${volume * 100}%, rgba(255,255,255,0.16) 100%)` }}
                />
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Artwork identity, and why a URL isn't it.
 *
 * The now-playing square cross-dissolves on every track change. That reads as
 * a swap when the picture genuinely changes and as nothing at all when it
 * doesn't — provided "doesn't" is decided on the PICTURE. Decided on the URL
 * string it's wrong constantly, because one record reaches the app by more
 * than one route and each route names the same image differently:
 *
 *   in-app download  → studio-cover://local/<sha1 of the fetched jpeg>.jpg
 *   local file       → studio-cover://local/<sha1 of the embedded jpeg>.jpg,
 *                      or a data: URI for the rest of the session it was
 *                      imported in
 *
 * Byte-identical artwork gives an identical sha1 and therefore an identical
 * URL — but re-encoding, a different source resolution, or a tagger rewriting
 * the APIC frame changes the bytes without changing the picture, and then the
 * two URLs differ. Chromium has no idea they're the same image, so it has to
 * fetch and rasterise the second one; the square paints empty for a frame or
 * two while that happens, and that blank frame is the blink.
 * ------------------------------------------------------------------------- */

/** The stable part of a cover URL: its content hash where one exists. */
function artIdentity(url) {
  if (!url) return '';
  const m = /^studio-cover:\/\/[^/]*\/([a-f0-9]{16,})\./i.exec(url);
  return m ? `sha:${m[1].toLowerCase()}` : url;
}

/**
 * Is the incoming artwork the same PICTURE as the outgoing one?
 *
 * Three tests, cheapest first: the same URL, the same content hash inside two
 * different-looking URLs, or — the case bytes can't settle — the same record.
 * Two tracks on one album share its sleeve by definition, so an album match is
 * a sound answer even when the two files carry differently-encoded copies of
 * it. A false positive here costs a swap animation nobody asked for; a false
 * negative costs the blink, which is the thing being fixed.
 */
function sameArtwork(aUrl, aTrack, bUrl, bTrack) {
  if (!aUrl || !bUrl) return false;
  if (artIdentity(aUrl) === artIdentity(bUrl)) return true;
  if (aTrack && bTrack) {
    const ak = albumKeyOf(aTrack);
    if (ak && ak !== '::' && ak === albumKeyOf(bTrack)) return true;
  }
  return false;
}

/* Warm cache of decoded cover bitmaps.
 *
 * The Image objects are RETAINED, deliberately. The old pre-decode dropped its
 * Image on the next line, so the bitmap it had just decoded was collectable
 * immediately and the paint that mattered — a background-image on a custom
 * protocol, which has to round-trip to the main process — was as cold as if
 * nothing had been warmed at all. Holding a couple of dozen references costs a
 * few MB and makes the swap a composite rather than a fetch. */
const ART_WARM = new Map(); // url → { img, promise }
const ART_WARM_MAX = 24;

function warmArt(url) {
  if (!url || typeof Image === 'undefined') return null;
  const hit = ART_WARM.get(url);
  if (hit) { // refresh LRU position
    ART_WARM.delete(url);
    ART_WARM.set(url, hit);
    return hit.promise;
  }
  const img = new Image();
  const promise = new Promise((resolve) => {
    const done = () => resolve(img);
    img.onload = () => {
      if (img.decode) img.decode().then(done, done);
      else done();
    };
    img.onerror = done;
  });
  try { img.src = url; } catch { /* ignore */ }
  ART_WARM.set(url, { img, promise });
  while (ART_WARM.size > ART_WARM_MAX) {
    ART_WARM.delete(ART_WARM.keys().next().value);
  }
  return promise;
}

const NP_MINI_HEADER_H = 88;  // 72px cover + 16px breathing room — matches
                              // the overlay's MINI_HEADER_H exactly.

/** Persistent Now Playing panel — the right column of the library view when
 *  nothing is being browsed. Shows the current track, or an idle prompt.
 *
 *  Track changes are animated as a swap rather than a hard cut: the outgoing
 *  title/artist fly upward (artist first, title trailing) while the outgoing
 *  artwork dissolves up through a blur, then the incoming lines rise in from
 *  below (title first, artist trailing) as the new artwork settles. The two
 *  halves overlap, so the panel never shows an empty frame.
 */
function NowPlayingPanel({ track, isPlaying, art, accent, onOpenFullscreen, onCollapseToBar, expanded = false, volume = 1, onSetVolume, onTogglePlay, onPrev, onNext, shuffleOn = false, repeat = 'off', onToggleShuffle, onToggleRepeat, animatedBg = false, onToggleAnimatedBg, showLyrics = false, onToggleLyrics, showCredits = false, onToggleCredits, lyricsData, onLyricsSaved, currentTime = 0, onSeek, library = [], onPlayTrack, upNext = [], onSelectTrack,
  /* Command center. The NODE is built by StudioHome (where playEvents,
     releases, followedArtists and the metadata callbacks already live) and
     handed down, so this component doesn't have to grow twenty pass-through
     props for a card it only positions. */
  commandCenter = null, ccOpen = false, ccExiting = false, onToggleCc,
  bigCoverRef, miniCoverRef, coverInFlight = false,
  lyricSelection = null, onLyricSelectStart, onLyricSelectLine, onBrowseLyrics }) {
  const acc = readableAccent(accent);
  // AnimatedGradientBg wants accent/mid/wash. We only have accent here, so
  // derive a darker mid and a near-black wash from it — enough variation for
  // the field to read without needing the full cover-theme palette.
  const gradMid = accent.split(',').map((n) => Math.round(Number(n) * 0.55)).join(', ');
  const gradWash = accent.split(',').map((n) => Math.round(Number(n) * 0.22)).join(', ');
  const lyricsAvailable = !!(lyricsData && (lyricsData.synced?.length || lyricsData.plain));

  const [dockCard, setDockCard] = useState(null); // null | 'credits' | 'queue'
  useEffect(() => {
    if (!dockCard) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setDockCard(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dockCard]);

  // Credits are fetched on demand (only when the view is opened) and cached
  // per track for the session, so flipping the toggle off and on is free.
  const [credits, setCredits] = useState(null);      // { primary, writers, producers, performances, releaseDate, url } | null
  const [creditsState, setCreditsState] = useState('idle'); // idle | loading | done | error
  const creditsCacheRef = useRef(new Map());
  const creditsReqRef = useRef(0);
  useEffect(() => {
    if (!(showCredits || dockCard === 'credits') || !track) return;
    const key = `${track.artist || ''}|${track.title || ''}`;
    const cached = creditsCacheRef.current.get(key);
    if (cached !== undefined) { setCredits(cached); setCreditsState(cached ? 'done' : 'error'); return; }
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.geniusCredits) { setCreditsState('error'); return; }
    const reqId = ++creditsReqRef.current;
    setCreditsState('loading'); setCredits(null);
    api.geniusCredits({ title: track.title || '', artist: track.artist || '' })
      .then((res) => {
        if (creditsReqRef.current !== reqId) return;
        const data = res?.ok ? res.credits : null;
        creditsCacheRef.current.set(key, data);
        setCredits(data); setCreditsState(data ? 'done' : 'error');
      })
      .catch(() => {
        if (creditsReqRef.current !== reqId) return;
        setCredits(null); setCreditsState('error');
      });
  }, [showCredits, dockCard, track?.id, track?.title, track?.artist]);

  // Timings. OUT is short and ease-IN; RETURN is longer and ease-OUT — the
  // exit is deliberately the entrance played backwards.
  const OUT_MS = 240;
  const IN_MS = 620;
  const EASE_OUT = 'cubic-bezier(0.55, 0, 0.55, 0.2)';
  const EASE_IN = 'cubic-bezier(0.22, 1, 0.36, 1)';

  // `shown` lags the incoming props for OUT_MS so the old content can leave.
  const [shown, setShown] = useState({ track, art });
  const [phase, setPhase] = useState('idle'); // 'idle' | 'out' | 'in'
  const [ghostArt, setGhostArt] = useState(null); // outgoing art, dissolving
  const [swapKey, setSwapKey] = useState(0); // bumped to restart TEXT animations
  /* A SECOND key, for the art layer alone. The text swaps on every track
     change; the artwork only swaps when the picture changes. One key can't
     express that — bumping it remounts the art div, and a remount is a fresh
     background-image fetch, which is the blink even when the URL is the same. */
  const [artKey, setArtKey] = useState(0);
  const [artHeld, setArtHeld] = useState(false); // picture unchanged this swap
  const lastKeyRef = useRef(null);
  const timersRef = useRef([]);

  // Warm (and RETAIN) the incoming bitmap the moment its URL is known, so the
  // swap composites an already-decoded image instead of starting a fetch.
  useEffect(() => { warmArt(art); }, [art]);

  useEffect(() => {
    const key = `${track?.id || ''}::${art || ''}`;
    if (lastKeyRef.current === key) return; // already showing/animating to this
    const isFirst = lastKeyRef.current === null;
    lastKeyRef.current = key;

    // First run (panel just mounted) adopts silently — the panel itself is
    // already sliding in, so a swap on top would double up.
    if (isFirst) { setShown({ track, art }); return; }

    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];

    /* Same picture? Then the square does nothing at all: no ghost, no
       animation, and — critically — no new URL. Adopting a different string
       for an identical image is precisely what made a download → local
       handoff flash while download → download sat still. */
    const held = sameArtwork(art, track, shown.art, shown.track);
    setArtHeld(held);
    setGhostArt(held ? null : (shown.art || null));
    setPhase('out');

    const swapIn = () => {
      // `held` keeps the URL already on screen and already decoded.
      setShown((s) => ({ track, art: held ? (s.art || art) : art }));
      setSwapKey((k) => k + 1);
      if (!held) setArtKey((k) => k + 1);
      setPhase('in');
      const t2 = setTimeout(() => { setPhase('idle'); setGhostArt(null); }, IN_MS);
      timersRef.current.push(t2);
    };

    const t1 = setTimeout(() => {
      if (held) { swapIn(); return; }
      /* A genuine change still shouldn't paint an empty square. Wait for the
         incoming bitmap to decode before handing it to the compositor — the
         ghost outlives OUT_MS by 280ms, so there's real headroom here — but
         cap the wait, because a cover that never loads must not freeze the
         panel on the previous track's artwork. */
      const warm = warmArt(art);
      if (!warm) { swapIn(); return; }
      let done = false;
      const go = () => { if (!done) { done = true; swapIn(); } };
      warm.then(go, go);
      const t3 = setTimeout(go, 220);
      timersRef.current.push(t3);
    }, OUT_MS);
    timersRef.current.push(t1);
    // `shown` is intentionally omitted — lastKeyRef guards re-entry, and
    // including it would restart the swap mid-flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id, art]);

  useEffect(() => () => { timersRef.current.forEach(clearTimeout); }, []);

  /** Per-line animation. Lines leave in reverse order (artist first) and
   *  return in reading order (title first) — the stage view's stagger.
   *  Exit durations are trimmed per line so the staggered title still lands
   *  before OUT_MS; otherwise its animation is cut mid-flight and snaps. */
  const lineAnim = (line) => {
    if (phase === 'out') {
      return line === 'title'
        ? `sthNpTxtOut 190ms ${EASE_OUT} 45ms both`   // 45 + 190 = 235 ≤ 240
        : `sthNpTxtOut 200ms ${EASE_OUT} 0ms both`;
    }
    if (phase === 'in') return `sthNpTxtIn 460ms ${EASE_IN} ${line === 'title' ? '0ms' : '80ms'} both`;
    return 'none';
  };

  // Elevation on a near-black surface, cast evenly on all four sides.
  //
  // Two constraints, and they pull against each other:
  //  - BLUR bands. The panel composites to ~rgb(15,15,17), leaving ~15 tonal
  //    levels; a blur past ~14px spreads them over more than a pixel each and
  //    you see concentric rings. So blur is capped at 13.
  //  - With no offset, all the reach has to come from SPREAD. But the shadow
  //    rect is expanded by `spread` and only THEN blurred, so a solid,
  //    unblurred ring of width (spread - blur/2) sits hard against the cover
  //    edge. Push spread too far and you get a dark border, not a shadow.
  //
  // spread 7 / blur 13 threads both: 13.5px of reach on every side, a solid
  // ring of just 0.5px (sub-pixel, invisible), and 0.87px per tonal band.
  const artBoxShadow = [
    'inset 0 1px 0 rgba(var(--st-fg-rgb), 0.22)', // lit top edge — reads as raised
    '0 0 0 1px rgba(var(--st-fg-rgb), 0.10)',     // crisp ring, zero blur = cannot band
    '0 0 5px 1px rgba(0,0,0,0.8)',          // tight halo (blur 5  → 0.33px/band)
    '0 0 13px 7px rgba(0,0,0,0.85)',        // main lift  (blur 13 → 0.87px/band)
  ].join(', ');
  const t = shown.track;
  // Seek-bar scrubbing for the fullscreen transport (mirrors the floating bar).
  const dur = t && Number.isFinite(t.duration) && t.duration > 0 ? t.duration : 0;
  const [scrub, setScrub] = useState(null);
  const [showLibrary, setShowLibrary] = useState(false);
  // Mount the synced lyrics only after the side column finishes sliding open,
  // so SyncedLyrics measures line positions at the final width and centres
  // immediately (it doesn't re-measure on resize).
  const [lyricsReady, setLyricsReady] = useState(false);
  useEffect(() => {
    if (!expanded || !showLyrics) { setLyricsReady(false); return undefined; }
    const t = setTimeout(() => setLyricsReady(true), 470);
    return () => clearTimeout(t);
  }, [expanded, showLyrics]);
  const seekTrackRef = useRef(null);
  const seekPct = scrub != null ? scrub * 100 : (dur ? Math.min(100, Math.max(0, (currentTime / dur) * 100)) : 0);
  const fmtT = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60); const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };
  const seekPosFromEvent = (clientX) => {
    const el = seekTrackRef.current; if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  const beginSeekScrub = (e) => {
    if (!onSeek || !dur) return;
    e.stopPropagation(); e.preventDefault();
    setScrub(seekPosFromEvent(e.clientX));
    const move = (ev) => setScrub(seekPosFromEvent(ev.clientX));
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const f = seekPosFromEvent(ev.clientX);
      setScrub(null);
      onSeek(f * dur);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Control buttons, defined once so they can sit in the narrow header or the
  // fullscreen bottom bar.
  const creditsBtn = onToggleCredits && track ? (
    <button type="button" className={`sth-npmute${showCredits ? ' is-on' : ''}`} onClick={onToggleCredits} title={showCredits ? 'Hide credits' : 'Show credits'} aria-label={showCredits ? 'Hide credits' : 'Show credits'} aria-pressed={showCredits}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="6" /><path d="M15.7 13.4L17 22l-5-3-5 3 1.3-8.6" /></svg>
    </button>
  ) : null;
  const lyricsBtn = onToggleLyrics && (lyricsAvailable || expanded) ? (
    <button type="button" className={`sth-npmute${showLyrics ? ' is-on' : ''}`} onClick={onToggleLyrics} title={showLyrics ? 'Hide lyrics' : 'Show lyrics'} aria-label={showLyrics ? 'Hide lyrics' : 'Show lyrics'} aria-pressed={showLyrics}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h11M4 10h9M4 14h11M4 18h7" /></svg>
    </button>
  ) : null;
  /* Landing pad for the cover flight — the relocated cover + song info.
   *
   * Rendered in ONE of two places depending on whether the lyrics column is
   * up, mirroring the overlay: with lyrics it sits at the top of the lyrics
   * column; without, it sits directly above the card in the art column. The
   * old build only had the lyrics-column version, so with lyrics hidden the
   * column was 0px wide and the cover appeared to vanish on open.
   *
   * ALWAYS mounted; only the height animates, on the flight's own curve.
   * Mounting it on open would pop the layout and move the ghost's measured
   * destination mid-flight. The content is absolutely anchored to the slot's
   * TOP so its final position is identical at any slot height — that's what
   * keeps the flight's destination measurement exact while the height is
   * still animating. */
  /* True whenever the command center owns the cover square — while it's open,
     while it's animating out, and for the whole cover flight in either
     direction. EVERY layer inside the square checks this one flag.
     It has to be one flag: the track-change crossfade ghost was checking
     nothing at all, so skipping a track while the card was open painted the
     outgoing artwork behind it for the length of the crossfade. */
  const squareTakenByCard = !!(expanded && (ccOpen || ccExiting || coverInFlight));

  const miniHeaderSlot = (
    <div className="sth-np-minislot" style={{
      height: ccOpen ? NP_MINI_HEADER_H : 0,
      transition: 'height 420ms cubic-bezier(0.3, 0.7, 0.25, 1)',
      overflow: 'hidden', flexShrink: 0, position: 'relative', width: '100%',
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        display: 'flex', alignItems: 'center', gap: 14, minWidth: 0,
        visibility: (ccOpen || ccExiting || coverInFlight) ? 'visible' : 'hidden',
      }}>
        {/* A real <img>, not a CSS background-image.
            This is a big reduction — a ~600px cover into 72px — and Chromium
            downsamples background-image with a single bilinear step, which
            drops most of the source detail and reads as a blurry thumbnail.
            An <img> with intrinsic sizing gets the browser's proper
            multi-step (mipmapped) downscale path instead, so it stays sharp.
            width/height are set as ATTRIBUTES as well as styles so the
            decode happens at the display size rather than full resolution. */}
        <div
          ref={miniCoverRef}
          style={{
            width: 72, height: 72, borderRadius: 12, flexShrink: 0,
            overflow: 'hidden', position: 'relative',
            background: 'rgba(var(--st-fg-rgb), 0.06)',
            boxShadow: `0 0 0 1px rgba(${accent},0.4), inset 0 0 0 1px rgba(var(--st-fg-rgb), 0.22)`,
            visibility: coverInFlight ? 'hidden' : 'visible',
          }}
        >
          {art ? (
            <img
              src={art}
              alt=""
              width={72}
              height={72}
              draggable={false}
              decoding="async"
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          ) : null}
        </div>
        <div style={{ minWidth: 0, textAlign: 'left' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--st-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {t?.title || ''}
          </div>
          <div style={{ fontSize: 12, color: 'rgba(var(--st-sub-rgb), 0.55)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>
            {t?.artist || ''}
          </div>
        </div>
      </div>
    </div>
  );

  // Command center trigger — fullscreen only; the collapsed panel has no
  // room for the card and no cover square to hand over.
  const ccBtn = expanded && onToggleCc ? (
    <button type="button" className={`sth-npmute${ccOpen ? ' is-on' : ''}`} onClick={onToggleCc}
      title={ccOpen ? 'Close command center' : 'Command center'}
      aria-label={ccOpen ? 'Close command center' : 'Command center'} aria-pressed={ccOpen}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35" />
      </svg>
    </button>
  ) : null;
  const bgBtn = onToggleAnimatedBg ? (
    <button type="button" className={`sth-npmute${animatedBg ? ' is-on' : ''}`} onClick={onToggleAnimatedBg} title={animatedBg ? 'Turn off animated background' : 'Turn on animated background'} aria-label="Toggle animated background" aria-pressed={animatedBg}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 0 0 18 4.5 4.5 0 0 1 0-9 4.5 4.5 0 0 0 0-9z" /></svg>
    </button>
  ) : null;
  const volumeCtl = onSetVolume ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <button type="button" className="sth-npmute" onClick={() => onSetVolume(volume > 0 ? 0 : 1)} title={volume > 0 ? 'Mute' : 'Unmute'} aria-label={volume > 0 ? 'Mute' : 'Unmute'}>
        {volume > 0 ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z" />{volume > 0.5 ? <path d="M19.1 4.9a10 10 0 0 1 0 14.2" /> : null}<path d="M15.5 8.5a5 5 0 0 1 0 7" /></svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z" /><path d="M22 9l-6 6M16 9l6 6" /></svg>
        )}
      </button>
      <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => onSetVolume(Number(e.target.value))} className="sth-vol" aria-label="Volume" style={{ width: 62, flexShrink: 0, background: `linear-gradient(to right, rgb(${acc}) 0%, rgb(${acc}) ${volume * 100}%, rgba(var(--st-fg-rgb), 0.14) ${volume * 100}%, rgba(var(--st-fg-rgb), 0.14) 100%)` }} />
    </div>
  ) : null;
  const libraryBtn = onPlayTrack && library.length ? (
    <button type="button" className={`sth-npmute${showLibrary ? ' is-on' : ''}`} onClick={() => setShowLibrary((v) => !v)} title={showLibrary ? 'Hide library' : 'Show library'} aria-label={showLibrary ? 'Hide library' : 'Show library'} aria-pressed={showLibrary}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
    </button>
  ) : null;
  const collapseBtn = onCollapseToBar ? (
    <button type="button" className="sth-npmute" onClick={onCollapseToBar} title="Collapse to a bar" aria-label="Collapse to a floating bar">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="15" width="18" height="5" rx="2" /><path d="M6 9l6-4 6 4" /></svg>
    </button>
  ) : null;
  const fullscreenBtn = onOpenFullscreen ? (
    <button type="button" className={`sth-npmute${expanded ? ' is-on' : ''}`} onClick={onOpenFullscreen} title={expanded ? 'Exit fullscreen' : 'Expand the library'} aria-label={expanded ? 'Exit fullscreen' : 'Expand the library'} aria-pressed={expanded}>
      {expanded ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8h3a2 2 0 0 0 2-2V3M16 3v3a2 2 0 0 0 2 2h3M21 16h-3a2 2 0 0 0-2 2v3M8 21v-3a2 2 0 0 0-2-2H3" /></svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
      )}
    </button>
  ) : null;

  return (
    <div className="sth-libpanel" style={{ animation: `sthPanelIn 0.32s ${EASE_IN} both`, position: 'relative', overflow: 'hidden' }}>
      {/* Optional animated colour field behind the panel content. Sits at the
          back; a scrim over it keeps text and controls legible. */}
      {animatedBg && track ? (
        <>
          <div aria-hidden style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}>
            <AnimatedGradientBg accent={accent} mid={gradMid} wash={gradWash} coverUrl={art} isPlaying={isPlaying} vignette={false} brightness={0.7} />
          </div>
          <div aria-hidden style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none', background: 'linear-gradient(180deg, rgba(10,10,12,0.55) 0%, rgba(10,10,12,0.4) 45%, rgba(10,10,12,0.72) 100%)' }} />
        </>
      ) : null}
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {!expanded ? (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 12px 10px 14px', flexShrink: 0, borderBottom: '1px solid rgba(var(--st-fg-rgb), 0.06)' }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: `rgb(${acc})`, whiteSpace: 'nowrap' }}>Now playing</div>
        <div style={{ flex: 1 }} />
        {creditsBtn}{lyricsBtn}{bgBtn}{volumeCtl}{collapseBtn}{fullscreenBtn}
      </div>
      ) : null}
      {/* Fullscreen bottom transport bar: seek + prev/play/next, with the view
          toggles on the left and volume / exit on the right. */}
      {expanded ? (
      <div className="sth-npfull-bar" style={{ order: 2, flexShrink: 0 }}>
        <div className="sth-npfull-toggles">{ccBtn}{lyricsBtn}{bgBtn}</div>
        <div className="sth-npfull-dock">
          {/* Transport — dock-scale, bare icons (matches the overlay). */}
          <div className="sth-npfull-transport">
            {onToggleShuffle ? (
              <button type="button" className="sth-npt-btn" onClick={onToggleShuffle} title="Shuffle" aria-label="Shuffle" aria-pressed={shuffleOn} style={shuffleOn ? { color: `rgb(${acc})` } : undefined}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></svg>
              </button>
            ) : null}
            {onPrev ? (
              <button type="button" className="sth-npt-btn" onClick={onPrev} title="Previous" aria-label="Previous track"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 4L7 12l10 8" /></svg></button>
            ) : null}
            {onTogglePlay ? (
              <button type="button" className="sth-npt-play" onClick={onTogglePlay} title={isPlaying ? 'Pause' : 'Play'} aria-label={isPlaying ? 'Pause' : 'Play'}>
                {isPlaying
                  ? <svg width="21" height="21" viewBox="0 0 32 32" fill="currentColor"><rect x="10.5" y="7" width="4" height="18" rx="2" /><rect x="17.5" y="7" width="4" height="18" rx="2" /></svg>
                  : <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" style={{ marginLeft: 1 }}><path d="M8 5.6c-1.4-1-3.5 0-3.5 1.7v9.4c0 1.75 2.1 2.75 3.5 1.7l8-5c1.4-.85 1.4-2.65 0-3.5l-8-4.3z" /></svg>}
              </button>
            ) : null}
            {onNext ? (
              <button type="button" className="sth-npt-btn" onClick={onNext} title="Next" aria-label="Next track"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 4l10 8-10 8" /></svg></button>
            ) : null}
            {onToggleRepeat ? (
              <button type="button" className="sth-npt-btn" onClick={onToggleRepeat} title={`Repeat: ${repeat}`} aria-label={`Repeat: ${repeat}`} style={repeat !== 'off' ? { color: `rgb(${acc})` } : undefined}>
                {repeat === 'one' ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3" /><text x="12" y="15" fontSize="8" fill="currentColor" stroke="none" textAnchor="middle" fontWeight="700">1</text></svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3" /></svg>
                )}
              </button>
            ) : null}
          </div>
          {/* Seek — dead-center, narrow. */}
          {onSeek && dur ? (
            <div className="sth-npfull-seek">
              <span className="sth-npfull-time">{fmtT((seekPct / 100) * dur)}</span>
              <div
                className="sth-npfull-track" ref={seekTrackRef} onPointerDown={beginSeekScrub}
                role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round((seekPct / 100) * dur)} tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'ArrowRight') { onSeek(Math.min(dur, currentTime + 5)); } else if (e.key === 'ArrowLeft') { onSeek(Math.max(0, currentTime - 5)); } }}
              >
                <div className="sth-npfull-fill" style={{ width: `${seekPct}%`, background: `rgb(${acc})`, transition: scrub != null ? 'none' : 'width 0.25s linear' }}>
                  <span className="sth-npfull-knob" style={{ background: `rgb(${acc})` }} />
                </div>
              </div>
              <span className="sth-npfull-time">{fmtT(dur)}</span>
            </div>
          ) : <div />}
          {/* Volume — right. */}
          <div className="sth-npfull-vol">{volumeCtl}</div>
        </div>
        <div className="sth-npfull-toggles" style={{ justifyContent: 'flex-end' }}>{collapseBtn}{fullscreenBtn}</div>
      </div>
      ) : null}
      {/* Credits + Up Next dock cards — ported from the overlay. */}
      {expanded ? (
        <div className="sth-npfull-dockrow">
          <div className="sth-npfull-dockwrap">
            <DockCard side="left" label="Credits" open={dockCard === 'credits'} accent={accent} layout="wrap" dockBarH={78}
              meta={creditsState === 'done' && credits?.releaseDate ? `via Genius · ${credits.releaseDate}` : (creditsState === 'done' ? 'via Genius' : null)}
              onToggle={() => setDockCard((c) => (c === 'credits' ? null : 'credits'))}>
              {(creditsState === 'loading' || creditsState === 'idle') ? (
                <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, color: 'rgba(var(--st-sub-rgb), 0.5)' }}>Looking up credits…</div>
              ) : (creditsState === 'error' || !credits) ? (
                <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, color: 'rgba(var(--st-sub-rgb), 0.5)' }}>No credits found for this track.</div>
              ) : (
                <>
                  {credits.primary?.length ? <CreditGroup label="Performed by" names={credits.primary} accent={accent} /> : null}
                  {credits.writers?.length ? <CreditGroup label="Written by" names={credits.writers} accent={accent} /> : null}
                  {credits.producers?.length ? <CreditGroup label="Produced by" names={credits.producers} accent={accent} /> : null}
                  {(credits.performances || []).slice(0, 6).map((p, i) => (
                    <CreditGroup key={`${p.label}-${i}`} label={p.label} names={Array.isArray(p.names) ? p.names : [p.names]} accent={accent} />
                  ))}
                </>
              )}
            </DockCard>
            <DockCard side="right" label={upNext.length ? `Up next · ${upNext.length}` : 'Up next'} open={dockCard === 'queue'} accent={accent} dockBarH={78}
              onToggle={() => setDockCard((c) => (c === 'queue' ? null : 'queue'))}>
              {upNext.length ? upNext.slice(0, 30).map((tk, i) => (
                <div key={`${tk.id}-${i}`} role="button" tabIndex={-1} title={`${tk.title || 'Unknown'} — ${tk.artist || ''}`}
                  onClick={() => onSelectTrack?.(tk)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '3px 8px 3px 4px', borderRadius: 9, cursor: 'pointer', minWidth: 0, transition: 'background 0.13s ease' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(var(--st-fg-rgb), 0.06)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                  <span style={{ width: 16, textAlign: 'right', flexShrink: 0, fontSize: 9.5, color: 'rgba(var(--st-sub-rgb), 0.32)', fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
                  <div style={{ width: 32, height: 32, borderRadius: 7, flexShrink: 0, backgroundColor: 'rgba(var(--st-fg-rgb), 0.06)', backgroundImage: tk.coverArt ? `url("${String(tk.coverArt).replace(/"/g, '%22')}")` : 'none', backgroundSize: 'cover', backgroundPosition: 'center', boxShadow: '0 0 0 1px rgba(var(--st-fg-rgb), 0.08)' }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--st-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tk.title || 'Unknown track'}</div>
                    <div style={{ fontSize: 10, color: 'rgba(var(--st-sub-rgb), 0.45)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tk.artist || ''}</div>
                  </div>
                </div>
              )) : (
                <div style={{ gridRow: '1 / -1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, color: 'rgba(var(--st-sub-rgb), 0.5)', minWidth: 220 }}>Nothing queued after this track.</div>
              )}
              {upNext.length > 30 ? (
                <div style={{ display: 'flex', alignItems: 'center', padding: '3px 8px', fontSize: 10.5, color: 'rgba(var(--st-sub-rgb), 0.4)', whiteSpace: 'nowrap' }}>+{upNext.length - 30} more in queue</div>
              ) : null}
            </DockCard>
          </div>
        </div>
      ) : null}
      {t ? (
        (showCredits && !expanded) ? (
          <NpCreditsView credits={credits} state={creditsState} accent={accent} track={t} />
        ) : (showLyrics && lyricsAvailable && !expanded) ? (
          <NpLyricsView lyricsData={lyricsData} onLyricsSaved={onLyricsSaved} currentTime={currentTime} accent={accent} onSeek={onSeek} track={t} />
        ) : (
        <div className={`sth-np-stage${expanded && showLyrics ? ' has-lyrics' : ''}`} /* `none`, NOT translateY(0). Any non-none transform promotes this subtree
             to its own composited layer, and Chromium rasterises that layer at CSS
             resolution rather than device resolution — on a HiDPI or fractionally
             scaled display every image inside it (cover art, list thumbnails, the
             mini header) comes out visibly soft. Only pay that cost while the
             docked-card shift is actually applied. */
          style={expanded ? { transform: dockCard ? 'translateY(-72px)' : 'none', transition: 'transform 360ms cubic-bezier(0.22, 1, 0.36, 1)' } : undefined}>
        <div className="sth-np-artcol" style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: expanded ? '0' : '26px 22px 22px', justifyContent: 'center' }}>
          {/* The card lives in the cover's footprint, centered on the same
              square, so opening it never shifts the transport below. Flex
              centering rather than translate(-50%): transforms aren't snapped
              to the device-pixel grid and a half-pixel blurs every glyph in
              the card. Only the integer drag offset rides on a transform. */}
          {expanded && (ccOpen || ccExiting) ? (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 6,
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none',
            }}>
              {/* With lyrics hidden there's no lyrics column to host the
                  relocated cover, so it stacks directly above the card —
                  the overlay's !sideLyrics branch. */}
              {!showLyrics ? (
                <div style={{ width: 'min(52vh, 42vw)', pointerEvents: 'auto' }}>
                  {miniHeaderSlot}
                </div>
              ) : null}
              {commandCenter}
            </div>
          ) : null}
          {/* Artwork — incoming and outgoing layers stacked so they overlap. */}
          <div
            role={onTogglePlay && !squareTakenByCard ? 'button' : undefined}
            tabIndex={onTogglePlay && !squareTakenByCard ? 0 : undefined}
            onClick={onTogglePlay && !squareTakenByCard ? onTogglePlay : undefined}
            onKeyDown={onTogglePlay && !squareTakenByCard ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTogglePlay(); } } : undefined}
            title={onTogglePlay ? (isPlaying ? 'Pause' : 'Play') : undefined}
            aria-label={onTogglePlay ? (isPlaying ? 'Pause' : 'Play') : undefined}
            ref={expanded ? bigCoverRef : undefined}
            className={[onTogglePlay ? 'sth-npcover' : '', expanded ? 'sth-np-cover' : ''].filter(Boolean).join(' ') || undefined}
            style={{ position: 'relative', width: expanded ? undefined : '100%', maxWidth: expanded ? undefined : 236, aspectRatio: '1', marginBottom: 22, flexShrink: 0, cursor: onTogglePlay ? 'pointer' : 'default',
              /* Element stays mounted and visible throughout — only the
                 artwork inside it hides (see .sth-np-art below). Unmounting
                 or hiding this would collapse the column and jump the
                 transport beneath it.
                 Deliberately NO background or shadow of its own: an earlier
                 attempt painted a fake "socket" here to stand in for the
                 lifted cover, which just drew a grey rectangle that matched
                 nothing else on the stage. The empty square now shows the
                 real background through it, and the card's own drop shadow
                 does the work of implying depth. */ }}
          >
            {ghostArt && !squareTakenByCard ? (
              <div
                key={`ghost-${swapKey}`}
                aria-hidden
                className="sth-np-ghost"
                style={{
                  position: 'absolute', inset: 0, borderRadius: 16,
                  background: `url("${ghostArt}") center/cover`,
                  boxShadow: artBoxShadow,
                  animation: `sthNpArtOut ${OUT_MS + 280}ms ${EASE_OUT} both`,
                }}
              />
            ) : null}
            <div
              /* artKey, NOT swapKey — see the two-key note above. This element
                 must survive a track change that keeps the same picture, or
                 React tears it down and rebuilds it, and the rebuilt one has
                 to fetch its background-image all over again. */
              key={`art-${artKey}`}
              className="sth-np-art"
              style={{
                position: 'absolute', inset: 0, borderRadius: 16,
                /* INSTANT, and it has to be instant. This is a FLIP handoff:
                   the ghost is a copy of this element that starts exactly on
                   top of it, so the original must vanish in the very frame the
                   ghost appears. Fading it instead leaves both on screen
                   cross-dissolving, which reads as the artwork reloading.
                   No transition here for the same reason — any easing on the
                   way out is a second copy of the image visibly dying. */
                visibility: squareTakenByCard ? 'hidden' : 'visible',
                background: shown.art ? `url("${shown.art}") center/cover` : `rgba(${acc},0.14)`,
                boxShadow: artBoxShadow,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                /* No entrance when the picture is held: there is nothing to
                   introduce, and the scale-from-1.05 would read as the cover
                   twitching between two tracks off the same record. */
                animation: (phase === 'in' && !artHeld) ? `sthNpArtIn 560ms ${EASE_IN} both` : 'none',
              }}
            >
              {!shown.art ? <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="rgba(var(--st-fg-rgb), 0.3)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="18" r="3" /><circle cx="18" cy="16" r="3" /><path d="M11 18V5l10-2v13" /></svg> : null}
            </div>
            {/* Hover affordance for the click-to-play target. Sits above both
                art layers so it survives the cross-dissolve. */}
            {/* Hover play/pause veil — also suppressed while the card owns the
                square, or hovering the card would darken it and float a play
                icon over the list. */}
            {onTogglePlay && !squareTakenByCard ? (
              <div className="sth-npcover-veil" aria-hidden style={{ position: 'absolute', inset: 0, borderRadius: 16, zIndex: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.42)' }}>
                {isPlaying
                  ? <svg width="30" height="30" viewBox="0 0 24 24" fill="#fff"><rect x="6" y="4" width="4" height="16" rx="1.2" /><rect x="14" y="4" width="4" height="16" rx="1.2" /></svg>
                  : <svg width="30" height="30" viewBox="0 0 24 24" fill="#fff" style={{ marginLeft: 3 }}><polygon points="5 3 19 12 5 21" /></svg>}
              </div>
            ) : null}
          </div>

          <div className="sth-np-line" style={{ fontSize: expanded ? 22 : 18, fontWeight: 650, color: 'var(--st-text)', letterSpacing: '-0.01em', maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', animation: lineAnim('title'), willChange: 'transform, opacity', marginTop: expanded ? 24 : 0 }}>
            {t.title}
          </div>
          <div className="sth-np-line" style={{ fontSize: 12.5, color: 'rgba(var(--st-sub-rgb), 0.55)', marginTop: 5, maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', animation: lineAnim('artist'), willChange: 'transform, opacity' }}>
            {t.artist}{t.album ? ` · ${t.album}` : ''}
          </div>

          {/* Badge + prev/next below the cover — only in the narrow panel.
              In fullscreen the transport flanks the artwork and the badge is
              dropped for a cleaner, stage-like view. */}
          {!expanded ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 14, minHeight: 26 }}>
            {onPrev ? (
              <button type="button" className="sth-npbtn" onClick={onPrev} title="Previous" aria-label="Previous track">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zM20 6v12l-9-6z" /></svg>
              </button>
            ) : null}
            {isPlaying ? (
              <div key={`eq-${swapKey}`} className="sth-np-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 600, color: `rgb(${acc})`, animation: phase === 'in' ? `sthNpMetaIn 420ms ${EASE_IN} 160ms both` : 'none' }}>
                <InlineEq />
                Playing
              </div>
            ) : (
              <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(var(--st-sub-rgb), 0.32)' }}>Paused</div>
            )}
            {onNext ? (
              <button type="button" className="sth-npbtn" onClick={onNext} title="Next" aria-label="Next track">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM4 6v12l9-6z" /></svg>
              </button>
            ) : null}
          </div>
          ) : null}
        </div>
        {/* Lyrics column — rendered in expanded mode whenever lyrics exist, so
            the width/opacity can animate; the .has-lyrics class on the stage
            slides the artwork over and reveals this beside it. */}
        {expanded ? (
          <div className="sth-np-lyriccol">
            {showLyrics ? miniHeaderSlot : null}
            {showLyrics && lyricsReady ? (
              <div className="sth-np-lyricbody" style={{ minHeight: 0, display: 'flex' }}>
                <NpLyricsView lyricsData={lyricsData} onLyricsSaved={onLyricsSaved} currentTime={currentTime} accent={accent} onSeek={onSeek} fontSize={20} track={t}
                  selection={lyricSelection} onSelectStart={onLyricSelectStart} onSelectLine={onLyricSelectLine}
                  onBrowseLyrics={onBrowseLyrics} />
              </div>
            ) : null}
          </div>
        ) : null}
        </div>
        )
      ) : (
        <div className="sth-libscroll" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 30, color: 'rgba(var(--st-sub-rgb), 0.4)', animation: `sthNpTxtIn 420ms ${EASE_IN} both` }}>
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="rgba(var(--st-fg-rgb), 0.28)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12 }}><circle cx="8" cy="18" r="3" /><circle cx="18" cy="16" r="3" /><path d="M11 18V5l10-2v13" /></svg>
          <div style={{ fontSize: 12.5, color: 'rgba(var(--st-sub-rgb), 0.5)' }}>Nothing playing</div>
          <div style={{ fontSize: 11, color: 'rgba(var(--st-sub-rgb), 0.35)', marginTop: 4 }}>Pick a track to start listening.</div>
        </div>
      )}
      </div>
    </div>
  );
}

/** Right-hand detail pane shared by the Albums / Artists / Songs two-pane
 *  views. Header (art + title + play/shuffle/remove) then arbitrary children
 *  (a track list or a nested album grid). */
function LibDetailPane({ onBack, art, round = false, eyebrow, title, meta, accent, onPlay, onShuffle, removeLabel, removeArmed, onRemove, children }) {
  const acc = readableAccent(accent);
  return (
    <div className="sth-libpanel" style={{ animation: 'sthPanelIn 0.32s cubic-bezier(0.22,0.9,0.3,1) both' }}>
      <div style={{ padding: '16px 20px 14px', flexShrink: 0 }}>
        <button type="button" onClick={onBack} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent', cursor: 'pointer', color: 'rgba(var(--st-sub-rgb), 0.55)', fontSize: 12, fontWeight: 600, padding: '0 0 12px' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#fff'; }} onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(var(--st-fg-rgb), 0.55)'; }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          Now playing
        </button>
        <div style={{ display: 'flex', gap: 18, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{
            width: 120, height: 120, borderRadius: round ? '50%' : 14, flexShrink: 0,
            background: art ? `url("${art}") center/cover` : `rgba(${acc},0.14)`,
            boxShadow: 'inset 0 1px 0 rgba(var(--st-fg-rgb), 0.20), 0 0 0 1px rgba(var(--st-fg-rgb), 0.10), 0 0 5px 1px rgba(0,0,0,0.8), 0 0 13px 7px rgba(0,0,0,0.85)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {!art ? <span style={{ fontSize: 34, fontWeight: 700, color: `rgb(${acc})`, textTransform: 'uppercase' }}>{(title || '?').trim().charAt(0)}</span> : null}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: `rgb(${acc})` }}>{eyebrow}</div>
            <div style={{ fontSize: 'clamp(19px, 1.9vw, 26px)', fontWeight: 650, letterSpacing: '-0.015em', color: 'var(--st-text)', lineHeight: 1.12, marginTop: 7 }}>{title}</div>
            <div style={{ fontSize: 12, color: 'rgba(var(--st-sub-rgb), 0.6)', marginTop: 7 }}>{meta}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <button type="button" className="sth-pill" onClick={onPlay} style={{ background: `rgb(${acc})`, color: accentTextColor(acc), padding: '8px 18px' }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21" /></svg>
                Play
              </button>
              {onShuffle ? (
                <button type="button" className="sth-pill" onClick={onShuffle} style={{ background: 'rgba(var(--st-fg-rgb), 0.08)', color: 'var(--st-text)', padding: '8px 16px' }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></svg>
                  Shuffle
                </button>
              ) : null}
              {removeLabel ? (
                <button type="button" onClick={onRemove} style={{ cursor: 'pointer', padding: '8px 15px', borderRadius: 11, border: removeArmed ? '1px solid rgba(255,90,90,0.55)' : '1px solid rgba(var(--st-fg-rgb), 0.14)', background: removeArmed ? 'rgba(255,90,90,0.18)' : 'rgba(var(--st-fg-rgb), 0.05)', color: removeArmed ? 'rgb(255,140,140)' : 'rgba(255,150,150,0.85)', fontSize: 12, fontWeight: 700, transition: 'all 0.18s ease' }}>
                  {removeLabel}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      <div className="sth-libscroll sth-vscroll" style={{ padding: '4px 8px 10px', borderTop: '1px solid rgba(var(--st-fg-rgb), 0.06)' }}>
        {children}
      </div>
    </div>
  );
}

/** Compact numbered track row for the detail pane. */
function DetailTrackRow({ n, track, active = false, playing = false, highlight = false, accent, showArtist = false, onPlay, onMore, onEdit }) {
  const acc = readableAccent(accent);
  return (
    <div
      role="button"
      tabIndex={0}
      className={`sth-drow${active ? ' is-active' : ''}`}
      onClick={onPlay}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPlay?.(); } }}
      onContextMenu={onMore || undefined}
      style={highlight && !active ? { background: 'rgba(var(--st-fg-rgb), 0.035)' } : undefined}
    >
      <span style={{ textAlign: 'right', fontSize: 11.5, color: active ? `rgb(${acc})` : 'rgba(var(--st-fg-rgb), 0.35)', fontVariantNumeric: 'tabular-nums' }}
        {...hoverPreload(track)}>
        {playing ? <InlineEq /> : (
          <>
            <span className="sth-dnum">{n}</span>
            <svg className="sth-dplay" width="11" height="11" viewBox="0 0 24 24" fill="#fff"><polygon points="5 3 19 12 5 21" /></svg>
          </>
        )}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: active ? '#fff' : 'rgba(var(--st-fg-rgb), 0.86)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.title}</span>
          {track.explicit ? <span className="sth-explicit">E</span> : null}
        </div>
        {showArtist && track.artist ? (
          <div style={{ fontSize: 10.5, color: 'rgba(var(--st-sub-rgb), 0.42)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.artist}</div>
        ) : null}
      </div>
      <span style={{ fontSize: 11, color: 'rgba(var(--st-sub-rgb), 0.34)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{fmtDur(track.duration)}</span>
      <div className="sth-drow-more">
        {onEdit ? (
          <button type="button" className="sth-iconbtn" title="Edit track info" onClick={onEdit}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>
          </button>
        ) : null}
        {onMore ? (
          <button type="button" className="sth-iconbtn" title="More" onClick={onMore}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
          </button>
        ) : null}
      </div>
    </div>
  );
}

function LibMenu({ value, options, onPick, accent, label, align = 'left', compact = false }) {
  const [open, setOpen] = useState(false);
  const acc = readableAccent(accent);
  const current = options.find(([v]) => v === value)?.[1] || value;
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen((v) => !v)} style={{
        display: 'inline-flex', alignItems: 'center', gap: compact ? 6 : 8,
        padding: compact ? '0 11px' : '8px 12px', height: compact ? 30 : undefined, borderRadius: compact ? 9 : 10,
        border: '1px solid rgba(var(--st-fg-rgb), 0.12)', background: 'rgba(var(--st-fg-rgb), 0.05)', cursor: 'pointer', color: 'var(--st-text)',
        fontSize: compact ? 12 : 12.5, fontWeight: 600, whiteSpace: 'nowrap',
      }}>
        {label ? <span style={{ color: 'rgba(var(--st-sub-rgb), 0.4)', fontWeight: 500 }}>{label}</span> : null}
        {current}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(var(--st-fg-rgb), 0.5)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }}><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open ? (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{ position: 'absolute', top: '100%', [align]: 0, marginTop: 6, zIndex: 41, minWidth: 168, padding: 5, borderRadius: 12, background: 'rgba(22,22,24,0.97)', border: '1px solid rgba(var(--st-fg-rgb), 0.12)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', boxShadow: '0 20px 50px rgba(0,0,0,0.5)' }}>
            {options.map(([v, lbl]) => (
              <button key={v} type="button" onClick={() => { onPick(v); setOpen(false); }} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 10, padding: '8px 10px', borderRadius: 8, border: 'none', cursor: 'pointer',
                background: value === v ? `rgba(${acc}, 0.16)` : 'transparent', color: value === v ? '#fff' : 'rgba(var(--st-fg-rgb), 0.75)', fontSize: 12.5, fontWeight: 600, textAlign: 'left',
              }}
                onMouseEnter={(e) => { if (value !== v) e.currentTarget.style.background = 'rgba(var(--st-fg-rgb), 0.06)'; }}
                onMouseLeave={(e) => { if (value !== v) e.currentTarget.style.background = 'transparent'; }}
              >
                {lbl}
                {value === v ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={`rgb(${acc})`} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Album/track tile for the library overview (reuses the album-grid look). */
/** Underlined tab bar (Overview / Tracks / Artists / Albums / Genres). */
/* ---------------------------------------------------------------------------
 *  Listening calendar
 *
 *  One square per day, Mon–Sun down each column, six months across. Density
 *  is the accent's alpha rather than a colour ramp, so it inherits whatever
 *  the current cover theme is instead of introducing a second palette.
 * ------------------------------------------------------------------------- */
function StatsHeatmap({ heat, accent }) {
  const { weeks, lead, daysInYear, jan1Key, todayKey, max, secOn, playsOn, dayMs } = heat;
  const cols = [];
  for (let w = 0; w < weeks; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const offset = w * 7 + d - lead;          // day-of-year index, negative in the pad
      const k = jan1Key + offset;
      // Padding before 1 Jan, days after 31 Dec, and days still to come all
      // hold the grid's shape without drawing anything.
      if (offset < 0 || offset >= daysInYear || k > todayKey) {
        days.push(<div key={d} className="sth-hm-cell" style={{ visibility: 'hidden' }} />);
        continue;
      }
      const sec = secOn(k);
      const plays = playsOn(k);
      const label = new Date(dayMs(k)).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      days.push(
        <div
          key={d}
          className="sth-hm-cell"
          title={sec > 0 ? `${label} — ${fmtSpan(sec)}, ${plays} ${plays === 1 ? 'song' : 'songs'}` : `${label} — nothing played`}
          style={{ background: sec > 0 ? `rgba(${accent}, ${(0.2 + (sec / max) * 0.8).toFixed(3)})` : 'rgba(var(--st-fg-rgb), 0.05)' }}
        />,
      );
    }
    cols.push(<div key={w} className="sth-hm-col">{days}</div>);
  }

  /* A month label goes under the first column containing that month's 1st. */
  const months = [];
  for (let m = 0; m < 12; m++) {
    const first = new Date(heat.year, m, 1);
    const offset = Math.round((new Date(heat.year, m, 1).setHours(0, 0, 0, 0) - new Date(heat.year, 0, 1).setHours(0, 0, 0, 0)) / 86400000);
    const w = Math.floor((offset + lead) / 7);
    if (w >= weeks) break;
    months.push({ w, name: first.toLocaleDateString(undefined, { month: 'short' }) });
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 9 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingTop: 1, fontSize: 9.5, fontWeight: 700, color: 'rgba(var(--st-fg-rgb), 0.28)' }}>
          {['M', '', 'W', '', 'F', '', 'S'].map((d, i) => (
            <span key={i} style={{ height: 13, lineHeight: '13px' }}>{d}</span>
          ))}
        </div>
        <div className="sth-hm">{cols}</div>
      </div>
      {/* Absolutely placed against the calendar's own left edge: 22px clears
          the weekday gutter, then 16px per week column (13px cell + 3px gap).
          Laying them out in flow can't work — a label has to sit under the
          column where its month starts, not under an equal share. */}
      {months.map((m, i) => (
        <span key={i} style={{
          position: 'absolute', bottom: 0, left: 22 + m.w * 16,
          fontSize: 10.5, fontWeight: 600, color: 'rgba(var(--st-fg-rgb), 0.3)',
        }}>{m.name}</span>
      ))}
    </>
  );
}

/* ---------------------------------------------------------------------------
 *  Streak tiers
 *
 *  The one place on the stats page that does NOT use the cover-derived accent.
 *  A streak is a semantic signal, not a themed surface — the same way lossless
 *  is always green and a queued peer is always amber elsewhere in the app —
 *  and the whole point is that the colour tells you something changed. If it
 *  tracked the current album's artwork, "my streak went orange" would mean
 *  nothing.
 *
 *  The ramp is ember → flame → hot, and it's deliberately coarse: six tiers
 *  across a hundred days, so reaching a new one stays rare enough to register.
 * ------------------------------------------------------------------------- */
const STREAK_TIERS = [
  { min: 0,   rgb: '150, 150, 158', label: '' },                 // nothing going
  { min: 1,   rgb: '232, 176, 112', label: 'Started' },          // warm neutral
  { min: 3,   rgb: '245, 176, 70',  label: 'Warming up' },
  { min: 7,   rgb: '250, 140, 66',  label: 'A week straight' },
  { min: 14,  rgb: '244, 106, 74',  label: 'Two weeks' },
  { min: 30,  rgb: '236, 84, 92',   label: 'A month straight' },
  { min: 100, rgb: '186, 132, 255', label: 'Hundred days' },     // past hot, into rare
];
function streakTier(days) {
  const n = Number(days) || 0;
  let i = 0;
  for (let k = 0; k < STREAK_TIERS.length; k++) if (n >= STREAK_TIERS[k].min) i = k;
  return { ...STREAK_TIERS[i], index: i };
}

/**
 * One leaderboard line, built to the mockup: rank, art, name (+ artist for a
 * track), listening time, then a proportional bar with the play count.
 *
 * The old page reused the big stats rows here, which is why it didn't match —
 * those are 48px tall, show plays but no time, and carry a full-bleed accent
 * wash behind each row. At ten rows that's most of the page for one panel.
 * This is a 38px grid: same columns for tracks and artists so switching the
 * tab doesn't reflow anything, and the bar is a fixed 34px chip on the right
 * rather than a background, so long titles can't collide with it.
 */
function LeaderRow({ i, cover, round = false, title, sub, sec, plays, max = 1, accent }) {
  const pct = Math.min(1, (plays || 0) / (max || 1));
  return (
    <div className="sth-lb-row">
      <div style={{
        textAlign: 'center', fontSize: 11, fontVariantNumeric: 'tabular-nums',
        color: i === 0 ? `rgb(${accent})` : 'rgba(var(--st-fg-rgb), 0.32)', fontWeight: i === 0 ? 800 : 600,
      }}>{i + 1}</div>
      {cover ? (
        <div style={{
          width: 30, height: 30, borderRadius: round ? '50%' : 7,
          background: `url("${cover}") center/cover`, boxShadow: 'inset 0 0 0 1px rgba(var(--st-fg-rgb), 0.1)',
        }} />
      ) : (
        <div style={{
          width: 30, height: 30, borderRadius: round ? '50%' : 7, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `rgba(${accent}, 0.14)`, color: `rgb(${accent})`, fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
        }}>{(title || '?').trim().charAt(0)}</div>
      )}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--st-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
        {sub ? <div style={{ fontSize: 10.5, color: 'rgba(var(--st-sub-rgb), 0.45)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div> : null}
      </div>
      <div style={{ fontSize: 11.5, color: 'rgba(var(--st-sub-rgb), 0.5)', fontVariantNumeric: 'tabular-nums' }}>{fmtSpan(sec)}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
        <div style={{ width: 34, height: 4, borderRadius: 999, background: 'rgba(var(--st-fg-rgb), 0.08)', overflow: 'hidden', flexShrink: 0 }}>
          <div style={{ width: `${pct * 100}%`, height: '100%', borderRadius: 999, background: `rgb(${accent})` }} />
        </div>
        <span style={{ fontSize: 11.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums', minWidth: 18, textAlign: 'right', color: 'rgba(var(--st-text-rgb), 0.8)' }}>{plays}</span>
      </div>
    </div>
  );
}

/** Headline habit figure — streak, this week, days listened. */
function StatStreakCard({ path, label, value, sub, accent, tone, flame = false, celebrate = false, countTo = null, onBadgeClick, footer }) {
  const rgb = tone || accent;
  const shown = useCountUp(countTo);
  const Badge = onBadgeClick ? 'button' : 'div';
  return (
    <div className="sth-card" style={{ padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Badge
          type={onBadgeClick ? 'button' : undefined}
          onClick={onBadgeClick}
          /* The only affordance for the streak tools. Unlabelled on purpose —
             it's a testing hatch, not a feature, and it shouldn't read as one
             of the card's controls. */
          title={onBadgeClick ? 'Streak tools' : undefined}
          className={`sth-streak-badge${flame ? ' is-flame' : ''}${celebrate ? ' is-new' : ''}`}
          style={{ '--tone': rgb, border: 'none', padding: 0, cursor: onBadgeClick ? 'pointer' : 'default' }}
        >
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>
        </Badge>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(var(--st-fg-rgb), 0.34)' }}>{label}</div>
          <div style={{ fontSize: 21, fontWeight: 750, letterSpacing: '-0.02em', color: 'var(--st-text)', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
            {countTo != null ? value.replace(String(countTo), String(shown)) : value}
          </div>
          {sub ? <div style={{ fontSize: 10.5, color: 'rgba(var(--st-sub-rgb), 0.35)', marginTop: 3 }}>{sub}</div> : null}
        </div>
      </div>
      {footer}
    </div>
  );
}

/**
 * Counts up to `target` over ~700ms with an ease-out, so the streak number
 * lands rather than just appearing. Returns the target immediately when the
 * value is null, when it's small enough that counting would look like a
 * stutter, or when the user has asked for reduced motion.
 */
function useCountUp(target, ms = 700) {
  const to = Number(target) || 0;
  const reduce = typeof window !== 'undefined' && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const skip = target == null || reduce || to <= 1;
  const [n, setN] = useState(skip ? to : 0);
  useEffect(() => {
    if (skip) { setN(to); return undefined; }
    let raf = 0;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      // easeOutCubic — quick out of the gate, settles softly on the number.
      setN(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, ms, skip]);
  return n;
}

/** Compact segmented picker — the leaderboard's category switch. */
function SegPick({ options, value, onPick }) {
  return (
    <div style={{ display: 'flex', gap: 2, padding: 3, borderRadius: 9, background: 'rgba(var(--st-fg-rgb), 0.05)', border: '1px solid rgba(var(--st-fg-rgb), 0.1)' }}>
      {options.map(([id, lbl]) => (
        <button key={id} type="button" onClick={() => onPick(id)} className={`sth-seg${value === id ? ' on' : ''}`} style={{ fontSize: 10.5, padding: '5px 10px' }}>{lbl}</button>
      ))}
    </div>
  );
}

function StatTabs({ tabs, active, onPick, accent }) {
  return (
    <div style={{ display: 'flex', gap: 22, borderBottom: '1px solid rgba(var(--st-fg-rgb), 0.08)', marginBottom: 22 }}>
      {tabs.map(([id, label]) => {
        const on = active === id;
        return (
          <button key={id} type="button" onClick={() => onPick(id)} style={{
            position: 'relative', border: 'none', background: 'transparent', cursor: 'pointer', padding: '4px 0 12px',
            color: on ? '#fff' : 'rgba(var(--st-fg-rgb), 0.5)', fontSize: 13, fontWeight: on ? 700 : 600, transition: 'color 0.15s ease',
          }}
            onMouseEnter={(e) => { if (!on) e.currentTarget.style.color = 'rgba(var(--st-fg-rgb), 0.8)'; }}
            onMouseLeave={(e) => { if (!on) e.currentTarget.style.color = 'rgba(var(--st-fg-rgb), 0.5)'; }}
          >
            {label}
            {on ? <span style={{ position: 'absolute', left: 0, right: 0, bottom: -1, height: 2, borderRadius: 2, background: `rgb(${accent})` }} /> : null}
          </button>
        );
      })}
    </div>
  );
}

/** By Day / By Week granularity toggle. */
function GranPill({ gran, onPick, accent }) {
  return (
    <div style={{ display: 'flex', gap: 2, padding: 3, borderRadius: 9, background: 'rgba(var(--st-fg-rgb), 0.05)', border: '1px solid rgba(var(--st-fg-rgb), 0.1)' }}>
      {[['day', 'By Day'], ['week', 'By Week']].map(([id, lbl]) => (
        <button key={id} type="button" onClick={() => onPick(id)} className={`sth-seg${gran === id ? ' on' : ''}`} style={{ fontSize: 10.5, padding: '5px 10px' }}>{lbl}</button>
      ))}
    </div>
  );
}

/** Panel header with an optional "More" link. */
function StatPanelHead({ title, onMore }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
      <div style={{ fontSize: 13.5, fontWeight: 650, color: 'var(--st-text)' }}>{title}</div>
      {onMore ? (
        <button type="button" onClick={onMore} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'rgba(var(--st-sub-rgb), 0.5)', fontSize: 11.5, fontWeight: 600 }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#fff'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(var(--st-fg-rgb), 0.5)'; }}
        >More ›</button>
      ) : null}
    </div>
  );
}

/** A y-axis (top, step) giving 4 clean ticks at or above maxHours. */
function niceAxis(maxHours) {
  const steps = [0.25, 0.5, 1, 2, 3, 5, 10, 25, 50, 100];
  for (const s of steps) if (s * 4 >= maxHours) return { top: s * 4, step: s };
  const s = Math.ceil(maxHours / 4);
  return { top: s * 4, step: s };
}

/** Listening-time bar chart with an hours y-axis and a dated x-axis. */
function StatsBarChart({ data = [], accent, height = 196 }) {
  const maxSec = Math.max(1, ...data.map((d) => d.sec));
  const axis = niceAxis(maxSec / 3600);
  const topH = axis.top;
  const useMin = axis.step < 1; // sub-hour steps → label the whole axis in minutes
  const ticks = [0, 1, 2, 3, 4].map((i) => (topH * (4 - i)) / 4); // top → bottom
  const n = data.length;
  const tickEvery = Math.max(1, Math.round(n / 5));
  const gap = n > 45 ? 1 : 2;
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, height }}>
        <div style={{ position: 'relative', width: 30, flexShrink: 0 }}>
          {ticks.map((val, i) => (
            <div key={i} style={{ position: 'absolute', right: 0, top: `${(i / 4) * 100}%`, transform: 'translateY(-50%)', fontSize: 9.5, color: 'rgba(var(--st-sub-rgb), 0.35)', fontVariantNumeric: 'tabular-nums' }}>
              {useMin ? `${Math.round(val * 60)}m` : `${Math.round(val)}h`}
            </div>
          ))}
        </div>
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          {ticks.map((_, i) => (
            <div key={i} aria-hidden style={{ position: 'absolute', left: 0, right: 0, top: `${(i / 4) * 100}%`, borderTop: '1px solid rgba(var(--st-fg-rgb), 0.05)' }} />
          ))}
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', gap }}>
            {data.map((d, i) => {
              const h = (d.sec / (topH * 3600)) * 100;
              return (
                <div key={i} title={`${d.label} — ${fmtSpan(d.sec)}`} style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', alignItems: 'flex-end' }}>
                  <div style={{ width: '100%', height: `${Math.max(d.sec ? 1.5 : 0, h)}%`, borderRadius: '3px 3px 0 0', background: d.sec ? `rgb(${accent})` : 'transparent', transition: 'height 0.3s ease' }} />
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap, marginLeft: 38, marginTop: 6 }}>
        {data.map((d, i) => (
          <div key={i} style={{ flex: 1, minWidth: 0, fontSize: 9.5, color: 'rgba(var(--st-sub-rgb), 0.35)', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden' }}>
            {i % tickEvery === 0 ? d.label : ''}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Time-of-day donut: gradient ring by share + persona in the hole + legend. */
function TimeOfDayDonut({ parts = [], persona, personaDesc, personaKey }) {
  const order = ['morning', 'afternoon', 'evening', 'night'];
  const byKey = Object.fromEntries(parts.map((p) => [p.key, p]));
  // Segment / legend / persona colours by time of day — warm for day, cool
  // for night. The ring uses the SAME colours as the legend so each wedge shows
  // when you listened.
  const todColor = { morning: '240,168,104', afternoon: '245,198,78', evening: '181,123,224', night: '124,134,232' };
  // Ring: one arc per window, coloured to match its legend swatch and sized by
  // that window's share of plays. Each arc keeps a solid core of its colour and
  // cross-fades to its neighbour only near the boundary (seam included), so it
  // reads as a smooth wheel without muddy full-arc blends between far-apart hues.
  const ring = (() => {
    const lerp = (c1, c2, t) => c1.split(',').map((v, i) => Math.round(+v + (+c2.split(',')[i] - +v) * t)).join(',');
    let a = 0;
    const segs = [];
    for (const k of order) {
      const p = byKey[k]?.pct || 0;
      if (p > 0) segs.push({ color: todColor[k], start: a * 360, end: (a + p) * 360 });
      a += p;
    }
    if (!segs.length) return 'conic-gradient(rgba(var(--st-fg-rgb), 0.08) 0deg 360deg)';
    if (segs.length === 1) return `conic-gradient(rgb(${segs[0].color}) 0deg 360deg)`;
    const minLen = Math.min(...segs.map((s) => s.end - s.start));
    const bw = Math.min(15, minLen * 0.45); // half-width of each cross-fade
    const first = segs[0];
    const last = segs[segs.length - 1];
    const seam = lerp(last.color, first.color, 0.5); // colour where night meets morning at 0°/360°
    const stops = [`rgb(${seam}) 0deg`];
    for (const s of segs) {
      stops.push(`rgb(${s.color}) ${(s.start + bw).toFixed(1)}deg`);
      stops.push(`rgb(${s.color}) ${(s.end - bw).toFixed(1)}deg`);
    }
    stops.push(`rgb(${seam}) 360deg`);
    return `conic-gradient(from 0deg, ${stops.join(', ')})`;
  })();
  // Distinct icon per time of day: sunrise / full sun / crescent moon / stars.
  const icons = {
    morning: <><path d="M17 17a5 5 0 0 0-10 0" /><line x1="12" y1="2" x2="12" y2="6" /><line x1="4.5" y1="9.5" x2="6" y2="11" /><line x1="19.5" y1="9.5" x2="18" y2="11" /><line x1="2" y1="17" x2="22" y2="17" /></>,
    afternoon: <><circle cx="12" cy="12" r="4.2" /><path d="M12 2v2.4M12 19.6V22M4.2 12H1.8M22.2 12H19.8M5.6 5.6 4 4M20 20l-1.6-1.6M18.4 5.6 20 4M4 20l1.6-1.6" /></>,
    evening: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
    night: <><path d="M10 4 L11.1 7.4 L14.5 8.5 L11.1 9.6 L10 13 L8.9 9.6 L5.5 8.5 L8.9 7.4 Z" /><path d="M17.5 12 L18.2 14.3 L20.5 15 L18.2 15.7 L17.5 18 L16.8 15.7 L14.5 15 L16.8 14.3 Z" /></>,
  };
  const iconFor = (key) => icons[key] || icons.afternoon;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 2px' }}>
        <div style={{ position: 'relative', width: 172, height: 172 }}>
          <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: ring }} />
          <div style={{ position: 'absolute', inset: 17, borderRadius: '50%', background: '#141416', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 10 }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={`rgb(${todColor[personaKey] || '201,190,245'})`} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{iconFor(personaKey)}</svg>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--st-text)', marginTop: 6 }}>{persona}</div>
            <div style={{ fontSize: 9.5, color: 'rgba(var(--st-sub-rgb), 0.5)', marginTop: 3, lineHeight: 1.35, maxWidth: 108 }}>{personaDesc}</div>
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginTop: 12 }}>
        {parts.map((p) => (
          <div key={p.key} style={{ textAlign: 'center', minWidth: 0 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={`rgb(${todColor[p.key] || '160,160,160'})`} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', margin: '0 auto' }}>{iconFor(p.key)}</svg>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--st-text)', marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>{Math.round(p.pct * 100)}%</div>
            <div style={{ fontSize: 10, color: 'rgba(var(--st-sub-rgb), 0.6)' }}>{p.label}</div>
            <div style={{ fontSize: 8.5, color: 'rgba(var(--st-sub-rgb), 0.35)', whiteSpace: 'nowrap' }}>{p.range}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Top-artist row: rank, circular art (or monogram), name, listening time. */
function ArtistStatRow({ i, a, accent, full = false, max = 1 }) {
  const pct = full ? Math.min(1, a.sec / max) : 0;
  return (
    <div style={{ position: 'relative', borderTop: i ? '1px solid rgba(var(--st-fg-rgb), 0.05)' : 'none' }}>
      {full ? <div aria-hidden style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct * 100}%`, background: `rgba(${accent}, 0.08)`, pointerEvents: 'none' }} /> : null}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 11, padding: full ? '8px 14px' : '7px 2px' }}>
        <span style={{ width: 15, textAlign: 'center', flexShrink: 0, fontSize: 11, color: i === 0 ? `rgb(${accent})` : 'rgba(var(--st-fg-rgb), 0.35)', fontWeight: i === 0 ? 800 : 600, fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
        {a.cover ? (
          <div style={{ width: 30, height: 30, borderRadius: '50%', flexShrink: 0, background: `url("${a.cover}") center/cover`, boxShadow: '0 0 0 1px rgba(var(--st-fg-rgb), 0.12)' }} />
        ) : (
          <div style={{ width: 30, height: 30, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `rgba(${accent}, 0.16)`, border: `1px solid rgba(${accent}, 0.3)`, color: `rgb(${readableAccent(accent)})`, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>{(a.name || '?').trim().charAt(0)}</div>
        )}
        <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--st-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</div>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'rgba(var(--st-sub-rgb), 0.55)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{fmtSpan(a.sec)}</div>
      </div>
    </div>
  );
}

/** Top-track row: rank, square art, title/artist, play count. */
function TrackStatRow({ i, row, cover, accent, full = false, max = 1 }) {
  const t = row.track;
  const pct = full ? Math.min(1, row.plays / max) : 0;
  return (
    <div style={{ position: 'relative', borderTop: i ? '1px solid rgba(var(--st-fg-rgb), 0.05)' : 'none' }}>
      {full ? <div aria-hidden style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct * 100}%`, background: `rgba(${accent}, 0.08)`, pointerEvents: 'none' }} /> : null}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 11, padding: full ? '8px 14px' : '7px 2px' }}>
        <span style={{ width: 15, textAlign: 'center', flexShrink: 0, fontSize: 11, color: i === 0 ? `rgb(${accent})` : 'rgba(var(--st-fg-rgb), 0.35)', fontWeight: i === 0 ? 800 : 600, fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
        <div style={{ width: 32, height: 32, borderRadius: 7, flexShrink: 0, background: cover ? `url("${cover}") center/cover` : 'rgba(var(--st-fg-rgb), 0.06)', boxShadow: '0 0 0 1px rgba(var(--st-fg-rgb), 0.08)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--st-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t?.title || 'Removed track'}</div>
          <div style={{ fontSize: 10.5, color: 'rgba(var(--st-sub-rgb), 0.45)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t?.artist || '—'}</div>
        </div>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: 'rgba(var(--st-text-rgb), 0.75)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{row.plays}</div>
      </div>
    </div>
  );
}

/** Top-album row (albums tab): rank, art, name/artist, listening time. */
function AlbumStatRow({ i, al, max = 1, accent }) {
  const pct = Math.min(1, al.sec / max);
  return (
    <div style={{ position: 'relative', borderTop: i ? '1px solid rgba(var(--st-fg-rgb), 0.05)' : 'none' }}>
      <div aria-hidden style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct * 100}%`, background: `rgba(${accent}, 0.08)`, pointerEvents: 'none' }} />
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 11, padding: '8px 14px' }}>
        <span style={{ width: 15, textAlign: 'center', flexShrink: 0, fontSize: 11, color: i === 0 ? `rgb(${accent})` : 'rgba(var(--st-fg-rgb), 0.35)', fontWeight: i === 0 ? 800 : 600, fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
        <div style={{ width: 34, height: 34, borderRadius: 7, flexShrink: 0, background: al.cover ? `url("${al.cover}") center/cover` : 'rgba(var(--st-fg-rgb), 0.06)', boxShadow: '0 0 0 1px rgba(var(--st-fg-rgb), 0.08)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--st-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{al.name}</div>
          <div style={{ fontSize: 10.5, color: 'rgba(var(--st-sub-rgb), 0.45)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{al.artist}</div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'rgba(var(--st-sub-rgb), 0.6)', fontVariantNumeric: 'tabular-nums' }}>{fmtSpan(al.sec)}</div>
          <div style={{ fontSize: 9.5, color: 'rgba(var(--st-sub-rgb), 0.35)', fontVariantNumeric: 'tabular-nums' }}>{al.plays} {al.plays === 1 ? 'play' : 'plays'}</div>
        </div>
      </div>
    </div>
  );
}

/** Top-genre row: rank, name, proportion bar, listening time. */
function GenreStatRow({ i, g, max = 1, accent, full = false, divider = true }) {
  const pct = Math.min(1, g.sec / max);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: full ? '9px 14px' : '7px 2px', borderTop: (i && divider) ? '1px solid rgba(var(--st-fg-rgb), 0.05)' : 'none' }}>
      <span style={{ width: 14, textAlign: 'center', flexShrink: 0, fontSize: 11, color: i === 0 ? `rgb(${accent})` : 'rgba(var(--st-fg-rgb), 0.35)', fontWeight: i === 0 ? 800 : 600, fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
      <div style={{ width: 112, flexShrink: 0, fontSize: 12, fontWeight: 600, color: 'var(--st-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.name}</div>
      <div style={{ flex: 1, minWidth: 24, height: 6, borderRadius: 999, background: 'rgba(var(--st-fg-rgb), 0.08)', overflow: 'hidden' }}>
        <div style={{ width: `${pct * 100}%`, height: '100%', borderRadius: 999, background: `rgb(${accent})` }} />
      </div>
      <div style={{ width: 58, textAlign: 'right', flexShrink: 0, fontSize: 11, fontWeight: 600, color: 'rgba(var(--st-sub-rgb), 0.6)', fontVariantNumeric: 'tabular-nums' }}>{fmtSpan(g.sec)}</div>
    </div>
  );
}

/** Minimal SVG sparkline of daily play counts. */
function Sparkline({ data = [], accent }) {
  if (!data.length) return null;
  const w = 74;
  const h = 30;
  const max = Math.max(1, ...data.map((d) => d.plays));
  const step = data.length > 1 ? w / (data.length - 1) : w;
  const pts = data.map((d, i) => `${(i * step).toFixed(1)},${(h - (d.plays / max) * h).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ flexShrink: 0, overflow: 'visible' }} aria-hidden>
      <polyline points={pts} fill="none" stroke={`rgb(${accent})`} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
    </svg>
  );
}

/** Smoothly-animating inline expansion for a release. Animates its measured
 *  height (so it works for any content and re-measures when the tracklist
 *  loads). Its bottom spacing is baked into the measured height, and the grid
 *  it lives in uses row-gap:0 with per-card margins — so opening and closing
 *  never leave a collapsing gap to snap. */
function ReleaseExpansion({ closing, onClosed, children }) {
  const measureRef = useRef(null);
  const [h, setH] = useState(0);
  const openedRef = useRef(false);
  const closingRef = useRef(closing);
  closingRef.current = closing;

  useEffect(() => {
    const el = measureRef.current;
    if (!el) return undefined;
    const raf = requestAnimationFrame(() => {
      setH(el.offsetHeight);
      openedRef.current = true;
    });
    // Grow smoothly when the tracklist loads in after opening.
    const ro = new ResizeObserver(() => {
      if (openedRef.current && !closingRef.current) setH(el.offsetHeight);
    });
    ro.observe(el);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  useEffect(() => {
    if (!closing) return undefined;
    setH(0);
    const t = setTimeout(() => onClosed?.(), 380);
    return () => clearTimeout(t);
  }, [closing, onClosed]);

  return (
    <div className="sth-relexp" style={{ height: h, overflow: 'hidden', transition: 'height 0.38s cubic-bezier(0.22, 1, 0.3, 1)' }}>
      <div ref={measureRef} className="sth-relexp-pad">
        <div className="sth-relexp-inner">{children}</div>
      </div>
    </div>
  );
}

/** Section header for the Discover page. The eyebrow encodes where the
 *  content comes from (a followed-artist feed vs. an Apple Music chart), the
 *  title names it, and an optional meta slot carries a count or hint. A thin
 *  accent rule down the left ties the sections together — the page's one
 *  signature device. */
function DiscoverSectionHead({ eyebrow, title, meta, accent, actions = null }) {
  const acc = readableAccent(accent);
  return (
    <div className="sth-dsc-head">
      <div style={{ minWidth: 0 }}>
        {eyebrow ? <div className="sth-dsc-eyebrow" style={{ color: `rgb(${acc})` }}>{eyebrow}</div> : null}
        <div className="sth-dsc-title">{title}</div>
      </div>
      {/* Actions and meta share ONE right-hand group. As separate children of
          a space-between row they were pushed to the centre, which is what
          left the buttons floating in the middle of the header. */}
      {(actions || meta) ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          {actions}
          {meta ? <div className="sth-dsc-meta" style={{ marginLeft: 2 }}>{meta}</div> : null}
        </div>
      ) : null}
    </div>
  );
}


/**
 * HomeRow — a horizontally scrolling shelf with arrow affordances.
 *
 * Scroll position drives the arrows' enabled state, so they never offer a
 * direction that does nothing. `scrollBy` rather than a transform: native
 * overflow keeps wheel, trackpad and keyboard scrolling working for free,
 * and the arrows are an addition to it rather than a replacement.
 */
function HomeRow({ title, eyebrow, accent, actions = null, children }) {
  const ref = useRef(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const acc = readableAccent(accent);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ start: el.scrollLeft <= 2, end: el.scrollLeft >= max - 2 });
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, children]);

  const nudge = (dir) => {
    const el = ref.current;
    if (!el) return;
    // Roughly one "page", minus a card, so something stays on screen as an
    // anchor rather than the whole row swapping out.
    el.scrollBy({ left: dir * Math.max(240, el.clientWidth - 180), behavior: 'smooth' });
  };

  /* Bare long-arrow glyphs, no button chrome. The circular outlined buttons
     competed with the section titles they sit beside — these are an
     affordance, not a control worth that much weight. Hit area stays 30px
     square even though nothing is painted, so they're still easy to hit. */
  const Arrow = ({ dir, disabled }) => (
    <button
      type="button"
      onClick={() => nudge(dir)}
      disabled={disabled}
      title={dir < 0 ? 'Scroll left' : 'Scroll right'}
      aria-label={dir < 0 ? 'Scroll left' : 'Scroll right'}
      style={{
        width: 30, height: 30, flexShrink: 0, padding: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', background: 'transparent',
        color: disabled ? 'rgba(var(--st-fg-rgb), 0.18)' : 'rgba(var(--st-fg-rgb), 0.55)',
        cursor: disabled ? 'default' : 'pointer',
        transition: 'color 0.15s ease',
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.color = '#fff'; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = disabled ? 'rgba(var(--st-fg-rgb), 0.18)' : 'rgba(var(--st-fg-rgb), 0.55)'; }}
    >
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {dir < 0
          ? <><path d="M19 12H5" /><path d="M11 18l-6-6 6-6" /></>
          : <><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></>}
      </svg>
    </button>
  );

  return (
    <section style={{ marginBottom: 34 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, marginBottom: 14, paddingLeft: 2 }}>
        <div style={{ minWidth: 0 }}>
          {eyebrow ? (
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: `rgb(${acc})`, marginBottom: 4 }}>
              {eyebrow}
            </div>
          ) : null}
          <div style={{ fontSize: 19, fontWeight: 700, color: 'var(--st-text)', letterSpacing: '-0.01em' }}>{title}</div>
        </div>
        <div style={{ flex: 1 }} />
        {actions}
        <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
          <Arrow dir={-1} disabled={edges.start} />
          <Arrow dir={1} disabled={edges.end} />
        </div>
      </div>
      <div
        ref={ref}
        onScroll={measure}
        className="sth-homerow"
        style={{
          display: 'flex', gap: 18, overflowX: 'auto', overflowY: 'hidden',
          scrollbarWidth: 'none', paddingBottom: 4,
        }}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * A settings section heading.
 *
 * Shares the scale of the new grouped-row headings on purpose: with two sizes
 * in play, Playback and Library read as subordinate to Colour and Layout when
 * they're siblings. All four sections are peers, so they look like peers.
 */
function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 18, fontWeight: 850, letterSpacing: '-0.02em', color: 'var(--st-text)',
      margin: '34px 2px 12px',
    }}>
      {children}
    </div>
  );
}


function GhostBtn({ children, onClick, disabled = false, active = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        cursor: disabled ? 'default' : 'pointer', padding: '7px 15px', borderRadius: 9,
        border: '1px solid rgba(var(--st-fg-rgb), 0.14)',
        background: active ? 'rgba(var(--st-fg-rgb), 0.14)' : 'rgba(var(--st-fg-rgb), 0.05)',
        color: active ? '#fff' : 'rgba(var(--st-fg-rgb), 0.75)',
        fontSize: 11.5, fontWeight: 700, letterSpacing: '0.02em',
        opacity: disabled ? 0.55 : 1, transition: 'background 0.15s ease',
      }}
    >
      {children}
    </button>
  );
}

/** Div-based bar chart — no libraries, exact counts on hover via title. */
/**
 * Song table row — index / art / title+artist / album / actions+time.
 * The index turns into a play glyph on hover; the pencil (edit metadata)
 * and ⋯ (remove options) appear on hover just left of the duration; the
 * playing row shows an equalizer in the index cell.
 */
function SongRow({ index, track, art, active = false, playing = false, onPlay, onEdit, onMore }) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={`sth-trow${active ? ' is-active' : ''}`}
      title={`${track.title} — ${track.artist}`}
      onClick={onPlay}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPlay?.(); } }}
      onContextMenu={onMore || undefined}
    >
      <div style={{ textAlign: 'right', fontSize: 11.5, color: active ? '#fff' : 'rgba(var(--st-fg-rgb), 0.35)' }}>
        {playing ? (
          <InlineEq />
        ) : (
          <>
            <span className="sth-num">{index}</span>
            <svg className="sth-playg" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style={{ marginLeft: 'auto', color: 'var(--st-text)' }}>
              <polygon points="5 3 19 12 5 21" />
            </svg>
          </>
        )}
      </div>
      <div style={{
        width: 38, height: 38, borderRadius: 8, position: 'relative', overflow: 'hidden',
        background: art ? `url("${art}") center/cover no-repeat` : 'rgba(var(--st-fg-rgb), 0.06)',
        boxShadow: '0 0 0 1px rgba(var(--st-fg-rgb), 0.07)',
      }}>
        {!art ? (
          <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(var(--st-fg-rgb), 0.3)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)' }}>
            <circle cx="8" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
            <path d="M11 18V5l10-2v13" />
          </svg>
        ) : null}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 12.5, fontWeight: 600,
          color: active ? '#fff' : 'rgba(var(--st-fg-rgb), 0.88)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{track.title}</div>
        <div style={{ fontSize: 10.5, marginTop: 1, color: 'rgba(var(--st-sub-rgb), 0.42)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {track.artist}
        </div>
      </div>
      <div className="sth-albcell" style={{ minWidth: 0, fontSize: 11, color: 'rgba(var(--st-sub-rgb), 0.4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {track.album || ''}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 9 }}>
        <div className="sth-hact">
          {onEdit ? (
            <button type="button" className="sth-iconbtn" title="Edit track info" onClick={onEdit}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>
            </button>
          ) : null}
          {onMore ? (
            <button type="button" className="sth-iconbtn" title="More" onClick={onMore}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
            </button>
          ) : null}
        </div>
        <span style={{ fontSize: 11, color: 'rgba(var(--st-sub-rgb), 0.32)', fontVariantNumeric: 'tabular-nums' }}>
          {fmtDur(track.duration)}
        </span>
      </div>
    </div>
  );
}

/**
 * Tiny inline 3-bar equalizer for the playing row.
 *
 * Now a thin wrapper over PlayingBars. It used to declare its own
 * `@keyframes sthEq` animating HEIGHT, while the app's stylesheet declares one
 * of the same name animating TRANSFORM. Keyframes are global and last-mounted
 * wins, so rendering this anywhere silently changed how every other equaliser
 * in the app moved — bars jumping instead of scaling, or freezing at the wrong
 * size. Three definitions of one name, one of them a different property.
 */
function InlineEq() {
  return <PlayingBars acc="255, 255, 255" playing />;
}

/** Rounded glass card that wraps a group of result rows. */
/* =========================================================================
 *  Find — search results
 *
 *  One surface, split in two: everything that matched on the left, the thing
 *  you picked on the right. Neither column is a card; they sit directly on the
 *  content panel and are separated by whichever device is chosen in
 *  Settings → Appearance (hairline / accent wash / gutter).
 *
 *  What the right column shows depends on what's selected, and in every case
 *  it's the thing you'd otherwise have to guess at:
 *    Spotify album  → the tracklist, with what you already own marked
 *    Spotify song   → the song, and the album it came from
 *    Soulseek folder→ every file in it, and what the whole thing weighs
 *    Soulseek song  → EVERY peer offering it, ranked, so "which one do I
 *                     take" becomes a visible choice rather than a lucky dip
 *
 *  That last one is the reason this view exists. A search for one album comes
 *  back as ~90 rows that are really 12 songs offered by 30 people; the old
 *  view rendered all 90 as bare filenames with no format, no availability and
 *  no way to compare them.
 * ========================================================================= */

/** A filter toggle that also reports. `count` is how many results the filter
 *  concerns — how many you'd hide, or how many match — so the chip answers
 *  "is this worth turning on" before you turn it on. */
function FilterChip({ on, count, onClick, children }) {
  return (
    <button type="button" className={`sth-fchip${on ? ' on' : ''}`} onClick={onClick} role="switch" aria-checked={!!on}>
      <span className="sth-fchip-box" />
      {children}
      {Number.isFinite(count) && count > 0 ? <span className="sth-fchip-ct">{count}</span> : null}
    </button>
  );
}

/** Quality chip. Lossless is green, 320-and-up takes the accent, the rest fade. */
function QualityBadge({ q, accent }) {
  const acc = readableAccent(accent);
  const style = q.lossless
    ? { background: 'rgba(140,220,160,0.14)', color: 'rgb(140,220,160)', boxShadow: 'inset 0 0 0 1px rgba(140,220,160,0.22)' }
    : q.tier >= 4 ? { background: `rgba(${acc},0.14)`, color: `rgb(${acc})`, boxShadow: `inset 0 0 0 1px rgba(${acc},0.22)` }
      : q.tier >= 2 ? { background: 'rgba(var(--st-fg-rgb), 0.07)', color: 'rgba(var(--st-fg-rgb), 0.55)', boxShadow: 'inset 0 0 0 1px rgba(var(--st-fg-rgb), 0.1)' }
        : { background: 'rgba(var(--st-fg-rgb), 0.05)', color: 'rgba(var(--st-fg-rgb), 0.38)' };
  return <span className="sth-fbadge" style={style}>{q.label}</span>;
}

/** Free upload slot or not — the single biggest predictor of whether a
 *  download actually starts, and it was nowhere in the old view. */
function SlotTag({ free }) {
  return (
    <span className="sth-favail" style={{ color: free ? 'rgba(140,220,160,0.9)' : 'rgba(240,190,120,0.85)' }}>
      <span className="sth-fdot" style={{ background: free ? 'rgb(140,220,160)' : 'rgb(240,190,120)' }} />
      {free ? 'Free slot' : 'Queued'}
    </span>
  );
}

/* FindResults, FindGetBtn, FindGhostBtn, ResultsCard and FolderGlyph lived
 * here. The Find page is gone: the palette answers the same question in
 * fewer keystrokes without leaving the page you were on, so a second
 * full-screen results surface was two implementations of one feature.
 * Chevron / ResultRow / RowBtn below survive — Discover and the release
 * panel use them too. */

function Chevron({ open }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(var(--st-fg-rgb), 0.5)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/** One row in a results card. */
function ResultRow({ art, title, sub, dl, progress, accent = '128, 128, 128', onGrab, onOpen, openable = false, open = false, ownedAlready = false, indent = false, dense = false, grow = false }) {
  const busy = dl === 'busy';
  const done = dl === 'done';
  const pct = typeof progress?.pct === 'number' ? progress.pct : null;
  const busyLabel = progress?.phase === 'processing' ? 'Processing…'
    : pct != null ? `${Math.round(pct * 100)}%`
    : 'Downloading…';
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        // In the stretched tracks card, rows share the spare height (capped)
        // so slack doesn't pool under the last track.
        ...(grow ? { flex: '1 0 auto', maxHeight: 56 } : null),
        padding: dense ? (indent ? '5px 14px 5px 28px' : '6px 14px') : (indent ? '7px 16px 7px 30px' : '9px 16px'),
        borderTop: '1px solid rgba(var(--st-fg-rgb), 0.05)',
        cursor: openable ? 'pointer' : 'default',
      }}
      onClick={openable ? onOpen : undefined}
    >
      {art ? (
        <div style={{ width: dense ? 30 : 36, height: dense ? 30 : 36, borderRadius: dense ? 7 : 8, flexShrink: 0, background: `url("${art}") center/cover no-repeat`, border: '1px solid rgba(var(--st-fg-rgb), 0.1)' }} />
      ) : null}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: dense ? 12 : 12.5, fontWeight: 600, color: 'var(--st-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
        {sub ? <div style={{ fontSize: dense ? 10.5 : 11, color: 'rgba(var(--st-sub-rgb), 0.5)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div> : null}
      </div>
      {openable ? (
        <Chevron open={open} />
      ) : (
        <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
          {ownedAlready && !done ? (
            <span style={{ fontSize: 10, color: 'rgba(var(--st-sub-rgb), 0.4)', marginRight: 2 }}>in library</span>
          ) : null}
          {busy ? (
            <div style={{ width: 118 }}>
              <DownloadProgressBar pct={pct} accent={accent} label={busyLabel} />
            </div>
          ) : (
            // Single download button — same look as the command center's.
            <button
              type="button"
              title={done ? 'In your library' : dl === 'failed' ? 'Retry' : 'Download to library'}
              disabled={done}
              onClick={(e) => { e.stopPropagation(); onGrab?.(); }}
              style={{
                width: 26, height: 26, borderRadius: 8, flexShrink: 0, border: 'none',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: done ? 'default' : 'pointer',
                background: done ? `rgba(${accent},0.3)` : 'rgba(var(--st-fg-rgb), 0.07)',
                color: dl === 'failed' ? '#f0a0a0' : done ? '#fff' : 'rgba(var(--st-fg-rgb), 0.65)',
                transition: 'background 0.2s ease, color 0.2s ease',
              }}>
              {done ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RowBtn({ label, filled = false, onClick }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      style={{
        cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '5px 12px', borderRadius: 8,
        border: '1px solid rgba(var(--st-fg-rgb), 0.16)',
        background: filled ? '#fff' : 'rgba(var(--st-fg-rgb), 0.06)',
        color: filled ? '#000' : 'rgba(var(--st-fg-rgb), 0.85)',
      }}
    >
      {label}
    </button>
  );
}
