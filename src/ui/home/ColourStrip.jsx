import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { barTone } from '../../lib/coverTheme.js';
import { oklabToLch, oklchToRgb, rgbToOklab } from '../../lib/coverColour.js';
import { hexToRgb, rgbToHex } from './common.jsx';
import { StudioColorPicker } from './Settings.jsx';

/* The record's colors, pulled out of the top edge of the Now Playing bar.
 *
 * Hover the bar and a tab in the bar's own color slides up from behind its
 * top edge with six of the cover's colors on it, then a seventh button for
 * a color of your own (the full color wheel). One click recolors the bar.
 * Auto puts it back. The bar's menu item ("Change Colors") opens it
 * too, and then it stays open until you click away.
 *
 * The tab sits above the bar and covers the bar's top border where they meet,
 * so it reads as part of the bar being pulled out. It slides inside a clip
 * whose bottom edge is the bar's top edge: it comes out of the bar and tucks
 * back into it. */

const ROW = 6;        // cover colors, always this many
const CHIP = 18;      // chip diameter
const CHIP_GAP = 7;
const TAB_H = 36;
const TOP_R = 12;
const SINK = 10;      // extra tab below the visible edge, kept hidden by the clip
const OPEN_DELAY = 200;  // hover this long before it opens, so passing over the bar on the way to play doesn't
const CLOSE_DELAY = 320;

const CSS = `
.sth-cs-clip { position: fixed; z-index: 31; overflow: hidden; pointer-events: none; padding: 0 2px; }
/* Closing is the opening played backwards, a little quicker: Auto goes,
   then the colors right to left, then the label, and the tab drops back into
   the bar last. Each curve is the time-reverse of the one it came in on, so
   the bounce they arrive with becomes a small swell before they go, and the
   tab's ease-out rise becomes an ease-in fall. The tab starts down while the
   last colors are still leaving, so there's no dead beat in between. */
.sth-cs { position: absolute; left: 2px; bottom: ${-SINK}px; height: ${TAB_H + SINK}px; padding: 0 6px ${SINK}px 11px;
  display: flex; align-items: center; gap: 8px; box-sizing: border-box; isolation: isolate;
  background: var(--cs-bg); border-radius: ${TOP_R}px ${TOP_R}px 0 0;
  box-shadow: inset 0 var(--cs-bw) 0 var(--cs-line), inset var(--cs-bw) 0 0 var(--cs-line), inset calc(var(--cs-bw) * -1) 0 0 var(--cs-line);
  transform: translateY(100%); visibility: hidden; pointer-events: none;
  transition: transform .3s cubic-bezier(.7,0,.84,0) .17s, visibility 0s linear .47s, background-color var(--cs-bgt, .35s ease); }
.sth-cs.is-open { transform: none; visibility: visible; pointer-events: auto;
  transition: transform .46s cubic-bezier(.16,1,.3,1), visibility 0s, background-color var(--cs-bgt, .35s ease); }

.sth-cs-lbl, .sth-cs-chip, .sth-cs-any, .sth-cs-pill {
  opacity: 0; transform: translateY(10px) scale(.2);
  transition: transform .24s cubic-bezier(.5,0,.66,-.8) calc(var(--c, 0) * 25ms), opacity .12s ease calc(var(--c, 0) * 25ms + 110ms); }
.sth-cs-lbl { --c: 8; font-size: 9.5px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; color: rgba(255,255,255,0.5); transform: translateX(-6px);
  transition: transform .2s cubic-bezier(.78,0,.64,0) calc(var(--c) * 25ms), opacity .14s ease calc(var(--c) * 25ms + 60ms); }
.sth-cs.is-open .sth-cs-lbl { opacity: 1; transform: none; transition: opacity .3s ease .08s, transform .45s cubic-bezier(.22,1,.36,1) .08s; }
.sth-cs-chips { display: flex; gap: ${CHIP_GAP}px; }

.sth-cs-chip { position: relative; width: ${CHIP}px; height: ${CHIP}px; padding: 0; border: none; border-radius: 50%; cursor: pointer; flex-shrink: 0;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.22); }
.sth-cs.is-open .sth-cs-chip, .sth-cs.is-open .sth-cs-any { opacity: 1; transform: none;
  transition: transform .52s cubic-bezier(.34,1.8,.5,1) calc(90ms + var(--i) * 40ms), opacity .2s ease calc(90ms + var(--i) * 40ms), box-shadow .2s ease; }
/* Once it's open the hover has to answer at once, not after the entrance delay. */
.sth-cs.is-settled .sth-cs-chip, .sth-cs.is-settled .sth-cs-any { transition: transform .32s cubic-bezier(.34,1.8,.5,1), opacity .2s ease, box-shadow .2s ease; }
.sth-cs.is-settled .sth-cs-chip:not([aria-pressed="true"]):hover { transform: translateY(-3px) scale(1.22); }
.sth-cs.is-settled .sth-cs-chip:not([aria-pressed="true"]):active { transform: translateY(-1px) scale(.92); transition-duration: .08s; }
/* The color in use: a bold white edge and a check, and it stays put on hover. */
.sth-cs-chip[aria-pressed="true"] { cursor: default; box-shadow: inset 0 0 0 2px #fff; }
.sth-cs-check { position: absolute; inset: 0; margin: auto; pointer-events: none; opacity: 0; transform: scale(.3) rotate(-20deg); transition: opacity .12s ease, transform .15s ease; }
[aria-pressed="true"] > .sth-cs-check, .sth-cs-any.is-on > .sth-cs-check { opacity: 1; transform: none; transition: opacity .2s ease .1s, transform .45s cubic-bezier(.34,1.8,.5,1) .1s; }
.sth-cs-chip.is-pop { animation: sthCsPop .5s cubic-bezier(.34,1.8,.5,1); }
@keyframes sthCsPop { 0% { transform: scale(.7); } 45% { transform: scale(1.3); } 100% { transform: none; } }
.sth-cs-chip:focus-visible, .sth-cs-pill:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }

/* Your own color: the color wheel, seventh after the cover's six. It shows
   the color once you've picked one. */
.sth-cs-any { position: relative; width: ${CHIP}px; height: ${CHIP}px; flex-shrink: 0; }
.sth-cs.is-settled .sth-cs-any:not(.is-on):hover { transform: rotate(90deg) scale(1.15); transition: transform .45s cubic-bezier(.34,1.6,.5,1); }

.sth-cs-pill { height: 22px; padding: 0 9px; border: none; border-radius: 7px; font: inherit; font-size: 11px; font-weight: 800; cursor: pointer; margin-left: 2px;
  color: rgba(255,255,255,0.78); background: rgba(255,255,255,0.1); }
.sth-cs-pill:hover { background: rgba(255,255,255,0.18); color: #fff; }
.sth-cs-pill.is-on { background: #fff; color: #0a0a0b; }
.sth-cs.is-open .sth-cs-pill { opacity: 1; transform: none;
  transition: opacity .2s ease calc(120ms + var(--n) * 40ms), transform .45s cubic-bezier(.34,1.6,.5,1) calc(120ms + var(--n) * 40ms), background-color .15s ease, color .15s ease; }
.sth-cs.is-settled .sth-cs-pill { transition: opacity .2s ease, transform .3s ease, background-color .15s ease, color .15s ease; }

/* The new color spreading from the chip that was clicked, like paint: a
   slightly lighter wet edge leads, the color fills in behind it, then the
   layer fades once the surface underneath has become that color. One circle,
   the same size at every moment, is drawn on the tab and on the bar, so it
   reads as a single splash crossing from one to the other. Each layer draws
   its surface's border too, so no edge keeps the old color while it spreads. */
@property --sp { syntax: '<length>'; inherits: false; initial-value: 0px; }
.sth-npbar-splash, .sth-cs-splash { position: absolute; pointer-events: none;
  clip-path: circle(var(--sp) at var(--sx) var(--sy));
  background: radial-gradient(circle at var(--sx) var(--sy), var(--sc) calc(var(--sp) - 34px), color-mix(in srgb, var(--sc), #fff 16%) calc(var(--sp) - 3px), var(--sc) var(--sp));
  animation: sthCsSplash 1.15s linear forwards; }
.sth-cs-splash { inset: 0; z-index: -1; border-radius: inherit; box-shadow: inherit; }
@keyframes sthCsSplash {
  0% { --sp: 0px; opacity: 1; animation-timing-function: cubic-bezier(.55,.05,.3,1); }
  58% { --sp: var(--sr); opacity: 1; animation-timing-function: ease-out; }
  100% { --sp: var(--sr); opacity: 0; } }

@media (prefers-reduced-motion: reduce) {
  .sth-cs, .sth-cs.is-open { transition: opacity .15s ease, visibility 0s linear .15s; transform: none; opacity: 0; }
  .sth-cs.is-open { opacity: 1; transition: opacity .15s ease, visibility 0s; }
  .sth-cs-chip, .sth-cs-pill, .sth-cs-lbl, .sth-cs-any, .sth-cs.is-open .sth-cs-chip, .sth-cs.is-open .sth-cs-pill { transition: none; transform: none; opacity: 1; }
  .sth-cs-chip.is-pop { animation: none; }
  .sth-npbar-splash, .sth-cs-splash { display: none; }
}
`;

const parse = (rgb) => String(rgb || '').split(',').map((n) => parseInt(n.trim(), 10));
const labOf = (rgb) => { const v = parse(rgb); return rgbToOklab(v[0], v[1], v[2]); };
// Too light for a white check: only a color of your own can be.
const lightChip = (rgb) => labOf(rgb)[0] > 0.72;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const NEUTRAL = 0.02;   // OKLCh chroma under which a chip is a grey, not a colour
const DISTINCT = 0.07;  // OKLab distance under which two chips read as the same colour
const CLOSE = 0.035;    // the looser bar for filling in, still visibly different side by side

/**
 * The cover's colours for the strip, always ROW of them, each shown as the
 * bar it would make.
 *
 * A raw cover colour used as the bar can be too light for its white text,
 * so every chip goes through barTone first: the chip is exactly the bar you
 * get, and it's always readable.
 *
 * The count never changes from record to record. The best colours go first:
 * the most colourful and most present, nothing too close to one already
 * chosen, at most a grey or two. A cover with fewer colours than that is
 * filled out with closer ones, then with darker and softer shades of its own
 * colours, then with greys, so a black-and-white sleeve has a full row too.
 */
function chipsFrom(swatches, auto) {
  const autoLab = auto ? labOf(auto) : null;
  const taken = [];
  const fits = (c, gap) => (!autoLab || dist(c.lab, autoLab) >= gap) && taken.every((t) => dist(t.lab, c.lab) >= gap);
  const make = (rgb) => { const lab = labOf(rgb); const [, C, h] = oklabToLch(lab); return { rgb, lab, C, h, score: 0 }; };

  const cands = [];
  for (const sw of swatches) {
    const raw = sw.exact || sw.rgb;
    const v = parse(raw);
    if (v.length < 3 || v.some((n) => !Number.isFinite(n))) continue;
    const c = make(barTone(raw));
    c.score = (c.C + 0.02) * Math.sqrt(sw.share || 0.01);
    cands.push(c);
  }
  cands.sort((a, b) => b.score - a.score);

  const take = (list, gap, limit = ROW) => {
    for (const c of list) {
      if (taken.length >= limit) break;
      if (fits(c, gap)) taken.push(c);
    }
  };
  // Colours first, then a grey or two: the most tinted, so a slate beats black.
  take(cands.filter((c) => c.C >= NEUTRAL), DISTINCT);
  const greys = cands.filter((c) => c.C < NEUTRAL).sort((a, b) => b.C - a.C);
  take(greys, DISTINCT, Math.min(ROW, taken.length + (taken.length >= 4 ? 1 : 2)));
  // Then everything else the cover has, at the looser bar.
  take(cands, CLOSE);
  // Then shades of what's there: darker, and softer.
  for (let round = 0; round < 3 && taken.length < ROW; round += 1) {
    for (const base of taken.slice()) {
      if (taken.length >= ROW) break;
      const [L, C, h] = oklabToLch(base.lab);
      const shade = round === 1 ? oklchToRgb(Math.max(0.16, L * 0.8), C * 0.55, h) : oklchToRgb(Math.max(0.16, L * (round ? 0.68 : 0.82)), C, h);
      take([make(barTone(shade.join(', ')))], CLOSE);
    }
  }
  // Last, plain greys from dark to mid, for a cover with nothing else to give.
  for (let L = 0.2; taken.length < ROW && L <= 0.5; L += 0.06) take([make(oklchToRgb(L, 0, 0).join(', '))], 0.03);

  const deg = (c) => ((c.h * 180) / Math.PI + 360) % 360;
  return taken.sort((a, b) => (a.C < NEUTRAL) - (b.C < NEUTRAL) || deg(a) - deg(b)).map((c) => c.rgb);
}

/** Where an element sits inside `root`, from layout offsets, so it's right
 *  even while the chips are mid-animation. */
function offsetIn(el, root) {
  let x = 0;
  let y = 0;
  while (el && el !== root) { x += el.offsetLeft; y += el.offsetTop; el = el.offsetParent; }
  return { x, y };
}

const WHEEL = 'conic-gradient(from 90deg, #ff5b5b, #ffd34d, #5be08a, #4dc8ff, #8a6bff, #ff5bd1, #ff5b5b)';

const Check = ({ light }) => (
  <svg className="sth-cs-check" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={light ? '#111' : '#fff'}
    strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

/**
 * hover: { subscribe(fn) } where fn(on, barEl) runs when the pointer enters or
 *   leaves the bar. A subscription rather than a prop so hovering the bar
 *   doesn't re-render the whole home screen.
 * surface: CSS color for the tab, the bar's own.
 * auto: the bar color Auto gives, so it isn't offered twice.
 * openRequest: bumped to open it and keep it open (the bar's menu).
 * hoverOpens: whether hovering the song's side of the bar opens it (Settings). The menu always does.
 * paints: whether a pick splashes. Off when the bar has a fixed color, which a pick doesn't change.
 * onPick(rgb | null, splash | null): splash is where the paint starts on the
 *   bar, or null for a pick that shouldn't splash (dragging the color wheel).
 */
export function ColourStrip({ hover, swatches = [], current = null, auto = null, surface, enabled = true, openRequest = 0, hoverOpens = true, paints = true, onPick }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [settled, setSettled] = useState(false);
  const [pos, setPos] = useState(null);
  const [pop, setPop] = useState(null);
  const [paint, setPaint] = useState(null);
  const barEl = useRef(null);
  const tabRef = useRef(null);
  const over = useRef({ bar: false, tab: false, picker: false });
  const pinnedRef = useRef(false);
  pinnedRef.current = pinned;
  const timer = useRef(null);

  const chips = useMemo(() => chipsFrom(swatches, auto), [swatches, auto]);
  const usable = enabled && chips.length > 0;
  // A color that isn't one of the six is your own, and shows in the seventh button.
  const own = current && !chips.includes(current) ? current : null;

  const measure = useCallback(() => {
    const el = barEl.current || document.querySelector('.sth-npbar');
    if (!el) return false;
    barEl.current = el;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const bw = parseFloat(cs.borderTopWidth) || 0;
    // Clear of the bar's rounded corner, so the tab's sides meet the straight part of its edge.
    const inset = Math.max(16, (parseFloat(cs.borderTopLeftRadius) || 0) + 4);
    const room = TAB_H + 8; // the tab, and headroom for a lifted chip
    setPos({
      left: r.left + inset - 2, top: r.top + bw - room, height: room,
      bw, line: bw ? cs.borderTopColor : 'transparent', barLeft: r.left, barTop: r.top, barW: r.width, barH: r.height,
    });
    return true;
  }, []);

  const close = useCallback(() => {
    clearTimeout(timer.current);
    over.current = { bar: false, tab: false, picker: false };
    setPinned(false);
    setOpen(false);
  }, []);

  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    const o = over.current;
    const want = o.bar || o.tab || o.picker || pinnedRef.current;
    timer.current = setTimeout(() => {
      if (want) measure();
      setOpen(want);
    }, want ? OPEN_DELAY : CLOSE_DELAY);
  }, [measure]);

  const hoverOpensRef = useRef(hoverOpens);
  hoverOpensRef.current = hoverOpens;
  useEffect(() => hover?.subscribe((on, el) => {
    if (el) barEl.current = el;
    if (on && !hoverOpensRef.current) return;
    over.current.bar = on;
    /* Placed (closed) the moment the pointer arrives, so it's already on the
       page when it opens and the pull-out plays instead of it just appearing. */
    if (on) measure();
    schedule();
  }), [hover, schedule, measure]);

  useEffect(() => () => clearTimeout(timer.current), []);

  // The bar's menu: open it, and keep it open until a click elsewhere.
  // Only a new request opens it. The strip remounts on leaving fullscreen
  // with the old count still set, and that must not reopen it.
  const seenRequest = useRef(openRequest);
  useEffect(() => {
    if (openRequest === seenRequest.current) return undefined;
    seenRequest.current = openRequest;
    if (!openRequest || !measure()) return undefined;
    setPinned(true);
    // A frame later, so a strip placed just now still plays its pull-out.
    const t = setTimeout(() => setOpen(true), 30);
    return () => clearTimeout(t);
  }, [openRequest, measure]);

  useEffect(() => { if (!open) setPinned(false); }, [open]);

  // Hover answers instantly only once the entrance has played out.
  useEffect(() => {
    if (!open) { setSettled(false); return undefined; }
    const t = setTimeout(() => setSettled(true), 420 + (ROW + 1) * 40);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const inside = (t) => tabRef.current?.contains(t) || barEl.current?.contains(t) || !!t?.closest?.('[data-colour-picker]');
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('[data-colour-picker]')) close(); };
    /* Where the pointer is, from the page itself. React's enter and leave
       treat the color wheel (a portal) as part of the tab, and when the
       wheel closes under the pointer no leave ever comes, so the tab stayed
       "hovered" for good. Being over the wheel still counts as being here. */
    const onOver = (e) => {
      const t = e.target;
      const tab = !!tabRef.current?.contains(t);
      const picker = !!t?.closest?.('[data-colour-picker]');
      if (tab !== over.current.tab || picker !== over.current.picker) {
        over.current.tab = tab;
        over.current.picker = picker;
        schedule();
      }
    };
    const onDown = (e) => { if (pinnedRef.current && !inside(e.target)) close(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerover', onOver);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerover', onOver);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, measure, schedule, close]);

  useLayoutEffect(() => { if (!usable) setOpen(false); }, [usable]);
  useEffect(() => {
    if (!paint) return undefined;
    const t = setTimeout(() => setPaint(null), 1250);
    return () => clearTimeout(t);
  }, [paint]);

  if (!pos) return <style>{CSS}</style>; // the styles go in first: the bar's splash uses them too

  const shown = open && usable;

  const pick = (rgb, e) => {
    setPop(rgb ? `${rgb}|${Date.now()}` : null);
    if (!paints) { onPick?.(rgb, null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    const x = r.left + r.width / 2 - pos.barLeft;
    const y = r.top + r.height / 2 - pos.barTop;
    // One radius for both layers: far enough from the chip to cover the whole bar.
    const sr = Math.ceil(Math.max(Math.hypot(x, pos.barH - y), Math.hypot(pos.barW - x, pos.barH - y)) + 2);
    const local = offsetIn(e.currentTarget, tabRef.current);
    setPaint({ key: Date.now(), rgb: rgb || auto, x: local.x + e.currentTarget.offsetWidth / 2, y: local.y + e.currentTarget.offsetHeight / 2, r: sr });
    onPick?.(rgb, { x, y, r: sr, bw: pos.bw, line: pos.line });
  };

  return (
    <>
      <style>{CSS}</style>
      <div className="sth-cs-clip" style={{ left: pos.left, top: pos.top, height: pos.height, width: 360 }}>
        <div
          ref={tabRef}
          className={`sth-cs${shown ? ' is-open' : ''}${shown && settled ? ' is-settled' : ''}`}
          role="group"
          aria-label="Change Colors"
          aria-hidden={!shown}
          style={{
            '--cs-bg': surface, '--cs-line': pos.line, '--cs-bw': `${pos.bw}px`, '--n': ROW + 1,
            // Under a splash the tab keeps its old color until the paint has covered it.
            ...(paint ? { '--cs-bgt': '.05s linear .62s' } : null),
          }}
        >
          {paint ? (
            <span key={paint.key} aria-hidden className="sth-cs-splash"
              style={{ '--sc': `rgb(${paint.rgb})`, '--sx': `${paint.x}px`, '--sy': `${paint.y}px`, '--sr': `${paint.r}px` }} />
          ) : null}

          <span className="sth-cs-lbl">Color</span>
          <div className="sth-cs-chips">
            {chips.map((rgb, i) => (
              <button key={rgb} type="button" tabIndex={shown ? 0 : -1}
                className={`sth-cs-chip${pop && pop.startsWith(`${rgb}|`) ? ' is-pop' : ''}`}
                style={{ '--i': i, '--c': ROW + 1 - i, background: `rgb(${rgb})` }}
                aria-label={`Use this color${current === rgb ? ', in use' : ''}`}
                aria-pressed={current === rgb}
                onAnimationEnd={() => setPop(null)}
                onClick={(e) => { if (current !== rgb) pick(rgb, e); }}>
                <Check light={lightChip(rgb)} />
              </button>
            ))}
            <span className={`sth-cs-any${own ? ' is-on' : ''}`} style={{ '--i': ROW, '--c': 1 }}>
              <StudioColorPicker title="Your own color" size={CHIP}
                buttonStyle={{
                  width: CHIP, height: CHIP, borderRadius: '50%',
                  background: own ? `rgb(${own})` : WHEEL,
                  boxShadow: own ? 'inset 0 0 0 2px #fff' : 'inset 0 0 0 1px rgba(255,255,255,0.3)',
                }}
                value={rgbToHex(current || auto || '0, 0, 0')}
                onChange={(hexv) => { const v = hexToRgb(hexv); if (v) onPick?.(v, null); }} />
              <Check light={!!own && lightChip(own)} />
            </span>
          </div>
          <button type="button" tabIndex={shown ? 0 : -1} className={`sth-cs-pill${current ? '' : ' is-on'}`}
            title="Let Studio pick from the cover" aria-pressed={!current}
            onClick={(e) => { if (current) pick(null, e); }}>Auto</button>
        </div>
      </div>
    </>
  );
}

/** A tiny pub/sub for the bar's hover, made once per mount of the home screen. */
export function makeHoverSource() {
  const subs = new Set();
  return {
    emit: (on, el) => { subs.forEach((fn) => fn(on, el)); },
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
  };
}
