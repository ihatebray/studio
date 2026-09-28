import React, { useCallback, useEffect, useRef, useState } from 'react';

/* =========================================================================
 *  BoostControl — the volume boost handle in the Now Playing bar.
 *
 *  HTMLAudioElement.volume is clamped to [0, 1] by spec, so a quietly
 *  mastered track has no headroom left once the slider is at the top. The
 *  audio graph in App.jsx routes playback through a GainNode that can
 *  multiply past that cap; this is the handle on it.
 *
 *  ── WHY THIS REPLACES Overlays.jsx's BoostButton ─────────────────────────
 *  That component was written for the immersive dock and never imported by
 *  anything — the feature has been shipping unreachable. It also styles
 *  itself in literal rgba(255,255,255,·), which was correct for a control
 *  floating over artwork and wrong for the bar, where every other control
 *  reads from --st-fg-rgb and follows the cover theme. Rather than fork the
 *  styling, this is the one boost control and that one is deleted.
 *
 *  ── WHY THE SLIDER IS LOGARITHMIC ────────────────────────────────────────
 *  Carried over from that component because it was right: the slider's raw
 *  value is log2(boost), so 0→4 spans 1×→16× and every integer step is one
 *  doubling. Linear would bury 1–4×, where nearly all real use lives, in the
 *  first fifth of the track. Equal space per doubling is also roughly equal
 *  space per unit of perceived loudness.
 *
 *  ── WHAT'S NEW ───────────────────────────────────────────────────────────
 *  A gain-reduction readout. Boost past a few × is not free — the compressor
 *  and limiter in App.jsx start taking back what the gain stage adds, and
 *  without a meter the only symptom is that loud passages stop getting louder
 *  and start sounding flat. This shows that happening, in dB, live.
 * ========================================================================= */

const MIN_BOOST = 1;
const MAX_BOOST = 16;
const LOG_MAX = Math.log2(MAX_BOOST);       // 4 — the slider's full travel
const TICKS = [1, 2, 4, 8, 16];             // evenly spaced under log2, by construction

const clampBoost = (n) => (
  Math.max(MIN_BOOST, Math.min(MAX_BOOST, Number.isFinite(n) ? n : MIN_BOOST))
);

/** "1×", "2.4×", "16×" — a decimal only where it carries information. */
function fmtX(boost) {
  if (boost >= 9.95) return `${Math.round(boost)}×`;
  const r = Math.round(boost * 10) / 10;
  return Number.isInteger(r) ? `${r}×` : `${r.toFixed(1)}×`;
}

/** The same number in the unit the audio graph actually works in. */
function fmtDb(boost) {
  const db = 20 * Math.log10(boost);
  if (db < 0.05) return '0 dB';
  return `+${db.toFixed(1)} dB`;
}

function BoostControl({ boost = 1, onSetBoost, accent = '255,255,255', getGainReduction = null }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const popRef = useRef(null);

  const value = clampBoost(boost);
  const active = value > 1.005;
  const acc = accent;
  const pct = (Math.log2(value) / LOG_MAX) * 100;

  const set = useCallback((n) => onSetBoost?.(clampBoost(n)), [onSetBoost]);

  /* Outside click / Esc, matching the other popovers in the bar. */
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /* Live gain reduction, polled only while the popover is open — the value
     comes off DynamicsCompressorNode.reduction, which is a live audio-thread
     read, so there is no reason to sample it when nobody can see it.

     Sum of both stages: the compressor does the musical work and the limiter
     catches what it misses, and what the listener wants to know is how much is
     being taken off in total, not which node took it. */
  const [reduction, setReduction] = useState(0);
  useEffect(() => {
    if (!open || !getGainReduction) return undefined;
    let raf = 0;
    let dead = false;
    const tick = () => {
      if (dead) return;
      const db = getGainReduction();
      /* Smoothed towards the reading rather than set to it. The raw value is
         per-audio-block and jitters several dB at 60fps, which reads as noise
         rather than as level. */
      setReduction((prev) => prev + ((Number.isFinite(db) ? db : 0) - prev) * 0.25);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { dead = true; cancelAnimationFrame(raf); };
  }, [open, getGainReduction]);

  /* Wheel over the button, the way the volume slider beside it behaves. One
     notch is 0.1 of a doubling — fine enough to trim, coarse enough to cross
     the range without spinning. */
  const onWheel = useCallback((e) => {
    e.preventDefault();
    const step = e.deltaY < 0 ? 0.1 : -0.1;
    set(2 ** Math.max(0, Math.min(LOG_MAX, Math.log2(clampBoost(boost)) + step)));
  }, [boost, set]);

  const meterOn = !!getGainReduction && active;
  const meterPct = Math.max(0, Math.min(1, -reduction / 15)) * 100;

  return (
    <div ref={wrapRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        className="sth-npbtn"
        onClick={() => setOpen((v) => !v)}
        /* Alt-click is the escape hatch from a bad setting without opening
           anything — the same gesture that resets most sliders. */
        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); set(1); } }}
        onWheel={onWheel}
        title={active ? `Volume boost: ${fmtX(value)} (${fmtDb(value)})` : 'Volume boost'}
        aria-label="Volume boost"
        aria-haspopup="dialog"
        aria-expanded={open}
        style={(active || open)
          ? { color: `rgb(${acc})`, background: `rgba(${acc},0.16)` }
          : undefined}
      >
        {active ? (
          <span style={{
            fontSize: value >= 9.95 ? 11 : 10.5,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            fontVariantNumeric: 'tabular-nums',
          }}>
            {fmtX(value)}
          </span>
        ) : (
          /* Ascending bars under a rising chevron. Deliberately not a speaker:
             the speaker glyph belongs to volume, and this is not volume — the
             slider two controls to the left is already that. */
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 20v-5" />
            <path d="M9 20v-9" />
            <path d="M14 20v-6" />
            <path d="M19 20v-12" />
            <path d="M16.5 6.5 19 4l2.5 2.5" />
          </svg>
        )}
      </button>

      {open ? (
        <div
          ref={popRef}
          role="dialog"
          aria-label="Volume boost"
          className="sth-boostpop"
          style={{
            position: 'absolute',
            right: 0,
            bottom: 'calc(100% + 10px)',
            width: 244,
            padding: '13px 14px 12px',
            borderRadius: 14,
            /* Same surface constants the cover colour tray uses, so the two
               things that pop out of this bar are the same object. */
            background: 'rgba(10, 10, 12, 0.97)',
            border: '1px solid rgba(var(--st-fg-rgb), 0.14)',
            backdropFilter: 'blur(24px) saturate(1.4)',
            WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
            boxShadow: '0 18px 50px rgba(0,0,0,0.55), inset 0 1px 0 rgba(var(--st-fg-rgb), 0.06)',
            zIndex: 60,
            animation: 'sthBoostIn 150ms cubic-bezier(0.2, 0.8, 0.3, 1)',
          }}
        >
          <style>{`
            @keyframes sthBoostIn {
              from { opacity: 0; transform: translateY(5px) scale(0.985); }
              to   { opacity: 1; transform: none; }
            }
            .sth-boosttick { border: none; background: transparent; padding: 3px 5px; border-radius: 6px;
              font-size: 9.5px; font-weight: 600; font-variant-numeric: tabular-nums;
              color: rgba(var(--st-sub-rgb), 0.45); cursor: pointer; transition: color 0.12s ease, background 0.12s ease; }
            .sth-boosttick:hover { color: #fff; background: rgba(var(--st-fg-rgb), 0.07); }
            .sth-boostreset { padding: 5px 11px; border-radius: 999px;
              border: 1px solid rgba(var(--st-fg-rgb), 0.12); background: rgba(var(--st-fg-rgb), 0.05);
              font-size: 10.5px; font-weight: 600; white-space: nowrap;
              transition: background 0.12s ease, color 0.12s ease; }
            .sth-boostreset:enabled { color: rgba(var(--st-fg-rgb), 0.85); cursor: pointer; }
            .sth-boostreset:enabled:hover { background: rgba(var(--st-fg-rgb), 0.11); color: #fff; }
            .sth-boostreset:disabled { color: rgba(var(--st-sub-rgb), 0.3); cursor: default; }
          `}</style>

          <div style={{
            display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 11,
          }}>
            <div style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
              color: 'rgba(var(--st-sub-rgb), 0.5)',
            }}>
              Volume boost
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{
                fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                color: active ? `rgb(${acc})` : 'rgba(var(--st-fg-rgb), 0.72)',
              }}>
                {fmtX(value)}
              </span>
              <span style={{
                fontSize: 10, fontVariantNumeric: 'tabular-nums',
                color: 'rgba(var(--st-sub-rgb), 0.4)',
              }}>
                {fmtDb(value)}
              </span>
            </div>
          </div>

          {/* .sth-vol is the bar's own volume slider class — same 3px track,
              same 11px white thumb. A boost slider that looked different from
              the volume slider it sits beside would imply it does something of
              a different kind, and it doesn't. */}
          <input
            type="range"
            min={0}
            max={LOG_MAX}
            step={0.05}
            value={Math.log2(value)}
            onChange={(e) => set(2 ** parseFloat(e.target.value))}
            className="sth-vol"
            aria-label="Volume boost multiplier"
            aria-valuetext={`${fmtX(value)}, ${fmtDb(value)}`}
            style={{
              width: '100%',
              background: `linear-gradient(to right, rgb(${acc}) 0%, rgb(${acc}) ${pct}%, rgba(var(--st-fg-rgb), 0.16) ${pct}%, rgba(var(--st-fg-rgb), 0.16) 100%)`,
            }}
          />

          {/* Quick jumps. Under a log2 slider these land at even intervals, so
              each pill genuinely sits under its own point on the track. */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', marginTop: 5, marginLeft: -5, marginRight: -5,
          }}>
            {TICKS.map((tick) => {
              const on = Math.abs(value - tick) < 0.06 * tick;   // proportional, like the scale
              return (
                <button
                  key={tick}
                  type="button"
                  className="sth-boosttick"
                  onClick={() => set(tick)}
                  style={on ? { color: `rgb(${acc})`, fontWeight: 700 } : undefined}
                >
                  {tick}×
                </button>
              );
            })}
          </div>

          {meterOn ? (
            <div style={{ marginTop: 10 }}>
              <div style={{
                display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 5,
                fontSize: 9.5, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase',
                color: 'rgba(var(--st-sub-rgb), 0.45)',
              }}>
                <span>Limiting</span>
                <span style={{ letterSpacing: 0, textTransform: 'none', fontVariantNumeric: 'tabular-nums' }}>
                  {reduction < -0.1 ? `${reduction.toFixed(1)} dB` : 'none'}
                </span>
              </div>
              <div style={{
                height: 3, borderRadius: 2, background: 'rgba(var(--st-fg-rgb), 0.1)', overflow: 'hidden',
              }}>
                {/* Amber rather than accent: this is the one readout in the
                    popover that is telling you something is being taken away,
                    and the accent means "on" everywhere else in the bar. */}
                <div style={{
                  width: `${meterPct}%`, height: '100%', borderRadius: 2,
                  background: meterPct > 66 ? 'rgb(240, 170, 90)' : `rgb(${acc})`,
                  transition: 'background 0.2s ease',
                }} />
              </div>
            </div>
          ) : null}

          {value > 8 ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 10px', marginTop: 10, borderRadius: 9,
              background: 'rgba(240, 170, 90, 0.1)',
              border: '1px solid rgba(240, 170, 90, 0.26)',
              fontSize: 10.5, lineHeight: 1.35, color: 'rgba(250, 205, 150, 0.95)',
            }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden>
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span>Extreme boost — protect your ears and speakers.</span>
            </div>
          ) : null}

          <div style={{
            display: 'flex', gap: 10, alignItems: 'center',
            marginTop: 11, paddingTop: 9,
            borderTop: '1px solid rgba(var(--st-fg-rgb), 0.08)',
          }}>
            <div style={{
              flex: 1, fontSize: 10, lineHeight: 1.35, color: 'rgba(var(--st-sub-rgb), 0.42)',
            }}>
              Amplifies past 100%. A soft limiter holds back clipping.
            </div>
            <button
              type="button"
              className="sth-boostreset"
              onClick={() => set(1)}
              disabled={!active}
            >
              Reset
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default BoostControl;
export { BoostControl, clampBoost, MIN_BOOST, MAX_BOOST };
