import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { PreviewButton, stop as stopPreview } from './previewPlayer.jsx';
import {
  parseQuery, providerQuery, passesScopes, scoreEntity,
  slskQuality, groupSlskFiles, matchFilesToTracks, trackKey,
  describeCoverage, groupReleases, rankSources, leadCredit, releaseKey, normStrict,
  creditMatchesArtist, creditIncludesArtist,
  isSongSizedRelease, sameSongFamily, classifyRelease,
  fmtMs, fmtSec, fmtSize, fmtSpeed, normLoose, normTitle,
} from './instantSearch.js';

/* =========================================================================
 *  studio — instant search
 *
 *  A palette that resolves as you type and DRILLS rather than dead-ends.
 *  Three levels, one keystroke apart in either direction:
 *
 *    results  →  album   →  (a track's sources, expanded in place)
 *             →  artist  →  album → …
 *
 *  The premise is that a search result is a place you can go, not a row you
 *  can only act on. Picking an album shows its real tracklist; picking an
 *  artist shows their catalogue. The search is never lost — it's the frame
 *  underneath, and Esc walks back to it with the same row still selected.
 *
 *  Results arrive in three waves so the panel is useful before the network
 *  is: the library filters synchronously as you type, Spotify lands in a few
 *  hundred milliseconds, and Soulseek takes as long as it takes. Each wave
 *  paints on arrival rather than the whole panel waiting for the slowest.
 *
 *  What this component does NOT own: downloading, playback, the library, or
 *  the artist page. Those are all props — this decides what's on screen and
 *  hands the verbs back to StudioHome, which already has them.
 * ========================================================================= */

const api = () => (typeof window !== 'undefined' ? window.electronAPI : null);

/* 320, not 190. Each search costs a handful of iTunes requests against a
   ~20/min ceiling, so the debounce is a rate-limit control as much as a
   responsiveness one: at 190ms, typing "Juice WRLD" fired several full
   searches and spent most of the minute's budget before the word was
   finished. A third of a second is still below the pause most people take
   between words, so it costs little in felt latency and saves most of the
   wasted searches. */
const DEBOUNCE_MS = 320;
/* Persisted so someone who wants lossless says so once, not every session. */
const QUALITY_KEY = 'studio:searchQuality';
const MAX_ARTISTS = 4;
/* Raised from 12. With singles (1-track) no longer taking slots, we can show
   more actual albums/EPs without overwhelming the panel. 24 gives a solid
   overview while still leaving room to drill into the full artist page. */
const MAX_ALBUMS = 50;
/* Upstream, spotifySearchTracks caps at SPOTIFY_SEARCH_MAX_TRACKS (20) because
   each page of 10 is its own request and client-credentials 429s bite fast. A
   downstream cap of 10 on top of that was throwing away half of what had
   already been paid for. This number is free; the upstream one is not.

   Neither makes the Songs section a CATALOGUE — /v1/search?type=track ranks by
   relevance and returns what it feels like, which is why the count differs per
   artist. Enumerating an artist properly happens in the artist frame. */
const MAX_SONGS = 24;
const MAX_FOLDERS = 4;

/* ---- The library confidence ladder -------------------------------------
   One score, three rungs, so "search my library too" isn't a mode with a
   switch — it's how sure the library is that it already answered you.

     >= CERTAIN     the query NAMES one song you own. Don't search at all.
     >= CONFIDENT   every query word is present in something you own. Pin it
                    above the network in a fixed-height band.
     below that     a weak match. It merges into Songs and competes on
                    relevance like anything else.

   That bottom rung is load-bearing. Pinning owned rows without a floor is
   how one song called "Drunk Dial" ends up above Beyoncé when you searched
   "drunk in love". The band is for confident matches; the tail still has to
   earn its place. */
const CERTAIN = 100;
const CONFIDENT = 70;
/* Rows per band page. Fixed, so a query like "you" that matches forty things
   you own can't push the rest of the panel off the bottom of the screen. */
const BAND = 8;   /* Brief: show six to eight rows and let the arrows run past
                     the bottom, rather than paging three at a time. */

/* Expanding a discography is one request per release. Pooled and capped
   because a client-credentials token is rate-limited on a rolling request
   count, not on bandwidth — the failure mode is a 429 that takes out the
   whole panel, not a slow list. */
const EXPAND_CONCURRENCY = 4;
const EXPAND_MAX_RELEASES = 60;
/* How many songs the artist frame leads with. A chart, not a catalogue —
   the releases underneath are the catalogue. */
const ARTIST_TOP_SONGS = 10;

/* ------------------------------------------------------------------ icons */
const Ico = {
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" /></>,
  chevron: <path d="M9 6l6 6-6 6" />,
  back: <path d="M19 12H5M11 18l-6-6 6-6" />,
  folder: <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
  note: <path d="M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm12-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />,
  check: <path d="M20 6L9 17l-5-5" />,
  spark: <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8z" />,
  play: <path d="M8 5v14l11-7z" fill="currentColor" stroke="none" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
};

/* ---- Scope chips ---------------------------------------------------------
   The query is two things: committed scope tokens (artist:, album:, year:,
   is:) shown as chips, and the free text in the field. `raw` — what every
   other part of this file reads — is just the two joined, so parseQuery and
   everything downstream see exactly the string they always did.

   Before this, the chips were a READ-ONLY echo of tokens that were still
   sitting in the input as text, so every scope showed twice, and removing
   one ran the value through `new RegExp` unescaped: "artist:A$AP", anything
   with brackets, and every is:new / is:mine (whose chip shows the normalised
   value, not what was typed) either threw or silently matched nothing. */
const RECENT_KEY = 'studio:recentSearches';
const RECENT_MAX = 8;
const TOKEN_RE = /(^|\s)(artist|album|year|is):("[^"]*"|[^\s"]\S*)(?=\s)/gi;
const TOKEN_ALL_RE = /(^|\s)(artist|album|year|is):("[^"]*"|[^\s"]\S*)/gi;

const quoteScope = (v) => (/\s/.test(v) ? `"${String(v).replace(/"/g, '')}"` : v);

/** A token parseQuery actually honours — "year:abc" or "is:foo" stay text. */
function validToken(tok) {
  return parseQuery(tok).scopes.length > 0;
}
/** The key a chip replaces: artist/album/year hold one value, is: stacks. */
function tokenSlot(tok) {
  const sc = parseQuery(tok).scopes[0];
  if (!sc) return tok;
  return sc.key === 'is' ? `is:${sc.value}` : sc.key;
}
/**
 * Pull scope tokens out of a string. `all` treats every token as finished
 * (for strings set in code — a seed, a recent search); otherwise a token only
 * commits once it's followed by whitespace, so "artist:ke" stays editable
 * text until the space that says it's done.
 */
function splitScopes(str, all = false) {
  const chips = [];
  const re = all ? TOKEN_ALL_RE : TOKEN_RE;
  re.lastIndex = 0;
  const text = String(str || '').replace(re, (whole, lead, key, value) => {
    const tok = `${key.toLowerCase()}:${value}`;
    if (!validToken(tok)) return whole;
    chips.push(tok);
    return lead;
  });
  return { chips, text: all ? text.replace(/\s+/g, ' ').trim() : text.replace(/^\s+/, '').replace(/\s{2,}/g, ' ') };
}
function mergeChips(prev, add) {
  const out = [...prev];
  for (const tok of add) {
    const slot = tokenSlot(tok);
    const at = out.findIndex((t) => tokenSlot(t) === slot);
    if (at >= 0) out[at] = tok; else out.push(tok);
  }
  return out;
}

function loadRecents() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).slice(0, RECENT_MAX) : [];
  } catch { return []; }
}

/* Starting points for an empty box. Prefix scopes drop the key into the
   field and wait for a value; the is: ones are complete on their own. */
const FILTER_HINTS = [
  ['artist:', 'only this artist'],
  ['album:', 'only this record'],
  ['year:', 'drops re-uploads'],
  ['is:missing', 'hide what you own'],
  ['is:lossless', 'FLAC and friends'],
  ['is:owned', 'include what you own'],
];

function Svg({ d, size = 15, w = 2, children, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden>
      {children || d}
    </svg>
  );
}

/* ------------------------------------------------------------- small bits */

function QualityBadge({ q }) {
  if (!q) return null;
  const style = q.lossless
    ? { background: 'rgba(140,220,160,0.14)', color: 'rgb(140,220,160)', boxShadow: 'inset 0 0 0 1px rgba(140,220,160,0.22)' }
    : q.tier >= 4 ? { background: 'rgba(var(--st-acc-rgb),0.14)', color: 'rgb(var(--st-acc-rgb))', boxShadow: 'inset 0 0 0 1px rgba(var(--st-acc-rgb),0.22)' }
      : { background: 'rgba(var(--st-fg-rgb),0.07)', color: 'rgba(var(--st-fg-rgb),0.55)' };
  return <span className="isx-badge" style={style}>{q.label}</span>;
}

function SlotTag({ free }) {
  return (
    <span className="isx-avail" style={{ color: free ? 'rgba(140,220,160,0.9)' : 'rgba(240,190,120,0.85)' }}>
      <span className="isx-dot" style={{ background: free ? 'rgb(140,220,160)' : 'rgb(240,190,120)' }} />
      {free ? 'Free slot' : 'Queued'}
    </span>
  );
}

/** Download affordance for one row. Mirrors FindGetBtn's states exactly so a
 *  download looks the same wherever you started it. */
function GetBtn({ dl, progress, label = 'Save', solid = false, big = false, onGrab, width = 92 }) {
  if (dl === 'busy') {
    const pct = typeof progress?.pct === 'number' ? progress.pct : null;
    const text = progress?.phase === 'processing' ? 'Processing…' : pct != null ? `${Math.round(pct * 100)}%` : 'Saving…';
    return (
      <div className="isx-prog" style={{ width }} title={text}>
        <div className="isx-prog-bar"><i style={{ width: pct != null ? `${Math.round(pct * 100)}%` : '35%' }} /></div>
        <span>{text}</span>
      </div>
    );
  }
  if (dl === 'done') return <span className="isx-owned">Added</span>;
  return (
    <button type="button"
      className={`isx-get${solid ? ' is-solid' : ''}${big ? ' is-big' : ''}`}
      onClick={(e) => { e.stopPropagation(); onGrab?.(); }}>
      {dl === 'failed' ? 'Retry' : label}
    </button>
  );
}

/* ========================================================================= */

export default function InstantSearch({
  open = false,
  onClose,
  /* Library — used for the instant tier and for ownership marks. */
  library = [],
  alreadyOwned,
  coverFor,
  /* Download plumbing, all owned by StudioHome. */
  dlState = {},
  dlProgress = {},
  onGetSpotifyTrack,      // (spotifyRow) — the YouTube route
  onGetSlskFile,          // (peerRow)    — a real file from a peer
  onGetSlskAlbum,         // (folder)     — a whole folder
  /* Navigation out of the palette. */
  onPlayTrack,            // (libraryTrack)
  onOpenArtist,           // (artist)  → push the full profile page
  /* (artistRef, nav) → the artist view, rendered INSIDE the panel as the
     artist frame. StudioHome supplies it (it owns the library and download
     plumbing the view needs); `nav` lets the view move within the panel —
     another artist, a release, a new search — or leave for the full page. */
  renderArtist,
  onOpenLibraryAlbum,     // (libTrack) → your album page, for owned songs Spotify can't place
  onOpenAlbum,            // (album)   → push the full album page (optional)
  seed = '',              // preload the query when something else opens this
  onFilterLibrary,        // (queryString) → narrow the library table and go there
}) {
  /* ---------------------------------------------------------------- state */
  // A preview started from the panel ends with the panel.
  useEffect(() => { if (!open) stopPreview(); }, [open]);
  const [chips, setChips] = useState([]);
  const [text, setText] = useState('');
  const raw = useMemo(() => (chips.length ? `${chips.join(' ')} ${text}` : text), [chips, text]);
  /* Everything that SETS the query from code (seed, recents, "drop the
     filters", Shift+Tab) goes through here and gets its scopes split out. */
  const setRaw = useCallback((full) => {
    const r = splitScopes(full, true);
    setChips(r.chips);
    setText(r.text);
  }, []);
  const onTextChange = useCallback((v) => {
    const r = splitScopes(v, false);
    if (r.chips.length) {
      setChips((c) => mergeChips(c, r.chips));
      setText(r.text);
    } else {
      setText(v);
    }
  }, []);
  const removeChip = useCallback((i) => {
    setChips((c) => c.filter((_, k) => k !== i));
  }, []);
  const parsed = useMemo(() => parseQuery(raw), [raw]);

  const [recents, setRecents] = useState(loadRecents);
  const saveRecents = useCallback((next) => {
    setRecents(next);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }, []);
  /* Recorded when a search is USED (a row acted on), not on every debounce —
     otherwise "ke", "kes", "kesh" each land in the list. */
  const rememberQuery = useCallback((q) => {
    const v = String(q || '').replace(/\s+/g, ' ').trim();
    if (v.length < 2) return;
    setRecents((prev) => {
      const next = [v, ...prev.filter((x) => x.toLowerCase() !== v.toLowerCase())].slice(0, RECENT_MAX);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const hasQuery = !!(parsed.text || parsed.artist || parsed.album);

  /* Which page of the library band is showing. Reset with the cursor. */
  const [bandPage, setBandPage] = useState(0);
  /* The exact query the user pressed "search anyway" on. Storing the QUERY
     rather than a boolean means it expires by itself the moment they type
     something else — no reset effect, and no window where a stale override
     fires a request for a query that didn't need one. */
  const [forceFor, setForceFor] = useState('');

  /* ---- Rung 1: the query names something you already have ----------------
     scoreEntity already handles both phrasings. "keshi - drunk" parses to an
     artist scope and scores the title at 100; bare "keshi drunk" goes
     through bestSplitScore and lands at 112 once both halves clear. Either
     way, CERTAIN means the query wasn't a DESCRIPTION of a song — it was
     that song's name, and the song is on this machine.

     Searching anyway isn't neutral here: it spends a round trip, then
     reshuffles the panel under the cursor to offer you a copy of a file you
     are already holding. */
  const localCertainty = useMemo(() => {
    if (!hasQuery) return null;
    /* These scopes are questions ABOUT the network — "what am I missing",
       "what exists in lossless". Owning a copy answers neither. */
    if (parsed.missingOnly || parsed.losslessOnly) return null;
    /* One bare word is never specific enough. "drunk" hitting a song you own
       doesn't mean you meant that song; it means you typed one word. */
    const words = String(parsed.text || '').trim().split(/\s+/).filter(Boolean);
    if (!parsed.artist && !parsed.album && words.length < 2) return null;

    const scored = library
      .filter((t) => passesScopes(parsed, { artist: t.artist, album: t.album, title: t.title }))
      .map((t) => ({ t, s: scoreEntity(parsed, 'track', { title: t.title, artists: t.artist }) }))
      .sort((a, b) => b.s - a.s);

    const top = scored[0];
    if (!top || top.s < CERTAIN) return null;
    /* A second pressing of the same recording doesn't make this ambiguous —
       a runner-up only counts as a rival if it's a DIFFERENT song. */
    const rival = scored.some((x) => x.s >= CERTAIN
      && !sameSongFamily(top.t.title, top.t.artist, x.t.title, x.t.artist));
    return rival ? null : { track: top.t };
  }, [library, parsed, hasQuery]);

  /* "Search anyway" is scoped to the query it was granted for. */
  /* The certainty gate (skip the network when the query names a song you
     own, and show only that song) is off: search always searches, and owned
     songs sit in the Songs list marked as yours rather than above it. */
  const certain = null;
  void localCertainty; void forceFor;
  const certainId = certain?.track?.id || '';

  /* Each wave lands in its own slot so a slow one can't blank a fast one. */
  const [spotify, setSpotify] = useState({ artists: [], albums: [], songs: [] });
  const [slsk, setSlsk] = useState({ rows: [], folders: [] });
  const [phase, setPhase] = useState({ spotify: 'idle', slsk: 'idle' }); // idle|busy|done|error
  const [errorNote, setErrorNote] = useState('');

  /* ---- Quality mode ------------------------------------------------------
     'fast'  — Spotify only. Every Get goes through YouTube, which always
               works and starts immediately. Soulseek is never touched unless
               you ask for it on a specific thing.
     'best'  — Soulseek is also checked in the background, and rows UPGRADE in
               place when it answers.

     Default is 'fast' on purpose. Soulseek routinely takes five to ten
     seconds, and a search box that appears to still be working is a search
     box people walk away from. The upgrade is worth waiting for; the wait is
     not worth imposing on someone who just wants the song. */
  const [quality, setQuality] = useState(() => {
    try { return localStorage.getItem(QUALITY_KEY) === 'best' ? 'best' : 'fast'; } catch { return 'fast'; }
  });
  const setQualityMode = useCallback((m) => {
    setQuality(m);
    try { localStorage.setItem(QUALITY_KEY, m); } catch { /* ignore */ }
  }, []);

  /* The drill stack. [] is the results list; each push is a frame. */
  const [stack, setStack] = useState([]);
  const frame = stack[stack.length - 1] || null;

  const [cursor, setCursor] = useState(0);
  const [expandedTrack, setExpandedTrack] = useState(null); // album track with its sources open
  const [expandedSong, setExpandedSong] = useState(null);   // results-list song, ditto

  /* Per-frame data, cached across pushes so backing out and in is instant. */
  const [albumData, setAlbumData] = useState({});   // albumId → { tracks, busy }
  const [artistData, setArtistData] = useState({}); // artistId → { albums, top, busy }
  /* artistId → { started, tracks[], done, total } — every track on every
     release, which is the only way to answer "what of theirs don't I have".
     Track search can't: it ranks by relevance and stops at 20. */
  const [artistTracks, setArtistTracks] = useState({});
  /* On-demand Soulseek lookups, one per thing asked about. Keyed and cached
     so asking twice costs one search. */
  const [songProbes, setSongProbes] = useState({});   // songId  → { busy, sources[], done }
  const [albumProbes, setAlbumProbes] = useState({}); // albumId → { busy, match, folders, done }

  const inputRef = useRef(null);
  const listRef = useRef(null);
  const reqRef = useRef(0);
  /* probeAlbum needs the tracklist AFTER its own await, by which point the
     `albumData` it closed over is stale — the tracklist may well have landed
     during the peer search. A ref reads the current one. */
  const albumDataRef = useRef({});
  useEffect(() => { albumDataRef.current = albumData; }, [albumData]);

  /* ------------------------------------------------------- open / reset */
  useEffect(() => {
    if (!open) return undefined;
    /* A seed means something else started this search — a Discover tile, an
       artist page — so it replaces whatever was in the box. An empty seed
       leaves the last query alone, which is what re-opening expects. */
    if (seed) { setRaw(seed); setForceFor(''); }
    /* Re-opening keeps the last query, selected — typing replaces it, an
       arrow key keeps it. Before, the caret landed at the end and a new
       search meant clearing the old one by hand first. */
    const t = setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      if (!seed) el.select();
    }, 20);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seed]);

  useEffect(() => {
    if (open) return;
    // Closing forgets the drill position but keeps the query, so re-opening
    // lands you back where you were reading rather than on a blank field.
    setStack([]);
    setExpandedTrack(null);
    setExpandedSong(null);
    setCursor(0);
  }, [open]);

  /* ------------------------------------------------------------- search */
  useEffect(() => {
    if (!open) return undefined;
    const q = parsed;
    /* Nothing to ask, or nothing worth asking — see localCertainty. */
    if (!hasQuery || certain) {
      /* Bumping the counter orphans anything already in flight. Without it,
         the search fired at "keshi drun" lands underneath the answer for
         "keshi drunk" and the panel fills with results it deliberately
         decided not to ask for. */
      reqRef.current += 1;
      setSpotify({ artists: [], albums: [], songs: [] });
      setSlsk({ rows: [], folders: [] });
      setPhase({ spotify: 'idle', slsk: 'idle' });
      setErrorNote('');
      return undefined;
    }

    const req = ++reqRef.current;
    const timer = setTimeout(async () => {
      /* Soulseek only reports 'busy' when it's actually going to run. In fast
         mode it stays idle, so nothing in the chrome suggests the panel is
         still waiting on something — because it isn't. */
      setPhase({ spotify: 'busy', slsk: quality === 'best' ? 'busy' : 'idle' });
      setErrorNote('');

      const sq = providerQuery(q, 'spotify');
      const kq = providerQuery(q, 'soulseek');

      if (api()?.spotifySearch) {
        /* Three independent searches, three independent arrivals.
         *
         * These used to be joined with Promise.all, so nothing appeared until
         * the slowest finished — and the slowest is albums, which verifies its
         * results against the store before returning. Artists and songs were
         * typically ready long before, sitting in a resolved promise waiting
         * for a section the user might not even be looking at. Landing each
         * one as it arrives doesn't make the search faster, it makes it feel
         * roughly as fast as its quickest part rather than its slowest.
         *
         * Each guards on `req` so a superseded search can't paint over a newer
         * one, and `pending` tracks completion across all three so the busy
         * indicator still clears exactly once. */
        let pending = 3;
        const settle = () => {
          pending -= 1;
          if (pending === 0 && reqRef.current === req) {
            setPhase((p) => ({ ...p, spotify: 'done' }));
          }
        };
        const land = (field) => (rows) => {
          if (reqRef.current !== req) return;
          setSpotify((s) => ({ ...s, [field]: Array.isArray(rows) ? rows : [] }));
          settle();
        };
        /* Every provider in the chain failed (main.js already tried the Client
           ID, the signed-in account and iTunes). Say why instead of showing
           "Nothing matched", which reads as "no such music". */
        const fail = (e) => {
          if (reqRef.current !== req) return;
          setPhase((p) => ({ ...p, spotify: 'error' }));
          const msg = String(e?.message || e || '');
          setErrorNote(/429|rate.?limit/i.test(msg)
            ? 'Spotify and the fallback providers are rate-limiting searches right now. Wait a minute and try again.'
            : `Search failed${msg ? `: ${msg.replace(/^Error invoking remote method '[^']+':\s*/, '')}` : ''}.`);
          settle();
        };

        api().spotifySearch(sq).then(land('songs'), fail);

        if (api().spotifySearchArtists) {
          api().spotifySearchArtists(q.artist || sq).then(land('artists'), fail);
        } else settle();

        if (api().spotifySearchAlbums) {
          api().spotifySearchAlbums(sq).then(land('albums'), fail);
        } else settle();
      } else {
        setPhase((p) => ({ ...p, spotify: 'error' }));
        setErrorNote('Spotify search needs credentials — add them in Settings.');
      }

      /* The background pass. Only in Best mode, and only ever ADDITIVE — when
         it answers, rows gain a lossless badge where one exists. It never
         reorders the list and never gates a Get, so landing late is harmless
         rather than disruptive. */
      if (quality === 'best' && api()?.soulseekSearch) {
        api().soulseekSearch(kq).then((res) => {
          if (reqRef.current !== req) return;
          if (res?.ok === false) { setPhase((p) => ({ ...p, slsk: 'error' })); return; }
          setSlsk({
            rows: Array.isArray(res?.results) ? res.results : [],
            folders: Array.isArray(res?.albums) ? res.albums : [],
          });
          setPhase((p) => ({ ...p, slsk: 'done' }));
        }).catch(() => {
          if (reqRef.current !== req) return;
          setPhase((p) => ({ ...p, slsk: 'error' }));
        });
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, raw, hasQuery, certainId]);

  /* ------------------------------------------------- tier 0: the library */
  /* The library has no section of its own any more — it merges into `songs`
     below, so an owned track and a downloadable one sit in one ranked list
     and a song appears exactly once. The count that used to live here is now
     rendered by the Songs header ("N already yours"), which is the only place
     it was ever read. */

  /* ------------------------------------------- library-aware artist facts */
  const libraryArtistCounts = useMemo(() => {
    const m = new Map();
    for (const t of library) {
      const k = normLoose(t.artist);
      if (!k) continue;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }, [library]);

  /* --------------------------------------------------------- result sets */
  const artists = useMemo(() => {
    const ranked = spotify.artists
      .map((a) => ({
        ...a,
        inLibraryCount: libraryArtistCounts.get(normLoose(a.name)) || 0,
        _score: scoreEntity(parsed, 'artist', {
          name: a.name,
          inLibraryCount: libraryArtistCounts.get(normLoose(a.name)) || 0,
        }),
      }))
      .filter((a) => a._score >= 40)
      .sort((a, b) => b._score - a._score
        || (Number(b.followers) || 0) - (Number(a.followers) || 0));
    /* Typed a name outright? Then that IS the answer, and everything else in
       the list is a substring accident. This runs before the weight test
       because it needs no popularity signal at all — which is the whole point:
       "dance gavin dance" resolves to one artist on the strength of the name
       matching, whether or not the provider can tell us how big either act is.

       Strict before loose. normLoose strips punctuation, so on its own it
       calls "Slayr" and "Slay-R" the same artist and then the weight tiebreak
       hands the page to whichever has more records — the wrong one, with the
       right one's songs mixed in. When something matches the query exactly as
       typed, that's the artist; the near-miss only wins if nothing does. */
    const qStrict = normStrict(parsed.artist || parsed.text);
    const qName = normLoose(parsed.artist || parsed.text);
    if (qName.length >= 2) {
      const strict = ranked.filter((a) => normStrict(a.name) === qStrict);
      if (strict.length) return strict.slice(0, MAX_ARTISTS);
      const exact = ranked.filter((a) => normLoose(a.name) === qName);
      if (exact.length) return exact.slice(0, MAX_ARTISTS);
    }

    /* Same name, different weight. When the top hit is an exact-name match
       with real audience data behind it, the query means THAT artist — a
       namesake with a fraction of the audience is a coincidence of
       spelling, not a candidate. Runner-ups survive only if they'd
       plausibly be meant too (within ~20% of the top act's weight).
     *
     * `weight` is not just followers any more. iTunes has no follower count
     * and hardcodes null, so the gate below was reading `!Number(null)` as
     * true on every single search and returning early — the cull hadn't run
     * at all since Spotify stopped being the default provider. Catalogue size
     * is the proxy that survives the switch: it's coarser than followers, but
     * it's the same shape of claim (a big act has more records than their
     * namesake) and it's a number both providers can produce. */
    const weight = (a) => Number(a.followers) || Number(a.releaseCount) || 0;
    const top = ranked[0];
    if (!top || top._score < 120 || !weight(top)) {
      return ranked.slice(0, MAX_ARTISTS);
    }
    const floor = weight(top) * 0.2;
    return ranked
      .filter((a) => a === top || weight(a) >= floor)
      .slice(0, MAX_ARTISTS);
  }, [spotify.artists, parsed, libraryArtistCounts]);

  /* ---- Artist portraits --------------------------------------------------
     Fetched AFTER the rows are on screen, deliberately.

     The iTunes musicArtist entity has no artwork field at all, so a photo has
     to be found elsewhere — the artist's Apple Music page, or Deezer
     corroborated against their release titles. Both are slow: an HTML document
     and a two-request verification respectively. Resolving them inside the
     search made every artist row wait on its own photograph, which is a poor
     trade when the row is perfectly readable without one.

     So rows arrive with a sleeve (always correct, just not a face) and the
     portrait swaps in when it lands. The provider caches by artist id, so this
     is one fetch per artist ever, not one per search. */
  const [artistPhotos, setArtistPhotos] = useState({});
  useEffect(() => {
    const a = api();
    if (!a?.artistPortrait && !a?.artistHeaderImage) return undefined;
    const want = artists.filter((x) => x.id && x.name && artistPhotos[x.id] === undefined);
    if (!want.length) return undefined;
    let cancelled = false;
    (async () => {
      const got = await Promise.all(want.map(async (x) => {
        if (a.artistPortrait) {
          const r = await a.artistPortrait(x.id, x.name, x.viewUrl).catch(() => null);
          if (r?.url) return r.url;
        }
        /* TheAudioDB last: name-searched AND user-contributed, so it can return
           both the wrong artist and, worse, a right artist with a stranger's
           photo. Only worth asking when nothing better exists. */
        if (a.artistHeaderImage) {
          const r = await a.artistHeaderImage(x.name, x.id).catch(() => null);
          if (r?.thumb) return r.thumb;
        }
        return null;
      }));
      if (cancelled) return;
      setArtistPhotos((m) => {
        const next = { ...m };
        want.forEach((x, i) => { next[x.id] = got[i]; });
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [artists, artistPhotos]);

  /* One rule for every place an artist gets a picture, so a row and the frame
     it opens can't disagree about what the artist looks like. */
  const artistImage = useCallback(
    (a) => artistPhotos[a?.id] || a?.image || a?.coverImage || '',
    [artistPhotos],
  );

  /* ---- Artist lock -------------------------------------------------------
     When the WHOLE query is exactly an artist's name, the search stops being
     a text match and becomes "show me this artist".

     Without this, searching "slayr" ranks by title relevance, so five
     unrelated one-track singles that happen to be *called* "Slayr" score 100
     and bury the actual artist's records, which mostly don't contain the word
     at all. Title relevance is the wrong question once we know the query is a
     name.

     Deliberately strict: the normalised query must EQUAL the artist's name.
     "keshi gabriel" doesn't lock, because there the album title genuinely is
     half the query and title matching is exactly what's wanted. */
  const artistLock = useMemo(() => {
    const q = normLoose(parsed.artist || parsed.text);
    if (!q || q.length < 2) return null;
    /* Several acts can share the exact name — for "keshi", Deezer returns
       a 1.6k-fan impostor next to the real one. The audience decides who
       the query means: lock onto the most-followed spelling match, never
       merely the first. */
    const weight = (a) => Number(a?.followers) || Number(a?.releaseCount) || 0;
    /* Strict first, for the same reason the list above prefers it: locking
       onto the loosely-matching namesake filters the whole result set to the
       wrong artist, which is worse than not locking at all. */
    const qs = normStrict(parsed.artist || parsed.text);
    let best = null;
    for (const a of artists) {
      if (normStrict(a.name) !== qs) continue;
      if (!best || weight(a) > weight(best)) best = a;
    }
    if (best) return best;
    for (const a of artists) {
      if (normLoose(a.name) !== q) continue;
      if (!best || weight(a) > weight(best)) best = a;
    }
    return best;
  }, [artists, parsed.artist, parsed.text]);

  /* ---- Implied artist ----------------------------------------------------
     "drake iceman" isn't an artist's name and isn't a bare title — it's an
     artist PLUS something, and the artist results already know who: an
     exact-name match sitting at the head or tail of the query. Naming that
     artist changes what the other sections owe you: records credited to
     them are answers; rows merely containing both words are noise wearing
     the query. Strict like artistLock: whole-name hits only, edge of the
     query only (head or tail), never a middle fragment or substring. */
  const impliedLock = useMemo(() => {
    if (parsed.artist || artistLock) return null;
    const words = String(parsed.text || '').trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) return null;
    for (const a of artists) {
      if (a._score < 120) continue;
      const n = normLoose(a.name);
      if (!n || n.length < 2) continue;
      for (let i = 1; i < words.length; i += 1) {
        if (normLoose(words.slice(0, i).join(' ')) === n) return a;   // "drake iceman"
        if (normLoose(words.slice(i).join(' ')) === n) return a;      // "iceman drake"
      }
    }
    return null;
  }, [artists, parsed.artist, parsed.text, artistLock]);

  /* One name for credit checks downstream — a real lock wins, an implied
     one fills in. */
  const effectiveLock = artistLock || impliedLock;

  /* Their real discography. /artists/{id}/albums is authoritative and
     complete; album SEARCH is neither, which is the whole problem above. */
  const [discog, setDiscog] = useState({});   // artistId → albums[]
  const [topTracks, setTopTracks] = useState({});  // artistId → tracks[]

  /* Warm BOTH halves of the artist frame, not just the releases.
   *
   * The discography was prefetched here and the songs weren't, so opening an
   * artist painted the Releases list instantly and then sat there for a beat
   * with an empty Top songs header above it — the two sections were racing
   * from different starting lines. Top songs is also the slower fetch of the
   * two (a ranking search plus a batched read of their releases), so it's the
   * one that most needs the head start.
   *
   * Fired on LOCK, which happens as soon as a search resolves to one artist —
   * typically several hundred milliseconds before the click that opens them. */
  const warmArtist = useCallback((id, name) => {
    if (!id) return;
    if (!discog[id] && api()?.spotifyArtistAlbums) {
      api().spotifyArtistAlbums(id)
        .then((albs) => setDiscog((m) => (m[id] ? m : { ...m, [id]: Array.isArray(albs) ? albs : [] })))
        .catch(() => {});
    }
    if (!topTracks[id] && api()?.spotifyArtistTopTracks) {
      api().spotifyArtistTopTracks(id, name)
        .then((t) => setTopTracks((m) => (m[id] ? m : { ...m, [id]: Array.isArray(t) ? t : [] })))
        .catch(() => {});
    }
  }, [discog, topTracks]);

  useEffect(() => {
    if (!artistLock?.id) return;
    warmArtist(artistLock.id, artistLock.name);
  }, [artistLock?.id, artistLock?.name, warmArtist]);

  /* Also warm when an artist frame opens (clicking an artist that isn't the
     locked one) — a cache hit if the lock already covered them. */
  useEffect(() => {
    if (frame?.kind !== 'artist') return;
    warmArtist(frame.artist.id, frame.artist.name);
  }, [frame?.kind, frame?.artist?.id, frame?.artist?.name, warmArtist]);

  const lockedDiscog = artistLock ? discog[artistLock.id] : null;

  /** Is this record actually credited to the locked (or implied) artist?
      Lead-credit EQUALITY, not substring: "Keshia Chanté" contains the
      letters of Keshi, and a loose includes() handed her catalogue the
      locked-artist bonus and a seat in his discography. The lead credit —
      who the record is BY, guests stripped — must be the artist itself. */
  const creditedToLock = useCallback((artistsStr) => {
    if (!effectiveLock) return true;
    /* creditMatchesArtist, not leadCredit — see creditMatchesArtist. This
       comparison used to decompose the credit, so "Sleeping With Sirens"
       reduced to "Sleeping", never matched its own name, and every album the
       band has took the -70 penalty below and fell out of the results. */
    return creditMatchesArtist(artistsStr, effectiveLock.name);
  }, [effectiveLock]);
  const albums = useMemo(() => {
    return spotify.albums
      /* Albums and EPs — two tracks and up. One-track releases are singles,
         and the Songs section below is already showing them; an album row for
         one drills into a tracklist of itself.
         An unknown count (0) still passes: see isSongSizedRelease. */
      .filter((a) => !isSongSizedRelease(a))
      .filter((a) => passesScopes(parsed, { artist: a.artists, album: a.name, year: a.releaseDate }))
      .map((a) => {
        let s = scoreEntity(parsed, 'album', a);
        /* Locked (typed the name outright or an edge of the query named
           one) but the discography hasn't landed yet — hold the line in
           the meantime so the wrong albums don't flash up and then
           reshuffle. Under an implied lock this is what buries the tribute
           singles: not credited to that artist, not competing. */
        if (effectiveLock) s += creditedToLock(a.artists) ? 60 : -70;
        return { ...a, _score: s };
      })
      .filter((a) => a._score >= 45)
      .sort((a, b) => b._score - a._score)
      .slice(0, MAX_ALBUMS);
  }, [spotify.albums, parsed, effectiveLock, creditedToLock]);

  /* Songs merge the two sources: Spotify supplies the metadata, Soulseek the
     file. Where both know a song, one row shows the good title AND the real
     file — which is the pairing the old two-source toggle made impossible. */
  const slskGroups = useMemo(() => groupSlskFiles(slsk.rows), [slsk.rows]);

  const songs = useMemo(() => {
    const byTitle = new Map();
    for (const g of slskGroups) byTitle.set(normLoose(g.title), g);

    /* ---- One list, not two -------------------------------------------
       A song you own and a song you don't are the same song in different
       states, so they belong in one list where each row offers the verb
       that fits it. Splitting them into "your library" and "to download"
       is what made a song you own appear twice — once as a row you can
       play, once as a row wearing an "In library" badge telling you not to
       press it. The badge was an apology for the duplicate. */
    const rows = new Map();   // dedupe key → row
    const keyOf = (title, artist) => `${normTitle(title)}|${normLoose(artist).slice(0, 24)}`;

    /* sameSongFamily — "is this the same recording, another pressing?" —
       now lives in instantSearch.js, because the certainty gate above needs
       the identical rule and two copies of a sameness test drift. */

    /* Library first, so an owned song claims its key and a catalogue row for
       the same recording merges into it rather than the other way round. */
    const ownedRows = [];   // visible owned titles, for duplicate suppression
    for (const t of library) {
      if (!passesScopes(parsed, { artist: t.artist, album: t.album, title: t.title })) continue;
      const s = scoreEntity(parsed, 'track', { title: t.title, artists: t.artist });
      if (s < 40) continue;
      ownedRows.push({ title: t.title, artist: t.artist });
      rows.set(keyOf(t.title, t.artist), {
        kind: 'song',
        id: `lib:${t.id}`,
        libTrack: t,
        spotify: null,
        slsk: null,
        owned: true,
        /* A mild lift, not a categorical one. You chose to own this, which
           is weak evidence you meant it — but not enough to bury the rest. */
        _score: s + 8,
      });
    }

    for (const r of spotify.songs) {
      if (!passesScopes(parsed, { artist: r.artists, album: r.album, title: r.title })) continue;
      const s = scoreEntity(parsed, 'track', r);
      if (s < 40) continue;
      const k = keyOf(r.title, r.artists);
      const existing = rows.get(k);
      if (existing) {
        // Same recording — attach the catalogue metadata to the owned row.
        existing.spotify = r;
        existing.slsk = existing.slsk || byTitle.get(normLoose(r.title)) || null;
        continue;
      }
      /* You already own this song — same base title, same lead credit.
         One row is the answer; a shelf of streaming duplicates isn't
         options, it's noise. */
      if (ownedRows.some((o) => sameSongFamily(o.title, o.artist, r.title, r.artists))) continue;
      rows.set(k, {
        kind: 'song',
        id: r.spotifyId,
        libTrack: null,
        spotify: r,
        slsk: byTitle.get(normLoose(r.title)) || null,
        owned: alreadyOwned?.(r.title, r.artists) || false,
        /* Same lock as the albums above: on a bare artist-name query, a song
           BY them beats a song merely CALLED their name. Demoted rather than
           dropped — a guest credit that didn't make it into the artists
           string is a real thing, and shouldn't vanish. */
        _score: s + ((artistLock || impliedLock) ? (creditedToLock(r.artists) ? 45 : -55) : 0),
      });
    }

    // Network-only finds: bootlegs, regional releases, things Spotify dropped.
    for (const g of slskGroups) {
      const k = keyOf(g.title, g.artist);
      if (rows.has(k)) continue;
      /* A copy you own makes network mirrors of it redundant too. */
      if (ownedRows.some((o) => sameSongFamily(o.title, o.artist, g.title, g.artist))) continue;
      const s = scoreEntity(parsed, 'track', { title: g.title, artists: g.artist });
      if (s < 48) continue;
      rows.set(k, {
        kind: 'song', id: `g:${g.key}`, libTrack: null, spotify: null, slsk: g,
        owned: false, networkOnly: true, _score: s - 6,
      });
    }

    let all = [...rows.values()];
    if (parsed.missingOnly) all = all.filter((x) => !x.owned);
    if (parsed.ownedOnly) all = all.filter((x) => x.owned);
    if (parsed.losslessOnly) all = all.filter((x) => x.slsk?.best?._q?.lossless);
    /* Pure relevance order. An older rule reserved slots for unowned rows
       and evicted yours to fill them — the opposite of what a search owes
       you once you own the thing: your copy IS the result, full stop. */
    all.sort((a, b) => b._score - a._score);

    /* `all` is handed back whole because the band pages through it — the cap
       only ever applied to what the merged Songs section shows. */
    return { list: all.slice(0, MAX_SONGS), all };
  }, [spotify.songs, slskGroups, library, parsed, alreadyOwned, artistLock, impliedLock, creditedToLock]);

  const folders = useMemo(() => (
    slsk.folders
      .map((f) => ({
        ...f,
        _q: slskQuality(f.ext, f.bitrate),
        _score: scoreEntity(parsed, 'folder', {
          name: f.displayName, lossless: slskQuality(f.ext, f.bitrate).lossless, slots: f.slots,
        }),
      }))
      .filter((f) => (parsed.losslessOnly ? f._q.lossless : true))
      .sort((a, b) => b._score - a._score)
      .slice(0, MAX_FOLDERS)
  ), [slsk.folders, parsed]);

  /* ---- Rung 2: the band --------------------------------------------------
     Confident library matches, pinned above the network at a fixed height.

     Pinning fixes something that isn't about preference: the library tier is
     synchronous and Spotify lands ~300ms later, so today the top row can
     change UNDER THE CURSOR mid-typing as network rows leapfrog owned ones
     on score. A pinned band keeps the top of the panel still while
     everything below it is still settling.

     Paged rather than scrolled, and paged by ROWS rather than tiles: songs
     are identified by text, not by cover art, so a horizontal strip of forty
     thumbnails for "you" trades vertical space for an unreadable row. */
  const band = useMemo(() => {
    if (frame || certain) return { rows: [], shown: [], total: 0, pages: 1, page: 0, from: 0, to: 0 };
    const rows = songs.all.filter((x) => x.owned && x._score >= CONFIDENT);
    const pages = Math.max(1, Math.ceil(rows.length / BAND));
    const page = Math.min(bandPage, pages - 1);
    return {
      rows,
      shown: rows.slice(page * BAND, page * BAND + BAND),
      total: rows.length,
      pages,
      page,
      from: rows.length ? page * BAND + 1 : 0,
      to: Math.min(rows.length, page * BAND + BAND),
    };
  }, [songs.all, frame, certain, bandPage]);

  const pageBand = useCallback((dir) => {
    setBandPage((p) => {
      const n = band.pages;
      if (n < 2) return 0;
      return ((Math.min(p, n - 1) + (dir > 0 ? 1 : n - 1)) % n);
    });
  }, [band.pages]);

  /* ------------------------------------------------ the linear item list */
  /* Keyboard navigation needs one flat, ordered array; sections are derived
     from it at render time by watching `group` change. Building it the other
     way round — sections owning their rows — is what makes arrow keys in a
     grouped list turn into a special case per group. */
  const items = useMemo(() => {
    if (frame?.kind === 'album') {
      const d = albumData[frame.album.albumId] || {};
      const tracks = d.tracks || [];
      const list = [];
      tracks.forEach((t, i) => {
        const key = trackKey(t, i);
        list.push({ key: `t:${key}`, group: 'Tracklist', kind: 'albumtrack', data: { track: t, index: i, tKey: key } });
        if (expandedTrack === key) {
          const srcs = albumProbes[frame.album.albumId]?.match?.sources?.get(key) || [];
          srcs.forEach((s, si) => {
            list.push({ key: `s:${key}:${s.id}`, group: 'Tracklist', kind: 'source', data: { source: s, track: t, index: si } });
          });
        }
      });
      return list;
    }

    if (frame?.kind === 'artist' && renderArtist) return []; // the embedded view has no rows
    if (frame?.kind === 'artist') {
      const d = artistData[frame.artist.id] || {};
      /* Merge search results (spotify.albums) with discography for consistency
         with Results frame. Search finds orphaned releases under duplicate
         artist entities; discography provides dates/track counts. Dedup by title. */
      const byId = new Map();
      const byName = new Map();
      const put = (a) => {
        /* releaseKey, NOT normTitle — see releaseKey. normTitle strips the
           parenthetical, so the two Coachella weekends and every deluxe edition
           collapsed into a single row here even after itunesClient started
           returning them separately. This dedupe was undoing that fix. */
        const nk = releaseKey(a.name);
        const dupe = byId.get(a.albumId) || (nk ? byName.get(nk) : null);
        if (dupe) {
          if (!dupe.releaseDate && a.releaseDate) dupe.releaseDate = a.releaseDate;
          if (!dupe.totalTracks && a.totalTracks) dupe.totalTracks = a.totalTracks;
          return;
        }
        const rec = { ...a };
        byId.set(rec.albumId, rec);
        if (nk) byName.set(nk, rec);
      };
      const discogAlbums = discog[frame.artist.id] || d.albums || [];
      for (const a of discogAlbums) put(a);
      /* Merge search results to catch releases the endpoint misses.
         Credit-checked, because spotify.albums holds the results for whatever
         is in the search box, which is not necessarily this artist — without
         the check, opening an artist from a two-name query staples the other
         act's records onto their page. Lead credit only: a guest feature is
         not their album. */
      /* Strict, so a same-name act's records can't be merged onto this page
         through the search-results side door. */
      for (const a of spotify.albums) {
        if (!creditMatchesArtist(a.artists, frame.artist.name)) continue;
        put(a);
      }
      /* This list was built and then dropped on the floor — every section
         below read `discogAlbums` instead, so the merge above did nothing and
         releases the artist-lookup missed stayed missing. */
      const mergedAlbums = [...byId.values()];
      const ex = artistTracks[frame.artist.id] || {};
      const list = [];

      /* No "In your library" section here, deliberately. Opening an artist is
         asking what they HAVE that you don't — songs you already own are the
         one thing you can't act on from this frame, so listing them costs
         rows and answers nothing. The count still appears in the hero, which
         is where a fact you can't click belongs. */

      /* Releases means RECORDS — albums and EPs. Nothing else.
         The singles bucket is deliberately dropped: a one-track single is a
         song wearing a cover, and a row that opens into a tracklist of one
         thing isn't a record you browse. Nothing is lost by dropping them,
         because expandArtist walks every release including singles, so their
         tracks are already sitting in Songs below — this only stops the same
         recording appearing twice in two different shapes.

         EPs stay with albums rather than going to Songs. An EP has its own
         identity and its own running order; opening one is a real thing to
         want, and flattening it would leave those tracks reachable only as
         loose songs. The line is "is this a record" — 2+ tracks qualifies. */
      /* Same floor the results frame uses: 1-track releases are singles.
         Applied BEFORE groupReleases so a single can't slip through by being
         labelled "album" by the provider. */
      /* Releases the expansion pass opened and found nothing in — see the
         `dead` note in expandArtist. Belt and braces now that itunesClient
         verifies collections before returning them; this still catches the
         case where a release has tracks but none of them are the artist's. */
      const dead = new Set(ex.dead || []);

      /* ---- Top songs, and only top songs ------------------------------
         This section used to try to be the artist's ENTIRE catalogue, built by
         opening every release one at a time. It was slow enough that it was
         still filling in while you read it — which is why it looked like "only
         a handful" of songs — and a complete song list is the wrong shape for
         this frame anyway: the releases below are how you find a deep cut, and
         a thousand-row list is how you fail to.

         Above the releases, deliberately. Someone opening an artist wants the
         song they half-remember first and the shelf second; making them scroll
         a discography to reach the hits inverts that. */
      const seenTop = new Set();
      /* Prefetched copy wins when it's there — it was started at lock time and
         has usually landed before the frame opens, whereas d.top starts on
         click. Same data either way. */
      (topTracks[frame.artist.id] || d.top || [])
        .filter((t) => {
          if (!t?.spotifyId) return false;
          /* Credited at all, not necessarily first.
             These rows are already restricted to the artist's own releases by
             the provider, so this is a backstop against a mismatched row
             rather than the primary filter — and insisting on LEAD credit here
             quietly deleted half of every collaborative album, since those
             list some tracks as "A & B" and others as "B & A". */
          if (!creditIncludesArtist(t.artists, frame.artist.name)) return false;
          /* Owned songs STAY. They were filtered out, which is why a
             well-covered artist showed four top songs and a thin one showed
             ten — the section silently became "top songs you're missing" and
             stopped being a recognisable list of their hits. The row already
             renders "In library" instead of a Get button, so an owned track
             costs nothing to show and its absence was the confusing part. */
          const k = normLoose(t.title);
          if (!k || seenTop.has(k)) return false;
          seenTop.add(k);
          return true;
        })
        .slice(0, ARTIST_TOP_SONGS)
        .forEach((t) => list.push({ key: `tt:${t.spotifyId}`, group: 'Top songs', kind: 'toptrack', data: t }));

      const g = groupReleases(
        mergedAlbums.filter((a) => !isSongSizedRelease(a) && !dead.has(a.albumId)),
      );
      const releases = [...g.albums, ...g.eps]
        .sort((x, y) => String(y.releaseDate || '').localeCompare(String(x.releaseDate || '')));
      releases.forEach((a) => list.push({ key: `a:${a.albumId}`, group: 'Releases', kind: 'release', data: a }));

      if (g.appearsOn.length) {
        g.appearsOn.slice(0, 4).forEach((a) => list.push({ key: `a:${a.albumId}`, group: 'Appears on', kind: 'release', data: a }));
      }
      return list;
    }

    /* Results frame. */
    const list = [];

    /* Empty box: recent searches are the list. Keyboard-reachable like any
       other row, so ↓ ↵ re-runs the last thing you looked for. */
    if (!hasQuery) {
      recents.forEach((q) => list.push({ key: `rc:${q}`, group: 'Recent', kind: 'recent', data: { q } }));
      return list;
    }

    /* Rung 1. Nothing was searched, so there is nothing else to show — just
       the song, and an explicit way to search anyway. The escape hatch is
       not optional: skipping the network SILENTLY, on the one occasion
       someone wanted a better copy of a song they own, is indistinguishable
       from the search being broken. */
    if (certain) {
      const row = songs.all.find((x) => x.libTrack?.id === certain.track.id);
      if (row) list.push({ key: `sg:${row.id}`, group: 'In your library', kind: 'song', data: row });
      list.push({ key: 'act:anyway', group: 'More', kind: 'action', data: { action: 'anyway' } });
      return list;
    }

    /* Rung 2, and it sits ABOVE artists and albums rather than above the
       network only. Something you already have is the most complete answer
       the panel can give — it needs no download and no round trip — so it
       outranks a catalogue entry for the same thing by definition. The whole
       band is claimed, not just the visible page, or page two's rows turn up
       a second time under Songs. */
    /* No "In your library" band at the top — results are the catalogue, and
       the songs you own appear in Songs with a Play verb instead. */
    const banded = new Set();

    artists.forEach((a) => list.push({ key: `ar:${a.id}`, group: 'Artists', kind: 'artist', data: a }));
    albums.forEach((a) => list.push({ key: `al:${a.albumId}`, group: 'Albums & EPs', kind: 'album', data: a }));

    songs.list.filter((s) => !banded.has(s.id)).forEach((s) => {
      list.push({ key: `sg:${s.id}`, group: 'Songs', kind: 'song', data: s });
      if (expandedSong === s.id) {
        const p = songProbes[s.id];
        (p?.sources || []).slice(0, 6).forEach((src, si) => {
          list.push({
            key: `ss:${s.id}:${src.id}`, group: 'Songs',
            kind: 'source', data: { source: src, index: si },
          });
        });
      }
    });
    /* The old "N more of yours" expander lived here. The band replaces it:
       same information, better shape — a pager that shows those rows rather
       than a row that promises them. */
    folders.forEach((f) => list.push({ key: `fd:${f.id}`, group: 'Album folders', kind: 'folder', data: f }));
    if (hasQuery) {
      /* The bridge back to the table.
         Playing from here is a one-shot: it acts and the palette closes. But
         some work needs the query to PERSIST — narrowing to eight tracks and
         retagging them one by one. That's a filtered table, not an overlay,
         and this is the row that hands the query over to one. */
      if (onFilterLibrary && band.total) {
        list.push({
          key: 'act:filter',
          group: 'More',
          kind: 'action',
          data: { action: 'filter', n: band.total },
        });
      }
      /* 'full' — "open the full results page" — is gone with the page it
         opened. The palette IS the results page now. */
      if (parsed.artist || parsed.album || parsed.year) {
        list.push({ key: 'act:wide', group: 'More', kind: 'action', data: { action: 'wide' } });
      }
    }
    return list;
  }, [frame, albumData, albumProbes, artistData, artistTracks, topTracks, discog, spotify.albums,
    expandedTrack, expandedSong, songProbes,
    artists, albums, songs, folders, hasQuery, parsed, certain, band, alreadyOwned, onFilterLibrary, recents, renderArtist]);

  /* Cursor never points past the end, and a re-search puts it back on top. */
  useEffect(() => { setCursor(0); setBandPage(0); }, [raw, stack.length]);

  /* Emptying the box means "start over", and a drilled frame has to go with it.
     The stack was only ever cleared on close, so clearing the query left the
     album tracklist sitting there over an empty search field with no crumb to
     back out of — the rows outlived the search that produced them, and the only
     way out was to close the panel entirely. */
  useEffect(() => {
    if (hasQuery || !stack.length) return;
    setStack([]);
    setExpandedTrack(null);
    setExpandedSong(null);
  }, [hasQuery, stack.length]);
  useEffect(() => {
    if (cursor >= items.length) setCursor(Math.max(0, items.length - 1));
  }, [items.length, cursor]);

  /* How many rows the Releases section is showing, shared with the hero so the
     header and the list can't quote different numbers. Derived from `items`
     rather than recomputed, because a second derivation is a second thing to
     keep in sync. */
  const artistReleaseCount = useMemo(
    () => (frame?.kind === 'artist' ? items.filter((i) => i.group === 'Releases').length : 0),
    [frame?.kind, items],
  );

  const current = items[cursor] || null;

  /* Keep the KEYBOARD-selected row in view — and ONLY the keyboard-selected
     one. This used to run on every cursor change, which made scrolling
     actively hostile to a mouse: the wheel drags rows past a stationary
     pointer, the pointer lands on a new row, that sets the cursor, and this
     scrolled the list back to where it started. The list fought the wheel.
     The arrow keys set nav.current; a pointer move clears it. */
  const nav = useRef(false);
  useEffect(() => {
    if (!nav.current) return;
    nav.current = false;
    const el = listRef.current?.querySelector('[data-cursor="1"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor, items.length]);

  /* ------------------------------------------------------- frame loading */
  /**
   * The tracklist. Catalogue only, so the album peek is on screen and usable
   * in ~300ms — a real tracklist with a working Get on every row, before any
   * peer has been contacted.
   */
  const loadAlbum = useCallback(async (album) => {
    const id = album.albumId;
    if (albumData[id]?.tracks) return;
    setAlbumData((m) => ({ ...m, [id]: { ...(m[id] || {}), busy: true } }));
    let tracks = [];
    let empty = false;
    let error = '';
    try {
      const res = await api()?.spotifyGetAlbumTracks?.(id);
      tracks = Array.isArray(res?.tracks) ? res.tracks : [];
      empty = !!res?.empty;
    } catch (e) {
      const msg = String(e?.message || e || '');
      error = /429|rate.?limit/i.test(msg)
        ? 'Spotify is rate-limiting requests right now, so this tracklist couldn\u2019t load. Try again in a minute.'
        : 'This tracklist couldn\u2019t load.';
    }
    /* Failures aren't cached as "loaded", so opening the record again retries. */
    setAlbumData((m) => ({ ...m, [id]: error ? { error, busy: false } : { tracks, empty, busy: false } }));
  }, [albumData]);

  /**
   * "Is there a better file for this record?"
   *
   * A separate, explicit step. In Best mode it fires as soon as the tracklist
   * lands; in Fast mode nothing happens until you press the button, so the
   * wait is always something you chose with a spinner you can see.
   */
  const probeAlbum = useCallback(async (album) => {
    const id = album.albumId;
    if (albumProbes[id]?.busy || albumProbes[id]?.done) return;
    setAlbumProbes((m) => ({ ...m, [id]: { busy: true } }));

    /* Scoped to THIS record. The original query was probably the artist's
       name, which returns their whole catalogue rather than one album's
       files — so the extra round trip buys a genuinely better answer. */
    let rows = [];
    let folders = [];
    try {
      const res = await api()?.soulseekSearch?.(`${album.artists} ${album.name}`.trim());
      if (res?.ok !== false) {
        rows = Array.isArray(res?.results) ? res.results : [];
        folders = Array.isArray(res?.albums) ? res.albums : [];
      }
    } catch { /* the coverage line reports the miss */ }

    // Anything the background pass already returned for this album counts too.
    const extra = slsk.rows.filter((r) => normLoose(r.folder || '').includes(normLoose(album.name)));
    const seen = new Set();
    const dedup = [...rows, ...extra].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));

    const tracks = albumDataRef.current[id]?.tracks || [];
    const match = matchFilesToTracks(tracks, dedup, { albumName: album.name, artistName: album.artists });
    setAlbumProbes((m) => ({ ...m, [id]: { busy: false, done: true, match, folders } }));
  }, [albumProbes, slsk.rows]);

  /**
   * The same question for one song. One keystroke, one scoped search, the
   * per-peer list expands underneath. This is the escape hatch that makes
   * Fast mode safe to default to: wanting lossless for one track costs a
   * deliberate second, not eight seconds on every search you ever run.
   */
  const probeSong = useCallback(async (song) => {
    const id = song.id;
    if (songProbes[id]?.busy || songProbes[id]?.done) return;
    setSongProbes((m) => ({ ...m, [id]: { busy: true, sources: [] } }));
    const title = song.spotify?.title || song.slsk?.title || '';
    const artist = song.spotify?.artists || song.slsk?.artist || '';
    let sources = [];
    try {
      const res = await api()?.soulseekSearch?.(`${artist} ${title}`.trim());
      if (res?.ok !== false) {
        const groups = groupSlskFiles(Array.isArray(res?.results) ? res.results : []);
        const want = normLoose(title);
        const hit = groups.find((g) => normLoose(g.title) === want)
          || groups.find((g) => normLoose(g.title).includes(want));
        sources = hit ? rankSources(hit.sources) : [];
      }
    } catch { /* empty list reads as "nobody has it" */ }
    setSongProbes((m) => ({ ...m, [id]: { busy: false, done: true, sources } }));
  }, [songProbes]);

  const loadArtist = useCallback(async (artist) => {
    const id = artist.id;
    if (artistData[id]?.albums) return;
    setArtistData((m) => ({ ...m, [id]: { ...(m[id] || {}), busy: true } }));

    /* Two arrivals, not one. Promise.all held the albums hostage to the
       slower top-tracks call, so the whole frame waited on its slowest half
       even though the two sections render independently. */
    const put = (patch) => setArtistData((m) => ({ ...m, [id]: { ...(m[id] || {}), ...patch } }));

    const albums = api()?.spotifyArtistAlbums
      ? api().spotifyArtistAlbums(id).then((a) => (Array.isArray(a) ? a : [])).catch(() => [])
      : Promise.resolve([]);
    const top = api()?.spotifyArtistTopTracks
      ? api().spotifyArtistTopTracks(id, artist.name).then((t) => (Array.isArray(t) ? t : [])).catch(() => [])
      : Promise.resolve([]);

    albums.then((a) => put({ albums: a }));
    top.then((t) => put({ top: t }));
    await Promise.allSettled([albums, top]);
    put({ busy: false });
  }, [artistData]);

  /**
   * Every song an artist has, by walking their releases.
   *
   * One request per release, so it's pooled at EXPAND_CONCURRENCY and capped
   * at EXPAND_MAX_RELEASES — a client-credentials token gets 429'd on a
   * rolling request count, and an artist with 200 entries would otherwise
   * fire 200 calls the moment you pressed →.
   *
   * Rows land as they arrive rather than all at the end, because the first
   * album's worth of songs is useful long before the last one's, and a list
   * that fills in reads as working where a spinner reads as stuck.
   */
  const expandArtist = useCallback(async (artist, releases) => {
    const id = artist.id;
    if (artistTracks[id]?.started) return;

    /* Compilations and appears_on are other people's records — they'd bury a
       discography in greatest-hits duplicates and one-off features. They keep
       their own section as releases you can open. */
    const want = (releases || []).filter((r) => {
      const g = String(r.albumGroup || '').toLowerCase();
      return g !== 'appears_on' && g !== 'compilation';
    }).slice(0, EXPAND_MAX_RELEASES);

    setArtistTracks((m) => ({
      ...m,
      [id]: { started: true, tracks: [], dead: [], done: 0, total: want.length },
    }));
    if (!want.length) return;

    /* Dedupe across releases: the same song on the album, on its own single,
       and on the deluxe edition is ONE song. */
    const seen = new Set();
    const keyOf = (t) => `${normTitle(t.title)}|${normLoose(leadCredit(t.artists)).slice(0, 24)}`;

    /* THEIR songs, not songs they turn up on.
     *
     * A soundtrack or a label compilation is filed under every contributing
     * artist, so walking it pulls in seventeen tracks by other people plus the
     * one that's actually theirs. albumGroup can't catch this — iTunes reports
     * these as ordinary albums credited to the artist you looked up — but the
     * TRACK credits can: on a record that's really theirs they lead every row,
     * and on a compilation they lead one. Lead credit, so "keshi" still matches
     * "keshi, Guest" but not "Someone Else (feat. keshi)". */
    const wantLead = normLoose(leadCredit(artist.name));
    const isTheirs = (t) => !wantLead || normLoose(leadCredit(t.artists)) === wantLead;

    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= want.length) return;
        const rel = want[i];
        let tracks = [];
        let empty = false;
        try {
          const res = await api()?.spotifyGetAlbumTracks?.(rel.albumId);
          tracks = Array.isArray(res?.tracks) ? res.tracks : [];
          empty = !!res?.empty;
        } catch { /* one release missing is not the whole list failing */ }
        const fresh = [];
        for (const t of tracks) {
          if (!t?.spotifyId) continue;
          if (!isTheirs(t)) continue;
          const k = keyOf(t);
          if (seen.has(k)) continue;
          seen.add(k);
          fresh.push({ ...t, _releaseDate: rel.releaseDate || '' });
        }
        /* Two ways a release earns a place on the hidden list, and both are
           things we can only learn by opening it:
             - the provider says it has no playable tracks at all (video
               albums, Apple-side collections);
             - it has tracks, but none of them are this artist's — which is
               what a soundtrack looks like from inside.
           Either way the row would open onto nothing worth reading, and a row
           that does that is worse than no row. */
        const dead = empty || (tracks.length > 0 && !tracks.some(isTheirs));
        setArtistTracks((m) => {
          const cur = m[id] || { started: true, tracks: [], done: 0, total: want.length, dead: [] };
          return {
            ...m,
            [id]: {
              ...cur,
              tracks: [...cur.tracks, ...fresh],
              dead: dead ? [...(cur.dead || []), rel.albumId] : (cur.dead || []),
              done: cur.done + 1,
            },
          };
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(EXPAND_CONCURRENCY, want.length) }, worker));
  }, [artistTracks]);

  useEffect(() => {
    if (frame?.kind === 'album') {
      loadAlbum(frame.album);
      /* Best mode goes looking straight away; Fast mode waits to be asked.
         Either way the tracklist above is already on screen and every row's
         Get already works — the probe only decides whether that Get pulls a
         peer's file or goes through YouTube. */
      if (quality === 'best') probeAlbum(frame.album);
    }
    if (frame?.kind === 'artist' && !renderArtist) loadArtist(frame.artist);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame?.kind, frame?.album?.albumId, frame?.artist?.id, quality]);

  /* ---- Discography trace -------------------------------------------------
     Turn on with  localStorage.setItem('studio:traceReleases', '1')  and
     reopen an artist. Off by default and costs nothing when off.

     Exists because "the album isn't on the artist page" has at least five
     possible causes and they are indistinguishable from the outside: the
     provider never returned it; the size floor ate it; classifyRelease filed
     it under singles or appearsOn; or it IS in Releases and something later
     hid it. The table names which one, per row, so the next fix is aimed at
     the stage that actually dropped it instead of the one that looks
     likeliest. */
  useEffect(() => {
    if (frame?.kind !== 'artist') return;
    let on = false;
    try { on = !!localStorage.getItem('studio:traceReleases'); } catch { /* ignore */ }
    if (!on) return;
    const albs = artistData[frame.artist.id]?.albums;
    if (!albs) return;

    const rowsOut = albs.map((a) => {
      const lone = isSongSizedRelease(a);
      const { bucket, reason } = classifyRelease(a);
      const shown = !lone && (bucket === 'albums' || bucket === 'eps');
      return {
        name: a.name,
        group: a.albumGroup || '(none)',
        tracks: a.totalTracks || 0,
        date: a.releaseDate || '(none)',
        bucket: lone ? 'DROPPED' : bucket,
        why: lone ? `song-sized: ${a.totalTracks} track(s)` : reason,
        inReleases: shown ? 'yes' : 'NO',
      };
    });

    /* eslint-disable no-console */
    console.groupCollapsed(
      `[releases] ${frame.artist.name} — ${albs.length} fetched, `
      + `${rowsOut.filter((r) => r.inReleases === 'yes').length} shown`,
    );
    console.table(rowsOut);
    const hidden = rowsOut.filter((r) => r.inReleases === 'NO');
    if (hidden.length) {
      console.log('Not in Releases:');
      console.table(hidden);
    }
    console.log('If a record you expect is absent from BOTH tables, the '
      + 'provider never returned it — nothing here can surface it.');
    console.groupEnd();
    /* eslint-enable no-console */
  }, [frame?.kind, frame?.artist?.id, frame?.artist?.name, artistData]);

  /* The expansion pass is gone from the default path.
   *
   * It opened every release the artist has — up to sixty requests — purely to
   * build a complete song list that the frame no longer shows. Top songs come
   * from one request, the releases below are the way to reach anything deeper,
   * and phantom releases are now filtered in itunesClient before they're ever
   * returned, which was the other thing this walk was buying.
   *
   * expandArtist itself is kept: `dead` still catches a release whose tracks
   * exist but belong to other people, and the hero's owned-count wants it.
   * Turn it on with  localStorage.setItem('studio:expandArtist', '1')  if you
   * want the old behaviour back while comparing. */
  useEffect(() => {
    if (frame?.kind !== 'artist') return;
    let on = false;
    try { on = !!localStorage.getItem('studio:expandArtist'); } catch { /* ignore */ }
    if (!on) return;
    const albs = discog[frame.artist.id] || artistData[frame.artist.id]?.albums;
    if (albs) expandArtist(frame.artist, albs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame?.kind, frame?.artist?.id, artistData, discog]);

  /* ------------------------------------------------------------ actions */
  const push = useCallback((f) => { setStack((s) => [...s, f]); setExpandedTrack(null); setExpandedSong(null); }, []);
  const pop = useCallback(() => {
    if (expandedTrack) { setExpandedTrack(null); return; }
    if (expandedSong) { setExpandedSong(null); return; }
    if (stack.length) { setStack((s) => s.slice(0, -1)); return; }
    onClose?.();
  }, [expandedTrack, expandedSong, stack.length, onClose]);

  /** Files found for a catalogue track — empty until the album is probed. */
  const sourcesFor = useCallback((tKey) => {
    if (frame?.kind !== 'album') return [];
    return albumProbes[frame.album.albumId]?.match?.sources?.get(tKey) || [];
  }, [frame, albumProbes]);

  /** The download key a row will report under, so its progress renders. */
  const dlKeyFor = useCallback((track, source) => (
    track?.spotifyId ? `s:${track.spotifyId}` : source ? `t:${source.id}` : ''
  ), []);

  /**
   * Get one track — which is now Save.
   *
   * A catalogue track with a Spotify ID is saved as a streamed library row
   * (nothing downloaded). A peer's file is only fetched when one was picked
   * explicitly, or when Spotify has no copy of the track at all.
   */
  const getTrack = useCallback((track, tKey, explicitSource) => {
    if (explicitSource) return onGetSlskFile?.(explicitSource);
    if (track?.spotifyId) return onGetSpotifyTrack?.(track);
    const src = sourcesFor(tKey)[0];
    if (src) return onGetSlskFile?.(src);
    return null;
  }, [sourcesFor, onGetSlskFile, onGetSpotifyTrack]);

  const getAlbumMissing = useCallback((album) => {
    const d = albumData[album.albumId];
    if (!d?.tracks) return;
    for (const [i, t] of d.tracks.entries()) {
      if (alreadyOwned?.(t.title, t.artists || album.artists)) continue;
      getTrack(t, trackKey(t, i));
    }
  }, [albumData, alreadyOwned, getTrack]);

  /* A song row's album, opened in the panel. Owned songs PLAY on click, so
     without this there was no way from search to the rest of a record you
     have one song from. Spotify's album ID when the row has one (the panel's
     tracklist, with Get for the rest); otherwise your own album page;
     otherwise a search for the record. */
  const openSongAlbum = useCallback((s) => {
    const sp = s?.spotify;
    if (sp?.albumId) {
      push({
        kind: 'album',
        album: {
          albumId: sp.albumId, name: sp.album || '', artists: sp.artists || '',
          albumArtUrl: sp.albumArtUrl || '', releaseDate: sp.releaseDate || '', totalTracks: null,
        },
      });
      return;
    }
    if (s?.libTrack && onOpenLibraryAlbum) { onOpenLibraryAlbum(s.libTrack); onClose?.(); return; }
    const album = s?.libTrack?.album || sp?.album || '';
    const artist = String(s?.libTrack?.artist || sp?.artists || '').split(',')[0].trim();
    if (album) { setStack([]); setRaw(`${artist} ${album}`.trim()); setForceFor(''); }
  }, [push, onOpenLibraryAlbum, onClose, setRaw]);

  const openSongArtist = useCallback((s) => {
    const name = String(s?.libTrack?.artist || s?.spotify?.artists || s?.slsk?.artist || '').split(',')[0].trim();
    if (!name) return;
    const data = { id: s?.spotify?.primaryArtistId || null, name };
    if (renderArtist) push({ kind: 'artist', artist: data });
    else if (onOpenArtist) { onOpenArtist(data); onClose?.(); }
  }, [push, renderArtist, onOpenArtist, onClose]);

  /** A CLICK — do the obvious thing for the row that was clicked. */
  const activate = useCallback((item, mod = false) => {
    if (!item) return;
    const { kind, data } = item;

    if (kind === 'recent') {
      setRaw(data.q);
      setForceFor('');
      inputRef.current?.focus();
      return;
    }
    if (hasQuery) rememberQuery(raw);

    if (kind === 'artist') {
      /* Artists open their full page — the Spotify-built one — rather than
         a cut-down frame inside the panel. The in-panel frame is only the
         fallback when there's no page to open to. */
      /* The artist view opens right here in the panel when StudioHome
         provides it; otherwise the full page; otherwise the old frame. */
      if (renderArtist) { push({ kind: 'artist', artist: data }); return; }
      if (onOpenArtist) { onOpenArtist(data); onClose?.(); return; }
      push({ kind: 'artist', artist: data });
      return;
    }
    if (kind === 'album' || kind === 'release') {
      if (mod && onOpenAlbum) { onOpenAlbum(data); onClose?.(); return; }
      push({ kind: 'album', album: data });
      return;
    }
    if (kind === 'song') {
      /* Owned rows play. This is the whole payoff of merging the lists:
         the same search that collects music also starts it. */
      if (data.owned) {
        if (data.libTrack) { onPlayTrack?.(data.libTrack); onClose?.(); }
        return;
      }
      /* Save through Spotify when the song is on it — streamed, nothing
         downloaded. A peer's file only when Spotify has no copy. */
      const probed = songProbes[data.id]?.sources?.[0];
      if (data.spotify) onGetSpotifyTrack?.(data.spotify);
      else if (probed) onGetSlskFile?.(probed);
      else if (data.slsk?.best) onGetSlskFile?.(data.slsk.best);
      return;
    }
    if (kind === 'folder') { onGetSlskAlbum?.(data); return; }
    if (kind === 'albumtrack') {
      const owned = alreadyOwned?.(data.track.title, data.track.artists || frame?.album?.artists);
      if (!owned) getTrack(data.track, data.tKey);
      return;
    }
    if (kind === 'toptrack') {
      const owned = alreadyOwned?.(data.title, data.artists);
      if (!owned) onGetSpotifyTrack?.(data);
      return;
    }
    if (kind === 'source') { onGetSlskFile?.(data.source); return; }
    if (kind === 'action') {
      if (data.action === 'wide') { setRaw(parsed.text || parsed.artist || parsed.album); }
      /* Override the certainty gate for THIS query. Scoped to the exact
         string so it lapses on its own as soon as you type something else. */
      if (data.action === 'anyway') { setForceFor(raw); }
      if (data.action === 'filter') {
        /* The raw string, scopes and all — libRows matches on plain text, so
           the plain text is what it gets. */
        onFilterLibrary?.(parsed.text || parsed.artist || parsed.album || raw.trim());
        onClose?.();
      }
    }
  }, [push, onOpenArtist, onOpenAlbum, onClose, onPlayTrack, onGetSlskFile, onGetSpotifyTrack,
    onGetSlskAlbum, alreadyOwned, getTrack, frame, parsed, raw, onFilterLibrary, hasQuery, rememberQuery, setRaw, renderArtist]);

  /** Right arrow — go deeper, when there is a deeper. */
  const drill = useCallback((item) => {
    if (!item) return;
    if (item.kind === 'artist') {
      if (renderArtist) { push({ kind: 'artist', artist: item.data }); return; }
      if (onOpenArtist) { onOpenArtist(item.data); onClose?.(); return; }
      push({ kind: 'artist', artist: item.data });
      return;
    }
    if (item.kind === 'album' || item.kind === 'release') { push({ kind: 'album', album: item.data }); return; }
    if (item.kind === 'albumtrack') {
      const id = frame?.album?.albumId;
      /* Asking about one track is asking about the record — probe it if it
         hasn't been, then open this track's sources when they arrive. */
      if (id && !albumProbes[id]?.done && !albumProbes[id]?.busy) probeAlbum(frame.album);
      setExpandedTrack(expandedTrack === item.data.tKey ? null : item.data.tKey);
      return;
    }
    if (item.kind === 'song') {
      /* The Fast-mode escape hatch: one keystroke asks the network about one
         song. The row shows a spinner and the peer list opens underneath —
         a wait you asked for, on a thing you pointed at. */
      /* Owned songs have no sources to look for — → opens their album. */
      if (item.data.owned) { openSongAlbum(item.data); return; }
      const id = item.data.id;
      if (expandedSong === id) { setExpandedSong(null); return; }
      setExpandedSong(id);
      probeSong(item.data);
    }
  }, [push, sourcesFor, expandedTrack, expandedSong, probeSong, probeAlbum, albumProbes, frame, onOpenArtist, onClose, renderArtist, openSongAlbum]);

  /* ---------------------------------------------------------- keyboard */
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); pop(); return; }
      /* The embedded artist view is a scrolling page with its own buttons:
         arrows scroll it and Enter presses what's focused. Only Esc (above)
         and ← walk back out. */
      if (frame?.kind === 'artist' && renderArtist) {
        const tag = e.target?.tagName;
        if (e.key === 'ArrowLeft' && tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); pop(); }
        return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); nav.current = true; setCursor((c) => Math.min(items.length - 1, c + 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); nav.current = true; setCursor((c) => Math.max(0, c - 1)); return; }
      if (e.key === 'ArrowRight') {
        // Only steal the arrow when the caret is at the end of the field,
        // otherwise moving through what you typed becomes impossible.
        const el = inputRef.current;
        if (el && document.activeElement === el && el.selectionStart < el.value.length) return;
        e.preventDefault();
        /* Inside the band, → turns the page. It cycles rather than stopping
           at the end because ← can't be paired with it here: the caret sits
           at the end of what you just typed, so ArrowLeft is spoken for by
           the input until you've walked back through the whole query. The
           chevrons in the section header go both ways for the mouse.

           Nothing is lost by taking the key: drill() on a song opens the
           "better?" peer probe, and that affordance is unowned-only — the
           band is entirely owned rows, so → had no target there. */
        if (!stack.length && current?.group === 'In your library' && band.pages > 1) { pageBand(1); return; }
        drill(current); return;
      }
      if (e.key === 'ArrowLeft') {
        const el = inputRef.current;
        if (el && document.activeElement === el && el.selectionStart > 0) return;
        if (!stack.length && !expandedTrack && !expandedSong) return;
        e.preventDefault(); pop(); return;
      }
      /* Brief, Instant search palette: Enter plays (acts on) the highlighted
         row — no palette anyone has used behaves otherwise — and filtering
         the library moves to Tab. The footer hints say so. */
      /* Enter ACTS — plays what you own, gets what you don't, opens an
         artist or record, runs an action row. It was wired to drill(), the
         → handler: an owned song on Enter started a Soulseek probe instead
         of playing, and "Search anyway" / "Filter your library" did nothing
         at all, because drill() has no branch for action rows. Ctrl/Cmd+Enter
         leaves for the full artist or album page, same as the ↗ button. */
      if (e.key === 'Enter') {
        if (!current) return;
        e.preventDefault();
        activate(current, e.ctrlKey || e.metaKey);
        return;
      }
      if (e.key === 'Tab') {
        // Shift+Tab on an artist row still accepts the name as a scope — the
        // fastest way to say "this name is the artist, search inside it".
        if (e.shiftKey && current?.kind === 'artist') {
          e.preventDefault();
          // Quoted when it has spaces — `artist:Lil Wayne` scoped to "Lil"
          // and searched for "Wayne".
          setRaw(`artist:${quoteScope(current.data.name)}`);
          inputRef.current?.focus();
          return;
        }
        if (!onFilterLibrary || !band.total) return;
        e.preventDefault();
        onFilterLibrary(parsed.text || parsed.artist || parsed.album || raw.trim());
        onClose?.();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, items.length, current, drill, activate, setRaw, pop, stack.length, expandedTrack, expandedSong, frame, renderArtist,
    band.pages, band.total, pageBand, onFilterLibrary, parsed, raw, onClose]);

  if (!open) return null;

  /* ============================================================ rendering */

  const busyNote = phase.spotify === 'busy' ? 'Searching' : '';

  /* What Enter will do to the highlighted row, for the footer. The old hint
     said "↵ play" over rows Enter would download, open or run. */
  const enterVerb = (() => {
    const c = current;
    if (!c) return null;
    switch (c.kind) {
      case 'recent': return 'search';
      case 'artist': case 'album': case 'release': return 'open';
      case 'song': return c.data.owned ? 'play' : 'get';
      case 'albumtrack': return alreadyOwned?.(c.data.track.title, c.data.track.artists || frame?.album?.artists) ? null : 'get';
      case 'toptrack': return alreadyOwned?.(c.data.title, c.data.artists) ? null : 'get';
      case 'folder': return 'get all';
      case 'source': return 'get this file';
      case 'action': return c.data.action === 'filter' ? 'filter' : 'search';
      default: return null;
    }
  })();
  const canOpenPage = current && (current.kind === 'album' || current.kind === 'release') && !!onOpenAlbum;

  const expandProgress = (() => {
    if (frame?.kind !== 'artist') return null;
    const ex = artistTracks[frame.artist.id];
    if (!ex?.started || !ex.total) return null;
    return { done: ex.done, total: ex.total, finished: ex.done >= ex.total };
  })();

  /* --- one results row per kind ------------------------------------------ */
  function renderItem(item, i) {
    const on = i === cursor;
    const common = {
      key: item.key,
      type: 'button',
      className: `isx-row isx-in${on ? ' is-on' : ''}`,
      /* Staggered entrance. Results arrive in three independent waves now
         (songs, artists, albums land separately), so without this a section
         materialises mid-read as a hard jump. A short rise with a per-row
         delay reads as the list assembling rather than snapping into place,
         and it gives the eye something to follow to the row it wants.

         The delay is capped and computed from position WITHIN the visible
         list: uncapped, row forty would wait most of a second to appear, and
         a stagger long enough to notice waiting is worse than none. */
      style: { animationDelay: `${Math.min(i, 12) * 22}ms` },
      'data-cursor': on ? '1' : undefined,
      /* mousemove, not mouseenter. A wheel scroll drags rows past a still
         pointer and fires mouseenter on each one, so the highlight strobes
         down the list as you scroll. mousemove only fires when the pointer
         itself actually moves. */
      onMouseMove: () => { nav.current = false; setCursor(i); },
      onClick: () => activate(item),
    };
    const chev = <Svg d={Ico.chevron} size={15} w={2.2} style={{ flexShrink: 0, color: 'rgba(var(--st-fg-rgb),0.3)' }} />;

    if (item.kind === 'recent') {
      const q = item.data.q;
      const sc = parseQuery(q);
      return (
        <button {...common}>
          <div className="isx-glyph is-small"><Svg d={Ico.clock} size={15} w={1.8} /></div>
          <div className="isx-mid isx-recent">
            {sc.scopes.map((x) => (
              <span key={`${x.key}:${x.value}`} className="isx-token is-static"><span className="k">{x.key}</span>{x.value}</span>
            ))}
            {splitScopes(q, true).text ? <span className="isx-nm">{splitScopes(q, true).text}</span> : null}
          </div>
          <span
            role="button" tabIndex={-1} className="isx-open"
            onClick={(e) => { e.stopPropagation(); saveRecents(recents.filter((x) => x !== q)); }}
            title="Remove from recent searches" aria-label={`Remove ${q} from recent searches`}
          >
            <Svg d={Ico.x} size={12} w={2.2} />
          </span>
        </button>
      );
    }

    if (item.kind === 'artist') {
      const a = item.data;
      return (
        <button {...common}>
          <div className="isx-art is-round" style={{ backgroundImage: artistImage(a) ? `url("${artistImage(a)}")` : 'none' }} />
          <div className="isx-mid">
            <div className="isx-nm">{a.name}</div>
            <div className="isx-meta">
              <span className="isx-mi">Artist</span>
              {a.genres?.length ? <span className="isx-mi">{a.genres.slice(0, 2).join(' · ')}</span> : null}
              {a.inLibraryCount ? <span className="isx-mi">{a.inLibraryCount} in your library</span> : null}
            </div>
          </div>
          <span className="isx-kb">Artist page</span>
          {chev}
        </button>
      );
    }

    if (item.kind === 'album' || item.kind === 'release') {
      const a = item.data;
      const year = String(a.releaseDate || '').slice(0, 4);
      return (
        <button {...common}>
          <div className="isx-art" style={{ backgroundImage: a.albumArtUrl ? `url("${a.albumArtUrl}")` : 'none' }} />
          <div className="isx-mid">
            <div className="isx-nm">{a.name}</div>
            <div className="isx-meta">
              <span className="isx-mi">{a.artists}</span>
              {year ? <span className="isx-mi">{year}</span> : null}
              {a.totalTracks ? <span className="isx-mi">{a.totalTracks} track{a.totalTracks === 1 ? '' : 's'}</span> : null}
            </div>
          </div>
          <span className="isx-kb">Tracklist</span>
          <span
            role="button" tabIndex={-1} className="isx-open"
            onClick={(e) => { e.stopPropagation(); activate(item, true); }}
            title="Go to the album page" aria-label="Go to the album page"
          >
            <Svg size={12} w={2.2}><path d="M7 17L17 7M9 7h8v8" /></Svg>
          </span>
          {chev}
        </button>
      );
    }

    if (item.kind === 'song') {
      const s = item.data;
      const title = s.libTrack?.title || s.spotify?.title || s.slsk?.title;
      const artist = s.libTrack?.artist || s.spotify?.artists || s.slsk?.artist || '';
      const album = s.libTrack?.album || s.spotify?.album || '';
      const art = (s.libTrack ? coverFor?.(s.libTrack) : null) || s.spotify?.albumArtUrl || s.libTrack?.coverArt;
      const probe = songProbes[s.id];
      const best = probe?.sources?.[0] || s.slsk?.best || null;
      const key = best ? `t:${best.id}` : `s:${s.spotify?.spotifyId}`;
      const isOpen = expandedSong === s.id;
      const dur = s.libTrack?.duration ? fmtSec(s.libTrack.duration) : fmtMs(s.spotify?.durationMs);
      return (
        <button {...common} onClick={(e) => { e.stopPropagation(); activate(item); }}>
          {art
            ? <div className={`isx-art${s.owned ? ' is-owned' : ''}`} style={{ backgroundImage: `url("${art}")` }} />
            : <div className="isx-glyph"><Svg d={Ico.note} size={17} w={1.8} /></div>}
          <div className="isx-mid">
            <div className="isx-nm">{title}</div>
            <div className="isx-meta">
              {best && !s.owned ? <QualityBadge q={best._q} /> : null}
              {artist ? (
                <span className="isx-mi is-link" role="link" tabIndex={-1}
                  title={`Open ${String(artist).split(',')[0]}`}
                  onClick={(e) => { e.stopPropagation(); openSongArtist(s); }}>{artist}</span>
              ) : null}
              {album ? (
                <span className="isx-mi is-link" role="link" tabIndex={-1}
                  title={`Open ${album}`}
                  onClick={(e) => { e.stopPropagation(); openSongAlbum(s); }}>{album}</span>
              ) : null}
              {s.networkOnly ? <span className="isx-mi">not on Spotify</span> : null}
              {probe?.busy ? <span className="isx-probing">looking for a better file…</span> : null}
              {probe?.done && !probe.sources.length ? <span className="isx-mi">nobody is sharing this</span> : null}
              {best && !s.owned && probe?.sources?.length ? <span className="isx-mi">{probe.sources.length} source{probe.sources.length === 1 ? '' : 's'}</span> : null}
              {best && !s.owned ? <SlotTag free={!!best.slots} /> : null}
            </div>
          </div>
          {dur ? <span className="isx-dur">{dur}</span> : null}
          {/* One verb per row, decided by the row's own state. Owned plays;
              not-owned gets. No badge explaining why a button is inert,
              because there is no inert button. */}
          {s.owned ? (
            <>
              {album ? (
                <span className={`isx-better${on ? ' is-shown' : ''}`} title="Open the album (→)"
                  onClick={(e) => { e.stopPropagation(); openSongAlbum(s); }}>
                  Album
                  <Svg d={Ico.chevron} size={11} w={2.4} />
                </span>
              ) : null}
              <span className="isx-playtag"><Svg d={Ico.play} size={11} w={0} /> Play</span>
            </>
          ) : (
            <>
              {!probe && !s.networkOnly ? (
                <span className={`isx-better${on ? ' is-shown' : ''}`}
                  title="Look for a lossless file (→)"
                  onClick={(e) => { e.stopPropagation(); setExpandedSong(s.id); probeSong(s); }}>
                  <Svg d={Ico.spark} size={13} w={2} />
                  better?
                </span>
              ) : null}
              {s.spotify ? (
                <PreviewButton pkey={`pv:${s.spotify.spotifyId || s.id}`} accent="var(--st-acc-rgb)"
                  track={{ title: s.spotify.title, artists: s.spotify.artists, durationMs: s.spotify.durationMs, explicit: s.spotify.explicit }} />
              ) : null}
              <GetBtn dl={dlState[key]} progress={dlProgress[key]} onGrab={() => activate(item)} />
            </>
          )}
          {isOpen ? <Svg d={Ico.chevron} size={13} w={2.2} style={{ flexShrink: 0, color: 'rgba(var(--st-acc-rgb),0.7)', transform: 'rotate(90deg)' }} /> : null}
        </button>
      );
    }

    if (item.kind === 'folder') {
      const f = item.data;
      const key = `ssa:${f.id}`;
      return (
        <button {...common}>
          <div className="isx-glyph"><Svg d={Ico.folder} size={17} w={1.8} /></div>
          <div className="isx-mid">
            <div className="isx-nm" style={{ fontSize: 12.5 }}>{f.displayName}</div>
            <div className="isx-meta">
              <QualityBadge q={f._q} />
              <span className="isx-mi">{f.trackCount} files</span>
              {f.totalSize ? <span className="isx-mi">{fmtSize(f.totalSize)}</span> : null}
              <SlotTag free={!!f.slots} />
            </div>
          </div>
          <GetBtn dl={dlState[key]} progress={dlProgress[key]} label="Save all"
            onGrab={() => onGetSlskAlbum?.(f)} width={100} />
        </button>
      );
    }

    if (item.kind === 'albumtrack') {
      const { track, tKey } = item.data;
      const srcs = sourcesFor(tKey);
      const best = srcs[0];
      const owned = alreadyOwned?.(track.title, track.artists || frame?.album?.artists);
      const key = dlKeyFor(track, best);
      const isOpen = expandedTrack === tKey;
      return (
        <button {...common} className={`isx-trk isx-in${on ? ' is-on' : ''}${isOpen ? ' is-open' : ''}`}>
          <span className="isx-n">{track.trackNumber || item.data.index + 1}</span>
          {/* Title over credits: the lead artist, then anyone featured. Each
              name opens that artist in the panel. */}
          <span className="isx-tcell">
            <span className={`isx-tt${owned ? ' is-have' : ''}`}>{track.title}</span>
            {(() => {
              const names = String(track.artists || frame?.album?.artists || '')
                .split(',').map((x) => x.trim()).filter(Boolean);
              if (!names.length) return null;
              const [lead, ...feat] = names;
              const link = (n) => (
                <span key={n} className="isx-tartist" role="link" tabIndex={-1} title={`Open ${n}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (renderArtist) push({ kind: 'artist', artist: { id: null, name: n } });
                    else if (onOpenArtist) { onOpenArtist({ name: n }); onClose?.(); }
                  }}>{n}</span>
              );
              return (
                <span className="isx-tcred">
                  {link(lead)}
                  {feat.length ? (
                    <>
                      <span className="isx-tfeat">feat.</span>
                      {feat.map((n, k) => (
                        <React.Fragment key={n}>{k ? ', ' : null}{link(n)}</React.Fragment>
                      ))}
                    </>
                  ) : null}
                </span>
              );
            })()}
          </span>
          <span className="isx-tq">
            {/* Unprobed shows nothing rather than "not on the network" — we
                haven't looked, and claiming otherwise is a lie the old copy
                told on every row of every album. */}
            {best ? <QualityBadge q={best._q} /> : null}
            {!best && albumProbes[frame?.album?.albumId]?.done && !owned
              ? <span className="isx-none">no file found</span> : null}
            {srcs.length > 1 ? <span className="isx-srcct">{srcs.length}</span> : null}
          </span>
          <span className="isx-dur">{fmtMs(track.durationMs)}</span>
          <span className="isx-ta">
            {owned
              ? <span className="isx-owned">In library</span>
              : (best || track.spotifyId)
                ? (
                  <>
                    <PreviewButton pkey={`pv:${track.spotifyId || tKey}`} accent="var(--st-acc-rgb)"
                      track={{ title: track.title, artists: track.artists || frame?.album?.artists || '', durationMs: track.durationMs, explicit: track.explicit }} />
                    <GetBtn dl={dlState[key]} progress={dlProgress[key]} label="Save"
                      onGrab={() => getTrack(track, tKey)} />
                  </>
                )
                : null}
          </span>
        </button>
      );
    }

    if (item.kind === 'source') {
      const s = item.data.source;
      const key = `t:${s.id}`;
      return (
        <div key={item.key} className="isx-srcwrap">
          <button type="button"
            className={`isx-src${on ? ' is-on' : ''}`}
            data-cursor={on ? '1' : undefined}
            onMouseMove={() => { nav.current = false; setCursor(i); }}
            onClick={() => onGetSlskFile?.(s)}>
            <span className="isx-pick" />
            <span className="isx-mid">
              <span className="isx-srchead">
                <QualityBadge q={s._q} />
                <b>{s.user}</b>
                <SlotTag free={!!s.slots} />
                <span className="isx-mi">{fmtSize(s.size)}</span>
                {fmtSpeed(s.speed) ? <span className="isx-mi">{fmtSpeed(s.speed)}</span> : null}
                {item.data.index === 0 ? <span className="isx-default">Default</span> : null}
              </span>
              <span className="isx-path">{s.filePath}</span>
            </span>
            <GetBtn dl={dlState[key]} progress={dlProgress[key]} onGrab={() => onGetSlskFile?.(s)} />
          </button>
        </div>
      );
    }

    if (item.kind === 'toptrack') {
      const t = item.data;
      const owned = alreadyOwned?.(t.title, t.artists);
      const key = `s:${t.spotifyId}`;
      return (
        <button {...common}>
          <div className="isx-art" style={{ backgroundImage: t.albumArtUrl ? `url("${t.albumArtUrl}")` : 'none' }} />
          <div className="isx-mid">
            <div className="isx-nm">{t.title}</div>
            <div className="isx-meta"><span className="isx-mi">{t.album}</span></div>
          </div>
          <span className="isx-dur">{fmtMs(t.durationMs)}</span>
          {owned
            ? <span className="isx-owned">In library</span>
            : <GetBtn dl={dlState[key]} progress={dlProgress[key]} onGrab={() => onGetSpotifyTrack?.(t)} />}
        </button>
      );
    }

    if (item.kind === 'action') {
      const act = item.data.action;
      if (act === 'filter') {
        return (
          <button {...common}>
            <div className="isx-glyph"><Svg d={Ico.note} size={16} w={1.8} /></div>
            <div className="isx-mid">
              <div className="isx-nm">Filter your library to “{(parsed.text || raw).trim()}”</div>
              <div className="isx-meta">
                <span className="isx-mi">
                  {item.data.n} {item.data.n === 1 ? 'match' : 'matches'} · stays filtered so you can work the rows
                </span>
              </div>
            </div>
            <span className="isx-kb">Filter list</span>
          </button>
        );
      }
      if (act === 'anyway') {
        return (
          <button {...common}>
            <div className="isx-glyph"><Svg d={Ico.search} size={16} w={2} /></div>
            <div className="isx-mid">
              <div className="isx-nm">Search anyway for “{raw.trim()}”</div>
              <div className="isx-meta">
                <span className="isx-mi">other pressings, live takes, a lossless rip</span>
              </div>
            </div>
            <span className="isx-kb">↵</span>
          </button>
        );
      }
      /* Only 'wide' reaches here now. The other half of this branch offered
         "open full results", which pointed at the Find page — gone, along
         with the ⌘↵ badge that advertised it. */
      return (
        <button {...common}>
          <div className="isx-glyph"><Svg d={Ico.search} size={16} w={2} /></div>
          <div className="isx-mid">
            <div className="isx-nm">Drop the filters and search everything</div>
            <div className="isx-meta">
              <span className="isx-mi">Removes every scope you set</span>
            </div>
          </div>
        </button>
      );
    }

    return null;
  }

  /* --- section-aware list ------------------------------------------------ */
  function renderList() {
    const out = [];
    let last = null;
    items.forEach((item, i) => {
      if (item.group !== last) {
        last = item.group;
        const count = items.filter((x) => x.group === item.group).length;
        /* The Songs header carries the ownership split, which is the one fact
           the merged list can no longer say by having two sections. */
        const ownedIn = item.group === 'Songs'
          ? items.filter((x) => x.group === 'Songs' && x.kind === 'song' && x.data.owned).length : 0;
        /* The band's own count would read as "3" — the page size, not the
           answer — so it's suppressed in favour of the range below. */
        const isBand = item.group === 'In your library';
        out.push(
          <div className="isx-sec isx-in" key={`sec:${item.group}`}>
            {item.group}
            {item.group === 'Recent' ? (
              <button type="button" className="isx-secbtn" onClick={() => saveRecents([])}>Clear</button>
            ) : null}
            {count > 2 && !isBand && item.group !== 'Recent' ? <span className="ct">{count}</span> : null}
            {isBand && certain
              ? <span className="isx-secnote">you already have this — didn’t search</span> : null}
            {/* A result count, not a pager: the prev/next chevrons and the
                "1–3 of 6" counter are gone (brief). */}
            {isBand && band.total > BAND ? (
              <span className="isx-secnote">{band.total} in your library</span>
            ) : null}
            {item.group === 'Songs' && ownedIn
              ? <span className="isx-secnote">{ownedIn} already yours</span> : null}
            {/* A catalogue walk arrives release by release. Saying how far in
                it is turns a list that keeps growing from something that
                looks unstable into something that looks like progress. */}
            {item.group === 'Top songs' && frame?.kind === 'artist' && expandProgress && !expandProgress.finished
              ? (
                <span className="isx-secnote">
                  <span className="isx-spin" style={{ marginRight: 6, verticalAlign: -1 }} />
                  {expandProgress.done} of {expandProgress.total} releases
                </span>
              ) : null}
            {/* Say why the list is what it is. A locked search silently
                swapping "albums matching your text" for "this artist's
                records" would be the right answer arrived at invisibly. */}
            {item.group === 'Albums & EPs' && artistLock
              ? <span className="isx-secnote">{artistLock.name}’s releases{lockedDiscog ? '' : ' — loading'}</span> : null}
            {item.group === 'Tracklist'
              ? <span className="isx-secnote">from the album record, not the filenames</span> : null}
          </div>,
        );
      }
      out.push(renderItem(item, i));
    });

    /* Placeholders for a section still in flight.
       Only while the provider is genuinely working and only when the section
       has nothing yet — a skeleton under real rows would suggest more is
       coming when the list may already be complete. */
    if (hasQuery && phase.spotify === 'busy' && !frame) {
      const pending = [];
      if (!artists.length) pending.push(['Artists', 1]);
      if (!albums.length) pending.push(['Albums & EPs', 3]);
      if (!songs.list.length) pending.push(['Songs', 4]);
      for (const [label, n] of pending) {
        out.push(
          <div className="isx-sec isx-in" key={`skelsec:${label}`}><span>{label}</span></div>,
        );
        for (let k = 0; k < n; k += 1) {
          out.push(
            <div className="isx-skel" key={`skel:${label}:${k}`} aria-hidden="true">
              <div className="sk-art" />
              <div className="sk-lines"><div className="sk-a" /><div className="sk-b" /></div>
            </div>,
          );
        }
      }
    }
    return out;
  }

  /* --- the header of a drilled frame ------------------------------------- */
  function renderHero() {
    if (frame?.kind === 'artist' && renderArtist) return null; // the view has its own hero
    if (frame?.kind === 'album') {
      const a = frame.album;
      const d = albumData[a.albumId] || {};
      const probe = albumProbes[a.albumId] || {};
      const cov = probe.match?.coverage;
      /* The provider answered and there is nothing in this release. Falling
         back to the record's own trackCount here is what produced "Get the 27
         you're missing" above an empty tracklist: the count came off the
         collection row, the tracks never existed. A count we can't show rows
         for is not a count worth printing. */
      const noTracks = Array.isArray(d.tracks) && d.tracks.length === 0 && !d.busy;
      const total = noTracks ? 0 : (d.tracks?.length || a.totalTracks || 0);
      const ownedCount = (d.tracks || []).filter((t) => alreadyOwned?.(t.title, t.artists || a.artists)).length;
      const missing = total - ownedCount;
      const year = String(a.releaseDate || '').slice(0, 4);
      const unmatched = probe.match?.unmatched?.length || 0;
      return (
        <div className="isx-peek">
          <div className="isx-peekhero">
            <div className="isx-peekart" style={{ backgroundImage: a.albumArtUrl ? `url("${a.albumArtUrl}")` : 'none' }} />
            <div className="isx-mid">
              <div className="isx-eyebrow">Album{year ? ` · ${year}` : ''}</div>
              <h3 className="isx-peektitle">{a.name}</h3>
              <div className="isx-peeksub">
                {a.artists}{total ? ` · ${total} tracks` : ''}{ownedCount ? ` · ${ownedCount} of ${total} in your library` : ''}
              </div>
              <div className="isx-peekacts">
                {noTracks ? (
                  <span className="isx-owned" style={{ fontSize: 12, opacity: 0.72 }}>
                    This release has no playable tracks — it&apos;s a video or
                    compilation entry the catalogue lists without audio.
                  </span>
                ) : missing > 0 ? (
                  <GetBtn big solid width={190} label={`Get the ${missing} you're missing`} onGrab={() => getAlbumMissing(a)} />
                ) : total ? (
                  <span className="isx-owned" style={{ fontSize: 12 }}>Every track is in your library</span>
                ) : null}
                {onOpenAlbum ? <button type="button" className="isx-ghost is-big" onClick={() => { onOpenAlbum(a); onClose?.(); }}>Open album page</button> : null}
              </div>
            </div>
          </div>
          {/* Three states, and the resting one is NOT a spinner.
              Unprobed, this says what you already have — a working tracklist —
              and offers the upgrade as a thing you can choose. The old version
              opened on "Matching files against the tracklist…", which made a
              screen that was already finished look like it wasn't. */}
          {probe.busy ? (
            <div className="isx-cov is-busy">
              <span className="isx-spin" />
              Asking the network about this record — usually a few seconds.
            </div>
          ) : cov ? (
            <div className="isx-cov">
              <Svg d={Ico.check} size={14} w={2.2} style={{ color: cov.have === cov.total ? 'rgb(140,220,160)' : 'rgba(240,190,120,0.9)', flexShrink: 0 }} />
              <span>{describeCoverage(cov, probe.folders?.length || 0)}</span>
              {unmatched ? (
                <span className="isx-unmatched">
                  {unmatched} file{unmatched === 1 ? '' : 's'} didn’t match any track
                </span>
              ) : null}
            </div>
          ) : d.tracks?.length ? (
            <div className="isx-cov">
              <span>
                Downloads use YouTube — instant, and good enough for most listening.
              </span>
              <button type="button" className="isx-ghost" style={{ marginLeft: 'auto' }}
                onClick={() => probeAlbum(a)}>
                Look for lossless files
              </button>
            </div>
          ) : null}
        </div>
      );
    }

    if (frame?.kind === 'artist') {
      const a = frame.artist;
      const d = artistData[a.id] || {};
      const ex = artistTracks[a.id] || {};
      /* The number of ROWS below, not the number of records the provider
         mentioned. The raw discography count includes every single, every
         one-track release and everything filed under Appears on — so the hero
         read "97 releases" over a list of 22 and looked like 75 were missing,
         when in fact the list was showing exactly what it means to show. Two
         numbers that disagree are a bug report waiting to happen even when
         both are correct. */
      const total = artistReleaseCount;
      /* The frame's whole question, answered in the header. "12 of 187 in
         your library" is the same fact the removed section spelled out over
         twelve rows you couldn't press. */
      const known = (ex.tracks || []).length;
      const owned = (ex.tracks || []).filter((t) => alreadyOwned?.(t.title, t.artists)).length;
      const missing = known - owned;
      /* Only claimed when the expansion pass actually ran. It's opt-in now, so
         the default frame says how many releases there are and stops — a count
         of songs "not yours yet" that was really a count of songs fetched so
         far was worse than no count, because it kept changing while you read
         it and settled on a number that meant nothing. */
      const songLine = known ? ` · ${missing} of ${known} song${known === 1 ? '' : 's'} not yours yet` : '';
      return (
        <div className="isx-peek">
          <div className="isx-peekhero">
            <div className="isx-peekart is-round" style={{ backgroundImage: artistImage(a) ? `url("${artistImage(a)}")` : 'none' }} />
            <div className="isx-mid">
              <div className="isx-eyebrow">Artist</div>
              <h3 className="isx-peektitle">{a.name}</h3>
              <div className="isx-peeksub">
                {total ? `${total} release${total === 1 ? '' : 's'}` : d.busy ? 'Loading discography…' : 'No releases found'}
                {songLine}
                {a.genres?.length ? ` · ${a.genres.slice(0, 2).join(', ')}` : ''}
              </div>
            </div>
          </div>
        </div>
      );
    }
    return null;
  }

  /* Embedded artist view. Everything it does stays in the panel — another
     artist or a release pushes a frame (so the crumb and Esc walk back), a
     search replaces the stack — except the explicit "Open full page". */
  const embedArtist = frame?.kind === 'artist' && !!renderArtist;
  const artistNav = {
    openArtist: (a) => push({ kind: 'artist', artist: { id: a.id || null, name: a.name, image: a.image || null } }),
    openAlbum: (r) => push({
      kind: 'album',
      album: {
        albumId: r.albumId, name: r.name, artists: r.artists || frame?.artist?.name || '',
        albumArtUrl: r.albumArtUrl || '', releaseDate: r.releaseDate || '', totalTracks: r.totalTracks || null,
        albumType: r.type || r.group || '',
      },
    }),
    search: (q) => { setStack([]); setRaw(q); setForceFor(''); setTimeout(() => inputRef.current?.focus(), 0); },
    openPage: onOpenArtist ? () => { onOpenArtist(frame.artist); onClose?.(); } : null,
    close: onClose,
  };

  const crumb = stack.length ? (
    <div className="isx-crumb">
      <button type="button" className="isx-back" onClick={pop} title="Back (Esc)" aria-label="Back">
        <Svg d={Ico.back} size={13} w={2.4} />
      </button>
      <div className="isx-path-bc">
        {stack.map((f, i) => {
          const label = f.kind === 'album' ? f.album.name : f.artist.name;
          return (
            <React.Fragment key={i}>
              {i > 0 ? <span className="sl">/</span> : null}
              {i === stack.length - 1
                ? <b>{label}</b>
                /* Clickable. A trail you can only walk back one Esc at a
                   time isn't a trail, and Esc is the only way a mouse had. */
                : (
                  <button type="button" className="isx-crumb-b"
                    onClick={() => setStack((st) => st.slice(0, i + 1))}
                    title={`Back to ${label}`}>{label}</button>
                )}
            </React.Fragment>
          );
        })}
      </div>
      <div style={{ flex: 1 }} />
      <span className="isx-esc"><kbd>esc</kbd>back to results</span>
    </div>
  ) : null;

  /* Hints describe MOVEMENT and the one submit key. No "↵ play" or
     "↵ get" — Enter doesn't do those any more, and a hint for a binding
     that doesn't exist is worse than no hint. Acting on a row is a click,
     which needs no legend. */
  const filterHint = onFilterLibrary && band.total ? [['tab', 'filter the list']] : [];

  const enterHint = enterVerb ? [['↵', enterVerb]] : [];
  const pageHint = canOpenPage ? [['ctrl ↵', 'open page']] : [];
  const albumHint = current?.kind === 'song' && current.data?.owned ? [['→', 'album']] : [];
  const footHints = embedArtist
    ? [['esc', 'back']]
    : frame?.kind === 'album'
    ? [['↑↓', 'move'], ...enterHint, ['→', 'sources'], ['esc', 'back']]
    : frame?.kind === 'artist'
      ? [['↑↓', 'move'], ...enterHint, ...pageHint, ['esc', 'back']]
      : items.length
        ? [['↑↓', 'move'], ...enterHint, ...albumHint, ...pageHint, ...filterHint]
        : [];

  return (
    <>
      <style>{STYLES}</style>
      <div className="isx-scrim" onClick={onClose} />
      <div className={`isx-panel${stack.length ? ' is-wide' : ''}${embedArtist ? ' is-artist' : ''}`} role="dialog" aria-label="Search">
        {crumb}

        {!stack.length ? (
          <div className="isx-top">
            {busyNote
              ? <span className="isx-spin isx-topspin" aria-label="Searching" />
              : <Svg d={Ico.search} size={17} w={2.1} style={{ flexShrink: 0, color: 'rgba(var(--st-fg-rgb), 0.55)' }} />}
            <div className="isx-field" onClick={() => inputRef.current?.focus()}>
              {chips.map((tok, i) => {
                const sc = parseQuery(tok).scopes[0];
                if (!sc) return null;
                return (
                  <span key={`${tok}:${i}`} className="isx-token">
                    <span className="k">{sc.key}</span>{sc.value}
                    <button type="button" className="isx-tokx" title="Remove this filter" aria-label={`Remove ${sc.key} ${sc.value}`}
                      onClick={(e) => { e.stopPropagation(); removeChip(i); inputRef.current?.focus(); }}>
                      <Svg d={Ico.x} size={10} w={2.6} />
                    </button>
                  </span>
                );
              })}
              <input
                ref={inputRef}
                className="isx-input"
                value={text}
                onChange={(e) => onTextChange(e.target.value)}
                onKeyDown={(e) => {
                  /* Backspace at the very start pulls the last chip back into
                     the field as text, so it can be edited rather than only
                     deleted. */
                  const el = e.currentTarget;
                  if (e.key === 'Backspace' && chips.length && el.selectionStart === 0 && el.selectionEnd === 0) {
                    e.preventDefault();
                    const last = chips[chips.length - 1];
                    setChips((c) => c.slice(0, -1));
                    setText(`${last}${text ? ` ${text}` : ''}`);
                  }
                }}
                placeholder={chips.length ? 'Add words…' : 'Search songs, albums, artists'}
                spellCheck={false}
                aria-label="Search"
              />
            </div>
            {/* Never skip the network silently — the chip is what separates
                "we decided not to search" from "the search is broken". */}
            {certain ? (
              <span className="isx-have"><Svg d={Ico.check} size={13} w={2.6} />You have this</span>
            ) : null}
            {raw.trim() ? (
              <button type="button" className="isx-clear" title="Clear" aria-label="Clear search"
                onClick={() => { setChips([]); setText(''); setForceFor(''); inputRef.current?.focus(); }}>
                <Svg d={Ico.x} size={12} w={2.4} />
              </button>
            ) : null}
            <button type="button" className="isx-escbtn" onClick={onClose} title="Close (Esc)" aria-label="Close search">esc</button>
          </div>
        ) : null}

        {renderHero()}

        {embedArtist ? (
          <div className="isx-artistbody">
            {renderArtist(
              { name: frame.artist.name, spotifyId: frame.artist.id, image: artistImage(frame.artist) },
              artistNav,
            )}
          </div>
        ) : (
        <div className="isx-body" ref={listRef}>
          {!hasQuery && !stack.length ? (
            <div className="isx-start">
              {items.length ? renderList() : (
                <div className="isx-intro">
                  <div className="isx-emptytitle">Search your library and the catalogue</div>
                  <div className="isx-emptyhint">Songs you own play straight away. Everything else can be fetched from here.</div>
                </div>
              )}
              <div className="isx-sec">Filters</div>
              <div className="isx-filters">
                {FILTER_HINTS.map(([tok, desc]) => (
                  <button key={tok} type="button" className="isx-filter"
                    onClick={() => {
                      if (tok.endsWith(':')) {
                        // A prefix: drop it in and wait for the value.
                        setText((t) => `${t && !/\s$/.test(t) ? `${t} ` : t}${tok}`);
                      } else {
                        setChips((c) => mergeChips(c, [tok]));
                      }
                      inputRef.current?.focus();
                    }}>
                    <span className="isx-filter-k">{tok}</span>
                    <span className="isx-filter-d">{desc}</span>
                  </button>
                ))}
              </div>
              <div className="isx-tip">
                {quality === 'best'
                  ? 'Best is on: Soulseek is checked in the background and rows upgrade to lossless when it answers.'
                  : 'Press → on any song to look for a lossless copy of just that track.'}
              </div>
            </div>
          ) : items.length ? (
            renderList()
          ) : phase.spotify === 'busy' || albumData[frame?.album?.albumId]?.busy || artistData[frame?.artist?.id]?.busy ? (
            <div className="isx-empty"><div className="isx-emptyhint">Looking…</div></div>
          ) : frame?.kind === 'album' ? (
            <div className="isx-empty">
              <div className="isx-emptytitle">
                {albumData[frame.album.albumId]?.error ? 'Couldn\u2019t load this release' : 'No tracks listed for this release'}
              </div>
              <div className="isx-emptyhint">{albumData[frame.album.albumId]?.error || 'Spotify returned an empty tracklist.'}</div>
              {albumData[frame.album.albumId]?.error ? (
                <button type="button" className="isx-ghost" style={{ marginTop: 12 }}
                  onClick={() => { setAlbumData((m) => { const n = { ...m }; delete n[frame.album.albumId]; return n; }); loadAlbum(frame.album); }}>
                  Try again
                </button>
              ) : null}
            </div>
          ) : (
            <div className="isx-empty">
              <div className="isx-emptytitle">{phase.spotify === 'error' && errorNote ? 'Search didn\u2019t go through' : <>Nothing matched “{parsed.text || parsed.artist || parsed.album}”.</>}</div>
              <div className="isx-emptyhint">
                {errorNote || 'Try fewer words — peers match on the whole phrase, so a shorter query usually returns more.'}
              </div>
            </div>
          )}
        </div>
        )}

        <div className="isx-foot">
          {footHints.map(([k, label]) => (
            <span key={k}><kbd>{k}</kbd>{label}</span>
          ))}
          <div style={{ flex: 1 }} />
          {phase.slsk === 'busy' ? <span className="isx-footnote"><span className="isx-spin" />checking Soulseek</span> : null}
          {/* The one global setting worth having in reach. Fast is the default
              and the honest one: Spotify's catalogue, YouTube's files, no
              waiting. Best is for people who'd rather wait than re-encode. */}
          <span className="isx-footnote" style={{ marginRight: 6 }}>Quality</span>
          <div className="isx-qtoggle" role="radiogroup" aria-label="Download quality">
            <button type="button" role="radio" aria-checked={quality === 'fast'}
              className={quality === 'fast' ? 'on' : ''}
              title="Spotify catalogue, downloaded through YouTube. Instant."
              onClick={() => setQualityMode('fast')}>Fast</button>
            <button type="button" role="radio" aria-checked={quality === 'best'}
              className={quality === 'best' ? 'on' : ''}
              title="Also checks Soulseek for lossless. Slower, better files."
              onClick={() => setQualityMode('best')}>Best</button>
          </div>
        </div>
      </div>
    </>
  );
}

/* =========================================================================
 *  Styles
 *
 *  Every colour resolves from the four variables StudioHome puts on its root
 *  (--st-bg-rgb / --st-fg-rgb / --st-sub-rgb / --st-acc-rgb), so the palette
 *  takes the cover's accent and the current theme without being told.
 * ========================================================================= */
const STYLES = `
.isx-scrim { position: fixed; inset: 0; z-index: 90; background: rgba(0,0,0,0.6);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); animation: isxFade 0.16s ease both; }
.isx-panel { position: fixed; top: 84px; left: 50%; transform: translateX(-50%); z-index: 91;
  width: min(720px, calc(100vw - 80px)); border-radius: 18px; overflow: hidden;
  border: 1px solid rgba(var(--st-fg-rgb), 0.13); background: rgba(15,15,17,0.975);
  box-shadow: 0 40px 100px rgba(0,0,0,0.75); display: flex; flex-direction: column;
  max-height: calc(100vh - 180px);
  transition: width 0.22s cubic-bezier(0.22,1,0.3,1);
  animation: isxIn 0.18s cubic-bezier(0.22,0.9,0.3,1) both; }
.isx-panel.is-wide { width: min(880px, calc(100vw - 60px)); }
.isx-mi.is-link { cursor: pointer; border-radius: 3px; }
.isx-mi.is-link:hover { color: var(--st-text); text-decoration: underline; text-underline-offset: 2px; }
/* The artist view is a page, so the panel becomes page-sized while it's up:
   near full width, a fixed height the view scrolls inside. */
.isx-panel.is-artist { width: min(1120px, calc(100vw - 48px)); top: 56px; height: calc(100vh - 112px); max-height: none; }
.isx-artistbody { flex: 1; min-height: 0; display: flex; position: relative; }
@keyframes isxFade { from { opacity: 0 } to { opacity: 1 } }
@keyframes isxIn { from { opacity: 0; transform: translateX(-50%) translateY(-8px) } to { opacity: 1; transform: translateX(-50%) } }

.isx-top { display: flex; align-items: center; gap: 10px; padding: 12px 12px 12px 18px; min-height: 58px; flex-shrink: 0;
  border-bottom: 1px solid rgba(var(--st-fg-rgb), 0.07); }
/* Chips and the input share one wrapping row, so a long scope list grows the
   bar downward instead of squeezing the text you're typing to nothing. */
.isx-field { flex: 1; min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; cursor: text; }
.isx-input { flex: 1; min-width: 120px; border: none; outline: none; background: transparent; padding: 4px 0;
  font-family: inherit; font-size: 15.5px; font-weight: 600; color: var(--st-text); }
.isx-topspin { width: 15px; height: 15px; margin: 0 1px; }
.isx-clear { width: 24px; height: 24px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  border-radius: 50%; border: none; cursor: pointer; background: rgba(var(--st-fg-rgb), 0.08); color: rgba(var(--st-fg-rgb), 0.6); }
.isx-clear:hover { background: rgba(var(--st-fg-rgb), 0.16); color: #fff; }
.isx-escbtn { flex-shrink: 0; height: 24px; padding: 0 8px; border-radius: 6px; cursor: pointer; font-family: inherit;
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.02em; border: 1px solid rgba(var(--st-fg-rgb), 0.12);
  background: transparent; color: rgba(var(--st-fg-rgb), 0.42); }
.isx-escbtn:hover { color: #fff; background: rgba(var(--st-fg-rgb), 0.08); }
.isx-tokx { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; margin: 0 -3px 0 1px;
  padding: 0; border: none; border-radius: 4px; cursor: pointer; background: transparent; color: inherit; opacity: 0.6; }
.isx-tokx:hover { opacity: 1; background: rgba(var(--st-acc-rgb), 0.25); }
.isx-token.is-static { cursor: default; padding: 2px 7px; font-size: 11px; }
.isx-recent { display: flex; align-items: center; gap: 7px; min-width: 0; }
.isx-glyph.is-small { width: 32px; height: 32px; border-radius: 8px; }
.isx-secbtn { margin-left: auto; border: none; background: none; padding: 0; cursor: pointer; font-family: inherit;
  font-size: 10.5px; font-weight: 650; letter-spacing: 0; text-transform: none; color: rgba(var(--st-fg-rgb), 0.35); }
.isx-secbtn:hover { color: #fff; }

/* ---- empty box ---- */
.isx-start { padding-bottom: 4px; }
.isx-intro { padding: 22px 12px 8px; }
.isx-intro .isx-emptyhint { margin-top: 5px; line-height: 1.5; }
.isx-filters { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; padding: 2px 8px 4px; }
.isx-filter { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; min-width: 0; padding: 9px 11px;
  border-radius: 10px; cursor: pointer; font-family: inherit; text-align: left;
  border: 1px solid rgba(var(--st-fg-rgb), 0.07); background: rgba(var(--st-fg-rgb), 0.03); color: inherit;
  transition: background 0.14s ease, border-color 0.14s ease; }
.isx-filter:hover { background: rgba(var(--st-acc-rgb), 0.1); border-color: rgba(var(--st-acc-rgb), 0.3); }
.isx-filter-k { font-size: 12px; font-weight: 750; color: rgb(var(--st-acc-rgb)); }
.isx-filter-d { font-size: 11px; color: rgba(var(--st-sub-rgb), 0.45); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.isx-tip { padding: 12px 12px 4px; font-size: 11.5px; line-height: 1.5; color: rgba(var(--st-sub-rgb), 0.38); }
.isx-input::placeholder { color: rgba(var(--st-fg-rgb), 0.28); font-weight: 500; }
.isx-busy { flex-shrink: 0; font-size: 11px; color: rgba(var(--st-sub-rgb), 0.32); animation: stPulse 1.4s ease infinite; }
.isx-token { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; max-width: 260px;
  padding: 4px 7px 4px 8px; border-radius: 7px; white-space: nowrap; overflow: hidden; font-family: inherit; font-size: 11.5px; font-weight: 700;
  background: rgba(var(--st-acc-rgb), 0.16); color: rgb(var(--st-acc-rgb)); border: 1px solid rgba(var(--st-acc-rgb), 0.3); }
.isx-token .k { opacity: 0.6; font-weight: 800; font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; }

.isx-crumb { display: flex; align-items: center; gap: 9px; padding: 11px 14px; flex-shrink: 0;
  border-bottom: 1px solid rgba(var(--st-fg-rgb), 0.07); background: rgba(var(--st-fg-rgb), 0.02); }
.isx-back { width: 26px; height: 26px; border-radius: 8px; flex-shrink: 0; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid rgba(var(--st-fg-rgb), 0.12); background: rgba(var(--st-fg-rgb), 0.05); color: rgba(var(--st-fg-rgb), 0.7); }
.isx-back:hover { background: rgba(var(--st-fg-rgb), 0.1); color: #fff; }
.isx-path-bc { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: 12px; font-weight: 650; color: rgba(var(--st-fg-rgb), 0.45); }
.isx-path-bc b { color: var(--st-text); font-weight: 700; }
.isx-path-bc .sl { color: rgba(var(--st-fg-rgb), 0.22); }
/* ↗ — leave the panel for the real page. Both of its actions were ⌘↵-only,
   so a mouse could not reach them at all. Shown on hover and on the
   highlighted row rather than as permanent chrome on every line. */
.isx-open { display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  width: 24px; height: 24px; border-radius: 7px; cursor: pointer;
  color: rgba(var(--st-fg-rgb), 0.5); background: transparent;
  opacity: 0; transition: opacity 0.14s ease, background 0.14s ease, color 0.14s ease; }
.isx-row:hover .isx-open, .isx-row.is-on .isx-open { opacity: 1; }
.isx-open:hover { background: rgba(var(--st-fg-rgb), 0.14); color: #fff; }
.isx-crumb-b { border: none; background: none; padding: 0; font: inherit; font-size: inherit;
  color: inherit; cursor: pointer; }
.isx-crumb-b:hover { color: #fff; text-decoration: underline; text-underline-offset: 2px; }
.isx-esc { font-size: 10.5px; font-weight: 700; color: rgba(var(--st-fg-rgb), 0.28); white-space: nowrap; }

.isx-body { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 8px 12px;
  scrollbar-width: thin; scrollbar-color: rgba(var(--st-fg-rgb), 0.13) transparent; }
.isx-body::-webkit-scrollbar { width: 6px; }
.isx-body::-webkit-scrollbar-thumb { background: rgba(var(--st-fg-rgb), 0.13); border-radius: 999px; }

.isx-sec { padding: 12px 12px 6px; display: flex; align-items: center; gap: 8px;
  font-size: 10px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(var(--st-fg-rgb), 0.3); }
.isx-sec .ct { letter-spacing: 0; font-weight: 700; color: rgba(var(--st-fg-rgb), 0.2); }
.isx-secnote { margin-left: auto; letter-spacing: 0; text-transform: none; font-size: 10.5px; font-weight: 600; color: rgba(var(--st-fg-rgb), 0.24); }

/* ---- Entrances --------------------------------------------------------
   Results land in three independent waves, so rows appear mid-read. These
   soften that into something that looks deliberate.

   The "both" fill-mode matters: without it a row is fully visible for the
   length of its own delay, then jumps to opacity 0 to start animating —
   a flicker that's worse than no animation at all. */
@keyframes isx-rise {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: none; }
}
.isx-in { animation: isx-rise 190ms cubic-bezier(.22,.61,.36,1) both; }

/* Artwork resolves after its row — album covers from cache, artist portraits
   from a page fetch that deliberately runs late. Fading the image in stops
   that from reading as a second, unrelated flash of movement. */
@keyframes isx-artin { from { opacity: 0; } to { opacity: 1; } }
.isx-art, .isx-peekart { animation: isx-artin 260ms ease both; }

/* Placeholder rows for a section whose results haven't arrived. A shape in
   the right place tells you something is coming and roughly how much, which
   a spinner doesn't; it also stops the list height jumping when rows land. */
@keyframes isx-shimmer { from { background-position: -320px 0; } to { background-position: 320px 0; } }
.isx-skel { display: flex; align-items: center; gap: 11px; padding: 8px 10px; border-radius: 10px; }
.isx-skel > * { border-radius: 6px;
  background: linear-gradient(90deg, rgba(255,255,255,.045) 0%, rgba(255,255,255,.10) 50%, rgba(255,255,255,.045) 100%);
  background-size: 320px 100%; animation: isx-shimmer 1.15s linear infinite; }
.isx-skel .sk-art { width: 42px; height: 42px; border-radius: 9px; flex-shrink: 0; }
.isx-skel .sk-lines { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.isx-skel .sk-a { height: 11px; width: 46%; }
.isx-skel .sk-b { height: 9px; width: 28%; opacity: .7; }

/* Anyone who has asked the OS for less motion gets none of it. The stagger is
   a nicety; withholding content from someone who finds movement unpleasant is
   not a trade worth making. */
@media (prefers-reduced-motion: reduce) {
  .isx-in, .isx-art, .isx-peekart { animation: none; }
  .isx-skel > * { animation: none; }
}

.isx-row { display: flex; align-items: center; gap: 11px; width: 100%; padding: 8px 10px; border-radius: 10px;
  border: none; background: transparent; color: inherit; text-align: left; cursor: pointer; font-family: inherit; }
.isx-row.is-on { background: rgba(var(--st-acc-rgb), 0.13); }
.isx-mid { min-width: 0; flex: 1; }
.isx-art { width: 42px; height: 42px; border-radius: 9px; flex-shrink: 0; background-size: cover; background-position: center;
  background-color: rgba(var(--st-fg-rgb), 0.06); box-shadow: 0 0 0 1px rgba(var(--st-fg-rgb), 0.08); }
.isx-art.is-round { border-radius: 50%; }
.isx-glyph { width: 42px; height: 42px; border-radius: 9px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(var(--st-fg-rgb), 0.05); border: 1px solid rgba(var(--st-fg-rgb), 0.09); color: rgba(var(--st-fg-rgb), 0.45); }
.isx-nm { font-size: 13px; font-weight: 650; color: var(--st-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.isx-meta { display: flex; align-items: center; gap: 7px; margin-top: 3px; min-width: 0; font-size: 10.5px; color: rgba(var(--st-sub-rgb), 0.45); }
.isx-meta > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.isx-mi + .isx-mi::before { content: '·'; margin-right: 7px; color: rgba(var(--st-sub-rgb), 0.3); font-weight: 700; }
.isx-kb { flex-shrink: 0; font-size: 10px; font-weight: 700; color: rgba(var(--st-fg-rgb), 0.32); }
.isx-dur { flex-shrink: 0; font-size: 11.5px; color: rgba(var(--st-sub-rgb), 0.45); font-variant-numeric: tabular-nums; }
.isx-owned { flex-shrink: 0; font-size: 10.5px; font-weight: 650; color: rgba(140,220,160,0.85); white-space: nowrap; }

.isx-badge { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; font-size: 9.5px; font-weight: 800;
  letter-spacing: 0.05em; padding: 3px 7px; border-radius: 6px; text-transform: uppercase; white-space: nowrap; }
.isx-avail { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; font-size: 10.5px; font-weight: 650; white-space: nowrap; }
.isx-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }

.isx-get { flex-shrink: 0; cursor: pointer; white-space: nowrap; font-family: inherit; padding: 5px 13px; border-radius: 8px;
  font-size: 11px; font-weight: 700; border: 1px solid rgba(var(--st-acc-rgb), 0.4);
  background: rgba(var(--st-acc-rgb), 0.16); color: rgb(var(--st-acc-rgb)); }
.isx-get:hover { background: rgba(var(--st-acc-rgb), 0.26); }
.isx-get.is-solid { background: rgb(var(--st-acc-rgb)); border-color: transparent; color: var(--st-acc-ink, #0d0f1c); }
.isx-get.is-big { padding: 9px 16px; border-radius: 10px; font-size: 12px; }
.isx-ghost { flex-shrink: 0; cursor: pointer; white-space: nowrap; font-family: inherit; padding: 5px 12px; border-radius: 8px;
  font-size: 11px; font-weight: 700; border: 1px solid rgba(var(--st-fg-rgb), 0.14);
  background: rgba(var(--st-fg-rgb), 0.05); color: rgba(var(--st-fg-rgb), 0.8); }
.isx-ghost:hover { background: rgba(var(--st-fg-rgb), 0.1); color: #fff; }
.isx-ghost.is-big { padding: 9px 14px; border-radius: 10px; font-size: 12px; }
.isx-prog { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; }
.isx-prog-bar { height: 5px; border-radius: 999px; background: rgba(var(--st-fg-rgb), 0.12); overflow: hidden; }
.isx-prog-bar i { display: block; height: 100%; border-radius: 999px; background: rgb(var(--st-acc-rgb)); transition: width 0.24s ease; }
.isx-prog span { font-size: 9.5px; font-weight: 650; color: rgba(var(--st-sub-rgb), 0.5); font-variant-numeric: tabular-nums; }

/* ---- peek hero ---- */
.isx-peek { padding: 16px 16px 2px; flex-shrink: 0; }
.isx-peekhero { display: flex; gap: 18px; align-items: flex-start; }
.isx-peekart { width: 112px; height: 112px; border-radius: 12px; flex-shrink: 0; background-size: cover; background-position: center;
  background-color: rgba(var(--st-fg-rgb), 0.06); box-shadow: 0 12px 34px rgba(0,0,0,0.55); }
.isx-peekart.is-round { border-radius: 50%; }
.isx-eyebrow { font-size: 10px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: rgb(var(--st-acc-rgb)); }
.isx-peektitle { margin: 7px 0 0; font-size: 24px; font-weight: 800; letter-spacing: -0.025em; color: var(--st-text); line-height: 1.08; }
.isx-peeksub { font-size: 12.5px; color: rgba(var(--st-sub-rgb), 0.5); margin-top: 8px; }
.isx-peekacts { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-top: 14px; }
.isx-cov { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-top: 14px; padding: 10px 12px; border-radius: 11px;
  background: rgba(var(--st-fg-rgb), 0.035); border: 1px solid rgba(var(--st-fg-rgb), 0.07);
  font-size: 11.5px; color: rgba(var(--st-fg-rgb), 0.55); }
.isx-cov.is-busy { animation: stPulse 1.3s ease infinite; }
.isx-unmatched { margin-left: auto; font-size: 11px; font-weight: 650; color: rgba(240,190,120,0.8); }

/* ---- tracklist ---- */
.isx-trk { display: grid; grid-template-columns: 26px minmax(0,1fr) auto 48px 138px; gap: 11px; align-items: center;
  width: 100%; padding: 7px 12px; border-radius: 9px; border: none; background: transparent; color: inherit;
  text-align: left; cursor: pointer; font-family: inherit; }
.isx-trk.is-on { background: rgba(var(--st-acc-rgb), 0.13); }
.isx-trk.is-open { background: rgba(var(--st-acc-rgb), 0.09); }
.isx-n { text-align: center; font-size: 11.5px; color: rgba(var(--st-fg-rgb), 0.32); font-variant-numeric: tabular-nums; }
.isx-tt { min-width: 0; font-size: 12.5px; font-weight: 600; color: var(--st-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.isx-tt.is-have { font-weight: 500; color: rgba(var(--st-text-rgb), 0.48); }
.isx-tcell { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.isx-tcell .isx-tt { display: block; }
.isx-tcred { min-width: 0; font-size: 11.5px; font-weight: 550; color: rgba(var(--st-sub-rgb), 0.5);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.isx-tartist { cursor: pointer; }
.isx-tartist:hover { color: var(--st-text); text-decoration: underline; text-underline-offset: 2px; }
.isx-tfeat { margin: 0 4px; color: rgba(var(--st-sub-rgb), 0.35); }
.isx-tq { display: flex; align-items: center; gap: 6px; justify-content: flex-end; }
.isx-none { font-size: 10.5px; color: rgba(var(--st-sub-rgb), 0.3); white-space: nowrap; }
.isx-srcct { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 999px;
  background: rgba(var(--st-fg-rgb), 0.08); color: rgba(var(--st-fg-rgb), 0.4); }
.isx-ta { text-align: right; display: flex; justify-content: flex-end; align-items: center; gap: 8px; }

/* ---- per-peer sources ---- */
.isx-srcwrap { margin: 2px 12px 8px 49px; }
.isx-src { display: flex; align-items: flex-start; gap: 12px; width: 100%; padding: 9px 10px; border-radius: 9px;
  border: none; background: rgba(var(--st-fg-rgb), 0.03); color: inherit; text-align: left; cursor: pointer;
  font-family: inherit; margin-bottom: 4px; }
.isx-src.is-on { background: rgba(var(--st-acc-rgb), 0.11); }
.isx-pick { width: 15px; height: 15px; border-radius: 50%; flex-shrink: 0; margin-top: 3px; border: 1.5px solid rgba(var(--st-fg-rgb), 0.22); }
.isx-src.is-on .isx-pick { border-color: rgb(var(--st-acc-rgb)); box-shadow: inset 0 0 0 3.5px rgb(var(--st-acc-rgb)); }
.isx-srchead { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.isx-srchead b { font-size: 12px; font-weight: 650; color: var(--st-text); }
.isx-default { font-size: 9.5px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; color: rgb(var(--st-acc-rgb)); }
.isx-path { display: block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px;
  color: rgba(var(--st-sub-rgb), 0.3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  direction: rtl; text-align: left; margin-top: 4px; }

/* ---- states ---- */
.isx-empty { padding: 42px 20px; text-align: center; }
.isx-emptytitle { font-size: 14px; font-weight: 650; color: rgba(var(--st-text-rgb), 0.85); }
.isx-emptyhint { font-size: 12px; color: rgba(var(--st-sub-rgb), 0.4); margin-top: 9px; line-height: 1.7; }
.isx-emptyhint b { color: rgba(var(--st-fg-rgb), 0.62); font-weight: 700; }

.isx-foot { display: flex; align-items: center; gap: 16px; padding: 11px 16px; flex-shrink: 0;
  border-top: 1px solid rgba(var(--st-fg-rgb), 0.07); font-size: 11px; color: rgba(var(--st-sub-rgb), 0.35); }
.isx-foot kbd { font-family: inherit; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 5px;
  background: rgba(var(--st-fg-rgb), 0.08); color: rgba(var(--st-fg-rgb), 0.55); margin-right: 6px; }
.isx-footnote { display: inline-flex; align-items: center; gap: 7px; color: rgba(var(--st-sub-rgb), 0.4); }

/* Band pager. Lives in the section header rather than as a row of its own,
   so the band stays a fixed three rows and costs no extra cursor stop. */
.isx-pager { display: inline-flex; gap: 3px; margin-left: 8px; }
.isx-pager button { display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; padding: 0; border-radius: 6px; cursor: pointer; font-family: inherit;
  border: 1px solid rgba(var(--st-fg-rgb), 0.12); background: rgba(var(--st-fg-rgb), 0.04);
  color: rgba(var(--st-fg-rgb), 0.45); }
.isx-pager button:hover { background: rgba(var(--st-fg-rgb), 0.12); color: #fff; }

/* "You have this" — the chip that keeps a deliberately skipped search from
   reading as a broken one. */
.isx-have { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; white-space: nowrap;
  font-size: 11px; font-weight: 650; color: rgba(140,220,160,0.9); }

/* Quality toggle — the segmented control studio uses everywhere else. */
.isx-qtoggle { display: inline-flex; gap: 2px; padding: 2px; border-radius: 9px; flex-shrink: 0;
  background: rgba(var(--st-fg-rgb), 0.06); border: 1px solid rgba(var(--st-fg-rgb), 0.07); }
.isx-qtoggle button { border: none; cursor: pointer; font-family: inherit; padding: 4px 11px; border-radius: 7px;
  font-size: 10.5px; font-weight: 700; background: transparent; color: rgba(var(--st-fg-rgb), 0.42); }
.isx-qtoggle button:hover { color: rgba(var(--st-fg-rgb), 0.8); }
.isx-qtoggle button.on { background: rgba(var(--st-fg-rgb), 0.14); color: #fff; }

/* "better?" — the per-song upgrade. Hidden until the row is the one you're
   on, so eight rows don't each shout about a thing most people won't want. */
.isx-better { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; cursor: pointer;
  padding: 4px 9px; border-radius: 7px; font-size: 10.5px; font-weight: 700;
  color: rgba(var(--st-fg-rgb), 0.45); background: rgba(var(--st-fg-rgb), 0.05);
  opacity: 0; transition: opacity 0.13s ease, color 0.13s ease, background 0.13s ease; }
.isx-better.is-shown { opacity: 1; }
.isx-better:hover { color: rgb(var(--st-acc-rgb)); background: rgba(var(--st-acc-rgb), 0.14); }
.isx-probing { color: rgba(var(--st-acc-rgb), 0.8); animation: stPulse 1.3s ease infinite; }

/* Owned rows. A play affordance rather than a disabled Get with a badge
   apologising for itself — the row does something, so it says what. */
.isx-playtag { display: none; align-items: center; gap: 6px; flex-shrink: 0; white-space: nowrap;
  padding: 4px 10px; border-radius: 6px; font-size: 10.5px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase;
  background: var(--accent); color: var(--accent-ink); }
/* Only the highlighted row carries a PLAY chip — with Enter working
   correctly, per-row buttons are mostly redundant (brief). */
.isx-row.is-on .isx-playtag { display: inline-flex; }
/* A hairline in the "owned" green, so the split is legible while scanning
   without every second row carrying a text badge. */
.isx-art.is-owned { box-shadow: 0 0 0 1px rgba(123,224,176,0.35); }

.isx-spin { width: 11px; height: 11px; flex-shrink: 0; border-radius: 50%; display: inline-block;
  border: 1.6px solid rgba(var(--st-fg-rgb), 0.15); border-top-color: rgb(var(--st-acc-rgb));
  animation: isxSpin 0.7s linear infinite; }
@keyframes isxSpin { to { transform: rotate(360deg); } }

@media (max-width: 820px) {
  .isx-panel, .isx-panel.is-wide { width: calc(100vw - 32px); top: 70px; }
  .isx-trk { grid-template-columns: 24px minmax(0,1fr) 44px 126px; }
  .isx-tq { display: none; }
  .isx-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (prefers-reduced-motion: reduce) { .isx-panel, .isx-scrim { animation: none; } }
`;
