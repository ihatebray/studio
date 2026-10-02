import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import StudioShell from './StudioShell.jsx';
import {
  getStoredFontId,
  storeFontId,
  presetById,
  ensureControlFontInheritance,
  loadGoogleFontForPreset,
} from '../lib/uiFonts.js';
import { useToastBus, ToastStack, ToastContext, recordNotice } from './Toasts.jsx';
import { SpotifyMediaElement, spotifyIdOf, preloadStreamed } from '../lib/spotifyMediaElement.js';
import { playContextFor } from '../lib/playContext.js';
import { titleCollator } from '../lib/mediaUtils.js';
import { loadCustomFonts } from '../lib/customFonts.js';
import { ImmerseTooltipLayer } from './sharedUI.jsx';
import { useFileDrop, DropOverlay } from './ImportDropZone.jsx';

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Default Discord Application ID baked into the build, used when the
 * user hasn't entered their own. Lets Discord rich presence work
 * zero-setup — toggling the feature on Just Works, broadcasting
 * "Listening to Immerse" with the bundled app's name and assets.
 *
 * Users can still override in Settings (paste their own App ID) if
 * they want their Discord profile to credit a custom application.
 *
 * Set this to your created Discord application's "Application ID"
 * value from discord.com/developers/applications. Leave as empty
 * string to require user-supplied IDs only.
 */
const DEFAULT_DISCORD_APP_ID = ''; // ← paste your Discord App ID here

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}


function sortByTitle(arr) {
  return [...arr].sort((a, b) =>
    titleCollator.compare(String(a.title || ''), String(b.title || ''))
    || titleCollator.compare(String(a.id), String(b.id))
  );
}

/**
 * Overlay freshly parsed cover art (and duration) onto DB rows for paths
 * present in `batch`. We deliberately copy both `coverArt` (which may
 * be a fast-rendering data: URI for the app's own UI) and `coverArtUrl`
 * (the public http(s) URL that Discord's media proxy can fetch). The DB
 * only persists one column so the round-trip via rowToTrack loses the
 * URL form; without re-overlaying it here, the in-memory track right
 * after import has only the data URI, and Discord falls back to its
 * asset key. The next app restart would heal it (rowToTrack puts the
 * URL into coverArt), but that's a confusing user-visible inconsistency.
 */
/**
 * Map a linear slider value (0..1) to a perceptual audio gain (0..1).
 *
 * Human loudness perception is roughly logarithmic, so a linear volume
 * slider feels wrong: it's already loud at 10% and most of the audible
 * change happens in the bottom third. Applying a power curve makes the
 * slider feel even across its whole range — genuinely quiet at the
 * bottom, ramping up gradually, and unchanged at the very top.
 *
 * We use gain = value^EXPONENT. At EXPONENT = 2.5:
 *   slider 1.0  → gain 1.000  (full, unchanged — keeps the "extremely loud" top)
 *   slider 0.75 → gain 0.487
 *   slider 0.5  → gain 0.177  (much quieter than the old linear 0.5)
 *   slider 0.25 → gain 0.031
 *   slider 0.1  → gain 0.003  (a real, quiet low end)
 *   slider 0.0  → gain 0.000
 *
 * The top of the slider is intentionally untouched (1^2.5 = 1) so the
 * loud ceiling everyone likes is preserved; only the lows and mids get
 * pulled down so there's room to ramp.
 */
const VOLUME_CURVE_EXPONENT = 2.5;
function perceptualVolume(linear) {
  const v = Math.max(0, Math.min(1, Number(linear) || 0));
  return Math.pow(v, VOLUME_CURVE_EXPONENT);
}

function mergeCoverArt(fromDb, batch) {
  if (!batch?.length) return fromDb;
  const rich = new Map(batch.map((t) => [t.filePath, t]));
  return fromDb.map((t) => {
    const r = rich.get(t.filePath);
    if (!r) return t;
    const next = { ...t };
    if (r.coverArt) {
      // If the DB track had a studio-cover:// URL and we're about to
      // overwrite it with a freshly-parsed data: URI, preserve it in
      // coverArtLocal so the Discord RPC imgbb uploader can still find it.
      // Without this, the studio-cover:// URL is lost in-memory for the
      // duration of the session and the imgbb upload path never triggers.
      if (typeof t.coverArt === 'string' && t.coverArt.startsWith('studio-cover://')) {
        next.coverArtLocal = t.coverArt;
      }
      next.coverArt = r.coverArt;
    }
    if (r.coverArtUrl) next.coverArtUrl = r.coverArtUrl;
    if (r.duration) next.duration = r.duration || t.duration;
    return next;
  });
}

export default function App() {
  const [library, setLibrary] = useState([]);
  const [libraryBootstrapped, setLibraryBootstrapped] = useState(() => typeof window === 'undefined' || !window.electronAPI);
  const [playlists, setPlaylists] = useState([]);

  // Global toast bus — used by the auto-updater (and anywhere else that
  // needs to surface a transient confirmation/error from the app shell).
  const { toasts, pushToast, dismissToast } = useToastBus();
  // Album display-art overrides { albumKey: url } — cosmetic album-view art
  // that's independent of every track's own cover. Loaded with the library.
  const [albumCoverOverrides, setAlbumCoverOverrides] = useState({});

  // Direct set — called from the album metadata editor's save path with a
  // data URI (or null to clear). Main persists the image and returns the
  // stable url, which we mirror into the in-memory map so album view
  // updates instantly.
  const handleSetAlbumCover = useCallback(async (albumKey, url) => {
    if (!albumKey || !window.electronAPI?.setAlbumCoverUrl) return;
    try {
      const res = await window.electronAPI.setAlbumCoverUrl(albumKey, url || null);
      if (res?.ok) {
        setAlbumCoverOverrides((m) => {
          const n = { ...m };
          if (res.url) n[albumKey] = res.url; else delete n[albumKey];
          return n;
        });
      } else if (res?.error) {
        pushToast({ message: res.error, kind: 'error' });
      }
    } catch (e) {
      pushToast({ message: String(e?.message || e), kind: 'error' });
    }
  }, [pushToast]);

  const updateToastIdRef = useRef(null);

  // "What's new" overlay state. Shown once after every version bump.
  //   whatsNewOpen: boolean controlling visibility of the overlay
  //   whatsNewData: { version, name, body, url, publishedAt } once we've
  //                 fetched the notes from GitHub. Null while loading or
  //                 if the fetch failed (in which case we don't show
  //                 the overlay at all — silent failure is preferable
  //                 to a "couldn't load release notes" splash).
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [whatsNewData, setWhatsNewData] = useState(null);

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.appGetVersion || !api?.whatsnewGetLastSeen) return;
    // Don't show the overlay in dev mode — there's no "release" for an
    // unpackaged build, the fetch would 404, and it'd be noise during
    // development.
    let cancelled = false;
    (async () => {
      try {
        const currentVersion = String(await api.appGetVersion());
        const seen = await api.whatsnewGetLastSeen();
        const lastSeen = String(seen?.version || '');
        if (cancelled) return;
        // Already shown for this version (or earlier of the same).
        // Comparison is string-based which is wrong for proper semver
        // (1.0.10 < 1.0.9 stringwise), but for our linear bump pattern
        // an EXACT match check is sufficient: we only need to know
        // "did we show notes for THIS version yet?" If yes, skip; if
        // no, show. After showing once, we save currentVersion so the
        // next launch sees an exact match and skips.
        if (lastSeen === currentVersion) return;
        // Fetch release notes. Failure is silent — better to skip
        // than show a broken overlay.
        const notes = await api.whatsnewFetchReleaseNotes(currentVersion);
        if (cancelled) return;
        if (!notes?.ok || !notes.body) {
          // Mark as seen anyway so we don't refetch every launch when
          // the release page has no body or the release hasn't been
          // created yet.
          try { await api.whatsnewSetLastSeen(currentVersion); } catch { /* ignore */ }
          return;
        }
        setWhatsNewData({
          version: currentVersion,
          name: notes.name || `v${currentVersion}`,
          body: notes.body,
          url: notes.url || '',
          publishedAt: notes.publishedAt || null,
        });
        setWhatsNewOpen(true);
      } catch { /* swallow — no overlay on any error */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const dismissWhatsNew = useCallback(async () => {
    setWhatsNewOpen(false);
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.whatsnewSetLastSeen || !whatsNewData?.version) return;
    try { await api.whatsnewSetLastSeen(whatsNewData.version); } catch { /* ignore */ }
  }, [whatsNewData]);


  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.onUpdateStatus) return undefined;
    const unsub = api.onUpdateStatus((s) => {
      if (!s) return;
      // Surface the "ready to install" prompt as a toast with an action
      // button. Push exactly once per download cycle by tracking the
      // toast id; if a second 'downloaded' event arrives (shouldn't,
      // but defensive), we won't stack duplicates.
      if (s.state === 'downloaded' && !updateToastIdRef.current) {
        const id = pushToast({
          message: `Update ready${s.version ? ` (v${s.version})` : ''}. Restart to install.`,
          kind: 'info',
          durationMs: 0, // 0 = no auto-dismiss; user has to click
          action: {
            label: 'Restart',
            // The toast bus expects `onClick`, not `handler`. Older
            // code in this file accidentally used `handler` which
            // meant the button silently did nothing because Toasts.jsx
            // guards on `!toast.action?.onClick`.
            onClick: () => {
              try { api.updateInstall?.(); }
              catch { /* main quits us regardless */ }
            },
          },
        });
        updateToastIdRef.current = id;
      }
      // Reset the toast tracker on any non-downloaded state so a future
      // check + download will be allowed to toast again.
      if (s.state !== 'downloaded' && updateToastIdRef.current) {
        updateToastIdRef.current = null;
      }
    });
    return () => { if (typeof unsub === 'function') unsub(); };
  }, [pushToast]);

  /* Problems the main process runs into (notices.js): Spotify rate limits,
     metadata falling back to Apple Music, the playback helper failing. A
     short toast now; the explanation stays in the notifications panel.
     Main already holds back repeats of the same notice. */
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.onAppNotice) return undefined;
    const unsub = api.onAppNotice((n) => {
      if (!n?.title) return;
      if (n.quiet) {
        recordNotice({ key: n.key || undefined, kind: n.kind || 'info', title: n.title, detail: n.detail, source: n.source, at: n.at });
        return;
      }
      pushToast({
        message: n.title, detail: n.detail, kind: n.kind || 'info', source: n.source,
        dedupeKey: n.key || undefined, log: true,
        durationMs: n.kind === 'error' ? 9000 : 7000,
      });
    });
    return () => { if (typeof unsub === 'function') unsub(); };
  }, [pushToast]);

  /** Recent releases (within last 30 days) for followed artists — cached server-side. */
  const [releases, setReleases] = useState([]);
  /** Manual follow-overrides: [{ artistName, action: 'add' | 'exclude', itunesArtistId }]. */
  const [followOverrides, setFollowOverrides] = useState([]);
  /** True while the main process is actively hitting iTunes to refresh the cache. */
  const [, setReleasesRefreshing] = useState(false);
  const [spotifyImportOpen, setSpotifyImportOpen] = useState(false);
  const [queue, setQueue] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(-1);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // Bumped on every audio `seeked` event so the Discord-presence effect
  // re-runs and re-anchors its wall-start timestamp. Without this, a
  // seek mid-song doesn't notify Discord and its progress bar keeps
  // counting from the pre-seek position.
  const [seekNonce, setSeekNonce] = useState(0);
  const [shuffleOn, setShuffleOn] = useState(false);
  const [repeat, setRepeat] = useState('off');


  // Track-to-track transition style:
  //   'off'       — hard cut (the next track's src is loaded only when the
  //                 previous ends; this is the original behaviour and has a
  //                 small unavoidable decode gap)
  //   'gapless'   — next track is preloaded into the standby element during
  //                 playback and started ~0.18s before the current ends, so
  //                 the seam is inaudible (no overlap)
  //   'crossfade' — next track starts `crossfadeSec` early and the two
  //                 overlap while one gain ramps down and the other up
  const [transitionMode, setTransitionMode] = useState(() => {
    if (typeof window === 'undefined') return 'off';
    const v = window.localStorage.getItem('immerse:transitionMode');
    if (v === 'off' || v === 'gapless' || v === 'crossfade') return v;
    return 'off';
  });
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem('immerse:transitionMode', transitionMode); }
      catch { /* ignore */ }
    }
    transitionModeRef.current = transitionMode;
  }, [transitionMode]);

  // Volume persists across launches. Defaults to 30% on first launch
  // so the app doesn't blast at full volume the first time. After that
  // it remembers whatever the user last set.
  const [volume, setVolume] = useState(() => {
    if (typeof window === 'undefined') return 0.3;
    try {
      const raw = window.localStorage.getItem('immerse:volume');
      if (raw == null) return 0.3;
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
      return 0.3;
    } catch {
      return 0.3;
    }
  });
  useEffect(() => {
    try { window.localStorage.setItem('immerse:volume', String(volume)); }
    catch { /* ignore */ }
  }, [volume]);


  /**
   * gainBoost — multiplier applied to the audio graph's GainNode, on top
   * of the regular volume slider. Lets the user push playback above the
   * OS-level 100% cap (HTMLAudioElement.volume is clamped to [0, 1]) for
   * tracks that are mastered too quietly, or just to crank.
   *
   * Range: 1.0 (passthrough — no boost) up to 16.0 (+24 dB of gain).
   * Most users will live in 1-4×; the 4-16× range is "this track was
   * mastered way too quietly" / "I'm across the room" territory. The
   * compressor in ensureAnalyser is tuned to keep the high end of the
   * range from sounding like a buzzsaw.
   *
   * Persisted across sessions because nothing is more annoying than
   * having to re-crank the volume every launch.
   *
   * A DynamicsCompressorNode sits after the gain stage as a safety net
   * for clipping when boost is high; see ensureAnalyser in this file.
   */
  const [gainBoost, setGainBoost] = useState(() => {
    try {
      const raw = localStorage.getItem('immerse:gainBoost');
      if (!raw) return 1;
      const n = parseFloat(raw);
      if (!Number.isFinite(n)) return 1;
      // Clamp on read in case a corrupted value snuck in.
      return Math.max(1, Math.min(16, n));
    } catch { return 1; }
  });
  useEffect(() => {
    try { localStorage.setItem('immerse:gainBoost', String(gainBoost)); } catch { /* ignore */ }
  }, [gainBoost]);

  const [importing, setImporting] = useState(false);
  /* Bumped to force a re-read of the play log from SQLite. Declared up here
     (rather than beside the log itself) so ingestPaths, which lives well above
     that code, can bump it without depending on declaration order. */
  const [playEventsNonce, setPlayEventsNonce] = useState(0);

  // Ambient mode: full-window cover collage that auto-engages after a
  // user-defined idle threshold. Behaviour is controlled by `ambientMode`:
  //   'off'     — never auto-engage
  //   'idle'    — only when no track loaded AND queue empty
  //   'pause'   — also when track is loaded but paused (relaxed)
  //   'custom'  — same as 'idle' but with user-specified delay
  // The delay is fixed at 30s for idle/pause; `ambientCustomDelaySec`
  // applies when mode === 'custom'. Both persist to localStorage.
  const [ambientMode] = useState(() => {
    if (typeof window === 'undefined') return 'idle';
    const v = window.localStorage.getItem('immerse:ambientMode');
    if (v === 'off' || v === 'idle' || v === 'pause' || v === 'custom') return v;
    return 'idle';
  });

  const [ambientCustomDelaySec] = useState(() => {
    if (typeof window === 'undefined') return 30;
    const raw = window.localStorage.getItem('immerse:ambientCustomDelaySec');
    const n = Number(raw);
    // Bounded so a fat-finger doesn't lock the user into a 24-hour wait.
    if (Number.isFinite(n) && n >= 5 && n <= 600) return Math.round(n);
    return 30;
  });

  const [ambientActive, setAmbientActive] = useState(false);
  // Toggle so a user who dismisses ambient mode doesn't immediately get
  // re-engaged the moment they stop interacting. Stays false until the
  // next time the player is actually used (currentTrack appears), then
  // flips back to true so future idle periods can re-engage.
  const [ambientArmed, setAmbientArmed] = useState(true);
  const [uiFontId, setUiFontId] = useState(getStoredFontId);
  /* Fonts you added yourself are registered with the page once, at startup. */
  useEffect(() => { loadCustomFonts(); }, []);
  /** Session flag — flips true the first time any track starts. Resets on next
   * launch. Used to render the Welcome screen until the user plays something. */
  const [hasEverPlayed, setHasEverPlayed] = useState(false);

  /** Beat reactivity — colour field pulses to the bass envelope of the playing audio.
   * Default OFF (audio analysis has a small CPU cost; keep the calm default behaviour). */
  const [beatReactive] = useState(() => {
    try {
      return typeof window !== 'undefined'
        && window.localStorage.getItem('immerse:beatReactive') === '1';
    } catch { return false; }
  });





  /* ---------- Experimental (Dev) toggles ----------------------------------
   *
   * Each of these gates a feature that's still being shaped. They live behind
   * a "DEV / EXPERIMENTAL" group in Settings so the user can opt in. Each
   * persists individually in localStorage under `immerse:dev:*` so they don't
   * collide with stable preferences and can all be wiped in one shot if a
   * future migration ever needs to.
   */









  useEffect(() => {
    try { window.localStorage.removeItem('immerse:dev:journalTab'); } catch { /* ignore */ }
  }, []);














  /** Discord rich presence — when enabled, broadcasts the playing
   * track to the user's Discord status (visible to friends and in
   * voice channels). Off by default for privacy. Requires the user
   * to have the Discord desktop client running and to provide their
   * own Application ID (created at discord.com/developers). */
  const [discordPresenceEnabled, setDiscordPresenceEnabled] = useState(() => {
    try {
      return typeof window !== 'undefined'
        && window.localStorage.getItem('immerse:dev:discordPresence') === '1';
    } catch { return false; }
  });
  useEffect(() => {
    try {
      if (discordPresenceEnabled) window.localStorage.setItem('immerse:dev:discordPresence', '1');
      else window.localStorage.removeItem('immerse:dev:discordPresence');
    } catch { /* ignore */ }
  }, [discordPresenceEnabled]);

  /** Discord application ID — user-provided string from
   * discord.com/developers/applications. Stored separately from the
   * toggle so the user can keep it set even when the feature is off.
   * If left empty, falls back to DEFAULT_DISCORD_APP_ID below so the
   * feature works out of the box. */
  const [discordAppId, setDiscordAppId] = useState(() => {
    try {
      return (typeof window !== 'undefined' ? window.localStorage.getItem('immerse:discordAppId') : null) || '';
    } catch { return ''; }
  });
  useEffect(() => {
    try {
      if (discordAppId.trim()) window.localStorage.setItem('immerse:discordAppId', discordAppId.trim());
      else window.localStorage.removeItem('immerse:discordAppId');
    } catch { /* ignore */ }
  }, [discordAppId]);

  // What the presence second line shows: 'full' (Artist · Album) or 'basic'
  // (Artist only). Default full.
  /* Settings → System → Hide when paused. Clears the Discord status while
     playback is stopped, rather than showing a frozen "paused" card. */
  const [discordHideWhenPaused, setDiscordHideWhenPaused] = useState(() => {
    try { return (typeof window !== 'undefined' ? window.localStorage.getItem('studio:discordHideWhenPaused') : null) !== '0'; } catch { return true; }
  });
  useEffect(() => {
    try { window.localStorage.setItem('studio:discordHideWhenPaused', discordHideWhenPaused ? '1' : '0'); } catch { /* ignore */ }
  }, [discordHideWhenPaused]);
  const [discordPresenceDetail, setDiscordPresenceDetail] = useState(() => {
    try {
      const v = (typeof window !== 'undefined' ? window.localStorage.getItem('immerse:discordPresenceDetail') : null);
      return v === 'basic' ? 'basic' : 'full';
    } catch { return 'full'; }
  });
  useEffect(() => {
    try { window.localStorage.setItem('immerse:discordPresenceDetail', discordPresenceDetail); } catch { /* ignore */ }
  }, [discordPresenceDetail]);

  /**
   * imgbb API key for uploading local cover art to a public URL so
   * Discord's media proxy can fetch it. Free, no OAuth — just sign up
   * at https://api.imgbb.com and paste the key shown on the dashboard.
   * Stored separately from the Discord toggle so the user keeps it set
   * while toggling the feature.
   */
  const [imgbbApiKey, setImgbbApiKey] = useState(() => {
    try {
      return (typeof window !== 'undefined' ? window.localStorage.getItem('immerse:imgbbApiKey') : null) || '';
    } catch { return ''; }
  });
  useEffect(() => {
    try {
      if (imgbbApiKey.trim()) window.localStorage.setItem('immerse:imgbbApiKey', imgbbApiKey.trim());
      else window.localStorage.removeItem('immerse:imgbbApiKey');
    } catch { /* ignore */ }
  }, [imgbbApiKey]);

  // Effective app ID used for the Discord IPC connection — the user's
  // value if they set one, otherwise the bundled default. Lets users
  // override (use their own Discord app, with their own naming and
  // image assets) but works zero-setup for everyone else.
  const effectiveDiscordAppId = (discordAppId.trim() || DEFAULT_DISCORD_APP_ID || '').trim();

  // Opt-in "now playing" toast on track change. Off by default; toggled in
  // Settings via the immerse:nowPlayingToast flag (read live so the toggle
  // takes effect without a reload). Uses a single deduped slot so rapid
  // skips refresh one toast instead of stacking.
  const lastNowPlayingToastId = useRef(null);
  useEffect(() => {
    let enabled = false;
    try { enabled = typeof window !== 'undefined' && window.localStorage.getItem('immerse:nowPlayingToast') === '1'; } catch { /* ignore */ }
    if (!enabled || !isPlaying) return;
    const track = queue[currentIndex];
    if (!track || track.id === lastNowPlayingToastId.current) return;
    lastNowPlayingToastId.current = track.id;
    const who = track.artist ? ` — ${track.artist}` : '';
    pushToast({
      message: `▶  ${track.title || 'Unknown track'}${who}`,
      kind: 'info',
      dedupeKey: 'now-playing',
      durationMs: 4000,
    });
  }, [queue[currentIndex]?.id, isPlaying, pushToast]);


  const audioRef = useRef(null);            // ALWAYS points at the active element
  const inactiveAudioRef = useRef(null);    // the standby element (preloads the next track)
  const firstElementRef = useRef(null);     // stable handle to "element A" so we can tell which crossfade gain is which
  /* Saved Spotify tracks play through the studio-spotify helper. While one is
     current, audioRef points at this stand-in element (spotifyMediaElement.js)
     instead of a real <audio>, and localAudioRef remembers which real element
     to go back to. inactiveAudioRef is always a real element. */
  const spotifyElRef = useRef(null);
  const localAudioRef = useRef(null);
  const seekGenerationRef = useRef(0);
  /** When this matches the active queue slot + file, we must not set `audio.src` again or playback restarts from 0. */
  const lastAudioLoadKeyRef = useRef(null);
  const handleNextRef = useRef(null);
  const libraryRef = useRef([]);
  libraryRef.current = library;
  const queueRef = useRef([]);
  queueRef.current = queue;

  /* ---- transition engine bookkeeping ----
   * preloadedKeyRef  : load-key currently staged in the standby element
   * handoffArmedRef  : true once a gapless/crossfade handoff has begun for the
   *                    current track (suppresses the active element's natural
   *                    'ended' so we don't double-advance)
   * transitionModeRef: mirror of `transitionMode` state, read inside event
   *                    handlers/callbacks without forcing a re-bind
   * crossfadeSecRef  : crossfade length in seconds */
  const preloadedKeyRef = useRef(null);
  const handoffArmedRef = useRef(false);
  const transitionModeRef = useRef('off');
  const crossfadeSecRef = useRef(6);

  const currentTrack = currentIndex >= 0 && queue[currentIndex] ? queue[currentIndex] : null;

  // Easter egg: detect "Fireflies" by Owl City. Normalizes title +
  // artist (lowercase, strip punctuation/parentheticals) so things like
  // "Fireflies (Remastered)" or "Owl City feat. ..." still match. When
  // this is true AND the song is playing, a swarm of fireflies drifts
  // across the whole window — see FirefliesOverlay below.
  const isFireflies = useMemo(() => {
    if (!currentTrack) return false;
    const norm = (s) => String(s || '')
      .toLowerCase()
      .replace(/\(.*?\)|\[.*?\]/g, '')
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const title = norm(currentTrack.title);
    const artist = norm(currentTrack.artist);
    return title === 'fireflies' && artist.includes('owl city');
  }, [currentTrack]);

  useEffect(() => {
    if (!window.electronAPI?.loadLibrary) {
      setLibraryBootstrapped(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const tracks = await window.electronAPI.loadLibrary();
        if (!cancelled && Array.isArray(tracks)) setLibrary(tracks);
        if (window.electronAPI?.loadAlbumCovers) {
          const ac = await window.electronAPI.loadAlbumCovers();
          if (!cancelled && ac?.ok) setAlbumCoverOverrides(ac.covers || {});
        }
      } catch (e) {
        console.error(e);
      } finally {
        if (!cancelled) setLibraryBootstrapped(true);
      }
      // Load playlists — not critical, don't block bootstrap on failure
      try {
        if (typeof window.electronAPI.loadPlaylists === 'function') {
          const pls = await window.electronAPI.loadPlaylists();
          if (!cancelled && Array.isArray(pls)) {
            // Same trackIds hydration as refreshPlaylists — bootstrap has to
            // do it too, or playlists read as empty until the first mutation.
            const withIds = await Promise.all(pls.map(async (pl) => {
              if (typeof window.electronAPI.loadPlaylistTrackIds !== 'function') return { ...pl, trackIds: [] };
              try {
                const ids = await window.electronAPI.loadPlaylistTrackIds(pl.id);
                return { ...pl, trackIds: Array.isArray(ids) ? ids : [] };
              } catch { return { ...pl, trackIds: [] }; }
            }));
            if (!cancelled) setPlaylists(withIds);
          }
        }
      } catch (e) {
        console.error('loadPlaylists failed', e);
      }
      // Load cached releases + follow overrides — also non-critical. The UI
      // shows whatever's cached immediately; a background refresh happens
      // separately in a different effect.
      try {
        if (typeof window.electronAPI.loadCachedReleases === 'function') {
          const r = await window.electronAPI.loadCachedReleases();
          if (!cancelled && r?.ok) setReleases(r.releases || []);
        }
      } catch (e) { console.error('loadCachedReleases failed', e); }
      try {
        if (typeof window.electronAPI.loadReleaseOverrides === 'function') {
          const r = await window.electronAPI.loadReleaseOverrides();
          if (!cancelled && r?.ok) setFollowOverrides(r.overrides || []);
        }
      } catch (e) { console.error('loadReleaseOverrides failed', e); }
    })();
    return () => { cancelled = true; };
  }, []);

  useLayoutEffect(() => {
    const preset = presetById(uiFontId);
    loadGoogleFontForPreset(preset);
    /* Controls don't inherit font-family on their own — see uiFonts.js. */
    ensureControlFontInheritance();
    document.body.style.fontFamily = preset.stack;
    storeFontId(uiFontId);
  }, [uiFontId]);

  useEffect(() => {
    if (!libraryBootstrapped || !window.electronAPI?.getMetadata) return undefined;
    let cancelled = false;
    const CAP = 200;
    const CONC = 4;
    const timer = setTimeout(async () => {
      const lib = libraryRef.current;
      const need = lib.filter((t) => t.filePath && !t.coverArt && !spotifyIdOf(t)).slice(0, CAP);
      for (let i = 0; i < need.length; i += CONC) {
        if (cancelled) return;
        const chunk = need.slice(i, i + CONC);
        const metas = await Promise.all(chunk.map((t) => window.electronAPI.getMetadata(t.filePath)));
        if (cancelled) return;
        setLibrary((prev) => {
          const byId = new Map(chunk.map((t, idx) => [t.id, metas[idx]]));
          return prev.map((t) => {
            const m = byId.get(t.id);
            if (!m?.coverArt) return t;
            return { ...t, coverArt: m.coverArt, duration: m.duration || t.duration };
          });
        });
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [libraryBootstrapped]);

  useEffect(() => {
    // Two elements that ping-pong: one plays while the other preloads the
    // next track. `audioRef` always points at whichever is currently active,
    // so every other site in this file that reads audioRef.current keeps
    // working unchanged.
    const a = new Audio();
    const b = new Audio();
    a.volume = perceptualVolume(volume);
    b.volume = perceptualVolume(volume);
    // preload='auto' lets the standby element buffer ahead of the handoff.
    a.preload = 'auto';
    b.preload = 'auto';
    audioRef.current = a;
    inactiveAudioRef.current = b;
    firstElementRef.current = a;
    localAudioRef.current = a;
    const sp = window.electronAPI?.spotifyPlayerLoad ? new SpotifyMediaElement(window.electronAPI) : null;
    spotifyElRef.current = sp;
    return () => {
      for (const el of [a, b]) {
        try { el.pause(); el.src = ''; } catch { /* ignore */ }
      }
      sp?.destroy();
      spotifyElRef.current = null;
      // Close the analyser graph if it was ever created. Safe to call even
      // if the context is already closed — close() on a closed context
      // throws an InvalidStateError which we swallow.
      if (audioCtxRef.current) {
        try { audioCtxRef.current.close(); } catch { /* ignore */ }
        audioCtxRef.current = null;
        audioSourceRef.current = null;
        audioSourceBRef.current = null;
        analyserRef.current = null;
      }
    };
  }, []);

  /* ---------- Web Audio analyser (for beat reactivity + visualizers) ----------
   *
   * A single AudioContext + AnalyserNode pair, lazily created on first
   * playback (browsers block AudioContext creation until user interaction).
   * Once `createMediaElementSource` is called on the <audio> element, all of
   * its output flows through the Web Audio graph permanently — there's no
   * way to undo it — so we wire it up exactly once and leave it alone.
   *
   * Visualizer components receive the `analyserRef` and pull frequency /
   * waveform data inside their own RAF loops. Storing the analyser in a ref
   * (not state) means consuming components don't re-render on each frame —
   * they read the current value directly from the ref.
   */
  const analyserRef = useRef(null);
  const audioCtxRef = useRef(null);
  const audioSourceRef = useRef(null);      // MediaElementSource for element A
  const audioSourceBRef = useRef(null);     // MediaElementSource for element B
  /** GainNode in the audio graph used to amplify playback above the OS
   *  100% cap. Driven by `gainBoost` state below. Shared stage AFTER the
   *  per-element crossfade gains, so boost applies to whatever is playing. */
  const gainNodeRef = useRef(null);
  /** The two dynamics stages that follow the gain. Held in refs because the
   *  boost control reads how much they are taking back, and because the
   *  compressor's threshold now tracks the boost rather than sitting still. */
  const compressorRef = useRef(null);
  const limiterRef = useRef(null);
  /** Per-element crossfade gains. During a crossfade one ramps to 0 while the
   *  other ramps to 1; otherwise both sit at 1. gainARef belongs to element A
   *  (firstElementRef), gainBRef to element B. */
  const gainARef = useRef(null);
  const gainBRef = useRef(null);

  const ensureAnalyser = useCallback(() => {
    if (analyserRef.current) return analyserRef.current;
    const audioA = firstElementRef.current || audioRef.current;
    const audioB = inactiveAudioRef.current;
    if (!audioA) return null;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      const ctx = new Ctx();

      // Wire one element into a source + its own crossfade gain. Each element
      // MUST get its own MediaElementSource (the binding is permanent and
      // can't be undone), so we build both up front here.
      const wireElement = (el) => {
        const source = ctx.createMediaElementSource(el);
        const xfadeGain = ctx.createGain();
        xfadeGain.gain.value = 1; // full unless a crossfade ramps it
        source.connect(xfadeGain);
        return { source, gain: xfadeGain };
      };
      const aNodes = wireElement(audioA);
      const bNodes = audioB ? wireElement(audioB) : null;

      const analyser = ctx.createAnalyser();
      // 1024 fftSize → 512 frequency bins; cheap and responsive enough for
      // visual feedback without spending real CPU.
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.78;

      // --- Volume boost stage ---------------------------------------
      // GainNode multiplies the signal. >1.0 amplifies (where the audio
      // element's own .volume cap of 1.0 can't reach). Initial value is
      // applied below from current state; subsequent changes flow in
      // through the gainBoost effect. This is now a SHARED stage that both
      // elements feed into, so boost applies to whichever one is playing.
      const gainNode = ctx.createGain();
      gainNode.gain.value = 1;

      // --- Two-stage dynamics safety net ----------------------------
      // With boost going as high as 16× (+24 dB), clipping is a serious
      // concern. We use a two-stage approach:
      //
      //   compressor: musical compression that does most of the work,
      //     gently riding the levels down so the perceived loudness
      //     keeps climbing but peaks don't blow out the DAC.
      //
      //   limiter: a near-brickwall final stage that catches anything
      //     the first compressor missed. Very high ratio, fast attack,
      //     threshold just below 0 dBFS — this is the "do not pass go"
      //     line that prevents speaker-killing clicks.
      //
      // At 1× boost both stages are essentially transparent (the signal
      // never reaches their thresholds). They only really start working
      // around 3× and become the dominant character at 8-16×.
      const compressor = ctx.createDynamicsCompressor();
      // Set for real from gainBoost in the effect below. -3 is the passthrough
      // value; the old -24 with a 20 dB knee meant this stage began working at
      // -34 dBFS, which every modern master exceeds — so the "transparent at
      // 1x" claim in the comment above was never true and everyone who never
      // touched boost was listening through 8:1 compression.
      compressor.threshold.value = -3;   // dB
      compressor.knee.value = 20;        // dB — still wide for transparency
      compressor.ratio.value = 8;        // 8:1 — firmer at high boost
      compressor.attack.value = 0.003;   // 3ms — fast enough to catch transients
      compressor.release.value = 0.2;    // 200ms — natural decay

      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -1;      // dB — brickwall just under digital max
      limiter.knee.value = 0;            // dB — hard knee (true brickwall)
      limiter.ratio.value = 20;          // ~∞:1 effectively
      limiter.attack.value = 0.001;      // 1ms — catches transients
      limiter.release.value = 0.05;      // 50ms — fast recovery

      // Graph:
      //   A.source → A.xfadeGain ┐
      //                          ├→ boost gain → compressor → limiter → analyser → destination
      //   B.source → B.xfadeGain ┘
      // (analyser before destination so visualizers see the boosted signal)
      aNodes.gain.connect(gainNode);
      if (bNodes) bNodes.gain.connect(gainNode);
      gainNode.connect(compressor);
      compressor.connect(limiter);
      limiter.connect(analyser);
      // CRITICAL: also connect to destination, otherwise the audio becomes
      // silent — createMediaElementSource removes the audio's default
      // connection to speakers.
      analyser.connect(ctx.destination);

      audioCtxRef.current = ctx;
      audioSourceRef.current = aNodes.source;
      audioSourceBRef.current = bNodes ? bNodes.source : null;
      gainARef.current = aNodes.gain;
      gainBRef.current = bNodes ? bNodes.gain : null;
      analyserRef.current = analyser;
      gainNodeRef.current = gainNode;
      compressorRef.current = compressor;
      limiterRef.current = limiter;
      return analyser;
    } catch (e) {
      // Some sources (cross-origin without CORS, certain DRM streams) refuse.
      // Don't crash visualizers — they'll just render their idle state.
      console.warn('Web Audio analyser unavailable:', e);
      return null;
    }
  }, []);

  /** Returns the crossfade GainNode belonging to the currently-active element. */
  const activeGainNode = useCallback(() => (
    audioRef.current === firstElementRef.current ? gainARef.current : gainBRef.current
  ), []);

  /**
   * Apply the current gainBoost value to the live audio graph. We do this
   * in an effect (rather than directly in setGainBoost) so the value
   * persists even if the analyser is built later — see the "make sure
   * analyser exists on first play" effect below, which calls ensureAnalyser
   * lazily.
   *
   * setTargetAtTime gives us a short smooth ramp instead of a click —
   * jumping from 1.0× to 2.5× in a single sample frame is audible as a
   * "thwack." 30ms is the magic number where the change feels instant but
   * doesn't pop.
   */
  useEffect(() => {
    const gainNode = gainNodeRef.current;
    const ctx = audioCtxRef.current;
    if (!gainNode || !ctx) return;
    try {
      gainNode.gain.setTargetAtTime(gainBoost, ctx.currentTime, 0.03);
    } catch {
      // Fallback: instant set (older Chromium versions, some Electron builds)
      gainNode.gain.value = gainBoost;
    }

    /* The compressor threshold follows the gain instead of sitting at a fixed
       point. A boost of G lifts a peak at P dBFS to P + 20log10(G), so the
       level that must not be exceeded sits exactly that far down. This is the
       relationship the comment beside the node already assumed; it just was
       not implemented, so the stage compressed everything at every setting.

       1x -> -3 dB (effectively passthrough), 4x -> -15, 16x -> -27. */
    const comp = compressorRef.current;
    if (comp) {
      const threshold = Math.max(-30, -3 - 20 * Math.log10(Math.max(1, gainBoost)));
      try { comp.threshold.setTargetAtTime(threshold, ctx.currentTime, 0.05); }
      catch { comp.threshold.value = threshold; }
    }
  }, [gainBoost]);

  /** Total gain reduction across both dynamics stages, in dB (<= 0).
   *  Summed rather than maxed: what a listener wants to know is how much is
   *  coming off in total, not which node took it. Read live off the audio
   *  thread, so the boost popover only polls this while it is open. */
  const helperReductionRef = useRef({ db: 0, at: 0 });
  const getGainReduction = useCallback(() => {
    const c = compressorRef.current?.reduction ?? 0;
    const l = limiterRef.current?.reduction ?? 0;
    // Spotify plays through the helper, not this graph; its limiter reports
    // with each levels event, which only arrive while it is playing.
    const sp = helperReductionRef.current;
    const h = Date.now() - sp.at < 250 ? sp.db : 0;
    return (Number.isFinite(c) ? c : 0) + (Number.isFinite(l) ? l : 0) + h;
  }, []);

  /* The same boost for Spotify, applied by the helper's own limiter. */
  useEffect(() => {
    window.electronAPI?.spotifyPlayerBoost?.(gainBoost)?.catch?.(() => {});
  }, [gainBoost]);
  useEffect(() => window.electronAPI?.onSpotifyPlayerEvent?.((ev) => {
    if (ev?.event === 'levels' && Number.isFinite(ev.gr)) helperReductionRef.current = { db: ev.gr, at: Date.now() };
  }), []);

  // Resume the audio context whenever playback begins — Chrome auto-suspends
  // it on inactivity, and after a tab backgrounds-then-foregrounds the
  // analyser stops producing data until resumed.
  //
  // We also build the analyser/gain graph here on first play if EITHER
  // beat-reactivity is on OR the user has a non-passthrough gainBoost set.
  // The graph is the only way to amplify above OS 100%, so it needs to
  // exist before the gainBoost effect can apply its value.
  useEffect(() => {
    if (!isPlaying) return;
    if (!analyserRef.current && (beatReactive || gainBoost > 1 || transitionMode !== 'off')) {
      ensureAnalyser();
      // ensureAnalyser created the gain node with value 1; sync to the
      // user's saved boost immediately so they don't hear a quiet first
      // second on session start.
      const gainNode = gainNodeRef.current;
      const ctx = audioCtxRef.current;
      if (gainNode && ctx) {
        try { gainNode.gain.setTargetAtTime(gainBoost, ctx.currentTime, 0.03); }
        catch { gainNode.gain.value = gainBoost; }
      }
    }
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => { /* ignore */ });
    }
  }, [isPlaying, beatReactive, gainBoost, transitionMode, ensureAnalyser]);

  /* The compact-bar visualizer asks for the analyser when a local file plays
     and nothing else has built it. Built mid-song, the context can start
     suspended and would silence the track, so resume it here, and carry the
     saved boost over just as the effect above does. */
  const needAnalyser = useCallback(() => {
    if (analyserRef.current) return;
    ensureAnalyser();
    const ctx = audioCtxRef.current;
    const gainNode = gainNodeRef.current;
    if (gainNode && ctx) {
      try { gainNode.gain.setTargetAtTime(gainBoost, ctx.currentTime, 0.03); } catch { gainNode.gain.value = gainBoost; }
    }
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => { /* ignore */ });
  }, [ensureAnalyser, gainBoost]);

  // Ambient idle-timer. The "idle" definition and delay both come from
  // user settings:
  //   - 'off'    → never engages
  //   - 'idle'   → no current track AND queue empty for 30s
  //   - 'pause'  → no track loaded OR loaded-but-paused for 30s
  //   - 'custom' → same idle test as 'idle' but with custom delay
  // Any state transition that breaks idleness cancels the pending timer.
  // The `ambientArmed` gate prevents auto-re-engagement after the user
  // manually dismisses: once dismissed, we wait until something happens
  // in the player (currentTrack appears) before allowing future engagement.
  useEffect(() => {
    // Off → never engage.
    if (ambientMode === 'off') return undefined;

    // Determine whether we count as idle under the active mode.
    const strictIdle = !currentTrack && queue.length === 0;
    const relaxedIdle = strictIdle || (!!currentTrack && !isPlaying);
    const isIdle = ambientMode === 'pause' ? relaxedIdle : strictIdle;

    // Re-arm whenever we leave idleness. If a track is now playing or
    // the queue has things lined up, the user is actively using the app.
    if (!isIdle) {
      setAmbientArmed(true);
      return undefined;
    }
    if (!ambientArmed) return undefined;
    if (ambientActive) return undefined;

    const delayMs = ambientMode === 'custom'
      ? Math.max(5, ambientCustomDelaySec) * 1000
      : 30_000;
    const t = setTimeout(() => setAmbientActive(true), delayMs);
    return () => clearTimeout(t);
  }, [
    currentTrack, queue.length, isPlaying,
    ambientMode, ambientCustomDelaySec,
    ambientArmed, ambientActive,
  ]);

  // Public-facing handler the AmbientMode overlay calls when the user
  // closes it. Disarms re-engagement until the player wakes up again.
  const dismissAmbient = useCallback(() => {
    setAmbientActive(false);
    setAmbientArmed(false);
  }, []);

  /* =====================================================================
   *  Transition engine: preload-next + gapless/crossfade handoff.
   *
   *  The active element drives `timeupdate`; on each tick maybeStartHandoff
   *  (a) stages the upcoming track in the standby element ahead of time and
   *  (b) once we're within the trigger window, promotes the standby element
   *  to active. For gapless the trigger is ~0.18s before the end and the
   *  outgoing element is simply stopped; for crossfade the trigger is the
   *  full crossfade length and the two elements' gains ramp past each other.
   * ===================================================================== */

  // Same key the load effect uses, so a staged element won't be reloaded.
  const trackLoadKey = useCallback((t) => (
    t ? `${t.id}|${String(t.filePath || t.objectUrl || '')}` : null
  ), []);

  // Resolve a playback src for a track (mirrors the load effect's logic).
  const srcForTrack = useCallback((t) => {
    if (!t) return null;
    // Streamed tracks have no file for a standby <audio> to buffer.
    if (spotifyIdOf(t)) return null;
    if (window.electronAPI?.getPlaybackUrl && t.filePath) {
      return window.electronAPI.getPlaybackUrl(t.filePath);
    }
    return t.objectUrl || null;
  }, []);

  // What plays after the current track, honoring repeat. Reads queue/index
  // live so shuffle and reorders are always reflected.
  const peekNext = useCallback(() => {
    const q = queueRef.current;
    if (!q || q.length === 0) return null;
    if (repeat === 'one') return { track: q[currentIndex], index: currentIndex };
    let n = currentIndex + 1;
    if (n >= q.length) {
      if (repeat === 'all') n = 0;
      else return null;
    }
    return { track: q[n], index: n };
  }, [currentIndex, repeat]);

  // Stage the next track into the STANDBY element (buffers, does not play).
  const preloadNext = useCallback(() => {
    const standby = inactiveAudioRef.current;
    if (!standby) return;
    const nxt = peekNext();
    if (!nxt || !nxt.track) return;
    const key = trackLoadKey(nxt.track);
    if (preloadedKeyRef.current === key) return; // already staged
    const src = srcForTrack(nxt.track);
    if (!src) return;
    standby.src = src;
    try { standby.currentTime = 0; } catch { /* ignore */ }
    try { standby.load(); } catch { /* ignore */ }
    preloadedKeyRef.current = key;
  }, [peekNext, trackLoadKey, srcForTrack]);

  // Reset both crossfade gains to unity and clear any scheduled ramps.
  const resetCrossfadeGains = useCallback(() => {
    const ctx = audioCtxRef.current;
    for (const g of [gainARef.current, gainBRef.current]) {
      if (!g) continue;
      try { g.gain.cancelScheduledValues(ctx ? ctx.currentTime : 0); } catch { /* ignore */ }
      g.gain.value = 1;
    }
  }, []);

  // Promote the standby element to active and run the chosen transition.
  const performHandoff = useCallback((mode) => {
    const outgoing = audioRef.current;
    const incoming = inactiveAudioRef.current;
    if (!incoming || !incoming.src) { handleNextRef.current(); return; }
    const nxt = peekNext();
    if (!nxt) return;

    const ctx = audioCtxRef.current;
    const outGain = activeGainNode();
    const inGain = (outGain === gainARef.current) ? gainBRef.current : gainARef.current;

    handoffArmedRef.current = true;

    incoming.volume = outgoing.volume; // keep perceptual volume consistent

    // Push the incoming track's progress into the UI. Called at the moment
    // the incoming element actually becomes the audible one, so the progress
    // bar flips in sync with what you hear (not early while the outgoing
    // track's tail is still playing).
    const syncProgressUI = () => {
      seekGenerationRef.current += 1;
      setCurrentTime(0);
      const seed = (typeof nxt.track.duration === 'number'
        && nxt.track.duration > 0 && Number.isFinite(nxt.track.duration))
        ? nxt.track.duration
        : (Number.isFinite(incoming.duration) && incoming.duration > 0 ? incoming.duration : 0);
      setDuration(seed);
    };

    if (mode === 'crossfade' && ctx && outGain && inGain) {
      // Start the incoming element now; the two overlap for `dur` seconds.
      const p = incoming.play(); if (p) p.catch(() => {});
      syncProgressUI(); // incoming is audible immediately in a crossfade
      const dur = Math.max(1, crossfadeSecRef.current);
      const now = ctx.currentTime;
      // Linear ramps past each other. (Linear is gentle enough for music and
      // avoids the dip a naive equal-power curve can introduce at the seam.)
      try {
        outGain.gain.cancelScheduledValues(now);
        inGain.gain.cancelScheduledValues(now);
        outGain.gain.setValueAtTime(outGain.gain.value, now);
        inGain.gain.setValueAtTime(0.0001, now);
        outGain.gain.linearRampToValueAtTime(0.0001, now + dur);
        inGain.gain.linearRampToValueAtTime(1.0, now + dur);
      } catch { /* ignore */ }
      // After the fade, stop + rewind the outgoing element and restore its
      // gain so it's clean for its next turn as the standby element.
      setTimeout(() => {
        try { outgoing.pause(); outgoing.currentTime = 0; } catch { /* ignore */ }
        if (outGain) outGain.gain.value = 1;
      }, dur * 1000 + 150);
    } else {
      // Gapless: we were triggered slightly early (so a sparse timeupdate
      // tick couldn't skip the window). Don't start the incoming element
      // immediately — that would clip the tail of the outgoing track or
      // overlap it. Instead schedule the incoming start for the exact moment
      // the outgoing track ends, and stop the outgoing element then too.
      if (outGain) outGain.gain.value = 1;
      if (inGain) inGain.gain.value = 1;
      const outDur = outgoing.duration;
      const remainingMs = (Number.isFinite(outDur) && outDur > 0)
        ? Math.max(0, (outDur - outgoing.currentTime) * 1000)
        : 0;
      const startIncoming = () => {
        const p = incoming.play(); if (p) p.catch(() => {});
        try { outgoing.pause(); outgoing.currentTime = 0; } catch { /* ignore */ }
        syncProgressUI(); // flip the progress bar in sync with the audio
      };
      if (remainingMs <= 30) startIncoming();
      else setTimeout(startIncoming, remainingMs);
    }

    // Swap refs so audioRef.current === the now-playing element.
    audioRef.current = incoming;
    inactiveAudioRef.current = outgoing;
    preloadedKeyRef.current = null;

    // Advance the index WITHOUT letting the load effect re-set src on the
    // already-playing element: pre-seed its load-key guard.
    lastAudioLoadKeyRef.current = trackLoadKey(nxt.track);

    setCurrentIndex(nxt.index);
  }, [peekNext, activeGainNode, trackLoadKey]);

  // Driven by the active element's timeupdate. Decides when to preload and
  // when to fire the handoff.
  const maybeStartHandoff = useCallback((el) => {
    if (el.isSpotify) {
      /* The helper plays one track at a time, so there's no handoff. Tell it
         what's next ~10s early (librespot buffers it for a near-gapless
         start) and let the natural 'ended' advance the queue. */
      const dur = el.duration;
      if (!Number.isFinite(dur) || dur - el.currentTime > 10 || repeat === 'one') return;
      preloadStreamed(peekNext()?.track);
      return;
    }
    const mode = transitionModeRef.current;
    if (mode === 'off') return;
    if (repeat === 'one') return;            // loops via the seek path instead
    /* Next up is streamed: the standby element can't hold it (and may still
       hold a stale file), so no gapless/crossfade — 'ended' advances. */
    const upcoming = peekNext()?.track;
    if (spotifyIdOf(upcoming)) {
      const d = el.duration;
      if (Number.isFinite(d) && d - el.currentTime <= 10) preloadStreamed(upcoming);
      return;
    }
    const dur = el.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const remaining = dur - el.currentTime;

    // Stage the next track well before we need it.
    const preloadLead = mode === 'crossfade' ? (crossfadeSecRef.current + 4) : 8;
    if (remaining <= preloadLead) preloadNext();

    if (handoffArmedRef.current) return;     // handoff already in progress

    // timeupdate only fires ~4×/sec, so `remaining` arrives in ~0.25s steps.
    // A fixed tiny window (e.g. <=0.18s) is frequently skipped over entirely
    // — one tick reads 0.30s left, the next reads -0.05 (already ended) — so
    // the handoff never fires and playback just stops. Instead we trigger as
    // soon as we're within one tick-interval of the target boundary. For
    // gapless the boundary is the very end; we use a 0.6s lead (≈2 ticks of
    // headroom) which is small enough to stay seamless on a preloaded element
    // but large enough that a tick always lands inside it.
    const GAPLESS_LEAD = 0.6;
    const trigger = mode === 'crossfade' ? crossfadeSecRef.current : GAPLESS_LEAD;
    if (remaining <= trigger) {
      const standby = inactiveAudioRef.current;
      // HAVE_CURRENT_DATA(2) is enough to start without a stall.
      const ready = standby && standby.src && standby.readyState >= 2;
      if (ready) performHandoff(mode);
      else preloadNext();                    // not ready; natural 'ended' covers it
    }
  }, [repeat, preloadNext, performHandoff, peekNext]);

  // Keep a ref to maybeStartHandoff so the (mount-once) listener effect can
  // call the latest version without re-binding listeners.
  const maybeStartHandoffRef = useRef(null);
  maybeStartHandoffRef.current = maybeStartHandoff;

  const handleNext = useCallback(() => {
    // Manual navigation cancels any in-flight transition and resets gains so
    // they don't get stuck mid-ramp; the load effect then hard-cuts normally.
    handoffArmedRef.current = false;
    preloadedKeyRef.current = null;
    resetCrossfadeGains();

    if (queue.length === 0) return;
    if (repeat === 'one') {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(() => {});
      return;
    }
    let next = currentIndex + 1;
    if (next >= queue.length) {
      if (repeat === 'all') next = 0;
      else {
        const el = audioRef.current;
        if (el) { try { el.pause(); el.currentTime = 0; } catch { /* ignore */ } }
        const inEl = inactiveAudioRef.current;
        if (inEl) { try { inEl.pause(); } catch { /* ignore */ } }
        setIsPlaying(false);
        return;
      }
    }

    setCurrentIndex(next);
  }, [currentIndex, queue, repeat, resetCrossfadeGains]);

  handleNextRef.current = handleNext;

  /* Spotify playback problems (helper not built, sign-in needed, a track
     that isn't available) arrive as 'error' on the stand-in element. Say
     why, and skip a single track Spotify won't play instead of stalling.
     Never skip on a throttle (the stand-in retries the same track), and
     stop after a few failed skips in a row: running down the queue asks
     Spotify for a key per track, which is what keeps a refusal going. */
  useEffect(() => {
    const sp = spotifyElRef.current;
    if (!sp) return undefined;
    const MAX_AUTO_SKIPS = 3;
    let skips = 0;
    let lastMsg = '';
    let lastAt = 0;
    const onError = (e) => {
      const msg = e?.message || 'Spotify playback failed.';
      const now = Date.now();
      if (msg !== lastMsg || now - lastAt > 5000) {
        pushToast({ message: msg, detail: e?.detail || '', source: 'Playback', kind: e?.transient ? 'warning' : 'error' });
      }
      lastMsg = msg;
      lastAt = now;
      if (e?.code !== 'unavailable' || audioRef.current !== sp) return;
      skips += 1;
      if (skips > MAX_AUTO_SKIPS) {
        pushToast({
          message: 'Playback stopped after several failed songs', kind: 'error', source: 'Playback',
          detail: 'Several Spotify songs in a row wouldn’t play. Skipping further would only ask Spotify for more songs and keep the refusal going, so Studio stopped. Press play to try again in a minute.',
        });
        skips = 0;
        return;
      }
      handleNextRef.current?.();
    };
    const onPlaying = () => { skips = 0; };
    sp.addEventListener('error', onError);
    sp.addEventListener('playing', onPlaying);
    return () => {
      sp.removeEventListener('error', onError);
      sp.removeEventListener('playing', onPlaying);
    };
  }, [pushToast]);

  useEffect(() => {
    const els = [audioRef.current, inactiveAudioRef.current, spotifyElRef.current].filter(Boolean);
    if (els.length === 0) return undefined;

    // Only the element that is currently active drives UI state. After a
    // handoff `audioRef.current` points at the other element, so isActive
    // flips and the formerly-active element's events become inert.
    const isActive = (el) => el === audioRef.current;

    const bind = (el) => {
      const onTime = () => {
        if (!isActive(el)) return;
        setCurrentTime(el.currentTime);
        maybeStartHandoffRef.current?.(el);
      };
      /* Brief, defect: elapsed read 0:00 on a paused, loaded track. Paused
         media fires no timeupdate, so a seek, a pause or a metadata load left
         the UI on whatever it last heard (often the 0 from load). Read the
         element's real position on every one of those events. */
      const syncTime = () => { if (isActive(el) && Number.isFinite(el.currentTime)) setCurrentTime(el.currentTime); };
      const onSeeked = () => { if (isActive(el)) { syncTime(); setSeekNonce((n) => n + 1); } };
      const syncDuration = () => {
        if (!isActive(el)) return;
        const d = el.duration;
        if (Number.isFinite(d) && d > 0) setDuration(d);
      };
      const onDur = () => syncDuration();
      const onLoadedMeta = () => { syncDuration(); syncTime(); };
      const onEnded = () => {
        if (!isActive(el)) {
          // The outgoing element of a gapless/crossfade handoff ended after
          // we already swapped to the incoming one. Clear the arm flag so the
          // NEXT track's natural end isn't mistakenly swallowed.
          handoffArmedRef.current = false;
          return;
        }
        // Active element ended with no handoff in flight → normal advance.
        if (handoffArmedRef.current) { handoffArmedRef.current = false; return; }
        handleNextRef.current();
      };
      const onPlay = () => {
        if (!isActive(el)) return;
        // Whichever element is now active and playing means any in-flight
        // handoff has completed; disarm so the natural-end path works again.
        handoffArmedRef.current = false;
        setIsPlaying(true);
      };
      const onPause = () => { if (isActive(el)) { setIsPlaying(false); syncTime(); } };

      el.addEventListener('timeupdate', onTime);
      el.addEventListener('seeked', onSeeked);
      el.addEventListener('durationchange', onDur);
      el.addEventListener('loadedmetadata', onLoadedMeta);
      el.addEventListener('ended', onEnded);
      el.addEventListener('play', onPlay);
      el.addEventListener('pause', onPause);
      return () => {
        el.removeEventListener('timeupdate', onTime);
        el.removeEventListener('seeked', onSeeked);
        el.removeEventListener('durationchange', onDur);
        el.removeEventListener('loadedmetadata', onLoadedMeta);
        el.removeEventListener('ended', onEnded);
        el.removeEventListener('play', onPlay);
        el.removeEventListener('pause', onPause);
      };
    };

    const cleanups = els.map(bind);
    return () => cleanups.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    if (!currentTrack || !audioRef.current) {
      if (!currentTrack) lastAudioLoadKeyRef.current = null;
      return;
    }
    const pathKey = String(currentTrack.filePath || currentTrack.objectUrl || '');
    // Intentionally omit `currentIndex` from the key — the same track can move
    // to a different queue position (e.g. when toggling shuffle) and we must
    // not reload audio.src in that case or playback restarts from 0.
    const loadKey = `${currentTrack.id}|${pathKey}`;
    if (lastAudioLoadKeyRef.current === loadKey) return;
    lastAudioLoadKeyRef.current = loadKey;

    seekGenerationRef.current += 1;
    setCurrentTime(0);
    const seed =
      typeof currentTrack.duration === 'number'
      && currentTrack.duration > 0
      && Number.isFinite(currentTrack.duration)
        ? currentTrack.duration
        : 0;
    setDuration(seed);

    /* Saved Spotify track → the helper. Point audioRef at the stand-in
       BEFORE pausing the real elements, so their 'pause' events land on an
       inactive element and don't flip the play button off. */
    const sp = spotifyElRef.current;
    const sid = spotifyIdOf(currentTrack);
    if (sid && sp) {
      if (audioRef.current !== sp) {
        localAudioRef.current = audioRef.current;
        audioRef.current = sp;
      }
      for (const el of [localAudioRef.current, inactiveAudioRef.current]) {
        if (el) { try { el.pause(); } catch { /* ignore */ } }
      }
      handoffArmedRef.current = false;
      resetCrossfadeGains();
      sp.volume = perceptualVolume(volume);
      sp.loadTrack(sid, seed);
      sp.play();
      return;
    }
    // Back to a local file: stop the helper and hand the bar back.
    if (sp && audioRef.current === sp) {
      sp.unload();
      audioRef.current = localAudioRef.current || firstElementRef.current;
    }
    const audio = audioRef.current;
    async function load() {
      if (window.electronAPI?.getPlaybackUrl) {
        audio.src = window.electronAPI.getPlaybackUrl(currentTrack.filePath);
        audio.play().catch(() => {});
      } else if (currentTrack.objectUrl) {
        audio.src = currentTrack.objectUrl;
        audio.play().catch(() => {});
      }
    }
    load();
    // Intentionally omit `currentTrack.duration`: metadata hydration updates it and must not reload `src` (that restarts playback).
  }, [currentIndex, currentTrack?.id, currentTrack?.filePath, currentTrack?.objectUrl]);

  useEffect(() => {
    const pv = perceptualVolume(volume);
    if (audioRef.current) audioRef.current.volume = pv;
    if (inactiveAudioRef.current) inactiveAudioRef.current.volume = pv;
  }, [volume]);

  const togglePlay = () => {
    if (!currentTrack) {
      if (library.length > 0) {
        const sorted = sortByTitle(library);
        const q = shuffleOn ? shuffleArray(sorted) : sorted;
        setQueue(q);
        setCurrentIndex(0);
      }
      return;
    }
    if (isPlaying) audioRef.current.pause();
    else audioRef.current.play().catch(() => {});
  };

  const handlePrev = () => {
    if (queue.length === 0) return;
    if (audioRef.current.currentTime > 3) { audioRef.current.currentTime = 0; return; }
    // Manual navigation cancels any in-flight transition and resets gains.
    handoffArmedRef.current = false;
    preloadedKeyRef.current = null;
    resetCrossfadeGains();
    let prev = currentIndex - 1;
    if (prev < 0) prev = repeat === 'all' ? queue.length - 1 : 0;
    setCurrentIndex(prev);
  };

  const toggleShuffle = () => {
    setShuffleOn((prev) => {
      if (!prev && queue.length > 0) {
        const cur = queue[currentIndex];
        const rest = queue.filter((_, i) => i !== currentIndex);
        setQueue([cur, ...shuffleArray(rest)]);
        setCurrentIndex(0);
      }
      return !prev;
    });
  };

  const seekTo = useCallback((seconds) => {
    const audio = audioRef.current;
    if (!audio) return;
    const t = Number(seconds);
    if (!Number.isFinite(t)) return;

    const maxFromElement = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const maxFromState = Number.isFinite(duration) && duration > 0 ? duration : 0;
    const maxSeek = maxFromElement > 0 ? maxFromElement : maxFromState;

    const apply = (max) => {
      if (!(max > 0)) return false;
      audio.currentTime = Math.max(0, Math.min(max, t));
      return true;
    };

    if (apply(maxSeek)) return;

    const gen = seekGenerationRef.current;
    const onMeta = () => {
      if (gen !== seekGenerationRef.current) return;
      const d = audio.duration;
      if (Number.isFinite(d) && d > 0) {
        audio.currentTime = Math.max(0, Math.min(d, t));
      }
    };
    audio.addEventListener('loadedmetadata', onMeta, { once: true });
  }, [duration]);

  /**
   * The one place paths become library rows.
   *
   * File picker, folder picker and drag-and-drop all funnel through here so
   * metadata reading, the DB write and the cover-art merge can't drift apart
   * between the three entry points.
   */
  const ingestPaths = useCallback(async (paths) => {
    if (!paths?.length) return 0;
    const tracks = [];
    for (const fp of paths) {
      try {
        const meta = await window.electronAPI.getMetadata(fp);
        tracks.push({ id: uid(), ...meta });
      } catch (e) {
        // One unreadable file shouldn't abort a 400-track folder import.
        console.error('[import] skipped', fp, e);
      }
    }
    if (!tracks.length) return 0;
    await window.electronAPI.addLibraryTracks(tracks);
    const fromDb = await window.electronAPI.loadLibrary();
    setLibrary(mergeCoverArt(fromDb, tracks));
    /* The import just repaired orphaned play events in SQLite (reattachPlay-
       History repoints them at the new track ids and rebuilds play_count).
       The renderer's copy of the log still holds the OLD ids, so without this
       a re-downloaded song shows no history until the app is restarted. */
    setPlayEventsNonce((n) => n + 1);
    return tracks.length;
  }, []);

  const importFiles = async () => {
    setImporting(true);
    try {
      if (window.electronAPI) {
        await ingestPaths(await window.electronAPI.openFiles());
      } else {
        const input = document.createElement('input');
        input.type = 'file'; input.multiple = true; input.accept = 'audio/*';
        const files = await new Promise((res) => { input.onchange = () => res(Array.from(input.files)); input.click(); });
        const tracks = files.map((f) => ({
          id: uid(),
          title: f.name.replace(/\.[^.]+$/, ''),
          artist: 'Unknown Artist',
          album: 'Unknown Album',
          duration: 0,
          coverArt: null,
          filePath: f.name,
          objectUrl: URL.createObjectURL(f),
        }));
        setLibrary((prev) => [...prev, ...tracks]);
      }
    } catch (e) { console.error(e); }
    setImporting(false);
  };

  const importFolder = async () => {
    if (!window.electronAPI) return;
    setImporting(true);
    try {
      await ingestPaths(await window.electronAPI.openFolder());
    } catch (e) { console.error(e); }
    setImporting(false);
  };

  /**
   * Drag-and-drop. The dropped paths can be files, folders, or a mix, and the
   * renderer can't tell which — main stats each one and expands directories.
   */
  const importDroppedPaths = useCallback(async (paths) => {
    if (!window.electronAPI?.resolveDroppedPaths || !paths?.length) return;
    setImporting(true);
    try {
      const audio = await window.electronAPI.resolveDroppedPaths(paths);
      if (!audio.length) {
        console.warn('[import] nothing playable in the drop');
        return;
      }
      await ingestPaths(audio);
    } catch (e) { console.error(e); }
    finally { setImporting(false); }
  }, [ingestPaths]);

  // NB: `inElectron` isn't declared until just above the render, so the check
  // is repeated here rather than moved — dropping files is meaningless in a
  // browser tab anyway, since there are no filesystem paths to resolve.
  const draggingFiles = useFileDrop({
    onPaths: importDroppedPaths,
    enabled: typeof window !== 'undefined' && !!window.electronAPI,
  });

  /**
   * Build the play queue for a clicked track.
   *
   *   context 'single'  — the track was a one-off (e.g. a free-text song search
   *                       that didn't resolve to a coherent artist/album). Play
   *                       it, then continue with a random shuffle of the rest of
   *                       the library.
   *   context 'list'    — the track belongs to a group the user is looking at
   *                       (an artist, an album, a coherent search, or the whole
   *                       library). Queue that whole list.
   *
   * Either way, when shuffle is ON the clicked track goes FIRST and the rest is
   * shuffled after it (matching the shuffle-toggle behavior) — so playing a new
   * track always starts a fresh queue from that track instead of dropping you
   * into the middle of the old shuffled order.
   */
  const playTrack = (track, sortedList, context = 'list') => {
    if (context === 'single') {
      const rest = shuffleArray(library.filter((t) => t.id !== track.id));
      setQueue([track, ...rest]);
      setCurrentIndex(0);
    } else {
      const source = sortedList && sortedList.length > 0 ? sortedList : sortByTitle(library);
      if (shuffleOn) {
        const rest = shuffleArray(source.filter((t) => t.id !== track.id));
        setQueue([track, ...rest]);
        setCurrentIndex(0);
      } else {
        const q = [...source];
        const idx = q.findIndex((t) => t.id === track.id);
        setQueue(q);
        setCurrentIndex(idx >= 0 ? idx : 0);
      }
    }
    if (!hasEverPlayed) setHasEverPlayed(true);
  };


  /**
   * Queue mutations — keep the current index pointed at the same track across
   * every operation. When tracks are inserted BEFORE the current index, shift
   * the index forward; when removed, shift back (or stay put if removal is
   * after).
   */

  /** Append one or more tracks to the end of the queue. */
  const addToQueue = useCallback((tracks) => {
    const rows = Array.isArray(tracks) ? tracks : [tracks];
    if (!rows.length) return;
    setQueue((prev) => {
      // If there's nothing playing yet, treat the first add as "play this now"
      if (prev.length === 0 || currentIndex < 0) {
        setCurrentIndex(0);
        if (!hasEverPlayed) setHasEverPlayed(true);
      }
      return [...prev, ...rows];
    });
  }, [currentIndex, hasEverPlayed]);

  /** Insert tracks right after the currently-playing track (Play Next). */
  const playNext = useCallback((tracks) => {
    const rows = Array.isArray(tracks) ? tracks : [tracks];
    if (!rows.length) return;
    setQueue((prev) => {
      if (prev.length === 0 || currentIndex < 0) {
        setCurrentIndex(0);
        if (!hasEverPlayed) setHasEverPlayed(true);
        return [...rows];
      }
      const before = prev.slice(0, currentIndex + 1);
      const after = prev.slice(currentIndex + 1);
      return [...before, ...rows, ...after];
    });
  }, [currentIndex, hasEverPlayed]);


  /** Move the track at `from` to position `to` in the queue. */
  const reorderQueue = useCallback((from, to) => {
    setQueue((prev) => {
      if (from === to) return prev;
      if (from < 0 || from >= prev.length) return prev;
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      // Adjust current index — the playing track might have moved. Track it
      // by id since the array positions all shifted.
      const playingId = prev[currentIndex]?.id;
      if (playingId) {
        const newIdx = next.findIndex((t) => t.id === playingId);
        if (newIdx >= 0 && newIdx !== currentIndex) setCurrentIndex(newIdx);
      }
      return next;
    });
  }, [currentIndex]);




  const handleSpotifyImportDone = async (track) => {
    if (!window.electronAPI?.loadLibrary) return;
    const fromDb = await window.electronAPI.loadLibrary();
    setLibrary(mergeCoverArt(fromDb, [track]));
    // Downloads land here rather than through ingestPaths, and this is the
    // path a re-downloaded song takes — so it needs the same play-log refresh,
    // or its restored history stays invisible until the next restart.
    setPlayEventsNonce((n) => n + 1);
  };

  /**
   * Re-load the library from the DB and update state. Used by features
   * that mutate the DB outside the normal add/remove paths — most
   * importantly the metadata re-scan, which can update many tracks at
   * once and needs the renderer to see the fresh values.
   */
  const reloadLibrary = useCallback(async () => {
    if (!window.electronAPI?.loadLibrary) return;
    try {
      const fromDb = await window.electronAPI.loadLibrary();
      if (Array.isArray(fromDb)) setLibrary(fromDb);
      // A re-scan can rewrite artist/title, which changes which events match
      // which track — re-read rather than trusting the in-memory log.
      setPlayEventsNonce((n) => n + 1);
    } catch { /* ignore */ }
  }, []);

  /* Missing details for Saved tracks are filled in by main in the background;
     it says so here, and the library re-reads from the DB. */
  useEffect(() => window.electronAPI?.onLibraryChanged?.(() => { reloadLibrary(); }), [reloadLibrary]);

  /* ---------- Discord rich presence ---------------------------------- */

  /**
   * Connect/disconnect Discord presence in the main process whenever
   * the toggle or app ID changes. Connection is fire-and-forget — the
   * main process handles retries if Discord isn't running yet.
   */
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.discordConnect) return undefined;
    if (discordPresenceEnabled && effectiveDiscordAppId) {
      api.discordConnect(effectiveDiscordAppId).catch(() => { /* ignore */ });
    } else if (api.discordDisconnect) {
      api.discordDisconnect().catch(() => { /* ignore */ });
    }
    return undefined;
  }, [discordPresenceEnabled, effectiveDiscordAppId]);

  /**
   * Push the current playback state to Discord whenever the playing
   * track or play/pause state changes. Uses the track's title +
   * artist + album for the activity strings, the wall-clock start
   * timestamp for elapsed-time progress (Discord computes the bar
   * itself given a start ms), and the total duration so the bar
   * shows total length. We DON'T push currentTime updates — that
   * would spam Discord's IPC with no visual benefit (Discord
   * extrapolates from the start timestamp).
   *
   * The "wall start time" is `Date.now() - currentTime*1000` recomputed
   * from a ref each time playback state changes, so a seek or pause-
   * resume cycle correctly re-anchors the timeline.
   */
  const discordWallStartRef = useRef(Date.now());
  const discordLastTrackIdRef = useRef(null);
  // Cache of iTunes artwork-lookup results keyed by `artist|album` (lower-
  // cased). Lets every track on the same album share one lookup and
  // avoids re-hitting the network on replay. `''` means "looked up and
  // got nothing"; absence means "haven't tried yet".
  const discordArtworkCacheRef = useRef(new Map());
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.discordSetActivity) return;
    if (!discordPresenceEnabled || !effectiveDiscordAppId) return;
    const track = queue[currentIndex];
    if (!track) {
      discordLastTrackIdRef.current = null;
      api.discordSetActivity(null).catch(() => { /* ignore */ });
      return;
    }
    // Re-anchor the wall start time. `currentTime` from the React state
    // is stale here (it's not in deps — including it would spam Discord
    // every audio frame), so read live from the audio element. On a
    // track change the audio element's currentTime still reads the OLD
    // song's position for one tick before `loadedmetadata`/`play` reset
    // it, so we treat a track-id change as "start from 0" explicitly.
    // For play/pause toggles on the same track, the live audio
    // currentTime is the correct anchor — pausing at 30s then resuming
    // anchors the wall start to (now - 30s), so Discord shows the right
    // elapsed time without rewinding.
    const trackId = track.id;
    const trackChanged = discordLastTrackIdRef.current !== trackId;
    discordLastTrackIdRef.current = trackId;
    if (!isPlaying && discordHideWhenPaused) {
      api.discordSetActivity(null).catch(() => { /* ignore */ });
      return;
    }
    const liveCurrentTime = trackChanged
      ? 0
      : (audioRef.current?.currentTime ?? currentTime);
    discordWallStartRef.current = Date.now() - (liveCurrentTime * 1000);
    // Discord only fetches public http(s) URLs for cover art — embedded
    // ID3 art (data: URLs) and our studio-cover:// custom protocol won't
    // resolve from Discord's servers. We try every field on the track
    // that might hold a public URL and pick the first one that qualifies.
    const isPublicHttpUrl = (s) => typeof s === 'string' && /^https?:\/\/[^\s]+$/i.test(s);
    const localCoverUrl = [
      track.coverArtUrl,
      track.coverArtRemote,
      track.albumArtUrl,
      track.spotifyAlbumImage,
      // track.coverArt is usually a data: URL from embedded ID3 — but on
      // Spotify-imported tracks it may also be a CDN URL, so try it last.
      track.coverArt,
    ].find(isPublicHttpUrl) || '';

    // imgbb upload path — for local tracks whose only art is a
    // studio-cover:// file, we upload it to imgbb once (cached on disk
    // by image hash) and use the resulting public URL. The upload key is
    // prefixed so it doesn't collide with the iTunes cache entries.
    //
    // Check coverArtLocal first: mergeCoverArt preserves the original
    // studio-cover:// URL there when it overwrites coverArt with a
    // freshly-parsed data: URI, so we don't lose the path mid-session.
    const studioUrl = !localCoverUrl
      ? [track.coverArtLocal, track.coverArt]
          .find((s) => typeof s === 'string' && s.startsWith('studio-cover://')) || null
      : null;
    const imgurKey = studioUrl ? `imgur:${studioUrl}` : null;
    const cachedImgur = imgurKey && discordArtworkCacheRef.current.has(imgurKey)
      ? (discordArtworkCacheRef.current.get(imgurKey) || '') : '';

    // Some tracks have no public URL anywhere (Spotify search row
    // didn't carry one, or the track was imported back when that field
    // wasn't being persisted). For those, check the iTunes cache — if
    // we've already looked up this song, use the cached URL
    // immediately; otherwise queue an async lookup and re-push when it
    // returns. Key by artist+album+title (not just album) because the
    // main-process lookup matches on all three; an album-wide cache key
    // would falsely share a URL between tracks where only one matched.
    const cacheKey = `${(track.artist || '').trim()}|${(track.album || '').trim()}|${(track.title || '').trim()}`.toLowerCase();
    const cachedRemote = discordArtworkCacheRef.current.get(cacheKey);
    const coverArtUrl = localCoverUrl || cachedImgur || cachedRemote || '';
    const payload = {
      title: track.title || 'Unknown track',
      artist: track.artist || '',
      album: track.album || '',
      showAlbum: discordPresenceDetail === 'full',
      coverArtUrl,
      isPlaying,
      duration: track.duration || 0,
      startedAtMs: discordWallStartRef.current,
    };
    api.discordSetActivity(payload).catch(() => { /* ignore */ });

    const effectiveImgbbApiKey = (imgbbApiKey || '').trim();

    // Path A — imgbb upload for local studio-cover:// art.
    // When the track has no public URL but has local embedded art,
    // upload it once to imgbb and re-push when the URL comes back.
    // The main process caches the result on disk by image hash so the
    // same art is never uploaded twice across restarts.
    if (
      !localCoverUrl && !cachedImgur
      && imgurKey && effectiveImgbbApiKey
      && api.discordResolveCoverUrl
      && !discordArtworkCacheRef.current.has(imgurKey)
    ) {
      discordArtworkCacheRef.current.set(imgurKey, null); // mark in-flight
      api.discordResolveCoverUrl({ studioUrl, clientId: effectiveImgbbApiKey })
        .then((res) => {
          const url = res?.url || '';
          discordArtworkCacheRef.current.set(imgurKey, url);
          if (!url) return;
          if (discordLastTrackIdRef.current !== trackId) return; // user moved on
          api.discordSetActivity({
            ...payload,
            coverArtUrl: url,
            isPlaying,
            startedAtMs: discordWallStartRef.current,
          }).catch(() => { /* ignore */ });
        })
        .catch(() => {
          // Network error — remove so next play can retry
          discordArtworkCacheRef.current.delete(imgurKey);
        });
    }

    // Path B — iTunes metadata lookup, fallback when no Imgur Client-ID
    // is configured or when the track has no studio-cover:// art at all.
    // If we sent no URL and don't have a cached lookup yet, kick off an
    // iTunes lookup. When it returns, if the user is still on this same
    // track, re-push the activity with the resolved URL. We guard on
    // trackId so that an old lookup for a previous track doesn't
    // overwrite presence for whatever the user has skipped to.
    if (
      !localCoverUrl && !cachedImgur
      && !(imgurKey && effectiveImgbbApiKey) // skip when imgbb path is active
      && !discordArtworkCacheRef.current.has(cacheKey)
      && api.discordLookupArtwork
      && (track.artist || track.album || track.title)
    ) {
      // Mark as "in flight" with `null` so we don't fire duplicate
      // lookups for the same album while the first request is pending.
      discordArtworkCacheRef.current.set(cacheKey, null);
      api.discordLookupArtwork({
        title: track.title || '',
        artist: track.artist || '',
        album: track.album || '',
      }).then((res) => {
        const url = res?.url || '';
        discordArtworkCacheRef.current.set(cacheKey, url || '');
        if (!url) return;
        if (discordLastTrackIdRef.current !== trackId) return; // user moved on
        const isStillPlaying = isPlaying;
        api.discordSetActivity({
          ...payload,
          coverArtUrl: url,
          isPlaying: isStillPlaying,
          // The wall-start was anchored above; reuse it so the elapsed-
          // time bar doesn't jump when the second activity arrives.
          startedAtMs: discordWallStartRef.current,
        }).catch(() => { /* ignore */ });
      }).catch(() => {
        // Mark as known-miss so we don't retry on replay.
        discordArtworkCacheRef.current.set(cacheKey, '');
      });
    }
    // Note: we deliberately depend on currentTrack identity + isPlaying
    // + seekNonce only, NOT currentTime. currentTime ticks every audio
    // frame and would spam Discord. Track changes and play/pause both
    // re-anchor on their own; seekNonce covers user seeks within a song.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue[currentIndex]?.id, isPlaying, seekNonce, discordPresenceEnabled, effectiveDiscordAppId, discordPresenceDetail, discordHideWhenPaused]);

  /**
   * Clear the entire library. `deleteFiles=true` also trashes audio files the
   * app downloaded (yt-dlp). User-imported files on disk are never touched.
   *
   * Returns the IPC result so the caller can surface a confirmation message
   * ("Deleted 42 files, kept 6 user-imported files").
   */
  const clearLibrary = useCallback(async ({ deleteFiles = false, clearStats = true } = {}) => {
    const api = window.electronAPI;
    if (!api?.clearLibrary) return { ok: false, error: 'Not supported' };
    const result = await api.clearLibrary({ deleteFiles, clearStats });
    if (result?.ok) {
      // Reset playback + library state locally
      const audio = audioRef.current;
      if (audio) { try { audio.pause(); } catch { /* ignore */ } audio.src = ''; }
      const standby = inactiveAudioRef.current;
      if (standby) { try { standby.pause(); } catch { /* ignore */ } standby.src = ''; }
      handoffArmedRef.current = false;
      preloadedKeyRef.current = null;
      resetCrossfadeGains();
      setQueue([]);
      setCurrentIndex(-1);
      /* The in-memory mirror has to go too, or Stats keeps rendering the
         cleared history until the next reload. */
      if (clearStats) {
        setPlayEvents([]);
        try { window.localStorage.removeItem('immerse:playEvents'); } catch { /* ignore */ }
      }
      setIsPlaying(false);
      setCurrentTime(0);
      setLibrary([]);
      setPlaylists([]);
      setReleases([]);
      setFollowOverrides([]);
      setHasEverPlayed(false);
      /* play_events deliberately SURVIVES a clear (see libraryDb) so history
         reattaches on re-import. Re-read it so the stats page reflects the
         new orphaned state immediately rather than after a restart. */
      setPlayEventsNonce((n) => n + 1);
    }
    return result;
  }, [resetCrossfadeGains]);

  const removeTracksFromLibrary = async (trackIds) => {
    const ids = new Set((trackIds || []).map(String).filter(Boolean));
    if (ids.size === 0) return;
    const api = window.electronAPI;
    // Snapshot the full track objects before removal so an Undo can re-add
    // them. Pull from the live library (the source of truth for metadata).
    const removedTracks = libraryRef.current.filter((t) => ids.has(t.id));
    let removedOk = false;
    if (api && typeof api.removeLibraryTracks === 'function') {
      const r = await api.removeLibraryTracks([...ids]);
      if (!r?.ok) return;
      removedOk = true;
    } else if (api && typeof api.invokeIpc === 'function') {
      const r = await api.invokeIpc('library:removeTracks', [...ids]);
      if (!r?.ok) return;
      removedOk = true;
    }
    if (!removedOk) return;

    const prevQ = queueRef.current;
    const curIdx = currentIndex;
    const curId = prevQ[curIdx]?.id;
    const nextQ = prevQ.filter((t) => !ids.has(t.id));

    if (api?.loadLibrary) {
      try {
        const fromDb = await api.loadLibrary();
        setLibrary(fromDb);
      } catch {
        setLibrary((prev) => prev.filter((t) => !ids.has(t.id)));
      }
    } else {
      setLibrary((prev) => prev.filter((t) => !ids.has(t.id)));
    }

    setQueue(nextQ);
    if (curId && ids.has(curId)) {
      if (nextQ.length === 0) {
        setCurrentIndex(-1);
        setIsPlaying(false);
      } else {
        setCurrentIndex(Math.min(curIdx, nextQ.length - 1));
      }
    } else if (curId) {
      const ni = nextQ.findIndex((t) => t.id === curId);
      setCurrentIndex(ni >= 0 ? ni : Math.min(curIdx, Math.max(0, nextQ.length - 1)));
    }

    // Undo toast — re-add the snapshotted tracks to the DB and reload. Only
    // offered when we actually captured the rows and the add API exists.
    const canUndo = removedTracks.length > 0 && typeof api?.addLibraryTracks === 'function';
    const label = removedTracks.length === 1
      ? `Removed “${removedTracks[0].title || 'track'}” from library`
      : `Removed ${ids.size} tracks from library`;
    pushToast({
      message: label,
      kind: 'info',
      durationMs: 7000,
      action: canUndo ? {
        label: 'Undo',
        onClick: async () => {
          try {
            await api.addLibraryTracks(removedTracks);
            await reloadLibrary();
            pushToast({ message: removedTracks.length === 1 ? 'Track restored' : `${removedTracks.length} tracks restored`, kind: 'success' });
          } catch (e) {
            pushToast({ message: `Couldn’t undo: ${e?.message || e}`, kind: 'error' });
          }
        },
      } : null,
    });
  };

  /** Update metadata fields on a single track and refresh the library. */
  const updateTrackMetadata = async (id, fields) => {
    const api = window.electronAPI;
    if (!api) return { ok: false, error: 'Not running in Electron' };
    let r;
    try {
      if (typeof api.updateLibraryTrack === 'function') {
        r = await api.updateLibraryTrack(id, fields);
      } else if (typeof api.invokeIpc === 'function') {
        r = await api.invokeIpc('library:updateTrack', { id, fields });
      } else {
        return { ok: false, error: 'Update not supported in this build' };
      }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
    if (!r?.ok) return r || { ok: false };
    // Reload the library so the edited row reflects in UI and queue
    try {
      const fromDb = await api.loadLibrary();
      setLibrary(fromDb);
      // Also patch the live queue so "currently playing" info updates without a skip
      setQueue((prev) => prev.map((t) => {
        if (t.id !== id) return t;
        const next = { ...t };
        if (typeof fields.title === 'string') next.title = fields.title.trim() || t.title;
        if (typeof fields.artist === 'string') next.artist = fields.artist.trim() || t.artist;
        if (typeof fields.album === 'string') next.album = fields.album.trim() || t.album;
        if ('year' in fields) next.year = fields.year || null;
        if ('genre' in fields) next.genre = fields.genre || '';
        if ('coverArt' in fields) next.coverArt = fields.coverArt || null;
        if ('trackNumber' in fields) next.trackNumber = fields.trackNumber || null;
        if ('discNumber' in fields) next.discNumber = fields.discNumber || null;
        return next;
      }));
    } catch { /* ignore */ }
    return { ok: true };
  };

  /** Apply album-level fields to a set of tracks in one transaction. */
  const updateAlbumMetadata = async (trackIds, fields) => {
    const api = window.electronAPI;
    if (!api) return { ok: false, error: 'Not running in Electron' };
    const ids = (trackIds || []).map(String).filter(Boolean);
    if (ids.length === 0) return { ok: false, error: 'No tracks to update' };
    let r;
    try {
      if (typeof api.updateLibraryAlbum === 'function') {
        r = await api.updateLibraryAlbum(ids, fields);
      } else if (typeof api.invokeIpc === 'function') {
        r = await api.invokeIpc('library:updateAlbum', { trackIds: ids, fields });
      } else {
        return { ok: false, error: 'Update not supported in this build' };
      }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
    if (!r?.ok) return r || { ok: false };
    // Reload library + patch live queue entries for any affected tracks
    try {
      const fromDb = await api.loadLibrary();
      setLibrary(fromDb);
      const idSet = new Set(ids);
      setQueue((prev) => prev.map((t) => {
        if (!idSet.has(t.id)) return t;
        const next = { ...t };
        if (typeof fields.artist === 'string') next.artist = fields.artist.trim() || t.artist;
        if (typeof fields.album === 'string') next.album = fields.album.trim() || t.album;
        if ('year' in fields) next.year = fields.year || null;
        if ('genre' in fields) next.genre = fields.genre || '';
        if ('coverArt' in fields) next.coverArt = fields.coverArt || null;
        return next;
      }));
    } catch { /* ignore */ }
    return { ok: true, updated: r.updated };
  };

  /* ---------- Favorites / notes / play tracking ---------- */

  /**
   * Toggle a track's favorite. Optimistically updates local library state so the
   * UI feels instant; rolls back if the DB write fails.
   */
  const toggleFavorite = async (id) => {
    const api = window.electronAPI;
    if (!api?.setTrackFavorite) return { ok: false };
    const current = library.find((t) => t.id === id);
    if (!current) return { ok: false };
    const next = !current.isFavorite;
    /* The queue holds COPIES of the track objects, taken when playback
       started — not references into `library`. So updating the library alone
       left `currentTrack.isFavorite` frozen at whatever it was when the song
       started, and every surface reading the current track (the now-playing
       bar's heart, the panel) could never show the change.
       Both have to move together. */
    const applyFav = (value) => {
      setLibrary((lib) => lib.map((t) => (t.id === id ? { ...t, isFavorite: value } : t)));
      setQueue((q) => q.map((t) => (t.id === id ? { ...t, isFavorite: value } : t)));
    };
    applyFav(next);
    try {
      const r = await api.setTrackFavorite(id, next);
      if (!r?.ok) applyFav(!next); // roll back
      return r;
    } catch (e) {
      applyFav(!next);
      return { ok: false, error: String(e?.message || e) };
    }
  };

  /**
   * Track which IDs we've already counted as played in this app session.
   * The threshold for counting a play is "30s elapsed OR 50% of duration,
   * whichever comes first" — matches Last.fm's scrobble rule.
   */
  /* ---------- Play count tracking ----------
   *
   * Bump play count + lastPlayed once per playback session of a track:
   *   - Threshold = min(30s, half the track length)
   *   - One bump per "session" = one continuous mount of this track as the
   *     current track. Switching to another track and back counts as a new
   *     session and is eligible for another bump.
   *
   * Why allow re-counting on return? Because a session is the natural unit
   * a listener thinks of — playing a song twice in a sitting is two plays
   * to a human. The Set is keyed by track id and is cleaned up in the
   * effect's teardown, so revisiting the same track later mounts a fresh
   * effect with a fresh chance to record.
   */

  /** Rolling log of play events. Each entry = { id, at }. Used by StatsTab to
   * compute "plays this week" as the actual count of events, not the count of
   * distinct tracks with `lastPlayed` in the window — the DB only stores the
   * latest play timestamp per track, so we keep this log in localStorage to
   * recover real per-week play totals.
   *
   * On bootstrap, hydrate from the DB (authoritative) — localStorage is a
   * legacy fallback for pre-DB-events installs. New events go to both.
   * Pruned to the last ~90 days on read so it can't grow unbounded. */
  const PLAY_EVENT_RETENTION_MS = 1000 * 60 * 60 * 24 * 90; // 90 days

  /* How much history the STATS page gets, which is a different question from
     how much the localStorage mirror should hold. SQLite never prunes
     play_events (only an explicit stats reset clears it), so the full log is
     always there — this constant just says how much of it to pull into memory.

     These used to be the same 90-day constant, which quietly capped every
     long-range view at a quarter: a year-to-date figure or a six-month
     calendar could only ever be populated for its most recent 90 days and
     would under-report the rest as zero rather than as unknown. It then
     became a 430-day window, which had the same shape of problem one order
     out — "All time" could only ever mean fourteen months. The DB read now
     pulls the whole log (bounded by the helper's 100k row cap), so the only
     retention policy left is the localStorage mirror below, which stays at
     90 days: it exists for pre-DB installs and is bounded by browser quota,
     not by what stats want. */
  const [playEvents, setPlayEvents] = useState(() => {
    try {
      const raw = typeof window !== 'undefined' ? window.localStorage.getItem('immerse:playEvents') : null;
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const cutoff = Date.now() - PLAY_EVENT_RETENTION_MS;
      // Keep only well-formed events newer than the cutoff. Sanitize defensively
      // — junk in localStorage shouldn't crash the app.
      return parsed.filter((e) => (
        e && typeof e.id === 'string' && Number.isFinite(e.at) && e.at >= cutoff
      ));
    } catch { return []; }
  });
  // Bootstrap from the DB once the library is open. The DB is the source
  // of truth for play events now — localStorage was a pre-DB-events
  // workaround that we keep around so older installs don't lose history.
  // The DB result REPLACES the localStorage seed (it includes everything
  // the localStorage one had, since recordTrackPlay writes both).
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.loadPlayEvents) return;
    let cancelled = false;
    (async () => {
      try {
        /* The whole log, not a trailing window. The Stats page defaults to
           "All time", and a 430-day cutoff would have quietly made that mean
           "the last fourteen months". The DB helper caps the result at 100k
           rows, so the payload stays bounded either way. */
        const events = await api.loadPlayEvents(0);
        if (cancelled || !Array.isArray(events)) return;
        setPlayEvents(events);
      } catch { /* keep the localStorage seed */ }
    })();
    return () => { cancelled = true; };
    /* Re-runs whenever playEventsNonce is bumped. Importing repairs orphaned
       events in SQLite (reattachPlayHistory repoints them at the new track ids
       and rebuilds play_count), but this component held a copy loaded once at
       mount — so a deleted-then-re-downloaded song showed no history until the
       app was restarted. Every path that can change which track an event
       belongs to bumps the nonce. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playEventsNonce]);

  // Persist the log whenever it changes. Also opportunistically prunes old
  // events on every save so the stored size never drifts upward.
  useEffect(() => {
    try {
      const cutoff = Date.now() - PLAY_EVENT_RETENTION_MS;
      const fresh = playEvents.filter((e) => e.at >= cutoff);
      if (fresh.length === 0) {
        window.localStorage.removeItem('immerse:playEvents');
      } else {
        window.localStorage.setItem('immerse:playEvents', JSON.stringify(fresh));
      }
    } catch { /* ignore */ }
  }, [playEvents]);


  // Dedupe lock for the per-track "scrobble" threshold. Tracks whose id
  // is in this set have already had a play recorded in the current play
  // segment. The lock is released when:
  //   - The track ends (audio `ended` event) — so a repeat play counts.
  //   - The user seeks backward below the threshold — so manually
  //     restarting the song to listen again counts.
  //   - The user switches to a different track — the effect cleanup
  //     removes the old id from the set.
  const playRecordedRef = useRef(new Set());
  /* How much of the CURRENT play has actually been heard, and which
     play_events row is waiting to be told about it.

     Listening time used to be inferred as duration x play count, which counts
     a six-minute track skipped at forty seconds as six minutes listened. That
     is what the stats page was ranking on. So we measure it instead: sum the
     forward progress of `currentTime` while the audio is actually playing.

     Deltas rather than a start/end subtraction, because subtraction cannot
     tell pausing, seeking and looping apart. Paused time contributes nothing
     (timeupdate stops firing), a seek is excluded because `seeked` re-baselines
     `last` before the next delta is taken, and rewinding to hear a passage
     twice correctly counts it twice. */
  const listenRef = useRef({ trackId: null, ms: 0, last: 0, eventId: null });

  useEffect(() => {
    if (!currentTrack) return undefined;
    const audio = audioRef.current;
    if (!audio) return undefined;
    const id = currentTrack.id;

    listenRef.current = { trackId: id, ms: 0, last: audio.currentTime || 0, eventId: null };

    /* Push the measured time onto the event opened for this play. Safe to
       call more than once — the DB only ever raises the stored value, so an
       `ended` flush followed by a teardown flush cannot shrink it. */
    const flushListened = () => {
      const st = listenRef.current;
      if (st.trackId !== id || !st.eventId || st.ms < 1000) return;
      const ms = Math.round(st.ms);
      const api = window.electronAPI;
      api?.updatePlayEventMs?.(st.eventId, ms).catch(() => {});
      // Mirror it in memory so the stats page reflects the real figure
      // without waiting for a reload.
      setPlayEvents((evs) => evs.map((e) => (e.eid === st.eventId ? { ...e, ms } : e)));
    };

    const recordIfThresholdHit = () => {
      if (playRecordedRef.current.has(id)) return;
      const dur = audio.duration || currentTrack.duration || 0;
      const elapsed = audio.currentTime || 0;
      const threshold = Math.min(30, dur > 0 ? dur * 0.5 : 30);
      if (elapsed < threshold) return;
      playRecordedRef.current.add(id);
      const api = window.electronAPI;
      /* Any Spotify song, saved or not, goes in Studio's own listening
         history too: Spotify never hears about plays here, so that's what
         My Spotify's Home is built from. */
      const sid = spotifyIdOf(currentTrack);
      if (sid && api?.recordListen) {
        const note = playContextFor(sid) || {};
        api.recordListen({
          spotifyId: sid,
          title: currentTrack.title,
          artists: currentTrack.artist || note.artists,
          artistIds: note.artistIds || [],
          album: currentTrack.album || note.album,
          albumId: note.albumId || null,
          albumArtUrl: (typeof currentTrack.coverArt === 'string' && /^https?:/.test(currentTrack.coverArt)
            ? currentTrack.coverArt : null) || note.albumArtUrl || null,
          durationMs: Math.round((dur || 0) * 1000),
          context: note.context || null,
        }).catch(() => {});
      }
      /* Played from My Spotify without saving: there's no library row to
         count it against. */
      if (currentTrack.streamOnly) return;
      if (!api?.recordTrackPlay) return;
      api.recordTrackPlay(id, Math.round(listenRef.current.ms)).then((r) => {
        if (!r?.ok) return;
        if (listenRef.current.trackId === id) listenRef.current.eventId = r.eventId ?? null;
        // Mirror the DB write in memory so library sorts and stats
        // update without waiting for a reload. The DB recordTrackPlay
        // is still the source of truth.
        const at = Date.now();
        setLibrary((lib) => lib.map((t) => (
          t.id === id
            ? { ...t, playCount: (t.playCount || 0) + 1, lastPlayed: at }
            : t
        )));
        setPlayEvents((evs) => [...evs, {
          id, at, eid: r.eventId ?? null, ms: Math.round(listenRef.current.ms) || null,
        }]);
      }).catch(() => {});
    };

    const onTime = () => {
      const st = listenRef.current;
      if (st.trackId === id) {
        const now = audio.currentTime || 0;
        const delta = now - st.last;
        st.last = now;
        /* Only forward progress counts. The upper bound absorbs a stalled
           tab or a decoding hiccup without swallowing a real seek, which
           `seeked` has already re-baselined away. */
        if (delta > 0 && delta < 10) st.ms += delta * 1000;
      }
      recordIfThresholdHit();
    };
    const onEnded = () => {
      // Report what was heard before the lock is released, then start the
      // next pass from zero so a repeat measures itself independently.
      flushListened();
      listenRef.current = { trackId: id, ms: 0, last: 0, eventId: null };
      // Track ended — clear the lock so a loop / repeat replays this
      // exact track at the next threshold crossing.
      playRecordedRef.current.delete(id);
    };
    const onSeeked = () => {
      // Seeking backward past the threshold gives the user another
      // shot at scrobbling: e.g. they really like the song and rewind
      // to its start. We re-arm the dedupe lock when current position
      // drops below the threshold, then the next forward play through
      // it will count.
      const dur = audio.duration || currentTrack.duration || 0;
      const threshold = Math.min(30, dur > 0 ? dur * 0.5 : 30);
      if ((audio.currentTime || 0) < threshold) {
        playRecordedRef.current.delete(id);
      }
    };
    /* Re-baseline before the next delta so the jump itself is never counted
       as listening. Runs for every seek, forward or back. */
    const onSeeking = () => {
      if (listenRef.current.trackId === id) listenRef.current.last = audio.currentTime || 0;
    };

    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('seeked', onSeeked);
    audio.addEventListener('seeking', onSeeking);
    audio.addEventListener('seeked', onSeeking);
    return () => {
      // Moving on mid-track is the common case — report what was heard.
      flushListened();
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('seeked', onSeeked);
      audio.removeEventListener('seeking', onSeeking);
      audio.removeEventListener('seeked', onSeeking);
      // Clear this id from the dedupe set so a future return to the
      // same track in a different session is eligible to be recorded.
      playRecordedRef.current.delete(id);
    };
  }, [currentTrack?.id]);

  /* ---------- New releases tracker ---------- */

  /**
   * Compute the "followed artist" set = (auto-followed from library with 2+ tracks)
   *                                   ∪ (manual 'add' overrides)
   *                                   − (manual 'exclude' overrides).
   *
   * Artist names are canonicalised to lower-case for comparison but returned
   * with their original casing so the iTunes query sees a proper name.
   */
  const followedArtists = useMemo(() => {
    const primaryArtist = (str) => {
      if (!str) return '';
      return str.split(/,|feat\.|ft\.|&|\bx\b/i)[0].trim();
    };
    const counts = new Map();    // lowercase → { displayName, count }
    for (const t of library) {
      const primary = primaryArtist(t.artist);
      if (!primary) continue;
      const key = primary.toLowerCase();
      const prev = counts.get(key);
      if (prev) prev.count += 1;
      else counts.set(key, { displayName: primary, count: 1 });
    }
    const auto = new Set();
    const displayByLower = new Map();
    for (const [key, v] of counts) {
      displayByLower.set(key, v.displayName);
      if (v.count >= 2) auto.add(key);
    }
    // Apply manual overrides
    for (const o of followOverrides) {
      const key = o.artistName.toLowerCase();
      displayByLower.set(key, o.artistName);
      if (o.action === 'add') auto.add(key);
      else if (o.action === 'exclude') auto.delete(key);
    }
    // Emit as array of { displayName, key, source }
    return [...auto].map((key) => {
      const override = followOverrides.find((o) => o.artistName.toLowerCase() === key && o.action === 'add');
      const resolved = followOverrides.find((o) => o.artistName.toLowerCase() === key && o.itunesArtistId);
      return {
        key,
        displayName: displayByLower.get(key) || key,
        itunesArtistId: resolved?.itunesArtistId ?? null,
        source: override ? 'manual' : 'auto',
      };
    }).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [library, followOverrides]);


  /**
   * Auto-refresh releases once per app session, a few seconds after bootstrap,
   * if we haven't already pulled within the last 24 hours. The main process
   * has its own cooldown so this is idempotent.
   */
  const releasesAutoRefreshedRef = useRef(false);
  useEffect(() => {
    if (releasesAutoRefreshedRef.current) return undefined;
    if (!libraryBootstrapped) return undefined;
    if (!followedArtists.length) return undefined;
    const api = window.electronAPI;
    if (!api?.refreshReleases) return undefined;

    // Only auto-refresh if the newest cached release is older than 24 hours
    // (or if there are no cached releases at all). Otherwise user hit refresh
    // recently or the data is already fresh.
    const newest = releases[0]?.cachedAt || 0;
    const stale = !newest || (Date.now() - newest) > 24 * 60 * 60 * 1000;
    if (!stale) {
      releasesAutoRefreshedRef.current = true;
      return undefined;
    }

    releasesAutoRefreshedRef.current = true;
    const t = setTimeout(async () => {
      try {
        setReleasesRefreshing(true);
        const names = followedArtists.map((a) => a.displayName);
        await api.refreshReleases(names, 'auto');
        // Reload cache after refresh completes
        const r = await api.loadCachedReleases();
        if (r?.ok) setReleases(r.releases || []);
      } catch (e) { console.error('auto-refresh releases', e); }
      finally { setReleasesRefreshing(false); }
    }, 3500); // small delay so we don't pile onto startup
    return () => clearTimeout(t);
  }, [libraryBootstrapped, followedArtists.length]);






  /* ---------- Playlist CRUD ---------- */

  const refreshPlaylists = async () => {
    const api = window.electronAPI;
    if (!api?.loadPlaylists) return;
    try {
      const pls = await api.loadPlaylists();
      if (!Array.isArray(pls)) return;
      /* loadPlaylists returns trackCOUNT, not track ids — the ids live behind a
         separate playlists:loadTrackIds call. Every consumer in the UI reads
         pl.trackIds (to render a playlist's contents, to mark songs as already
         added, to count them), so without this hydration playlists always
         looked empty and adding a track appeared to do nothing at all. */
      const withIds = await Promise.all(pls.map(async (pl) => {
        if (!api.loadPlaylistTrackIds) return { ...pl, trackIds: null };
        try {
          const ids = await api.loadPlaylistTrackIds(pl.id);
          return { ...pl, trackIds: Array.isArray(ids) ? ids.map(String) : null };
        } catch { return { ...pl, trackIds: null }; }
      }));
      /* null means "couldn't read them", NOT "there are none". Returning [] on
         failure here would clobber ids we already hold — including the ones
         just added optimistically — and make a populated playlist look empty. */
      setPlaylists((prev) => withIds.map((pl) => (
        pl.trackIds === null
          ? { ...pl, trackIds: prev.find((x) => x.id === pl.id)?.trackIds || [] }
          : pl
      )));
    } catch (e) { console.error('refreshPlaylists', e); }
  };

  const createPlaylist = async (fields) => {
    const api = window.electronAPI;
    if (!api?.createPlaylist) return { ok: false, error: 'Not supported' };
    const r = await api.createPlaylist(fields || {});
    if (r?.ok) await refreshPlaylists();
    return r;
  };

  const updatePlaylist = async (id, fields) => {
    const api = window.electronAPI;
    if (!api?.updatePlaylist) return { ok: false, error: 'Not supported' };
    const r = await api.updatePlaylist(id, fields || {});
    /* Log failures. A cover that silently doesn't save is indistinguishable
       from one that saved and didn't render — normalizePlaylistCover returns
       null for anything that isn't http(s), studio-cover:// or a data URI it
       can write to disk, so a rejected image looks like a no-op. */
    if (!r?.ok) console.error('[updatePlaylist]', r?.error || 'failed', fields);
    if (r?.ok) await refreshPlaylists();
    return r;
  };

  const renamePlaylist = async (id, name) => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.renamePlaylist) return { ok: false, error: 'Not supported' };
    const r = await api.renamePlaylist(id, name);
    if (r?.ok) setPlaylists((ls) => ls.map((p) => (p.id === id ? { ...p, name } : p)));
    return r;
  };

  const removeTrackFromPlaylist = async (playlistId, trackId) => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.removeTrackFromPlaylist) return { ok: false, error: 'Not supported' };
    const r = await api.removeTrackFromPlaylist(playlistId, trackId);
    if (r?.ok) {
      setPlaylists((ls) => ls.map((p) => (p.id === playlistId
        ? { ...p, trackIds: (p.trackIds || []).filter((t) => t !== trackId) }
        : p)));
    }
    return r;
  };

  const deletePlaylist = async (id) => {
    const api = window.electronAPI;
    if (!api?.deletePlaylist) return { ok: false, error: 'Not supported' };
    // Snapshot for undo: the playlist's fields + its ordered track ids.
    const snapshot = (playlists || []).find((p) => p.id === id) || null;
    let trackIds = [];
    if (api.loadPlaylistTrackIds) {
      try {
        const r = await api.loadPlaylistTrackIds(id);
        trackIds = Array.isArray(r) ? r : (r?.trackIds || []);
      } catch { /* ignore */ }
    }
    const r = await api.deletePlaylist(id);
    if (r?.ok) {
      await refreshPlaylists();
      const canUndo = !!snapshot && typeof api.createPlaylist === 'function';
      pushToast({
        message: `Deleted playlist “${snapshot?.name || 'Untitled'}”`,
        kind: 'info', durationMs: 7000,
        action: canUndo ? {
          label: 'Undo',
          onClick: async () => {
            try {
              const created = await api.createPlaylist({ name: snapshot.name, coverArt: snapshot.coverArt });
              const newId = created?.id || created?.playlist?.id;
              if (newId && trackIds.length && api.addTracksToPlaylist) {
                await api.addTracksToPlaylist(newId, trackIds);
              }
              await refreshPlaylists();
              pushToast({ message: `Restored “${snapshot.name || 'playlist'}”`, kind: 'success' });
            } catch (e) {
              pushToast({ message: `Couldn’t undo: ${e?.message || e}`, kind: 'error' });
            }
          },
        } : null,
      });
    }
    return r;
  };

  const addTracksToPlaylist = async (playlistId, trackIds) => {
    const api = window.electronAPI;
    if (!api?.addTracksToPlaylist) return { ok: false, error: 'Not supported' };
    const ids = (trackIds || []).map(String);
    const r = await api.addTracksToPlaylist(playlistId, ids);
    if (r?.ok) {
      /* Update local state directly as well as refreshing. refreshPlaylists
         re-reads from SQLite and re-hydrates trackIds, but it depends on
         loadPlaylistTrackIds being present and succeeding for every playlist —
         if that call is missing or throws, the catch hands back an empty
         trackIds array and the playlist reads as empty even though the write
         succeeded. Merging here means the view is correct either way. */
      setPlaylists((ls) => ls.map((p) => {
        if (p.id !== playlistId) return p;
        const cur = Array.isArray(p.trackIds) ? p.trackIds : [];
        const merged = [...cur, ...ids.filter((id) => !cur.includes(id))];
        return { ...p, trackIds: merged, trackCount: merged.length };
      }));
      await refreshPlaylists();
    }
    return r;
  };



  const inElectron = typeof window !== 'undefined' && !!window.electronAPI;
  const uiFontStack = presetById(uiFontId).stack;

  return (
    <ToastContext.Provider value={pushToast}>
    <div style={{
      width: '100%', height: '100vh', display: 'flex', flexDirection: 'column',
      background: '#000', color: '#fff',
      fontFamily: uiFontStack,
      fontSize: '13px', overflow: 'hidden',
      position: 'relative',
    }}
    >
      {!inElectron ? (
        <div style={{
          flexShrink: 0, background: '#5c1010', color: '#fecaca', padding: '12px 20px', fontSize: 13, lineHeight: 1.55,
          borderBottom: '1px solid rgba(255,255,255,0.12)', WebkitAppRegion: 'no-drag',
          position: 'relative', zIndex: 200,
        }}
        >
          <strong style={{ color: '#fff' }}>You are in a normal browser tab.</strong>
          {' '}
          Close this tab and use the
          {' '}
          <strong style={{ color: '#fff' }}>studio desktop window</strong>
          {' '}
          that appears when you run
          {' '}
          <span style={{ fontFamily: 'ui-monospace, Consolas, monospace', color: '#fda4af' }}>npm start</span>
          {' '}
          from the project folder.
        </div>
      ) : null}

      {/* StudioShell is the entire view layer: onboarding → home → fullscreen overlay. */}
      <StudioShell
        library={library}
        onClearLibrary={clearLibrary}
        /* Playlists existed in App from the start but were never passed to any
           component, so nothing could show or create one. */
        playlists={playlists}
        onCreatePlaylist={createPlaylist}
        onDeletePlaylist={deletePlaylist}
        onAddTracksToPlaylist={addTracksToPlaylist}
        onRenamePlaylist={renamePlaylist}
        onUpdatePlaylist={updatePlaylist}
        onRemoveFromPlaylist={removeTrackFromPlaylist}
        onImportFiles={importFiles}
        onImportSpotify={() => setSpotifyImportOpen(true)}
        spotifyImportOpen={spotifyImportOpen}
        onCloseSpotifyImport={() => setSpotifyImportOpen(false)}
        onReloadLibrary={reloadLibrary}
        onImportFolder={importFolder}
        importing={importing}
        albumCoverOverrides={albumCoverOverrides}
        currentTrack={currentTrack}
        isPlaying={isPlaying}
        currentTime={currentTime}
        duration={duration}
        volume={volume}
        gainBoost={gainBoost}
        onSetGainBoost={setGainBoost}
        getGainReduction={getGainReduction}
        shuffleOn={shuffleOn}
        repeat={repeat}
        onPlayTrack={playTrack}
        onTogglePlay={togglePlay}
        onPrev={handlePrev}
        onNext={handleNext}
        onToggleShuffle={toggleShuffle}
        onToggleRepeat={() => setRepeat((p) => (p === 'off' ? 'all' : p === 'all' ? 'one' : 'off'))}
        onSeek={seekTo}
        onSetVolume={setVolume}
        beatReactive={beatReactive}
        analyserRef={analyserRef}
        onNeedAnalyser={needAnalyser}
        ensureAnalyser={ensureAnalyser}
        playEvents={playEvents}
        onSpotifyImportDone={handleSpotifyImportDone}
        transitionMode={transitionMode}
        onSetTransitionMode={setTransitionMode}
        onUpdateTrackMetadata={updateTrackMetadata}
        onRemoveFromLibrary={removeTracksFromLibrary}
        onToggleFavorite={toggleFavorite}
        onPlayNext={playNext}
        onAddToQueue={addToQueue}
        onUpdateAlbumMetadata={updateAlbumMetadata}
        onSetAlbumCover={handleSetAlbumCover}
        discordPresenceEnabled={discordPresenceEnabled}
        onSetDiscordPresenceEnabled={setDiscordPresenceEnabled}
        discordAppId={discordAppId}
        onSetDiscordAppId={setDiscordAppId}
        discordPresenceDetail={discordPresenceDetail}
        onSetDiscordPresenceDetail={setDiscordPresenceDetail}
        discordHideWhenPaused={discordHideWhenPaused}
        onSetDiscordHideWhenPaused={setDiscordHideWhenPaused}
        queue={queue}
        queueIndex={currentIndex}
        /* Already existed and was never wired to anything — the queue panel
           had no way to ask for a move until now. */
        onReorderQueue={reorderQueue}
        imgbbApiKey={imgbbApiKey}
        onSetImgbbApiKey={setImgbbApiKey}
        uiFontId={uiFontId}
        onSetUiFontId={setUiFontId}
      />

      {/* Drag strip and window controls both removed from here.

          The drag strip was an invisible 36px bar pinned across the top at
          z-index 99. Fine when the top of the window was empty, but the top bar
          lives there now — and a `-webkit-app-region: drag` element swallows
          clicks at the OS hit-test level, before they reach React, so the upper
          half of every tab was dead. Dragging still works: the top bar itself
          is `drag`, with its tabs, search and settings `no-drag`.

          The window controls were three glass pills at top: 6, right: 8 that
          painted over the bar's settings button. NOTE: the window is
          frame: false, so with these gone it can only be closed from the
          taskbar until they're restored. WinBtn is kept below for that. */}

      {/* Ambient mode overlay. Renders unconditionally so React keeps the
         AmbientMode instance mounted across activations; the component
         itself returns null when `active` is false. This avoids a tear-
         down/rebuild every time the player goes idle, which matters
         because AmbientMode runs its own setIntervals for cover cycling. */}
      <AmbientMode
        active={ambientActive}
        library={library}
        onClose={dismissAmbient}
        onPlayAlbum={(albumTracks) => {
          // User picked an album from ambient mode — play track 1 and
          // exit ambient. setAmbientActive(false) here, NOT dismissAmbient,
          // because we want re-engagement to happen if they later become
          // idle again (which dismissAmbient would prevent until the
          // next session-start). currentTrack appearing will re-arm
          // anyway via the idle-timer effect.
          if (!albumTracks || albumTracks.length === 0) return;
          setAmbientActive(false);
          playTrack(albumTracks[0], albumTracks);
        }}
      />
      {/* Global toast stack — used by the auto-updater and any other
          app-shell notification path. Pinned to bottom-right above the
          player chrome. */}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      {/* What's new overlay — shown once per version bump. */}
      {whatsNewOpen && whatsNewData ? (
        <WhatsNewOverlay
          data={whatsNewData}
          onClose={dismissWhatsNew}
        />
      ) : null}
      {/* Easter egg — fireflies drift across the window while "Fireflies"
          by Owl City plays. Pure decoration; pointer-events disabled so
          it never blocks the UI. */}
      <FirefliesOverlay active={isFireflies && isPlaying} />
      {/* Drag-and-drop import indicator. Last real child of App's root so it
          layers over onboarding, home and the fullscreen overlay alike, and
          renders nothing unless a drag is in flight or an import is running.
          Neutral accent: the cover theme is derived inside StudioShell and
          isn't in scope here. */}
      <DropOverlay active={draggingFiles} importing={importing} />

      <ImmerseTooltipLayer />
    </div>
    </ToastContext.Provider>
  );
}

/**
 * FirefliesOverlay — full-window swarm of glowing fireflies, shown as an
 * easter egg while "Fireflies" by Owl City plays.
 *
 * Implementation notes:
 *   - Canvas-based for smooth 60fps particle motion without thrashing
 *     React. The component only re-renders when `active` flips; all the
 *     animation happens imperative inside a rAF loop on the canvas.
 *   - ~32 particles (medium swarm). Each drifts with gentle sinusoidal
 *     motion, blinks its glow on its own cycle (real fireflies pulse,
 *     they don't shine steadily), and varies in size/brightness.
 *   - Additive blending ('lighter') so overlapping glows build up into
 *     luminous blooms against the dark UI.
 *   - Fades in over ~1.5s when activated and out when deactivated, so it
 *     doesn't pop in/out abruptly on track change.
 *   - pointer-events: none — purely decorative, never blocks clicks.
 *   - Respects the canvas being unmounted: the rAF loop is cancelled and
 *     the canvas cleared on cleanup.
 */
function FirefliesOverlay({ active }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const particlesRef = useRef([]);
  const globalAlphaRef = useRef(0);   // master fade 0..1
  const activeRef = useRef(active);

  // Keep the latest `active` readable inside the persistent rAF loop.
  useEffect(() => { activeRef.current = active; }, [active]);

  // We keep the canvas + loop alive whenever there's ANY visible
  // firefly alpha — so when `active` turns off, the swarm fades out
  // gracefully before we tear down. Mount the loop once.
  const [shouldRender, setShouldRender] = useState(active);
  useEffect(() => {
    if (active) setShouldRender(true);
    // when inactive, shouldRender stays true until fade-out completes
    // (handled in the loop, which calls setShouldRender(false) at alpha 0)
  }, [active]);

  useEffect(() => {
    if (!shouldRender) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');

    let width = 0;
    let height = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    // Spawn the swarm if not already populated.
    const COUNT = 32;
    if (particlesRef.current.length === 0) {
      particlesRef.current = Array.from({ length: COUNT }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        // base drift velocity (px/sec), slow and dreamy
        vx: (Math.random() - 0.5) * 18,
        vy: (Math.random() - 0.5) * 14 - 4, // slight upward bias
        // wander offsets so motion isn't perfectly linear
        wanderPhase: Math.random() * Math.PI * 2,
        wanderSpeed: 0.4 + Math.random() * 0.6,
        // blink cycle
        blinkPhase: Math.random() * Math.PI * 2,
        blinkSpeed: 0.6 + Math.random() * 1.1,
        radius: 1.4 + Math.random() * 2.2,
        baseBrightness: 0.5 + Math.random() * 0.5,
      }));
    }

    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000); // clamp big gaps
      last = now;

      // Master fade toward target.
      const target = activeRef.current ? 1 : 0;
      const fadeSpeed = activeRef.current ? 0.7 : 0.9; // per second
      globalAlphaRef.current += (target - globalAlphaRef.current) * Math.min(1, fadeSpeed * dt * 4);
      if (!activeRef.current && globalAlphaRef.current < 0.01) {
        // Fully faded out — stop and unmount.
        ctx.clearRect(0, 0, width, height);
        setShouldRender(false);
        return;
      }

      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'lighter';

      const g = globalAlphaRef.current;
      for (const p of particlesRef.current) {
        // wander
        p.wanderPhase += p.wanderSpeed * dt;
        const wob = Math.sin(p.wanderPhase) * 8;
        p.x += (p.vx + Math.cos(p.wanderPhase) * 6) * dt;
        p.y += (p.vy + wob * 0.3) * dt;

        // wrap around edges with a margin so they drift back in
        const m = 30;
        if (p.x < -m) p.x = width + m;
        if (p.x > width + m) p.x = -m;
        if (p.y < -m) p.y = height + m;
        if (p.y > height + m) p.y = -m;

        // blink
        p.blinkPhase += p.blinkSpeed * dt;
        const blink = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(p.blinkPhase));
        const alpha = g * p.baseBrightness * blink;
        if (alpha <= 0.01) continue;

        // glow: radial gradient, warm yellow-green
        const r = p.radius;
        const glowR = r * 6;
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowR);
        grad.addColorStop(0, `rgba(200, 255, 130, ${alpha})`);
        grad.addColorStop(0.25, `rgba(160, 240, 90, ${alpha * 0.5})`);
        grad.addColorStop(1, 'rgba(140, 220, 70, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, glowR, 0, Math.PI * 2);
        ctx.fill();

        // bright core
        ctx.fillStyle = `rgba(230, 255, 190, ${alpha})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 0.7, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalCompositeOperation = 'source-over';
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('resize', resize);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [shouldRender]);

  if (!shouldRender) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 55, // below toasts (60) and overlays, above the app UI
        pointerEvents: 'none',
      }}
    />
  );
}

/**
 * WhatsNewOverlay — modal that appears once after each app update with
 * the GitHub release notes for the new version.
 *
 * Notes are pulled from the GitHub Release's `body` field, which is
 * GitHub-flavored markdown. We do a lightweight render here (headings,
 * bold, italic, inline code, code blocks, links, lists) — no full
 * markdown parser dep. The renderer is intentionally conservative;
 * anything we don't recognize falls through as plain text rather than
 * raw HTML, so a malformed release body just looks plain, not broken.
 *
 * The overlay matches Immerse's existing modal style: blurred backdrop,
 * frosted glass card, accent green for headings + the close button.
 */
function WhatsNewOverlay({ data, onClose }) {
  const { name, body, url, publishedAt } = data;

  // Escape key dismisses, matching the rest of Immerse's modals.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const dateLine = useMemo(() => {
    if (!publishedAt) return '';
    try {
      const d = new Date(publishedAt);
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch { return ''; }
  }, [publishedAt]);

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div style={{
        width: 'min(560px, 100%)',
        maxHeight: 'calc(100vh - 80px)',
        display: 'flex', flexDirection: 'column',
        borderRadius: 18,
        background: 'rgba(22, 22, 24, 0.88)',
        backdropFilter: 'blur(40px) saturate(1.6)', WebkitBackdropFilter: 'blur(40px) saturate(1.6)',
        border: '1px solid rgba(255,255,255,0.1)',
        boxShadow: '0 24px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(29,185,84,0.12), inset 0 1px 0 rgba(255,255,255,0.06)',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '18px 22px 14px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          display: 'flex', alignItems: 'flex-start', gap: 14,
        }}>
          <div style={{
            flexShrink: 0,
            width: 38, height: 38,
            borderRadius: 10,
            background: 'rgba(29,185,84,0.16)',
            border: '1px solid rgba(29,185,84,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18,
          }}>
            <span aria-hidden style={{ color: '#1db954' }}>✨</span>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 10.5, letterSpacing: 0.6, textTransform: 'uppercase',
              color: '#1db954', fontWeight: 700,
            }}>
              What's new
            </div>
            <div style={{
              fontSize: 18, fontWeight: 600, color: '#fff',
              marginTop: 2,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {name}
            </div>
            {dateLine ? (
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>
                Released {dateLine}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              flexShrink: 0,
              width: 28, height: 28,
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.1)',
              background: 'rgba(255,255,255,0.04)',
              color: 'rgba(255,255,255,0.7)',
              cursor: 'pointer',
              fontSize: 14,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            ×
          </button>
        </div>

        {/* Body — scrollable */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '14px 22px 18px',
          fontSize: 12.5,
          lineHeight: 1.65,
          color: 'rgba(255,255,255,0.82)',
        }}>
          <MarkdownLite text={body} />
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              style={{
                display: 'inline-block', marginTop: 14,
                fontSize: 11, color: 'rgba(255,255,255,0.45)',
                borderBottom: '1px solid rgba(255,255,255,0.15)',
                textDecoration: 'none',
              }}
            >
              View on GitHub →
            </a>
          ) : null}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 22px 16px',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          display: 'flex', justifyContent: 'flex-end',
        }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '8px 18px',
              borderRadius: 10,
              border: '1px solid rgba(29,185,84,0.4)',
              background: 'rgba(29,185,84,0.22)',
              color: '#1db954',
              fontSize: 12, fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}


/**
 * MarkdownLite — minimal renderer for GitHub release-notes markdown.
 * Handles only the subset that's actually common in release notes:
 *
 *   - # / ## / ### headings
 *   - **bold** and *italic*
 *   - `inline code`
 *   - ```fenced code blocks```
 *   - [link text](url)
 *   - - / * bullet lists (single level)
 *   - 1. 2. 3. numbered lists (single level)
 *   - Blank lines as paragraph separators
 *
 * Anything else falls through as plain text. We don't use
 * dangerouslySetInnerHTML — every match is rendered as React elements,
 * which keeps untrusted release-notes content sandboxed (GitHub itself
 * sanitizes markdown but we don't want to depend on that).
 *
 * Why not pull in a real markdown lib? Three reasons:
 *   - Bundle size: react-markdown + remark-gfm pulls in ~80 KB of
 *     code we don't otherwise use.
 *   - Style isolation: real libs need extra CSS to match a dark theme.
 *   - Scope: release notes are short and structurally simple; we don't
 *     need tables, footnotes, task lists, etc.
 *
 * The implementation is line-based: split on \n, classify each line by
 * its prefix, render. Inline transforms (bold, links, code) are applied
 * per-line. Code fences span multiple lines so we maintain a small
 * state machine for "inside fence" vs "normal".
 */
function MarkdownLite({ text }) {
  const blocks = useMemo(() => parseMarkdownLite(text || ''), [text]);
  return (
    <div>
      {blocks.map((b, i) => renderMdBlock(b, i))}
    </div>
  );
}

function parseMarkdownLite(src) {
  const lines = src.split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, '').trim();
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }

    // Headings
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2] });
      i++;
      continue;
    }

    // Bulleted list — consume consecutive bullet lines into one block
    if (/^[\-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[\-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[\-*]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // Numbered list
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    // Blank line — separator
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph — consume consecutive non-blank, non-special lines
    const para = [line];
    i++;
    while (i < lines.length
      && lines[i].trim() !== ''
      && !/^(#{1,3})\s+/.test(lines[i])
      && !/^[\-*]\s+/.test(lines[i])
      && !/^\d+\.\s+/.test(lines[i])
      && !/^```/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'p', text: para.join(' ') });
  }
  return blocks;
}

function renderMdBlock(b, key) {
  if (b.type === 'heading') {
    const sizes = { 1: 17, 2: 14.5, 3: 13 };
    const weights = { 1: 700, 2: 700, 3: 600 };
    return (
      <div
        key={key}
        style={{
          fontSize: sizes[b.level] || 13,
          fontWeight: weights[b.level] || 600,
          color: '#fff',
          marginTop: key === 0 ? 0 : 14,
          marginBottom: 6,
        }}
      >
        {renderInline(b.text)}
      </div>
    );
  }
  if (b.type === 'ul') {
    return (
      <ul key={key} style={{ margin: '4px 0 8px 0', paddingLeft: 22 }}>
        {b.items.map((it, j) => (
          <li key={j} style={{ marginBottom: 2 }}>{renderInline(it)}</li>
        ))}
      </ul>
    );
  }
  if (b.type === 'ol') {
    return (
      <ol key={key} style={{ margin: '4px 0 8px 0', paddingLeft: 22 }}>
        {b.items.map((it, j) => (
          <li key={j} style={{ marginBottom: 2 }}>{renderInline(it)}</li>
        ))}
      </ol>
    );
  }
  if (b.type === 'code') {
    return (
      <pre
        key={key}
        style={{
          margin: '6px 0 10px',
          padding: '10px 12px',
          borderRadius: 8,
          background: 'rgba(0,0,0,0.4)',
          border: '1px solid rgba(255,255,255,0.06)',
          fontSize: 11.5,
          lineHeight: 1.5,
          color: 'rgba(255,255,255,0.85)',
          fontFamily: 'ui-monospace, SF Mono, Menlo, Consolas, monospace',
          overflowX: 'auto',
          whiteSpace: 'pre',
        }}
      >
        {b.text}
      </pre>
    );
  }
  // paragraph
  return (
    <div key={key} style={{ marginBottom: 8 }}>
      {renderInline(b.text)}
    </div>
  );
}

/**
 * renderInline — apply inline markdown formatting (links, bold, italic,
 * code) to a single string and return a list of React nodes. Goes
 * link → code → bold → italic in that priority order so combos like
 * `**bold with `code` inside**` work reasonably.
 *
 * Returns an array of strings + spans / anchor elements. Caller embeds
 * the array directly as children.
 */
function renderInline(text) {
  if (!text) return null;
  // Tokenize: walk the string finding the next match for any of our
  // patterns. We always consume the EARLIEST match at each step.
  const patterns = [
    { re: /\[([^\]]+)\]\(([^)]+)\)/, kind: 'link' },     // [text](url)
    { re: /`([^`]+)`/, kind: 'code' },                   // `code`
    { re: /\*\*([^*]+)\*\*/, kind: 'bold' },             // **bold**
    { re: /\*([^*]+)\*/, kind: 'italic' },               // *italic*
    { re: /_([^_]+)_/, kind: 'italic' },                 // _italic_
  ];
  const out = [];
  let remaining = text;
  let nodeKey = 0;
  while (remaining.length > 0) {
    let earliest = null;
    for (const pat of patterns) {
      const m = pat.re.exec(remaining);
      if (m && (earliest === null || m.index < earliest.match.index)) {
        earliest = { match: m, kind: pat.kind };
      }
    }
    if (!earliest) {
      out.push(remaining);
      break;
    }
    if (earliest.match.index > 0) {
      out.push(remaining.slice(0, earliest.match.index));
    }
    const m = earliest.match;
    if (earliest.kind === 'link') {
      out.push(
        <a key={`mdn${nodeKey++}`} href={m[2]} target="_blank" rel="noreferrer"
          style={{ color: '#1db954', textDecoration: 'none', borderBottom: '1px solid rgba(29,185,84,0.4)' }}>
          {m[1]}
        </a>,
      );
    } else if (earliest.kind === 'code') {
      out.push(
        <code key={`mdn${nodeKey++}`}
          style={{
            padding: '1px 6px',
            borderRadius: 4,
            background: 'rgba(0,0,0,0.4)',
            border: '1px solid rgba(255,255,255,0.07)',
            fontSize: '0.92em',
            fontFamily: 'ui-monospace, SF Mono, Menlo, Consolas, monospace',
            color: 'rgba(255,255,255,0.92)',
          }}>
          {m[1]}
        </code>,
      );
    } else if (earliest.kind === 'bold') {
      out.push(<strong key={`mdn${nodeKey++}`} style={{ color: 'rgba(255,255,255,0.95)' }}>{m[1]}</strong>);
    } else if (earliest.kind === 'italic') {
      out.push(<em key={`mdn${nodeKey++}`}>{m[1]}</em>);
    }
    remaining = remaining.slice(m.index + m[0].length);
  }
  return out;
}




/**
 * AmbientMode — full-window cover collage that auto-engages after the
 * player has been idle for 30s.
 *
 * Returns null while `active` is false (kept mounted so internal state /
 * intervals can be lazily initialized once on first activation, not torn
 * down and rebuilt every idle cycle).
 *
 * Weighted selection picks each visible slot from three buckets so the
 * collage mixes familiar music with rediscovery and discovery:
 *   - 50% recently played (last 14 days)
 *   - 30% rediscovery (played before, but not in last 6 months)
 *   - 20% deep cuts (played < 2 times)
 * The track-level `playCount` and `lastPlayed` fields drive bucketing,
 * with album-keyed dedup so the same album doesn't show up twice on
 * screen at once.
 */
function AmbientMode({ active, library, onClose, onPlayAlbum }) {
  // Number of cover slots visible at once. 6 hits a balance — busy
  // enough to feel like a collage, sparse enough that each cover gets
  // visual breathing room. On smaller windows the layout still works
  // because each slot picks a random position within bounds.
  const SLOT_COUNT = 6;
  // How long each cover stays visible before being swapped out, in ms.
  // Slot lifetimes are staggered so the screen never feels like it's
  // refreshing all at once.
  const SLOT_LIFETIME_MS = 11_000;
  // Stagger between slot updates. Spreads the SLOT_COUNT changes evenly
  // across the lifetime so a different cover swaps every ~1.8s.
  const SLOT_CYCLE_MS = Math.round(SLOT_LIFETIME_MS / SLOT_COUNT);

  // Albums grouped by key with cover + tracks. Recomputed only when
  // library changes (could be 10k tracks; don't rebuild on every render).
  const albumsByKey = useMemo(() => {
    // Extract the "primary artist" — the first name before any feat./ft./&/x
    // /comma separators. Mirrors the grouping logic in ImmersiveLibraryPage so
    // collab tracks (e.g. "Pierce the Veil, Kellin Quinn") get keyed under the
    // same album as the rest of the album's tracks, instead of producing a
    // separate per-track tile. Without this, ambient would surface a single
    // collab song as if it were its own album.
    const primaryArtist = (str) => {
      if (!str) return 'Unknown Artist';
      const clean = str.split(/,|feat\.|ft\.|&|\bx\b/i)[0].trim();
      return clean || str.trim();
    };
    const m = new Map();
    for (const t of library || []) {
      if (!t.album || !t.coverArt) continue; // need both for the collage
      const albumName = (t.album || '').trim() || 'Unknown Album';
      const primary = primaryArtist(t.artist);
      const key = `${albumName}__${primary}`;
      if (!m.has(key)) {
        // Prefer a track with a cover to seed the album entry's cover.
        // Any track on the album might have cover art; we just pick whichever
        // one we hit first.
        m.set(key, { key, album: albumName, artist: primary, coverArt: t.coverArt, tracks: [] });
      }
      m.get(key).tracks.push(t);
    }
    return m;
  }, [library]);

  // Pre-bucket album keys by play status so the weighted random in
  // pickAlbum is O(1) per call. Rebuilt with library; doesn't change
  // during a single ambient session unless tracks get played in
  // background (rare while ambient is showing — by definition we're idle).
  const buckets = useMemo(() => {
    const now = Date.now();
    const recentMs = 14 * 24 * 60 * 60 * 1000;       // 14 days
    const longTimeMs = 180 * 24 * 60 * 60 * 1000;    // ~6 months
    const recent = [];
    const rediscovery = [];
    const discovery = [];
    for (const album of albumsByKey.values()) {
      // For album-level bucketing, use the most-played track in the album
      // as the representative. Counts the album as "played recently" if
      // any track on it was, etc.
      let maxPlay = 0;
      let mostRecent = 0;
      for (const t of album.tracks) {
        if ((t.playCount || 0) > maxPlay) maxPlay = t.playCount || 0;
        if ((t.lastPlayed || 0) > mostRecent) mostRecent = t.lastPlayed || 0;
      }
      if (mostRecent && now - mostRecent < recentMs) {
        recent.push(album.key);
      } else if (mostRecent && now - mostRecent > longTimeMs) {
        rediscovery.push(album.key);
      } else if (maxPlay < 2) {
        discovery.push(album.key);
      } else {
        // Plays in 14d–6mo window — counts as "rediscovery-adjacent",
        // give it to rediscovery bucket as a fallback so it still gets
        // surfaced occasionally.
        rediscovery.push(album.key);
      }
    }
    return { recent, rediscovery, discovery };
  }, [albumsByKey]);

  // Pick a weighted-random album key, avoiding any keys currently shown
  // in other slots. Returns null if the library is empty.
  const pickAlbumKey = useCallback((avoidKeys) => {
    const tryBucket = (arr) => {
      if (!arr || arr.length === 0) return null;
      // Up to 8 attempts to find a non-dup; if everything dups, just
      // return any from the bucket — the visual repeat is preferable
      // to a blank slot.
      for (let i = 0; i < 8; i++) {
        const k = arr[Math.floor(Math.random() * arr.length)];
        if (!avoidKeys.has(k)) return k;
      }
      return arr[Math.floor(Math.random() * arr.length)];
    };
    const roll = Math.random();
    let key = null;
    if (roll < 0.5) key = tryBucket(buckets.recent);
    else if (roll < 0.8) key = tryBucket(buckets.rediscovery);
    else key = tryBucket(buckets.discovery);
    // Fallback chain: if the chosen bucket is empty, walk the others.
    if (!key) key = tryBucket(buckets.recent) || tryBucket(buckets.rediscovery) || tryBucket(buckets.discovery);
    // Last-resort: any album at all.
    if (!key && albumsByKey.size > 0) {
      const keys = Array.from(albumsByKey.keys());
      key = keys[Math.floor(Math.random() * keys.length)];
    }
    return key;
  }, [buckets, albumsByKey]);

  // Slot state: an array of { id, albumKey, x, y, scale, phase }.
  // phase is 'in' (fading in), 'visible', 'out' (fading out), 'gone'.
  // We use the slot's stable id (0..SLOT_COUNT-1) as the React key so
  // React doesn't unmount the wrapper between cycles — the wrapper has
  // its CSS transition that handles the visual fade.
  const [slots, setSlots] = useState(() => Array.from({ length: SLOT_COUNT }, (_, i) => ({
    id: i, albumKey: null, x: 50, y: 50, scale: 1, opacity: 0, generation: 0,
  })));

  // Click-confirmation popup state. Holds the album the user clicked
  // on; while non-null, a small modal asks what to do.
  const [confirmAlbum, setConfirmAlbum] = useState(null);
  // Tracks mouse activity for the auto-revealing ✕ button. Mouse moves
  // set this to a timestamp; an interval below sets it back to 0 after
  // 2.5s of stillness. The X button's opacity is derived from this.
  const [mouseActive, setMouseActive] = useState(false);
  const mouseTimerRef = useRef(null);
  const onMouseMove = useCallback(() => {
    setMouseActive(true);
    if (mouseTimerRef.current) clearTimeout(mouseTimerRef.current);
    mouseTimerRef.current = setTimeout(() => setMouseActive(false), 2500);
  }, []);

  // Position generator — uses a 3x2 grid with jitter so slots don't
  // bunch up. Six slots map naturally to a 3x2 layout; jitter prevents
  // it from looking like a static grid.
  const positionForSlot = useCallback((slotId) => {
    const col = slotId % 3;          // 0, 1, 2
    const row = Math.floor(slotId / 3); // 0, 1
    const baseX = 18 + col * 32;     // 18, 50, 82
    const baseY = 28 + row * 44;     // 28, 72
    const jitterX = (Math.random() - 0.5) * 12;
    const jitterY = (Math.random() - 0.5) * 14;
    return {
      x: Math.max(8, Math.min(92, baseX + jitterX)),
      y: Math.max(12, Math.min(88, baseY + jitterY)),
      scale: 0.85 + Math.random() * 0.25, // 0.85..1.10
    };
  }, []);

  // The cycle: every SLOT_CYCLE_MS, pick the oldest slot and replace it.
  // Initial activation: stagger all slots in with a quick burst so the
  // screen fills naturally rather than appearing all at once.
  useEffect(() => {
    if (!active) return undefined;
    if (albumsByKey.size === 0) return undefined; // empty library

    // Initial fill: stagger SLOT_COUNT covers into view over ~2 seconds.
    let cancelled = false;
    const fillTimers = [];
    setSlots(Array.from({ length: SLOT_COUNT }, (_, i) => ({
      id: i, albumKey: null, x: 50, y: 50, scale: 1, opacity: 0, generation: 0,
    })));
    for (let i = 0; i < SLOT_COUNT; i++) {
      const t = setTimeout(() => {
        if (cancelled) return;
        setSlots((prev) => {
          const taken = new Set(prev.map((s) => s.albumKey).filter(Boolean));
          const key = pickAlbumKey(taken);
          if (!key) return prev;
          const pos = positionForSlot(i);
          return prev.map((s) => s.id === i
            ? { ...s, albumKey: key, ...pos, opacity: 1, generation: s.generation + 1 }
            : s
          );
        });
      }, i * 320);
      fillTimers.push(t);
    }

    // Ongoing cycle: replace one slot every SLOT_CYCLE_MS once the
    // initial fill is done. Picks slot in round-robin order so each
    // gets equal "screen time."
    let cycleSlot = 0;
    const cycleStart = setTimeout(() => {
      const iv = setInterval(() => {
        if (cancelled) return;
        const id = cycleSlot;
        cycleSlot = (cycleSlot + 1) % SLOT_COUNT;
        setSlots((prev) => {
          const taken = new Set(prev.map((s) => s.albumKey).filter(Boolean));
          const next = pickAlbumKey(taken);
          if (!next) return prev;
          const pos = positionForSlot(id);
          return prev.map((s) => s.id === id
            ? { ...s, albumKey: next, ...pos, generation: s.generation + 1 }
            : s
          );
        });
      }, SLOT_CYCLE_MS);
      fillTimers.push({ kind: 'interval', iv });
    }, SLOT_COUNT * 320 + 500);

    return () => {
      cancelled = true;
      fillTimers.forEach((t) => {
        if (t && t.kind === 'interval') clearInterval(t.iv);
        else clearTimeout(t);
      });
      clearTimeout(cycleStart);
    };
  }, [active, albumsByKey, pickAlbumKey, positionForSlot]);

  // Cleanup mouse timer on unmount.
  useEffect(() => {
    return () => { if (mouseTimerRef.current) clearTimeout(mouseTimerRef.current); };
  }, []);

  if (!active) return null;

  // Background wash: pick the focal cover (most-recently changed slot
  // with an album) and use it as a blurred backdrop. Falls back to the
  // first available album cover or a dark gradient if nothing.
  const focal = [...slots].sort((a, b) => b.generation - a.generation).find((s) => s.albumKey);
  const focalCover = focal ? albumsByKey.get(focal.albumKey)?.coverArt : null;

  return (
    <div
      onMouseMove={onMouseMove}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 200,
        background: '#000',
        // Smooth fade-in when ambient activates. The 600ms is intentionally
        // a bit slow so it feels gentle, not abrupt.
        animation: 'ambientFadeIn 600ms ease',
        overflow: 'hidden',
        cursor: 'default',
      }}
    >
      {/* Blurred background wash from the focal cover. Heavy blur +
         lowered opacity creates the dreamlike backdrop. */}
      {focalCover ? (
        <div
          key={focalCover}
          style={{
            position: 'absolute', inset: -40,
            backgroundImage: `url(${focalCover})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            filter: 'blur(60px) saturate(1.4)',
            opacity: 0.45,
            // Cross-fade when focal changes by re-running this animation.
            animation: 'ambientWashFade 1500ms ease',
          }}
        />
      ) : (
        <div style={{
          position: 'absolute', inset: 0,
          background: 'radial-gradient(ellipse at center, #1a1a2e 0%, #000 70%)',
        }} />
      )}

      {/* Dim overlay so foreground covers pop against the wash. */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'rgba(0,0,0,0.35)',
        pointerEvents: 'none',
      }} />

      {/* Cover slots */}
      {slots.map((slot) => {
        const album = slot.albumKey ? albumsByKey.get(slot.albumKey) : null;
        if (!album) return null;
        return (
          <div
            key={slot.id}
            // Inner key on the image swaps to re-trigger fade animations
            // when the slot's album changes.
            onClick={() => setConfirmAlbum(album)}
            style={{
              position: 'absolute',
              left: `${slot.x}%`,
              top: `${slot.y}%`,
              width: 'min(260px, 22vw)',
              aspectRatio: '1',
              transform: `translate(-50%, -50%) scale(${slot.scale})`,
              opacity: slot.opacity,
              cursor: 'pointer',
              // Smooth cross-fade as covers change in their slot.
              transition: 'opacity 1200ms ease, transform 1200ms ease',
              willChange: 'opacity, transform',
            }}
          >
            <img
              key={`${slot.albumKey}-${slot.generation}`}
              src={album.coverArt}
              alt=""
              decoding="async"
              style={{
                width: '100%', height: '100%',
                objectFit: 'cover',
                borderRadius: 8,
                boxShadow: '0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06)',
                animation: 'ambientCoverFade 1500ms ease',
                display: 'block',
              }}
            />
          </div>
        );
      })}

      {/* Hint text near the bottom — fades to nothing after a few
         seconds so it doesn't distract once the user has seen it. */}
      <div style={{
        position: 'absolute',
        bottom: 48, left: 0, right: 0,
        textAlign: 'center',
        color: 'rgba(255,255,255,0.5)',
        fontSize: 13, letterSpacing: 0.5,
        pointerEvents: 'none',
        animation: 'ambientHintFade 4s ease forwards',
      }}>
        Click any cover to play
      </div>

      {/* Close button — only visible when mouse has moved recently. */}
      <button
        type="button"
        onClick={onClose}
        title="Exit ambient mode"
        style={{
          position: 'absolute',
          top: 16, right: 16,
          width: 36, height: 36,
          borderRadius: '50%',
          border: 'none',
          background: 'rgba(0,0,0,0.5)',
          color: '#fff',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          opacity: mouseActive ? 1 : 0,
          transition: 'opacity 300ms ease, background 0.15s',
          WebkitAppRegion: 'no-drag',
          zIndex: 210,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(232,17,35,0.85)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.5)'; }}
      >
        <svg width="14" height="14" viewBox="0 0 12 12">
          <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>

      {/* Click-confirmation popup */}
      {confirmAlbum && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setConfirmAlbum(null); }}
          style={{
            position: 'absolute', inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 215,
            animation: 'ambientFadeIn 200ms ease',
          }}
        >
          <div style={{
            background: 'rgba(20,20,30,0.95)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 16,
            padding: '24px 28px',
            minWidth: 320,
            maxWidth: 'min(420px, 90vw)',
            boxShadow: '0 30px 80px rgba(0,0,0,0.7)',
          }}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              <img src={confirmAlbum.coverArt} alt=""
                style={{ width: 72, height: 72, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{
                  fontSize: 15, fontWeight: 700, color: '#fff',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {confirmAlbum.album}
                </div>
                <div style={{
                  fontSize: 12, color: 'rgba(255,255,255,0.6)', marginTop: 3,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {confirmAlbum.artist}
                  <span style={{ color: 'rgba(255,255,255,0.35)' }}>
                    {' · '}{confirmAlbum.tracks.length} {confirmAlbum.tracks.length === 1 ? 'track' : 'tracks'}
                  </span>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 18 }}>
              <button
                type="button"
                onClick={() => {
                  const tracks = confirmAlbum.tracks;
                  setConfirmAlbum(null);
                  onPlayAlbum(tracks);
                }}
                style={ambientBtnStyle(true)}
              >
                Play this album
              </button>
              <button
                type="button"
                onClick={() => setConfirmAlbum(null)}
                style={ambientBtnStyle(false)}
              >
                Keep browsing
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Keyframes for the various fades. Scoped via unique names so they
         won't collide with anything else in the app. */}
      <style>{`
        @keyframes ambientFadeIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes ambientWashFade {
          from { opacity: 0; }
          to   { opacity: 0.45; }
        }
        @keyframes ambientCoverFade {
          from { opacity: 0; transform: scale(0.96); }
          to   { opacity: 1; transform: scale(1); }
        }
        @keyframes ambientHintFade {
          0%   { opacity: 0; }
          15%  { opacity: 1; }
          75%  { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}

function ambientBtnStyle(primary) {
  return {
    width: '100%', padding: '10px 16px',
    borderRadius: 8, border: 'none',
    background: primary ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.06)',
    color: primary ? '#000' : 'rgba(255,255,255,0.85)',
    fontSize: 13, fontWeight: 600,
    cursor: 'pointer',
    transition: 'background 0.15s',
  };
}
