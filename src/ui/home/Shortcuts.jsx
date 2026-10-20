import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

/* Keyboard shortcuts: the one list the key handler matches against and the
 * Keyboard shortcuts window shows, so the two can't disagree.
 *
 * A combo is an array of key names: 'Mod' is Ctrl (⌘ on a Mac), then 'Shift',
 * then the key itself. An item can have more than one combo; the first is
 * the one menus show. Shortcuts with Ctrl or ⌘ work even while typing in a
 * field. Plain keys (Space, M, Q...) only work when you're not typing, so
 * they never get in the way of a search box. */

export const OPEN_SHORTCUTS_EVENT = 'studio:shortcuts';
export const openShortcuts = () => window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT));

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');

export const SHORTCUTS = [
  {
    group: 'Playback',
    items: [
      { id: 'play', label: 'Play or Pause', keys: [['Space']] },
      { id: 'next', label: 'Next Song', keys: [['Mod', '→']] },
      { id: 'prev', label: 'Previous Song', keys: [['Mod', '←']] },
      { id: 'forward', label: 'Forward 10 Seconds', keys: [['Shift', '→']], repeat: true },
      { id: 'back', label: 'Back 10 Seconds', keys: [['Shift', '←']], repeat: true },
      { id: 'volumeUp', label: 'Volume Up', keys: [['Mod', '↑']], repeat: true },
      { id: 'volumeDown', label: 'Volume Down', keys: [['Mod', '↓']], repeat: true },
      { id: 'mute', label: 'Mute', keys: [['M']] },
      { id: 'shuffle', label: 'Shuffle', keys: [['S']] },
      { id: 'repeat', label: 'Repeat', keys: [['R']] },
      { id: 'favorite', label: 'Favorite', keys: [['H']], note: 'Songs in Your Library' },
    ],
  },
  {
    group: 'Now Playing',
    items: [
      { id: 'queue', label: 'Queue', keys: [['Q']] },
      { id: 'clearQueue', label: 'Clear Queue', keys: [['Mod', 'Shift', 'Q']] },
      { id: 'lyrics', label: 'Lyrics', keys: [['L']] },
      { id: 'info', label: 'Info', keys: [['I']] },
      { id: 'copyLink', label: 'Copy Spotify Link', keys: [['Mod', 'Shift', 'L']] },
      { id: 'fullscreen', label: 'Fullscreen', keys: [['F'], ['Mod', 'Shift', 'F']] },
      { id: 'darkMode', label: 'Dark Mode', keys: [['Mod', 'Shift', 'D']] },
      { id: 'immerse', label: 'Immerse', keys: [['Mod', 'Shift', 'E']] },
      { id: 'colour', label: 'Change Colors', keys: [['Mod', 'Shift', 'P']] },
      { id: 'compact', label: 'Compact Mode', keys: [['Mod', 'Shift', 'C']] },
    ],
  },
  {
    group: 'App',
    items: [
      { id: 'search', label: 'Search', keys: [['Mod', 'K'], ['/']] },
      { id: 'settings', label: 'Settings', keys: [['Mod', ',']] },
      { id: 'shortcuts', label: 'Keyboard Shortcuts', keys: [['?']] },
      { id: 'pasteLink', label: 'Open a Copied Spotify Link', keys: [['Mod', 'V']] },
      { id: 'close', label: 'Close or Go Back', keys: [['Esc']] },
      { id: 'reload', label: 'Reload', keys: [['Mod', 'R']] },
      { id: 'restart', label: 'Restart Studio', keys: [['Mod', 'Shift', 'R']] },
    ],
  },
];

const BY_ID = new Map(SHORTCUTS.flatMap((g) => g.items.map((it) => [it.id, it])));

const NAME = {
  Mod: IS_MAC ? '⌘' : 'Ctrl',
  Shift: IS_MAC ? '⇧' : 'Shift',
};
const keyName = (k) => NAME[k] || k;

/** "Ctrl+Shift+F" (or "⌘⇧F" on a Mac): the first combo, for menus. */
export function keysText(id) {
  const combo = BY_ID.get(id)?.keys?.[0];
  if (!combo) return undefined;
  return IS_MAC ? combo.map(keyName).join('') : combo.map(keyName).join('+');
}

const CODE = { '→': 'ArrowRight', '←': 'ArrowLeft', '↑': 'ArrowUp', '↓': 'ArrowDown', Space: ' ', Esc: 'Escape' };

function matchesCombo(e, combo) {
  const key = combo[combo.length - 1];
  const mod = combo.includes('Mod');
  const shift = combo.includes('Shift');
  if (e.altKey || (e.ctrlKey || e.metaKey) !== mod) return false;
  // ? is Shift+/ on most layouts, so the key itself is what's matched.
  if (key === '?') return e.key === '?';
  if (e.shiftKey !== shift) return false;
  if (/^[A-Z]$/.test(key)) return e.code === `Key${key}`;
  if (key === ',') return e.code === 'Comma';
  return e.key === (CODE[key] || key);
}

/** The shortcut this key press is, or null. */
export function shortcutFor(e) {
  for (const g of SHORTCUTS) {
    for (const it of g.items) {
      if (it.keys.some((c) => matchesCombo(e, c))) return it;
    }
  }
  return null;
}

/** Whether a combo should work while typing in a field: only chords. */
export const worksWhileTyping = (it) => it.keys.some((c) => c.includes('Mod') && c.length > 2);

/* Built on the search box's own values (InstantSearch.jsx, .isx-*), so the
   two read as one family: the same blurred scrim, card, edge, header row,
   esc button, section labels and chips, in both modes. The window is
   portalled to <body>, outside the app's [data-dark] root, so it carries
   the attribute itself. */
const CSS = `
.sks-scrim { position: fixed; inset: 0; z-index: 320; background: rgba(0,0,0,0.6);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); animation: sksFade .16s ease both; }
@keyframes sksFade { from { opacity: 0; } }
.sks { position: fixed; top: 84px; left: 50%; transform: translateX(-50%); width: min(720px, calc(100vw - 80px));
  max-height: calc(100vh - 180px); display: flex; flex-direction: column; overflow: hidden;
  border-radius: 18px; border: 1px solid rgba(var(--st-fg-rgb), 0.13); background: rgba(15,15,17,0.975);
  box-shadow: 0 40px 100px rgba(0,0,0,0.75); animation: sksIn .18s cubic-bezier(.22,.9,.3,1) both; }
@keyframes sksIn { from { opacity: 0; transform: translateX(-50%) translateY(-8px); } }
.sks-head { display: flex; align-items: center; gap: 10px; padding: 12px 18px; min-height: 58px; box-sizing: border-box; flex-shrink: 0;
  border-bottom: 1px solid rgba(var(--st-fg-rgb), 0.07); }
.sks-head b { font-size: 15px; font-weight: 800; color: var(--st-text, #fff); }
.sks-head span { font-size: 12.5px; color: rgba(var(--st-fg-rgb), 0.42); }
.sks-esc { margin-left: auto; flex-shrink: 0; height: 24px; padding: 0 8px; border-radius: 6px; cursor: pointer; font-family: inherit;
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.02em; border: 1px solid rgba(var(--st-fg-rgb), 0.12);
  background: transparent; color: rgba(var(--st-fg-rgb), 0.42); }
.sks-esc:hover { color: #fff; background: rgba(var(--st-fg-rgb), 0.08); }
.sks-body { overflow-y: auto; padding: 4px 12px 14px; column-count: 2; column-gap: 16px; }
.sks-row { break-inside: avoid; }
.sks-group { break-after: avoid; break-inside: avoid; }
.sks-group { padding: 12px 10px 5px; font-size: 10px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(var(--st-fg-rgb), 0.3); }
.sks-row { display: flex; align-items: center; gap: 12px; min-height: 33px; padding: 3px 10px; border-radius: 8px; box-sizing: border-box; }
.sks-row:hover { background: rgba(var(--st-fg-rgb), 0.045); }
.sks-label { flex: 1; min-width: 0; font-size: 13px; font-weight: 650; color: var(--st-text, #fff); }
.sks-label span { display: block; font-size: 11px; font-weight: 600; color: rgba(var(--st-fg-rgb), 0.42); }
.sks-keys { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.sks-combo { display: inline-flex; gap: 4px; }
.sks-or { font-size: 10.5px; color: rgba(var(--st-fg-rgb), 0.35); }
.sks-key { min-width: 24px; height: 24px; padding: 0 7px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 6px; font: inherit; font-size: 11px; font-weight: 800; color: var(--st-text, #fff);
  background: rgba(var(--st-fg-rgb), 0.05); border: 1px solid rgba(var(--st-fg-rgb), 0.08); }

.sks-scrim[data-dark] { background: rgba(0,0,0,0.66); }
[data-dark] .sks { background: var(--st-dark-float, rgb(10,10,11)); border-color: rgba(255,255,255,0.08); box-shadow: 0 40px 100px rgba(0,0,0,0.8), 0 0 0 1px rgba(0,0,0,0.6); }
[data-dark] .sks-head { border-bottom-color: rgba(255,255,255,0.06); }
[data-dark] .sks-esc { border-color: rgba(255,255,255,0.1); color: rgba(255,255,255,0.45); }
[data-dark] .sks-group { color: rgba(255,255,255,0.32); }
[data-dark] .sks-key { background: rgb(21,21,24); border-color: rgba(255,255,255,0.07); }
@media (max-width: 700px) { .sks-body { column-count: 1; } }
@media (prefers-reduced-motion: reduce) { .sks-scrim, .sks { animation: none; } }
`;

/** The Keyboard shortcuts window: every shortcut, grouped. */
export function ShortcutsDialog({ onClose, dark = false }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose?.(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="sks-scrim" data-dark={dark ? '' : undefined} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <style>{CSS}</style>
      <div className="sks" role="dialog" aria-modal="true" aria-label="Keyboard Shortcuts">
        <div className="sks-head">
          <b>Keyboard Shortcuts</b>
          <span>Press ? anywhere to open this.</span>
          <button type="button" className="sks-esc" onClick={onClose} aria-label="Close">Esc</button>
        </div>
        <div className="sks-body sth-libscroll">
          {SHORTCUTS.map((g) => (
            <section key={g.group} aria-label={g.group}>
              <div className="sks-group">{g.group}</div>
              {g.items.map((it) => (
                <div key={it.id} className="sks-row">
                  <span className="sks-label">{it.label}{it.note ? <span>{it.note}</span> : null}</span>
                  <span className="sks-keys">
                    {it.keys.map((combo, i) => (
                      <React.Fragment key={combo.join('+')}>
                        {i ? <span className="sks-or">or</span> : null}
                        <span className="sks-combo">
                          {combo.map((k) => <kbd key={k} className="sks-key">{keyName(k)}</kbd>)}
                        </span>
                      </React.Fragment>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
