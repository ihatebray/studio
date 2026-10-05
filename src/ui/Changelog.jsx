import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CHANGELOG } from '../changelog.js';

/* Settings → System → Changelog: every version and what came with it.
   Also What's new after an update: the same window with `title` and just
   the `versions` that came since the last one shown. */

const CSS = `
.stcl-scrim { position: fixed; inset: 0; z-index: 320; display: flex; align-items: center; justify-content: center; padding: 24px;
  background: rgba(4,4,6,0.78); animation: stclIn .18s ease both; }
@keyframes stclIn { from { opacity: 0; } }
.stcl { width: min(520px, 100%); max-height: min(78vh, 680px); display: flex; flex-direction: column; overflow: hidden;
  border-radius: 16px; background: rgb(16,16,19); border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 24px 70px rgba(0,0,0,0.6); }
.stcl-head { display: flex; align-items: center; padding: 18px 18px 14px 22px; border-bottom: 1px solid rgba(255,255,255,0.07); }
.stcl-head b { font-size: 16px; font-weight: 800; color: #fff; }
.stcl-x { margin-left: auto; width: 28px; height: 28px; border-radius: 8px; border: none; background: transparent; cursor: pointer;
  color: rgba(255,255,255,0.55); display: flex; align-items: center; justify-content: center; }
.stcl-x:hover { background: rgba(255,255,255,0.08); color: #fff; }
.stcl-body { overflow-y: auto; padding: 6px 22px 22px; }
.stcl-v { padding: 16px 0; }
.stcl-v + .stcl-v { border-top: 1px solid rgba(255,255,255,0.07); }
.stcl-vh { display: flex; align-items: baseline; gap: 10px; }
.stcl-vh b { font-size: 15px; font-weight: 800; color: #fff; }
.stcl-vh span { font-size: 12.5px; color: rgba(255,255,255,0.45); }
.stcl-vh em { margin-left: auto; font-style: normal; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px;
  background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.75); }
.stcl-t { margin-top: 4px; font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.75); }
.stcl ul { margin: 10px 0 0; padding-left: 18px; }
.stcl li { font-size: 13px; line-height: 1.55; color: rgba(255,255,255,0.68); margin: 3px 0; }
`;

const dateText = (iso) => {
  try { return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }); } catch { return iso; }
};

export default function Changelog({ current, onClose, title = 'Changelog', versions = null }) {
  const list = versions ? CHANGELOG.filter((v) => versions.includes(v.version)) : CHANGELOG;
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="stcl-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <style>{CSS}</style>
      <div className="stcl" role="dialog" aria-label={title}>
        <div className="stcl-head">
          <b>{title}</b>
          <button type="button" className="stcl-x" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className="stcl-body">
          {list.map((v) => (
            <section key={v.version} className="stcl-v">
              <div className="stcl-vh">
                <b>{v.version}</b>
                {v.date ? <span>{dateText(v.date)}</span> : null}
                {current && current === v.version ? <em>Installed</em> : null}
              </div>
              {v.title ? <div className="stcl-t">{v.title}</div> : null}
              <ul>{v.notes.map((n) => <li key={n}>{n}</li>)}</ul>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
