import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { sampleImageTheme, isFallbackTheme, recordWashSource, pageWash, readableAccent, accentTextColor } from './coverTheme.js';
import { PlayIcon } from './sharedUI.jsx';
import { formatTotalMs, titleCollator, parseGenres } from './mediaUtils.js';

/* =========================================================================
 *  studio — artist page
 *
 *  The Artists rail entry used to be a flat song table sorted by artist,
 *  which is a sort order rather than a place. This is the place: one artist's
 *  whole presence in the library on a single page — top tracks by real play
 *  count, their records, their loose singles, the records they only guest on,
 *  and (the part a streaming service structurally can't show you) the part of
 *  their catalogue you DON'T have yet, handed straight to Find.
 *
 *  Colour, artwork treatment, tracklist grid and header rhythm are the album
 *  page's, not a second set that resembles it — the two are the same kind of
 *  page and should read that way.
 * ========================================================================= */

const api = () => (typeof window !== 'undefined' ? window.electronAPI : null);

/* Artist profiles are stable and the lookup costs a network round trip, so
   they're cached for a week in localStorage and for the session in memory.
   A miss is remembered too (as null) — an artist Spotify has never heard of
   shouldn't be re-queried on every visit to their page. */
const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/* v2: entries gained a `header` field. Bumping the key rather than migrating
   because the whole store is a cache — the worst case is one refetch. */
const PROFILE_LS_KEY = 'studio:artistProfiles:v2';
const profileMem = new Map();

function readProfileCache() {
  try { return JSON.parse(localStorage.getItem(PROFILE_LS_KEY) || '{}') || {}; } catch { return {}; }
}

function cachedProfile(key) {
  if (profileMem.has(key)) return profileMem.get(key);
  const all = readProfileCache();
  const hit = all[key];
  if (hit && Date.now() - (hit.at || 0) < PROFILE_TTL_MS) {
    profileMem.set(key, hit.data || null);
    return hit.data || null;
  }
  return undefined; // undefined = not cached, null = cached miss
}

function storeProfile(key, data) {
  profileMem.set(key, data);
  try {
    const all = readProfileCache();
    all[key] = { at: Date.now(), data };
    // Keep the store bounded — 300 artists is far past any real library's
    // browsing history and stops this growing without limit.
    const keys = Object.keys(all);
    if (keys.length > 300) {
      keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0)).slice(0, keys.length - 300)
        .forEach((k) => { delete all[k]; });
    }
    localStorage.setItem(PROFILE_LS_KEY, JSON.stringify(all));
  } catch { /* quota — the in-memory cache still holds for this session */ }
}

/* Hero framing. A square source in a wide band is always a crop, so these are
   the only two dials that matter: HERO_H is how tall a slice survives, and
   HERO_FOCUS is where in the image that slice is taken from (0% = top of the
   frame, 50% = middle). Both are here rather than inline so they're one edit,
   not a hunt through JSX. Dialled in against a real photo at full width. */
const HERO_H = 260;
const HERO_FOCUS = '40%';

function fmtDur(s) {
  if (!s || !Number.isFinite(s)) return '';
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}

/** Normalise a release title for "do I already own this?" comparison. */
function normRelease(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\((deluxe|expanded|remaster(ed)?|anniversary|edition|version|explicit)[^)]*\)/g, '')
    .replace(/\[(deluxe|expanded|remaster(ed)?|anniversary|edition|version|explicit)[^\]]*\]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/* ---- Small shared pieces ------------------------------------------------ */

function ActionBtn({ title, onClick, active = false, children }) {
  const [hot, setHot] = useState(false);
  return (
    <button
      type="button" onClick={onClick} title={title} aria-label={title}
      onMouseEnter={() => setHot(true)} onMouseLeave={() => setHot(false)}
      style={{
        width: 36, height: 36, borderRadius: '50%', border: 'none', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        background: hot ? 'rgba(var(--st-fg-rgb), 0.12)' : 'transparent',
        color: active ? 'var(--st-text)' : `rgba(var(--st-sub-rgb), ${hot ? 0.9 : 0.6})`,
        transition: 'background 0.15s ease, color 0.15s ease',
      }}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

function PillBtn({ onClick, on = false, children }) {
  const [hot, setHot] = useState(false);
  return (
    <button
      type="button" onClick={onClick}
      onMouseEnter={() => setHot(true)} onMouseLeave={() => setHot(false)}
      style={{
        height: 36, padding: '0 17px', borderRadius: 999, cursor: 'pointer',
        font: 'inherit', fontSize: 12.5, fontWeight: 750, whiteSpace: 'nowrap',
        border: `1px solid rgba(var(--st-fg-rgb), ${on ? 0.34 : (hot ? 0.4 : 0.2)})`,
        background: on ? 'rgba(var(--st-fg-rgb), 0.13)' : (hot ? 'rgba(var(--st-fg-rgb), 0.06)' : 'transparent'),
        color: on || hot ? 'var(--st-text)' : 'rgba(var(--st-text-rgb), 0.82)',
        transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease',
      }}>
      {children}
    </button>
  );
}

function SectionHead({ title, sub, action, onAction }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, margin: '34px 0 15px' }}>
      <span style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.015em', color: 'var(--st-text)' }}>{title}</span>
      {sub ? <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(var(--st-sub-rgb), 0.42)' }}>{sub}</span> : null}
      {action ? (
        <button type="button" onClick={onAction}
          style={{
            marginLeft: 'auto', border: 'none', background: 'transparent', cursor: 'pointer', font: 'inherit',
            fontSize: 11.5, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase',
            color: 'rgba(var(--st-sub-rgb), 0.42)', transition: 'color 0.15s ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--st-text)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(var(--st-sub-rgb), 0.42)'; }}>
          {action}
        </button>
      ) : null}
    </div>
  );
}

/** Release card. `missing` drains the art and swaps the play affordance for a
 *  download one — same shape as an owned record, visibly not one. */
function ReleaseCard({ art, name, meta, missing = false, accent, onClick }) {
  const [hot, setHot] = useState(false);
  return (
    <button
      type="button" onClick={onClick} title={name}
      onMouseEnter={() => setHot(true)} onMouseLeave={() => setHot(false)}
      style={{
        border: 'none', background: 'transparent', cursor: 'pointer', font: 'inherit',
        textAlign: 'left', padding: 0, display: 'flex', flexDirection: 'column', minWidth: 0,
        /* Browsers set `align-items: center` on <button> in their own stylesheet.
           In a column flex that centres children on the cross axis and lets them
           size to their content instead of stretching — so a long release title
           grew the caption past the card and the ellipsis clipped nothing,
           because the box it was clipping to was as wide as the text. */
        alignItems: 'stretch',
      }}>
      <div style={{
        position: 'relative', width: '100%', aspectRatio: '1', borderRadius: 9, overflow: 'hidden',
        background: art ? `url("${String(art).replace(/"/g, '%22')}") center/cover` : 'rgba(var(--st-fg-rgb), 0.07)',
        boxShadow: missing ? 'none' : '0 10px 26px rgba(0,0,0,0.45)',
        outline: missing ? '1px dashed rgba(var(--st-fg-rgb), 0.2)' : 'none',
        outlineOffset: -1,
        filter: missing ? `grayscale(${hot ? 0.4 : 0.85}) brightness(${hot ? 0.72 : 0.5})` : (hot ? 'brightness(1.05)' : 'none'),
        transform: hot && !missing ? 'translateY(-3px)' : 'none',
        transition: 'transform 0.22s cubic-bezier(0.22,0.9,0.3,1), filter 0.22s ease',
      }}>
        <span style={{
          position: 'absolute', right: 9, bottom: 9, width: 36, height: 36, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: missing ? 'rgba(255,255,255,0.16)' : `rgb(${accent})`,
          color: missing ? '#fff' : accentTextColor(accent),
          backdropFilter: missing ? 'blur(6px)' : 'none',
          boxShadow: '0 6px 16px rgba(0,0,0,0.45)',
          opacity: hot ? 1 : 0, transform: hot ? 'none' : 'translateY(7px)',
          transition: 'opacity 0.18s ease, transform 0.18s ease',
        }}>
          {missing ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v12M7 12l5 5 5-5M5 20h14" /></svg>
          ) : (
            <PlayIcon size={14} />
          )}
        </span>
      </div>
      <div style={{
        fontSize: 13, fontWeight: 750, marginTop: 10, lineHeight: 1.25,
        color: missing ? 'rgba(var(--st-text-rgb), 0.62)' : 'var(--st-text)',
        width: '100%', minWidth: 0, maxWidth: '100%',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{name}</div>
      <div style={{
        fontSize: 11.5, fontWeight: 600, color: 'rgba(var(--st-fg-rgb), 0.5)', marginTop: 3, lineHeight: 1.25,
        width: '100%', minWidth: 0, maxWidth: '100%',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{meta}</div>
    </button>
  );
}

function CardGrid({ children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(158px, 1fr))', gap: '26px 22px' }}>
      {children}
    </div>
  );
}

/** One row of the top-tracks list. Same column rhythm as the album page's
 *  tracklist, plus a plays column — the reason this list exists. */
function TrackRow({ n, track, art, plays, playing, isPlaying, accent, onPlay, onTogglePlay }) {
  const [hot, setHot] = useState(false);
  /* Clicking the row that's already current toggles it. Restarting a track
     you're listening to is never what the click meant. */
  const activate = () => { if (playing && onTogglePlay) onTogglePlay(); else onPlay(); };
  const showPause = playing && isPlaying;
  return (
    <div
      role="button" tabIndex={0} onClick={activate}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } }}
      onMouseEnter={() => setHot(true)} onMouseLeave={() => setHot(false)}
      style={{
        display: 'grid', gridTemplateColumns: '30px 40px minmax(0, 2.4fr) minmax(0, 1.4fr) 62px 52px',
        alignItems: 'center', gap: 14, padding: '7px 12px', borderRadius: 9, cursor: 'pointer',
        background: hot ? 'rgba(var(--st-fg-rgb), 0.055)' : 'transparent',
        transition: 'background 0.13s ease',
      }}>
      <span style={{
        textAlign: 'right', fontSize: 12.5, fontWeight: 650, fontVariantNumeric: 'tabular-nums',
        color: playing ? `rgb(${accent})` : `rgba(var(--st-sub-rgb), ${hot ? 0.8 : 0.35})`,
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
      }}>
        {/* Hover states what the click will do — pause for the track you can
            hear, play for anything else. */}
        {hot ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            {showPause
              ? <><rect x="6.5" y="5" width="3.6" height="14" rx="1.1" /><rect x="13.9" y="5" width="3.6" height="14" rx="1.1" /></>
              : <path d="M8 6.5v11l9.5-5.5z" />}
          </svg>
        ) : n}
      </span>
      <span style={{
        width: 40, height: 40, borderRadius: 6, flexShrink: 0,
        background: art ? `url("${String(art).replace(/"/g, '%22')}") center/cover` : 'rgba(var(--st-fg-rgb), 0.07)',
      }} />
      <span style={{ minWidth: 0 }}>
        <span style={{
          display: 'block', fontSize: 13.5, fontWeight: 650,
          color: playing ? `rgb(${accent})` : 'var(--st-text)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{track.title || 'Unknown track'}</span>
      </span>
      <span style={{
        fontSize: 12, fontWeight: 600, color: 'rgba(var(--st-sub-rgb), 0.45)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{(track.album || '').trim() || 'Single'}</span>
      <span style={{
        textAlign: 'right', fontSize: 12, fontWeight: 650, fontVariantNumeric: 'tabular-nums',
        color: 'rgba(var(--st-sub-rgb), 0.4)',
      }}>{plays ? plays.toLocaleString() : '—'}</span>
      <span style={{
        textAlign: 'right', fontSize: 12, fontWeight: 650, fontVariantNumeric: 'tabular-nums',
        color: 'rgba(var(--st-sub-rgb), 0.4)',
      }}>{fmtDur(track.duration)}</span>
    </div>
  );
}

/* ========================================================================= */

/**
 * @param artist   entry from StudioHome's `libArtists` memo
 * @param onOpenAlbum  (libAlbums key) → opens the existing album detail page
 * @param onJumpToFind (query, source) → Find, pre-loaded
 */
export default function ArtistPage({
  artist,
  accent = '120, 120, 120',
  theme = {},
  playEvents = [],
  currentTrack = null,
  isPlaying = false,
  onPlayTrack,
  onTogglePlay,
  onOpenAlbum,
  onJumpToFind,
  onBack,
  following = false,
  onToggleFollow,
}) {
  const [profile, setProfile] = useState(() => {
    const c = cachedProfile(artist?.key || '');
    return c === undefined ? null : c;
  });
  const [profileState, setProfileState] = useState('idle'); // idle | loading | done
  const [remote, setRemote] = useState(null);   // spotifyArtistAlbums result
  const [remoteState, setRemoteState] = useState('idle');
  const [showAllTracks, setShowAllTracks] = useState(false);
  const [stuck, setStuck] = useState(false);
  const scrollRef = useRef(null);



  const name = artist?.name || 'Unknown artist';
  const key = artist?.key || '';

  /* ---- Header override --------------------------------------------------
   * The fetched header is a default, not a verdict. `override` holds what the
   * user decided instead: optionally their own image, and always a framing.
   * `draft` is the framing being dragged right now — separate so a drag can
   * be abandoned without having written anything. */
  const [override, setOverride] = useState(null);   // { image, focusX, focusY, zoom } | null
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const dragRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    setEditing(false);
    setDraft(null);
    if (!key) { setOverride(null); return undefined; }
    let dead = false;
    const a = api();
    if (!a?.loadArtistHeaders) { setOverride(null); return undefined; }
    a.loadArtistHeaders()
      .then((res) => { if (!dead) setOverride(res?.headers?.[key] || null); })
      .catch(() => { if (!dead) setOverride(null); });
    return () => { dead = true; };
  }, [key]);

  /* Best-shaped image wins, in this order:
       header  — landscape art actually meant to sit behind a title
       image   — Spotify's square avatar, which a wide band has to crop hard
       art     — the newest cover, blurred, as a last-resort colour field
     Only the first is the right shape for the job; the other two are what we
     had before and are kept so the page never renders empty. Declared up here
     rather than beside the JSX because the aspect probe below is a hook, and
     hooks can't sit after this component's early return. */
  const heroSrc = override?.image || profile?.header || profile?.image || artist?.art || null;
  /* A real photo is shown as-is. The album-cover fallback is blurred, because
     stretching a 300px cover across the band is exactly the artefact this
     whole change exists to remove. A chosen image is never blurred — if you
     picked it, you meant it. */
  const heroIsPhoto = !!(override?.image || profile?.header || profile?.image);
  const heroIsCustom = !!override?.image;

  /* Default framing depends on what kind of picture we ended up with. Wide
     header art is already composed for a band, so it centres. A square avatar
     has to be pushed up onto the face — that's what HERO_FOCUS is for. */
  const autoFocusY = profile?.header ? 50 : parseFloat(HERO_FOCUS);
  const frame = draft || override || { focusX: 50, focusY: autoFocusY, zoom: 1 };

  const saveHeader = useCallback(async (next) => {
    setOverride(next);
    const a = api();
    if (!a?.setArtistHeader || !key) return;
    try {
      const res = await a.setArtistHeader(key, {
        image: next.image || null,
        focusX: next.focusX, focusY: next.focusY, zoom: next.zoom,
      });
      /* The main process rewrites a pasted data URI into a stable
         studio-cover:// url. Take that back, or the next mount reads a url the
         in-memory copy never knew about. */
      if (res?.ok && res.image && res.image !== next.image) {
        setOverride((cur) => (cur ? { ...cur, image: res.image } : cur));
      }
    } catch { /* the in-memory value stands for this session */ }
  }, [key]);

  const resetHeader = useCallback(async () => {
    setOverride(null);
    setDraft(null);
    setEditing(false);
    const a = api();
    if (a?.clearArtistHeader && key) { try { await a.clearArtistHeader(key); } catch { /* ignore */ } }
  }, [key]);

  const pickImage = useCallback((file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const next = { ...frame, image: String(reader.result) };
      setDraft(null);
      saveHeader(next);
      setEditing(true);
    };
    reader.readAsDataURL(file);
  }, [frame, saveHeader]);

  /* Natural aspect of whatever is in the header, so a drag can know how much
     slack there actually is. Without it the handler is guessing, and a guess
     is what made dragging feel dead in one axis and wild in the other. */
  const [imgAspect, setImgAspect] = useState(null);   // natural width / height
  const heroRef = useRef(null);
  const [heroW, setHeroW] = useState(0);
  useEffect(() => {
    const el = heroRef.current;
    if (!el || typeof window === 'undefined' || !window.ResizeObserver) return undefined;
    const ro = new window.ResizeObserver(([entry]) => {
      setHeroW(entry?.contentRect?.width || 0);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* Which edge does the picture fill at zoom 1?
     Narrower than the band (a square, a 16:9 still) fills the WIDTH and spills
     vertically. Wider than the band fills the HEIGHT and spills sideways.
     Picking wrong doesn't just misplace the drag — it letterboxes, leaving a
     gap of page wash inside the header. */
  const bandAspect = heroW ? heroW / HERO_H : null;
  const sizeByWidth = !imgAspect || !bandAspect || imgAspect <= bandAspect;

  /* Drag to reposition, 1:1 with the cursor.
   *
   * The image can only move by the amount it OVERFLOWS the band, so the
   * conversion from pixels to background-position percent depends on that
   * overflow, not on the band's size. Get it wrong and one axis flies while
   * the other looks broken.
   *
   * At zoom 1 a square photo overflows vertically only — the width already
   * fits exactly — so up/down moves and left/right correctly doesn't. Zoom in
   * and horizontal slack appears, so both axes come alive. Inverted, because
   * you're dragging the picture, not a window onto it.
   */
  const draftRef = useRef(null);
  const onDragStart = useCallback((e) => {
    if (!editing) return;
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    const imgW = sizeByWidth
      ? box.width * frame.zoom
      : (box.height * frame.zoom) * (imgAspect || 1);
    const imgH = sizeByWidth
      ? (box.width * frame.zoom) / (imgAspect || 1)
      : box.height * frame.zoom;
    const slackX = Math.max(0, imgW - box.width);
    const slackY = Math.max(0, imgH - box.height);
    const start = { x: e.clientX, y: e.clientY, fx: frame.focusX, fy: frame.focusY };
    dragRef.current = start;

    const clamp = (n) => Math.min(100, Math.max(0, n));
    const move = (ev) => {
      if (!dragRef.current) return;
      const next = {
        image: override?.image || null,
        zoom: frame.zoom,
        focusX: slackX ? clamp(start.fx - ((ev.clientX - start.x) / slackX) * 100) : start.fx,
        focusY: slackY ? clamp(start.fy - ((ev.clientY - start.y) / slackY) * 100) : start.fy,
      };
      draftRef.current = next;
      setDraft(next);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      dragRef.current = null;
      /* Commit OUTSIDE a state updater. Saving from inside setDraft's callback
         meant one setState ran during another's update — React is free to call
         an updater twice, so the write landed unpredictably and the drag
         snapped back to where it started. */
      const finished = draftRef.current;
      draftRef.current = null;
      setDraft(null);
      if (finished) saveHeader(finished);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [editing, frame, imgAspect, sizeByWidth, override, saveHeader]);

  useEffect(() => {
    if (!heroSrc || typeof window === 'undefined') { setImgAspect(null); return undefined; }
    let dead = false;
    const img = new window.Image();
    img.onload = () => {
      if (dead || !img.naturalHeight) return;
      setImgAspect(img.naturalWidth / img.naturalHeight);
    };
    img.onerror = () => { if (!dead) setImgAspect(null); };
    img.src = heroSrc;
    return () => { dead = true; };
  }, [heroSrc]);

  /* ---- Artist profile (photo, genres) ---------------------------------- */
  useEffect(() => {
    setShowAllTracks(false);
    setRemote(null);
    setRemoteState('idle');
    if (!key) return undefined;
    const cached = cachedProfile(key);
    if (cached !== undefined) { setProfile(cached); setProfileState('done'); return undefined; }
    setProfile(null);
    let dead = false;
    setProfileState('loading');
    const a = api();
    if (!a?.spotifyArtistInfo) { setProfileState('done'); return undefined; }

    /* Two lookups, one cache entry.
       Spotify supplies the identity — id, genres, avatar. TheAudioDB supplies
       the one thing Spotify's API doesn't expose at all: a WIDE header image.
       They're independent, so they run together and the page renders on
       whichever shape it ends up with. */
    Promise.all([
      a.spotifyArtistInfo(name).catch(() => null),
      a.artistHeaderImage ? a.artistHeaderImage(name).catch(() => null) : Promise.resolve(null),
    ])
      .then(([info, head]) => {
        if (dead) return;
        const base = info && info.id ? info : null;
        const header = head?.url || null;
        const data = base || header ? { ...(base || {}), header } : null;
        storeProfile(key, data);
        setProfile(data);
        setProfileState('done');
      })
      .catch(() => { if (!dead) setProfileState('done'); });
    return () => { dead = true; };
  }, [key, name]);

  /* ---- Page wash -------------------------------------------------------
   * Sampled from `heroSrc` — the SAME image the header ends up displaying,
   * override and all.
   *
   * This used to sample `profile.image || artist.art`, which is only the last
   * two entries of the hero's four-deep fallback chain. So an artist with wide
   * header art, or with a photo you'd uploaded yourself, got a page coloured
   * by a picture that wasn't on it: a blue portrait on screen over a wash
   * pulled from an orange album cover you never see. One source, one colour. */
  const [pageTheme, setPageTheme] = useState(null);
  useEffect(() => {
    if (!heroSrc) { setPageTheme(null); return undefined; }
    let dead = false;
    /* A failed read resolves to a neutral theme rather than throwing, so it
       has to be recognised — otherwise one bad sample repaints the page black
       and it stays that way. */
    sampleImageTheme(heroSrc)
      .then((t) => { if (!dead && !isFallbackTheme(t)) setPageTheme(t); })
      .catch(() => {});
    return () => { dead = true; };
  }, [heroSrc]);

  const wash = theme.detailMode === 'fixed'
    ? pageWash(theme.detailColor)
    : pageWash(pageTheme ? recordWashSource(pageTheme) : accent);
  const deep = pageTheme ? pageTheme.wash : '10, 10, 14';
  const pageAcc = pageTheme ? pageTheme.accent : accent;
  const pageAccUI = readableAccent(pageAcc);

  /* ---- Play counts ------------------------------------------------------
   * All-time, not the Stats page's rolling window: an artist page is a shelf,
   * and "your most played" on a shelf means ever. */
  const playCounts = useMemo(() => {
    const m = new Map();
    for (const e of playEvents || []) {
      if (!e || !e.id) continue;
      m.set(e.id, (m.get(e.id) || 0) + 1);
    }
    return m;
  }, [playEvents]);

  const topTracks = useMemo(() => {
    const list = [...(artist?.tracks || [])];
    list.sort((a, b) => (playCounts.get(b.id) || 0) - (playCounts.get(a.id) || 0)
      || (b.addedAt || 0) - (a.addedAt || 0)
      || titleCollator.compare(a.title || '', b.title || ''));
    return list;
  }, [artist, playCounts]);

  const totalPlays = useMemo(
    () => (artist?.tracks || []).reduce((n, t) => n + (playCounts.get(t.id) || 0), 0),
    [artist, playCounts],
  );

  /* ---- Genres — file tags first, Spotify only to fill a gap ------------ */
  const genres = useMemo(() => {
    const seen = new Map();
    for (const t of artist?.tracks || []) {
      for (const g of parseGenres(t.genre)) {
        const k = g.toLowerCase();
        if (!seen.has(k)) seen.set(k, { g, n: 0 });
        seen.get(k).n += 1;
      }
    }
    if (seen.size) {
      return [...seen.values()].sort((a, b) => b.n - a.n).slice(0, 4).map((x) => x.g);
    }
    return (profile?.genres || []).slice(0, 4);
  }, [artist, profile]);

  /* ---- Catalogue you don't own ------------------------------------------
   * Only fetched on demand: it's a second network call per artist and most
   * visits to this page are to play something, not to shop. */
  const loadRemote = useCallback(async () => {
    if (remoteState !== 'idle' || !profile?.id) return;
    const a = api();
    if (!a?.spotifyArtistAlbums) return;
    setRemoteState('loading');
    try {
      const res = await a.spotifyArtistAlbums(profile.id);
      setRemote(Array.isArray(res) ? res : []);
    } catch { setRemote([]); }
    setRemoteState('done');
  }, [remoteState, profile]);

  /* Fetched only when the section is actually scrolled to.
   *
   * This is up to ten paginated Spotify requests per artist, and it used to
   * fire the moment a page opened — so browsing five artists cost fifty
   * requests and earned a 429, which then broke the sections that DID matter.
   * Most page opens are to play something and never reach the bottom of the
   * page, so the work is deferred until it's about to be looked at. */
  const missingRef = useRef(null);
  useEffect(() => {
    const el = missingRef.current;
    if (!el || !profile?.id || remoteState !== 'idle') return undefined;
    if (typeof window === 'undefined' || !window.IntersectionObserver) {
      loadRemote();
      return undefined;
    }
    const io = new window.IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); loadRemote(); }
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [profile, remoteState, loadRemote]);

  const missing = useMemo(() => {
    if (!Array.isArray(remote) || !remote.length) return [];
    const owned = new Set();
    for (const t of artist?.tracks || []) {
      const n = normRelease(t.album);
      if (n) owned.add(n);
    }
    /* A track with no album tag counts as owning the single of the same name —
       that's how a loose rip lines up with Spotify's single release.
       Restricted to UNTAGGED tracks on purpose: matching every track title
       would let one song off an album mark the whole album as owned, which
       hides a real gap. */
    for (const t of artist?.tracks || []) {
      if ((t.album || '').trim()) continue;
      const n = normRelease(t.title);
      if (n) owned.add(n);
    }
    const seen = new Set();
    const out = [];
    for (const r of remote) {
      const n = normRelease(r.name);
      if (!n || owned.has(n) || seen.has(n)) continue;
      seen.add(n);
      out.push(r);
    }
    /* Records before one-offs — a missing album is a real gap, a missing
       single usually isn't. Newest first within each. */
    const rank = (r) => (r.albumGroup === 'single' || r.totalTracks === 1 ? 1 : 0);
    out.sort((a, b) => rank(a) - rank(b) || String(b.releaseDate).localeCompare(String(a.releaseDate)));
    return out;
  }, [remote, artist]);

  /* ---- Header condenses once the hero scrolls past --------------------- */
  const onScroll = useCallback((e) => {
    setStuck(e.currentTarget.scrollTop > HERO_H - 72);
  }, []);

  if (!artist) return null;

  const albums = artist.albums || [];
  const singles = artist.singles || [];
  const appearsOn = artist.appearsOn || [];
  const totalMs = (artist.totalSec || 0) * 1000;
  const runtime = formatTotalMs(totalMs);
  const currentId = currentTrack?.id;

  const playAll = (list, shuffle = false) => {
    const src = list && list.length ? list : artist.tracks;
    if (!src || !src.length) return;
    const ordered = shuffle ? [...src].sort(() => Math.random() - 0.5) : src;
    onPlayTrack?.(ordered[0], ordered);
  };

  const statLine = [
    albums.length ? `${albums.length} album${albums.length === 1 ? '' : 's'}` : null,
    `${artist.tracks.length} song${artist.tracks.length === 1 ? '' : 's'}`,
    runtime,
    totalPlays ? `${totalPlays.toLocaleString()} play${totalPlays === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div style={{
      position: 'relative', flex: 1, minWidth: 0, minHeight: 0, height: '100%',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <style>{`
        @keyframes sthArtistIn { 0% { opacity: 0; transform: translateY(10px); } 100% { opacity: 1; transform: none; } }
        /* Full-bleed means full-bleed: a scrollbar gutter would hold the hero
           off the right edge by its own width. The app's main scroller
           (.sth-scroll) already hides its bar for the same reason, so this
           matches rather than invents. */
        .sth-artistscroll { scrollbar-width: none; -ms-overflow-style: none; }
        .sth-artistscroll::-webkit-scrollbar { width: 0; height: 0; display: none; }
        /* Header tools stay out of the way until you go looking for them. */
        .sth-artist-hero-tools { opacity: 0; transition: opacity 0.16s ease; }
        .sth-artist:hover .sth-artist-hero-tools,
        .sth-artist-hero-tools:focus-within { opacity: 1; }
        .sth-artist-editbtn { display: inline-flex; align-items: center; gap: 7px; height: 28px; padding: 0 12px;
          border-radius: 999px; border: 1px solid rgba(255,255,255,0.16); background: rgba(0,0,0,0.46);
          backdrop-filter: blur(10px); color: rgba(255,255,255,0.86); font: inherit; font-size: 11.5px;
          font-weight: 700; cursor: pointer; transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease; }
        .sth-artist-editbtn:hover { background: rgba(0,0,0,0.64); color: #fff; border-color: rgba(255,255,255,0.3); }
        .sth-artist-editbtn.is-on { background: rgba(255,255,255,0.9); color: #101014; border-color: transparent; }
        .sth-artist-editbtn.is-on:hover { background: #fff; color: #101014; }
        .sth-artist-zoom { display: inline-flex; align-items: center; gap: 8px; height: 28px; padding: 0 12px;
          border-radius: 999px; border: 1px solid rgba(255,255,255,0.16); background: rgba(0,0,0,0.46);
          backdrop-filter: blur(10px); color: rgba(255,255,255,0.7); }
        .sth-artist-zoom input { width: 92px; accent-color: #fff; cursor: pointer; }
        @media (prefers-reduced-motion: reduce) { .sth-artist * { animation: none !important; } }
      `}</style>

      {/* Back — floats top-right, exactly where the album page keeps it, so
          the two pages have one close gesture in one place. */}
      <button type="button" onClick={onBack} title="Back" aria-label="Back"
        style={{
          position: 'absolute', top: 14, right: 16, zIndex: 5,
          width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: '50%', border: 'none', cursor: 'pointer',
          background: 'rgba(0,0,0,0.34)', color: 'rgba(var(--st-text-rgb), 0.85)',
        }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
      </button>

      <div ref={scrollRef} onScroll={onScroll} className="sth-artist sth-artistscroll"
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>

        {/* ---- Hero -------------------------------------------------------
            One layer: the photo, full width, `cover`.

            A square source can't fill a wide band without losing its top and
            bottom — the two are different shapes, and `cover` resolves that by
            cropping. What IS adjustable is how much of the image survives and
            which part: a taller band keeps a taller slice, and HERO_FOCUS
            decides where that slice is taken from. 32% sits on the face for
            most press shots, which are framed with the head high.

            No photo → the newest cover, blurred, as a colour field. */}
        <header ref={heroRef} style={{ position: 'relative', height: HERO_H, flexShrink: 0, overflow: 'hidden' }}>
          <div aria-hidden style={{
            position: 'absolute', inset: 0,
            backgroundImage: heroSrc
              ? `url("${String(heroSrc).replace(/"/g, '%22')}")`
              : `linear-gradient(150deg, rgba(${wash},0.85), rgba(${wash},0.3))`,
            backgroundRepeat: 'no-repeat',
            /* Zoom is the background's SIZE, not a transform on the layer.
               A transform scales the whole band and leaves the image with no
               more room to travel than it had before, so panning stayed stuck
               however far you zoomed. Sized this way, zooming past 100% makes
               the picture genuinely wider than the band — which is what gives
               left/right its slack. Width-driven, so `auto` keeps the aspect. */
            backgroundSize: heroSrc
              ? (sizeByWidth ? `${Math.round(frame.zoom * 100)}% auto` : `auto ${Math.round(frame.zoom * 100)}%`)
              : 'cover',
            backgroundPosition: `${frame.focusX}% ${frame.focusY}%`,
            filter: heroSrc && !heroIsPhoto ? 'blur(26px) saturate(1.3)' : 'none',
            transform: heroSrc && !heroIsPhoto ? 'scale(1.1)' : 'none',
            transition: dragRef.current ? 'none' : 'background-size 0.16s ease',
          }} />
          <div aria-hidden style={{
            position: 'absolute', inset: 0,
            background: `linear-gradient(180deg, rgba(${deep},0.10) 0%, rgba(${deep},0.28) 40%, rgba(${wash},0.58) 76%, rgba(${wash},0.88) 100%)`,
            opacity: editing ? 0.35 : 1,
            transition: 'opacity 0.2s ease',
          }} />

          {/* Drag surface. Only present while editing, so a normal click on
              the hero never turns into an accidental reposition. */}
          {editing ? (
            <div onMouseDown={onDragStart}
              style={{ position: 'absolute', inset: 0, cursor: 'grab', zIndex: 2 }}
              title="Drag to reposition" />
          ) : null}

          {/* Edit affordance — appears on hover, like the playlist cover. */}
          <div className="sth-artist-hero-tools" style={{
            position: 'absolute', top: 14, left: 30, zIndex: 3,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            {!editing ? (
              <button type="button" className="sth-artist-editbtn" onClick={() => setEditing(true)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>
                Edit header
              </button>
            ) : (
              <>
                <button type="button" className="sth-artist-editbtn is-on" onClick={() => fileRef.current?.click()}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></svg>
                  {heroIsCustom ? 'Replace image' : 'Upload image'}
                </button>
                <label className="sth-artist-zoom" title="Zoom">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5M8 11h6" /></svg>
                  <input type="range" min="100" max="300" step="1"
                    value={Math.round(frame.zoom * 100)}
                    onChange={(e) => {
                      const next = { ...frame, image: override?.image || null, zoom: Number(e.target.value) / 100 };
                      draftRef.current = next;
                      setDraft(next);
                    }}
                    /* Commit from the ref, not from `frame` — `frame` is the
                       value this render closed over, which is one step behind
                       the slider by the time the mouse comes up. */
                    onMouseUp={() => { const d = draftRef.current; draftRef.current = null; setDraft(null); if (d) saveHeader(d); }}
                    onKeyUp={() => { const d = draftRef.current; draftRef.current = null; setDraft(null); if (d) saveHeader(d); }}
                  />
                </label>
                {override ? (
                  <button type="button" className="sth-artist-editbtn" onClick={resetHeader} title="Back to the fetched image and framing">
                    Reset
                  </button>
                ) : null}
                <button type="button" className="sth-artist-editbtn is-on" onClick={() => { setEditing(false); setDraft(null); }}>
                  Done
                </button>
              </>
            )}
            <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
              onChange={(e) => { pickImage(e.target.files?.[0]); e.target.value = ''; }} />
          </div>

          <div style={{ position: 'absolute', left: 30, right: 30, bottom: 26, zIndex: 1, animation: 'sthArtistIn 0.42s cubic-bezier(0.22,0.9,0.3,1) both' }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.13em', textTransform: 'uppercase', color: 'rgba(var(--st-sub-rgb), 0.6)' }}>
              Artist
            </div>
            <h1 style={{
              fontSize: 'clamp(38px, 5.2vw, 66px)', fontWeight: 900, letterSpacing: '-0.035em',
              lineHeight: 0.94, margin: '10px 0 0', color: 'var(--st-text)',
              textShadow: '0 4px 30px rgba(0,0,0,0.5)',
            }}>{name}</h1>
            <div style={{ marginTop: 14, fontSize: 13.5, fontWeight: 650, color: 'rgba(var(--st-text-rgb), 0.78)' }}>
              {statLine}
            </div>
          </div>
        </header>

        {/* ---- Body ---- */}
        <div style={{
          position: 'relative', paddingBottom: 60, minHeight: `calc(100% - ${HERO_H}px)`,
          background: `linear-gradient(180deg, rgba(${wash},0.88) 0%, rgba(${wash},0.5) 16%, rgba(${wash},0.3) 44%, rgba(${wash},0.24) 100%), rgba(${deep},0.78)`,
        }}>

          {/* Action bar. Sticks to the top of the scroller and takes on a
              backdrop + the artist's name once the hero is gone — so the
              controls never leave and you never lose track of whose page
              you're on. */}
          <div style={{
            position: 'sticky', top: 0, zIndex: 4,
            display: 'flex', alignItems: 'center', gap: 14, padding: '16px 30px',
            background: stuck ? `rgba(${deep},0.82)` : 'transparent',
            backdropFilter: stuck ? 'blur(18px) saturate(1.3)' : 'none',
            boxShadow: stuck ? 'inset 0 -1px 0 rgba(var(--st-fg-rgb), 0.07)' : 'none',
            transition: 'background 0.2s ease, box-shadow 0.2s ease',
          }}>
            <button type="button" onClick={() => playAll(topTracks)} title="Play" aria-label="Play"
              style={{
                width: 52, height: 52, borderRadius: '50%', border: 'none', cursor: 'pointer', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: `rgb(${pageAcc})`, color: accentTextColor(pageAcc),
                boxShadow: `0 6px 22px rgba(${pageAcc},0.5)`,
                transition: 'transform 0.16s cubic-bezier(0.22,0.9,0.3,1)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.06)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; }}>
              <PlayIcon size={19} />
            </button>

            <ActionBtn title="Shuffle" onClick={() => playAll(artist.tracks, true)}>
              <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
            </ActionBtn>

            {/* Following here is the SAME follow the releases feed uses — one
                concept with two doors, not a second list to keep in sync. */}
            {onToggleFollow ? (
              <PillBtn on={following} onClick={() => onToggleFollow(name)}>
                {following ? 'Following' : 'Follow'}
              </PillBtn>
            ) : null}

            <div style={{ flex: 1 }} />
            <span style={{
              fontSize: 17, fontWeight: 850, letterSpacing: '-0.02em', color: 'var(--st-text)',
              opacity: stuck ? 1 : 0, transform: stuck ? 'none' : 'translateY(4px)',
              transition: 'opacity 0.2s ease, transform 0.2s ease', pointerEvents: 'none',
              marginRight: 34, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '40%',
            }}>{name}</span>
          </div>

          <div style={{ padding: '0 30px' }}>

            {/* ---- Top tracks ------------------------------------------ */}
            {topTracks.length ? (
              <>
                <SectionHead
                  title="Your top tracks"
                  sub={totalPlays ? 'by plays, all time' : 'nothing played yet'}
                />
                <div>
                  {(showAllTracks ? topTracks : topTracks.slice(0, 5)).map((t, i) => (
                    <TrackRow
                      key={t.id} n={i + 1} track={t} art={t.coverArt}
                      plays={playCounts.get(t.id) || 0}
                      playing={currentId === t.id} isPlaying={isPlaying} accent={pageAccUI}
                      onPlay={() => onPlayTrack?.(t, topTracks)} onTogglePlay={onTogglePlay}
                    />
                  ))}
                </div>
                {topTracks.length > 5 ? (
                  <div style={{ marginTop: 14 }}>
                    <PillBtn onClick={() => setShowAllTracks((v) => !v)}>
                      {showAllTracks ? 'Show less' : `Show all ${topTracks.length} songs`}
                    </PillBtn>
                  </div>
                ) : null}
              </>
            ) : null}

            {/* ---- Albums ---------------------------------------------- */}
            {albums.length ? (
              <>
                <SectionHead title="Albums" sub={`${albums.length} in your library`} />
                <CardGrid>
                  {albums.map((g) => (
                    <ReleaseCard
                      key={g.key} art={g.art} name={g.name} accent={pageAcc}
                      meta={`${g.year ? `${g.year} · ` : ''}${g.tracks.length} song${g.tracks.length === 1 ? '' : 's'}`}
                      onClick={() => onOpenAlbum?.(g.key)}
                    />
                  ))}
                </CardGrid>
              </>
            ) : null}

            {/* ---- Singles & EPs ----------------------------------------
                The Albums grid hides one-track groups on purpose — they're
                usually a loose download whose tag carries an album name. On
                the artist's own page they're part of the catalogue, so this
                is the one view where they surface. */}
            {singles.length ? (
              <>
                <SectionHead title="Singles &amp; EPs" sub="loose tracks and short releases" />
                <CardGrid>
                  {singles.map((g) => (
                    <ReleaseCard
                      key={g.key} art={g.art} name={g.name} accent={pageAcc}
                      meta={g.tracks.length > 1
                        ? `${g.year ? `${g.year} · ` : ''}${g.tracks.length} songs`
                        : `${g.year ? `${g.year} · ` : ''}${fmtDur(g.tracks[0]?.duration) || 'Single'}`}
                      onClick={() => onPlayTrack?.(g.tracks[0], g.tracks)}
                    />
                  ))}
                </CardGrid>
              </>
            ) : null}

            {/* ---- Appears on -------------------------------------------
                Records where this artist is credited but isn't the primary.
                The grouping splitter throws these credits away; this is where
                the tail of the string gets a use. */}
            {appearsOn.length ? (
              <>
                <SectionHead title="Appears on" sub="features and collaborations" />
                <CardGrid>
                  {appearsOn.map((g) => (
                    <ReleaseCard
                      key={g.key} art={g.art} name={g.name} accent={pageAcc}
                      meta={`${g.artist} · ${g.count} track${g.count === 1 ? '' : 's'}`}
                      onClick={() => onOpenAlbum?.(g.key)}
                    />
                  ))}
                </CardGrid>
              </>
            ) : null}

            {/* ---- Not in your library ----------------------------------
                Always states its case. Three different situations used to
                render as one blank space — no Spotify link, still checking,
                and genuinely nothing missing are very different answers, and
                silence made a working feature look broken. */}
            {(() => {
              const a = api();
              const canCheck = !!a?.spotifyArtistAlbums;
              const note = (text) => (
                <div style={{ padding: '2px 0 4px', fontSize: 12.5, fontWeight: 600, color: 'rgba(var(--st-sub-rgb), 0.38)' }}>
                  {text}
                </div>
              );
              return (
                <div ref={missingRef}>
                  <SectionHead
                    title="Not in your library"
                    sub={missing.length
                      ? `${missing.length} release${missing.length === 1 ? '' : 's'} you don't have`
                      : undefined}
                  />
                  {missing.length ? (
                    <CardGrid>
                      {missing.slice(0, 24).map((r) => (
                        <ReleaseCard
                          key={r.albumId || r.name} missing art={r.albumArtUrl || null}
                          name={r.name || 'Untitled'} accent={pageAcc}
                          meta={[
                            (r.releaseDate || '').slice(0, 4),
                            r.totalTracks >= 2 ? `${r.totalTracks} songs` : 'Single',
                          ].filter(Boolean).join(' · ')}
                          onClick={() => onJumpToFind?.(`${name} ${r.name || ''}`.trim(), 'spotify')}
                        />
                      ))}
                    </CardGrid>
                  ) : !canCheck
                    ? note('Connect Spotify in Settings to see what you\u2019re missing.')
                    : remoteState === 'loading'
                      ? note('Checking the rest of their catalogue\u2026')
                      : profileState === 'loading'
                        ? note('Looking this artist up\u2026')
                        : !profile?.id
                          ? note(`Couldn\u2019t match ${name} on Spotify, so there\u2019s nothing to compare against.`)
                          : remoteState === 'done' && Array.isArray(remote) && !remote.length
                            ? note('Spotify lists no releases for this artist.')
                            : remoteState === 'idle'
                              ? note('Scroll down to check the rest of their catalogue.')
                              : note('You have every release Spotify lists for them.')}
                </div>
              );
            })()}

            {/* ---- Empty state ------------------------------------------ */}
            {!topTracks.length && !albums.length && !singles.length ? (
              <div style={{ padding: '60px 0', textAlign: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'rgba(var(--st-text-rgb), 0.7)' }}>
                  Nothing from {name} yet
                </div>
                <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 600, color: 'rgba(var(--st-sub-rgb), 0.4)' }}>
                  Search for them in Find to start a collection.
                </div>
              </div>
            ) : null}

            {/* Genres sit at the FOOT of the page, not in the header. They
                describe the artist rather than help you act on them, and up
                top they competed with the name for the same glance. */}
            {genres.length ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 40 }}>
                {genres.map((g) => (
                  <span key={g} style={{
                    fontSize: 11.5, fontWeight: 650, padding: '5px 12px', borderRadius: 999,
                    background: 'rgba(var(--st-fg-rgb), 0.09)',
                    border: '1px solid rgba(var(--st-fg-rgb), 0.08)',
                    color: 'rgba(var(--st-text-rgb), 0.7)',
                  }}>{g}</span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
