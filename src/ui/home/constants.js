

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
export const NP_BAR_DEFAULT = '#20242f';

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
export const THEME_DEFAULTS = {
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
  recordLayout: 'classic',  // album/playlist page layout; see RECORD_LAYOUTS in RecordPage.jsx
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

export const TOPBAR_H = 62;

/* Library rail. 'recent' first because that's the view you want after an
   import, which is when you open the library most. */
/* Sidebar order, per the mockup. 'recent' is kept as a view id — Home's empty
   state and the import flow both navigate to it — but it isn't a sidebar row:
   Songs already sorts by date added, so a separate entry duplicated it. */
export const LIB_VIEWS = [
  ['songs', 'Songs', 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm12-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'],
  ['albums', 'Albums', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  ['artists', 'Artists', 'M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM21 21v-2a4 4 0 0 0-3-3.87'],
];

/* Sidebar, above Library: the signed-in Spotify account's own pages
   (MySpotify.jsx). They replaced the old Home and Stats tabs in the top bar. */
export const MY_SPOTIFY = [
  ['sp-home', 'Home', 'M3 11l9-8 9 8M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5'],
  ['sp-releases', 'New Releases', 'M12 3l1.9 5.6L19.5 10.5 13.9 12.4 12 18l-1.9-5.6L4.5 10.5l5.6-1.9L12 3zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z'],
];
export const MY_SPOTIFY_IDS = new Set(MY_SPOTIFY.map(([id]) => id));
/* Sections that no longer exist, from stored nav state and old callers. */
export const LEGACY_SECTIONS = new Set(['home', 'stats', 'discover', 'find']);

/* Library width. The sidebar is a permanent column beside the content, not a
   tab you switch to — so the wrapper starts after it rather than under it. */
export const SIDEBAR_W = 236;



/** Tiny 3-bar equalizer marking the playing row in the library panel.
 *  Animates while playing, freezes as short bars when paused. */





/** Floating Now Playing bar — the collapsed form of the panel, pinned to the
 *  bottom of the library content area (Spotify-mobile style). Keeps the
 *  animated background when that option is on. Clicking the body (not a
 *  control) expands back to the full panel. */

/* Width of the docked Now Playing panel. Exported as a constant because the
   content wrapper has to reserve exactly this much when it's open — a
   mismatch shows up as either a gap or a clipped panel. */
export const NP_PANEL_W = 360;


export const NP_PANEL_TABS = [
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
export const NP_FULL_TABS = [
  ['lyrics', 'Lyrics', 'L'],
  ['queue', 'Queue', 'Q'],
  ['info', 'Info', 'I'],
];

/* ---------------------------------------------------------------------------
 *  Colour picking, in Studio's own language.
 *
 *  `<input type="color">` opens the browser's dialog, which is drawn by the OS
 *  outside the page — no stylesheet can reach it, so it arrives as a grey
 *  system box in the middle of a dark app. This is the same job done in the
 *  document: a saturation/value field, a hue rail, a hex box and the presets
 *  Studio actually uses.
 * ------------------------------------------------------------------------- */

export const PICKER_PRESETS = [
  '#000000', '#0e0e12', '#20242f', '#3b3f52',
  '#7a6ae0', '#a84ab4', '#e2506a', '#e0803c',
  '#d8c04a', '#4ca86a', '#3f9fd0', '#ffffff',
];

export const SORT_LABELS = { title: 'Title', artist: 'Artist', album: 'Album', recent: 'Recently added' };
