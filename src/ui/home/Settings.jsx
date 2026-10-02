import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PICKER_PRESETS, SIDEBAR_W } from './constants.js';
import { hexToRgb, rgbToHex } from './common.jsx';

/* Category titles for the settings body heading. Kept beside the rail's own
   labels so the two can't drift — the rail says "Colour", the heading says
   "Colour", and neither is a hardcoded string in the middle of the JSX. */
/**
 * SetHowTo — the settings-surface twin of onboarding's HowTo.
 *
 * Separate component rather than a shared one because the two live on
 * different surfaces: onboarding is fixed white-on-black, settings follows
 * the cover-derived theme variables.
 */
export function SetHowTo({ label, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 9 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, padding: 0,
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'rgba(var(--st-sub-rgb), 0.72)', fontSize: 11.5, fontWeight: 700,
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.18s ease' }}>
          <path d="M9 6l6 6-6 6" />
        </svg>
        {label}
      </button>
      <div style={{
        display: 'grid', gridTemplateRows: open ? '1fr' : '0fr',
        opacity: open ? 1 : 0,
        transition: 'grid-template-rows 0.26s cubic-bezier(0.22,1,0.36,1), opacity 0.18s ease',
      }}>
        <div style={{ overflow: 'hidden' }}>
          <div style={{ paddingTop: 9, fontSize: 11.5, color: 'rgba(var(--st-sub-rgb), 0.62)' }}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A value that has to be typed or copied exactly. */
export function SetLit({ children }) {
  return (
    <span style={{
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 11, color: 'var(--st-text)',
      background: 'rgba(var(--st-fg-rgb), 0.09)', borderRadius: 5, padding: '1px 5px',
    }}>{children}</span>
  );
}

function hexToHsv(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const n = m ? parseInt(m[1], 16) : 0;
  const r = ((n >> 16) & 255) / 255; const g = ((n >> 8) & 255) / 255; const b = (n & 255) / 255;
  const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: mx ? d / mx : 0, v: mx };
}

function hsvToHex({ h, s, v }) {
  const c = v * s; const x = c * (1 - Math.abs(((h / 60) % 2) - 1)); const m = v - c;
  let rgb;
  if (h < 60) rgb = [c, x, 0]; else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x]; else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c]; else rgb = [c, 0, x];
  return `#${rgb.map((u) => Math.round((u + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A swatch that opens Studio's own colour picker.
 *
 * @param value  current colour as #rrggbb
 * @param onChange called with #rrggbb as the user drags — live, so the app
 *        recolours under the picker and you judge the colour in place rather
 *        than against a dialog's white background.
 */
export function StudioColorPicker({ value, onChange, onReset, title, size = 24 }) {
  const [open, setOpen] = useState(false);
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const [hexText, setHexText] = useState(value);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  // Follow the value while closed; while open the drag state is the truth.
  useEffect(() => { if (!open) { setHsv(hexToHsv(value)); setHexText(value); } }, [value, open]);

  useEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const W = 232; const H = 286;
      // Flip above / pull inside the viewport rather than opening off-screen.
      const left = Math.min(Math.max(8, r.left + r.width / 2 - W / 2), window.innerWidth - W - 8);
      const below = r.bottom + 8;
      const top = below + H > window.innerHeight - 8 ? Math.max(8, r.top - H - 8) : below;
      setPos({ top, left });
    };
    place();
    const onDown = (e) => {
      if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  const push = (next) => { setHsv(next); const hex = hsvToHex(next); setHexText(hex); onChange(hex); };

  /* One drag handler for both the field and the rail: press, move, release,
     with the pointer captured on the window so a fast drag off the edge keeps
     tracking instead of dropping the colour where the cursor left. */
  const drag = (e, compute) => {
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    const apply = (ev) => push(compute(ev, box));
    apply(e);
    const move = (ev) => apply(ev);
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const clamp01 = (n) => Math.min(1, Math.max(0, n));
  const hex = /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : '#000000';

  return (
    <>
      <button ref={btnRef} type="button" title={title} aria-label={title} onClick={() => setOpen((o) => !o)}
        style={{
          width: size, height: size, borderRadius: 7, padding: 0, cursor: 'pointer', display: 'block',
          border: 'none', background: hex,
          boxShadow: `inset 0 0 0 1px rgba(var(--st-fg-rgb), ${open ? 0.5 : 0.22})`,
        }} />

      {/* Portalled to <body>.
          `position: fixed` is only fixed relative to the nearest ancestor that
          has a transform, filter or running animation — and the settings
          scroller has one. That made a stacking context the popover couldn't
          escape, so it sat behind the docked Queue/Lyrics panel no matter how
          high its z-index went. Out here it has no ancestor to be trapped by. */}
      {open ? createPortal((
        <div ref={popRef} role="dialog" aria-label={title}
          style={{
            position: 'fixed', top: pos.top, left: pos.left, width: 232, zIndex: 200,
            borderRadius: 14, padding: 12,
            /* Black, like the rest of Studio's surfaces. The near-black grey it
               had was a hair lighter than the panels around it, which is the
               kind of difference that reads as a mistake rather than a choice. */
            background: '#000',
            boxShadow: 'inset 0 0 0 1px rgba(var(--st-fg-rgb), 0.14), 0 24px 60px rgba(0,0,0,0.7)',
            transformOrigin: 'top center',
            animation: 'sthPopIn 0.15s cubic-bezier(0.22,1,0.3,1) both',
          }}>
          {/* Saturation and value */}
          <div
            onMouseDown={(e) => drag(e, (ev, box) => ({
              ...hsv,
              s: clamp01((ev.clientX - box.left) / box.width),
              v: 1 - clamp01((ev.clientY - box.top) / box.height),
            }))}
            style={{
              position: 'relative', height: 122, borderRadius: 9, cursor: 'crosshair',
              background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hsvToHex({ h: hsv.h, s: 1, v: 1 })})`,
              boxShadow: 'inset 0 0 0 1px rgba(var(--st-fg-rgb), 0.1)',
            }}>
            <span style={{
              position: 'absolute', left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`,
              width: 13, height: 13, marginLeft: -6.5, marginTop: -6.5, borderRadius: '50%',
              border: '2px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,0.5), 0 2px 6px rgba(0,0,0,0.5)',
              pointerEvents: 'none',
            }} />
          </div>

          {/* Hue */}
          <div
            onMouseDown={(e) => drag(e, (ev, box) => ({ ...hsv, h: clamp01((ev.clientX - box.left) / box.width) * 360 }))}
            style={{
              position: 'relative', height: 12, borderRadius: 999, marginTop: 11, cursor: 'ew-resize',
              background: 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)',
              boxShadow: 'inset 0 0 0 1px rgba(var(--st-fg-rgb), 0.1)',
            }}>
            <span style={{
              position: 'absolute', left: `${(hsv.h / 360) * 100}%`, top: '50%',
              width: 16, height: 16, marginLeft: -8, marginTop: -8, borderRadius: '50%',
              background: hsvToHex({ h: hsv.h, s: 1, v: 1 }),
              border: '2px solid #fff', boxShadow: '0 1px 5px rgba(0,0,0,0.55)', pointerEvents: 'none',
            }} />
          </div>

          {/* Hex, typed */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 11 }}>
            <span style={{ width: 26, height: 26, borderRadius: 7, flexShrink: 0, background: hex,
              boxShadow: 'inset 0 0 0 1px rgba(var(--st-fg-rgb), 0.2)' }} />
            <input
              value={hexText}
              onChange={(e) => {
                const v = e.target.value;
                setHexText(v);
                const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
                if (m) { const h = `#${m[1]}`; setHsv(hexToHsv(h)); onChange(h); }
              }}
              onBlur={() => setHexText(hex)}
              spellCheck={false}
              style={{
                flex: 1, minWidth: 0, height: 26, borderRadius: 7, border: 'none', outline: 'none',
                background: 'rgba(0,0,0,0.35)', boxShadow: 'inset 0 0 0 1px rgba(var(--st-fg-rgb), 0.12)',
                color: 'var(--st-text)', font: 'inherit', fontSize: 12, fontWeight: 700,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', padding: '0 9px', textTransform: 'lowercase',
              }} />
            {onReset ? (
              <button type="button" onClick={() => { onReset(); setOpen(false); }} className="sth-set-link">Reset</button>
            ) : null}
          </div>

          {/* Studio's own palette, so the common choices are one click. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6, marginTop: 11 }}>
            {PICKER_PRESETS.map((c) => (
              <button key={c} type="button" title={c}
                onClick={() => { setHsv(hexToHsv(c)); setHexText(c); onChange(c); }}
                style={{
                  height: 22, borderRadius: 6, border: 'none', cursor: 'pointer', background: c,
                  boxShadow: `inset 0 0 0 1px rgba(var(--st-fg-rgb), ${c.toLowerCase() === hex.toLowerCase() ? 0.7 : 0.16})`,
                }} />
            ))}
          </div>
        </div>
      ), document.body) : null}
    </>
  );
}

/**
 * Pick the colour for the record that's playing.
 *
 * A card in the sidebar column, not a popover on the bar. The sidebar is
 * mostly empty below the playlists, the column is tall, and a vertical list
 * gives every reading its full name and hex without anything running off the
 * edge — which is what a wide row of tiles couldn't do at any width.
 */
/* Once per app session, not once per mount. The component remounts on every
   track change, so component state would re-announce on every song — which is
   nagging, not introducing. */
let hintAnnounced = false;

/**
 * Colour override for the playing record.
 *
 * TWO RULES ABOUT WHAT THIS OFFERS.
 *
 * Only colours from the artwork. It used to list the named readings too —
 * Auto, Fitted, Palette vibrant, Dark muted and the rest. Those are diagnostics
 * for comparing algorithms, not choices: "Palette muted" tells you nothing
 * about what you'd be looking at, and picking one saves a LITERAL colour, so a
 * reading chosen today freezes forever even after the algorithm improves. What
 * a person actually wants here is "use that red, the one in the sleeve".
 *
 * And the swatches are real pixels, not cluster means — see the exact field in
 * coverTheme's kmeans(). A mean can be a colour that appears nowhere in the
 * cover, which makes a picker that promises colours from the cover a liar.
 *
 * The handle is a chevron behind the left edge of the Now Playing bar, at a
 * lower z-index than the bar so it reads as tucked underneath. It's deliberately
 * quiet: Auto is right most of the time now, and this should look like a thing
 * you can reach for rather than a thing asking to be used.
 */
export function CoverColourTab({
  open, setOpen, swatches = [], current, onPick, onReset, accent,
  coverSrc = null, exportName = 'cover', headless = false,
}) {
  /* Above the hooks on purpose: it is a const, so a hook body reading it from
     further up the component hits the temporal dead zone at render time. */
  const HINT = 'Hey! Don’t like this color?';
  const tick = useRef(null);

  const [hover, setHover] = useState(false);

  /* Announce once per app SESSION, not per mount: the component remounts on
     every track change, so component state would re-announce every song.
     The flag is spent when the hint actually appears, not when this effect
     runs — an unmount inside the delay (a null blip in currentTrack while
     metadata resolves, or StrictMode's dev double-mount) would otherwise burn
     the announce without ever drawing it, and the remount would bail forever. */
  const [announce, setAnnounce] = useState(false);
  useEffect(() => {
    if (headless || hintAnnounced) return undefined;
    const on = setTimeout(() => {
      if (hintAnnounced) return;
      hintAnnounced = true;
      setAnnounce(true);
    }, 900);
    /* Visible for 10s: in at 900ms, out at 10900ms. */
    const off = setTimeout(() => setAnnounce(false), 10900);
    return () => { clearTimeout(on); clearTimeout(off); };
  }, []);

  /* Typed out on the first-run announce only. On every hover it would be a
     delay you sit through after you already know what it says. */
  const [typed, setTyped] = useState(HINT.length);
  useEffect(() => {
    if (!announce) { setTyped(HINT.length); return undefined; }
    setTyped(0);
    let n = 0;
    /* Starts after the swing lands — typing mid-swing is two motions at once. */
    const begin = setTimeout(() => {
      const id = setInterval(() => {
        n += 1;
        setTyped(n);
        if (n >= HINT.length) clearInterval(id);
      }, 34);
      tick.current = id;
    }, 380);
    return () => { clearTimeout(begin); if (tick.current) clearInterval(tick.current); };
  }, [announce]);

  /* Open by default. The panel exists because Auto is a guess, and someone
     opening it for the first time is usually asking why it got this wrong —
     answering that up front beats hiding it behind a button they have to
     think to press. The toggle stays so it can be collapsed. */
  const [info, setInfo] = useState(true);

  /* Hover wins: reaching for it mid-announce should not fight the timer. */
  const hintOn = (hover || announce) && !open;

  /* The exit animation is keyed off hintOn going false — but it starts false,
     so without this the box would fly across the screen once on mount. Only
     arms after it has actually been shown.
     MUST sit below hintOn: the [hintOn] dependency array is evaluated during
     render, so declaring this above it is a temporal dead zone hit. */
  const [everShown, setEverShown] = useState(false);
  useEffect(() => { if (hintOn) setEverShown(true); }, [hintOn]);
  const [saveNote, setSaveNote] = useState('');
  useEffect(() => { setSaveNote(''); }, [coverSrc]);

  /* Vertically centred on the 84px bar, which sits at bottom:12. */
  const TAB_H = 54;
  /* Kept short enough to stay on one line inside the column. */
  const barLeft = 'var(--np-bar-left, 238px)';

  /* Even margins between the window edge and the content area.
     The sidebar is SIDEBAR_W wide and content starts 12px past it, so the
     usable span is 0..SIDEBAR_W+12 and the panel is centred inside it. Anchored
     at left:12 the gaps came out 12 and 24 — visibly off-centre. */
  const COL_W = SIDEBAR_W - 24;
  const COL_LEFT = (SIDEBAR_W + 12 - COL_W) / 2;
  /* Both the hint and the panel occupy this one slot: the panel unfolds out of
     exactly where the prompt was, so the prompt reads as the thing that opened. */
  const SLOT_BOTTOM = 34;
  /* The chevron's midline. Bar is 84 tall at bottom:12, tab is centred on it,
     so both resolve to the same number — the hint hangs off this rather than a
     bottom edge, which keeps it centred on the tab at any text height. */
  const CHEV_MID = 12 + 84 / 2;
  /* How far the hint's centre has to travel to land on the chevron's visible
     sliver. --np-bar-left is SIDEBAR_W + 12, and the tab pokes 15px out of it
     with its right half hidden behind the bar, so the visible centre is 7.5px
     left of the bar edge. Derived, not measured, so it survives a sidebar
     resize. */
  const SUCK_X = (SIDEBAR_W + 12 - 15 / 2) - (COL_LEFT + COL_W / 2);
  /* One surface for the tab and the hint. As two literals they drifted; as one
     constant they cannot. */
  const SURFACE = 'rgba(10, 10, 12, 0.97)';
  const SURFACE_RING = 'rgba(var(--st-fg-rgb), 0.14)';

  /* Drop chips too close to one already shown. Clustering regularly returns
     two cells a few RGB units apart — string equality won't catch those, and
     they render as what looks like the same colour twice, which makes the grid
     read as padded. 28 is roughly where two chips stop being distinguishable
     side by side. */
  const kept = [];
  const chips = swatches.filter((sw) => {
    const v = String(sw.exact || sw.rgb || '').split(',').map((n) => parseInt(n.trim(), 10));
    if (v.length < 3 || v.some((n) => !Number.isFinite(n))) return false;
    if (kept.some((k) => Math.hypot(k[0] - v[0], k[1] - v[1], k[2] - v[2]) < 28)) return false;
    kept.push(v);
    return true;
  });

  return (
    <>
      {/* Brief, Now Playing bar: the "Hey! Don't like this color?" toast is
          removed, and the handle with it. The tray now opens from the bar's
          overflow menu ("Colour for this record"), so `headless` is how it's
          mounted. The old handle stays available behind the prop. */}
      {!headless ? (<>
      {/* ---- The hint ----
          Hangs off the bottom edge of the sidebar, in the horizontal band the
          Now Playing bar occupies, so it reads as part of that row rather than
          floating in the library.

          Hinged at TOP CENTRE and swung down like a sign on a bracket — the
          1.52 in the easing overshoots and settles, which is what sells it as
          an object with weight instead of a tooltip fading in. Out is slow with
          the bounce; back is quick and eased, because a bounce on the way in
          looks like it can't decide. */}
      {/* Outer node does nothing but centring, inner does nothing but the swing.
          On one node the centring translate has to be restated inside every
          animated transform, and it drops the moment one state forgets — which
          is why the box hung off the left edge and shifted with phrase length.
          Split, they cannot interfere: centred once, centred at any width. */}
      <div aria-hidden style={{
        position: 'fixed', left: COL_LEFT + COL_W / 2, bottom: CHEV_MID, zIndex: 28,
        /* Capped by geometry, not by the column: centred at the column's midpoint,
           the box can grow until its left edge nears the window edge, which is
           wider than COL_W and still clear of the content area at SIDEBAR_W+12.
           At COL_W the longer phrase clipped. */
        /* translateY(50%) against a bottom anchor puts the box's own centre on
           CHEV_MID whatever its height, so it stays aligned if the copy grows. */
        transform: 'translate(-50%, 50%)', width: 'fit-content',
        maxWidth: 2 * (COL_LEFT + COL_W / 2 - 8),
        pointerEvents: 'none',
      }}>
      <div style={{
        whiteSpace: 'nowrap', position: 'relative',
        padding: '9px 11px', borderRadius: 10,
        /* Centre, not the right edge. Pivoting at the right edge held that edge
           still and only walked the left one in — the box collapsed where it
           stood instead of going anywhere, which is why it read as a blink.
           From the centre it can both travel and shrink. */
        transformOrigin: 'center center',
        background: SURFACE,
        boxShadow: `inset 0 0 0 1px ${SURFACE_RING}, 0 10px 26px rgba(0,0,0,0.5)`,
        fontSize: 11.5, fontWeight: 650, lineHeight: 1.3,
        color: 'rgba(var(--st-text-rgb), 0.9)',
        opacity: hintOn ? 1 : 0,
        /* Resting hidden state is the keyframe's END state, deliberately. When
           the animation is dropped on re-show the element falls back to this,
           and if the two disagreed it would snap a frame before the entry ran.
           Matching them makes the handoff invisible — and it means the entry
           slides out of the tab, mirroring the exit. */
        '--suck-x': `${SUCK_X}px`,
        transform: hintOn
          ? 'translateX(0) scale(1)'
          : `translateX(${SUCK_X}px) scale(0.92)`,
        /* Entry is a transition; exit is the keyframe, because a transition
           cannot go left before it goes right. */
        transition: hintOn
          ? 'opacity 0.16s ease, transform 0.44s cubic-bezier(0.34, 1.52, 0.42, 1)'
          : 'none',
        animation: !hintOn && everShown ? 'sthHintSuck 0.52s forwards' : 'none',
      }}>
        {/* The full string holds the box width even when only part is shown.
            Without it a fit-content, centre-anchored box would grow and drift
            sideways on every character. */}
        <span style={{ position: 'relative', display: 'inline-block' }}>
          <span aria-hidden style={{ visibility: 'hidden' }}>{HINT}</span>
          <span style={{ position: 'absolute', left: 0, top: 0, whiteSpace: 'nowrap' }}>
            {HINT.slice(0, typed)}
          </span>
        </span>
      </div>
      </div>

      {/* ---- The handle ----
          z-index 29 against the bar's 30, so the bar paints over its right
          half and it reads as tucked behind rather than floating beside. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        /* No title attribute: the OS tooltip fired on top of the hint, saying
           the same thing twice in two different styles. aria-label still names
           the control for screen readers. */
        aria-label="Color for this record"
        aria-expanded={open}
        style={{
          position: 'fixed', left: `calc(${barLeft} - 15px)`, bottom: 12 + (84 - TAB_H) / 2,
          zIndex: 29, width: 30, height: TAB_H, padding: 0, border: 'none', cursor: 'pointer',
          borderRadius: '9px 0 0 9px', font: 'inherit',
          /* Same fill and ring as the hint, so the tab reads as the edge of the
             thing that swings out of it rather than as bar chrome. Only the
             glyph responds to state — moving the fill as well made it flash
             against the bar's colour wash. */
          background: SURFACE,
          boxShadow: `inset 0 0 0 1px ${SURFACE_RING}`,
          color: open || hover || announce ? 'rgba(var(--st-text-rgb), 0.9)' : 'rgba(var(--st-text-rgb), 0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'flex-start', paddingLeft: 3,
          transition: 'background 0.16s ease, color 0.16s ease, left 0.2s cubic-bezier(0.22,0.9,0.3,1)',
          /* Only while introducing itself, and it stops the moment you reach
             for it — something still asking for attention under the cursor is
             the fastest way to make a control feel broken. */
          animation: announce && !hover && !open ? 'sthChevNudge 2.6s ease-in-out infinite' : 'none',
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.26s cubic-bezier(0.22,0.9,0.3,1)' }}>
          <path d="M15 6l-6 6 6 6" />
        </svg>
      </button>

      </>) : null}

      {/* ---- The panel ----
          Opens out of the prompt's own slot — same left, same width, same
          bottom edge — so it grows from where you were just looking instead of
          appearing somewhere else. Never crosses into the content area. */}
      <div aria-hidden={!open} style={{
        position: 'fixed', left: COL_LEFT, width: COL_W,
        bottom: SLOT_BOTTOM, transformOrigin: 'bottom center', zIndex: 31,
        borderRadius: 14, background: 'rgba(8, 8, 10, 0.98)',
        /* Symmetric now that it floats mid-column; the old -12px cast the shadow
           upward, which only made sense when it sat on top of the bar. */
        boxShadow: 'inset 0 0 0 1px rgba(var(--st-fg-rgb), 0.12), 0 -10px 40px rgba(0,0,0,0.55)',
        /* Grid-rows 0fr -> 1fr rather than max-height. max-height needs a number
           picked in advance, and any number that clears the tallest case (info
           open, twelve swatches) is far taller than the usual one — so it
           either clips and needs an inner scroller, or overshoots and the close
           animation stalls while it unwinds empty space. This animates to
           whatever the content actually is, so there is nothing to scroll. */
        display: 'grid', gridTemplateRows: open ? '1fr' : '0fr', overflow: 'hidden',
        opacity: open ? 1 : 0,
        pointerEvents: open ? 'auto' : 'none',
        /* Deliberately NOT the hint's animation. The hint swings on a hinge with
           an overshoot because it is a small object being flicked into view; a
           panel doing that would wobble. This unfolds upward out of the prompt's
           slot — anchored bottom-centre, easing straight to rest with no bounce,
           scale barely under 1 so the edges settle rather than snap. */
        transform: open ? 'scale(1)' : 'scale(0.94)',
        transition: 'grid-template-rows 0.3s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.17s ease, transform 0.3s cubic-bezier(0.22, 1, 0.36, 1)',
      }}>
        {/* The single grid row. Children keep their old flex-column layout. */}
        <div style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: '11px 11px 8px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontSize: 10.5, fontWeight: 800, letterSpacing: '0.11em',
            textTransform: 'uppercase', color: 'rgba(var(--st-sub-rgb), 0.4)', flex: 1,
          }}>
            From this cover
          </span>
          <button type="button" onClick={() => setInfo((v) => !v)}
            aria-label="Why is this here?" aria-expanded={info}
            style={{
              width: 17, height: 17, flexShrink: 0, padding: 0, borderRadius: '50%',
              border: 'none', cursor: 'pointer', font: 'inherit',
              fontSize: 10, fontWeight: 800, lineHeight: '17px', textAlign: 'center',
              background: info ? 'rgba(var(--st-fg-rgb), 0.22)' : 'rgba(var(--st-fg-rgb), 0.09)',
              color: info ? 'var(--st-text)' : 'rgba(var(--st-text-rgb), 0.5)',
              transition: 'background 0.14s ease, color 0.14s ease',
            }}>?</button>
          {/* Only offered once something is overridden — with nothing to undo it
              is a button that does nothing, which reads as broken. */}
          {current ? (
            <button type="button" className="sth-set-link" onClick={onReset}>Auto</button>
          ) : null}
        </div>

        {/* Collapsed by default. Someone who opened this panel wants swatches,
            not an essay — but the honest answer to "why can I even change this"
            is that the automatic pick is a guess, and that is worth being able
            to find. Grid-rows rather than max-height so it animates to its real
            height whatever the copy length. */}
        <div aria-hidden={!info} style={{
          display: 'grid', flexShrink: 0,
          gridTemplateRows: info ? '1fr' : '0fr',
          opacity: info ? 1 : 0,
          transition: 'grid-template-rows 0.26s cubic-bezier(0.22,1,0.36,1), opacity 0.2s ease',
        }}>
          <div style={{ overflow: 'hidden' }}>
            <p style={{
              margin: '0 11px 10px', fontSize: 10.5, lineHeight: 1.5,
              color: 'rgba(var(--st-sub-rgb), 0.62)',
            }}>
              Studio reads the bar color off the artwork by itself. It&rsquo;s tuned
              against real covers and lands close most of the time &mdash; but there
              isn&rsquo;t one true color in an image, and on busy or washed-out
              sleeves it can pick something you wouldn&rsquo;t have. Everything below
              is an actual color from this cover, so you can overrule it. Auto puts
              it back.
            </p>
          </div>
        </div>

        <div style={{ padding: '0 11px 8px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 7 }}>
            {chips.map((sw) => {
              const rgb = sw.exact || sw.rgb;
              const on = current === rgb;
              const pct = sw.share < 0.01 ? '<1%' : `${Math.round(sw.share * 100)}%`;
              return (
                <button key={rgb} type="button" onClick={() => onPick(rgb)}
                  title={`rgb(${rgb}) — ${pct} of the cover`}
                  style={{
                    padding: 0, border: 'none', background: 'transparent',
                    cursor: 'pointer', font: 'inherit', display: 'block',
                  }}>
                  <span style={{
                    display: 'block', width: '100%', aspectRatio: '1 / 1', borderRadius: 8,
                    background: `rgb(${rgb})`,
                    boxShadow: `inset 0 0 0 ${on ? 2.5 : 1}px rgba(var(--st-fg-rgb), ${on ? 0.95 : 0.16})`,
                    transition: 'box-shadow 0.14s ease',
                  }} />
                  <span style={{
                    display: 'block', marginTop: 3, fontSize: 8.5, lineHeight: 1.2, textAlign: 'center',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    color: `rgba(var(--st-sub-rgb), ${on ? 0.66 : 0.32})`,
                  }}>{pct}</span>
                </button>
              );
            })}
          </div>

          {!chips.length ? (
            <div style={{ fontSize: 11, color: 'rgba(var(--st-sub-rgb), 0.4)', padding: '4px 0 8px' }}>
              No colors read from this cover yet.
            </div>
          ) : null}

          {/* Kept as the last resort, not the first option — a free colour
              picker has nothing to do with the artwork, so it sits under the
              swatches rather than above them. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 11, paddingTop: 9, boxShadow: 'inset 0 1px 0 rgba(var(--st-fg-rgb), 0.08)' }}>
            <StudioColorPicker title="Any color" size={20}
              value={rgbToHex(current || accent)}
              onChange={(hexv) => { const v = hexToRgb(hexv); if (v) onPick(v); }} />
            <span style={{ fontSize: 10.5, fontWeight: 650, color: 'rgba(var(--st-sub-rgb), 0.4)', flex: 1 }}>
              or any color
            </span>
          </div>

          {/* The exact bytes these colours were read from — a separately
              downloaded jpg of the same artwork is a different encoding at a
              different size and gives different colours from identical code. */}
          {coverSrc ? (
            <button type="button" className="sth-set-link"
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 0 4px', fontSize: 9.5 }}
              title="Write the exact image these colors were read from into your Downloads folder"
              onClick={async () => {
                setSaveNote('saving…');
                try {
                  const r = await window.electronAPI?.exportCover?.(coverSrc, exportName || 'cover');
                  setSaveNote(r?.ok ? `saved to Downloads (${Math.round((r.bytes || 0) / 1024)} KB)` : (r?.error || 'could not save'));
                } catch (e) {
                  setSaveNote(String(e?.message || e));
                }
              }}>
              {saveNote || 'save this cover to Downloads'}
            </button>
          ) : null}
        </div>
        </div>
      </div>
    </>
  );
}


/* Brief, Settings: every row is a description on the left and a fixed 320px
   right-aligned control column. Segmented controls fill that column at equal
   segment widths, so every row on a page ends at the same right edge. */
/**
 * Settings → Connections → Spotify account.
 *
 * The full sign-in (spotifyPartner.js): play counts, monthly listeners, bios
 * and related artists on artist pages, and your own Spotify library. Separate
 * from the Client ID panel above, which keeps powering search either way.
 * "Test connection" walks sign-in → web player scan → client token → a real
 * artist query and shows where it stops, because this rides an unofficial
 * interface and "it's blank" needs to come with a reason.
 */
export function SpotifyAccountPanel() {
  const a = typeof window !== 'undefined' ? window.electronAPI : null;
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [steps, setSteps] = useState(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!a?.spotifyPartnerState) return undefined;
    a.spotifyPartnerState().then(setSt).catch(() => setSt({ connected: false }));
    const off = a.onSpotifyPartnerChanged?.((next) => {
      setBusy(false);
      setSt(next);
      if (next?.error) setErr(String(next.error));
      else setErr('');
    });
    return () => off?.();
  }, [a]);

  if (!a?.spotifyPartnerState) return null;

  const signIn = async () => {
    setErr(''); setSteps(null); setBusy(true);
    const r = await a.spotifyPartnerSignIn().catch((e) => ({ ok: false, error: String(e) }));
    if (!r?.ok) { setBusy(false); setErr(r?.error || 'Could not start sign-in.'); }
  };
  const signOut = async () => { await a.spotifyPartnerSignOut(); setSteps(null); };
  const test = async () => {
    setTesting(true); setSteps(null);
    const r = await a.spotifyPartnerDiagnose().catch((e) => ({ ok: false, error: String(e) }));
    setSteps(r?.ok ? r.data : [{ step: 'Test', ok: false, detail: r?.error || 'failed' }]);
    setTesting(false);
  };

  return (
    <section className="sth-conn">
      <div className="sth-conn-head">
        <div>
          <h2>Spotify account</h2>
          <p>
            Plays Spotify songs right in Studio (Premium), and powers My Spotify, search and artist
            pages (play counts, listeners, bios, discography) on any account. Save also hearts a song
            on Spotify. This uses Spotify&apos;s private web player interface, which is unofficial and
            can change without notice.
          </p>
        </div>
        {st ? (
          <span className={`st-status ${st.connected ? 'ok' : 'off'}`}>{st.connected ? 'Connected' : 'Not connected'}</span>
        ) : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {st?.connected ? (
          <>
            <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--text)' }}>
              {st.displayName || 'Signed in'}
              {st.product ? <span style={{ color: 'var(--text-faint)', fontWeight: 600 }}> · {st.product}</span> : null}
            </span>
            <span style={{ flex: 1 }} />
            <button type="button" className="st-btn st-btn-outline" onClick={test} disabled={testing}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <button type="button" className="st-btn st-btn-outline" onClick={signOut}>Sign out</button>
          </>
        ) : (
          <>
            <button type="button" className="st-btn st-btn-primary" onClick={signIn} disabled={busy}>
              {busy ? 'Waiting for your browser…' : 'Sign in with Spotify'}
            </button>
            {busy ? <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Finish in the browser tab that opened.</span> : null}
          </>
        )}
      </div>
      {err ? <div role="status" style={{ fontSize: 12, color: 'var(--danger)', marginTop: 10 }}>{err}</div> : null}
      {steps ? (
        <div style={{ display: 'grid', gap: 6, marginTop: 14 }}>
          {steps.map((x) => (
            <div key={x.step} style={{ display: 'grid', gridTemplateColumns: '16px 150px minmax(0, 1fr)', gap: 10, alignItems: 'baseline', fontSize: 12.5 }}>
              <span style={{ color: x.ok ? 'rgb(140,220,160)' : 'var(--danger)', fontWeight: 800 }}>{x.ok ? '✓' : '×'}</span>
              <span style={{ fontWeight: 700, color: 'var(--text)' }}>{x.step}</span>
              <span style={{ color: 'var(--text-faint)', overflowWrap: 'anywhere' }}>{x.detail}</span>
            </div>
          ))}
        </div>
      ) : null}
      {st?.connected ? <SpotifyPlaybackCheck needsReauth={st.canStream === false} onReauth={signIn} /> : null}
    </section>
  );
}

/**
 * Settings → Connections → Spotify account → Playback.
 *
 * Stage one of Spotify playback: the studio-spotify helper, on its own,
 * before the player bar and library are routed through it. Shows whether the
 * helper is built and signed in, and plays any track you paste so the whole
 * chain (helper → librespot → your speakers) can be checked end to end.
 */
function SpotifyPlaybackCheck({ needsReauth, onReauth }) {
  const a = typeof window !== 'undefined' ? window.electronAPI : null;
  const [snap, setSnap] = useState(null);
  const [link, setLink] = useState('');
  const [pb, setPb] = useState({ state: 'idle', id: null, positionMs: 0 });
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!a?.spotifyPlayerState) return undefined;
    a.spotifyPlayerState().then((s2) => { setSnap(s2); if (s2?.playback) setPb(s2.playback); }).catch(() => {});
    const off = a.onSpotifyPlayerEvent?.((ev) => {
      if (ev.event === 'status') { setSnap(ev); return; }
      if (['loading', 'playing', 'paused', 'ended', 'stopped', 'unavailable'].includes(ev.event)) {
        setPb((p) => ({ ...p, id: ev.id, state: ev.event, positionMs: ev.positionMs ?? p.positionMs }));
        if (ev.event === 'unavailable') setNote('Spotify says this track can’t be played on this account.');
      } else if (ev.event === 'position' || ev.event === 'seeked') {
        setPb((p) => ({ ...p, id: ev.id, positionMs: ev.positionMs }));
      } else if (ev.event === 'error') {
        setNote(String(ev.message || 'The helper reported an error.'));
      }
    });
    return () => off?.();
  }, [a]);

  if (!a?.spotifyPlayerState) return null;

  // Accepts a track link, a spotify:track: URI, or a bare ID.
  const trackId = (() => {
    const v = link.trim();
    const m = v.match(/track[/:]([0-9A-Za-z]{22})/) || v.match(/^([0-9A-Za-z]{22})$/);
    return m ? m[1] : null;
  })();
  const status = snap?.status || 'stopped';
  const statusText = !snap?.installed ? 'Helper not built'
    : status === 'ready' ? `Ready${snap.account?.account ? ` · ${snap.account.account}` : ''}`
      : status === 'starting' ? 'Starting…'
        : status === 'signingIn' ? 'Signing in…'
          : status === 'error' ? 'Not available' : 'Idle — starts when you play';
  const fmt = (ms) => { const t = Math.floor((ms || 0) / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  const act = async (fn) => {
    setNote('');
    const r = await fn().catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (r && r.ok === false) setNote(r.error || 'That didn’t work.');
  };

  return (
    <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 750, color: 'var(--text)' }}>Playback</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: status === 'error' || !snap?.installed ? 'var(--danger)' : 'var(--text-faint)' }}>{statusText}</span>
        <span style={{ flex: 1 }} />
        {snap?.installed && status === 'error' ? (
          <button type="button" className="st-btn st-btn-outline" onClick={() => act(() => a.spotifyPlayerConnect())}>Retry</button>
        ) : null}
      </div>

      {needsReauth ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text-faint)' }}>
            Your sign-in is from before playback existed. Sign in once more to allow it.
          </span>
          <button type="button" className="st-btn st-btn-primary" onClick={onReauth}>Sign in again</button>
        </div>
      ) : null}

      {!snap?.installed ? (
        <p style={{ margin: '8px 0 0', fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-faint)' }}>
          Build it once from the project folder with <code>npm run setup:spotify</code> (needs Rust from rustup.rs), then restart Studio.
        </p>
      ) : snap?.error?.message && status === 'error' ? (
        <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--danger)' }}>{snap.error.message}</p>
      ) : null}

      {snap?.installed && !needsReauth ? (
        <>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <input className="st-input" style={{ flex: 1, minWidth: 0 }} value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="Paste a Spotify track link to test playback"
              aria-label="Spotify track link" spellCheck={false} />
            <button type="button" className="st-btn st-btn-primary" disabled={!trackId}
              onClick={() => act(() => a.spotifyPlayerLoad(trackId, { play: true }))}>Play</button>
            <button type="button" className="st-btn st-btn-outline" disabled={pb.state !== 'playing' && pb.state !== 'paused'}
              onClick={() => act(() => (pb.state === 'playing' ? a.spotifyPlayerPause() : a.spotifyPlayerPlay()))}>
              {pb.state === 'paused' ? 'Resume' : 'Pause'}
            </button>
            <button type="button" className="st-btn st-btn-outline" disabled={pb.state !== 'playing' && pb.state !== 'paused'}
              onClick={() => act(() => a.spotifyPlayerStop())}>Stop</button>
          </div>
          {pb.id ? (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>
              {pb.state === 'loading' ? 'Loading…' : pb.state === 'playing' ? `Playing · ${fmt(pb.positionMs)}`
                : pb.state === 'paused' ? `Paused · ${fmt(pb.positionMs)}` : pb.state === 'ended' ? 'Finished' : pb.state}
            </div>
          ) : null}
          {note ? <div role="status" style={{ marginTop: 8, fontSize: 12, color: 'var(--danger)' }}>{note}</div> : null}
        </>
      ) : null}
    </div>
  );
}

/** Top bar, beside Settings: pick up changes without quitting the app. The
 *  main process decides how much that takes (main.js, reloadApp): a window
 *  reload for screen changes, a full restart when the main process was
 *  rebuilt. Shift+click always restarts. Ctrl+R / Ctrl+Shift+R do the same. */
export function ReloadButton() {
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(false);
  const api = typeof window !== 'undefined' ? window.electronAPI : null;
  if (!api?.appReload) return null;
  const run = (e) => {
    if (busy) return;
    setBusy(true);
    api.appReload({ full: e.shiftKey }).catch(() => setBusy(false));
  };
  return (
    <button
      type="button"
      onClick={run}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Reload (Ctrl+R) · Shift+click to restart Studio (Ctrl+Shift+R)"
      aria-label="Reload Studio"
      style={{
        width: 34, height: 34, borderRadius: 10, border: 'none', cursor: busy ? 'progress' : 'pointer', marginLeft: 'auto',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: hover ? 'rgba(var(--st-fg-rgb), 0.07)' : 'transparent',
        color: hover || busy ? '#fff' : 'rgba(var(--st-fg-rgb), 0.5)',
        transition: 'background 0.16s ease, color 0.16s ease',
      }}
    >
      <style>{'@keyframes sthReloadSpin { to { transform: rotate(360deg); } }'}</style>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        style={{ animation: busy ? 'sthReloadSpin 0.7s linear infinite' : 'none' }}>
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <polyline points="21 3 21 9 15 9" />
      </svg>
    </button>
  );
}

export function SetRow({ title, note, children, wide = true }) {
  return (
    <div className="sth-set-r">
      <span className="txt"><b>{title}</b>{note ? <p>{note}</p> : null}</span>
      <span className={`ctl${wide ? ' is-col' : ''}`}>{children}</span>
    </div>
  );
}

/** A segmented picker. Options are [value, label] pairs. Fills its column. */
export function SetSeg({ value, options, onPick, label }) {
  return (
    <span className="st-segs" role="radiogroup" aria-label={label}>
      {options.map(([id, lbl]) => (
        <button key={String(id)} type="button" role="radio" aria-checked={value === id}
          className={value === id ? 'on' : ''} onClick={() => onPick(id)}>
          {lbl}
        </button>
      ))}
    </span>
  );
}

/* Toggle switches keep their capsule (the one radius exception) and take the
   accent when on — the stock green they used to carry is gone. */
export function SetToggle({ on, onToggle, label }) {
  return (
    <button type="button" role="switch" aria-checked={!!on} aria-label={label}
      className={`st-toggle${on ? ' on' : ''}`} onClick={onToggle} />
  );
}
