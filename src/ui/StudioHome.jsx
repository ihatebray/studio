import React, { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { StudioMotionStyles } from './StudioOnboarding.jsx';
import { useToast, setToastLayout, OPEN_NOTICES_EVENT } from './Toasts.jsx';
import { useDownloadProgress, VideoPicker } from './sharedUI.jsx';
import InstantSearch from './InstantSearch.jsx';
import { LyricsPickerButton } from './LyricsPicker.jsx';
/* Opened rarely, so loaded on first use instead of with the app. */
const MetadataEditor = React.lazy(() => import('./MetadataEditor.jsx').then((m) => ({ default: m.MetadataEditor })));
const AlbumMetadataEditor = React.lazy(() => import('./MetadataEditor.jsx').then((m) => ({ default: m.AlbumMetadataEditor })));
const LyricShare = React.lazy(() => import('./LyricShare.jsx'));
import { sampleCoverTheme, isFallbackTheme, recordWashSource, washSourceFor, barTone, readableAccent } from '../lib/coverTheme.js';
import { titleCollator } from '../lib/mediaUtils.js';
import { songKey } from '../lib/instantSearch.js';
import ArtistPage from './ArtistPage.jsx';
import { spotifyIdOf } from '../lib/spotifyMediaElement.js';
import { connectTwitchChat, twitchChannelOf } from '../lib/twitchChat.js';
import { blockedBy, entryLabel, sameEntry, songEntry } from '../lib/srBlock.js';
import { CompactVizContext, COMPACT_VIZ_KEY, COMPACT_VIZ_COVER_KEY } from './CompactVisualizer.jsx';
import { VIZ_IDS } from '../lib/compactVizStyles.js';
import { SpotifyHome, SpotifyReleases, loadCollection, recordFor } from './MySpotify.jsx';
import NotificationsButton from './Notifications.jsx';
import DarkModeButton from './home/DarkModeButton.jsx';
import { useStudioFollows, isStudioFollowed, followArtist, unfollowArtist } from '../lib/studioFollows.js';
import { notePlayContext } from '../lib/playContext.js';
import { fullAlbumRows, mergeAlbum } from './home/RecordPage.jsx';
import { deriveAccent, applyAccent, accentSourceFromTheme, lastAccentSource, rememberAccentSource, NEUTRAL_ACCENT } from '../lib/accentTokens.js';
import { api, fmtMs } from '../lib/format.js';
import { ColourStrip, makeHoverSource } from './home/ColourStrip.jsx';
import { getPlaybackTime } from '../lib/playbackClock.js';
import { OPEN_SHORTCUTS_EVENT, ShortcutsDialog, keysText, shortcutFor, worksWhileTyping } from './home/Shortcuts.jsx';
import { CoverLightbox, NowPlayingBar, NowPlayingFullView, NowPlayingPanelDock } from './home/NowPlaying.jsx';
import { HOME_CSS } from './home/styles.js';
import { DARK, LEGACY_SECTIONS, LIB_VIEWS, MY_SPOTIFY, MY_SPOTIFY_IDS, NP_BAR_DEFAULT, NP_PANEL_W, SIDEBAR_W, THEME_DEFAULTS, TOPBAR_H, viewTheme } from './home/constants.js';
import WindowControls from './WindowControls.jsx';
import { DIALOG_CSS, Dialog, MENU_SURFACE, MI, MenuHead, MenuItem, Modal, ObjectMenu, PlaylistPickList, albumKeyOf, hexToRgb, primaryArtistOf } from './home/common.jsx';
import SettingsPage from './home/SettingsPage.jsx';
import LibraryPage from './home/LibraryPage.jsx';
import { IMPORT_ICONS, ImportMenuItem } from './home/Library.jsx';

/** An album name for comparing: case and spacing don't count. */
const normAlbum = (a) => String(a || '').toLowerCase().replace(/\s+/g, ' ').trim();

export default function StudioHome({
  library = [],
  onImportFiles,         // () → App: file picker, tag read, DB write
  onImportFolder,        // () → App: folder picker, recursive scan
  onImportSpotify,       // () → App: opens the Spotify playlist importer
  importing = false,     // an import is in flight — disable the buttons
  queue = [],
  queueIndex = -1,
  playSource = null,     // { item, ids }: the playlist, album or mix the queue came from (App's playTrack)
  onReorderQueue,
  onRemoveFromQueue,
  onRestoreToQueue,      // (track, after): puts back what onRemoveFromQueue took out
  onClearQueue,          // () → App: empty up next, returns what it took out
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
  onQueueRequest,        // (track, by) → App: a chat request, first come first served; returns its place in line
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
  onReorderPlaylist,     // (playlistId, trackIds) — its songs in a new order
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
  normalization = 'normal',
  onSetNormalization,
  eq,
  eqHeadroom = 0,
  onSetEq,
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
      delete saved.colourIntensity; // retired: cover colors use one strength, picked colors are exact
      /* The old default for a picked page or panel colour was near-black
         (14, 13, 18), so choosing Color looked like it did nothing. Anyone
         still on it gets the new default; a colour you picked is kept. */
      for (const k of ['pageColour', 'panelColour']) if (saved[k] === '14, 13, 18') delete saved[k];
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
  /* Switching window layout plays one motion (styles.js, "Entering and
     leaving compact mode"). Going compact, the top bar and sidebar keep
     their docked places while they slide off, and only take their compact
     (hidden, peek-on-hover) form once they're gone; coming back, they slide
     in from where the compact ones were parked. */
  const [modeAnim, setModeAnim] = useState(null); // 'to-compact' | 'to-standard' | null
  const modeSeen = useRef(false);                 // a switch has happened since launch
  const prevCompact = useRef(compactMode);
  useLayoutEffect(() => {
    if (prevCompact.current === compactMode) return undefined;
    prevCompact.current = compactMode;
    modeSeen.current = true;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setModeAnim(null); return undefined; }
    setModeAnim(compactMode ? 'to-compact' : 'to-standard');
    const t = setTimeout(() => setModeAnim(null), 480);
    return () => clearTimeout(t);
  }, [compactMode]);
  // The chrome is in its compact form only once it has finished leaving.
  const chromeCompact = compactMode && modeAnim !== 'to-compact';
  /* The frame measurements glide only while the mode changes (styles.js).
     True from the render that flips the mode, before the effect above sets
     modeAnim, so the change itself is what glides. */
  const modeMoving = modeAnim != null || prevCompact.current !== compactMode;
  const MODE_EASE = '0.46s cubic-bezier(0.32,0.72,0,1) both';
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
  /* A picked accent keeps its own saturation; one from a cover is held to
     the usual ceiling so a loud sleeve doesn't flood the controls. */
  const accentTokens = useMemo(() => deriveAccent(accentSrc, accentMode === 'fixed'), [accentSrc, accentMode]);
  const accent = accentTokens.fill;
  useEffect(() => { applyAccent(accentTokens); }, [accentTokens]);

  /* ---------- Navigation --------------------------------------------------- */
  const [section, setSection] = useState(() => {
    try {
      const v = localStorage.getItem('studio:homeSection');
      /* 'library' lives in the sidebar; the My Spotify pages too. Anything
         else stored (the old Home and Stats tabs, and before them Find and
         Discover) lands on My Spotify's Home. */
      return (v === 'library' || v === 'settings' || MY_SPOTIFY_IDS.has(v)) ? v : 'sp-home';
    } catch { return 'sp-home'; }
  });
  const pickSection = useCallback((s) => {
    const target = LEGACY_SECTIONS.has(s) ? 'sp-home' : s;
    setSection(target);
    try { localStorage.setItem('studio:homeSection', target); } catch { /* ignore */ }
  }, []);
  /* A popup menu measured once it's drawn, and again whenever it grows (the
     Add to playlist list opens inside it): if its bottom would pass the
     window's, it moves up to fit, 8px clear. Its first placement only
     guessed a height, which left the last options cut off on a song low in
     the list. */
  const keepMenuOnScreen = useCallback((el) => {
    if (!el || el.__fit) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      if (r.bottom > vh - 8 && el.style.bottom === '') el.style.top = `${Math.max(8, vh - r.height - 8)}px`;
    };
    el.__fit = new ResizeObserver(fit);
    el.__fit.observe(el);
    fit();
  }, []);
  /* Settings → Layout → Home: hidden, it leaves the sidebar, anything that
     would land on it lands on New Releases, and the countdowns move there. */
  const homeOn = theme.showHome !== false;
  /* The Settings tour, shown once right after setup. */
  const [settingsTour, setSettingsTour] = useState(() => { try { return localStorage.getItem('studio:settingsTour') === '1'; } catch { return false; } });
  const endSettingsTour = useCallback((leave) => {
    setSettingsTour(false);
    try { localStorage.removeItem('studio:settingsTour'); } catch { /* ignore */ }
    if (leave) pickSection(homeOn ? 'sp-home' : 'sp-releases');
  }, [homeOn, pickSection]);
  useEffect(() => { if (!homeOn && section === 'sp-home') pickSection('sp-releases'); }, [homeOn, section, pickSection]);

  /* ---------- Row menu + metadata editor (shared by library views) --------- */
  const [rowMenu, setRowMenu] = useState(null); // { x, y, track | row, queueIndex? }
  /* The song menu's playlist list: open, what's typed to find one, and the
     name of a new one being made (null when not). */
  const [plSub, setPlSub] = useState(null);
  const plSubTimer = useRef(null);
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
    /* Plain lyrics: the view numbers every line, blanks included, so slice
       first and drop blanks and "[Verse 1]"-style headers after. */
    const plain = (lyricsData?.plain || '').split('\n');
    return plain.slice(lyricSel.start, lyricSel.end + 1)
      .filter((l) => l.trim() && !/^\s*\[[^\]]*\]\s*$/.test(l));
  }, [lyricSel, lyricsData]);


  const closeMenu = useCallback(() => { setRowMenu(null); setPlSub(null); }, []);

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
  /* The Songs list's row height, which the virtualiser counts in: it has
     to be the height the rows really are (.sth-lrow, var(--row-h)), per
     List density. A fixed 50 against 54px rows let long lists drift. */
  const LIB_ROW_H = listDensity === 'compact' ? 40 : listDensity === 'roomy' ? 64 : 54;
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
  /* A playlist's list is where the song plays from. Songs (your whole
     library) isn't a place: there the bar shows the song's album. */
  const libSourceRef = useRef(null);
  const playFromLibRows = useCallback((t) => {
    onPlayTrackRef.current?.(t, libRowsRef.current || undefined, 'list', libSourceRef.current);
  }, []);

  /* A library list's row. On a playlist's page the menu also knows which
     playlist, for Move up / Move down / Remove from playlist. `extra` can
     carry a Spotify `row` instead of a track (an album's songs you don't
     have). */
  const libDetailRef = useRef(null);
  const openRowMenu = useCallback((e, track, extra = null) => {
    e.preventDefault();
    e.stopPropagation();
    setPlSub(null);
    const d = libDetailRef.current;
    setRowMenu({ x: e.clientX, y: e.clientY, track, ...(extra || {}), playlistId: track && d?.kind === 'playlist' ? d.key : null });
  }, []);
  /* The same menu for a Spotify row (My Spotify, artist pages, search) and
     for a song in the queue (`queueIndex`, its place in the whole queue). */
  const openSongMenu = useCallback((e, { track = null, row = null, queueIndex = null, playlistId = null } = {}) => {
    e.preventDefault();
    e.stopPropagation();
    /* A song streaming from Spotify (in the queue, say) is a Spotify row as
       far as the menu goes: it can be saved and filed. */
    if (track?.streamOnly && spotifyIdOf(track)) {
      row = { spotifyId: spotifyIdOf(track), title: track.title, artists: track.artist, album: track.album || '', albumArtUrl: track.coverArt || '', durationMs: (track.duration || 0) * 1000, explicit: !!track.explicit };
      track = null;
    }
    if (!track && !row?.spotifyId) return;
    setPlSub(null);
    // `playlistId`: one of your playlists, open in the album view.
    setRowMenu({ x: e.clientX, y: e.clientY, track, row, queueIndex, playlistId: track ? playlistId : null });
  }, []);
  const openQueueMenu = useCallback((e, track, queueIndex) => openSongMenu(e, { track, queueIndex }), [openSongMenu]);

  const canManage = !!(onUpdateTrackMetadata || onRemoveFromLibrary);

  /* ---------- Download bookkeeping (shared by find + discover) ------------- */
  const pushToast = useToast();

  /** Clear Queue: empties up next, with Undo putting the songs back. */
  const clearUpNext = useCallback(() => {
    const removed = onClearQueue?.() || [];
    if (!removed.length) return;
    const n = removed.length;
    pushToast?.({
      message: `Cleared ${n} ${n === 1 ? 'song' : 'songs'} from the queue`,
      action: onAddToQueue ? { label: 'Undo', onClick: () => onAddToQueue(removed) } : null,
    });
  }, [onClearQueue, onAddToQueue, pushToast]);

  const setDiscordPresenceDetailSafely = useCallback((detail) => {
    try {
      const result = onSetDiscordPresenceDetail?.(detail);
      if (result?.catch) result.catch((e) => {
        console.error('[discordPresenceDetail]', e);
        pushToast?.({ message: 'Couldn’t save the Discord profile detail.', kind: 'error' });
      });
    } catch (e) {
      // A parent integration mismatch must not crash Settings. The parent should
      // still be corrected to pass its dedicated Discord detail setter.
      console.error('[discordPresenceDetail]', e);
      pushToast?.({ message: 'Couldn’t save the Discord profile detail.', kind: 'error' });
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
          pushToast?.({ message: 'Spotify isn’t connected.', kind: 'error' });
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
          pushToast?.({ message: `Couldn’t find “${t.title}” on Spotify.`, kind: 'error', durationMs: 5000 });
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
      pushToast?.({ message: 'Couldn’t copy the link. Please try again.', kind: 'error' });
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
    if (res?.noPicker) { toastError(res.error, `Couldn’t save “${meta?.title || 'this song'}”.`); return; }
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
  /* Every copy you have of each song, by songKey. Several when the same
     title is on more than one record (a studio album and a live set). */
  const ownedByKey = useMemo(() => {
    const m = new Map();
    for (const t of library) {
      const k = songKey(t.title, t.artist);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(t);
    }
    return m;
  }, [library]);
  /* The copy you have of a song, or null. With an album, only a copy from
     that same album counts: the same title on another record (a live set,
     a deluxe, a single) is a different song to save. */
  const ownedTrackFor = useCallback((title, artists, album) => {
    const copies = ownedByKey.get(songKey(title, artists));
    if (!copies) return null;
    if (album === undefined) return copies[0];
    const want = normAlbum(album);
    return copies.find((t) => normAlbum(t.album) === want) || null;
  }, [ownedByKey]);
  /* The Spotify songs in your library, by id: the exact match, checked
     before the looser title, artist and album one. */
  const ownedSids = useMemo(() => {
    const m = new Set();
    for (const t of library) { const sid = spotifyIdOf(t); if (sid) m.add(sid); }
    return m;
  }, [library]);
  const alreadyOwned = useCallback((title, artists, album, sid = null) => (!!sid && ownedSids.has(sid)) || !!ownedTrackFor(title, artists, album), [ownedTrackFor, ownedSids]);
  /* "Saved" means it's in your library. A save that finished stops counting
     once that song isn't there any more (removed since, say), or every view
     would go on showing it as saved. */
  useEffect(() => {
    setDlState((m) => {
      let next = null;
      for (const [k, v] of Object.entries(m)) {
        if (v !== 'done' || !k.startsWith('s:') || ownedSids.has(k.slice(2))) continue;
        if (!next) next = { ...m };
        delete next[k];
      }
      return next || m;
    });
  }, [ownedSids]);

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
    if (n) pushToast?.({ message: 'Compact Mode on. Move the pointer to the top or left edge for navigation. Ctrl+Shift+C to exit.', durationMs: 5000 });
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
  const npFullBlockers = useRef(false);
  // Nothing loaded, nothing to show: the view closes itself rather than
  // leaving an empty stage over the app.
  useEffect(() => { if (!currentTrack) setNpFull(false); }, [currentTrack]);
  /* The window buttons live in the top bar (WindowControls inline), and
     the fullscreen player shows none: App's floating set stays hidden
     either way while this page is up. */
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.winctl = npFull ? 'none' : 'bar';
    return () => { delete root.dataset.winctl; };
  }, [npFull]);
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
  /* The notifications panel hangs from the top bar. Opened from a toast in
     compact mode, the bar slides out with it and stays while it's open, the
     pointer wherever it is; once it closes, the bar goes back unless the
     pointer is up there. */
  const noticesOpenRef = useRef(false);
  const pointerYRef = useRef(0);
  useEffect(() => {
    const onAsk = () => { if (compactRef.current) setChromePeek('top'); };
    const onNotices = (e) => {
      noticesOpenRef.current = !!e.detail?.open;
      if (!noticesOpenRef.current && compactRef.current) {
        setChromePeek((p) => (p === 'top' && pointerYRef.current > TOPBAR_H + 16 ? null : p));
      }
    };
    window.addEventListener(OPEN_NOTICES_EVENT, onAsk);
    window.addEventListener('studio:notices', onNotices);
    return () => { window.removeEventListener(OPEN_NOTICES_EVENT, onAsk); window.removeEventListener('studio:notices', onNotices); };
  }, []);

  useEffect(() => {
    if (!compactMode || npFull) { setChromePeek(null); return undefined; }
    const EDGE = 8;
    const onMove = (e) => {
      pointerYRef.current = e.clientY;
      if (e.buttons) return;
      const x = e.clientX; const y = e.clientY;
      /* Anything that drops down from the top bar (notifications) hangs
         below it; the bar stays out while the pointer is over one. */
      const overDropdown = !!e.target?.closest?.('[data-topbar-dropdown]');
      setChromePeek((p) => {
        if (p === 'top') return y > TOPBAR_H + 16 && !overDropdown && !noticesOpenRef.current ? null : p;
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
        placeholder="Search songs, albums and artists"
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
      if (opts.noPicker) toastError(res?.error, `Couldn’t download “${row.title}”.`);
      else openPicker(meta, res, key);
    } catch (e) { markDl(key, 'failed'); toastError(e?.message || e, `Couldn’t download “${row.title}”.`); }
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
      toastError(res?.error, `Couldn’t download “${row.filename}”.`);
    } catch (e) { markDl(key, 'failed'); toastError(e?.message || e, `Couldn’t download “${row.filename}”.`); }
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
        if (res?.partial) pushToast?.({ message: res.error || `Some songs on “${alb.displayName || 'this album'}” couldn’t be downloaded.`, kind: 'warning', durationMs: 7000 });
      } else {
        markDl(key, 'failed');
        toastError(res?.error, `Couldn’t download “${alb.displayName || 'this album'}”.`);
      }
    } catch (e) { markDl(key, 'failed'); toastError(e?.message || e, `Couldn’t download “${alb.displayName || 'this album'}”.`); }
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
      const clean = String(str).split(/,(?=\s)|feat\.|ft\.|&|\bx\b/i)[0].trim();
      return clean || String(str).trim();
    };
    const map = new Map();
    for (const t of library) {
      const albName = (t.album || '').trim();
      const primary = primaryOf(t.artist);
      const key = albName ? `${albName.toLowerCase()}::${primary.toLowerCase()}` : '::singles';
      let g = map.get(key);
      if (!g) {
        g = { key, name: albName || 'Singles', artist: albName ? primary : 'Loose songs', tracks: [], newest: 0, isSingles: !albName };
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
      const clean = String(str).split(/,(?=\s)|feat\.|ft\.|&|\bx\b/i)[0].trim();
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
    // The side panel's Info tab, or the fullscreen view's.
    const infoShown = (npPanelOpen && npPanelTab === 'info') || (npFull && npFullTab === 'info');
    if (!infoShown || !currentTrack) return undefined;
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
          // [] means looked and found none; null means still looking.
          creditsCacheRef2.current.set(ck, rows);
          setPanelCredits(rows);
        }).catch(() => { if (!dead) setPanelCredits([]); });
      }
    } else setPanelCredits([]);
    return () => { dead = true; };
  }, [npPanelOpen, npPanelTab, npFull, npFullTab, currentTrack?.id, currentTrack?.artist, currentTrack?.title]);

  /* ---- Library rows ----------------------------------------------------
   * One list, sorted per view. Albums and Artists sort so that a record's
   * tracks stay together and in disc order — a flat title sort scatters them,
   * which is what the old card grid existed to avoid. */
  /* ---- Album / playlist detail -----------------------------------------
   * `libDetail` is what you drilled INTO, kept separate from `libView` (the
   * rail selection) so closing the detail returns you to the same list rather
   * than resetting the rail. */


  /* Sampled theme for the library wash. Same sampler + pageWash() clamp the
     album and playlist pages use, so the library's colour is produced the same
     way theirs is rather than by a second method that only looks similar. */
  const [npWashTheme, setNpWashTheme] = useState(null);
  const npWashSrc = currentTrack ? coverFor(currentTrack) : null;
  useEffect(() => {
    if (!npWashSrc) { setNpWashTheme(null); return undefined; }
    let dead = false;
    let retry = 0;
    /* A cover that couldn't be read comes back as a neutral grey. That's
       usually a moment's problem (the cover still downloading, a network
       blip), so it's read again rather than leaving the bar and the page
       grey for the whole song. */
    const read = (n) => sampleCoverTheme(npWashSrc).then((t) => {
      if (dead) return;
      if (isFallbackTheme(t) && n < 2) { retry = setTimeout(() => read(n + 1), 1500 * (n + 1)); return; }
      setNpWashTheme(t || null);
    }).catch(() => {});
    read(0);
    return () => { dead = true; clearTimeout(retry); };
  }, [npWashSrc]);
  /* The bar's colour, from the same sampled artwork and the same extraction
     the page uses. It read `.mid` directly before, which is the flat average —
     so with any extraction other than Average, the bar and the page behind it
     pulled different colours out of the same cover. */
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

  // The bar's menu item opens the color strip grown (see ColourStrip).
  const [colourStripReq, setColourStripReq] = useState(0);

  /* The color strip that pulls out of the bar on hover. The bar's hover goes
     through a subscription so it doesn't re-render this whole screen. */
  const [barHover] = useState(makeHoverSource);
  const [barSplash, setBarSplash] = useState(null);
  useEffect(() => {
    if (!barSplash) return undefined;
    const t = setTimeout(() => setBarSplash(null), 1250);
    return () => clearTimeout(t);
  }, [barSplash]);

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
     pageWash still runs afterwards as the text-contrast and saturation
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
  /* Dark mode stands in for every surface setting (see viewTheme), Immerse
     included: pages get the dark view of the theme, Settings the real one. */
  const dark = !!theme.darkMode;
  /* Dark mode: every floating layer (dialogs, menus, pickers, tooltips) takes
     the same #0a0a0b as the pages, the bar and the side panel. Most of them
     are portalled to <body>, outside the [data-dark] root, so the color goes
     on the document as a variable they fall back from. Light mode keeps
     each one's own color. */
  useEffect(() => {
    const r = document.documentElement.style;
    if (dark) r.setProperty('--st-dark-float', `rgb(${DARK.page})`);
    else r.removeProperty('--st-dark-float');
  }, [dark]);
  const vtheme = useMemo(() => viewTheme(theme), [theme]);
  const npAnim = npAnimatedBg && !dark;
  const immerse = npAnim && !!currentTrack;
  /* The top bar is the window's handle. Electron works its draggable area
     out from layout, and a slide done with a transform (compact mode's peek,
     entering and leaving compact) isn't a layout change: the area can stay
     wherever the bar was when the slide began, off screen, until something
     else lays the page out. So when a slide ends, the region is switched off
     for a frame and back on, which makes Electron measure it again. */
  const topbarRegion = chromeCompact && chromePeek !== 'top' ? 'no-drag' : 'drag';
  const topbarRegionRef = useRef(topbarRegion);
  topbarRegionRef.current = topbarRegion;
  const refreshDragRegion = useCallback((e) => {
    if (e.target !== e.currentTarget || topbarRegionRef.current !== 'drag') return;
    const el = e.currentTarget;
    el.style.setProperty('-webkit-app-region', 'no-drag');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.style.setProperty('-webkit-app-region', topbarRegionRef.current);
    }));
  }, []);
  // What Immerse listens to (VisualEffects, "One sky"): the playing song.
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
  libDetailRef.current = libDetail; // read by openRowMenu
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
  const [renamePl, setRenamePl] = useState(null);     // { id, name } | null
  /* Deleting a playlist is immediate: the toast's Undo brings it back
     (App's deletePlaylist), so there's nothing to confirm. */
  /* Menus for albums, playlists, artists and releases (built further down,
     in menuLive). The openers stay the same across renders. */
  const [objMenu, setObjMenu] = useState(null);   // { at, head, items } | null
  const menuLive = useRef(null);
  const openAlbumMenu = useCallback((e, src) => { e.preventDefault?.(); e.stopPropagation?.(); menuLive.current.album(e, src); }, []);
  const openPlaylistMenu = useCallback((e, id) => { e.preventDefault?.(); e.stopPropagation?.(); menuLive.current.playlist(e, id); }, []);
  const openArtistMenu = useCallback((e, a, image) => { e.preventDefault?.(); e.stopPropagation?.(); menuLive.current.artist(e, a, image); }, []);
  const openItemMenu = useCallback((e, item, extra) => { e.preventDefault?.(); e.stopPropagation?.(); menuLive.current.item(e, item, extra); }, []);
  const deletePlaylistNow = useCallback((id) => {
    onDeletePlaylist?.(id);
    setLibDetail((d) => (d?.kind === 'playlist' && d.key === id ? null : d));
  }, [onDeletePlaylist]);
  /* Taking a song out of a playlist is immediate too, with Undo putting it
     back where it was. The playlist as it is when you press Undo, so a change
     made since isn't lost. */
  const playlistsRef = useRef(playlists);
  playlistsRef.current = playlists;
  const removeFromPlaylistNow = useCallback(async (plId, trackId) => {
    const pl = (playlistsRef.current || []).find((p) => p.id === plId);
    const at = (pl?.trackIds || []).indexOf(trackId);
    const r = await onRemoveFromPlaylist?.(plId, trackId);
    if (r && r.ok === false) {
      pushToast?.({ message: `Couldn’t remove it from ${pl?.name || 'that playlist'}.`, kind: 'error' });
      return r;
    }
    pushToast?.({
      message: `Removed from ${pl?.name || 'playlist'}`,
      action: onAddTracksToPlaylist ? {
        label: 'Undo',
        onClick: async () => {
          const now = ((playlistsRef.current || []).find((p) => p.id === plId)?.trackIds || []).filter((id) => id !== trackId);
          const back = await onAddTracksToPlaylist(plId, [trackId]);
          if (back && back.ok === false) return;
          if (onReorderPlaylist && at >= 0 && at < now.length) {
            onReorderPlaylist(plId, [...now.slice(0, at), trackId, ...now.slice(at)]);
          }
        },
      } : null,
    });
    return r;
  }, [onRemoveFromPlaylist, onAddTracksToPlaylist, onReorderPlaylist, pushToast]);
  const [albumEditScope, setAlbumEditScope] = useState(null);  // AlbumMetadataEditor scope
  /* The Now Playing bar's playlist popover: { track, x, y, above }. */
  const [plPicker, setPlPicker] = useState(null);
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
       inside a name from punctuation between names.

       No bare "with": it's part of band names ("Sleeping With Sirens" was
       showing as "Sleeping"). */
    const SEP = /\s*(?:,(?=\s)|;|&|\bx\b|\b(?:feat|ft|featuring)\.?(?=\s|$))\s*/i;

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

  // Your albums open in search's album view (openLibAlbum, further down).
  const openLibAlbumRef = useRef(null);
  const openAlbumFromRow = useCallback((t) => {
    const key = albumKeyOf(t);
    if (!key || key === '::' || !(t.album || '').trim()) return;
    openLibAlbumRef.current?.(key, t);
  }, []);

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
    if (r?.ok) pushToast?.({ message: `Following ${artist.name}`, kind: 'success', durationMs: 3500, detail: 'Their new albums and singles show up in My Spotify → New Releases. This is Studio’s own follow. Nothing changes on Spotify.', log: false });
    else pushToast?.({ message: r?.error || `Couldn’t follow ${artist.name}`, kind: 'error', source: 'Follow' });
  }, [studioFollows, pushToast]);

  /* Auto-follow (Settings → Library): an artist with more than 5 songs in
     the library is followed in Studio, so their releases and countdowns
     show up. Each artist is tried once and remembered (studio:autoFollowed),
     so unfollowing one sticks; one Spotify couldn't find is tried again a
     day later. One pass at a time works through every artist due, a few
     seconds apart, with one toast for the lot. The library changing while a
     pass runs (an import saving in batches) doesn't stop it: the pass picks
     up the newly due artists once it's through the ones it has. */
  const autoFollowOn = theme.autoFollow !== false;
  const autoFollowKey = useMemo(() => libArtists
    .filter((a) => (a.tracks?.length || 0) > 5)
    .map((a) => a.name).sort().join('|'), [libArtists]);
  const autoFollowLive = useRef({});
  autoFollowLive.current = { on: autoFollowOn, artists: libArtists, follows: studioFollows };
  const autoFollowRun = useRef({ running: false, again: false, stopped: false });
  useEffect(() => {
    // Set on every mount: StrictMode mounts, unmounts and mounts again.
    autoFollowRun.current.stopped = false;
    return () => { autoFollowRun.current.stopped = true; };
  }, []);
  useEffect(() => {
    if (!autoFollowOn || !autoFollowKey) return;
    const run = autoFollowRun.current;
    if (run.running) { run.again = true; return; }
    run.running = true;
    const DAY = 24 * 60 * 60 * 1000;
    const due = (log, done) => {
      const { artists, follows } = autoFollowLive.current;
      return artists
        .filter((a) => (a.tracks?.length || 0) > 5 && a.name && !done.has(a.name.toLowerCase()))
        .filter((a) => !isStudioFollowed({ name: a.name }, follows))
        .filter((a) => { const e = log[a.name.toLowerCase()]; return !e || (!e.ok && Date.now() - e.at > DAY); })
        .sort((x, y) => y.tracks.length - x.tracks.length);
    };
    (async () => {
      await new Promise((res) => { setTimeout(res, 4000); });
      let log = {};
      try { log = JSON.parse(localStorage.getItem('studio:autoFollowed') || '{}') || {}; } catch { log = {}; }
      const followed = [];
      const done = new Set();
      for (;;) {
        run.again = false;
        const todo = due(log, done);
        if (!todo.length) break;
        for (const a of todo) {
          if (run.stopped || !autoFollowLive.current.on) break;
          done.add(a.name.toLowerCase());
          const r = await followArtist({ name: a.name }).catch(() => null);
          log[a.name.toLowerCase()] = { at: Date.now(), ok: !!r?.ok };
          try { localStorage.setItem('studio:autoFollowed', JSON.stringify(log)); } catch { /* ignore */ }
          if (r?.ok) followed.push(a.name);
          await new Promise((res) => { setTimeout(res, 2500); });
        }
        if (run.stopped || !autoFollowLive.current.on || !run.again) break;
      }
      run.running = false;
      if (followed.length && !run.stopped) {
        const names = followed.length > 12 ? `${followed.slice(0, 12).join(', ')} and ${followed.length - 12} more` : followed.join(', ');
        pushToast?.({
          message: followed.length === 1 ? `Following ${followed[0]}` : `Following ${followed.length} artists you listen to`,
          detail: `${names}. You have more than 5 of their songs, so their new releases show up in New Releases. Turn this off in Settings → Library.`,
          kind: 'success', durationMs: 6000, log: false,
        });
      }
    })();
  }, [autoFollowOn, autoFollowKey]); // eslint-disable-line react-hooks/exhaustive-deps

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
    /* Without a cover of its own a playlist shows four of the albums in it
       (RecordPage draws the same four), so its colours come from all four. */
    let mosaic = null;
    if (!pl.coverArt) {
      const seen = [];
      for (const t of tracks) {
        const a = coverFor(t);
        if (a && !seen.includes(a)) seen.push(a);
        if (seen.length === 4) break;
      }
      if (seen.length === 4) mosaic = seen;
    }
    return { kind: 'playlist', title: pl.name, by: 'You', customArt: !!pl.coverArt, art: pl.coverArt || tracks[0] ? (pl.coverArt || coverFor(tracks[0])) : null, mosaic, tracks };
  }, [libDetail, libAlbums, playlists, library, coverFor]);

  /* Page wash, sampled from the open record's cover. Same sampler the
     fullscreen stage use, so there's no second colour system —
     and it means a record page carries the record's identity instead of the
     flat black every other view uses. */
  const [detailTheme, setDetailTheme] = useState(null);
  const detailMosaicKey = detailData?.mosaic ? detailData.mosaic.join('\n') : '';
  useEffect(() => {
    const art = detailData?.art;
    if (!art) { setDetailTheme(null); return undefined; }
    let dead = false;
    /* A four-cover playlist: the page is washed in the first cover's colour
       (it's top left), and its palette, which the layouts spread around the
       page, takes the main colour of each of the four. */
    const tiles = detailMosaicKey ? detailMosaicKey.split('\n') : [art];
    Promise.all(tiles.map((src) => sampleCoverTheme(src).catch(() => null))).then((themes) => {
      if (dead) return;
      const [first] = themes;
      if (!first || themes.length < 2) { setDetailTheme(first || null); return; }
      const main = themes.map((t) => recordWashSource(t)).filter(Boolean);
      setDetailTheme({ ...first, palette: main.length ? main : first.palette });
    });
    return () => { dead = true; };
  }, [detailData?.art, detailMosaicKey]);

  /** Tracks after the in-page filter. */
  const detailTracks = useMemo(() => {
    const list = detailData?.tracks || [];
    const q = detailFilter.trim().toLowerCase();
    if (!q) return list;
    return list.filter((t) => `${t.title || ''} ${t.artist || ''} ${t.album || ''}`.toLowerCase().includes(q));
  }, [detailData, detailFilter]);

  /* Moving a song within a playlist (drag on its page, or Move up / Move
     down from the menu). Off while the page is filtered: the rows on screen
     aren't the playlist's order then. */
  const movePlaylistSong = useCallback((playlistId, trackId, to) => {
    const pl = playlists.find((p) => p.id === playlistId);
    if (!pl || !onReorderPlaylist) return;
    const ids = [...(pl.trackIds || [])];
    const from = ids.indexOf(trackId);
    if (from < 0 || to < 0 || to >= ids.length || from === to) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    onReorderPlaylist(playlistId, ids);
  }, [playlists, onReorderPlaylist]);
  const moveInOpenPlaylist = useMemo(() => (
    libDetail?.kind === 'playlist' && onReorderPlaylist && !detailFilter.trim()
      ? (trackId, to) => movePlaylistSong(libDetail.key, trackId, to)
      : null
  ), [libDetail, onReorderPlaylist, detailFilter, movePlaylistSong]);

  const libTitle = useMemo(() => {
    if (libView.startsWith('pl:')) {
      const pl = playlists.find((x) => x.id === libView.slice(3));
      return pl?.name || 'Playlist';
    }
    return (LIB_VIEWS.find(([id]) => id === libView) || [, 'Library'])[1];
  }, [libView, playlists]);
  /* Where a song played from this list comes from, for the bar. */
  const libSource = useMemo(() => (
    libView.startsWith('pl:') ? { kind: 'playlist', lib: true, id: libView.slice(3), name: libTitle } : null
  ), [libView, libTitle]);
  libSourceRef.current = libSource;

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
    // live target is just clutter. While searching it stays (letters with no
    // match dim), so the columns don't shift as you type.
    return map.size > 1 || libFilter.trim() ? map : null;
  }, [libRows, libSortField, libFilter]);

  /** Relative "date added" — absolute dates read as noise in a dense table.
   *  added_at is stored by SQLite as strftime('%s','now'), i.e. SECONDS. Read
   *  as milliseconds every row lands in 1970 and reports "56 yr ago". Values
   *  below ~1e11 are unambiguously seconds (that ceiling is year 5138 in
   *  seconds, but only 1973 in ms), so scale those up. */
  const fmtAdded = useCallback((raw) => {
    // Not known: left blank rather than a dash.
    if (!raw) return '';
    const ms = raw < 1e11 ? raw * 1000 : raw;
    const d = Math.floor((Date.now() - ms) / 86400000);
    if (d <= 0) return 'Today';
    if (d === 1) return 'Yesterday';
    if (d < 30) return `${d} days ago`;
    if (d < 365) return `${Math.floor(d / 30)} mo ago`;
    return `${Math.floor(d / 365)} yr ago`;
  }, []);

  const [newPlaylist, setNewPlaylist] = useState(null);   // { name } | null
  const [plAddMenu, setPlAddMenu] = useState(null);       // the sidebar's + menu: { left, top } | null

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
   * The Now Playing bar's add-to-playlist button. One click files the song:
   * a playlist without it gets it, one with it (ticked) loses it, and the
   * picker closes. The song menu's Add to playlist works the same way.
   */
  const openPlaylistPicker = useCallback((track, anchor) => {
    if (!track) return;
    /* Anchored, not centred. This is a menu — it belongs beside the control
       that opened it, the way the row menu does. A centred dialog over a
       dimmed screen is the right shape for something that interrupts you;
       filing a song does not, and the backdrop hid the very library you were
       filing it from. `anchor` is { x, y, above }, in the same terms the row
       menu uses, so a picker opened FROM that menu lands exactly where it
       was standing. */
    setPlPicker({ track, ...(anchor || {}) });
  }, []);

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

  /* The song as a library copy to file: a song you're only streaming is
     saved first (it plays through your account; nothing is downloaded). */
  const libCopyFor = useCallback(async (track) => {
    if (!track?.streamOnly) return track;
    const sid = spotifyIdOf(track);
    if (!sid) return null;
    return downloadSpotifyRow({ spotifyId: sid, title: track.title, artists: track.artist, album: track.album || '', albumArtUrl: track.coverArt || '', durationMs: (track.duration || 0) * 1000, explicit: !!track.explicit }, { noPicker: true });
  }, [downloadSpotifyRow]);

  /* One click files it: a playlist without the song gets it, one with it
     (ticked) loses it, and the picker closes. */
  const pickPlaylistNow = useCallback(async (id) => {
    const cur = plPicker;
    if (!cur) return;
    const pl = (playlists || []).find((p) => p.id === id);
    const has = (pl?.trackIds || []).includes(cur.track.id);
    setPlPicker(null);
    if (has) {
      await removeFromPlaylistNow(id, cur.track.id);
      return;
    }
    const song = await libCopyFor(cur.track);
    if (!song) return;
    const r = await onAddTracksToPlaylist?.(id, [song.id]);
    pushToast?.(r && r.ok === false ? { message: `Couldn’t add it to ${pl?.name || 'that playlist'}.`, kind: 'error' } : { message: `Added to ${pl?.name || 'playlist'}` });
  }, [plPicker, playlists, onAddTracksToPlaylist, removeFromPlaylistNow, pushToast, libCopyFor]);

  /* A new playlist from the picker, with the song already in it. */
  const createFromPlPicker = useCallback(async (typed) => {
    const name = String(typed || '').trim();
    const cur = plPicker;
    if (!name || !cur) return;
    setPlPicker(null);
    const r = await onCreatePlaylist?.({ name });
    if (!r?.ok || !r.id) { pushToast?.({ message: 'Couldn’t create that playlist.', kind: 'error' }); return; }
    const song = await libCopyFor(cur.track);
    if (song) await onAddTracksToPlaylist?.(r.id, [song.id]);
    pushToast?.({ message: `Added to ${name}` });
  }, [plPicker, onCreatePlaylist, onAddTracksToPlaylist, pushToast, libCopyFor]);
  /* Add to Playlist for any set of your songs (an album, a playlist, an
     artist's), as the list beside its menu. A playlist with all of them is
     ticked; one with some gets the rest. One song toggles, as in the song
     menu. */
  const libById = useMemo(() => new Map(library.map((t) => [t.id, t])), [library]);
  const plArt = useCallback((pl) => {
    if (pl.coverArt) return pl.coverArt;
    const first = pl.trackIds?.length ? libById.get(pl.trackIds[0]) : null;
    return first ? coverFor(first) : null;
  }, [libById, coverFor]);
  const pickerFor = useCallback((ids, { exclude = null } = {}) => {
    const list = (ids || []).filter(Boolean);
    const stateOf = (pl) => {
      const have = new Set(pl.trackIds || []);
      const n = list.filter((id) => have.has(id)).length;
      return list.length && n === list.length ? 'all' : n ? 'some' : 'none';
    };
    const addTo = async (plId, name) => {
      const pl = (playlistsRef.current || []).find((x) => x.id === plId);
      const have = new Set(pl?.trackIds || []);
      const missing = list.filter((id) => !have.has(id));
      if (!missing.length) return;
      const r = await onAddTracksToPlaylist?.(plId, missing);
      pushToast?.(r && r.ok === false
        ? { message: `Couldn’t add ${missing.length === 1 ? 'it' : 'them'} to ${name}.`, kind: 'error' }
        : { message: missing.length === 1 ? `Added to ${name}` : `Added ${missing.length} songs to ${name}` });
    };
    return {
      playlists: (playlists || []).filter((pl) => pl.id !== exclude),
      artFor: plArt,
      multi: list.length > 1,
      stateOf,
      onPick: (pl) => {
        const st = stateOf(pl);
        if (st === 'all') {
          if (list.length === 1) removeFromPlaylistNow(pl.id, list[0]);
          else pushToast?.({ message: `Already in ${pl.name}` });
          return;
        }
        addTo(pl.id, pl.name);
      },
      onCreate: onCreatePlaylist ? async (name) => {
        const r = await onCreatePlaylist({ name });
        if (!r?.ok || !r.id) { pushToast?.({ message: 'Couldn’t create that playlist.', kind: 'error' }); return; }
        const res = await onAddTracksToPlaylist?.(r.id, list);
        pushToast?.(res && res.ok === false ? { message: `Couldn’t add ${list.length === 1 ? 'it' : 'them'} to ${name}.`, kind: 'error' } : { message: `Added to ${name}` });
      } : null,
    };
  }, [playlists, plArt, onAddTracksToPlaylist, onCreatePlaylist, removeFromPlaylistNow, pushToast]);
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
    || ownedTrackFor(row.title, row.artists, row.album || '')
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
  const favorites = useMemo(() => library.filter((t) => t.isFavorite), [library]);
  /* A song playing straight from Spotify (a copied link, My Spotify) isn't in
     the library: the bar offers Save, and once it's saved, the heart and
     add-to-playlist act on its library row. */
  const npSid = currentTrack?.streamOnly ? spotifyIdOf(currentTrack) : null;
  const npSaved = npSid ? libBySpotifyId.get(npSid) || null : null;
  const npSaveBusy = !!npSid && dlState[`s:${npSid}`] === 'busy';
  const npSaveFailed = !!npSid && dlState[`s:${npSid}`] === 'failed';

  /* ---- Keyboard shortcuts ------------------------------------------------
   * Matched against the one list in Shortcuts.jsx, which is also what the
   * Keyboard shortcuts window shows. Search, fullscreen, compact mode, Ctrl+V
   * and Esc keep the handlers they already had above; this is the rest. The
   * actions are read through a ref so the listener is bound once. */
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useEffect(() => {
    const open = () => setShortcutsOpen(true);
    window.addEventListener(OPEN_SHORTCUTS_EVENT, open);
    return () => window.removeEventListener(OPEN_SHORTCUTS_EVENT, open);
  }, []);
  const lastVolume = useRef(1);
  const shortcutActs = useRef({});
  const favTarget = npSaved || (currentTrack && !currentTrack.streamOnly ? currentTrack : null);
  shortcutActs.current = {
    play: () => currentTrack && onTogglePlay?.(),
    next: () => currentTrack && onNext?.(),
    prev: () => currentTrack && onPrev?.(),
    forward: () => currentTrack && duration > 0 && onSeek?.(Math.min(duration - 1, getPlaybackTime() + 10)),
    back: () => currentTrack && onSeek?.(Math.max(0, getPlaybackTime() - 10)),
    volumeUp: () => onSetVolume?.(Math.min(1, Math.round((volume + 0.05) * 100) / 100)),
    volumeDown: () => onSetVolume?.(Math.max(0, Math.round((volume - 0.05) * 100) / 100)),
    mute: () => {
      if (volume > 0) { lastVolume.current = volume; onSetVolume?.(0); } else onSetVolume?.(lastVolume.current || 0.5);
    },
    shuffle: () => onToggleShuffle?.(),
    repeat: () => onToggleRepeat?.(),
    favorite: () => favTarget && onToggleFavorite?.(favTarget.id),
    // In fullscreen, Q, L and I switch its own tabs (the handler above).
    queue: () => currentTrack && !npFull && toggleNpPanel('queue'),
    clearQueue: () => clearUpNext?.(),
    lyrics: () => currentTrack && !npFull && toggleNpPanel('lyrics'),
    info: () => currentTrack && !npFull && toggleNpPanel('info'),
    copyLink: () => currentTrack && copySpotifyLink(currentTrack),
    darkMode: () => setThemeKey('darkMode', !dark),
    immerse: () => !dark && toggleNpAnimatedBg(),
    colour: () => currentTrack && !dark && !npFull && setColourStripReq((n) => n + 1),
    settings: () => { setNpFull(false); pickSection('settings'); },
    shortcuts: () => setShortcutsOpen((v) => !v),
  };
  useEffect(() => {
    /* Which control the pointer last pressed. The browser's own "focused from
       the keyboard" signal can't tell: right after any key press it reports
       a clicked button as keyboard-focused too. */
    const PRESSABLE = 'button, a, [role="button"], [role="menuitem"], [role="tab"], [role="radio"], [role="switch"], [role="option"]';
    let pressed = null;
    const onPointer = (e) => { pressed = e.target?.closest?.(PRESSABLE) || null; };
    const onKey = (e) => {
      if (e.key === 'Tab') pressed = null;
      if (e.defaultPrevented) return;
      const it = shortcutFor(e);
      const act = it && shortcutActs.current[it.id];
      if (!act) return;
      const el = e.target;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName || '') || el?.isContentEditable;
      if (typing && !worksWhileTyping(it)) return;
      if (e.repeat && !it.repeat) { e.preventDefault(); return; }
      /* Space on a control you tabbed to presses it, as it should. On one
         you last clicked, it plays or pauses: clicking leaves focus behind,
         and Space doing that button again is never what's meant. */
      const control = it.id === 'play' ? el?.closest?.(PRESSABLE) : null;
      if (control) {
        if (control !== pressed) return;
        control.blur?.();
        // The press itself lands on keyup; stop that one too.
        window.addEventListener('keyup', (u) => { if (u.key === ' ') u.preventDefault(); }, { capture: true, once: true });
      }
      e.preventDefault();
      act();
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onPointer, true); window.removeEventListener('keydown', onKey); };
  }, []);
  const saveCurrentToLibrary = useCallback((t) => {
    const sid = spotifyIdOf(t);
    if (!sid) return;
    downloadSpotifyRow({
      spotifyId: sid, title: t.title || '', artists: t.artist || '', album: t.album || '',
      albumArtUrl: typeof t.coverArt === 'string' && /^https?:/.test(t.coverArt) ? t.coverArt : '',
      durationMs: Math.round((t.duration || 0) * 1000), explicit: !!t.explicit,
    }, { noPicker: true }).then((saved) => {
      // A failure says so itself (downloadSpotifyRow's error toast).
      if (saved) pushToast?.({ message: `Saved “${t.title || 'the song'}” to your library.`, kind: 'success', durationMs: 3500, log: false });
    });
  }, [downloadSpotifyRow, pushToast]);
  /* An album, playlist or countdown from Home, a Spotify link, Go to album
     or the bar's Playing From: search's album view, opened straight onto it
     (recordFor). Your own albums open there too (libAlbumRecord). */
  const [paletteRecord, setPaletteRecord] = useState(null);
  const openRecord = useCallback((item) => { setPaletteRecord(recordFor(item)); setPaletteOpen(true); }, []);
  /* One of your albums as a record for that view: your copies, in order,
     playing as your library does (local files included). With Album Songs
     on Whole Album it's the whole album from Spotify, your copies where you
     have them and the rest ready to get. A new id each time, so an edit
     since it was last open shows. */
  const libOpenSeq = useRef(0);
  /* `src` is an album key (libAlbums, or a one-song album it leaves out) or
     a group of your songs (an artist page's single). */
  const libAlbumRecord = useCallback((src, focusTrack = null) => {
    const a = (() => {
      if (src && typeof src === 'object' && Array.isArray(src.tracks)) {
        const credit = src.tracks.map((t) => String(t.artist || '').trim()).filter(Boolean).sort((x, y) => x.length - y.length)[0] || '';
        return { key: src.key, name: src.name, artist: src.artist || credit, art: src.art || coverFor(src.tracks[0]) || null, tracks: src.tracks };
      }
      const hit = libAlbums.find((x) => x.key === src);
      if (hit) return hit;
      const tracks = src && src !== '::' ? library.filter((t) => (t.album || '').trim() && albumKeyOf(t) === src) : [];
      if (!tracks.length) return null;
      tracks.sort((x, y) => (x.discNumber || 1) - (y.discNumber || 1) || (x.trackNumber || 0) - (y.trackNumber || 0));
      return { key: src, name: tracks[0].album.trim(), artist: String(tracks[0].artist || '').trim(), art: coverFor(tracks[0]) || null, tracks };
    })();
    if (!a) return null;
    const key = a.key;
    const row = (t) => ({
      title: t.title || '', artists: t.artist || '', album: t.album || a.name, trackNumber: t.trackNumber || null,
      durationMs: Math.round((Number(t.duration) || 0) * 1000), explicit: !!t.explicit,
      spotifyId: spotifyIdOf(t) || undefined, albumArtUrl: coverFor(t) || a.art || '', libTrack: t,
    });
    const years = a.tracks.map((t) => Number(t.year)).filter((y) => y > 1000);
    libOpenSeq.current += 1;
    return {
      focusId: focusTrack ? (spotifyIdOf(focusTrack) || `lib:${focusTrack.id}`) : null,
      album: {
        albumId: `lib:${key}:${libOpenSeq.current}`, name: a.name, artists: a.artist || '', albumArtUrl: a.art || '',
        releaseDate: years.length ? String(Math.max(...years)) : '', label: a.tracks.length === 1 ? 'Single' : 'Album', collection: false, lib: true,
        load: async () => {
          if (theme.albumSongs === 'full') {
            const merged = mergeAlbum(await fullAlbumRows(key, a.name, a.artist).catch(() => null), a.tracks);
            if (merged) return merged.map((x) => (x.lib ? row(x.lib) : x.row));
          }
          return a.tracks.map(row);
        },
        /* Plays from the song picked: your copies as your library does, the
           rest streamed. */
        play: (rows, index = 0, shuffle = false) => {
          const want = rows[index];
          const live = rows.filter((r) => !r.notOut);
          const list = live.map((r) => r.libTrack || spotifyPlayable(r));
          if (!list.length) return;
          const from = { kind: 'album', lib: true, key, name: a.name };
          if (shuffle) { const sh = [...list].sort(() => Math.random() - 0.5); onPlayTrack?.(sh[0], sh, 'list', from); return; }
          const at = Math.max(0, live.indexOf(want));
          onPlayTrack?.(list[at], list, 'list', from);
        },
        edit: onUpdateAlbumMetadata ? () => {
          setPaletteOpen(false);
          setAlbumEditScope({
            key, album: a.name, artist: a.artist, coverArt: a.art, sampleTrack: a.tracks[0],
            trackIds: a.tracks.map((t) => t.id), discNumber: null,
          });
        } : null,
      },
    };
  }, [libAlbums, library, coverFor, theme.albumSongs, onPlayTrack, onUpdateAlbumMetadata, spotifyPlayable]);
  const openLibAlbum = useCallback((src, focusTrack = null) => {
    const rec = libAlbumRecord(src, focusTrack);
    if (!rec) return;
    setPaletteRecord(rec);
    setPaletteOpen(true);
  }, [libAlbumRecord]);
  openLibAlbumRef.current = openLibAlbum;
  /* One of your playlists in the album view, where it gets the playlist
     design. Its songs follow the playlist while it's open (libPlaylistLive):
     a song moved, removed or added shows straight away. */
  const libPlaylistRows = useCallback((id) => {
    const pl = playlists.find((p) => p.id === id);
    if (!pl) return [];
    return (pl.trackIds || []).map((tid) => libById.get(tid)).filter(Boolean).map((t) => ({
      title: t.title || '', artists: t.artist || '', album: t.album || '', durationMs: Math.round((Number(t.duration) || 0) * 1000),
      explicit: !!t.explicit, spotifyId: spotifyIdOf(t) || undefined, albumArtUrl: coverFor(t) || '', libTrack: t,
    }));
  }, [playlists, libById, coverFor]);
  /* The record outlives this render, so what it calls later reads the
     playlists as they are then. */
  const libPlaylistRowsRef = useRef(libPlaylistRows);
  libPlaylistRowsRef.current = libPlaylistRows;
  const movePlaylistSongRef = useRef(movePlaylistSong);
  movePlaylistSongRef.current = movePlaylistSong;
  const libPlaylistRecord = useCallback((id, focusTrack = null) => {
    const pl = playlists.find((p) => p.id === id);
    if (!pl) return null;
    const from = { kind: 'playlist', lib: true, id, name: pl.name };
    return {
      focusId: focusTrack ? (spotifyIdOf(focusTrack) || `lib:${focusTrack.id}`) : null,
      album: {
        albumId: `libpl:${id}`, name: pl.name, artists: 'You', albumArtUrl: pl.coverArt || '', label: 'Playlist',
        collection: true, playlist: true, lib: true, playlistId: id, context: from,
        empty: 'Nothing in this playlist yet. Add songs from any song’s menu.',
        load: async () => libPlaylistRowsRef.current(id),
        play: (rows, index = 0, shuffle = false) => {
          const want = rows[index];
          const list = rows.map((r) => r.libTrack).filter(Boolean);
          if (!list.length) return;
          if (shuffle) { const sh = [...list].sort(() => Math.random() - 0.5); onPlayTrack?.(sh[0], sh, 'list', from); return; }
          onPlayTrack?.(want?.libTrack || list[0], list, 'list', from);
        },
        /* Dropped on the song at `row` in the list: its place in the playlist
           (the list leaves out any song no longer in your library). */
        move: onReorderPlaylist ? (trackId, row) => {
          const target = libPlaylistRowsRef.current(id)[row]?.libTrack?.id;
          const now = playlistsRef.current.find((p) => p.id === id);
          const to = target && now ? (now.trackIds || []).indexOf(target) : -1;
          if (to >= 0) movePlaylistSongRef.current(id, trackId, to);
        } : null,
        // Edited right in the view: its name, cover and songs, or the whole playlist gone.
        editor: {
          rename: onRenamePlaylist ? (name) => onRenamePlaylist(id, name) : null,
          setCover: onUpdatePlaylist ? (coverArt) => onUpdatePlaylist(id, { coverArt }) : null,
          remove: onRemoveFromPlaylist ? (trackId) => removeFromPlaylistNow(id, trackId) : null,
          del: onDeletePlaylist ? () => { setPaletteOpen(false); deletePlaylistNow(id); } : null,
        },
      },
    };
  }, [playlists, onPlayTrack, onReorderPlaylist, onRenamePlaylist, onUpdatePlaylist, onRemoveFromPlaylist, onDeletePlaylist, removeFromPlaylistNow, deletePlaylistNow]);
  const openLibPlaylist = useCallback((id, focusTrack = null) => {
    const rec = libPlaylistRecord(id, focusTrack);
    if (!rec) return;
    setPaletteRecord(rec);
    setPaletteOpen(true);
  }, [libPlaylistRecord]);
  // The open playlist's songs as they are now.
  const openPlId = paletteOpen ? paletteRecord?.album?.playlistId || null : null;
  const libPlaylistLive = useMemo(() => {
    const pl = openPlId ? playlists.find((p) => p.id === openPlId) : null;
    return pl ? { albumId: `libpl:${pl.id}`, tracks: libPlaylistRows(pl.id), name: pl.name, albumArtUrl: pl.coverArt || '' } : null;
  }, [openPlId, playlists, libPlaylistRows]);
  /* How the album view looks until you pick one in it: what your settings
     give the rest of the app (Dark mode, Immerse, or Library pages on Cover
     Art or Full Color). */
  const albumLook = theme.darkMode ? 'dark' : npAnim ? 'immerse'
    : vtheme.pageSurface === 'coverFull' ? 'full' : vtheme.pageSurface === 'off' ? 'dark' : 'color';
  /* Where the song playing came from, for the bar's link back to it and
     the bar menu's Go to item. Opens with the song picked out. */
  const npFrom = playSource && currentTrack && playSource.ids.has(currentTrack.id) ? playSource.item : null;
  /* The album a song is on: your copy's album when you have the album;
     otherwise the album itself, shown in the album view with this song
     picked out. Its Spotify id comes from the song when it carries one,
     else from the song's own Spotify entry, else from Spotify's albums by
     name. `row` is the Spotify row the song came from, when there is one. */
  const openTrackAlbum = useCallback(async (t, { row = null, saved = null } = {}) => {
    if (!t) return;
    const have = saved ?? (libById.has(t.id) && !t.streamOnly);
    if (have && (t.album || '').trim() && albumKeyOf(t) !== '::') { openLibAlbum(albumKeyOf(t), t); return; }
    const sid = row?.spotifyId || t.spotifyId || spotifyIdOf(t) || null;
    const artistName = row ? String(row.artists || '').split(', ')[0] : primaryArtistOf(t);
    const albumName = row?.album || t.album || '';
    const show = (id, name, image) => openRecord({
      kind: 'album', id, name: name || albumName, image: image || row?.albumArtUrl || coverFor(t) || null,
      sub: artistName ? `Album · ${artistName}` : '', focusId: sid || null,
    });
    const knownId = row?.albumId || t.albumId || null;
    if (knownId) { show(knownId); return; }
    const api = window.electronAPI;
    if (sid && api?.spotifyLinkResolve) {
      const info = await api.spotifyLinkResolve(`spotify:track:${sid}`).catch(() => null);
      if (info?.album?.id) { show(info.album.id, info.album.name, info.album.image); return; }
    }
    if (albumName && api?.spotifySearchAlbums) {
      const norm = (x) => String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
      const hits = await api.spotifySearchAlbums(`${albumName} ${artistName}`.trim()).catch(() => []);
      const list = Array.isArray(hits) ? hits : [];
      const named = list.filter((h) => norm(h.name) === norm(albumName));
      const hit = named.find((h) => !artistName || norm(h.artists).includes(norm(artistName))) || named[0];
      if (hit?.albumId) { show(hit.albumId, hit.name, hit.albumArtUrl); return; }
    }
    pushToast?.({ message: `Couldn’t find ${albumName ? `“${albumName}”` : 'this album'} on Spotify.`, kind: 'error', durationMs: 4000, log: false });
  }, [libById, openLibAlbum, openRecord, coverFor, pushToast]);
  /* Opens a source: a Spotify album, playlist or mix in the album view, or
     one of your own albums (album view), playlists or artists (their page).
     `focus` is the song to pick out where the view can. */
  const openSource = useCallback((item, focus = null) => {
    if (!item) return;
    if (item.lib && item.kind === 'album') { openLibAlbum(item.key, focus); return; }
    if (item.lib && item.kind === 'playlist') { openLibPlaylist(item.id, focus); return; }
    if (item.lib && item.kind === 'artist') { setPaletteOpen(false); openArtistAnywhere({ name: item.name }); return; }
    if (item.songAlbum) { openTrackAlbum(focus); return; }
    openRecord({ ...item, focusId: spotifyIdOf(focus) || null });
  }, [openLibAlbum, openLibPlaylist, openRecord, openArtistAnywhere, openTrackAlbum]);
  /* What the bar shows after the artist: the playlist or album the song is
     playing from, or else the album the song is on. A source is left out
     when it says nothing the bar doesn't already: an artist's Popular songs
     would read "Frank Ocean · Frank Ocean", and a one-song release would
     repeat the song's own title. */
  const npFromShown = useMemo(() => {
    if (!currentTrack) return null;
    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    const artists = String(currentTrack.artist || '').split(/\s*(?:,|&|\bfeat\.?|\bft\.?)\s*/i);
    const says = (name) => !!String(name || '').trim() && !same(name, currentTrack.title)
      && !same(name, currentTrack.artist) && !artists.some((a) => same(a, name));
    if (npFrom && says(npFrom.name)) return npFrom;
    const album = String(currentTrack.album || '').trim();
    return says(album) ? { kind: 'album', songAlbum: true, name: album } : null;
  }, [npFrom, currentTrack]);
  const openFrom = useCallback(() => {
    if (npFromShown) openSource(npFromShown, currentTrack);
  }, [npFromShown, currentTrack, openSource]);
  /* The queue's "Next from" link: the same view the bar's link opens. */
  const openQueueSource = useCallback((item) => openSource(item), [openSource]);
  const mySpotifyBridge = useMemo(() => {
    const saveState = (row) => {
      if (libBySpotifyId.has(row.spotifyId) || ownedTrackFor(row.title, row.artists, row.album || '')) return 'saved';
      const st = dlState[`s:${row.spotifyId}`];
      return st === 'busy' ? 'busy' : st === 'done' ? 'saved' : null;
    };
    const currentSid = spotifyIdOf(currentTrack);
    return {
      playRows(rows, index = 0, { shuffle = false, context = null, source = null } = {}) {
        /* Songs Spotify lists but hasn't released (notOut) are skipped:
           playing one only fails. Clicking one does nothing. */
        const want = (rows || [])[index];
        if (!shuffle && want?.notOut) return;
        const spotifyRows = (rows || []).filter((r) => r?.spotifyId && !r.notOut);
        notePlayContext(spotifyRows, context);
        const list = spotifyRows.map(spotifyPlayable);
        if (!list.length) return;
        /* What the bar links back to: the page it was played from, or a
           search album, which isn't a play context for Home's history. */
        const from = context || source || null;
        if (shuffle) {
          const mixed = [...list].sort(() => Math.random() - 0.5);
          onPlayTrack?.(mixed[0], mixed, 'list', from);
        } else {
          const at = spotifyRows.indexOf(want);
          onPlayTrack?.(list[at >= 0 ? at : Math.min(index, list.length - 1)] || list[0], list, 'list', from);
        }
      },
      // Not out yet: nothing to save.
      saveRow(row) { if (!row?.notOut && !saveState(row)) downloadSpotifyRow(row, { noPicker: true }); },
      saveState,
      // An album, playlist or countdown, opened in search's album view.
      openRecord,
      /* Shuffle Liked Songs: the songs you've hearted in Studio, not
         Spotify's Liked Songs. */
      likedCount: favorites.length,
      shuffleLiked() {
        if (!favorites.length) return;
        const mixed = [...favorites].sort(() => Math.random() - 0.5);
        onPlayTrack?.(mixed[0], mixed);
      },
      /* The row's song is playing: streamed, or your own copy of it (which
         is what playRows plays when you have one, via spotifyPlayable). */
      isCurrent: (row) => !!currentTrack && !!row?.spotifyId && (
        currentSid === row.spotifyId || currentTrack.spotifyId === row.spotifyId
        || spotifyPlayable(row).id === currentTrack.id),
      isPlaying: !!isPlaying,
      onOpenArtist: openArtistAnywhere,
      // Right-click on a Spotify row: the song menu (play, queue, playlists…).
      openMenu: (e, row) => openSongMenu(e, { row }),
      // An album, playlist or mix: its menu (Play, Play Next, Save, …).
      openItemMenu,
      onConnect: () => { pickSection('settings'); setSetCat('connections'); },
    };
  }, [libBySpotifyId, ownedTrackFor, dlState, favorites, currentTrack, isPlaying, spotifyPlayable, onPlayTrack, downloadSpotifyRow, openArtistAnywhere, pickSection, openSongMenu, openRecord, openItemMenu]);

  /* ---------- Spotify links (spotifyLinks.js) ----------------------------
     Ctrl+V anywhere in Studio, or pasting into search, opens a Spotify link;
     one copied in another app is offered in a notification. A song plays
     and its album opens with it marked; an album or playlist opens in the
     side panel; an artist opens their page. */
  const openSpotifyLink = useCallback((info, { play = true } = {}) => {
    if (!info?.id) {
      pushToast?.({ message: 'Couldn’t open that Spotify link.', kind: 'error', durationMs: 4000, dedupeKey: 'spotify-link', log: false });
      return;
    }
    setPaletteOpen(false);
    if (info.kind === 'artist') {
      openArtistAnywhere({ name: info.name, spotifyId: info.id, image: info.image || null });
      return;
    }
    if (info.kind === 'album' || info.kind === 'playlist') {
      openRecord({ kind: info.kind, id: info.id, name: info.name || 'Spotify', image: info.image || null, sub: info.sub || '', label: info.kind === 'album' ? 'Album' : 'Playlist', rows: info.rows || null });
      return;
    }
    // A song: play it, and open its album with it marked.
    if (play && info.rows?.length) mySpotifyBridge.playRows(info.rows, 0);
    if (info.album?.id) {
      openRecord({ kind: 'album', id: info.album.id, name: info.album.name || info.name, image: info.album.image || info.image || null, sub: info.sub || '', label: 'Album', focusId: info.id });
    } else if (!info.rows?.length && info.name) {
      openPalette(info.name); // signed out: find it instead
    }
  }, [pushToast, openArtistAnywhere, mySpotifyBridge, openPalette, openRecord]);
  const openSpotifyLinkText = useCallback(async (text) => {
    const api = window.electronAPI;
    if (!api?.spotifyLinkResolve) return;
    pushToast?.({ message: 'Opening Spotify link…', kind: 'info', durationMs: 2500, dedupeKey: 'spotify-link', log: false });
    openSpotifyLink(await api.spotifyLinkResolve(text).catch(() => null));
  }, [pushToast, openSpotifyLink]);

  // Ctrl+V outside a text field.
  useEffect(() => {
    const onKey = async (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'v') return;
      const el = e.target;
      if (el?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName || '')) return;
      const link = await window.electronAPI?.spotifyLinkFromClipboard?.().catch(() => null);
      if (!link) return;
      openSpotifyLinkText(link.kind === 'short' ? link.url : `spotify:${link.kind}:${link.id}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSpotifyLinkText]);

  /* The copied-link card (Toasts.jsx, ToastCard): what the link is and its
     buttons. Built when it's shown, from what's current then (saved yet,
     followed yet). A button with `again` shows the card again with that
     added, so Save and Follow turn into a tick in place. */
  const linkLive = useRef({});
  linkLive.current = { bridge: mySpotifyBridge, follows: studioFollows, open: openSpotifyLink, style: theme.linkCard || 'slim' };
  const linkCardFor = useCallback((info) => {
    const live = () => linkLive.current;
    const { bridge, follows, style } = live();
    const rows = info.rows || null;
    const row = info.kind === 'track' ? rows?.[0] : null;
    const year = String(info.date || '').slice(0, 4);
    const card = { style, image: info.image || '', title: info.name || 'Spotify link', sub: info.sub || '', buttons: [] };
    const saveBtn = (done, label, save) => (done
      ? { label: 'In Your Library', icon: 'check', disabled: true }
      : { label, icon: 'plus', stay: true, again: { saved: true }, onClick: save });
    const open = { label: 'Open', icon: 'open', onClick: () => live().open(info) };
    /* The quick first version (name and cover, details still coming): the
       buttons it's about to have, dimmed, so nothing moves when they land. */
    if (info.loading && (info.kind === 'track' || info.kind === 'album')) {
      card.buttons.push({ label: 'Play', icon: 'play', primary: true, pending: true });
      card.buttons.push({ label: info.kind === 'album' ? 'Save all' : 'Save', icon: 'plus', pending: true });
      card.buttons.push(info.kind === 'album' ? open : { label: 'Album', icon: 'open', pending: true });
      return card;
    }
    if (info.kind === 'track') {
      card.explicit = !!row?.explicit;
      card.meta = [info.album?.name, year, row?.durationMs ? fmtMs(row.durationMs) : ''].filter(Boolean).join(' · ');
      if (row) {
        card.buttons.push({ label: 'Play', icon: 'play', primary: true, onClick: () => live().bridge.playRows([row], 0) });
        card.buttons.push(saveBtn(info.saved || bridge.saveState(row), 'Save', () => live().bridge.saveRow(row)));
        if (info.album?.id) card.buttons.push({ label: 'Album', icon: 'open', onClick: () => live().open(info, { play: false }) });
      } else {
        // Signed out: Studio can't play it, but can look for it.
        card.buttons.push({ ...open, label: 'Find', primary: true });
      }
    } else if (info.kind === 'album') {
      const mins = rows?.length ? Math.round(rows.reduce((n, r) => n + (r.durationMs || 0), 0) / 60000) : 0;
      card.meta = [year, rows?.length ? `${rows.length} songs` : '', mins ? `${mins} min` : ''].filter(Boolean).join(' · ');
      if (rows?.length) {
        const context = { kind: 'album', id: info.id, name: info.name };
        const unsaved = (b) => rows.filter((r) => !b.saveState(r));
        card.buttons.push({ label: 'Play', icon: 'play', primary: true, onClick: () => live().bridge.playRows(rows, 0, { context }) });
        card.buttons.push(saveBtn(info.saved || !unsaved(bridge).length, 'Save all', () => { const b = live().bridge; unsaved(b).forEach((r) => b.saveRow(r)); }));
      }
      card.buttons.push(rows?.length ? open : { ...open, primary: true });
    } else if (info.kind === 'playlist') {
      card.sub = card.sub || 'Playlist';
      card.buttons.push({
        label: 'Play', icon: 'play', primary: true,
        onClick: async () => {
          const r = await window.electronAPI?.spotifyFeedPlaylist?.(info.id).catch(() => null);
          if (r?.ok && r.data?.length) live().bridge.playRows(r.data, 0, { context: { kind: 'playlist', id: info.id, name: info.name, image: info.image } });
          else live().open(info);
        },
      });
      card.buttons.push(open);
    } else if (info.kind === 'artist') {
      card.round = true;
      card.sub = 'Artist';
      card.buttons.push({ ...open, primary: true });
      card.buttons.push(info.following || isStudioFollowed({ name: info.name, spotifyId: info.id }, follows)
        ? { label: 'Following', icon: 'check', disabled: true }
        : { label: 'Follow', icon: 'follow', stay: true, again: { following: true }, onClick: () => { followArtist({ spotifyId: info.id, name: info.name, image: info.image }); } });
    }
    return card;
  }, []);

  /* Settings → Connections → Link Card: picking a look shows it, with the song
     that's playing (or one from the library) standing in. */
  const previewLinkCard = useCallback((style) => {
    const t = currentTrack || library.find((x) => coverFor?.(x) || x.coverArt) || library[0];
    pushToast?.({
      message: 'Link card preview', kind: 'info', durationMs: 6000, dedupeKey: 'spotify-link-copied', log: false,
      card: {
        style, image: (t && (coverFor?.(t) || t.coverArt)) || '', title: t?.title || 'Song title', sub: t?.artist || 'Artist',
        meta: [t?.album, t?.year, t?.duration ? fmtMs(t.duration * 1000) : ''].filter(Boolean).join(' · '),
        buttons: [{ label: 'Play', icon: 'play', primary: true }, { label: 'Save', icon: 'plus' }, { label: 'Album', icon: 'open' }],
      },
    });
  }, [currentTrack, library, coverFor, pushToast]);

  // Copied in another app: offered now if Studio is on screen, and again
  // when you come back to it (within a few minutes). Watching restarts only
  // when the setting changes: a restart counts whatever is on the clipboard
  // as already seen, so restarting on every play/pause could miss a link.
  const linkWatchOn = theme.linkWatch !== false;
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.spotifyLinkWatch) return undefined;
    api.spotifyLinkWatch(linkWatchOn).catch(() => {});
    if (!linkWatchOn || !api.onSpotifyLinkCopied) return () => { api.spotifyLinkWatch(false).catch(() => {}); };
    let pending = null;
    const offer = (info) => {
      const card = linkCardFor(info);
      pushToast?.({
        message: card.sub ? `${card.title} · ${card.sub}` : card.title,
        kind: 'info', durationMs: 15000, dedupeKey: 'spotify-link-copied', log: false,
        card: { ...card, buttons: card.buttons.map((btn) => (btn.again ? { ...btn, onClick: () => { btn.onClick(); offer({ ...info, ...btn.again }); } } : btn)) },
      });
    };
    const off = api.onSpotifyLinkCopied((info) => {
      pending = { info, at: Date.now() };
      if (document.visibilityState === 'visible') offer(info);
    });
    const onFocus = () => {
      if (pending && Date.now() - pending.at < 5 * 60 * 1000) offer(pending.info);
      pending = null;
    };
    window.addEventListener('focus', onFocus);
    return () => { off?.(); window.removeEventListener('focus', onFocus); api.spotifyLinkWatch(false).catch(() => {}); };
  }, [linkWatchOn, pushToast, linkCardFor]);

  /* ---- Streamer Mode: song requests from Twitch chat ---------------------
   * Viewers type "!sr" and a song name or a Spotify link. Requests line up
   * first come, first served after the current song (or play, if nothing
   * is), skipping anything on the block list, and the card a copied link
   * gets (in the style picked for it) says who asked, in place of its
   * buttons. Chat is read without signing in (twitchChat.js). Who may ask
   * and how often are Settings → Connections → Twitch. */
  const [twitchStatus, setTwitchStatus] = useState('off');
  const srLive = useRef({});
  srLive.current = { theme, currentTrack, queue, onPlayNext, onQueueRequest, onPlayTrack, spotifyPlayable, pushToast };
  const srChannel = theme.streamerMode ? twitchChannelOf(theme.twitchChannel) : '';
  /* The block list (Settings → Connections → Twitch, or a song's menu). */
  const srBlocked = Array.isArray(theme.srBlocked) ? theme.srBlocked : [];
  /* Takes an updater, so an Undo that fires later edits the list as it is then. */
  const setSrBlocked = useCallback((fn) => {
    setTheme((th) => {
      const list = Array.isArray(th.srBlocked) ? th.srBlocked : [];
      const next = { ...th, srBlocked: fn(list) };
      try { localStorage.setItem('studio:theme', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const toggleSrBlock = useCallback((entry, hit) => {
    const drop = (l) => l.filter((b) => b !== hit && !sameEntry(b, hit));
    const put = (e) => (l) => (l.some((b) => sameEntry(b, e)) ? l : [...l, e]);
    if (hit) {
      setSrBlocked(drop);
      pushToast?.({ message: `${entryLabel(hit)} can be requested again.`, action: { label: 'Undo', onClick: () => setSrBlocked(put(hit)) } });
    } else {
      setSrBlocked(put(entry));
      pushToast?.({ message: `${entryLabel(entry)} can’t be requested now.`, action: { label: 'Undo', onClick: () => setSrBlocked((l) => l.filter((b) => !sameEntry(b, entry))) } });
    }
  }, [pushToast, setSrBlocked]);
  useEffect(() => {
    if (!srChannel) { setTwitchStatus('off'); return undefined; }
    const lastAsked = new Map(); // viewer → when their last request was taken
    const request = async ({ text, user }) => {
      const m = /^!sr\s+(.+)$/i.exec(String(text || '').trim());
      if (!m) return;
      const live = srLive.current;
      const th = live.theme;
      const who = th.srWho || 'everyone';
      const trusted = user.broadcaster || user.mod;
      if (!(who === 'everyone' || trusted || (who === 'subs' && (user.sub || user.vip)))) return;
      const wait = Math.max(0, Number(th.srCooldown ?? 60)) * 1000;
      if (wait && !trusted && Date.now() - (lastAsked.get(user.login) || 0) < wait) return;
      lastAsked.set(user.login, Date.now());

      const q = m[1].trim().slice(0, 200);
      const api = window.electronAPI;
      let row = null;
      try {
        if (/open\.spotify\.com\/|spotify:track:|spotify\.link\//i.test(q)) {
          const info = await api?.spotifyLinkResolve?.(q);
          if (info?.kind === 'track') row = info.rows?.[0] || null;
        } else {
          const rows = await api?.spotifySearch?.(q);
          row = (Array.isArray(rows) ? rows : []).find((r) => r?.spotifyId && !String(r.spotifyId).startsWith('itunes:') && !r.notOut) || null;
        }
      } catch { row = null; }
      const now = srLive.current;
      if (!row) {
        lastAsked.delete(user.login); // nothing was queued: they can try again straight away
        now.pushToast?.({ message: `No song found for “${q}”, requested by ${user.name}`, kind: 'info', durationMs: 5000 });
        return;
      }
      const blocked = blockedBy(now.theme.srBlocked, row);
      if (blocked) {
        lastAsked.delete(user.login);
        now.pushToast?.({ message: `Blocked request: ${row.title}${row.artists ? ` by ${row.artists}` : ''}, from ${user.name}`, kind: 'info', durationMs: 5000 });
        return;
      }
      const track = now.spotifyPlayable(row);
      const playing = !!now.currentTrack;
      /* The same song twice in a row is a pile-on, not a request: if it's
         playing or already waiting in line, it isn't added again. */
      const same = (t) => t && (t.id === track.id || (row.spotifyId && t.spotifyId === row.spotifyId));
      if (playing && (same(now.currentTrack) || (now.queue || []).some((t) => t?.srBy && same(t)))) {
        lastAsked.delete(user.login);
        now.pushToast?.({ message: `${row.title} is already ${same(now.currentTrack) ? 'playing' : 'in the queue'}, requested by ${user.name}`, kind: 'info', durationMs: 5000 });
        return;
      }
      let spot = 1;
      if (!playing) now.onPlayTrack?.(track, [track]);
      else if (now.onQueueRequest) spot = now.onQueueRequest(track, user.name) || 1;
      else now.onPlayNext?.([track]);
      const where = !playing ? 'Playing Now' : spot <= 1 ? 'Playing Next' : `#${spot} in Queue`;
      now.pushToast?.({
        message: `${row.title}${row.artists ? ` by ${row.artists}` : ''}, requested by ${user.name}: ${where.toLowerCase()}`,
        kind: 'info', durationMs: 8000,
        card: {
          style: now.theme.linkCard || 'slim',
          image: row.albumArtUrl || '', title: row.title || 'Song', sub: row.artists || '', explicit: !!row.explicit,
          meta: [row.album, row.durationMs ? fmtMs(row.durationMs) : ''].filter(Boolean).join(' · '),
          note: { by: user.name, text: where },
          buttons: [],
        },
      });
    };
    let chat = null;
    // A moment's pause, so typing the channel name doesn't connect once per letter.
    const t = setTimeout(() => { chat = connectTwitchChat(srChannel, { onStatus: setTwitchStatus, onMessage: request }); }, 600);
    setTwitchStatus('connecting');
    return () => { clearTimeout(t); chat?.close(); };
  }, [srChannel]);

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
    analyserRef, onNeedAnalyser, currentTrack, isPlaying, duration, onSeek,
    palette: npWashTheme?.palette || null, accent: rawAccent, coverColours: compactVizCover,
  }), [compactMode, compactViz, analyserRef, onNeedAnalyser, currentTrack, isPlaying, duration, onSeek, npWashTheme, rawAccent, compactVizCover]);

  /* ---------- Menus for albums, playlists, artists and releases ----------
     The song menu's look (ObjectMenu), opened by right-click anywhere one
     of these shows and by a page's ··· button. Built at call time from
     what's current, so the openers below stay stable. */
  const atOf = (e) => (e?.at ? e.at : { x: e.clientX, y: e.clientY });
  const songItems = (tracks, name, { exclude = null, from = null } = {}) => {
    const ids = tracks.map((t) => t.id);
    return [
      onPlayTrack ? { label: 'Play', icon: MI.play, run: () => onPlayTrack(tracks[0], tracks, 'list', from) } : null,
      onPlayTrack && tracks.length > 1 ? { label: 'Shuffle', icon: MI.shuffle, run: () => { const sh = [...tracks].sort(() => Math.random() - 0.5); onPlayTrack(sh[0], sh, 'list', from); } } : null,
      'sep',
      onPlayNext ? { label: 'Play Next', icon: MI.next, run: () => { onPlayNext(tracks); pushToast?.({ message: `Playing next: ${name}` }); } } : null,
      onAddToQueue ? { label: 'Add to Queue', icon: MI.queue, run: () => { onAddToQueue(tracks); pushToast?.({ message: `Added to queue: ${name}` }); } } : null,
      onAddTracksToPlaylist ? { label: 'Add to Playlist', icon: MI.playlist, picker: pickerFor(ids, { exclude }) } : null,
      'sep',
    ];
  };
  const copyItemLink = async (kind, id) => {
    try { await navigator.clipboard.writeText(`https://open.spotify.com/${kind}/${id}`); pushToast?.({ message: 'Spotify link copied' }); } catch { /* ignore */ }
  };
  menuLive.current = {
    /* One of your albums: a libAlbums entry or an album key. */
    album(e, src) {
      const a = typeof src === 'string' ? libAlbums.find((x) => x.key === src) : src;
      if (!a?.tracks?.length) return;
      const tracks = [...a.tracks].sort((x, y) => (x.discNumber || 1) - (y.discNumber || 1) || (x.trackNumber || 0) - (y.trackNumber || 0));
      setObjMenu({
        at: atOf(e),
        head: { art: a.art || coverFor(tracks[0]), title: a.name, sub: [tracks.length === 1 ? 'Single' : 'Album', a.artist].filter(Boolean).join(' · ') },
        items: [
          ...songItems(tracks, a.name, { from: { kind: 'album', lib: true, key: a.key, name: a.name } }),
          a.artist ? { label: 'Go to Artist', icon: MI.artist, run: () => openArtistAnywhere({ name: a.artist }) } : null,
          onUpdateAlbumMetadata ? {
            label: 'Edit Info', icon: MI.edit,
            run: () => setAlbumEditScope({ key: a.key, album: a.name, artist: a.artist, coverArt: a.art, sampleTrack: tracks[0], trackIds: tracks.map((t) => t.id), discNumber: null }),
          } : null,
          'sep',
          onRemoveFromLibrary ? { label: 'Remove from Library', icon: MI.trash, danger: true, run: () => onRemoveFromLibrary(tracks.map((t) => t.id)) } : null,
        ],
      });
    },
    /* One of your playlists. */
    playlist(e, plId) {
      const pl = (playlists || []).find((x) => x.id === plId);
      if (!pl) return;
      const tracks = (pl.trackIds || []).map((id) => libById.get(id)).filter(Boolean);
      const n = (pl.trackIds || []).length;
      setObjMenu({
        at: atOf(e),
        head: { art: plArt(pl), title: pl.name, sub: `Playlist · ${n} ${n === 1 ? 'song' : 'songs'}` },
        items: [
          ...(tracks.length ? songItems(tracks, pl.name, { exclude: pl.id, from: { kind: 'playlist', lib: true, id: pl.id, name: pl.name } }) : []),
          onRenamePlaylist || onUpdatePlaylist ? { label: 'Edit Playlist', icon: MI.edit, run: () => setRenamePl({ id: pl.id, name: pl.name }) } : null,
          onDeletePlaylist ? { label: 'Delete Playlist', icon: MI.trash, danger: true, run: () => deletePlaylistNow(pl.id) } : null,
        ],
      });
    },
    /* An artist in your library: { name, tracks }, plus a portrait. */
    artist(e, a, image = null) {
      const tracks = a?.tracks || [];
      setObjMenu({
        at: atOf(e),
        head: { art: image, title: a.name, sub: `Artist · ${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'}`, round: true },
        items: [
          ...(tracks.length ? songItems(tracks, a.name, { from: { kind: 'artist', lib: true, name: a.name } }) : []),
          { label: 'Go to Artist', icon: MI.artist, run: () => openArtistAnywhere({ name: a.name, spotifyId: a.spotifyId || null, image }) },
          a.spotifyId ? { label: 'Copy Spotify Link', icon: MI.link, run: () => copyItemLink('artist', a.spotifyId) } : null,
        ],
      });
    },
    /* A Spotify album, playlist or mix (Home, New Releases, an artist's
       releases): { kind, id, name, sub, image }. Its songs load when an
       item needs them. `extra`: items of the page's own (Open Your Copy). */
    item(e, item, extra = []) {
      if (!item) return;
      const rows = () => loadCollection(item).then((r) => (r || []).filter((x) => x?.spotifyId && !x.notOut));
      const fail = () => pushToast?.({ message: 'Couldn’t load its songs.', kind: 'error' });
      const artist = String(item.sub || '').replace(/^(album|single|ep|playlist|compilation)\s·\s/i, '');
      const isAlbum = item.kind === 'album' && !item.countdown;
      setObjMenu({
        at: atOf(e),
        head: { art: item.image || null, title: item.name, sub: item.sub || '', round: item.kind === 'artist' },
        items: [
          { label: 'Play', icon: MI.play, run: () => rows().then((r) => mySpotifyBridge.playRows(r, 0, { context: item }), fail) },
          { label: 'Shuffle', icon: MI.shuffle, run: () => rows().then((r) => mySpotifyBridge.playRows(r, 0, { shuffle: true, context: item }), fail) },
          'sep',
          onPlayNext ? { label: 'Play Next', icon: MI.next, run: () => rows().then((r) => { notePlayContext(r, item); onPlayNext(r.map(spotifyPlayable)); pushToast?.({ message: `Playing next: ${item.name}` }); }, fail) } : null,
          onAddToQueue ? { label: 'Add to Queue', icon: MI.queue, run: () => rows().then((r) => { notePlayContext(r, item); onAddToQueue(r.map(spotifyPlayable)); pushToast?.({ message: `Added to queue: ${item.name}` }); }, fail) } : null,
          isAlbum ? { label: 'Save to Library', icon: MI.save, run: () => rows().then((r) => r.forEach((x) => mySpotifyBridge.saveRow(x)), fail) } : null,
          'sep',
          item.kind === 'artist'
            ? { label: 'Go to Artist', icon: MI.artist, run: () => openArtistAnywhere({ name: item.name, spotifyId: item.id, image: item.image || null }) }
            : { label: isAlbum ? 'Go to Album' : 'Open', icon: isAlbum ? MI.album : MI.open, run: () => openRecord(item) },
          ...(extra || []),
          isAlbum && artist ? { label: 'Go to Artist', icon: MI.artist, run: () => openArtistAnywhere({ name: artist.split(', ')[0] }) } : null,
          item.id && /^(album|playlist|artist)$/.test(item.kind) && !item.countdown ? { label: 'Copy Spotify Link', icon: MI.link, run: () => copyItemLink(item.kind, item.id) } : null,
        ],
      });
    },
  };

  return (
    /* Flat black behind everything. The radial gradient that used to lift the
       top of the window read as a seam once the content became its own panel —
       the panel floated on a lighter patch instead of on the shell. */
    <CompactVizContext.Provider value={compactVizCtx}>
    <div className={`sth-root${compactMode ? ' is-compact' : ''}${modeMoving ? ' is-mode-anim' : ''}`} data-dark={dark ? '' : undefined} style={{
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
      '--np-bar-bg': dark ? DARK.bar : npBarColor,
      '--np-bar-left': compactMode ? 'var(--gutter)' : `${SIDEBAR_W}px`,
      '--content-left': compactMode ? 'var(--gutter)' : `${SIDEBAR_W}px`,
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
      '--row-h': `${LIB_ROW_H}px`,
    }}>
      <StudioMotionStyles />
      <style>{HOME_CSS}</style>
      <style>{DIALOG_CSS}</style>
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
      <header className={`sth-topbar${chromeCompact ? ' is-compact' : ''}${chromeCompact && chromePeek === 'top' ? ' is-peek' : ''}`}
        aria-hidden={chromeCompact && chromePeek !== 'top' ? true : undefined}
        style={{
        /* Above the side panel (5): the bar's dropdowns (notifications and the
           rest) open over it. At 3 they slid underneath. */
        position: 'absolute', top: 0, left: 0, right: 0, height: TOPBAR_H, zIndex: compactMode ? 46 : 6,
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
        animation: modeAnim === 'to-compact' ? `sthTopOut ${MODE_EASE}`
          : !compactMode ? (modeSeen.current ? `sthTopIn ${MODE_EASE}` : 'stFadeIn 0.6s ease both')
          : 'none',
        /* Hidden in compact: no drag region at all. A transformed-away drag
           element can still claim its untransformed box at the OS hit-test,
           which would swallow clicks across the top of the card. */
        WebkitAppRegion: topbarRegion,
      }}
        onAnimationEnd={refreshDragRegion}
        onTransitionEnd={refreshDragRegion}
      >
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
        <div style={{ width: SIDEBAR_W, flexShrink: 1, minWidth: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', paddingLeft: 20 }}>
          <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text)' }}>studio</span>
        </div>

        </div>

        {/* Column 2: the search, on the window's centre line. Width is clamped
            so it neither shrinks to a slot nor stretches into a text area on a
            wide monitor. */}
        <div style={{ width: 'clamp(260px, 34vw, 480px)', WebkitAppRegion: 'no-drag' }}>{topbarSearch}</div>

        {/* Column 3: mirrors column 1's width, so whatever sits here can't
            pull the search off centre. */}
        {/* The empty stretch before the buttons is part of the handle: only
            the buttons themselves are no-drag. */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', minWidth: 0, paddingRight: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, WebkitAppRegion: 'no-drag' }}>
          {/* Dark mode, one click from anywhere (see DarkModeButton). */}
          <DarkModeButton on={dark} onToggle={() => setThemeKey('darkMode', !dark)} />
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
          <WindowControls inline />
        </div>
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
        animation: modeAnim === 'to-compact' ? `sthSideOut ${MODE_EASE}` : modeAnim === 'to-standard' ? `sthSideIn ${MODE_EASE}` : undefined,
        ...(chromeCompact ? {
          top: 'var(--gutter)', left: 'var(--gutter)', bottom: 'var(--np-reserve)',
          width: SIDEBAR_W - 16, zIndex: 45, padding: '6px 8px 8px',
          background: `var(--st-dark-float, rgb(${theme.bg}))`, border: '1px solid var(--border)', borderRadius: 'var(--r-card)',
          boxShadow: '0 18px 48px rgba(0,0,0,0.5)',
          transform: chromePeek === 'side' ? 'none' : 'translateX(calc(-100% - 24px))',
          visibility: chromePeek === 'side' ? 'visible' : 'hidden',
          transition: chromePeek === 'side'
            ? 'transform 0.22s cubic-bezier(0.22,1,0.36,1)'
            : 'transform 0.18s ease, visibility 0s linear 0.18s',
        } : null),
      }}
      aria-hidden={chromeCompact && chromePeek !== 'side' ? true : undefined}>
        {/* LIBRARY heading — the point of the change: the sidebar reads as one
            category rather than the leftovers of a split navigation. */}
        <div className="sth-side-eyebrow"><span className="st-eyebrow">My Spotify</span></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {MY_SPOTIFY.filter(([id]) => homeOn || id !== 'sp-home').map(([id, label, path]) => {
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
          {/* + : a new playlist, or bring yours over from Spotify. The
              importer lives here rather than under Songs → Import, since
              what it brings over is playlists. */}
          {onCreatePlaylist ? (
            <>
              <button type="button" className="st-icon-btn is-sm"
                onClick={(e) => {
                  if (!onImportSpotify) { setNewPlaylist({ name: '' }); return; }
                  if (plAddMenu) { setPlAddMenu(null); return; }
                  /* Drawn over the whole window (a portal), from the button's
                     spot: inside the sidebar its edge cut the menu off. */
                  const r = e.currentTarget.getBoundingClientRect();
                  setPlAddMenu({ left: Math.max(8, r.right - 222), top: r.bottom + 6 });
                }}
                title="New Playlist" aria-label="New Playlist" aria-haspopup={onImportSpotify ? 'menu' : undefined} aria-expanded={onImportSpotify ? !!plAddMenu : undefined}
                style={{ width: 24, height: 24, background: plAddMenu ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.07)' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
              </button>
              {plAddMenu ? createPortal(
                <>
                  <div onClick={() => setPlAddMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 300 }} />
                  <div role="menu" style={{ position: 'fixed', left: plAddMenu.left, top: plAddMenu.top, zIndex: 301, width: 236, ...MENU_SURFACE }}>
                    <ImportMenuItem label="New Playlist" hint="Start an empty one" icon={IMPORT_ICONS.playlist}
                      onClick={() => { setPlAddMenu(null); setNewPlaylist({ name: '' }); }} />
                    <ImportMenuItem label="Import from Spotify…" hint="Your playlists and Liked Songs" icon={IMPORT_ICONS.spotify}
                      onClick={() => { setPlAddMenu(null); onImportSpotify(); }} />
                  </div>
                </>,
                document.body,
              ) : null}
            </>
          ) : null}
        </div>
        <div className="sth-libscroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 4 }}>
          {playlists.length === 0 ? (
            <div style={{ padding: '6px 12px', fontSize: 12.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
              {onImportSpotify ? 'No playlists yet. Use + to start one or bring yours over from Spotify.' : 'No playlists yet. Use + to start one.'}
            </div>
          ) : null}
          {playlists.map((pl) => {
            const on = openPlId === pl.id || (libDetail?.kind === 'playlist' && libDetail.key === pl.id);
            const n = Array.isArray(pl.trackIds) ? pl.trackIds.length : 0;
            const firstArt = !pl.coverArt && n ? (() => {
              const t0 = library.find((t) => t.id === pl.trackIds[0]);
              return t0 ? coverFor(t0) : null;
            })() : null;
            const artUrl = pl.coverArt || firstArt;
            return (
              <button key={pl.id} type="button" className={`sth-side-pl${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined}
                onClick={() => openLibPlaylist(pl.id)}
                onContextMenu={(e) => openPlaylistMenu(e, pl.id)}>
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
        bottom: 0, left: 'var(--content-left)', right: 0, zIndex: 1,
        display: 'flex', flexDirection: 'column',
        /* Reserve the dock's width so the content narrows instead of being
           covered. The shelves re-measure through HomeRow's ResizeObserver, so
           the carousel arrows stay accurate at the new width. */
        /* The panel's own width plus the gap between it and the card. The
           card's --gutter margin sits outside this, so the card ends exactly
           one gap from the panel's edge. */
        paddingRight: (npPanelOpen && currentTrack) ? NP_PANEL_W + 12 : 0,
        /* No glide on this edge. Gliding it re-laid out the whole page (every
           row of a long list) on every frame of the panel's slide, which is
           what made opening it judder. The content makes room in one step and
           the panel slides into the space, or away over it, on the GPU. */
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
          {sec === 'sp-releases' ? <SpotifyReleases bridge={mySpotifyBridge} countdowns={!homeOn} /> : null}
          {/* An album or playlist opened from a Spotify link, over any page. */}

          {/* ================= LIBRARY =================
              Rebuilt to the mockup: a fixed left rail of views + playlists,
              and a dense track table on the right. The old version was a
              toolbar over a card grid with an inline detail panel — good for
              browsing albums, poor for the "find one song among 500" job a
              library actually gets used for. */}
          {sec === 'library' ? (
            <LibraryPage
              onPlayNext={onPlayNext ? (ts, name) => { onPlayNext(ts); pushToast?.({ message: `Playing next: ${name}` }); } : null}
              onAddToQueue={onAddToQueue ? (ts, name) => { onAddToQueue(ts); pushToast?.({ message: `Added to queue: ${name}` }); } : null}
              onAddToPlaylist={onAddTracksToPlaylist ? (ids) => pickerFor(ids, { exclude: libDetail?.kind === 'playlist' ? libDetail.key : null }) : null}
              LIB_OVERSCAN={LIB_OVERSCAN}
              LIB_ROW_H={LIB_ROW_H}
              accent={accent}
              autoRgb={autoRgb}
              canManage={canManage}
              compactMode={compactMode}
              coverFor={coverFor}
              coverOverride={coverOverride}
              currentTrack={currentTrack}
              detailData={detailData}
              detailFilter={detailFilter}
              detailMore={detailMore}
              detailTheme={detailTheme}
              detailTracks={detailTracks}
              dlProgress={dlProgress}
              dlState={dlState}
              downloadSpotifyRow={downloadSpotifyRow}
              filteredLibArtists={filteredLibArtists}
              fmtAdded={fmtAdded}
              immerse={immerse}
              immersePalette={immersePalette}
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
              onPlayTrack={onPlayTrack}
              onRemoveFromPlaylist={onRemoveFromPlaylist ? removeFromPlaylistNow : null}
              onMovePlaylistSong={moveInOpenPlaylist}
              onToggleFavorite={onToggleFavorite}
              onTogglePlay={onTogglePlay}
              onUpdateAlbumMetadata={onUpdateAlbumMetadata}
              openAlbumFromRow={openAlbumFromRow}
              openAlbumMenu={openAlbumMenu}
              openArtistMenu={openArtistMenu}
              openLibAlbum={openLibAlbum}
              openArtist={openArtist}
              openArtistAnywhere={openArtistAnywhere}
              openArtistFromRow={openArtistFromRow}
              openPalette={openPalette}
              openRowMenu={openRowMenu}
              ownedTrackFor={ownedTrackFor}
              pickerFor={pickerFor}
              pickLibRowSort={pickLibRowSort}
              pickSection={pickSection}
              playCountFor={playCountFor}
              playEvents={playEvents}
              playFromLibRows={playFromLibRows}
              setAlbumEditScope={setAlbumEditScope}
              deletePlaylist={deletePlaylistNow}
              setDetailFilter={setDetailFilter}
              setDetailMore={setDetailMore}
              setLibDetail={setLibDetail}
              setLibFilter={setLibFilter}
              setLibScrollTop={setLibScrollTop}
              setRenamePl={setRenamePl}
              setSetCat={setSetCat}
              showDateAdded={showDateAdded}
              showPlayCounts={showPlayCounts}
              theme={vtheme}
              toggleFollow={toggleFollow}
            />
          ) : null}



          {/* ================= SETTINGS ================= */}
          {sec === 'settings' ? (
            <SettingsPage
              onPreviewLinkCard={previewLinkCard}
              twitchStatus={twitchStatus}
              onSetSrBlocked={setSrBlocked}
              pushToast={pushToast}
              tour={settingsTour}
              onEndTour={endSettingsTour}
              accentFixed={accentFixed}
              accentMode={accentMode}
              clearing={clearing}
              clearingAll={clearingAll}
              compactMode={compactMode}
              compactViz={compactViz}
              compactVizCover={compactVizCover}
              connState={connState}
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
              normalization={normalization}
              onSetNormalization={onSetNormalization}
              eq={eq}
              eqHeadroom={eqHeadroom}
              onSetEq={onSetEq}
              onSpotifyCredsSaved={onSpotifyCredsSaved}
              pickAccentFixed={pickAccentFixed}
              pickAccentMode={pickAccentMode}
              pickCompactMode={pickCompactMode}
              pickCompactViz={pickCompactViz}
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
      {objMenu ? (
        <ObjectMenu at={objMenu.at} head={objMenu.head} items={objMenu.items}
          accentRgb={readableAccent(accent)} onClose={() => setObjMenu(null)} />
      ) : null}
      {rowMenu ? (() => {
        /* The song menu, for any song anywhere: a library row (`track`), a
           Spotify row from My Spotify, an artist page or search (`row`), or a
           queue entry (`queueIndex`). A Spotify row you have a copy of is
           treated as that copy. */
        const row = rowMenu.row || null;
        const owned = rowMenu.track || (row ? (libBySpotifyId.get(row.spotifyId) || ownedTrackFor(row.title, row.artists, row.album || '')) : null);
        const saved = !!owned && !owned.streamOnly;
        const t = owned || (row ? spotifyPlayable(row) : null);
        if (!t) return null;
        const inQueue = Number.isInteger(rowMenu.queueIndex);
        const acc = readableAccent(accent);
        const albumTracks = saved && t?.album
          ? library.filter((x) => (x.album || '').toLowerCase() === (t.album || '').toLowerCase()
              && primaryArtistOf(x).toLowerCase() === primaryArtistOf(t).toLowerCase())
          : [];
        const close = () => { setRowMenu(null); setPlSub(null); };
        const inPls = saved ? playlists.filter((p) => (p.trackIds || []).includes(t.id)) : [];
        const sid = row?.spotifyId || t.spotifyId || spotifyIdOf(t) || null;
        const artistName = row ? String(row.artists || '').split(', ')[0] : primaryArtistOf(t);
        const sep = <div style={{ height: 1, background: 'rgba(var(--st-fg-rgb), 0.08)', margin: '4px 3px' }} />;
        /* The library copy to file, saving a Spotify song first (it plays
           through your account; nothing is downloaded). */
        const songForPlaylist = async () => (saved ? t : (row ? await downloadSpotifyRow(row, { noPicker: true }) : null));
        const togglePlaylist = async (pl) => {
          const has = saved && (pl.trackIds || []).includes(t.id);
          close();
          if (has) {
            await removeFromPlaylistNow(pl.id, t.id);
            return;
          }
          const song = await songForPlaylist();
          if (!song) return;
          const r = await onAddTracksToPlaylist?.(pl.id, [song.id]);
          pushToast?.(r && r.ok === false ? { message: `Couldn’t add it to ${pl.name}.`, kind: 'error' } : { message: `Added to ${pl.name}` });
        };
        const createWithSong = async (name) => {
          const n = String(name || '').trim();
          if (!n) return;
          close();
          const r = await onCreatePlaylist?.({ name: n });
          if (!r?.ok || !r.id) { pushToast?.({ message: 'Couldn’t create that playlist.', kind: 'error' }); return; }
          const song = await songForPlaylist();
          if (song) await onAddTracksToPlaylist?.(r.id, [song.id]);
          pushToast?.({ message: `Added to ${n}` });
        };
        // The album page, as the bar's link opens it (openTrackAlbum).
        const goAlbum = () => { close(); openTrackAlbum(t, { row, saved }); };
        const copyLink = async () => {
          close();
          if (sid) {
            try { await navigator.clipboard.writeText(`https://open.spotify.com/track/${sid}`); pushToast?.({ message: 'Spotify link copied' }); } catch { /* ignore */ }
            return;
          }
          await copySpotifyLink(t);
        };
        const plHere = rowMenu.playlistId ? playlists.find((p) => p.id === rowMenu.playlistId) : null;
        const plAt = plHere ? (plHere.trackIds || []).indexOf(t.id) : -1;
        const qMax = queue.length - 1;
        const qMin = queueIndex + 1;
        /* Wide enough for the longest label next to its shortcut on one line.
           The bar's menu adds the app options, whose shortcuts are longer. */
        const menuW = rowMenu.bar ? 316 : 280;
        const menuLeft = Math.max(8, Math.min(rowMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 1400) - menuW - 12));
        const subOnLeft = menuLeft + menuW + 244 > (typeof window !== 'undefined' ? window.innerWidth : 1400);
        const chev = (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5, flexShrink: 0 }}>
            <path d="M9 6l6 6-6 6" />
          </svg>
        );
        return createPortal(
          <>
            <div onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }}
              style={{ position: 'fixed', inset: 0, zIndex: 400 }} />
            <div
              data-rowmenu=""
              ref={keepMenuOnScreen}
              style={{
                position: 'fixed', zIndex: 401,
                /* Clamped so the menu never opens off-screen near an edge. */
                left: menuLeft,
                /* A row drops the menu from the cursor; a Now Playing bar
                   button is pinned to the bottom edge, so its menu grows up. */
                ...(rowMenu.above
                  ? { bottom: Math.max(8, (typeof window !== 'undefined' ? window.innerHeight : 900) - rowMenu.y) }
                  : { top: Math.min(rowMenu.y, (typeof window !== 'undefined' ? window.innerHeight : 900) - 320) }),
                width: menuW, padding: 5, borderRadius: 12,
                /* Every floating layer (menus, pickers, notifications,
                   toasts) is the app's own card colour, so they sit in the
                   same family as the pages under them. */
                background: 'var(--surface)', border: '1px solid var(--border)',
                boxShadow: '0 22px 60px rgba(0,0,0,0.7)',
                animation: 'stFadeUp 0.13s ease both',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px 10px' }}>
                <div style={{ width: 34, height: 34, borderRadius: 6, flexShrink: 0, background: coverFor(t) ? `url("${coverFor(t)}") center/cover` : 'rgba(var(--st-fg-rgb), 0.08)' }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--st-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</div>
                  <div style={{ fontSize: 10.5, color: 'rgba(var(--st-sub-rgb), 0.45)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {[t.artist, t.album].filter(Boolean).join(' · ')}
                  </div>
                </div>
              </div>
              <div style={{ height: 1, background: 'rgba(var(--st-fg-rgb), 0.08)', margin: '0 3px 4px' }} />

              {/* On a playlist's page: its place in the playlist, first. */}
              {plHere ? (
                <>
                  {onReorderPlaylist && plAt > 0 ? (
                    <MenuItem accentRgb={acc} onClick={() => { movePlaylistSong(plHere.id, t.id, plAt - 1); close(); }}
                      icon={<path d="M12 19V5M6 11l6-6 6 6" />} label="Move up" />
                  ) : null}
                  {onReorderPlaylist && plAt < (plHere.trackIds || []).length - 1 ? (
                    <MenuItem accentRgb={acc} onClick={() => { movePlaylistSong(plHere.id, t.id, plAt + 1); close(); }}
                      icon={<path d="M12 5v14M6 13l6 6 6-6" />} label="Move down" />
                  ) : null}
                  {onRemoveFromPlaylist ? (
                    <MenuItem accentRgb={acc} onClick={() => { removeFromPlaylistNow(plHere.id, t.id); close(); }}
                      icon={<><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M8.5 12h7" /></>} label="Remove from playlist" />
                  ) : null}
                  {sep}
                </>
              ) : null}

              {/* In the queue: where it sits, first. */}
              {inQueue ? (
                <>
                  {onReorderQueue && rowMenu.queueIndex > qMin ? (
                    <MenuItem accentRgb={acc} onClick={() => { onReorderQueue(rowMenu.queueIndex, rowMenu.queueIndex - 1); close(); }}
                      icon={<path d="M12 19V5M6 11l6-6 6 6" />} label="Move up" />
                  ) : null}
                  {onReorderQueue && rowMenu.queueIndex < qMax ? (
                    <MenuItem accentRgb={acc} onClick={() => { onReorderQueue(rowMenu.queueIndex, rowMenu.queueIndex + 1); close(); }}
                      icon={<path d="M12 5v14M6 13l6 6 6-6" />} label="Move down" />
                  ) : null}
                  {onRemoveFromQueue ? (
                    <MenuItem accentRgb={acc} onClick={() => {
                      const out = onRemoveFromQueue(rowMenu.queueIndex);
                      close();
                      if (out?.track) pushToast?.({ message: 'Removed from the queue', action: onRestoreToQueue ? { label: 'Undo', onClick: () => onRestoreToQueue(out.track, out.after) } : null });
                    }}
                      icon={<><path d="M4 6h16M4 12h10M4 18h7" /><path d="M15 16l5 5M20 16l-5 5" /></>} label="Remove from queue" />
                  ) : null}
                  {sep}
                </>
              ) : (
                <>
                  {onPlayTrack && !rowMenu.bar ? (
                    <MenuItem accentRgb={acc}
                      onClick={() => { if (row) mySpotifyBridge.playRows([row], 0); else onPlayTrack(t, library, 'list'); close(); }}
                      icon={<path d="M8 6.5v11l9.5-5.5z" />} label="Play" />
                  ) : null}
                  {/* The queue's two verbs. Both confirm with a toast: the
                      queue panel is often closed. */}
                  {onPlayNext ? (
                    <MenuItem accentRgb={acc}
                      onClick={() => { onPlayNext(t); pushToast?.({ message: `Playing next: ${t.title || 'song'}` }); close(); }}
                      icon={<><path d="M4 6h10M4 12h10M4 18h6" /><path d="M17.5 14.5v6M14.5 17.5h6" /></>}
                      label="Play next" />
                  ) : null}
                  {onAddToQueue ? (
                    <MenuItem accentRgb={acc}
                      onClick={() => { onAddToQueue(t); pushToast?.({ message: `Added to queue: ${t.title || 'song'}` }); close(); }}
                      icon={<><path d="M4 6h16M4 12h16M4 18h9" /><path d="M17 15.5v5.5" /><path d="M14.2 18.2h5.6" /></>}
                      label="Add to queue" />
                  ) : null}
                  {sep}
                </>
              )}

              {/* Add to playlist: hover (or click) opens your playlists beside
                  the menu; clicking one adds the song there and then, and
                  clicking one that has it (ticked) takes it out. */}
              {onAddTracksToPlaylist && !row?.notOut ? (
                <div style={{ position: 'relative' }}
                  onMouseEnter={() => { clearTimeout(plSubTimer.current); setPlSub((c) => c || {}); }}
                  onMouseLeave={(e) => { clearTimeout(plSubTimer.current); const host = e.currentTarget; plSubTimer.current = setTimeout(() => { if (!host.contains(document.activeElement) || document.activeElement?.tagName !== 'INPUT') setPlSub(null); }, 220); }}>
                  <MenuItem accentRgb={acc} onClick={() => setPlSub((c) => c || {})}
                    icon={<><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M12 8.5v7M8.5 12h7" /></>}
                    label="Add to playlist"
                    trailing={<>{inPls.length ? <span style={{ fontSize: 11, color: 'rgba(var(--st-fg-rgb), 0.38)', whiteSpace: 'nowrap' }}>In {inPls.length}</span> : null}{chev}</>} />
                  {plSub ? (
                    <div data-rowmenu="" className="sth-libscroll" onWheel={(e) => e.stopPropagation()}
                      style={{
                        position: 'absolute', top: -6, [subOnLeft ? 'right' : 'left']: 'calc(100% + 9px)',
                        width: 236, maxHeight: 340, overflowY: 'auto', ...MENU_SURFACE, animation: 'stFadeUp 0.12s ease both',
                      }}>
                      <PlaylistPickList playlists={playlists} artFor={plArt}
                        stateOf={(pl) => (saved && (pl.trackIds || []).includes(t.id) ? 'all' : 'none')}
                        onPick={togglePlaylist} onCreate={onCreatePlaylist ? createWithSong : null} />
                    </div>
                  ) : null}
                </div>
              ) : null}
              {!saved && row && !row.notOut ? (
                <MenuItem accentRgb={acc} onClick={() => { downloadSpotifyRow(row, { noPicker: true }); close(); }}
                  icon={<><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></>} label="Save to library" />
              ) : null}
              {saved && onToggleFavorite ? (
                <MenuItem accentRgb={acc} onClick={() => { onToggleFavorite(t.id); close(); }}
                  icon={<path d="M20.8 8.6a5 5 0 0 0-8.8-2.6A5 5 0 0 0 3.2 8.6c0 4.2 5.5 7.6 8.8 10.4 3.3-2.8 8.8-6.2 8.8-10.4z" />}
                  label={t.isFavorite ? 'Remove from Favorites' : 'Add to Favorites'} keys={keysText('favorite')} />
              ) : null}
              {sep}
              {/* The bar's menu: back to the playlist or mix it's playing
                  from. An album is Go to album, just below. */}
              {rowMenu.bar && npFromShown && npFromShown.kind !== 'album' && t.id === currentTrack?.id ? (
                <MenuItem accentRgb={acc} onClick={() => { close(); openFrom(); }}
                  icon={<><path d="M4 6h12M4 12h12M4 18h8" /><path d="M16 15l3 3-3 3" /></>}
                  label={<span style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Go to {npFromShown.name || 'playlist'}</span>} />
              ) : null}
              {artistName ? (
                <MenuItem accentRgb={acc} onClick={() => { close(); openArtistAnywhere({ name: artistName, spotifyId: row?.artistIds?.[0] || null }); }}
                  icon={<><circle cx="12" cy="8" r="4" /><path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5" /></>} label="Go to artist" />
              ) : null}
              {t.album || row?.albumId ? (
                <MenuItem accentRgb={acc} onClick={goAlbum}
                  icon={<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.5" /></>} label="Go to album" />
              ) : null}
              <MenuItem accentRgb={acc} onClick={copyLink}
                icon={<><path d="M4 12v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" /><path d="M16 6l-4-4-4 4" /><path d="M12 2v14" /></>}
                label="Copy Spotify link"
                sub={sharing === t.id ? 'Looking up…' : undefined} keys={keysText('copyLink')} />
              {theme.streamerMode && !row?.notOut ? (() => {
                const hit = blockedBy(srBlocked, row || t);
                return (
                  <MenuItem accentRgb={acc} onClick={() => { close(); toggleSrBlock(hit ? null : songEntry(row || t), hit); }}
                    icon={<><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></>}
                    label={hit ? 'Unblock from requests' : 'Block from requests'}
                    sub={hit?.kind === 'artist' ? `Every song by ${hit.name} is blocked` : undefined} />
                );
              })() : null}
              {saved && onUpdateTrackMetadata && !rowMenu.bar ? (
                <MenuItem accentRgb={acc} onClick={() => {
                  /* The editor opens on the page, so the album view (above
                     it) closes first, as its own Edit Info does. */
                  setPaletteOpen(false);
                  setEditingTrack(t); close();
                }}
                  icon={<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />}
                  label="Edit info" />
              ) : null}

              {/* From the Now Playing bar's "…": the player's own options. */}
              {rowMenu.bar ? (
                <>
                  {sep}
                  <MenuItem accentRgb={acc} onClick={() => { close(); setNpFull((v) => !v); }}
                    icon={<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />}
                    label={npFull ? 'Exit Fullscreen' : 'Enter Fullscreen'} keys={keysText('fullscreen')} />
                  <MenuItem accentRgb={acc} onClick={() => { close(); setThemeKey('darkMode', !dark); }}
                    icon={<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />}
                    label={dark ? 'Turn Off Dark Mode' : 'Turn On Dark Mode'} keys={keysText('darkMode')} />
                  {/* Immerse and the record's color both paint surfaces Dark
                      mode keeps dark, so they wait until it's off. */}
                  {!dark ? (
                    <MenuItem accentRgb={acc} onClick={() => { close(); toggleNpAnimatedBg(); }}
                      icon={<path d="M12 3.2c3.4 3.6 5.4 6.2 5.4 8.9a5.4 5.4 0 1 1-10.8 0c0-2.7 2-5.3 5.4-8.9z" />}
                      label={npAnimatedBg ? 'Turn Off Immerse' : 'Turn On Immerse'} keys={keysText('immerse')} />
                  ) : null}
                  {/* The color strip hangs off the Now Playing bar, which isn't
                      mounted in fullscreen, so the item goes with it. */}
                  {!npFull && !dark ? (
                    <MenuItem accentRgb={acc} onClick={() => { close(); setColourStripReq((n) => n + 1); }}
                      icon={<><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" /></>}
                      label="Change Colors" keys={keysText('colour')} />
                  ) : null}
                  <MenuItem accentRgb={acc} onClick={() => { close(); toggleCompactMode(); }}
                    icon={<><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 15h18" /></>}
                    label={compactMode ? 'Turn Off Compact Mode' : 'Turn On Compact Mode'} keys={keysText('compact')} />
                </>
              ) : null}
              {saved && onRemoveFromLibrary && !rowMenu.bar && !inQueue ? (
                <>
                  {sep}
                  <MenuItem accentRgb={acc} danger onClick={() => { onRemoveFromLibrary([t.id]); close(); }}
                    icon={<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />}
                    label="Remove from library" />
                  {albumTracks.length > 1 && !plHere ? (
                    <MenuItem accentRgb={acc} danger onClick={() => { onRemoveFromLibrary(albumTracks.map((x) => x.id)); close(); }}
                      icon={<><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M9 15l6-6M9 9l6 6" /></>}
                      label="Remove whole album"
                      sub={`${t.album} · ${albumTracks.length} songs`} />
                  ) : null}
                </>
              ) : null}
            </div>
          </>,
          document.body,
        );
      })() : null}

      {shortcutsOpen ? <ShortcutsDialog dark={dark} onClose={() => setShortcutsOpen(false)} /> : null}

      {/* Clear-library confirmation. Typed phrase, not a yes/no — a
          misclicked "Clear everything" has no undo path. */}
      {clearConfirm ? (
        <Dialog title="Clear Library" width={430} busy={clearing} onClose={() => setClearConfirm(null)}
          actions={[
            { label: 'Cancel', disabled: clearing, onClick: () => setClearConfirm(null) },
            {
              label: clearing ? 'Clearing…' : 'Clear Library', kind: 'danger', disabled: clearing || !(clearPhrase.trim().toLowerCase() === 'clear'),
              onClick: async () => {
                setClearing(true);
                try {
                  const r = await onClearLibrary?.({ deleteFiles: !!clearConfirm.deleteFiles });
                  if (r?.ok) {
                    const bits = [`Cleared ${r.cleared ?? 0} song${(r.cleared ?? 0) === 1 ? '' : 's'}`];
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
              },
            },
          ]}>
          <div>
            This removes <strong style={{ color: 'var(--st-text)' }}>{library.length} song{library.length === 1 ? '' : 's'}</strong>,
            along with your playlists and album notes. It can’t be undone.
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
                Only files Studio downloaded itself. Music you imported from elsewhere on
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
        </Dialog>
      ) : null}

      {/* Delete-everything confirmation. One rung above Clear library — it
          also wipes listening stats and drops the onboarded flag, so the app
          returns to its first-run setup. Typed phrase, same rule as above. */}
      {clearAllConfirm ? (
        <Dialog title="Delete Everything" width={430} busy={clearingAll} onClose={() => setClearAllConfirm(null)}
          actions={[
            { label: 'Cancel', disabled: clearingAll, onClick: () => setClearAllConfirm(null) },
            {
              label: clearingAll ? 'Deleting…' : 'Delete Everything', kind: 'danger', disabled: clearingAll || !(clearAllPhrase.trim().toLowerCase() === 'delete everything'),
              onClick: async () => {
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
              },
            },
          ]}>
          <div>
            This removes <strong style={{ color: 'var(--st-text)' }}>{library.length} song{library.length === 1 ? '' : 's'}</strong>,
            every playlist, album note, and{' '}
            <strong style={{ color: 'var(--st-text)' }}>all listening history</strong>, then
            returns Studio to its first-run setup screen. It can’t be undone.
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
                Only files Studio downloaded itself. Music you imported from elsewhere on
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
        </Dialog>
      ) : null}

      {/* Metadata editor — same floating glass modal the overlay uses. */}
      {editingTrack && onUpdateTrackMetadata ? (
        <React.Suspense fallback={null}>
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
        </React.Suspense>
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
          {/* Colour override for this record: a tab that pulls out of the
              bar's top edge on hover. */}
          <ColourStrip
            hover={barHover}
            enabled={!dark}
            openRequest={colourStripReq}
            hoverOpens={theme.colourStripHover !== false}
            // Only a bar that shows the record's color gets the splash; a fixed bar color doesn't change.
            paints={immerse || vtheme.barSurface === 'cover'}
            swatches={npWashTheme?.swatches || []}
            current={coverOverride}
            auto={barTone(autoRgb || accent)}
            /* The tab is the bar's own surface, whichever one it's showing. */
            surface={immerse ? `rgb(${immersePalette?.wash || '18, 18, 22'})`
              : vtheme.barSurface === 'cover' ? `rgb(${npBarSolidWash})` : 'var(--np-bar-bg, var(--surface))'}
            onPick={(rgb, at) => {
              setCoverColourFor(rgb);
              if (at) setBarSplash({ key: Date.now(), rgb: rgb || barTone(autoRgb || accent), ...at });
            }}
          />

        <NowPlayingBar
          track={currentTrack}
          compact={compactMode}
          isPlaying={isPlaying}
          art={currentTrack ? coverFor(currentTrack) : null}
          accent={accent}
          onZoomCover={openCoverZoom}
          onCopyLink={copySpotifyLink}
          copyBusy={!!currentTrack && sharing === currentTrack.id}
          onOpenArtist={openArtistAnywhere}
          onTogglePlay={onTogglePlay}
          onPrev={onPrev}
          onNext={onNext}
          volume={volume}
          onSetVolume={onSetVolume}
          gainBoost={gainBoost}
          onSetGainBoost={onSetGainBoost}
          getGainReduction={getGainReduction}
          animatedBg={npAnim}
          /* Immerse off: the bar is its own colour, or the cover's, per the
             one setting that governs it. Immerse on: the animated artwork
             gradient takes over and nothing else applies. */
          solidWash={!immerse && vtheme.barSurface === 'cover' ? npBarSolidWash : null}
          immersePalette={immersePalette}
          immerseOn={npAnim}
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
          savedTrack={npSaved}
          onSaveToLibrary={saveCurrentToLibrary}
          saveBusy={npSaveBusy}
          saveFailed={npSaveFailed}
          onAddToPlaylist={onAddTracksToPlaylist ? (e, t) => {
            const r = e.currentTarget.getBoundingClientRect();
            // Right-aligned to the button and growing upward — the bar sits
            // on the bottom edge, so a downward menu would open off-screen.
            openPlaylistPicker(t, { x: r.right - 288, y: r.top - 10, above: true });
          } : null}
          onMore={openBarMenu}
          from={theme.npSource !== false ? npFromShown : null}
          /* A playlist (Liked Songs and mixes are playlists too) always has
             its own line: it isn't the song's, so it shouldn't read as part of
             its credit. An album beside the artist does. */
          fromLayout={['playlist', 'liked', 'mix'].includes(npFromShown?.kind) || theme.npSourceLayout === 'line' ? 'line' : 'artist'}
          onOpenFrom={openFrom}
          shuffleOn={shuffleOn}
          repeat={repeat}
          onToggleShuffle={onToggleShuffle}
          onToggleRepeat={onToggleRepeat}
          onSeek={onSeek}
          onHoverChange={barHover.emit}
          splash={barSplash}
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
        onClearQueue={clearUpNext}
        onQueueMenu={openQueueMenu}
        playSource={playSource}
        onOpenSource={openQueueSource}
        /* "Up next" starts one past the current track, and reorder works in
           absolute queue positions — this is the offset between the two. */
        queueOffset={queueIndex >= 0 ? queueIndex + 1 : 0}
        surface={immerse ? 'immerse' : vtheme.panelSurface}
        immersePalette={immersePalette}
        /* Match bar: whatever the bar is showing, its fixed colour included. */
        barWash={vtheme.barSurface === 'cover' ? npBarSolidWash : (hexToRgb(dark ? DARK.bar : npBarColor) || npBarSolidWash)}
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
        onSeek={onSeek}
        /* Opens fullscreen on the tab the dock was showing, so the thing
           you were reading carries over instead of disappearing. */
        onExpand={() => { setNpFullTab(npPanelTab); try { localStorage.setItem('studio:npFullTab', npPanelTab || ''); } catch { /* ignore */ } setNpFull(true); }}
        artistInfo={artistInfo}
        plays={currentTrack ? playCountFor(currentTrack.id) : 0}
        credits={panelCredits}
      />

      {npFull && currentTrack ? (
        <NowPlayingFullView
          dark={dark}
          track={currentTrack}
          art={coverFor(currentTrack)}
          accent={accent}
          isPlaying={isPlaying}
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
          savedTrack={npSaved}
          onSaveToLibrary={saveCurrentToLibrary}
          saveBusy={npSaveBusy}
          saveFailed={npSaveFailed}
          onAddToPlaylist={onAddTracksToPlaylist ? (e, t) => {
            const r = e.currentTarget.getBoundingClientRect();
            openPlaylistPicker(t, { x: Math.max(12, r.left + r.width / 2 - 144), y: r.top - 10, above: true });
          } : null}
          onMore={openBarMenu}
          onCopyLink={copySpotifyLink}
          copyBusy={sharing === currentTrack.id}
          onZoomCover={openCoverZoom}
          animatedBg={npAnim}
          immersePalette={immersePalette}
          tab={npFullTab}
          onTab={pickNpFullTab}
          onClose={() => setNpFull(false)}
          coverFor={coverFor}
          upNext={queueIndex >= 0 ? queue.slice(queueIndex + 1) : []}
          onSelectTrack={(t) => onPlayTrack?.(t, queue)}
          onReorderQueue={onReorderQueue}
          onClearQueue={clearUpNext}
          onQueueMenu={openQueueMenu}
          playSource={playSource}
          onOpenSource={openQueueSource}
          queueOffset={queueIndex >= 0 ? queueIndex + 1 : 0}
          lyricsData={lyricsData}
          onLyricsSaved={onLyricsSaved}
          onBrowseLyrics={onPickLyrics ? () => setLyricsPickReq((n2) => n2 + 1) : null}
          lyricSelection={lyricSel}
          onLyricSelectStart={startLyricSel}
          onLyricSelectLine={extendLyricSel}
          artistInfo={artistInfo}
        plays={currentTrack ? playCountFor(currentTrack.id) : 0}
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
            background: 'var(--st-dark-float, rgba(16,16,20,0.9))',
            border: '1px solid rgba(var(--st-fg-rgb), 0.09)',
            boxShadow: '0 12px 44px rgba(0,0,0,0.55)',
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(var(--st-text-rgb), 0.72)', fontVariantNumeric: 'tabular-nums' }}>
            {selectedLyricLines.length} line{selectedLyricLines.length === 1 ? '' : 's'} selected
          </span>
          <button type="button" onClick={() => setLyricShareOpen(true)}
            style={{
              padding: '7px 16px', borderRadius: 9,
              border: `1px solid rgba(${readableAccent(accent)},0.45)`,
              background: `rgba(${readableAccent(accent)},0.28)`,
              color: 'var(--st-text)', fontSize: 12, fontWeight: 700, cursor: 'pointer',
            }}
          >
            Make Card
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
        <React.Suspense fallback={null}>
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
        </React.Suspense>
      ) : null}

      {/* Album metadata — the editor the overlay already used, now reachable
          from the album page. */}
      {albumEditScope && onUpdateAlbumMetadata ? (
        <React.Suspense fallback={null}>
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
        </React.Suspense>
      ) : null}

      {plPicker ? (() => {
        const t = plPicker.track;
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
            {/* The song menu's header and the same playlist list as every
                other Add to Playlist, as a popover from the bar's button. */}
            <div data-rowmenu="" className="sth-libscroll" onClick={(e) => e.stopPropagation()}
              style={{ position: 'fixed', zIndex: 401, left, ...vpos, width: W, maxHeight: 392, overflowY: 'auto', ...MENU_SURFACE }}>
              <MenuHead art={coverFor(t)} title={t?.title} sub={[t?.artist, t?.album].filter(Boolean).join(' · ')} />
              <PlaylistPickList playlists={playlists || []} artFor={plArt}
                stateOf={(pl) => ((pl.trackIds || []).includes(t.id) ? 'all' : 'none')}
                onPick={(pl) => pickPlaylistNow(pl.id)}
                onCreate={onCreatePlaylist ? createFromPlPicker : null} />
            </div>
          </Modal>
        );
      })() : null}

      {/* Edit profile — name and avatar. Local only; nothing is uploaded. */}
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
          <Dialog title="Edit Playlist" onClose={() => setRenamePl(null)}
            start={art ? <button type="button" className="st-dlg-btn is-secondary" onClick={() => setRenamePl((r) => ({ ...r, coverArt: null }))}>Remove Cover</button> : null}
            actions={[
              { label: 'Cancel', onClick: () => setRenamePl(null) },
              { label: 'Save', kind: 'primary', disabled: !renamePl.name.trim(), onClick: save },
            ]}>
            <div style={{ display: 'flex', gap: 14, paddingTop: 2 }}>
              <label className="sth-plcover" style={{
                position: 'relative', width: 104, height: 104, borderRadius: 9, flexShrink: 0, overflow: 'hidden', cursor: 'pointer',
                background: art ? `url("${art}") center/cover` : 'rgba(var(--st-fg-rgb), 0.07)',
                border: art ? 'none' : '1px dashed rgba(var(--st-fg-rgb), 0.2)',
              }}>
                <div className="sth-plcover-veil" style={{ opacity: art ? undefined : 1, background: art ? undefined : 'transparent' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="M21 16l-5-5-8 8" />
                  </svg>
                  <span style={{ fontSize: 10.5, fontWeight: 650, marginTop: 6 }}>{art ? 'Replace' : 'Add Cover'}</span>
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
                <div className="st-eyebrow" style={{ marginBottom: 6 }}>Name</div>
                <input className="st-dlg-input" autoFocus value={renamePl.name}
                  onChange={(e) => setRenamePl((r) => ({ ...r, name: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter' && renamePl.name.trim()) save(); }} />
              </div>
            </div>
          </Dialog>
        );
      })() : null}

      {/* New playlist. A dialog rather than an inline row: the name is the
          only field, and an inline editor in the rail would shift the list
          under the pointer as you type. */}
      {newPlaylist ? (
        <Dialog title="New Playlist" width={380} onClose={() => setNewPlaylist(null)}
          actions={[
            { label: 'Cancel', onClick: () => setNewPlaylist(null) },
            { label: 'Create', kind: 'primary', disabled: !newPlaylist.name.trim(), onClick: createPlaylistNow },
          ]}>
          <input className="st-dlg-input" autoFocus value={newPlaylist.name} placeholder="Playlist name"
            onChange={(e) => setNewPlaylist({ name: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter' && newPlaylist.name.trim()) createPlaylistNow(); }} />
        </Dialog>
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
        nowPlaying={currentTrack ? { id: currentTrack.id, isRow: mySpotifyBridge.isCurrent, playing: !!isPlaying } : null}
        onTogglePlay={onTogglePlay}
        onSongMenu={openSongMenu}
        library={library}
        alreadyOwned={alreadyOwned}
        coverFor={coverFor}
        dlState={dlState}
        dlProgress={dlProgress}
        onGetSpotifyTrack={downloadSpotifyRow}
        onPlaySpotifyRows={(rows, i, opts) => mySpotifyBridge.playRows(rows, i, opts)}
        record={paletteRecord}
        liveRecord={libPlaylistLive}
        /* The song playing, for the mini player along the bottom of a
           playlist. */
        mini={currentTrack ? {
          track: currentTrack, art: coverFor(currentTrack) || null, playing: !!isPlaying, duration: duration || currentTrack.duration || 0,
          onToggle: onTogglePlay, onPrev, onNext, onSeek,
          shuffleOn, repeat, onToggleShuffle, onToggleRepeat,
          volume, onSetVolume, gainBoost, onSetGainBoost, getGainReduction,
        } : null}
        look={albumLook}
        onGetSlskFile={downloadSoulseekRow}
        onGetSlskAlbum={downloadSsAlbum}
        onPlayTrack={(t) => onPlayTrack?.(t, library, 'list')}
        onSpotifyLink={openSpotifyLinkText}
        seed={paletteSeed}
        onFilterLibrary={(q) => {
          setLibFilter(q);
          pickSection('library');
        }}
        onOpenLibraryAlbum={(t) => openAlbumFromRow(t)}
        libAlbumOf={(t) => ((t?.album || '').trim() && albumKeyOf(t) !== '::' ? libAlbumRecord(albumKeyOf(t), t)?.album || null : null)}
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
              theme={vtheme}
              playEvents={playEvents}
              currentTrack={currentTrack}
              isPlaying={isPlaying}
              onPlayTrack={onPlayTrack}
              onTogglePlay={onTogglePlay}
              onOpenAlbum={(key, group) => { const rec = libAlbumRecord(group || key); if (rec) nav.openRecord(rec.album); }}
              onOpenRelease={nav.openAlbum}
              viewState={nav.viewState}
              onViewState={nav.onViewState}
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
              // Popular plays here too, saved or not, the same as the full page.
              spotifyBridge={mySpotifyBridge}
            />
          );
        }}
      />
    </div>
    </CompactVizContext.Provider>
  );
}
