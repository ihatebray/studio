import React, { useCallback, useEffect, useState } from 'react';

/* =========================================================================
 *  MiniPlayerSettings — the Settings-page card for the mini player.
 *
 *  Self-contained: it reads and writes the mini player's options straight
 *  over IPC rather than threading them through App.jsx, because nothing else
 *  in the renderer needs them. Drop it into StudioHome's settings section and
 *  hand it the current `accent`.
 *
 *  Options live in main (userData/miniplayer.json) so they survive a reload
 *  and so the window can honour them before the renderer has painted.
 * ========================================================================= */

const STYLES = [
  ['full', 'Full', 'Art, scrubber, shuffle and repeat — everything.'],
  ['compact', 'Compact', 'Art, title, and three buttons. The default.'],
  ['minimal', 'Minimal', 'A single strip. Progress is the bottom edge.'],
  ['art', 'Art only', 'Just the cover. Controls appear on hover.'],
];

const DEFAULTS = {
  style: 'compact', alwaysOnTop: true, opacity: 1,
  clickThrough: false, hideMain: false, autoHideChrome: true, showProgress: true,
};

function readable(accent, minLum = 165) {
  const parts = String(accent || '').split(',').map((s) => parseInt(s.trim(), 10));
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return '150, 150, 150';
  let [r, g, b] = parts;
  const lum = () => 0.299 * r + 0.587 * g + 0.114 * b;
  let guard = 0;
  while (lum() < minLum && guard < 24) { r += (255 - r) * 0.16; g += (255 - g) * 0.16; b += (255 - b) * 0.16; guard += 1; }
  return `${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}`;
}

export default function MiniPlayerSettings({ accent = '150, 150, 150' }) {
  const [options, setOptions] = useState(DEFAULTS);
  const [open, setOpen] = useState(false);
  const [available, setAvailable] = useState(true);
  const a = readable(accent);

  useEffect(() => {
    const mini = window.electronAPI?.mini;
    if (!mini?.getState) { setAvailable(false); return undefined; }
    mini.getState().then((s) => {
      if (s?.options) setOptions({ ...DEFAULTS, ...s.options });
      setOpen(!!s?.open);
    }).catch(() => setAvailable(false));
    const offOpen = mini.onOpenChanged?.((v) => setOpen(!!v));
    const offOpts = mini.onOptions?.((o) => setOptions((p) => ({ ...p, ...(o || {}) })));
    return () => { offOpen?.(); offOpts?.(); };
  }, []);

  const setOpt = useCallback((patch) => {
    setOptions((p) => ({ ...p, ...patch }));
    window.electronAPI?.mini?.setOptions?.(patch);
  }, []);

  if (!available) return null;

  return (
    <>
      <div style={{ fontSize: 13.5, fontWeight: 700, letterSpacing: '0.01em', color: '#fff', margin: '0 2px 14px' }}>
        Mini player
      </div>

      <div className="sth-card" style={{ padding: 14, marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>
              {open ? 'Mini player is open' : 'Open the mini player'}
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 3, lineHeight: 1.45 }}>
              A small, resizable window that floats over other apps. Press <Kbd>Ctrl</Kbd> <Kbd>Alt</Kbd> <Kbd>M</Kbd> to
              open or close it from anywhere, even mid-game.
            </div>
          </div>
          <button
            type="button"
            onClick={() => window.electronAPI?.mini?.toggle?.()}
            style={{
              flexShrink: 0, padding: '9px 16px', borderRadius: 10, cursor: 'pointer',
              fontSize: 12, fontWeight: 700,
              border: `1px solid rgba(${a},${open ? 0.3 : 0.5})`,
              background: open ? 'rgba(255,255,255,0.05)' : `rgba(${a},0.16)`,
              color: open ? 'rgba(255,255,255,0.7)' : `rgb(${a})`,
              transition: 'background 0.16s ease, color 0.16s ease, border-color 0.16s ease',
            }}
          >
            {open ? 'Close' : 'Open'}
          </button>
        </div>

        <div style={{ marginTop: 14, paddingTop: 13, borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          <Label>Layout</Label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
            {STYLES.map(([id, label, hint]) => {
              const on = options.style === id;
              return (
                <button key={id} type="button" onClick={() => setOpt({ style: id })} style={{
                  padding: '10px 11px', borderRadius: 11, cursor: 'pointer', textAlign: 'left',
                  border: `1px solid ${on ? `rgba(${a},0.5)` : 'rgba(255,255,255,0.1)'}`,
                  background: on ? `rgba(${a},0.14)` : 'rgba(255,255,255,0.04)',
                  transition: 'background 0.16s ease, border-color 0.16s ease',
                }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: on ? `rgb(${a})` : 'rgba(255,255,255,0.85)' }}>{label}</div>
                  <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.45)', marginTop: 3, lineHeight: 1.4 }}>{hint}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <Label>Opacity — {Math.round(options.opacity * 100)}%</Label>
          <input
            type="range" min={0.35} max={1} step={0.01} value={options.opacity}
            onChange={(e) => setOpt({ opacity: Number(e.target.value) })}
            aria-label="Mini player opacity"
            style={{
              width: '100%', height: 4, appearance: 'none', WebkitAppearance: 'none',
              borderRadius: 999, outline: 'none', cursor: 'pointer',
              background: `linear-gradient(90deg, rgb(${a}) ${((options.opacity - 0.35) / 0.65) * 100}%, rgba(255,255,255,0.16) ${((options.opacity - 0.35) / 0.65) * 100}%)`,
            }}
          />
        </div>

        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Row accent={a} on={options.alwaysOnTop} onChange={(v) => setOpt({ alwaysOnTop: v })}
            title="Keep on top"
            hint="Floats above other windows. Works over borderless and windowed games; exclusive fullscreen will still cover it — switch the game to borderless if it does." />
          <Row accent={a} on={options.clickThrough} onChange={(v) => setOpt({ clickThrough: v })}
            title="Click-through"
            hint={<>Clicks pass straight to whatever is underneath. Hover the mini player to wake it, or press <Kbd>Ctrl</Kbd> <Kbd>Alt</Kbd> <Kbd>G</Kbd> to turn it off.</>} />
          <Row accent={a} on={options.hideMain} onChange={(v) => setOpt({ hideMain: v })}
            title="Hide the studio window"
            hint="Tucks the main window away while the mini player is open, so only the mini shows in your taskbar." />
          <Row accent={a} on={options.autoHideChrome} onChange={(v) => setOpt({ autoHideChrome: v })}
            title="Hide buttons when idle"
            hint="Pin, layout and close fade out until you move the mouse over the window." />
          <Row accent={a} on={options.showProgress} onChange={(v) => setOpt({ showProgress: v })}
            title="Show progress"
            hint="The scrubber. Turn off for a cleaner strip when you only want the title." />
        </div>
      </div>
    </>
  );
}

function Label({ children }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
      color: 'rgba(255,255,255,0.4)', marginBottom: 7,
    }}>
      {children}
    </div>
  );
}

function Kbd({ children }) {
  return (
    <span style={{
      display: 'inline-block', padding: '1px 5px', borderRadius: 4,
      background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)',
      color: 'rgba(255,255,255,0.85)', fontSize: 10,
      fontFamily: 'ui-monospace, SF Mono, Menlo, Consolas, monospace',
    }}>{children}</span>
  );
}

function Row({ title, hint, on, onChange, accent }) {
  return (
    <button type="button" onClick={() => onChange(!on)} style={{
      display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
      padding: '10px 11px', borderRadius: 11, cursor: 'pointer',
      border: `1px solid ${on ? `rgba(${accent},0.4)` : 'rgba(255,255,255,0.09)'}`,
      background: on ? `rgba(${accent},0.12)` : 'rgba(255,255,255,0.035)',
      transition: 'background 0.18s ease, border-color 0.18s ease',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: '#fff' }}>{title}</div>
        <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.48)', marginTop: 3, lineHeight: 1.45 }}>{hint}</div>
      </div>
      <div aria-hidden style={{
        width: 36, height: 21, borderRadius: 999, flexShrink: 0, position: 'relative',
        background: on ? `rgba(${accent},0.85)` : 'rgba(255,255,255,0.14)',
        border: '1px solid rgba(255,255,255,0.18)', transition: 'background 0.18s ease',
      }}>
        <div style={{
          position: 'absolute', top: 2, left: on ? 16 : 2, width: 15, height: 15, borderRadius: '50%',
          background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
          transition: 'left 0.18s cubic-bezier(0.3, 0.9, 0.3, 1)',
        }} />
      </div>
    </button>
  );
}
