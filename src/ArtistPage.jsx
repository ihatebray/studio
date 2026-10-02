import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { PreviewButton, stop as stopPreview } from './previewPlayer.jsx';
import { sampleImageTheme, isFallbackTheme, recordWashSource, pageWash, readableAccent, accentTextColor } from './coverTheme.js';
import { PlayIcon } from './sharedUI.jsx';
import { formatTotalMs } from './mediaUtils.js';

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
/* Discography cards shown before "Show all". Two rows at typical widths. */
const DISC_PAGE = 12;
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

/* Song-level match between a Spotify title and a library title. Featured
   credits and "- 2011 Remaster" tails are how the same recording ends up
   with two names, so both are dropped before comparing. */
function normSong(title) {
  return normRelease(String(title || '')
    .replace(/[([](feat|ft|with)\.?\s[^)\]]*[)\]]/gi, '')
    .replace(/\s-\s.*\b(remaster(ed)?|version|edit|mix|live)\b.*$/i, ''));
}

function Note({ children }) {
  return (
    <div style={{ padding: '2px 0 4px', fontSize: 12.5, fontWeight: 600, color: 'rgba(var(--st-sub-rgb), 0.38)' }}>
      {children}
    </div>
  );
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


/* ---- Spotify pieces ------------------------------------------------------
   Everything below renders data from the signed-in Spotify account
   (spotifyPartner.js). Each one is built from the page's existing parts —
   the TrackRow grid, SectionHead, the card treatment — so the Spotify
   sections read as more of the same page, not a panel bolted onto it. */

const fmtCount = (n) => (Number.isFinite(n) && n > 0 ? Math.round(n).toLocaleString() : '');
const fmtMs = (ms) => (ms ? fmtDur(ms / 1000) : '');

/* Column layout shared by the header and every row, so the labels sit
   exactly over the values they name. */
const POP_COLS = '28px 44px minmax(0, 1fr) 128px 52px 138px';

function PopularHeader({ plays = true }) {
  const cell = { fontSize: 10.5, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(var(--st-sub-rgb), 0.42)' };
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: POP_COLS, gap: 14, alignItems: 'center',
      padding: '0 12px 9px', marginBottom: 6, boxShadow: 'inset 0 -1px 0 rgba(var(--st-fg-rgb), 0.08)',
    }}>
      <span style={{ ...cell, textAlign: 'right' }}>#</span>
      <span />
      <span style={cell}>Title</span>
      <span style={{ ...cell, textAlign: 'right' }} title="All-time streams on Spotify">{plays ? 'Spotify plays' : ''}</span>
      <span style={{ ...cell, textAlign: 'right', display: 'flex', justifyContent: 'flex-end' }} title="Length">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
      </span>
      <span />
    </div>
  );
}

/** The action cell. Owned rows say so; everything else downloads in place,
 *  with the same busy / done / retry states the search panel uses. */
function GetCell({ owned, dl, progress, accent, onGet }) {
  if (owned) {
    return (
      <span title="In your library" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: 'rgba(140,220,160,0.9)' }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
        In library
      </span>
    );
  }
  if (dl === 'busy') {
    const pct = typeof progress?.pct === 'number' ? Math.round(progress.pct * 100) : null;
    return (
      <span style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 84 }} title="Saving">
        <span style={{ height: 4, borderRadius: 2, background: 'rgba(var(--st-fg-rgb), 0.12)', overflow: 'hidden' }}>
          <span style={{ display: 'block', height: '100%', width: `${pct ?? 30}%`, background: `rgb(${accent})`, transition: 'width 0.24s ease' }} />
        </span>
        <span style={{ fontSize: 10, fontWeight: 650, color: 'rgba(var(--st-sub-rgb), 0.55)', fontVariantNumeric: 'tabular-nums' }}>
          {progress?.phase === 'processing' ? 'Processing…' : pct != null ? `${pct}%` : 'Saving…'}
        </span>
      </span>
    );
  }
  if (dl === 'done') {
    return <span style={{ fontSize: 11.5, fontWeight: 700, color: 'rgba(140,220,160,0.9)' }}>Added</span>;
  }
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); onGet?.(); }}
      style={{
        height: 26, padding: '0 13px', borderRadius: 999, cursor: 'pointer', font: 'inherit',
        fontSize: 11.5, fontWeight: 750, border: `1px solid rgba(${accent}, 0.45)`,
        background: `rgba(${accent}, 0.14)`, color: 'var(--st-text)',
      }}>
      {dl === 'failed' ? 'Retry' : 'Save'}
    </button>
  );
}

/** One row of the artist's Popular list: rank, cover, title over album,
 *  all-time Spotify plays, length, and what you can do with it. */
function PopularRow({ n, t, owned, playing, isPlaying, accent, dl, progress, onPlay, onGet }) {
  const [hot, setHot] = useState(false);
  const act = () => (owned ? onPlay() : onGet?.());
  return (
    <div role="button" tabIndex={0} onClick={act}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } }}
      onMouseEnter={() => setHot(true)} onMouseLeave={() => setHot(false)}
      style={{
        display: 'grid', gridTemplateColumns: POP_COLS, gap: 14, alignItems: 'center',
        padding: '6px 12px', borderRadius: 9, cursor: 'pointer',
        background: hot ? 'rgba(var(--st-fg-rgb), 0.055)' : 'transparent',
        transition: 'background 0.13s ease',
      }}>
      <span style={{
        textAlign: 'right', fontSize: 13, fontWeight: 650, fontVariantNumeric: 'tabular-nums',
        color: playing ? `rgb(${accent})` : `rgba(var(--st-sub-rgb), ${hot ? 0.85 : 0.4})`,
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
      }}>
        {hot && owned ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            {playing && isPlaying
              ? <><rect x="6.5" y="5" width="3.6" height="14" rx="1.1" /><rect x="13.9" y="5" width="3.6" height="14" rx="1.1" /></>
              : <path d="M8 6.5v11l9.5-5.5z" />}
          </svg>
        ) : n}
      </span>
      <span style={{
        width: 44, height: 44, borderRadius: 6, flexShrink: 0,
        background: t.albumArtUrl ? `url("${String(t.albumArtUrl).replace(/"/g, '%22')}") center/cover` : 'rgba(var(--st-fg-rgb), 0.07)',
      }} />
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <span style={{
            fontSize: 13.5, fontWeight: 650, minWidth: 0,
            color: playing ? `rgb(${accent})` : 'var(--st-text)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{t.title}</span>
          {t.explicit ? (
            <span aria-label="Explicit" title="Explicit" style={{
              flexShrink: 0, fontSize: 9, fontWeight: 800, lineHeight: 1, padding: '3px 4px', borderRadius: 3,
              background: 'rgba(var(--st-fg-rgb), 0.16)', color: 'rgba(var(--st-text-rgb), 0.75)',
            }}>E</span>
          ) : null}
        </span>
        {t.album ? (
          <span style={{
            display: 'block', marginTop: 3, fontSize: 12, fontWeight: 600, color: 'rgba(var(--st-sub-rgb), 0.48)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{t.album}</span>
        ) : null}
      </span>
      <span style={{
        textAlign: 'right', fontSize: 12.5, fontWeight: 650, fontVariantNumeric: 'tabular-nums',
        color: 'rgba(var(--st-text-rgb), 0.7)',
      }}>{fmtCount(t.playcount)}</span>
      <span style={{
        textAlign: 'right', fontSize: 12.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
        color: 'rgba(var(--st-sub-rgb), 0.45)',
      }}>{fmtMs(t.durationMs)}</span>
      <span style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
        {!owned && dl !== 'busy' && dl !== 'done' ? (
          <PreviewButton pkey={`pv:${t.spotifyId || t.title}`} accent={accent}
            track={{ title: t.title, artists: t.artists, durationMs: t.durationMs, explicit: t.explicit }} />
        ) : null}
        <GetCell owned={owned} dl={dl} progress={progress} accent={accent} onGet={onGet} />
      </span>
    </div>
  );
}

/** A release in the discography grid. Every release looks like a record —
 *  the page is the artist's catalogue, not a list of gaps — and the ones you
 *  already have carry a small "In library" mark. */
function DiscCard({ r, owned, accent, onClick, opensTracklist = false, open = false }) {
  const [hot, setHot] = useState(false);
  const kind = r.group === 'appears_on' ? (r.artists || 'Appears on')
    : r.type === 'compilation' || r.group === 'compilation' ? 'Compilation'
      : r.group === 'single' ? (r.totalTracks > 1 ? 'EP' : 'Single') : 'Album';
  const meta = [r.year || String(r.releaseDate || '').slice(0, 4), kind].filter(Boolean).join(' · ');
  return (
    <button type="button" onClick={onClick}
      title={opensTracklist ? `Open ${r.name} — see the tracklist and get what you're missing` : owned ? `Open ${r.name}` : `Find ${r.name}`}
      onMouseEnter={() => setHot(true)} onMouseLeave={() => setHot(false)}
      style={{
        border: 'none', background: 'transparent', cursor: 'pointer', font: 'inherit', textAlign: 'left',
        padding: 0, display: 'flex', flexDirection: 'column', alignItems: 'stretch', minWidth: 0,
      }}>
      <div style={{
        position: 'relative', width: '100%', aspectRatio: '1', borderRadius: 9, overflow: 'hidden',
        background: r.albumArtUrl ? `url("${String(r.albumArtUrl).replace(/"/g, '%22')}") center/cover` : 'rgba(var(--st-fg-rgb), 0.07)',
        boxShadow: `${hot || open ? '0 16px 34px rgba(0,0,0,0.5)' : '0 10px 26px rgba(0,0,0,0.4)'}${open ? `, 0 0 0 2px rgb(${readableAccent(accent)})` : ''}`,
        transform: hot || open ? 'translateY(-3px)' : 'none',
        transition: 'transform 0.22s cubic-bezier(0.22,0.9,0.3,1), box-shadow 0.22s ease',
      }}>
        {owned ? (
          <span title="In your library" style={{
            position: 'absolute', left: 8, top: 8, display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '4px 8px', borderRadius: 999, fontSize: 10.5, fontWeight: 750,
            background: 'rgba(0,0,0,0.62)', color: 'rgba(160,235,180,0.95)', backdropFilter: 'blur(8px)',
          }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
            In library
          </span>
        ) : null}
        <span style={{
          position: 'absolute', right: 9, bottom: 9, width: 36, height: 36, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `rgb(${accent})`, color: accentTextColor(accent),
          boxShadow: '0 6px 16px rgba(0,0,0,0.45)',
          opacity: hot ? 1 : 0, transform: hot ? 'none' : 'translateY(7px)',
          transition: 'opacity 0.18s ease, transform 0.18s ease',
        }}>
          {opensTracklist ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round"><path d="M4 6h11M4 12h11M4 18h7M19 15v6M16 18h6" /></svg>
          ) : owned ? <PlayIcon size={14} /> : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></svg>
          )}
        </span>
      </div>
      <div style={{
        fontSize: 13, fontWeight: 750, marginTop: 10, lineHeight: 1.25, color: 'var(--st-text)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{r.name}</div>
      <div style={{
        fontSize: 11.5, fontWeight: 600, color: 'rgba(var(--st-fg-rgb), 0.5)', marginTop: 3, lineHeight: 1.25,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{meta}{r.totalTracks > 1 ? ` · ${r.totalTracks} songs` : ''}</div>
    </button>
  );
}

/** A problem with where the page's data comes from, said plainly, with the
 *  one thing you can do about it. */
function IssueBanner({ title, detail, action }) {
  return (
    <div role="status" style={{
      display: 'flex', alignItems: 'center', gap: 16, marginTop: 22, padding: '14px 16px',
      borderRadius: 12, background: 'rgba(255, 170, 60, 0.08)', border: '1px solid rgba(255, 170, 60, 0.28)',
    }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgb(255,190,110)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <path d="M12 3l9.5 17h-19z" /><path d="M12 10v4.5M12 17.5v.5" />
      </svg>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 750, color: 'var(--st-text)' }}>{title}</div>
        {detail ? <div style={{ marginTop: 3, fontSize: 12.5, fontWeight: 600, lineHeight: 1.5, color: 'rgba(var(--st-sub-rgb), 0.62)' }}>{detail}</div> : null}
      </div>
      {action}
    </div>
  );
}

function StatBlock({ value, label }) {
  if (!value) return null;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 22, fontWeight: 850, letterSpacing: '-0.02em', color: 'var(--st-text)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(var(--st-sub-rgb), 0.45)', marginTop: 3 }}>{label}</div>
    </div>
  );
}

/** Bio, headline numbers and where the listeners are. The bio clamps to four
 *  lines; the whole card is the toggle, since it's the only thing it does. */
function AboutCard({ data, image, accent }) {
  const [open, setOpen] = useState(false);
  const bio = data.biography || '';
  const long = bio.length > 320;
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: image ? 'minmax(0, 220px) minmax(0, 1fr)' : 'minmax(0, 1fr)', gap: 0,
      borderRadius: 14, overflow: 'hidden',
      background: 'rgba(var(--st-fg-rgb), 0.045)', border: '1px solid rgba(var(--st-fg-rgb), 0.07)',
    }}>
      {image ? (
        <div aria-hidden style={{
          minHeight: 220, background: `url("${String(image).replace(/"/g, '%22')}") center/cover`,
        }} />
      ) : null}
      <div style={{ padding: '20px 22px', minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
          <StatBlock value={fmtCount(data.monthlyListeners)} label="Monthly listeners" />
          <StatBlock value={fmtCount(data.followers)} label="Followers" />
          <StatBlock value={data.worldRank ? `#${data.worldRank.toLocaleString()}` : ''} label="In the world" />
        </div>
        {bio ? (
          <div
            role={long ? 'button' : undefined} tabIndex={long ? 0 : undefined}
            onClick={long ? () => setOpen((v) => !v) : undefined}
            onKeyDown={long ? (e) => { if (e.key === 'Enter') setOpen((v) => !v); } : undefined}
            style={{
              marginTop: 18, fontSize: 13, lineHeight: 1.65, fontWeight: 500,
              color: 'rgba(var(--st-text-rgb), 0.74)', cursor: long ? 'pointer' : 'default',
              display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: open ? 'unset' : 4, overflow: 'hidden',
            }}>
            {bio}
          </div>
        ) : null}
        {long ? (
          <button type="button" onClick={() => setOpen((v) => !v)} style={{
            marginTop: 6, padding: 0, border: 'none', background: 'none', cursor: 'pointer', font: 'inherit',
            fontSize: 12, fontWeight: 700, color: `rgba(${accent}, 0.95)`,
          }}>{open ? 'Show less' : 'Read more'}</button>
        ) : null}
        {data.topCities?.length ? (
          <div style={{ marginTop: 22 }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(var(--st-sub-rgb), 0.45)', marginBottom: 8 }}>
              Top cities
            </div>
            <div style={{ display: 'grid', gap: 2 }}>
              {data.topCities.map((c, i) => (
                <div key={`${c.city}-${c.country}`} style={{ display: 'grid', gridTemplateColumns: '18px minmax(0, 1fr) auto', gap: 10, alignItems: 'baseline', padding: '5px 0' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'rgba(var(--st-sub-rgb), 0.4)', fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
                  <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--st-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.city}<span style={{ color: 'rgba(var(--st-sub-rgb), 0.45)', fontWeight: 600 }}>{c.country ? `, ${c.country}` : ''}</span>
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'rgba(var(--st-sub-rgb), 0.55)' }}>
                    {fmtCount(c.listeners)} listeners
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RelatedArtist({ a, inLibrary, onClick }) {
  const [hot, setHot] = useState(false);
  return (
    <button type="button" onClick={onClick} title={a.name}
      onMouseEnter={() => setHot(true)} onMouseLeave={() => setHot(false)}
      style={{
        border: 'none', background: 'transparent', cursor: 'pointer', font: 'inherit', padding: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0,
      }}>
      <span style={{
        width: '100%', aspectRatio: '1', borderRadius: '50%',
        background: a.image ? `url("${String(a.image).replace(/"/g, '%22')}") center/cover` : 'rgba(var(--st-fg-rgb), 0.07)',
        boxShadow: hot ? '0 12px 28px rgba(0,0,0,0.5)' : '0 6px 18px rgba(0,0,0,0.35)',
        transform: hot ? 'translateY(-3px)' : 'none',
        transition: 'transform 0.22s cubic-bezier(0.22,0.9,0.3,1), box-shadow 0.22s ease',
      }} />
      <span style={{
        marginTop: 10, fontSize: 13, fontWeight: 750, color: 'var(--st-text)', maxWidth: '100%',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{a.name}</span>
      <span style={{ marginTop: 2, fontSize: 11.5, fontWeight: 600, color: inLibrary ? 'rgba(140,220,160,0.8)' : 'rgba(var(--st-fg-rgb), 0.45)' }}>
        {inLibrary ? 'In your library' : 'Artist'}
      </span>
    </button>
  );
}

/* ---- Releases opened in place (the full page) -------------------------
 * Outside the search panel, a release you don't own opens right under its
 * row of cards instead of sending you to search: cover, Play / Shuffle /
 * Save all, and the tracklist, each song playable straight away and
 * savable on its own. A notch points up at the card it belongs to. */

const releaseTracksCache = new Map();   // albumId → rows

const GRID_GAP = 22;

/** The discography grid, with room for one open release after the row that
 *  holds it. Measures its own column count so the panel lands after the
 *  right card, whatever the window's width. */
function DiscGrid({ items, keyOf, openKey, renderCard, renderOpen }) {
  const ref = useRef(null);
  const [cols, setCols] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setCols(Math.max(1, getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const at = openKey == null ? -1 : items.findIndex((r) => keyOf(r) === openKey);
  const rowEnd = at < 0 ? -1 : Math.min(items.length - 1, Math.floor(at / cols) * cols + cols - 1);
  const col = at < 0 ? 0 : at % cols;
  const notch = `calc((100% - ${(cols - 1) * GRID_GAP}px) / ${cols} * ${col + 0.5} + ${col * GRID_GAP}px)`;
  return (
    <div ref={ref} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(158px, 1fr))', gap: `26px ${GRID_GAP}px` }}>
      {items.map((r, i) => (
        <React.Fragment key={keyOf(r)}>
          {renderCard(r)}
          {i === rowEnd ? renderOpen(items[at], notch) : null}
        </React.Fragment>
      ))}
    </div>
  );
}

const relKind = (r) => (r.group === 'appears_on' ? 'Appears on'
  : r.type === 'compilation' || r.group === 'compilation' ? 'Compilation'
    : r.group === 'single' ? (r.totalTracks > 1 ? 'EP' : 'Single') : 'Album');

function ReleaseInline({ release, notch, accent, bridge, artistName, onClose, onOpenLibrary = null }) {
  const id = release.albumId;
  const [rows, setRows] = useState(() => releaseTracksCache.get(id) || null);
  const [err, setErr] = useState('');
  const boxRef = useRef(null);

  useEffect(() => {
    setRows(releaseTracksCache.get(id) || null);
    setErr('');
    if (releaseTracksCache.has(id)) return undefined;
    let live = true;
    Promise.resolve(api()?.spotifyGetAlbumTracks?.(id)).then((r) => {
      if (r?.ok === false) throw new Error(r.error || 'Couldn’t load this release.');
      const list = (r?.tracks || r?.data?.tracks || []).map((t) => ({
        ...t, albumId: id, album: t.album || release.name, albumArtUrl: t.albumArtUrl || release.albumArtUrl,
      }));
      releaseTracksCache.set(id, list);
      if (live) setRows(list);
    }).catch((e) => { if (live) setErr(String(e?.message || e)); });
    return () => { live = false; };
  }, [id, release]);

  // Bring it into view once it opens (only as far as needed).
  useEffect(() => {
    const t = setTimeout(() => boxRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60);
    return () => clearTimeout(t);
  }, [id]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const context = { kind: 'album', id, name: release.name, sub: `${relKind(release)} · ${release.artists || artistName}`, image: release.albumArtUrl || null };
  const totalMs = (rows || []).reduce((n, t) => n + (t.durationMs || 0), 0);
  const unsaved = (rows || []).filter((t) => !bridge.saveState(t));
  const year = release.year || String(release.releaseDate || '').slice(0, 4);
  const haveCount = (rows || []).filter((t) => bridge.saveState(t) === 'saved').length;
  const two = (rows?.length || 0) >= 10;

  return (
    <div className="apx-rel" ref={boxRef} style={{ '--apx-notch': notch, '--apx-acc': accent }}>
      <div className="apx-rel-card">
        <div className="apx-rel-side">
          <div className="apx-rel-cover" style={{ backgroundImage: release.albumArtUrl ? `url("${String(release.albumArtUrl).replace(/"/g, '%22')}")` : 'none' }} />
          <div className="apx-rel-eyebrow">{[relKind(release), year].filter(Boolean).join(' · ')}</div>
          <div className="apx-rel-title">{release.name}</div>
          <div className="apx-rel-meta">
            {release.artists || artistName}
            {rows?.length ? ` · ${rows.length} song${rows.length === 1 ? '' : 's'} · ${Math.max(1, Math.round(totalMs / 60000))} min` : ''}
          </div>
          {haveCount ? (
            <div className="apx-rel-have">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6L9 17l-5-5" /></svg>
              {haveCount === rows.length ? 'All in your library' : `${haveCount} of ${rows.length} in your library`}
            </div>
          ) : null}
          <div className="apx-rel-actions">
            <button type="button" className="apx-btn is-primary" disabled={!rows?.length}
              onClick={() => bridge.playRows(rows, 0, { context })}>
              <PlayIcon size={12} /> Play
            </button>
            <button type="button" className="apx-btn" disabled={!rows?.length} title="Shuffle"
              onClick={() => bridge.playRows(rows, 0, { shuffle: true, context })}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></svg>
            </button>
            {onOpenLibrary ? (
              <button type="button" className="apx-btn" onClick={onOpenLibrary} title="Open your copy of this album">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 19V5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z" /><path d="M8 7h6" /></svg>
                In library
              </button>
            ) : null}
            {unsaved.length > 1 ? (
              <button type="button" className="apx-btn" onClick={() => unsaved.forEach((t) => bridge.saveRow(t))} title="Add every song here to your library">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
                Save all
              </button>
            ) : null}
          </div>
        </div>

        <div className={`apx-rel-list${two ? ' is-two' : ''}`} style={two ? { '--apx-rows': Math.ceil(rows.length / 2) } : null}>
          {err ? <div className="apx-rel-note">{err}</div> : null}
          {!rows && !err ? Array.from({ length: Math.min(8, release.totalTracks || 6) }, (_, i) => <div key={i} className="apx-rel-sk" />) : null}
          {rows && !rows.length ? <div className="apx-rel-note">No songs to show for this one.</div> : null}
          {(rows || []).map((t, i) => {
            const on = bridge.isCurrent(t);
            const st = bridge.saveState(t);
            const feat = t.artists && t.artists !== (release.artists || artistName) ? t.artists : '';
            return (
              <div key={`${t.spotifyId}:${i}`} className={`apx-trk${on ? ' is-on' : ''}`} role="button" tabIndex={0}
                onClick={() => bridge.playRows(rows, i, { context })}
                onKeyDown={(e) => { if (e.key === 'Enter') bridge.playRows(rows, i, { context }); }}
                {...(bridge.hoverProps?.(t) || {})}>
                <span className="n">
                  {on && bridge.isPlaying ? <span className="apx-eq"><i /><i /><i /></span> : <span className="num">{i + 1}</span>}
                  <span className="pl"><PlayIcon size={11} /></span>
                </span>
                <span className="tt">
                  <span className="t">{t.explicit ? <span className="e">E</span> : null}{t.title}</span>
                  {feat ? <span className="a">{feat}</span> : null}
                </span>
                <span className="d">{fmtDur((t.durationMs || 0) / 1000)}</span>
                {st === 'saved' ? (
                  <span className="sv is-saved" title="In your library">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6L9 17l-5-5" /></svg>
                  </span>
                ) : st === 'busy' ? (
                  <span className="sv is-busy" title="Saving…"><span className="apx-spin" /></span>
                ) : (
                  <button type="button" className="sv" title="Save to your library" aria-label={`Save ${t.title}`}
                    onClick={(e) => { e.stopPropagation(); bridge.saveRow(t); }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <button type="button" className="apx-rel-x" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>
    </div>
  );
}

const RELEASE_INLINE_CSS = `
.apx-rel { grid-column: 1 / -1; position: relative; margin: -8px 0 4px; animation: apxRelIn 0.32s cubic-bezier(0.22,1,0.36,1) both; }
@keyframes apxRelIn { from { opacity: 0; transform: translateY(-8px); } }
/* The notch: points up at the card this belongs to. */
.apx-rel::before { content: ''; position: absolute; top: -7px; left: var(--apx-notch); width: 14px; height: 14px; margin-left: -7px;
  transform: rotate(45deg); border-radius: 3px 0 0 0; background: rgb(var(--st-bg-rgb));
  background-image: linear-gradient(135deg, rgba(var(--apx-acc), 0.2), rgba(var(--apx-acc), 0.2));
  box-shadow: -1px -1px 0 rgba(var(--st-fg-rgb), 0.1); transition: left 0.24s cubic-bezier(0.22,1,0.36,1); }
.apx-rel-card { position: relative; container-type: inline-size; display: grid; grid-template-columns: 224px minmax(0, 1fr); gap: 28px;
  padding: 22px 22px 18px; border-radius: 16px; overflow: hidden;
  background: linear-gradient(135deg, rgba(var(--apx-acc), 0.2) 0%, rgba(var(--apx-acc), 0.05) 45%, rgba(var(--st-fg-rgb), 0.025) 100%);
  box-shadow: inset 0 0 0 1px rgba(var(--st-fg-rgb), 0.1), 0 18px 40px rgba(0,0,0,0.28); }
.apx-rel-side { display: flex; flex-direction: column; min-width: 0; }
.apx-rel-cover { width: 100%; aspect-ratio: 1; border-radius: 10px; background: rgba(var(--st-fg-rgb), 0.07) center/cover no-repeat;
  box-shadow: 0 14px 34px rgba(0,0,0,0.45); margin-bottom: 14px; }
.apx-rel-eyebrow { font-size: 10.5px; font-weight: 750; letter-spacing: 0.09em; text-transform: uppercase; color: rgba(var(--st-sub-rgb), 0.55); }
.apx-rel-title { margin-top: 4px; font-size: 19px; font-weight: 800; letter-spacing: -0.015em; line-height: 1.15; color: var(--st-text);
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.apx-rel-meta { margin-top: 5px; font-size: 12px; color: rgba(var(--st-sub-rgb), 0.55); line-height: 1.45; }
.apx-rel-have { display: inline-flex; align-items: center; gap: 6px; margin-top: 8px; width: fit-content; padding: 3px 9px; border-radius: 999px;
  font-size: 11px; font-weight: 700; background: rgba(123,224,176,0.12); color: rgb(123,224,176); }
.apx-rel-actions { display: flex; gap: 6px; margin-top: 14px; flex-wrap: wrap; }
.apx-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; height: 32px; min-width: 32px; padding: 0 12px; border-radius: 8px;
  border: none; cursor: pointer; font-family: inherit; font-size: 12.5px; font-weight: 700; white-space: nowrap;
  background: rgba(var(--st-fg-rgb), 0.08); color: var(--st-text); transition: background 0.15s ease, filter 0.15s ease; }
.apx-btn:hover { background: rgba(var(--st-fg-rgb), 0.14); }
.apx-btn.is-primary { background: rgb(var(--apx-acc)); color: #0b0b0c; }
.apx-btn.is-primary:hover { filter: brightness(1.08); background: rgb(var(--apx-acc)); }
.apx-btn:disabled { opacity: 0.45; cursor: default; }
.apx-rel-list { min-width: 0; align-self: start; }
@container (min-width: 760px) {
  .apx-rel-list.is-two { display: grid; grid-auto-flow: column; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-rows: repeat(var(--apx-rows), auto); column-gap: 18px; }
}
@container (max-width: 560px) {
  .apx-rel-card { grid-template-columns: minmax(0, 1fr); }
  .apx-rel-cover { width: 132px; }
}
.apx-trk { display: grid; grid-template-columns: 26px minmax(0, 1fr) 42px 28px; align-items: center; gap: 10px; height: 40px; padding: 0 6px 0 8px;
  border-radius: 8px; cursor: pointer; transition: background 0.12s ease; }
.apx-trk:hover { background: rgba(var(--st-fg-rgb), 0.06); }
.apx-trk .n { position: relative; display: flex; align-items: center; font-size: 12px; font-variant-numeric: tabular-nums; color: rgba(var(--st-sub-rgb), 0.45); }
.apx-trk .n .pl { display: none; color: var(--st-text); }
.apx-trk:hover .n .num, .apx-trk:hover .n .apx-eq { display: none; }
.apx-trk:hover .n .pl { display: flex; }
.apx-trk .tt { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.apx-trk .t { font-size: 13.5px; font-weight: 600; color: var(--st-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 1; min-width: 0; }
.apx-trk.is-on .t { color: rgb(var(--apx-acc)); }
.apx-trk .a { font-size: 12px; color: rgba(var(--st-sub-rgb), 0.45); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex-shrink: 2; }
.apx-trk .e { display: inline-block; margin-right: 6px; padding: 0 4px; border-radius: 3px; font-size: 9px; font-weight: 800; line-height: 14px;
  background: rgba(var(--st-fg-rgb), 0.16); color: rgba(var(--st-fg-rgb), 0.7); vertical-align: 1px; }
.apx-trk .d { font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; color: rgba(var(--st-sub-rgb), 0.45); }
.apx-trk .sv { width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; padding: 0; cursor: pointer;
  border: 1px solid rgba(var(--st-fg-rgb), 0.16); background: transparent; color: rgba(var(--st-fg-rgb), 0.6); opacity: 0; transition: opacity 0.12s ease, background 0.12s ease; }
.apx-trk:hover .sv, .apx-trk .sv.is-saved, .apx-trk .sv.is-busy { opacity: 1; }
.apx-trk .sv:hover { background: rgba(var(--st-fg-rgb), 0.1); color: var(--st-text); }
.apx-trk .sv.is-saved { border-color: transparent; background: rgba(123,224,176,0.12); color: rgb(123,224,176); cursor: default; }
.apx-eq { display: inline-flex; align-items: flex-end; gap: 2px; height: 12px; color: rgb(var(--apx-acc)); }
.apx-eq i { width: 2.5px; border-radius: 1px; background: currentColor; animation: apxEq 0.9s ease-in-out infinite; }
.apx-eq i:nth-child(2) { animation-delay: -0.3s; } .apx-eq i:nth-child(3) { animation-delay: -0.6s; }
@keyframes apxEq { 0%, 100% { height: 3px; } 50% { height: 12px; } }
.apx-spin { width: 11px; height: 11px; border-radius: 50%; border: 1.6px solid rgba(var(--st-fg-rgb), 0.2); border-top-color: var(--st-text); animation: apxSpin 0.7s linear infinite; }
@keyframes apxSpin { to { transform: rotate(360deg); } }
.apx-rel-sk { height: 30px; margin: 5px 0; border-radius: 8px; background: linear-gradient(90deg, rgba(var(--st-fg-rgb),0.04), rgba(var(--st-fg-rgb),0.09), rgba(var(--st-fg-rgb),0.04));
  background-size: 200% 100%; animation: apxSk 1.4s ease-in-out infinite; }
@keyframes apxSk { from { background-position: 100% 0; } to { background-position: -100% 0; } }
.apx-rel-note { padding: 10px 8px; font-size: 12.5px; color: rgba(var(--st-sub-rgb), 0.55); }
.apx-rel-x { position: absolute; top: 12px; right: 12px; width: 28px; height: 28px; border-radius: 8px; border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center; background: transparent; color: rgba(var(--st-fg-rgb), 0.5); }
.apx-rel-x:hover { background: rgba(var(--st-fg-rgb), 0.1); color: var(--st-text); }
@media (prefers-reduced-motion: reduce) { .apx-rel, .apx-eq i, .apx-rel-sk { animation: none; } }
`;

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
  onOpenRelated,          // (name) → that artist's page if you have them, search if not
  hasArtist,              // (name) → boolean, for "In your library" on related artists
  onConnectSpotify,       // () → Settings → Connections
  dlState = {},           // download state by key (`s:<spotifyId>`), shared with search
  dlProgress = {},
  onGetTrack,             // (spotifyRow) → download it
  ownedTrackFor,          // (title, artists) → the library track, or null
  embedded = false,       // rendered inside the search panel: no back button, no header editing
  onOpenRelease,          // (spotifyRelease) → open it in place (the panel's album frame)
  onOpenFullPage,         // () → leave the panel for the full artist page
  spotifyBridge = null,   // the full page: play / save Spotify rows (StudioHome's My Spotify bridge)
}) {
  const [profile, setProfile] = useState(() => {
    const c = cachedProfile(artist?.key || '');
    return c === undefined ? null : c;
  });
  const [profileState, setProfileState] = useState('idle'); // idle | loading | done
  const [remote, setRemote] = useState(null);   // spotifyArtistAlbums result
  const [remoteState, setRemoteState] = useState('idle');
  const [stuck, setStuck] = useState(false);
  const scrollRef = useRef(null);



  const name = artist?.name || 'Unknown artist';
  /* The page's identity: the artist's name, lowercased. NOT artist.key,
     which is `sp:<id>` for someone not in your library and their name once
     they are, so saving one of their songs changed it mid-visit: the page
     reloaded everything (the "random refresh" on Save), and a header saved
     under one key was looked for under the other and never found. */
  const key = String(artist?.name || '').trim().toLowerCase() || artist?.key || '';

  /* ---- Spotify account data --------------------------------------------
   * Only when the full Spotify account is connected (Settings → Connections).
   * `sp.status`: off | loading | done | nomatch | error. The overview is cached
   * for an hour in the main process, so flipping between pages is free. */
  const [spConnected, setSpConnected] = useState(false);
  const [sp, setSp] = useState({ status: 'off', data: null, error: '' });
  const [showAllPopular, setShowAllPopular] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => () => stopPreview(), []);
  const [disc, setDisc] = useState({ status: 'idle', list: null });
  const [discTab, setDiscTab] = useState('album');
  const [discAll, setDiscAll] = useState(false);
  // The release open in place on the full page (its albumId).
  const [openRel, setOpenRel] = useState(null);
  const closeRel = useCallback(() => setOpenRel(null), []);
  useEffect(() => { setOpenRel(null); }, [key]);
  const spData = sp.status === 'done' ? sp.data : null;
  useEffect(() => {
    const a = api();
    if (!a?.spotifyPartnerState) return undefined;
    a.spotifyPartnerState().then((st) => setSpConnected(!!st?.connected)).catch(() => {});
    const off = a.onSpotifyPartnerChanged?.((st) => setSpConnected(!!st?.connected));
    return () => off?.();
  }, []);

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
      .then((res) => {
        if (dead) return;
        const h = res?.headers || {};
        // Headers saved before the key was the name live under the old one.
        const legacy = [artist?.key, artist?.spotifyId ? `sp:${artist.spotifyId}` : null, `sp:${key}`].filter(Boolean);
        setOverride(h[key] || legacy.map((k) => h[k]).find(Boolean) || null);
      })
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
  /* Spotify's own header art (the wide banner on the artist's page) beats
     everything fetched, since it's the image the artist chose for exactly this
     shape. The remaining chain is unchanged. */
  const heroSrc = override?.image || spData?.header || profile?.header || profile?.image || spData?.avatar || artist?.art || null;
  /* A real photo is shown as-is. The album-cover fallback is blurred, because
     stretching a 300px cover across the band is exactly the artefact this
     whole change exists to remove. A chosen image is never blurred — if you
     picked it, you meant it. */
  const heroIsPhoto = !!(override?.image || spData?.header || profile?.header || profile?.image || spData?.avatar);
  const heroIsCustom = !!override?.image;

  /* Default framing depends on what kind of picture we ended up with. Wide
     header art is already composed for a band, so it centres. A square avatar
     has to be pushed up onto the face — that's what HERO_FOCUS is for. */
  const autoFocusY = (spData?.header || profile?.header) ? 50 : parseFloat(HERO_FOCUS);
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

  /* Save whatever framing is pending. The slider used to save only on a
     mouseup over the slider itself, so letting go anywhere else (or pressing
     Done straight after) dropped the change. */
  const draftRef = useRef(null);
  const commitDraft = useCallback(() => {
    const d = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (d) saveHeader(d);
  }, [saveHeader]);

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

  /* ---- Spotify overview --------------------------------------------------
   * Needs a Spotify artist ID. The profile lookup above usually has one; an
   * iTunes-sourced profile doesn't, and then the signed-in account searches
   * for the name itself. Waits for the profile so it doesn't search for an ID
   * that's a moment away from arriving. */
  const knownSpotifyId = artist?.spotifyId
    || (/^[0-9A-Za-z]{22}$/.test(String(profile?.id || '')) ? profile.id : null);
  useEffect(() => {
    setShowAllPopular(false);
    if (!spConnected || !key) { setSp({ status: 'off', data: null, error: '' }); return undefined; }
    if (profileState === 'loading' && !artist?.spotifyId) return undefined;
    const a = api();
    if (!a?.spotifyPartnerArtist) return undefined;
    let dead = false;
    setSp((cur) => (cur.data?.name && cur.status === 'done' && cur.forKey === key ? cur : { status: 'loading', data: null, error: '' }));
    (async () => {
      let id = knownSpotifyId;
      if (!id) {
        const f = await a.spotifyPartnerFindArtist(name).catch((e) => ({ ok: false, error: String(e) }));
        if (dead) return;
        if (f?.ok && f.data?.id) id = f.data.id;
        /* A failed lookup is an error, not "not on Spotify" — a rate limit
           here used to read as "Couldn't find X on Spotify". */
        else if (f && f.ok === false) {
          setSp({ status: 'error', data: null, error: f.error || 'Spotify did not answer', step: f.step, retryAfter: f.retryAfter, id: null });
          return;
        }
      }
      if (dead) return;
      if (!id) { setSp({ status: 'nomatch', data: null, error: '' }); return; }
      const r = await a.spotifyPartnerArtist(id).catch((e) => ({ ok: false, error: String(e) }));
      if (dead) return;
      if (r?.ok && r.data) setSp({ status: 'done', data: r.data, error: '', forKey: key, id });
      else setSp({ status: 'error', data: null, error: r?.error || 'Spotify did not answer', step: r?.step, retryAfter: r?.retryAfter, id });
    })();
    return () => { dead = true; };
  }, [spConnected, key, name, knownSpotifyId, profileState, retry, artist?.spotifyId]);

  /* A short rate limit retries itself when it lifts; a long one waits for
     the Try again button rather than keeping a timer alive for an hour. */
  /* Once per visit: retrying after every short wait kept a page asking
     every minute while Spotify kept saying wait. */
  const autoRetried = useRef(false);
  useEffect(() => { autoRetried.current = false; }, [key]);
  useEffect(() => {
    if (sp.status !== 'error' || sp.step !== 'ratelimit' || !sp.retryAfter || sp.retryAfter > 180) return undefined;
    if (autoRetried.current) return undefined;
    const t = setTimeout(() => { autoRetried.current = true; setRetry((n) => n + 1); }, (sp.retryAfter + 1) * 1000);
    return () => clearTimeout(t);
  }, [sp]);

  /* Fallback Popular: when the overview failed but the artist is known,
     their top tracks from a different endpoint (no play counts, but the
     right songs in the right order). */
  const [fbTop, setFbTop] = useState(null);
  useEffect(() => {
    setFbTop(null);
    const a = api();
    if (sp.status !== 'error' || !sp.id || !a?.spotifyArtistTopTracks) return undefined;
    let dead = false;
    /* Main's artist route: the playback helper's session first. (This used
       the Web API, whose shared quota is what was rate-limited.) */
    a.spotifyArtistTopTracks(sp.id, name).then((r) => {
      const rows = Array.isArray(r) ? r : (r?.ok ? r.data : null);
      if (!dead && Array.isArray(rows)) setFbTop(rows);
    }).catch(() => {});
    return () => { dead = true; };
  }, [sp.status, sp.id, name]);

  /* The complete discography, after the overview is up. Until it lands the
     grid shows the releases the overview already carried. */
  const spId = spData?.id || sp.id || null;
  useEffect(() => {
    setDiscAll(false);
    const id = spId;
    const a = api();
    if (!id || !a?.spotifyPartnerDiscography) { setDisc({ status: 'idle', list: null }); return undefined; }
    let dead = false;
    setDisc({ status: 'loading', list: null });
    a.spotifyPartnerDiscography(id)
      .then((r) => { if (!dead) setDisc(r?.ok ? { status: 'done', list: r.data || [] } : { status: 'error', list: null, error: r?.error || '' }); })
      .catch((e) => { if (!dead) setDisc({ status: 'error', list: null, error: String(e?.message || e) }); });
    return () => { dead = true; };
  }, [spId]);
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


  const totalPlays = useMemo(
    () => (artist?.tracks || []).reduce((n, t) => n + (playCounts.get(t.id) || 0), 0),
    [artist, playCounts],
  );


  /* ---- Catalogue you don't own ------------------------------------------
   * Only fetched on demand: it's a second network call per artist and most
   * visits to this page are to play something, not to shop. */
  const loadRemote = useCallback(async () => {
    /* With the Spotify account connected the overview already carries the
       whole discography, so the ten paged Web API calls this makes are
       skipped entirely. */
    if (spData || sp.status === 'loading') return;
    if (remoteState !== 'idle' || !profile?.id) return;
    const a = api();
    if (!a?.spotifyArtistAlbums) return;
    setRemoteState('loading');
    try {
      const res = await a.spotifyArtistAlbums(profile.id);
      setRemote(Array.isArray(res) ? res : []);
    } catch { setRemote([]); }
    setRemoteState('done');
  }, [remoteState, profile, spData, sp.status]);

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

  /* If the Spotify account was expected to supply the discography and then
     failed, fall back to the Web API route instead of leaving the section on
     its loading note. */
  useEffect(() => {
    if (sp.status === 'error' && (disc.status === 'error' || disc.status === 'idle') && remoteState === 'idle' && profile?.id) loadRemote();
  }, [sp.status, disc.status, remoteState, profile, loadRemote]);



  /* Spotify's Popular list, each row matched to a library track if you have
     it — a match plays, a miss goes to search. */
  const popular = useMemo(() => {
    const byTitle = new Map();
    for (const t of artist?.tracks || []) {
      const k = normSong(t.title);
      if (k && !byTitle.has(k)) byTitle.set(k, t);
    }
    const src = spData?.topTracks || (sp.status === 'error' ? fbTop : null) || [];
    return src.map((t) => ({
      t,
      lib: ownedTrackFor?.(t.title, t.artists || name) || byTitle.get(normSong(t.title)) || null,
    }));
  }, [spData, fbTop, sp.status, artist, ownedTrackFor, name]);
  const hasPlays = popular.some((p) => p.t.playcount);

  const popularOwned = useMemo(() => popular.filter((p) => p.lib).map((p) => p.lib), [popular]);

  /* Play: the popular songs you own, in popular order, then everything else
     of theirs you have. */
  const playable = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const t of [...popularOwned, ...(artist?.tracks || [])]) {
      if (!t || seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
    return out;
  }, [popularOwned, artist]);
  const playQueue = (shuffle) => {
    if (!playable.length) return;
    const list = shuffle ? [...playable].sort(() => Math.random() - 0.5) : playable;
    onPlayTrack?.(list[0], list);
  };
  const getTrack = onGetTrack || null;
  const missingPopular = useMemo(
    () => popular.filter((p) => !p.lib && dlState?.[`s:${p.t.spotifyId}`] !== 'busy' && dlState?.[`s:${p.t.spotifyId}`] !== 'done').map((p) => p.t),
    [popular, dlState],
  );

  /* ---- Discography ---------------------------------------------------- */
  /* Account discography → the overview's releases → the Client ID route
     (the old "not in your library" source). Whichever answered. */
  const discSource = useMemo(() => {
    if (Array.isArray(disc.list) && disc.list.length) return disc.list;
    if (spData) {
      return [
        ...(spData.albums || []), ...(spData.singles || []),
        ...(spData.compilations || []), ...(spData.appearsOn || []),
      ];
    }
    if (Array.isArray(remote) && remote.length) {
      return remote.map((r) => ({ ...r, group: r.albumGroup || r.group || 'album', year: r.releaseDate ? Number(String(r.releaseDate).slice(0, 4)) : null }));
    }
    return [];
  }, [disc.list, spData, remote]);
  const discGroups = useMemo(() => {
    const g = { album: [], single: [], compilation: [], appears_on: [] };
    for (const r of discSource) {
      const k = r.group === 'appears_on' ? 'appears_on'
        : (r.group === 'compilation' || r.type === 'compilation') ? 'compilation'
          : r.group === 'single' ? 'single' : 'album';
      g[k].push(r);
    }
    return g;
  }, [discSource]);
  const discTabs = [
    ['album', 'Albums', discGroups.album.length],
    ['single', 'Singles & EPs', discGroups.single.length],
    ['compilation', 'Compilations', discGroups.compilation.length],
    ['appears_on', 'Appears on', discGroups.appears_on.length],
  ].filter(([, , n]) => n > 0);
  /* Land on the first non-empty group — an artist with only singles
     shouldn't open on an empty Albums tab. */
  useEffect(() => {
    if (discTabs.length && !discTabs.some(([id]) => id === discTab)) setDiscTab(discTabs[0][0]);
  }, [discTabs.map((x) => x[0]).join(','), discTab]); // eslint-disable-line react-hooks/exhaustive-deps
  const discList = discGroups[discTab] || [];
  const discShown = discAll ? discList : discList.slice(0, DISC_PAGE);

  /* A Spotify release you already have, matched by name against this
     artist's library records. */
  const ownedReleaseIndex = useMemo(() => {
    const m = new Map();
    for (const g of [...(artist?.albums || []), ...(artist?.singles || []), ...(artist?.appearsOn || [])]) {
      const k = normRelease(g.name);
      if (k && !m.has(k)) m.set(k, g);
    }
    return m;
  }, [artist]);
  const ownedRelease = (r) => ownedReleaseIndex.get(normRelease(r.name)) || null;


  /* ---- Header condenses once the hero scrolls past --------------------- */
  const onScroll = useCallback((e) => {
    setStuck(e.currentTarget.scrollTop > HERO_H - 72);
  }, []);

  if (!artist) return null;

  const albums = artist.albums || [];
  const singles = artist.singles || [];
  const totalMs = (artist.totalSec || 0) * 1000;
  const runtime = formatTotalMs(totalMs);
  const currentId = currentTrack?.id;


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
      <style>{RELEASE_INLINE_CSS}</style>
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
          the two pages have one close gesture in one place. The search panel
          has its own back (the crumb), so the embedded view doesn't. */}
      {!embedded ? <button type="button" onClick={onBack} title="Back" aria-label="Back"
        style={{
          position: 'absolute', top: 14, right: 16, zIndex: 5,
          width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: '50%', border: 'none', cursor: 'pointer',
          background: 'rgba(0,0,0,0.34)', color: 'rgba(var(--st-text-rgb), 0.85)',
        }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
      </button> : null}

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
            display: embedded ? 'none' : 'flex', alignItems: 'center', gap: 8,
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
                    onPointerUp={commitDraft}
                    onKeyUp={commitDraft}
                    onBlur={commitDraft}
                  />
                </label>
                {override ? (
                  <button type="button" className="sth-artist-editbtn" onClick={resetHeader} title="Back to the fetched image and framing">
                    Reset
                  </button>
                ) : null}
                <button type="button" className="sth-artist-editbtn is-on" onClick={() => { commitDraft(); setEditing(false); }}>
                  Done
                </button>
              </>
            )}
            <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
              onChange={(e) => { pickImage(e.target.files?.[0]); e.target.value = ''; }} />
          </div>

          <div style={{ position: 'absolute', left: 30, right: 30, bottom: 26, zIndex: 1, animation: 'sthArtistIn 0.42s cubic-bezier(0.22,0.9,0.3,1) both' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 10.5, fontWeight: 800, letterSpacing: '0.13em', textTransform: 'uppercase', color: 'rgba(var(--st-sub-rgb), 0.6)' }}>
              {spData?.verified ? (
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
                  <path fill={`rgb(${pageAccUI})`} d="M12 2l2.4 2.1 3.2-.3.9 3.1 2.8 1.6-1.1 3 1.1 3-2.8 1.6-.9 3.1-3.2-.3L12 22l-2.4-2.1-3.2.3-.9-3.1-2.8-1.6 1.1-3-1.1-3 2.8-1.6.9-3.1 3.2.3z" />
                  <path d="M8 12.2l2.7 2.6L16.2 9.4" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : null}
              {spData?.verified ? 'Verified artist' : 'Artist'}
            </div>
            <h1 style={{
              fontSize: 'clamp(38px, 5.2vw, 66px)', fontWeight: 900, letterSpacing: '-0.035em',
              lineHeight: 0.94, margin: '10px 0 0', color: 'var(--st-text)',
              textShadow: '0 4px 30px rgba(0,0,0,0.5)',
            }}>{name}</h1>
            {spData?.monthlyListeners ? (
              <div style={{ marginTop: 14, fontSize: 15, fontWeight: 750, color: 'var(--st-text)', textShadow: '0 2px 16px rgba(0,0,0,0.45)', fontVariantNumeric: 'tabular-nums' }}>
                {fmtCount(spData.monthlyListeners)} monthly listeners
              </div>
            ) : null}
            <div style={{ marginTop: spData?.monthlyListeners ? 5 : 14, fontSize: 13.5, fontWeight: 650, color: 'rgba(var(--st-text-rgb), 0.78)' }}>
              {spConnected
                ? (artist.tracks.length
                  ? `${artist.tracks.length} song${artist.tracks.length === 1 ? '' : 's'} in your library`
                  : 'Nothing in your library yet')
                : statLine}
            </div>
          </div>
        </header>

        {/* ---- Body ---- */}
        <div style={{
          position: 'relative', paddingBottom: 60, minHeight: `calc(100% - ${HERO_H}px)`,
          background: `linear-gradient(180deg, rgba(${wash},0.88) 0%, rgba(${wash},0.5) 16%, rgba(${wash},0.3) 44%, rgba(${wash},0.24) 100%), rgba(${deep},0.78)`,
        }}>

          {/* Action bar. Sticks once the hero is gone and takes the name. */}
          <div style={{
            position: 'sticky', top: 0, zIndex: 4,
            display: 'flex', alignItems: 'center', gap: 14, padding: '16px 30px',
            background: stuck ? `rgba(${deep},0.82)` : 'transparent',
            backdropFilter: stuck ? 'blur(18px) saturate(1.3)' : 'none',
            boxShadow: stuck ? 'inset 0 -1px 0 rgba(var(--st-fg-rgb), 0.07)' : 'none',
            transition: 'background 0.2s ease, box-shadow 0.2s ease',
          }}>
            <button type="button" onClick={() => playQueue(false)} disabled={!playable.length}
              title={playable.length ? 'Play' : 'None of their songs are in your library yet'}
              aria-label="Play"
              style={{
                width: 52, height: 52, borderRadius: '50%', border: 'none', flexShrink: 0,
                cursor: playable.length ? 'pointer' : 'default',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: playable.length ? `rgb(${pageAcc})` : 'rgba(var(--st-fg-rgb), 0.12)',
                color: playable.length ? accentTextColor(pageAcc) : 'rgba(var(--st-fg-rgb), 0.4)',
                boxShadow: playable.length ? `0 6px 22px rgba(${pageAcc},0.5)` : 'none',
                transition: 'transform 0.16s cubic-bezier(0.22,0.9,0.3,1)',
              }}
              onMouseEnter={(e) => { if (playable.length) e.currentTarget.style.transform = 'scale(1.06)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; }}>
              <PlayIcon size={19} />
            </button>

            {playable.length > 1 ? (
              <ActionBtn title="Shuffle" onClick={() => playQueue(true)}>
                <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
              </ActionBtn>
            ) : null}

            {onToggleFollow ? (
              <PillBtn on={following} onClick={() => onToggleFollow(name)}>
                {following ? 'Following' : 'Follow'}
              </PillBtn>
            ) : null}

            {/* One click for every popular song you don't have yet. */}
            {getTrack && missingPopular.length ? (
              <PillBtn onClick={() => missingPopular.forEach((t) => getTrack(t))}>
                {`Save ${missingPopular.length} popular song${missingPopular.length === 1 ? '' : 's'}`}
              </PillBtn>
            ) : null}

            <div style={{ flex: 1 }} />
            {embedded && onOpenFullPage ? (
              <PillBtn onClick={onOpenFullPage}>Open full page</PillBtn>
            ) : null}
            <span style={{
              display: embedded ? 'none' : undefined,
              fontSize: 17, fontWeight: 850, letterSpacing: '-0.02em', color: 'var(--st-text)',
              opacity: stuck ? 1 : 0, transform: stuck ? 'none' : 'translateY(4px)',
              transition: 'opacity 0.2s ease, transform 0.2s ease', pointerEvents: 'none',
              marginRight: 34, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '40%',
            }}>{name}</span>
          </div>

          <div style={{ padding: '0 30px' }}>

            {/* ---- Not connected ------------------------------------------ */}
            {!spConnected ? (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 16, marginTop: 22, padding: '16px 18px',
                borderRadius: 12, background: 'rgba(var(--st-fg-rgb), 0.05)', border: '1px solid rgba(var(--st-fg-rgb), 0.08)',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 750, color: 'var(--st-text)' }}>
                    Connect Spotify to see {name}&apos;s page
                  </div>
                  <div style={{ marginTop: 4, fontSize: 12.5, fontWeight: 600, color: 'rgba(var(--st-sub-rgb), 0.5)' }}>
                    Popular songs with play counts, the full discography, monthly listeners and similar artists.
                  </div>
                </div>
                {onConnectSpotify ? <PillBtn onClick={onConnectSpotify}>Connect Spotify</PillBtn> : null}
              </div>
            ) : null}

            {spConnected && sp.status === 'loading' ? (
              <>
                <SectionHead title="Popular" />
                <div aria-hidden>
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: POP_COLS, gap: 14, alignItems: 'center', padding: '6px 12px' }}>
                      <span />
                      <span style={{ width: 44, height: 44, borderRadius: 6, background: 'rgba(var(--st-fg-rgb), 0.07)' }} />
                      <span style={{ display: 'grid', gap: 6 }}>
                        <span style={{ height: 11, width: `${58 - i * 7}%`, borderRadius: 4, background: 'rgba(var(--st-fg-rgb), 0.08)' }} />
                        <span style={{ height: 9, width: '30%', borderRadius: 4, background: 'rgba(var(--st-fg-rgb), 0.05)' }} />
                      </span>
                      <span /><span /><span />
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {spConnected && sp.status === 'error' ? (
              <IssueBanner
                title={sp.step === 'ratelimit' ? 'Spotify is rate-limiting this account' : sp.step === 'signin' ? 'Your Spotify session ended' : 'Spotify didn\u2019t answer'}
                detail={[
                  sp.error,
                  (popular.length || discSource.length)
                    ? 'Showing what could still be loaded; play counts, listeners and the About section come back when Spotify does.'
                    : '',
                  sp.step === 'ratelimit' && sp.retryAfter && sp.retryAfter <= 180 ? 'This page retries on its own when the limit lifts.' : '',
                ].filter(Boolean).join(' ')}
                action={sp.step === 'signin' && onConnectSpotify
                  ? <PillBtn onClick={onConnectSpotify}>Sign in again</PillBtn>
                  : <PillBtn onClick={() => setRetry((n) => n + 1)}>Try again</PillBtn>}
              />
            ) : null}

            {spConnected && sp.status === 'nomatch' ? (
              <div style={{ marginTop: 26 }}><Note>Couldn&apos;t find {name} on Spotify.</Note></div>
            ) : null}

            {/* ---- Popular -------------------------------------------------- */}
            {popular.length ? (
              <>
                <SectionHead
                  title="Popular"
                  sub={[
                    popularOwned.length ? `${popularOwned.length} of ${popular.length} in your library` : '',
                    !hasPlays ? 'play counts unavailable right now' : '',
                  ].filter(Boolean).join(' \u00b7 ') || undefined}
                />
                <PopularHeader plays={hasPlays} />
                <div>
                  {(showAllPopular ? popular : popular.slice(0, 5)).map(({ t, lib }, i) => (
                    <PopularRow
                      key={t.spotifyId || i} n={i + 1} t={t} owned={!!lib}
                      playing={!!lib && currentId === lib.id} isPlaying={isPlaying}
                      accent={pageAccUI}
                      dl={dlState?.[`s:${t.spotifyId}`]} progress={dlProgress?.[`s:${t.spotifyId}`]}
                      onPlay={() => {
                        if (currentId === lib.id && onTogglePlay) onTogglePlay();
                        else onPlayTrack?.(lib, popularOwned);
                      }}
                      onGet={getTrack ? () => getTrack(t) : () => onJumpToFind?.(`${name} ${t.title}`, 'spotify')}
                    />
                  ))}
                </div>
                {popular.length > 5 ? (
                  <div style={{ marginTop: 14 }}>
                    <PillBtn onClick={() => setShowAllPopular((v) => !v)}>
                      {showAllPopular ? 'Show less' : `Show ${popular.length - 5} more`}
                    </PillBtn>
                  </div>
                ) : null}
              </>
            ) : null}

            {/* ---- Discography ---------------------------------------------- */}
            {spConnected && discTabs.length ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '40px 0 16px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.015em', color: 'var(--st-text)' }}>Discography</span>
                  <div role="tablist" aria-label="Release type" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {discTabs.map(([id, label, n]) => (
                      <PillBtn key={id} on={discTab === id} onClick={() => setDiscTab(id)}>
                        {label}<span style={{ marginLeft: 6, opacity: 0.55, fontVariantNumeric: 'tabular-nums' }}>{n}</span>
                      </PillBtn>
                    ))}
                  </div>
                  {disc.status === 'loading' ? (
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(var(--st-sub-rgb), 0.42)' }}>loading the full catalogue…</span>
                  ) : null}
                </div>
                <DiscGrid
                  items={discShown}
                  keyOf={(r) => r.albumId || r.name}
                  openKey={openRel}
                  renderOpen={(r, notch) => {
                    const own = ownedRelease(r);
                    return (
                      <ReleaseInline key={`open:${r.albumId}`} release={r} notch={notch} accent={pageAccUI}
                        bridge={spotifyBridge} artistName={name} onClose={closeRel}
                        onOpenLibrary={own && (own.tracks?.length || 0) > 1 ? () => onOpenAlbum?.(own.key) : null} />
                    );
                  }}
                  renderCard={(r) => {
                    const own = ownedRelease(r);
                    /* Opens in place: in the search panel, its album frame;
                       on the full page, right under this row of cards. */
                    /* Every release with a Spotify id opens here, owned or
                       not: the tracklist marks what you have (and plays your
                       copies), and an owned album keeps a way to its page. */
                    const inline = !onOpenRelease && !!spotifyBridge && !!r.albumId;
                    return (
                      <DiscCard r={r} owned={!!own} accent={pageAcc} opensTracklist={!!onOpenRelease || inline}
                        open={inline && openRel === r.albumId}
                        onClick={() => {
                          /* In the search panel every release opens its tracklist
                             there — owned or not — so you can see what you have and
                             Get the rest. Playing an owned single instead left no way
                             to reach the other tracks. */
                          if (onOpenRelease) { onOpenRelease(r); return; }
                          if (inline) {
                            setOpenRel((cur) => (cur === r.albumId ? null : r.albumId));
                          } else if (own) {
                            /* A one-track record in the library is a loose single,
                               which has no album page — play it instead. */
                            if ((own.tracks?.length || 0) === 1) onPlayTrack?.(own.tracks[0], own.tracks);
                            else onOpenAlbum?.(own.key);
                          } else {
                            onJumpToFind?.(`${r.group === 'appears_on' ? '' : `${name} `}${r.name}`.trim(), 'spotify');
                          }
                        }} />
                    );
                  }}
                />
                {discList.length > DISC_PAGE && !discAll ? (
                  <div style={{ marginTop: 18 }}>
                    <PillBtn onClick={() => setDiscAll(true)}>{`Show all ${discList.length}`}</PillBtn>
                  </div>
                ) : null}
              </>
            ) : null}

            {spConnected && !discTabs.length && sp.status !== 'loading' && disc.status === 'error' && remoteState !== 'loading' ? (
              <>
                <SectionHead title="Discography" />
                <Note>Couldn&apos;t load their releases{disc.error ? ` (${disc.error})` : ''}.</Note>
              </>
            ) : null}

            {/* ---- About ----------------------------------------------------- */}
            {spData && (spData.biography || spData.monthlyListeners || spData.topCities?.length) ? (
              <>
                <SectionHead title="About" />
                <AboutCard data={spData} image={spData.gallery?.[0] || spData.avatar} accent={pageAccUI} />
              </>
            ) : null}

            {/* ---- Fans also like -------------------------------------------- */}
            {spData?.related?.length ? (
              <>
                <SectionHead title="Fans also like" />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(128px, 1fr))', gap: 22 }}>
                  {spData.related.slice(0, 12).map((r) => (
                    <RelatedArtist key={r.id} a={r} inLibrary={!!hasArtist?.(r.name)}
                      onClick={() => (onOpenRelated ? onOpenRelated(r) : onJumpToFind?.(r.name, 'spotify'))} />
                  ))}
                </div>
              </>
            ) : null}

            {/* ---- Without Spotify: what you have, so the page isn't empty ---- */}
            {!spConnected && (albums.length || singles.length) ? (
              <>
                <SectionHead title="In your library" sub={statLine} />
                <CardGrid>
                  {[...albums, ...singles].map((g) => (
                    <ReleaseCard
                      key={g.key} art={g.art} name={g.name} accent={pageAcc}
                      meta={`${g.year ? `${g.year} · ` : ''}${g.tracks.length} song${g.tracks.length === 1 ? '' : 's'}`}
                      onClick={() => (g.tracks.length > 1 ? onOpenAlbum?.(g.key) : onPlayTrack?.(g.tracks[0], g.tracks))}
                    />
                  ))}
                </CardGrid>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
