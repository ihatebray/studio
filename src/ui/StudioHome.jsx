import React, { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
/* The DOCK's editor. LyricsEditor stays where it is — the fullscreen stage it
   was designed for is unchanged — but a full-height textarea and two
   side-by-side actions don't shrink into a 360px column, so the panel gets its
   own. Same props, same onSave contract. See PanelLyricsEditor. */
import { MetadataEditor, AlbumMetadataEditor } from './MetadataEditor.jsx';
import { StudioMotionStyles } from './StudioOnboarding.jsx';
import { useToast, setToastLayout } from './Toasts.jsx';
import { useDownloadProgress, VideoPicker } from './sharedUI.jsx';
import InstantSearch from './InstantSearch.jsx';
import LyricShare from './LyricShare.jsx';
import { LyricsPickerButton } from './LyricsPicker.jsx';
import { sampleCoverTheme, washSourceFor, setColourIntensity, barTone, readableAccent, accentTextColor } from '../lib/coverTheme.js';
import { titleCollator, parseGenres } from '../lib/mediaUtils.js';
import { songKey } from '../lib/instantSearch.js';
import ArtistPage from './ArtistPage.jsx';
import { setPreviewHooks, isPreviewing, stop as stopPreview } from './previewPlayer.jsx';
import { hoverPreload, spotifyIdOf } from '../lib/spotifyMediaElement.js';
import { CompactVizContext, COMPACT_VIZ_KEY, COMPACT_VIZ_COVER_KEY } from './CompactVisualizer.jsx';
import { VIZ_IDS } from '../lib/compactVizStyles.js';
import { SpotifyHome, SpotifyReleases } from './MySpotify.jsx';
import NotificationsButton from './Notifications.jsx';
import { useStudioFollows, isStudioFollowed, followArtist, unfollowArtist } from '../lib/studioFollows.js';
import { notePlayContext } from '../lib/playContext.js';
import { deriveAccent, applyAccent, accentSourceFromTheme, lastAccentSource, rememberAccentSource, NEUTRAL_ACCENT } from '../lib/accentTokens.js';
import { api } from '../lib/format.js';
import { CoverColourTab, ReloadButton } from './home/Settings.jsx';
import { CoverLightbox, NowPlayingBar, NowPlayingFullView, NowPlayingPanelDock } from './home/NowPlaying.jsx';
import { HOME_CSS } from './home/styles.js';
import { LEGACY_SECTIONS, LIB_VIEWS, MY_SPOTIFY, MY_SPOTIFY_IDS, NP_BAR_DEFAULT, NP_PANEL_W, SIDEBAR_W, THEME_DEFAULTS, TOPBAR_H } from './home/constants.js';
import { MenuItem, Modal, albumKeyOf, primaryArtistOf } from './home/common.jsx';
import SettingsPage from './home/SettingsPage.jsx';
import LibraryPage from './home/LibraryPage.jsx';

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
  gainBoost = 1,         // gain past full volume, 1–16x (App's audio graph + the Spotify helper)
  onSetGainBoost,
  getGainReduction = null,
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
  uiFontId,              // the UI font (uiFonts.js), and its setter
  onSetUiFontId,
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


  const closeMenu = useCallback(() => { setRowMenu(null); }, []);

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
  const currentTrackRef = useRef(currentTrack);
  useEffect(() => { currentTrackRef.current = currentTrack; }, [currentTrack]);
  useEffect(() => {
    const onKey = (e) => {
      const el = e.target;
      const tag = el && el.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable;
      // F (or Ctrl/Cmd+Shift+F) toggles the full view while something plays.
      const plainF = !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      const comboF = (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey;
      if ((plainF || comboF) && (e.key === 'f' || e.key === 'F') && !e.defaultPrevented) {
        if (!currentTrackRef.current) return;
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
  const [libSort] = useState(() => {
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

  // Now Playing panel options, persisted so they survive restarts.
  const [npAnimatedBg, setNpAnimatedBg] = useState(() => {
    try { return localStorage.getItem('studio:npAnimatedBg') === '1'; } catch { return false; }
  });
  // Expanded library: the fullscreen button on the Now Playing panel no
  // longer opens the stage overlay — it grows the library grid to fill the
  // content area, hiding the page header (title + totals). The nav rail and
  // the Now Playing pane stay.

  const toggleNpAnimatedBg = useCallback(() => {
    setNpAnimatedBg((v) => { const n = !v; try { localStorage.setItem('studio:npAnimatedBg', n ? '1' : '0'); } catch { /* ignore */ } return n; });
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
  const songRoRef = useRef(null);
  const songListRef = useRef(null);
  useEffect(() => () => { if (songRoRef.current) songRoRef.current.disconnect(); }, []);

  // A narrowed filter can leave the viewport scrolled past the end of the new
  // result set, which would render an empty slice. Jump back to the top.
  useEffect(() => {
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
  const saveProfile = useCallback((next) => {
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

  const [libDetail, setLibDetail] = useState(null);   // { kind:'album'|'playlist', key } | null
  const [detailFilter, setDetailFilter] = useState('');
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
  useEffect(() => { setDetailFilter(''); }, [libDetail?.key]);
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
    return { kind: 'playlist', title: pl.name, by: 'You', customArt: !!pl.coverArt, art: pl.coverArt || tracks[0] ? (pl.coverArt || coverFor(tracks[0])) : null, tracks };
  }, [libDetail, libAlbums, playlists, library, coverFor]);

  /* Page wash, sampled from the open record's cover. Same sampler the
     fullscreen stage use, so there's no second colour system —
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




  // Recently played — most-recent-first, de-duplicated by track, resolved
  // from the play-event log against the current library.

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

  const barShown = !!currentTrack;
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
      '--np-reserve': `calc(${currentTrack
        ? (compactMode ? `${10 + 86 + 10}px` : `${16 + 86 + 12}px`)
        : (compactMode ? '10px' : '16px')} + var(--st-toast-lane, 0px))`,
      '--row-h': listDensity === 'compact' ? '40px' : listDensity === 'roomy' ? '64px' : '54px',
      '--row-art': listDensity === 'compact' ? '30px' : listDensity === 'roomy' ? '48px' : '40px',
    }}>
      <StudioMotionStyles />
      <style>{HOME_CSS}</style>
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
          {/* The app icon's own mark (src/assets/icon.png): three bars on a
              dark tile. It used to be a tile filled with the accent, which on
              the neutral accent was a blank white square. */}
          <svg aria-hidden width="26" height="26" viewBox="0 0 100 100" style={{ flexShrink: 0, display: 'block' }}>
            <defs>
              <linearGradient id="sth-mark-tile" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#1c1c20" />
                <stop offset="1" stopColor="#09090b" />
              </linearGradient>
            </defs>
            <rect x="2" y="2" width="96" height="96" rx="24" fill="url(#sth-mark-tile)" />
            <rect x="2.5" y="2.5" width="95" height="95" rx="23.5" fill="none" stroke="#ffffff" strokeOpacity="0.14" strokeWidth="3" />
            <rect x="32" y="26" width="9" height="47" rx="4.5" fill="#f4f4f5" />
            <rect x="46" y="18" width="9" height="64" rx="4.5" fill="#f4f4f5" />
            <rect x="59" y="37" width="9" height="24" rx="4.5" fill="#f4f4f5" />
          </svg>
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
        /* Always below the top bar. */
        position: 'absolute', top: 'var(--shell-top)',
        bottom: 0, left: compactMode ? 'var(--gutter)' : SIDEBAR_W, right: 0, zIndex: 1,
        display: 'flex', flexDirection: 'column',
        /* Reserve the dock's width so the content narrows instead of being
           covered. The shelves re-measure through HomeRow's ResizeObserver, so
           the carousel arrows stay accurate at the new width. */
        /* The panel's own width plus the gap between it and the card. The
           card's --gutter margin sits outside this, so the card ends exactly
           one gap from the panel's edge. */
        paddingRight: (npPanelOpen && currentTrack) ? NP_PANEL_W + 12 : 0,
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

        {/* No per-section padding: the panel's geometry is fixed in
            .sth-scroll, and only the `is-page` variant alters it. */}
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
          {sec === 'library' ? (
            <LibraryPage
              LIB_OVERSCAN={LIB_OVERSCAN}
              LIB_ROW_H={LIB_ROW_H}
              accent={accent}
              autoRgb={autoRgb}
              canManage={canManage}
              compactMode={compactMode}
              coverFor={coverFor}
              coverOverride={coverOverride}
              currentTrack={currentTrack}
              detailAlign={detailAlign}
              detailData={detailData}
              detailFilter={detailFilter}
              detailGenres={detailGenres}
              detailMore={detailMore}
              detailTheme={detailTheme}
              detailTracks={detailTracks}
              dlProgress={dlProgress}
              dlState={dlState}
              downloadSpotifyRow={downloadSpotifyRow}
              filteredLibArtists={filteredLibArtists}
              fmtAdded={fmtAdded}
              immerse={immerse}
              importing={importing}
              isFollowing={isFollowing}
              isPlaying={isPlaying}
              libAlbums={libAlbums}
              libArtists={libArtists}
              libAzIndex={libAzIndex}
              libDetail={libDetail}
              libFilter={libFilter}
              libRowSort={libRowSort}
              libRows={libRows}
              libRowsRef={libRowsRef}
              libScrollElRef={libScrollElRef}
              libScrollRef={libScrollRef}
              libScrollTop={libScrollTop}
              libSortField={libSortField}
              libTitle={libTitle}
              libView={libView}
              libViewH={libViewH}
              library={library}
              mySpotifyBridge={mySpotifyBridge}
              npWashTheme={npWashTheme}
              onImportFiles={onImportFiles}
              onImportFolder={onImportFolder}
              onImportSpotify={onImportSpotify}
              onPlayTrack={onPlayTrack}
              onRemoveFromPlaylist={onRemoveFromPlaylist}
              onToggleFavorite={onToggleFavorite}
              onTogglePlay={onTogglePlay}
              onUpdateAlbumMetadata={onUpdateAlbumMetadata}
              openAlbumFromRow={openAlbumFromRow}
              openArtist={openArtist}
              openArtistAnywhere={openArtistAnywhere}
              openArtistFromRow={openArtistFromRow}
              openPalette={openPalette}
              openRowMenu={openRowMenu}
              ownedTrackFor={ownedTrackFor}
              pickLibRowSort={pickLibRowSort}
              pickSection={pickSection}
              playCountFor={playCountFor}
              playEvents={playEvents}
              playFromLibRows={playFromLibRows}
              setAlbumEditScope={setAlbumEditScope}
              setDeletePl={setDeletePl}
              setDetailFilter={setDetailFilter}
              setDetailMore={setDetailMore}
              setLibDetail={setLibDetail}
              setLibFilter={setLibFilter}
              setLibScrollTop={setLibScrollTop}
              setPlCoverFor={setPlCoverFor}
              setRenamePl={setRenamePl}
              setSetCat={setSetCat}
              showDateAdded={showDateAdded}
              showPlayCounts={showPlayCounts}
              theme={theme}
              toggleFollow={toggleFollow}
            />
          ) : null}



          {/* ================= SETTINGS ================= */}
          {sec === 'settings' ? (
            <SettingsPage
              accentFixed={accentFixed}
              accentMode={accentMode}
              clearing={clearing}
              clearingAll={clearingAll}
              compactMode={compactMode}
              compactViz={compactViz}
              compactVizCover={compactVizCover}
              connState={connState}
              detailAlign={detailAlign}
              discordAppId={discordAppId}
              discordHideWhenPaused={discordHideWhenPaused}
              discordPresenceDetail={discordPresenceDetail}
              discordPresenceEnabled={discordPresenceEnabled}
              discordStatus={discordStatus}
              imgbbApiKey={imgbbApiKey}
              listDensity={listDensity}
              navStyle={navStyle}
              npAnimatedBg={npAnimatedBg}
              npBarColor={npBarColor}
              npWashTheme={npWashTheme}
              onClearEverything={onClearEverything}
              onClearLibrary={onClearLibrary}
              onReplayOnboarding={onReplayOnboarding}
              onSetDiscordAppId={onSetDiscordAppId}
              onSetDiscordHideWhenPaused={onSetDiscordHideWhenPaused}
              onSetDiscordPresenceDetail={onSetDiscordPresenceDetail}
              onSetDiscordPresenceEnabled={onSetDiscordPresenceEnabled}
              onSetImgbbApiKey={onSetImgbbApiKey}
              uiFontId={uiFontId}
              onSetUiFontId={onSetUiFontId}
              onSetTransitionMode={onSetTransitionMode}
              onSpotifyCredsSaved={onSpotifyCredsSaved}
              pickAccentFixed={pickAccentFixed}
              pickAccentMode={pickAccentMode}
              pickCompactMode={pickCompactMode}
              pickCompactViz={pickCompactViz}
              pickDetailAlign={pickDetailAlign}
              pickListDensity={pickListDensity}
              pickNpBarColor={pickNpBarColor}
              rawAccent={rawAccent}
              setCat={setCat}
              setClearAllConfirm={setClearAllConfirm}
              setClearConfirm={setClearConfirm}
              setConnState={setConnState}
              setDiscordPresenceDetailSafely={setDiscordPresenceDetailSafely}
              setNavStylePref={setNavStylePref}
              setSetCat={setSetCat}
              setThemeKey={setThemeKey}
              showDateAdded={showDateAdded}
              showPlayCounts={showPlayCounts}
              theme={theme}
              toggleCompactVizCover={toggleCompactVizCover}
              toggleDateAdded={toggleDateAdded}
              toggleNpAnimatedBg={toggleNpAnimatedBg}
              toggleShowPlayCounts={toggleShowPlayCounts}
              transitionMode={transitionMode}
            />
          ) : null}
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
        const close = () => { setRowMenu(null); };
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

      {currentTrack && !npFull ? (
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
          gainBoost={gainBoost}
          onSetGainBoost={onSetGainBoost}
          getGainReduction={getGainReduction}
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
        open={npPanelOpen && !!currentTrack && !npFull}
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
          gainBoost={gainBoost}
          onSetGainBoost={onSetGainBoost}
          getGainReduction={getGainReduction}
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

      {/* ---- Lyric browser + share --------------------------------------
       * Driven by `lyricsPickReq`, `lyricSel` and `lyricShareOpen`; keep a
       * single copy of each, or one request would open two modals. */}
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

      {/* Selection confirm bar. position:fixed and centred at the top, so it
          reads the same whether the lines were picked in the dock or the
          fullscreen stage. */}
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
