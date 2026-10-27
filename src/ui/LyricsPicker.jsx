import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { spotifyIdOf } from '../lib/spotifyMediaElement.js';

/* =========================================================================
 *  The lyrics browser: every version of the playing song's lyrics, to pick
 *  the one it shows.
 *
 *  main.js (lyrics:searchAll) does the finding: Spotify's lyrics for each
 *  Spotify version of the song first, then LRCLIB's, Genius's only when
 *  nothing else has the song. It hands back one row per set of words (the
 *  same words with other timing is the same row), split into the song itself
 *  and other results, each marked Explicit or Clean when the words tell.
 *
 *  Here: the list on the left, the words of the one picked on the right,
 *  with the lines that differ from what's showing now marked, and Use These
 *  Lyrics. Arrow keys move, Enter uses, Esc closes.
 *
 *  Props (unchanged): currentTrack, accent, visible, onApply(candidate),
 *  appliedText (what's showing now, as text), appliedId, openRequest (bump
 *  to open), hideTrigger.
 * ========================================================================= */

const STAMP = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]\s?/g;
const lineNorm = (l) => l.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
/** A version's lines, as shown (timing removed, blanks dropped). */
const linesOf = (c) => String(c?.syncedLyrics || c?.plainLyrics || '').replace(STAMP, '').split('\n').map((l) => l.trim()).filter(Boolean);
const wordsKey = (lines) => lines.map(lineNorm).filter((l) => l && l !== '♪').join('\n');
const SOURCE = { spotify: 'Spotify', lrclib: 'LRCLIB', genius: 'Genius' };
const fmtLen = (s) => (s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');

const CSS = `
.lyx-scrim { position: fixed; inset: 0; z-index: 300; display: flex; align-items: center; justify-content: center; padding: 30px; background: rgba(4,4,6,0.8); }
.lyx { width: min(980px, 94vw); height: min(640px, calc(100vh - 60px)); display: flex; flex-direction: column; overflow: hidden;
  border-radius: var(--r-panel, 16px); background: var(--st-dark-float, var(--surface, #0e0e10)); border: 1px solid rgba(var(--st-fg-rgb, 255,255,255), 0.1);
  box-shadow: 0 24px 70px rgba(0,0,0,0.65); animation: stFadeUp 0.16s ease both; color: var(--st-text, #fff); }
.lyx-h { display: flex; align-items: center; gap: 12px; padding: 16px 14px 14px 18px; }
.lyx-art { width: 40px; height: 40px; flex: none; border-radius: var(--r-art-s, 6px); background: rgba(var(--st-fg-rgb, 255,255,255), 0.08) center/cover; }
.lyx-ttl { flex: 1; min-width: 0; }
.lyx-ttl b { display: block; font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lyx-ttl span { display: block; margin-top: 2px; font-size: 12px; color: rgba(var(--st-sub-rgb, 255,255,255), 0.55); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lyx-x { width: 28px; height: 28px; flex: none; display: flex; align-items: center; justify-content: center; border: none; border-radius: var(--r-ctl-s, 6px); cursor: pointer;
  background: transparent; color: rgba(var(--st-fg-rgb, 255,255,255), 0.5); }
.lyx-x:hover { background: rgba(var(--st-fg-rgb, 255,255,255), 0.08); color: var(--st-text, #fff); }
.lyx-search { display: flex; align-items: center; gap: 10px; margin: 0 18px 12px; padding: 0 12px; height: 40px; border-radius: var(--r-ctl-m, 10px);
  border: 1px solid rgba(var(--st-fg-rgb, 255,255,255), 0.12); background: rgba(0,0,0,0.3); color: rgba(var(--st-fg-rgb, 255,255,255), 0.5); }
.lyx-search:focus-within { border-color: rgba(var(--accent-rgb, 255,255,255), 0.55); }
.lyx-search input { flex: 1; min-width: 0; border: 0; outline: none; background: none; color: var(--st-text, #fff); font: inherit; font-size: 13px; }
.lyx-search kbd { font: inherit; font-size: 10.5px; font-weight: 700; padding: 2px 6px; border-radius: 5px; border: 1px solid rgba(var(--st-fg-rgb, 255,255,255), 0.14); color: rgba(var(--st-fg-rgb, 255,255,255), 0.5); }
.lyx-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr); border-top: 1px solid rgba(var(--st-fg-rgb, 255,255,255), 0.08); }
.lyx-list { min-height: 0; overflow-y: auto; padding: 8px 8px 14px; border-right: 1px solid rgba(var(--st-fg-rgb, 255,255,255), 0.08); }
.lyx-sec { display: flex; align-items: baseline; gap: 8px; padding: 12px 10px 6px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(var(--st-sub-rgb, 255,255,255), 0.45); }
.lyx-sec .ct { font-weight: 600; color: rgba(var(--st-sub-rgb, 255,255,255), 0.3); }
.lyx-row { display: block; width: 100%; text-align: left; padding: 10px 12px; border: 0; border-radius: var(--r-ctl-m, 10px); background: transparent; color: inherit; font: inherit; cursor: pointer; }
.lyx-row:hover { background: rgba(var(--st-fg-rgb, 255,255,255), 0.05); }
.lyx-row.is-on { background: rgba(var(--st-fg-rgb, 255,255,255), 0.09); }
.lyx-row-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.lyx-row-name { flex: 0 1 auto; min-width: 0; font-size: 13px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lyx-tag { flex: none; padding: 2px 6px; border-radius: 5px; font-size: 10px; font-weight: 700; letter-spacing: 0.02em; background: rgba(var(--st-fg-rgb, 255,255,255), 0.08); color: rgba(var(--st-fg-rgb, 255,255,255), 0.7); }
.lyx-tag.is-synced { background: rgba(var(--accent-rgb, 255,255,255), 0.18); color: var(--st-text, #fff); }
.lyx-tag.is-explicit { background: rgba(255,255,255,0.86); color: #111; }
.lyx-tag.is-clean { border: 1px solid rgba(var(--st-fg-rgb, 255,255,255), 0.25); background: none; }
.lyx-inuse { margin-left: auto; flex: none; display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 700; color: rgb(var(--accent-rgb, 255,255,255)); }
.lyx-meta { margin-top: 3px; font-size: 11.5px; color: rgba(var(--st-sub-rgb, 255,255,255), 0.5); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lyx-first { margin-top: 4px; font-size: 12px; color: rgba(var(--st-sub-rgb, 255,255,255), 0.72); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lyx-prev { min-height: 0; display: flex; flex-direction: column; }
.lyx-prev-h { display: flex; align-items: center; gap: 8px; padding: 14px 20px 10px; font-size: 12px; color: rgba(var(--st-sub-rgb, 255,255,255), 0.55); }
.lyx-prev-b { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 20px 16px; font-size: 14px; line-height: 1.75; }
.lyx-prev-b p { margin: 0; color: rgba(var(--st-fg-rgb, 255,255,255), 0.82); }
.lyx-prev-b p.is-diff { color: var(--st-text, #fff); background: rgba(var(--accent-rgb, 255,255,255), 0.14); border-radius: 4px; padding: 0 6px; margin: 0 -6px; }
.lyx-prev-f { display: flex; align-items: center; gap: 10px; padding: 14px 20px 16px; border-top: 1px solid rgba(var(--st-fg-rgb, 255,255,255), 0.08); }
.lyx-prev-f span { flex: 1; min-width: 0; font-size: 12px; color: rgba(var(--st-sub-rgb, 255,255,255), 0.55); }
.lyx-use { padding: 9px 16px; border-radius: var(--r-ctl-m, 10px); border: 0; cursor: pointer; font: inherit; font-size: 12px; font-weight: 700; background: rgb(var(--accent-rgb, 255,255,255)); color: var(--accent-ink, #000); }
.lyx-use:disabled { opacity: 0.45; cursor: default; }
.lyx-use:not(:disabled):hover { filter: brightness(1.1); }
.lyx-empty { padding: 48px 24px; text-align: center; font-size: 13px; color: rgba(var(--st-sub-rgb, 255,255,255), 0.55); line-height: 1.6; }
.lyx-empty b { display: block; margin-bottom: 4px; font-size: 14px; color: var(--st-text, #fff); }
.lyx-skel { height: 64px; margin: 4px 4px 8px; border-radius: var(--r-ctl-m, 10px); background: linear-gradient(90deg, rgba(255,255,255,0.04), rgba(255,255,255,0.08), rgba(255,255,255,0.04)); background-size: 200% 100%; animation: lyxShimmer 1.2s linear infinite; }
@keyframes lyxShimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
@media (max-width: 720px) { .lyx-body { grid-template-columns: 1fr; grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); } .lyx-list { border-right: 0; border-bottom: 1px solid rgba(var(--st-fg-rgb, 255,255,255), 0.08); } }
`;

export function LyricsPickerButton({
  currentTrack, accent, visible, onApply, appliedText, appliedId,
  openRequest = 0,     // increment to open the browser programmatically
  hideTrigger = false, // no built-in trigger (the host has its own button)
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState({ song: [], other: [], query: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [queryText, setQueryText] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef(null);
  const reqRef = useRef(0);
  const searchedRef = useRef('');  // the words last searched, as typed

  const runSearch = useCallback(async (customQuery) => {
    if (!currentTrack) return;
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.searchAllLyrics) return;
    const req = ++reqRef.current;
    searchedRef.current = String(customQuery || '').trim();
    setLoading(true);
    setError('');
    try {
      const r = await api.searchAllLyrics({
        title: currentTrack.title, artist: currentTrack.artist,
        album: currentTrack.album, duration: currentTrack.duration,
        spotifyId: spotifyIdOf(currentTrack) || null,
        explicit: typeof currentTrack.explicit === 'boolean' ? currentTrack.explicit : null,
        customQuery: String(customQuery || '').trim() || undefined,
      });
      if (req !== reqRef.current) return;
      if (r?.error) setError(r.error);
      setData({ song: r?.song || [], other: r?.other || [], query: r?.query || '' });
      setSel(0);
    } catch (e) {
      if (req !== reqRef.current) return;
      setError(String(e?.message || e));
      setData({ song: [], other: [], query: '' });
    }
    setLoading(false);
  }, [currentTrack]);

  const handleOpen = useCallback(() => {
    if (!currentTrack) return;
    setOpen(true);
    setQueryText('');
    runSearch('');
  }, [currentTrack, runSearch]);

  const lastOpenReq = useRef(0);
  useEffect(() => {
    if (openRequest > 0 && openRequest !== lastOpenReq.current) {
      lastOpenReq.current = openRequest;
      handleOpen();
    }
  }, [openRequest, handleOpen]);

  /* What's showing now, to mark the version in use and the lines that differ. */
  const appliedLines = useMemo(() => String(appliedText || '').split('\n').map((l) => l.trim()).filter(Boolean), [appliedText]);
  const appliedKey = useMemo(() => wordsKey(appliedLines), [appliedLines]);
  const rows = useMemo(() => [
    ...data.song.map((c) => ({ c, group: 'This Song' })),
    ...data.other.map((c) => ({ c, group: 'Other Results' })),
  ].map((r) => {
    const lines = linesOf(r.c);
    const inUse = (appliedId != null && r.c.id != null && String(r.c.id) === String(appliedId)) || (!!appliedKey && wordsKey(lines) === appliedKey);
    // Lines this version has that what's showing doesn't (each copy counted once).
    const have = new Map();
    for (const l of appliedLines) { const k = lineNorm(l); have.set(k, (have.get(k) || 0) + 1); }
    const diff = lines.map((l) => {
      const k = lineNorm(l);
      if ((have.get(k) || 0) > 0) { have.set(k, have.get(k) - 1); return false; }
      return !!k;
    });
    return { ...r, lines, inUse, diff, diffCount: appliedLines.length ? diff.filter(Boolean).length : null };
  }), [data, appliedId, appliedKey, appliedLines]);
  // Only one row is "in use".
  const inUseAt = rows.findIndex((r) => r.inUse);
  const cur = rows[Math.min(sel, rows.length - 1)] || null;

  const applyRow = useCallback((row) => {
    if (!row) return;
    onApply?.(row.c);
    setOpen(false);
  }, [onApply]);

  useEffect(() => {
    if (!open) return undefined;
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); return; }
      if (e.target?.tagName === 'INPUT' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(rows.length - 1, i + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
      else if (e.key === 'Enter' && cur) { e.preventDefault(); applyRow(cur); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open, rows.length, cur, applyRow]);
  useEffect(() => {
    listRef.current?.querySelector('.lyx-row.is-on')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const targetSec = Number(currentTrack?.duration) || 0;
  const lengthNote = (c) => {
    if (!c.duration || !targetSec) return fmtLen(c.duration);
    const d = Math.round(c.duration - targetSec);
    if (Math.abs(d) <= 1) return 'Same length';
    return `${Math.abs(d)}s ${d > 0 ? 'longer' : 'shorter'}`;
  };
  const art = currentTrack?.coverArt || currentTrack?.albumArtUrl || '';

  const renderRow = (r, i) => {
    const c = r.c;
    const name = c.source === 'spotify' ? 'Spotify' : (c.albumName || SOURCE[c.source] || 'LRCLIB');
    const meta = [
      c.source !== 'spotify' && c.albumName ? SOURCE[c.source] : null,
      r.group === 'Other Results' ? [c.trackName, c.artistName].filter(Boolean).join(' · ') : lengthNote(c),
      r.inUse ? null : r.diffCount === 0 ? 'Same words as yours' : r.diffCount ? `${r.diffCount} ${r.diffCount === 1 ? 'line differs' : 'lines differ'}` : null,
    ].filter(Boolean).join(' · ');
    return (
      <button key={`${c.id}:${i}`} type="button" className={`lyx-row${i === sel ? ' is-on' : ''}`}
        onClick={() => setSel(i)} onDoubleClick={() => applyRow(r)}>
        <div className="lyx-row-top">
          <span className="lyx-row-name">{name}</span>
          <span className={`lyx-tag${c.hasSynced ? ' is-synced' : ''}`}>{c.hasSynced ? 'Synced' : 'Plain'}</span>
          {c.rating ? <span className={`lyx-tag is-${c.rating}`}>{c.rating === 'explicit' ? 'Explicit' : 'Clean'}</span> : null}
          {i === inUseAt ? (
            <span className="lyx-inuse">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
              In Use
            </span>
          ) : null}
        </div>
        {meta ? <div className="lyx-meta">{meta}</div> : null}
        {r.lines[0] ? <div className="lyx-first">{r.lines[0]}</div> : null}
      </button>
    );
  };

  const list = () => {
    const out = [];
    let last = null;
    rows.forEach((r, i) => {
      if (r.group !== last) {
        last = r.group;
        const n = rows.filter((x) => x.group === r.group).length;
        out.push(<div key={`sec:${r.group}`} className="lyx-sec">{r.group}<span className="ct">{n}</span></div>);
      }
      out.push(renderRow(r, i));
    });
    return out;
  };

  return (
    <>
      {hideTrigger ? null : (
        <button type="button" onClick={handleOpen} title="Lyrics versions" aria-label="Lyrics versions"
          style={{
            position: 'absolute', top: 4, right: 72, width: 28, height: 28, borderRadius: 8, padding: 0,
            border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(0,0,0,0.45)', color: 'rgba(255,255,255,0.75)', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: visible ? 1 : 0, pointerEvents: visible ? 'auto' : 'none', transition: 'opacity 0.18s ease',
          }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
      )}

      {open ? createPortal(
        <div className="lyx-scrim" onClick={() => setOpen(false)}>
          <style>{CSS}</style>
          <div className="lyx" role="dialog" aria-modal="true" aria-label="Lyrics" onClick={(e) => e.stopPropagation()}
            style={accent ? { '--accent-rgb': accent } : undefined}>
            <div className="lyx-h">
              <div className="lyx-art" style={art ? { backgroundImage: `url("${art}")` } : undefined} />
              <div className="lyx-ttl">
                <b>Lyrics</b>
                <span>{[currentTrack?.title, currentTrack?.artist].filter(Boolean).join(' · ')}</span>
              </div>
              <button type="button" className="lyx-x" title="Close (Esc)" aria-label="Close" onClick={() => setOpen(false)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <label className="lyx-search">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
              <input type="text" value={queryText} autoFocus spellCheck={false}
                placeholder={data.query ? `Searching “${data.query}”. Type other words to search those instead.` : 'Title, artist, or both'}
                onChange={(e) => setQueryText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || loading) return;
                  e.preventDefault();
                  e.stopPropagation();
                  // New words: search them. Otherwise Enter uses the version picked.
                  if (queryText.trim() !== searchedRef.current) runSearch(queryText);
                  else if (cur) applyRow(cur);
                }} />
              <kbd>Enter</kbd>
            </label>
            <div className="lyx-body">
              <div className="lyx-list" ref={listRef}>
                {loading ? [0, 1, 2, 3].map((k) => <div key={k} className="lyx-skel" />)
                  : rows.length ? list()
                    : (
                      <div className="lyx-empty">
                        {error ? <><b>Couldn’t search right now</b>{error}</>
                          : <><b>No lyrics found</b>Try the title on its own, or another spelling of the artist.</>}
                      </div>
                    )}
              </div>
              <div className="lyx-prev">
                {cur && !loading ? (
                  <>
                    <div className="lyx-prev-h">
                      {cur.c.source === 'spotify' ? 'Spotify' : SOURCE[cur.c.source] || 'LRCLIB'}
                      {cur.c.hasSynced ? ' · Synced to the song' : ' · Words only, no timing'}
                    </div>
                    <div className="lyx-prev-b">
                      {cur.lines.map((l, i) => <p key={i} className={cur.diff[i] && cur.diffCount ? 'is-diff' : ''}>{l}</p>)}
                    </div>
                    <div className="lyx-prev-f">
                      <span>
                        {cur.inUse ? 'These are the lyrics showing now.'
                          : cur.diffCount ? 'Highlighted lines differ from the lyrics showing now.'
                            : cur.diffCount === 0 ? 'Same words as now, with their own timing.' : ''}
                      </span>
                      <button type="button" className="lyx-use" disabled={rows.indexOf(cur) === inUseAt} onClick={() => applyRow(cur)}>Use These Lyrics</button>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
