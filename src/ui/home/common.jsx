import React from 'react';
import { useIndicatorStyle } from '../../lib/playingIndicator.js';
import { createPortal } from 'react-dom';
import { PauseIcon, PlayIcon } from '../sharedUI.jsx';
import { titleCase } from '../../lib/format.js';

export function rgbToHex(rgb) {
  const p = String(rgb || '').split(',').map((n) => Math.max(0, Math.min(255, parseInt(n.trim(), 10) || 0)));
  return `#${p.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
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
export function Modal({ children }) {
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
/* Every menu item's label is Title Case ("Add to Playlist"), set here so no
   menu can drift from it. A label that's an element (one with a name in it)
   is left as written. `keys` is the item's keyboard shortcut, shown on the
   right, in every menu that has the item. */
export const MenuItem = React.memo(function MenuItem({ icon, label, sub, keys, danger, onClick, trailing, accentRgb }) {
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
        {titleCase(label)}
        {sub ? <span className="sth-mi-sub">{sub}</span> : null}
      </span>
      {keys ? <kbd className="sth-mi-keys">{keys}</kbd> : null}
      {trailing}
    </button>
  );
});

/* The one empty state: an icon, a title, a line of text and (at most) one
   action, centered in whatever it fills. `icon` is an SVG path, or a whole
   <svg>. The title is Title Case, set here like menu labels. */
export function EmptyState({ icon = null, title, text = null, action = null, compact = false, style = null }) {
  return (
    <div style={{
      flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 6, textAlign: 'center', padding: compact ? '22px 20px' : '40px 28px', ...style,
    }}>
      {icon ? (
        <span aria-hidden style={{
          width: 44, height: 44, borderRadius: '50%', marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(var(--st-fg-rgb), 0.06)', color: 'rgba(var(--st-sub-rgb), 0.6)',
        }}>
          {React.isValidElement(icon) && icon.type === 'svg' ? icon
            : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>}
        </span>
      ) : null}
      <b style={{ fontSize: 15, fontWeight: 800, color: 'var(--st-text)' }}>{titleCase(title)}</b>
      {text ? <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'rgba(var(--st-sub-rgb), 0.55)', maxWidth: 320 }}>{text}</p> : null}
      {action ? <div style={{ marginTop: 8 }}>{action}</div> : null}
    </div>
  );
}

/* The one dialog. Title on the left and × on the right, the body, then a
   footer: a secondary action on the left (`start`), Cancel and the main
   action on the right. Escape or a click outside closes it, unless `busy`.
   `actions`: { label, onClick, kind: 'primary' | 'danger' | 'secondary', disabled }. */
export function Dialog({ title, onClose, children, actions = [], start = null, width = 400, busy = false }) {
  const live = React.useRef({ onClose, busy });
  live.current = { onClose, busy };
  React.useEffect(() => {
    const key = (e) => {
      if (e.key !== 'Escape' || live.current.busy) return;
      e.stopPropagation();
      live.current.onClose();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);
  return (
    <Modal>
      <div className="st-dlg-scrim" onClick={() => { if (!busy) onClose(); }}>
        <div className="st-dlg" role="dialog" aria-modal="true" aria-label={title} style={{ width: `min(${width}px, 92vw)` }}
          onClick={(e) => e.stopPropagation()}>
          <div className="st-dlg-h">
            <b>{title}</b>
            <button type="button" className="st-dlg-x" title="Close (Esc)" aria-label="Close" disabled={busy} onClick={onClose}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
          <div className="st-dlg-b">{children}</div>
          {actions.length || start ? (
            <div className="st-dlg-f">
              {start}
              <span style={{ flex: 1 }} />
              {actions.filter(Boolean).map((a) => (
                <button key={a.label} type="button" className={`st-dlg-btn is-${a.kind || 'secondary'}`} disabled={a.disabled} onClick={a.onClick}>{a.label}</button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
export const DIALOG_CSS = `
.st-dlg-scrim { position: fixed; inset: 0; z-index: 300; display: flex; align-items: center; justify-content: center; padding: 30px; background: rgba(4,4,6,0.8); }
.st-dlg { max-height: calc(100vh - 60px); display: flex; flex-direction: column; border-radius: var(--r-panel); background: var(--st-dark-float, var(--surface));
  border: 1px solid rgba(var(--st-fg-rgb), 0.1); box-shadow: 0 24px 70px rgba(0,0,0,0.65); animation: stFadeUp 0.16s ease both; }
.st-dlg-h { display: flex; align-items: center; gap: 12px; padding: 16px 14px 0 20px; }
.st-dlg-h b { flex: 1; min-width: 0; font-size: 15px; font-weight: 700; color: var(--st-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.st-dlg-x { width: 28px; height: 28px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border: none; border-radius: var(--r-ctl-s); cursor: pointer;
  background: transparent; color: rgba(var(--st-fg-rgb), 0.5); transition: background 0.12s ease, color 0.12s ease; }
.st-dlg-x:hover { background: rgba(var(--st-fg-rgb), 0.08); color: var(--st-text); }
.st-dlg-b { padding: 12px 20px 0; min-height: 0; overflow-y: auto; font-size: 12px; line-height: 1.55; color: rgba(var(--st-sub-rgb), 0.6); }
.st-dlg-f { display: flex; align-items: center; gap: 8px; padding: 18px 20px 18px; }
.st-dlg-btn { padding: 9px 16px; border-radius: var(--r-ctl-m); cursor: pointer; font: inherit; font-size: 12px; font-weight: 700; border: 1px solid transparent; transition: filter 0.12s ease, background 0.12s ease; }
.st-dlg-btn:disabled { opacity: 0.45; cursor: default; }
.st-dlg-btn.is-secondary { border-color: rgba(var(--st-fg-rgb), 0.12); background: rgba(var(--st-fg-rgb), 0.05); color: var(--st-text); }
.st-dlg-btn.is-secondary:not(:disabled):hover { background: rgba(var(--st-fg-rgb), 0.09); }
.st-dlg-btn.is-primary { background: rgb(var(--accent-rgb)); color: var(--accent-ink, #000); }
.st-dlg-btn.is-danger { border-color: rgba(230,90,90,0.5); background: rgba(230,90,90,0.2); color: rgb(245,160,160); }
.st-dlg-btn.is-primary:not(:disabled):hover, .st-dlg-btn.is-danger:not(:disabled):hover { filter: brightness(1.1); }
.st-dlg-input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: var(--r-ctl-m); outline: none; border: 1px solid rgba(var(--st-fg-rgb), 0.12);
  background: rgba(0,0,0,0.35); color: var(--st-text); font-size: 13px; font-family: inherit; }
.st-dlg-input:focus { border-color: rgba(var(--accent-rgb), 0.55); }
`;

/* One icon per action, in every menu: the circled + is always Save to
   Library, the square + always Add to Playlist. */
export const MI = {
  play: <path d="M8 6.5v11l9.5-5.5z" />,
  shuffle: <><path d="M16 3h5v5" /><path d="M4 20L21 3" /><path d="M21 16v5h-5" /><path d="M15 15l6 6" /><path d="M4 4l5 5" /></>,
  next: <><path d="M4 6h10M4 12h10M4 18h6" /><path d="M17.5 14.5v6M14.5 17.5h6" /></>,
  queue: <><path d="M4 6h16M4 12h16M4 18h9" /><path d="M17 15.5v5.5" /><path d="M14.2 18.2h5.6" /></>,
  playlist: <><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M12 8.5v7M8.5 12h7" /></>,
  save: <><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></>,
  artist: <><circle cx="12" cy="8" r="4" /><path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5" /></>,
  album: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.5" /></>,
  open: <><path d="M4 6h12M4 12h12M4 18h8" /><path d="M16 15l3 3-3 3" /></>,
  link: <><path d="M4 12v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" /><path d="M16 6l-4-4-4 4" /><path d="M12 2v14" /></>,
  edit: <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />,
  trash: <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />,
  follow: <><circle cx="9" cy="8" r="4" /><path d="M2 20c1.3-3.3 3.9-5 7-5s5.7 1.7 7 5" /><path d="M19 8v6M16 11h6" /></>,
  unfollow: <><circle cx="9" cy="8" r="4" /><path d="M2 20c1.3-3.3 3.9-5 7-5s5.7 1.7 7 5" /><path d="M16 11h6" /></>,
};

/* The one playlist list. Every Add to Playlist shows it: beside the song
   menu, beside an album's or playlist's menu, and in the Now Playing bar's
   popover. Covers, a tick on the playlists that already have the songs, and
   New Playlist at the top that turns into a name field in place.
   `stateOf(pl)`: 'all' when it has every song, 'some', or 'none'. */
const NOTE_ICON = <path d="M9 17V6.5l9-1.8V15" />;
export function PlaylistPickList({ playlists, artFor, stateOf, onPick, onCreate = null, multi = false }) {
  const [query, setQuery] = React.useState('');
  const [naming, setNaming] = React.useState(null);
  const q = query.trim().toLowerCase();
  const shown = q ? playlists.filter((p) => (p.name || '').toLowerCase().includes(q)) : playlists;
  const create = () => { const n = String(naming || '').trim(); if (n) onCreate?.(n); };
  return (
    <>
      {playlists.length > 7 ? (
        <input className="st-input" autoFocus placeholder="Find a playlist" value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) onPick(shown[0]); }}
          style={{ width: '100%', height: 32, fontSize: 12.5, marginBottom: 4 }} />
      ) : null}
      {naming != null ? (
        <input className="st-input" autoFocus placeholder="Playlist name" value={naming}
          onChange={(e) => setNaming(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create();
            /* Backs out of the name, not the whole menu. */
            if (e.key === 'Escape') { e.stopPropagation(); setNaming(null); }
          }}
          style={{ width: '100%', height: 32, fontSize: 12.5, marginBottom: 4 }} />
      ) : onCreate ? (
        <button type="button" className="sth-pl-pick" onClick={() => setNaming('')}>
          <span className="pc is-new">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </span>
          <span className="nm">New Playlist</span>
        </button>
      ) : null}
      {shown.map((pl) => {
        const st = stateOf(pl);
        const art = artFor(pl);
        const title = st === 'all'
          ? (multi ? `Already in ${pl.name}` : `In ${pl.name}. Click to remove it.`)
          : st === 'some' ? `Add the rest to ${pl.name}` : `Add to ${pl.name}`;
        return (
          <button key={pl.id} type="button" className={`sth-pl-pick${st === 'all' ? ' is-in' : ''}`} onClick={() => onPick(pl)} title={title}>
            <span className={`pc${art ? '' : ' is-new'}`} style={{ backgroundImage: art ? `url("${art}")` : undefined }}>
              {art ? null : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.55 }}>
                  {NOTE_ICON}<circle cx="6.6" cy="17.4" r="2.6" /><circle cx="15.6" cy="15.4" r="2.6" />
                </svg>
              )}
            </span>
            <span className="nm">{pl.name}</span>
            {st === 'all' ? (
              <svg className="ok" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            ) : st === 'some' ? (
              <svg className="ok" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{ opacity: 0.6 }}><path d="M7 12h10" /></svg>
            ) : null}
          </button>
        );
      })}
      {!shown.length ? <div style={{ padding: '8px 10px', fontSize: 12, color: 'rgba(var(--st-fg-rgb), 0.4)' }}>{playlists.length ? 'No playlist by that name.' : 'No playlists yet.'}</div> : null}
    </>
  );
}

/* The surface every menu and popover shares: the app's card color, its
   border and shadow. */
export const MENU_SURFACE = {
  padding: 5, borderRadius: 'var(--r-ctl-l)', background: 'var(--surface)', border: '1px solid var(--border)',
  boxShadow: '0 22px 60px rgba(0,0,0,0.7)', animation: 'stFadeUp 0.13s ease both',
};
export const MenuSep = () => <div style={{ height: 1, background: 'rgba(var(--st-fg-rgb), 0.08)', margin: '4px 3px' }} />;
/* A menu's header: what it acts on. Artwork (round for an artist), name and
   a short line under it. */
export function MenuHead({ art, title, sub, round = false }) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px 10px' }}>
        <div style={{ width: 34, height: 34, borderRadius: round ? '50%' : 'var(--r-art-s)', flexShrink: 0, background: art ? `url("${art}") center/cover` : 'rgba(var(--st-fg-rgb), 0.08)' }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--st-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
          {sub ? <div style={{ fontSize: 11, color: 'rgba(var(--st-sub-rgb), 0.45)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div> : null}
        </div>
      </div>
      <div style={{ height: 1, background: 'rgba(var(--st-fg-rgb), 0.08)', margin: '0 3px 4px' }} />
    </>
  );
}

/* A menu for an album, playlist, artist or release: the song menu's look,
   opened by right-click or its ··· button, so the two always match.
   `items`: { label, icon, run, danger, keys, sub, picker } or 'sep'. An item
   with `picker` (PlaylistPickList's props) opens the playlist list beside the
   menu on hover or click. */
const CHEV = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5, flexShrink: 0 }}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);
export function ObjectMenu({ at, head, items, accentRgb, onClose, width = 280 }) {
  const ref = React.useRef(null);
  const [sub, setSub] = React.useState(false);
  const timer = React.useRef(null);
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1400;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 900;
  const left = Math.max(8, Math.min(at.x, vw - width - 12));
  const subOnLeft = left + width + 244 > vw;
  /* Kept on screen: one opened near the bottom moves up to fit. */
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || at.above) return;
    const r = el.getBoundingClientRect();
    if (r.bottom > vh - 8) el.style.top = `${Math.max(8, vh - r.height - 8)}px`;
  });
  React.useEffect(() => {
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); clearTimeout(timer.current); };
  }, [onClose]);
  const list = (items || []).filter(Boolean).filter((it, i, a) => it !== 'sep' || (i > 0 && i < a.length - 1 && a[i - 1] !== 'sep'));
  if (typeof document === 'undefined') return null;
  return createPortal(
    <>
      <div onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}
        style={{ position: 'fixed', inset: 0, zIndex: 400 }} />
      <div data-rowmenu="" ref={ref} role="menu"
        style={{
          position: 'fixed', zIndex: 401, left, width, ...MENU_SURFACE,
          ...(at.above ? { bottom: Math.max(8, vh - at.y) } : { top: Math.min(at.y, vh - 120) }),
        }}>
        {head ? <MenuHead {...head} /> : null}
        {list.map((it, i) => {
          if (it === 'sep') return <MenuSep key={`s${i}`} />;
          if (it.picker) {
            return (
              <div key={it.label} style={{ position: 'relative' }}
                onMouseEnter={() => { clearTimeout(timer.current); setSub(true); }}
                onMouseLeave={(e) => { clearTimeout(timer.current); const host = e.currentTarget; timer.current = setTimeout(() => { if (!host.contains(document.activeElement) || document.activeElement?.tagName !== 'INPUT') setSub(false); }, 220); }}>
                <MenuItem accentRgb={accentRgb} icon={it.icon} label={it.label} onClick={() => setSub(true)} trailing={CHEV} />
                {sub ? (
                  <div data-rowmenu="" className="sth-libscroll" onWheel={(e) => e.stopPropagation()}
                    style={{
                      position: 'absolute', top: -6, [subOnLeft ? 'right' : 'left']: 'calc(100% + 9px)',
                      width: 236, maxHeight: 340, overflowY: 'auto', ...MENU_SURFACE, animation: 'stFadeUp 0.12s ease both',
                    }}>
                    <PlaylistPickList {...it.picker}
                      onPick={(pl) => { onClose(); it.picker.onPick(pl); }}
                      onCreate={it.picker.onCreate ? (n) => { onClose(); it.picker.onCreate(n); } : null} />
                  </div>
                ) : null}
              </div>
            );
          }
          return (
            <MenuItem key={it.label} accentRgb={accentRgb} icon={it.icon} label={it.label} sub={it.sub} keys={it.keys} danger={it.danger}
              onClick={() => { onClose(); it.run(); }} />
          );
        })}
      </div>
    </>,
    document.body,
  );
}

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

/* Dragging songs within a playlist to reorder them. `onMove(id, toIndex)`;
   null turns it off (a filtered list, an album). Spread props(i, id) on each
   row and add cls(i) to its className: the dragged row dims and a line marks
   where it will land. */
export function useRowDrag(onMove) {
  const [drag, setDrag] = React.useState(null); // { from, over, id }
  if (!onMove) return { props: () => ({}), cls: () => '' };
  const props = (i, id) => ({
    draggable: true,
    onDragStart: (e) => { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(id)); } catch { /* ignore */ } setDrag({ from: i, over: i, id }); },
    onDragOver: (e) => { if (!drag) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (drag.over !== i) setDrag((d) => (d ? { ...d, over: i } : d)); },
    onDrop: (e) => { e.preventDefault(); if (drag && drag.from !== i) onMove(drag.id, i); setDrag(null); },
    onDragEnd: () => setDrag(null),
  });
  const cls = (i) => (!drag ? '' : i === drag.from ? ' is-dragged' : i === drag.over ? (drag.from < i ? ' is-drop-after' : ' is-drop-before') : '');
  return { props, cls };
}

/* The one playing indicator, used by every list: Bars, Beacon or Signal,
   whichever is picked in Settings → Layout (playingIndicator.js). Paused
   holds it still. `acc` is an "r, g, b" string; `color` any CSS color, for
   lists that keep their accent in a variable. `kind` forces a style (the
   setting's own preview). Styles: .st-ind in accentTokens.js. */
export const PlayingBars = React.memo(function PlayingBars({ acc, color, playing = true, kind = null }) {
  const chosen = useIndicatorStyle();
  const style = kind || chosen;
  return (
    <span className={`st-ind is-${style}${playing ? '' : ' is-paused'}`} role="img"
      aria-label={playing ? 'Now playing' : 'Paused'} title={playing ? 'Now playing' : 'Paused'}
      style={acc ? { color: `rgb(${acc})` } : color ? { color } : undefined}>
      {style === 'signal' ? (
        <svg viewBox="0 0 18 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <circle cx="4" cy="8" r="2.2" fill="currentColor" stroke="none" />
          <path className="a1" d="M8.5 4.8a4.5 4.5 0 0 1 0 6.4" />
          <path className="a2" d="M11.8 2a8.6 8.6 0 0 1 0 12" />
        </svg>
      ) : <><i /><i /><i /></>}
    </span>
  );
});

/**
 * The first credited artist on a track.
 *
 * Module-level: it reads no state and closes over nothing, so as a useCallback
 * inside the component it only served to make everything declared above it
 * unable to use it. Function declarations hoist, so call order stops mattering.
 */
/* Separators that can't also be part of a name. No bare "with" ("Sleeping
   With Sirens" showed as "Sleeping"), and a comma only counts when a space
   follows it ("nothing,nowhere." showed as "nothing"): credits list artists
   as "A, B". The same rule holds everywhere Studio splits a credit. */
export function primaryArtistOf(t) {
  const raw = String(t?.artist || '').trim();
  if (!raw) return '';
  return raw.split(/\s*(?:,(?=\s)|&|\bfeat\.?\b|\bft\.?\b|\bx\b)\s*/i)[0].trim() || raw;
}

/** The (album, primary artist) pair that identifies a record. */
export function albumKeyOf(t) {
  return `${(t.album || '').toLowerCase()}::${primaryArtistOf(t).toLowerCase()}`;
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
export const PlayGlyph = PlayIcon;
export const PauseGlyph = PauseIcon;
