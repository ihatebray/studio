import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FONT_GROUPS, getAllPresets, loadFontPreview } from '../../lib/uiFonts.js';
import { addFontFiles, removeCustomFont } from '../../lib/customFonts.js';

/* Settings → Font. Every option is drawn in its own face, so picking is by
   eye. Fonts you own (Modulus Pro and the like) are added as files and
   kept in the app, under My fonts. */

const SAMPLE = 'Pink + White · Frank Ocean';

const CSS = `
.stf-hero { display: flex; align-items: center; gap: 18px; padding: 18px 20px; border-radius: 14px;
  background: rgba(var(--st-fg-rgb), 0.04); border: 1px solid rgba(var(--st-fg-rgb), 0.08); margin-bottom: 18px; }
.stf-hero .aa { font-size: 54px; line-height: 1; font-weight: 600; letter-spacing: -0.01em; }
.stf-hero .nm { font-size: 18px; font-weight: 700; }
.stf-hero .sm { margin-top: 4px; font-size: 14px; color: var(--text-dim); }
.stf-tools { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
.stf-tools .st-input { flex: 1 1 220px; max-width: 320px; }
.stf-group { margin-bottom: 22px; }
.stf-group h3 { margin: 0 0 10px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-dim); }
.stf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 8px; }
.stf-card { position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 14px 14px 12px;
  border-radius: 12px; border: 1px solid rgba(var(--st-fg-rgb), 0.08); background: rgba(var(--st-fg-rgb), 0.03);
  color: inherit; cursor: pointer; text-align: left; transition: background .14s ease, border-color .14s ease; }
.stf-card:hover { background: rgba(var(--st-fg-rgb), 0.07); }
.stf-card.on { border-color: rgba(var(--accent-rgb, 255,255,255), 0.85); background: rgba(var(--accent-rgb, 255,255,255), 0.08); }
.stf-card .aa { font-size: 30px; line-height: 1.05; font-weight: 500; }
.stf-card .nm { font-size: 13.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.stf-card .tick { position: absolute; top: 10px; right: 10px; width: 18px; height: 18px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; background: rgb(var(--accent-rgb, 255,255,255)); color: var(--accent-ink, #000); }
.stf-card .x { position: absolute; top: 8px; right: 8px; width: 22px; height: 22px; border-radius: 6px; border: none; background: transparent;
  color: var(--text-dim); cursor: pointer; display: none; align-items: center; justify-content: center; }
.stf-card:hover .x { display: flex; }
.stf-card.on .x { right: 32px; }
.stf-card .x:hover { color: #fff; background: rgba(var(--st-fg-rgb), 0.1); }
.stf-add { border-style: dashed; justify-content: center; align-items: center; min-height: 88px; color: var(--text-dim); font-size: 13px; font-weight: 600; }
.stf-add:hover { color: #fff; }
.stf-note { margin: 10px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--text-dim); max-width: 620px; }
.stf-msg { margin-top: 8px; font-size: 12.5px; color: var(--text-dim); }
.stf-empty { font-size: 13px; color: var(--text-dim); padding: 8px 0; }
`;

export default function FontSettings({ uiFontId, onSetUiFontId }) {
  const [query, setQuery] = useState('');
  const [version, setVersion] = useState(0); // bumps when your fonts change
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const fileRef = useRef(null);

  const presets = useMemo(() => getAllPresets(), [version]);
  const current = presets.find((p) => p.id === uiFontId) || presets.find((p) => !p.isCustom);
  useEffect(() => { presets.forEach((p) => loadFontPreview(p, SAMPLE)); }, [presets]);

  const q = query.trim().toLowerCase();
  const shown = q ? presets.filter((p) => p.label.toLowerCase().includes(q)) : presets;

  const onFiles = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    setBusy(true);
    setMsg('');
    try {
      const { added, skipped } = await addFontFiles(files);
      setVersion((v) => v + 1);
      const parts = [];
      if (added.length) parts.push(`Added ${added.join(', ')}.`);
      if (skipped.length) parts.push(`Skipped ${skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}.`);
      setMsg(parts.join(' '));
      if (added.length === 1) onSetUiFontId?.(`custom-${added[0].toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
    } catch (err) {
      setMsg(`Couldn't add those files: ${err?.message || err}`);
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (p) => {
    await removeCustomFont(p.id);
    if (p.id === uiFontId) onSetUiFontId?.(presets.find((x) => !x.isCustom).id);
    setVersion((v) => v + 1);
  };

  const card = (p) => {
    const on = p.id === current?.id;
    return (
      <div key={p.id} role="button" tabIndex={0} aria-pressed={on} className={`stf-card${on ? ' on' : ''}`}
        style={{ fontFamily: p.stack }} title={p.label}
        onClick={() => onSetUiFontId?.(p.id)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSetUiFontId?.(p.id); } }}>
        <span className="aa">Aa</span>
        <span className="nm">{p.label}</span>
        {on ? (
          <span className="tick" aria-hidden>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="5 12.5 10 17.5 19 7" /></svg>
          </span>
        ) : null}
        {p.isCustom ? (
          <button type="button" className="x" aria-label={`Remove ${p.label}`} title="Remove"
            onClick={(e) => { e.stopPropagation(); onRemove(p); }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <div>
      <style>{CSS}</style>
      <div className="stf-hero" style={{ fontFamily: current?.stack }}>
        <span className="aa">Aa</span>
        <span>
          <div className="nm">{current?.label}</div>
          <div className="sm">{SAMPLE}</div>
        </span>
      </div>

      <div className="stf-tools">
        <input className="st-input" type="search" placeholder="Find a font" value={query}
          onChange={(e) => setQuery(e.target.value)} aria-label="Find a font" />
      </div>

      {FONT_GROUPS.map((group) => {
        const list = shown.filter((p) => p.group === group);
        const mine = group === 'My fonts';
        if (!mine && !list.length) return null;
        if (mine && q && !list.length) return null;
        return (
          <section key={group} className="stf-group">
            <h3>{group}</h3>
            <div className="stf-grid">
              {list.map(card)}
              {mine ? (
                <button type="button" className="stf-card stf-add" disabled={busy} onClick={() => fileRef.current?.click()}>
                  {busy ? 'Adding…' : '+ Add Font Files'}
                </button>
              ) : null}
            </div>
            {mine ? (
              <>
                <input ref={fileRef} type="file" multiple accept=".woff2,.woff,.ttf,.otf" hidden onChange={onFiles} />
                <p className="stf-note">
                  For a font you own, like Modulus Pro: select all of its files at once (for example
                  ModulusPro-Regular.otf, ModulusPro-Medium.otf, ModulusPro-Bold.otf). Files named alike become one
                  font, with each weight taken from the file name. They're kept in Studio, so the originals can stay
                  where they are.
                </p>
                {msg ? <div className="stf-msg">{msg}</div> : null}
              </>
            ) : null}
          </section>
        );
      })}
      {q && !shown.length ? <div className="stf-empty">No font matches “{query}”.</div> : null}
    </div>
  );
}
