/* =========================================================================
 *  studio — the notifications panel (bell in the top bar)
 *
 *  Toasts disappear after a few seconds; this is where they stay. Each entry
 *  has the short title the toast showed, the explanation behind it (what
 *  happened, what it affects, what Studio is doing about it), where it came
 *  from and when. The same notice again folds into one entry with a count.
 *
 *  The history itself lives in Toasts.jsx (recordNotice / useNotices), so
 *  anything that raises a warning or error toast lands here without asking.
 * ========================================================================= */

import React, { useEffect, useRef, useState } from 'react';
import { useNotices, markNoticesSeen, clearNotices, removeNotice, OPEN_NOTICES_EVENT, KindIcon, KIND_RGB } from './Toasts.jsx';
import { ago } from '../lib/format.js';
import { installUpdate, markUpdateSeen, useUpdate } from './updates.js';

const stamp = (at) => new Date(at).toLocaleString(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
});

const CSS = `
.stn-wrap { position: relative; }
.stn-bell { position: relative; width: 34px; height: 34px; border-radius: 10px; border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center; background: transparent;
  color: rgba(var(--st-fg-rgb), 0.5); transition: background 0.16s ease, color 0.16s ease; }
.stn-bell:hover, .stn-bell.on { background: rgba(var(--st-fg-rgb), 0.08); color: #fff; }
.stn-badge { position: absolute; top: 3px; right: 2px; min-width: 16px; height: 16px; padding: 0 4px; box-sizing: border-box;
  border-radius: 999px; font-size: 9.5px; font-weight: 800; line-height: 16px; text-align: center;
  background: var(--accent); color: var(--accent-ink); box-shadow: 0 0 0 2px rgb(var(--st-bg-rgb, 0,0,0)); }
.stn-badge.is-bad { background: rgb(243, 114, 114); color: #1a0b0b; }
.stn-panel { -webkit-app-region: no-drag; position: absolute; top: calc(100% + 8px); right: 0; z-index: 96; width: min(420px, calc(100vw - 32px));
  max-height: min(72vh, 600px); display: flex; flex-direction: column; overflow: hidden;
  border-radius: 14px; background: rgba(22, 22, 24, 0.985); border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 22px 60px rgba(0, 0, 0, 0.55); transform-origin: top right;
  animation: stnIn 0.22s cubic-bezier(0.22, 1, 0.36, 1) both; }
@keyframes stnIn { from { opacity: 0; transform: translateY(-6px) scale(0.98); } }
.stn-head { display: flex; align-items: center; gap: 10px; padding: 14px 14px 10px 16px; border-bottom: 1px solid rgba(255,255,255,0.06); }
.stn-head b { font-size: 14px; font-weight: 800; color: #fff; }
.stn-head span { font-size: 11.5px; color: rgba(255,255,255,0.45); }
.stn-clear { margin-left: auto; border: none; background: transparent; color: rgba(255,255,255,0.6); font: inherit;
  font-size: 12px; font-weight: 700; padding: 5px 8px; border-radius: 7px; cursor: pointer; }
.stn-clear:hover { background: rgba(255,255,255,0.07); color: #fff; }
.stn-list { overflow-y: auto; padding: 6px; }
.stn-item { position: relative; display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 11px; padding: 11px 30px 11px 10px;
  border-radius: 10px; }
.stn-item:hover { background: rgba(255,255,255,0.04); }
.stn-item.is-new::after { content: ''; position: absolute; left: 3px; top: 50%; width: 3px; height: 18px; margin-top: -9px;
  border-radius: 2px; background: rgb(var(--tk)); }
.stn-ic { width: 22px; height: 22px; border-radius: 999px; display: flex; align-items: center; justify-content: center;
  background: rgba(var(--tk), 0.16); color: rgb(var(--tk)); margin-top: 1px; }
.stn-t { font-size: 13px; font-weight: 700; color: rgba(255,255,255,0.95); line-height: 1.35; }
.stn-d { font-size: 12px; color: rgba(255,255,255,0.64); line-height: 1.5; margin-top: 3px; }
.stn-m { font-size: 11px; color: rgba(255,255,255,0.4); margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; }
.stn-m .n { padding: 0 6px; border-radius: 999px; background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.65); font-weight: 700; }
.stn-x { position: absolute; top: 9px; right: 6px; width: 22px; height: 22px; border: none; border-radius: 6px; padding: 0; cursor: pointer;
  background: transparent; color: rgba(255,255,255,0.35); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.14s; }
.stn-item:hover .stn-x { opacity: 1; }
.stn-x:hover { color: #fff; background: rgba(255,255,255,0.08); }
.stn-empty { padding: 40px 20px 44px; text-align: center; color: rgba(255,255,255,0.5); font-size: 12.5px; }
.stn-empty b { display: block; color: rgba(255,255,255,0.85); font-size: 14px; margin-bottom: 4px; }
/* A new version, pinned above the list until it's installed. */
.stn-up { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 11px; margin: 6px 6px 0; padding: 12px 12px 12px 10px;
  border-radius: 10px; background: rgba(255,255,255,0.05); }
.stn-up .stn-ic { background: rgba(255,255,255,0.12); color: #fff; }
.stn-up-btn { margin-top: 10px; height: 30px; padding: 0 14px; border: none; border-radius: 999px; cursor: pointer; font: inherit;
  font-size: 12.5px; font-weight: 800; background: #fff; color: #0a0a0b; transition: filter 0.14s ease; }
.stn-up-btn:hover { filter: brightness(0.9); }
@media (prefers-reduced-motion: reduce) { .stn-panel { animation: none; } }
`;

export default function NotificationsButton() {
  const { items, seenAt, unread: unreadNotices } = useNotices();
  const update = useUpdate();
  const unread = unreadNotices + (update.unseen ? 1 : 0);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const wrap = useRef(null);
  // What was new when the panel opened stays marked while it's open.
  const [openedSeenAt, setOpenedSeenAt] = useState(0);

  const show = () => { setOpenedSeenAt(seenAt); setNow(Date.now()); setOpen(true); };
  const toggle = () => (open ? setOpen(false) : show());

  useEffect(() => {
    const onOpen = () => show();
    window.addEventListener(OPEN_NOTICES_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_NOTICES_EVENT, onOpen);
  });

  // The compact top bar hid (StudioHome): close with it.
  useEffect(() => {
    const onHidden = () => setOpen(false);
    window.addEventListener('studio:topbar-hidden', onHidden);
    return () => window.removeEventListener('studio:topbar-hidden', onHidden);
  }, []);

  // Open means read, including anything that arrives while it's open.
  useEffect(() => { if (open) { markNoticesSeen(); markUpdateSeen(); } }, [open, items, update.status.version]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { clearInterval(tick); document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const unreadBad = items.some((n) => n.at > seenAt && n.kind === 'error');

  return (
    <div className="stn-wrap" ref={wrap}>
      <style>{CSS}</style>
      <button type="button" className={`stn-bell${open ? ' on' : ''}`} onClick={toggle}
        title="Notifications" aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'} aria-expanded={open}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread ? <span className={`stn-badge${unreadBad ? ' is-bad' : ''}`}>{unread > 9 ? '9+' : unread}</span> : null}
      </button>
      {open ? (
        <div className="stn-panel" role="dialog" aria-label="Notifications" data-topbar-dropdown>
          <div className="stn-head">
            <b>Notifications</b>
            {items.length ? <span>{items.length}</span> : null}
            {items.length ? <button type="button" className="stn-clear" onClick={clearNotices}>Clear all</button> : null}
          </div>
          {update.offer || update.status.state === 'downloading' ? <UpdateRow status={update.status} /> : null}
          <div className="stn-list">
            {items.length === 0 && !update.offer && update.status.state !== 'downloading' ? (
              <div className="stn-empty"><b>You’re all caught up</b>New versions of Studio, and problems it runs into like Spotify rate limits, show up here.</div>
            ) : items.map((n) => (
              <div key={n.id} className={`stn-item${n.at > openedSeenAt ? ' is-new' : ''}`}
                style={{ '--tk': KIND_RGB[n.kind] || 'var(--st-acc-rgb, 190, 190, 196)' }}>
                <span className="stn-ic"><KindIcon kind={n.kind} /></span>
                <div style={{ minWidth: 0 }}>
                  <div className="stn-t">{n.title}</div>
                  {n.detail ? <div className="stn-d">{n.detail}</div> : null}
                  <div className="stn-m">
                    {n.source ? <span>{n.source}</span> : null}
                    {n.source ? <span>·</span> : null}
                    <span title={stamp(n.at)}>{ago(n.at, now)} · {stamp(n.at)}</span>
                    {n.count > 1 ? <span className="n">×{n.count}</span> : null}
                  </div>
                </div>
                <button type="button" className="stn-x" onClick={() => removeNotice(n.id)} aria-label="Remove">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The new version at the top of the panel, with the button that installs it. */
function UpdateRow({ status: s }) {
  const ready = s.state === 'ready';
  const busy = s.state === 'downloading';
  return (
    <div className="stn-up">
      <span className="stn-ic">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 4v12M6 11l6 6 6-6M5 20h14" />
        </svg>
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="stn-t">{busy ? `Downloading Studio ${s.version}…` : ready ? `Studio ${s.version} is ready` : `Studio ${s.version} is out`}</div>
        <div className="stn-d">
          {busy ? 'It downloads in the background. You can keep listening.'
            : ready ? `You’re on ${s.current}. Restart to update; your library and settings stay as they are.`
              : `You’re on ${s.current}. This copy of Studio can’t update itself, so download the new one from GitHub.`}
        </div>
        {busy ? null : (
          <button type="button" className="stn-up-btn" onClick={() => { installUpdate(); }}>
            {ready ? 'Restart to update' : 'Download'}
          </button>
        )}
      </div>
    </div>
  );
}
