import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/* =========================================================================
 *  VolumeControl: mute, volume and boost, for the Now Playing bar and the
 *  full view.
 *
 *  Boost is gain past full volume, for quietly mastered tracks. It is set
 *  in dB (0 to +24) because that is linear to the ear; App stores it as a
 *  multiplier (1 to 16x), so every +6 dB is one doubling. Local files get
 *  it from App's Web Audio graph and Spotify from the helper's sink, each
 *  with a limiter after it; the meter shows how much that limiter is
 *  taking back, which is the cost of the extra gain.
 * ========================================================================= */

const MAX_DB = 24;
const PRESETS = [0, 3, 6, 12];
const TICKS = [0, 6, 12, 18, 24];
/** Reduction the meter treats as full scale. */
const METER_DB = 12;

const toDb = (boost) => Math.max(0, Math.min(MAX_DB, 20 * Math.log10(Math.max(1, Number(boost) || 1))));
const toBoost = (db) => Math.min(16, Math.max(1, 10 ** (db / 20)));
/** Where fraction `f` of the range sits, matching the knob's travel. */
const at = (f) => `calc(7px + (100% - 14px) * ${f})`;
const fmtDb = (db) => (db < 0.05 ? 'Off' : `+${db.toFixed(db >= 10 ? 0 : 1)} dB`);

const CSS = `
.stv-boost { position: relative; height: 24px; min-width: 34px; padding: 0 6px; margin-left: 4px; border-radius: 999px;
  border: 1px solid transparent; background: transparent; color: rgba(255,255,255,0.55); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px; font: inherit; font-size: 10.5px;
  font-weight: 700; letter-spacing: 0.02em; font-variant-numeric: tabular-nums; flex-shrink: 0;
  transition: color .14s ease, background .14s ease, border-color .14s ease; }
.stv-boost:hover, .stv-boost.open { color: #fff; background: rgba(255,255,255,0.08); }
.stv-boost.on { color: #fff; border-color: rgba(255,255,255,0.22); background: rgba(255,255,255,0.08); }
.stv-boost.on:hover, .stv-boost.on.open { background: rgba(255,255,255,0.14); }
.stv-boost .stv-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent, #fff); box-shadow: 0 0 6px var(--accent, #fff); }

.stv-pop { position: fixed; z-index: 9000; box-sizing: border-box; width: 272px; padding: 14px 14px 12px; border-radius: 14px;
  background: rgba(22,22,24,0.985); border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 22px 60px rgba(0,0,0,0.55);
  color: #fff; font-size: 12px; transform-origin: bottom right; animation: stv-in .14s ease-out;
  -webkit-app-region: no-drag; }
@keyframes stv-in { from { opacity: 0; transform: translateY(4px) scale(.98); } to { opacity: 1; transform: none; } }
.stv-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 12px; }
.stv-title { font-size: 12px; font-weight: 700; color: rgba(255,255,255,0.86); }
.stv-read { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; line-height: 1; }
.stv-read.off { color: rgba(255,255,255,0.4); }

.stv-range { position: relative; height: 22px; }
.stv-range input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.stv-rail { position: absolute; left: 0; right: 0; top: 9px; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.12); overflow: hidden; pointer-events: none; }
.stv-fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 2px;
  background: linear-gradient(90deg, rgba(255,255,255,0.75), var(--accent, #fff)); }
.stv-knob { position: absolute; top: 4px; width: 14px; height: 14px; margin-left: -7px; border-radius: 50%; background: #fff;
  box-shadow: 0 1px 4px rgba(0,0,0,0.6); pointer-events: none; transition: transform .12s ease; }
.stv-range:hover .stv-knob, .stv-range input:focus-visible ~ .stv-knob { transform: scale(1.12); }
.stv-range input:focus-visible ~ .stv-knob { box-shadow: 0 0 0 3px rgba(255,255,255,0.25), 0 1px 4px rgba(0,0,0,0.6); }
.stv-ticks { position: relative; height: 14px; margin-top: 2px; }
.stv-ticks span { position: absolute; transform: translateX(-50%); font-size: 9.5px; color: rgba(255,255,255,0.38); font-variant-numeric: tabular-nums; }

.stv-presets { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin: 10px 0 12px; padding: 3px;
  border-radius: 9px; background: rgba(255,255,255,0.05); }
.stv-presets button { height: 24px; border: none; border-radius: 6px; background: transparent; color: rgba(255,255,255,0.6);
  font: inherit; font-size: 11px; font-weight: 700; cursor: pointer; font-variant-numeric: tabular-nums; }
.stv-presets button:hover { color: #fff; background: rgba(255,255,255,0.06); }
.stv-presets button.on { color: #000; background: #fff; }

.stv-meter { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px; }
.stv-meter-label { font-size: 10.5px; font-weight: 700; color: rgba(255,255,255,0.5); text-transform: uppercase; letter-spacing: 0.06em; }
.stv-meter-bar { display: grid; grid-template-columns: repeat(12, 1fr); gap: 2px; height: 8px; direction: rtl; }
.stv-meter-bar i { border-radius: 1.5px; background: rgba(255,255,255,0.08); transition: background .08s linear; }
.stv-meter-bar i.lit { background: rgba(255,255,255,0.85); }
.stv-meter-bar i.lit.hot { background: rgb(255,170,90); }
.stv-meter-bar i.lit.over { background: rgb(243,114,114); }
.stv-meter-val { min-width: 48px; text-align: right; font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; color: rgba(255,255,255,0.75); }
.stv-meter-val.idle { color: rgba(255,255,255,0.35); font-weight: 600; }
.stv-note { margin-top: 10px; font-size: 11px; line-height: 1.45; color: rgba(255,255,255,0.45); }
`;

function BoostIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 9.5h3L10 6v12l-4-3.5H3z" /><path d="M17 8.5v7M13.5 12h7" />
    </svg>
  );
}

/** Limiter gain reduction, polled while the popover is open. */
function useReduction(getGainReduction, live) {
  const [db, setDb] = useState(0);
  useEffect(() => {
    if (!live || !getGainReduction) { setDb(0); return undefined; }
    let raf = 0;
    let last = 0;
    let shown = 0;
    const tick = (t) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 50) return;
      last = t;
      const v = Number(getGainReduction()) || 0;
      // Fast attack, slow fall: easier to read than the raw value.
      shown = v < shown ? v : shown + (v - shown) * 0.25;
      setDb(Math.abs(shown) < 0.05 ? 0 : shown);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [live, getGainReduction]);
  return db;
}

function BoostPopover({ anchor, boost, onSetBoost, getGainReduction, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const db = toDb(boost);
  const reduction = useReduction(getGainReduction, db > 0);

  useLayoutEffect(() => {
    const place = () => {
      const r = anchor?.getBoundingClientRect();
      if (!r) return;
      const w = 272;
      const left = Math.max(12, Math.min(window.innerWidth - w - 12, r.right - w));
      setPos({ left, bottom: window.innerHeight - r.top + 10 });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);

  useEffect(() => {
    const down = (e) => {
      if (ref.current?.contains(e.target) || anchor?.contains(e.target)) return;
      onClose();
    };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [anchor, onClose]);

  if (!pos) return null;
  const pct = (db / MAX_DB) * 100;
  const lit = Math.round(Math.min(1, -reduction / METER_DB) * 12);
  return createPortal(
    <div ref={ref} className="stv-pop" role="dialog" aria-label="Volume boost" style={pos}>
      <div className="stv-head">
        <span className="stv-title">Boost</span>
        <span className={`stv-read${db < 0.05 ? ' off' : ''}`}>{fmtDb(db)}</span>
      </div>
      <div className="stv-range">
        <input type="range" min={0} max={MAX_DB} step={0.5} value={db} aria-label="Boost in decibels"
          aria-valuetext={fmtDb(db)} onChange={(e) => onSetBoost(toBoost(Number(e.target.value)))} />
        <div className="stv-rail"><div className="stv-fill" style={{ width: `${pct}%` }} /></div>
        <div className="stv-knob" style={{ left: at(pct / 100) }} />
      </div>
      <div className="stv-ticks" aria-hidden>
        {TICKS.map((t) => <span key={t} style={{ left: at(t / MAX_DB) }}>{t ? `+${t}` : '0'}</span>)}
      </div>
      <div className="stv-presets">
        {PRESETS.map((p) => (
          <button key={p} type="button" className={Math.abs(db - p) < 0.25 ? 'on' : ''}
            onClick={() => onSetBoost(toBoost(p))}>{p ? `+${p}` : 'Off'}</button>
        ))}
      </div>
      <div className="stv-meter" title="How much the limiter is turning peaks down to keep the boost from clipping">
        <span className="stv-meter-label">Limiter</span>
        <div className="stv-meter-bar" aria-hidden>
          {Array.from({ length: 12 }, (_, i) => (
            <i key={i} className={i < lit ? `lit${i >= 9 ? ' over' : i >= 5 ? ' hot' : ''}` : ''} />
          ))}
        </div>
        <span className={`stv-meter-val${reduction === 0 ? ' idle' : ''}`}>
          {db < 0.05 ? 'Bypassed' : reduction === 0 ? 'Idle' : `−${Math.abs(reduction).toFixed(1)} dB`}
        </span>
      </div>
      <div className="stv-note">
        Lifts quiet tracks past full volume, for local files and Spotify. If the limiter stays lit, the extra gain is mostly being taken back.
      </div>
    </div>,
    document.body,
  );
}

/** Mute button, volume slider and boost button. Renders a fragment so it
 *  slots into whichever cluster holds it. */
export default function VolumeControl({ volume = 1, onSetVolume, boost = 1, onSetBoost, getGainReduction = null, width = 72 }) {
  const lastVol = useRef(volume > 0 ? volume : 0.6);
  useEffect(() => { if (volume > 0) lastVol.current = volume; }, [volume]);
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const muted = volume <= 0.001;
  const db = toDb(boost);
  const pct = volume * 100;
  return (
    <>
      <style>{CSS}</style>
      <button type="button" className="sth-npbtn" onClick={() => onSetVolume(muted ? (lastVol.current || 0.6) : 0)}
        title={muted ? 'Unmute' : 'Mute'} aria-label={muted ? 'Unmute' : 'Mute'} aria-pressed={muted}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
          {muted ? <path d="M16 9.5l5 5M21 9.5l-5 5" /> : <><path d="M15.5 9a4 4 0 0 1 0 6" />{volume > 0.5 ? <path d="M18.5 6.5a8 8 0 0 1 0 11" /> : null}</>}
        </svg>
      </button>
      <input type="range" min={0} max={1} step={0.01} value={volume}
        onChange={(e) => onSetVolume(Number(e.target.value))}
        className="sth-vol" aria-label="Volume"
        style={{ width, background: `linear-gradient(to right, #fff 0%, #fff ${pct}%, rgba(255,255,255,0.16) ${pct}%, rgba(255,255,255,0.16) 100%)` }} />
      {onSetBoost ? (
        <button ref={btnRef} type="button" className={`stv-boost${db >= 0.05 ? ' on' : ''}${open ? ' open' : ''}`}
          onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open}
          title={db >= 0.05 ? `Boost ${fmtDb(db)}` : 'Boost'} aria-label={db >= 0.05 ? `Boost, ${fmtDb(db)}` : 'Boost'}>
          {db >= 0.05 ? <><span className="stv-dot" />{`+${Math.round(db)}`}</> : <BoostIcon />}
        </button>
      ) : null}
      {open && onSetBoost ? (
        <BoostPopover anchor={btnRef.current} boost={boost} onSetBoost={onSetBoost}
          getGainReduction={getGainReduction} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
