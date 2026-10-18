import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../lib/format.js';
import { artistEntry, entryLabel, sameEntry, songEntry } from '../../lib/srBlock.js';

/* Settings → Connections → Twitch → Blocked Songs.
 *
 * The setting itself stays one row however long the list gets: a few covers
 * and Manage. Manage opens a window in the Changelog's style: search to add
 * at the top, then All / Songs / Artists, a filter, and the list, newest
 * first. Every removal can be undone from its toast.
 *
 * `list` is theme.srBlocked; `onChange` takes an updater (list → list) so an
 * Undo that fires later works on the list as it is then, not as it was. */

const CSS = `
.stbl-ctl { display: inline-flex; align-items: center; gap: 12px; }
.stbl-stack { display: inline-flex; flex-shrink: 0; }
.stbl-stack > * + * { margin-left: -8px; }
.stbl-stack > * { box-shadow: 0 0 0 2px var(--surface-raised); }

.stbl-scrim { position: fixed; inset: 0; z-index: 320; display: flex; align-items: center; justify-content: center; padding: 24px;
  background: rgba(4,4,6,0.78); animation: stblIn .18s ease both; }
@keyframes stblIn { from { opacity: 0; } }
.stbl { width: min(560px, 100%); max-height: min(80vh, 660px); display: flex; flex-direction: column; overflow: hidden;
  border-radius: 16px; background: var(--st-dark-float, rgb(16,16,19)); border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 24px 70px rgba(0,0,0,0.6); }
.stbl-head { display: flex; align-items: center; gap: 10px; padding: 18px 18px 14px 22px; }
.stbl-head b { font-size: 16px; font-weight: 800; color: #fff; }
.stbl-head span { font-size: 12.5px; color: rgba(255,255,255,0.45); }
.stbl-x { margin-left: auto; width: 28px; height: 28px; border-radius: 8px; border: none; background: transparent; cursor: pointer;
  color: rgba(255,255,255,0.55); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.stbl-x:hover { background: rgba(255,255,255,0.08); color: #fff; }

.stbl-field { position: relative; }
.stbl-field > svg { position: absolute; left: 13px; top: 50%; transform: translateY(-50%); color: var(--text-faint); pointer-events: none; }
.stbl-field .st-input { width: 100%; padding-left: 36px; }
.stbl-field.is-sm > svg { left: 11px; }
.stbl-field.is-sm .st-input { height: 34px; padding-left: 31px; font-size: 12.5px; border-radius: var(--r-ctl-s); }
.stbl-add { padding: 0 22px 14px; border-bottom: 1px solid rgba(255,255,255,0.07); }

/* Search results float over the list, like a menu, so typing never shifts it. */
.stbl-pop { position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 2; padding: 5px; border-radius: 12px;
  background: var(--surface); border: 1px solid var(--border); box-shadow: 0 22px 60px rgba(0,0,0,0.7); animation: stFadeUp 0.12s ease both; }
.stbl-pop-h { padding: 7px 9px 5px; font-size: 10.5px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255,255,255,0.4); }
.stbl-note { padding: 12px 10px; font-size: 12.5px; color: var(--text-faint); }

.stbl-bar { display: flex; align-items: center; gap: 10px; padding: 12px 22px; border-bottom: 1px solid rgba(255,255,255,0.07); }
.stbl-bar .st-segs { width: auto; flex-shrink: 0; }
.stbl-bar .st-segs button { padding: 0 11px; font-size: 12.5px; white-space: nowrap; }
.stbl-bar .st-segs button i { font-style: normal; margin-left: 5px; color: var(--text-faint); font-weight: 700; }
.stbl-bar .st-segs button.on i { color: rgba(255,255,255,0.6); }
.stbl-bar .stbl-field { flex: 1; min-width: 0; }

/* Grows with the list up to the window's cap, never below about five rows,
   so filtering doesn't make the window jump. */
.stbl-list { flex: 1 1 auto; min-height: 262px; overflow-y: auto; padding: 6px 12px 10px; }
.stbl-row { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 50px; padding: 7px 10px; border-radius: 10px; box-sizing: border-box;
  border: none; background: transparent; color: inherit; font: inherit; text-align: left; }
.stbl-list .stbl-row:hover, .stbl-list .stbl-row:focus-within { background: rgba(255,255,255,0.04); }
.stbl-pop .stbl-row { min-height: 46px; padding: 6px 9px; border-radius: 8px; cursor: pointer; }
.stbl-pop .stbl-row:hover, .stbl-pop .stbl-row.is-sel { background: rgba(255,255,255,0.07); }
.stbl-pop .stbl-row:disabled { cursor: default; background: transparent; }
.stbl-art { width: 34px; height: 34px; border-radius: 7px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(255,255,255,0.06) center / cover no-repeat; color: rgba(255,255,255,0.55); }
.stbl-art.is-round { border-radius: 50%; }
.stbl-stack .stbl-art { width: 26px; height: 26px; border-radius: 6px; }
.stbl-stack .stbl-art.is-round { border-radius: 50%; }
.stbl-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.stbl-txt b, .stbl-txt span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stbl-txt b { font-size: 13px; font-weight: 700; color: var(--text); }
.stbl-txt span { font-size: 11.5px; color: var(--text-faint); }
.stbl-tag { flex-shrink: 0; height: 26px; padding: 0 10px; border-radius: var(--r-ctl-s); display: inline-flex; align-items: center;
  font-size: 11.5px; font-weight: 700; background: rgba(255,255,255,0.08); color: var(--text); }
.stbl-row:disabled .stbl-tag { background: none; color: var(--text-faint); }
.stbl-list .st-icon-btn { opacity: 0; }
.stbl-list .stbl-row:hover .st-icon-btn, .stbl-list .st-icon-btn:focus-visible { opacity: 1; }
.stbl-empty { padding: 44px 30px; text-align: center; }
.stbl-empty b { display: block; font-size: 14px; font-weight: 750; color: var(--text); }
.stbl-empty span { display: block; margin-top: 6px; font-size: 12.5px; line-height: 1.55; color: var(--text-faint); }
.stbl-foot { display: flex; align-items: center; gap: 12px; padding: 12px 18px 14px 22px; border-top: 1px solid rgba(255,255,255,0.07); }
.stbl-foot > span { flex: 1; min-width: 0; font-size: 12px; color: var(--text-faint); }
.stbl.is-empty { overflow: visible; }
.stbl.is-empty .stbl-add { border-bottom: none; }
.stbl.is-empty .stbl-empty { padding: 30px 40px 40px; }
@media (prefers-reduced-motion: reduce) { .stbl-scrim, .stbl-pop { animation: none; } }
`;

const Ban = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></svg>
);
const Search = ({ size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
);
const X = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
);

function Art({ entry, image }) {
  if (entry?.kind === 'artist') return <span className="stbl-art is-round"><Ban size={13} /></span>;
  const src = image ?? entry?.image;
  if (!src) {
    return (
      <span className="stbl-art">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></svg>
      </span>
    );
  }
  return <span className="stbl-art" style={{ backgroundImage: `url("${src}")` }} />;
}

const isSong = (b) => b?.kind !== 'artist';
export function countText(list) {
  const s = list.filter(isSong).length;
  const a = list.length - s;
  return [s ? `${s} song${s === 1 ? '' : 's'}` : '', a ? `${a} artist${a === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
}

/** The control in the Settings row: a few covers and Manage. */
export function BlockedSongsControl({ list, onManage }) {
  const newest = list.slice(-12).reverse();
  const shown = [...newest.filter(isSong), ...newest.filter((b) => !isSong(b))].slice(0, 3);
  return (
    <span className="stbl-ctl">
      <style>{CSS}</style>
      {shown.length ? (
        <span className="stbl-stack" aria-hidden="true">
          {shown.map((b, i) => <Art key={i} entry={b} />)}
        </span>
      ) : null}
      <button type="button" className="st-btn st-btn-outline st-btn-sm" onClick={onManage}>{list.length ? 'Manage' : 'Add Songs'}</button>
    </span>
  );
}

export function BlockedSongsManager({ list, onChange, onClose, pushToast }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const [tab, setTab] = useState('all');
  const [filter, setFilter] = useState('');
  const addRef = useRef(null);

  // Spotify search for the add field, a moment after typing stops.
  useEffect(() => {
    const text = q.trim();
    setSel(0);
    if (text.length < 2) { setRows([]); setBusy(false); return undefined; }
    let dead = false;
    setBusy(true);
    const t = setTimeout(async () => {
      let r = [];
      try { r = await api()?.spotifySearch?.(text); } catch { r = []; }
      if (dead) return;
      setRows((Array.isArray(r) ? r : []).filter((x) => x?.title && !String(x.spotifyId || '').startsWith('itunes:')).slice(0, 5));
      setBusy(false);
    }, 280);
    return () => { dead = true; clearTimeout(t); };
  }, [q]);

  // Five songs, then up to two of their artists as "Every song by …".
  const results = useMemo(() => {
    const songs = rows.map((r) => ({ entry: songEntry(r), sub: [r.artists, r.album].filter(Boolean).join(' · ') }));
    const names = [...new Set(rows.map((r) => String(r.artists || '').split(', ')[0]).filter(Boolean))].slice(0, 2);
    return [...songs, ...names.map((n) => ({ entry: artistEntry(n), sub: 'Artist' }))];
  }, [rows]);

  const has = (e) => list.some((b) => sameEntry(b, e));
  const add = (e) => {
    if (!e || has(e)) return;
    onChange((l) => (l.some((b) => sameEntry(b, e)) ? l : [...l, e]));
    setQ('');
    addRef.current?.focus();
  };
  const remove = (b) => {
    onChange((l) => l.filter((x) => !sameEntry(x, b)));
    pushToast?.({
      message: `${entryLabel(b)} can be requested again`,
      action: { label: 'Undo', onClick: () => onChange((l) => (l.some((x) => sameEntry(x, b)) ? l : [...l, b])) },
    });
  };
  const removeAll = () => {
    const before = list;
    onChange(() => []);
    pushToast?.({ message: `Unblocked ${countText(before)}`, action: { label: 'Undo', onClick: () => onChange(() => before) } });
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // Esc clears the add search first, then closes.
      if (document.activeElement === addRef.current && addRef.current?.value) return;
      onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const songs = list.filter(isSong).length;
  const artists = list.length - songs;
  const needle = filter.trim().toLowerCase();
  const shown = list
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => (tab === 'all' || (tab === 'songs' ? isSong(b) : !isSong(b)))
      && (!needle || `${b.title || ''} ${b.artist || ''} ${b.name || ''}`.toLowerCase().includes(needle)))
    .reverse();
  const open = q.trim().length >= 2;

  return createPortal(
    <div className="stbl-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <style>{CSS}</style>
      <div className={`stbl${list.length ? '' : ' is-empty'}`} role="dialog" aria-modal="true" aria-label="Blocked Songs">
        <div className="stbl-head">
          <b>Blocked Songs</b>
          {list.length ? <span>{countText(list)}</span> : null}
          <button type="button" className="stbl-x" onClick={onClose} aria-label="Close"><X size={14} /></button>
        </div>

        <div className="stbl-add">
          <div className="stbl-field">
            <Search />
            <input ref={addRef} className="st-input" autoFocus value={q} spellCheck={false} autoComplete="off"
              placeholder="Search for a song or artist to block" aria-label="Search for a song or artist to block"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(results.length - 1, i + 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
                else if (e.key === 'Enter') add(results[sel]?.entry);
                else if (e.key === 'Escape' && q) { e.preventDefault(); setQ(''); }
              }} />
            {open ? (
              <div className="stbl-pop" role="listbox">
                {results.length ? <div className="stbl-pop-h">Block</div> : null}
                {results.map(({ entry, sub }, i) => {
                  const on = has(entry);
                  return (
                    <button key={entry.kind === 'artist' ? `a:${entry.name}` : `s:${entry.spotifyId || entry.title}:${i}`} type="button"
                      role="option" aria-selected={i === sel} disabled={on}
                      className={`stbl-row${i === sel ? ' is-sel' : ''}`}
                      onMouseEnter={() => setSel(i)} onClick={() => add(entry)}>
                      <Art entry={entry} />
                      <span className="stbl-txt"><b>{entry.kind === 'artist' ? `Every song by ${entry.name}` : entry.title}</b><span>{sub}</span></span>
                      <span className="stbl-tag">{on ? 'Blocked' : 'Block'}</span>
                    </button>
                  );
                })}
                {!results.length ? <div className="stbl-note">{busy ? 'Searching…' : 'Nothing found.'}</div> : null}
              </div>
            ) : null}
          </div>
        </div>

        {list.length ? (
          <>
            <div className="stbl-bar">
              <span className="st-segs" role="radiogroup" aria-label="Show">
                {[['all', 'All', list.length], ['songs', 'Songs', songs], ['artists', 'Artists', artists]].map(([id, label, n]) => (
                  <button key={id} type="button" role="radio" aria-checked={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
                    {label}<i>{n}</i>
                  </button>
                ))}
              </span>
              <div className="stbl-field is-sm">
                <Search size={13} />
                <input className="st-input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter"
                  spellCheck={false} autoComplete="off" aria-label="Filter blocked songs" />
              </div>
            </div>
            <div className="stbl-list sth-libscroll">
              {shown.map(({ b, i }) => (
                <div key={`${b.kind}:${b.spotifyId || b.name || b.title}:${i}`} className="stbl-row">
                  <Art entry={b} />
                  <span className="stbl-txt">
                    <b>{b.kind === 'artist' ? `Every song by ${b.name}` : b.title}</b>
                    <span>{b.kind === 'artist' ? 'Artist' : b.artist}</span>
                  </span>
                  <button type="button" className="st-icon-btn is-sm" title="Unblock" aria-label={`Unblock ${entryLabel(b)}`} onClick={() => remove(b)}>
                    <X />
                  </button>
                </div>
              ))}
              {!shown.length ? (
                <div className="stbl-empty"><span>{needle ? `Nothing blocked matches “${filter.trim()}”.` : `No ${tab} blocked.`}</span></div>
              ) : null}
            </div>
            <div className="stbl-foot">
              <span>Blocking a song also blocks its clean, remix and remastered versions.</span>
              <button type="button" className="st-btn st-btn-ghost st-btn-sm" style={{ color: 'var(--danger)' }} onClick={removeAll}>Unblock All</button>
            </div>
          </>
        ) : (
          <div className="stbl-empty">
            <b>Nothing blocked yet</b>
            <span>Search above to block a song, or every song by an artist. You can also block a song from its menu.</span>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
