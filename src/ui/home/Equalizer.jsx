import React, { useMemo, useRef } from 'react';
import { EQ_BANDS, EQ_MAX_DB, EQ_FLAT, EQ_PRESETS, clampGain, presetOf, responseDb } from '../../lib/eq.js';

/* =========================================================================
 *  The equalizer panel (Settings → Audio): presets, ten band sliders and
 *  the curve they make. The bands are an octave apart, so they sit evenly
 *  on the curve's frequency axis and each slider stands on its own band.
 * ========================================================================= */

const LABELS = ['31', '62', '125', '250', '500', '1K', '2K', '4K', '8K', '16K'];
/** Points across the panel (0 to 1). Band i centres at (i + 0.5) / 10, so
 *  point x is the frequency 31.25 × 2^(10x - 0.5). */
const CURVE_X = Array.from({ length: 121 }, (_, i) => i / 120);
const fmt = (db) => (db > 0 ? `+${db}` : db < 0 ? `${db}` : '0');

const CSS = `
.sth-eq { padding: 20px 0 22px; border-bottom: 1px solid var(--border); }
.sth-eq-presets { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 18px; }
.sth-eq-presets button { height: 30px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--border);
  background: transparent; color: var(--text-dim); font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
  transition: color .12s ease, background .12s ease, border-color .12s ease; }
.sth-eq-presets button:hover { color: var(--text); background: rgba(255,255,255,0.05); }
.sth-eq-presets button.on { color: var(--text); border-color: rgba(255,255,255,0.35); background: rgba(255,255,255,0.08); }
.sth-eq-presets .custom { height: 30px; display: inline-flex; align-items: center; padding: 0 12px; border-radius: 8px;
  font-size: 12.5px; font-weight: 600; color: var(--text); border: 1px dashed rgba(255,255,255,0.3); }
.sth-eq-stage { position: relative; height: 200px; }
.sth-eq-curve { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
.sth-eq-cols { position: absolute; inset: 0; display: grid; grid-template-columns: repeat(10, 1fr); }
.sth-eq-col { position: relative; cursor: ns-resize; touch-action: none; outline: none; }
.sth-eq-col::before { content: ''; position: absolute; left: 50%; top: 0; bottom: 0; width: 2px; margin-left: -1px;
  border-radius: 1px; background: rgba(255,255,255,0.08); }
.sth-eq-knob { position: absolute; left: 50%; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.6); transition: transform .12s ease; pointer-events: none; }
.sth-eq-col:hover .sth-eq-knob { transform: scale(1.12); }
.sth-eq-col:focus-visible .sth-eq-knob { box-shadow: 0 0 0 3px rgba(255,255,255,0.3), 0 1px 4px rgba(0,0,0,0.6); }
.sth-eq-labels { display: grid; grid-template-columns: repeat(10, 1fr); margin-top: 10px; text-align: center;
  font-variant-numeric: tabular-nums; }
.sth-eq-labels b { display: block; font-size: 12px; font-weight: 700; color: var(--text); }
.sth-eq-labels span { display: block; margin-top: 2px; font-size: 11px; font-weight: 500; color: var(--text-dim); }
.sth-eq-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 16px;
  font-size: 12.5px; color: var(--text-dim); }
.sth-eq-foot button { height: 30px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--border); background: transparent;
  color: var(--text); font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; }
.sth-eq-foot button:hover { background: rgba(255,255,255,0.06); }
.sth-eq-foot button:disabled { opacity: 0.4; cursor: default; background: transparent; }
`;

/** Gain to a height across the stage: +12 at the top, -12 at the bottom. */
const yOf = (db) => 50 - (db / EQ_MAX_DB) * 46;

export default function Equalizer({ gains, headroomDb, onChange, disabled = false }) {
  const preset = presetOf(gains);
  const setBand = (i, db) => {
    const v = clampGain(db);
    if (v === gains[i]) return;
    onChange(gains.map((g, j) => (j === i ? v : g)));
  };
  const curve = useMemo(() => CURVE_X.map((x) => {
    const db = responseDb(gains, 31.25 * 2 ** (x * EQ_BANDS.length - 0.5));
    return [x * 100, yOf(Math.max(-EQ_MAX_DB - 2, Math.min(EQ_MAX_DB + 2, db)))];
  }), [gains]);
  const line = curve.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const drag = useRef(null);

  const fromPointer = (e, i) => {
    const r = e.currentTarget.getBoundingClientRect();
    // The knob's travel is the stage's middle 92% (yOf), so map it back.
    const frac = (e.clientY - r.top) / r.height;
    setBand(i, ((50 - frac * 100) / 46) * EQ_MAX_DB);
  };

  return (
    <div className="sth-eq" style={disabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined} aria-disabled={disabled || undefined}>
      <style>{CSS}</style>
      <div className="sth-eq-presets" role="radiogroup" aria-label="Equalizer preset">
        {EQ_PRESETS.map(([id, label, g]) => (
          <button key={id} type="button" role="radio" aria-checked={preset === id} className={preset === id ? 'on' : ''}
            onClick={() => onChange(g)}>{label}</button>
        ))}
        {preset === 'custom' ? <span className="custom">Custom</span> : null}
      </div>
      <div className="sth-eq-stage">
        <svg className="sth-eq-curve" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          {[EQ_MAX_DB, EQ_MAX_DB / 2, -EQ_MAX_DB / 2, -EQ_MAX_DB].map((db) => (
            <line key={db} x1="0" x2="100" y1={yOf(db)} y2={yOf(db)} stroke="rgba(255,255,255,0.05)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}
          <line x1="0" x2="100" y1="50" y2="50" stroke="rgba(255,255,255,0.16)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <path d={`${line} L100 50 L0 50 Z`} fill="var(--accent, #fff)" fillOpacity="0.12" />
          <path d={line} fill="none" stroke="var(--accent, #fff)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </svg>
        <div className="sth-eq-cols">
          {EQ_BANDS.map((f, i) => (
            <div key={f} className="sth-eq-col" role="slider" tabIndex={0}
              aria-label={`${LABELS[i]} Hz`} aria-valuemin={-EQ_MAX_DB} aria-valuemax={EQ_MAX_DB} aria-valuenow={gains[i]}
              aria-valuetext={`${fmt(gains[i])} dB`}
              title="Drag to change. Double-click to reset."
              onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = i; fromPointer(e, i); }}
              onPointerMove={(e) => { if (drag.current === i) fromPointer(e, i); }}
              onPointerUp={() => { drag.current = null; }}
              onPointerCancel={() => { drag.current = null; }}
              onDoubleClick={() => setBand(i, 0)}
              onKeyDown={(e) => {
                const step = { ArrowUp: 0.5, ArrowRight: 0.5, ArrowDown: -0.5, ArrowLeft: -0.5, PageUp: 3, PageDown: -3 }[e.key];
                if (step != null) { e.preventDefault(); setBand(i, gains[i] + step); }
                else if (e.key === 'Home' || e.key === '0') { e.preventDefault(); setBand(i, 0); }
              }}>
              <span className="sth-eq-knob" style={{ top: `${yOf(gains[i])}%` }} />
            </div>
          ))}
        </div>
      </div>
      <div className="sth-eq-labels" aria-hidden>
        {EQ_BANDS.map((f, i) => <div key={f}><b>{fmt(gains[i])}</b><span>{LABELS[i]}</span></div>)}
      </div>
      <div className="sth-eq-foot">
        <span>{headroomDb < 0 ? `Everything is lowered ${Math.abs(headroomDb)} dB to make room for the raised bands.` : 'Nothing is raised, so the level is unchanged.'}</span>
        <button type="button" onClick={() => onChange(EQ_FLAT)} disabled={preset === 'flat'}>Reset</button>
      </div>
    </div>
  );
}
