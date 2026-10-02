import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/* =========================================================================
 *  useCoverFlight — the ghost-FLIP that flies album art between two slots.
 *
 *  Lifted from CoverFullscreenOverlay's "search morph" so the expanded Now
 *  Playing stage animates with identical physics instead of an approximation.
 *  The overlay's own copy is left in place (it's entangled with the rail
 *  relocation and the staggered close); this is the portable core.
 *
 *  HOW IT WORKS. You can't transition an element between two positions in
 *  two different layouts, so nothing actually moves: we measure the source
 *  rect BEFORE the layout change, let the layout commit, measure the
 *  destination AFTER, then fly a single fixed-position ghost between the two
 *  while both real elements stay hidden. Standard FLIP, with three details
 *  that took the overlay a while to get right and are worth preserving:
 *
 *   1. TWO-FRAME ARM. The ghost must paint at `from` for one frame before
 *      the transition to `to` is applied, or the browser coalesces both
 *      style changes into one and the element simply appears at the
 *      destination with no animation. Hence rAF inside rAF.
 *
 *   2. TOUCHDOWN VERIFICATION. Predicting the destination fails whenever
 *      the card has been dragged — the measurement was taken before the
 *      user's offset applied. So at transitionend we re-measure where the
 *      destination ACTUALLY is (flight over, layout settled, measurement
 *      trivially correct). More than ~1.5px of drift gets a short settle
 *      hop rather than letting the swap snap. Two phases maximum.
 *
 *   3. DIRECTION-AWARE SHADOW. The shadow morphs from the SOURCE's style to
 *      the DESTINATION's — big-and-soft flying up, the inverse coming home —
 *      so neither handoff shows a seam.
 *
 *  The caller owns both refs and the open flag; this owns only the ghost.
 * ========================================================================= */

const FLIGHT_MS = 420;
const FLIGHT_EASE = 'cubic-bezier(0.3, 0.7, 0.25, 1)';
const SETTLE_MS = 190;
/* Drift under this many px is left alone. The settle hop exists for the case
 * where the destination genuinely moved (a dragged card), not for rounding
 * noise — running a second animation to correct 2px reads as a stutter at the
 * end of an otherwise smooth flight, which is worse than the 2px itself. */
const SETTLE_TOLERANCE = 4;

/**
 * @param {object}   o
 * @param {boolean}  o.open        true = flying to the mini slot
 * @param {object}   o.bigRef      ref to the large cover element
 * @param {object}   o.miniRef     ref to the compact header cover element
 * @param {number}   o.radiusBig
 * @param {number}   o.radiusMini
 * @param {boolean}  o.disabled    skip animation entirely (reduced motion)
 */
export function useCoverFlight({
  open,
  bigRef,
  miniRef,
  radiusBig = 16,
  radiusMini = 12,
  disabled = false,
}) {
  const [ghost, setGhost] = useState(null);   // { from, to, radiusFrom, radiusTo, opening, settle }
  const [flying, setFlying] = useState(false);
  const pendingFromRef = useRef(null);
  // The settled big-cover rect captured while at rest, plus the viewport size
  // it was captured at. Flying home to a pre-captured rect is exact by
  // construction; re-measuring mid-collapse is not, because the layout is
  // still animating underneath us.
  const homeRef = useRef(null);
  const firstRun = useRef(true);

  /** Call immediately BEFORE flipping `open` — captures the source rect. */
  const capture = useCallback(() => {
    if (disabled) return;
    const el = open ? miniRef.current : bigRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width) return;
    pendingFromRef.current = {
      left: rect.left, top: rect.top, width: rect.width, height: rect.height,
    };
    if (!open) {
      homeRef.current = {
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        vw: window.innerWidth,
        vh: window.innerHeight,
      };
    }
  }, [open, disabled, bigRef, miniRef]);

  // Measure the destination once the new layout has committed, then launch.
  useLayoutEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    if (disabled) return;
    const from = pendingFromRef.current;
    pendingFromRef.current = null;
    if (!from || !from.width) return;

    let to;
    const home = homeRef.current;
    // Only trust the cached home rect if the viewport hasn't changed since —
    // a resize mid-session would fly the cover to where it used to live.
    const homeValid = !open && home
      && home.vw === window.innerWidth && home.vh === window.innerHeight;
    if (homeValid) {
      to = { ...home.rect };
    } else {
      const dst = open ? miniRef.current : bigRef.current;
      if (!dst) return;
      const m = dst.getBoundingClientRect();
      if (!m.width) return;
      to = { left: m.left, top: m.top, width: m.width, height: m.height };
    }

    setGhost({
      from,
      to,
      radiusFrom: open ? radiusBig : radiusMini,
      radiusTo: open ? radiusMini : radiusBig,
      opening: open,
    });
  }, [open, disabled, bigRef, miniRef, radiusBig, radiusMini]);

  // Two-frame arm (see note 1 above).
  useEffect(() => {
    if (!ghost) { setFlying(false); return undefined; }
    let raf2;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setFlying(true));
    });
    // Belt and braces: if transitionend never fires (tab blurred mid-flight,
    // the element unmounted) the ghost would hang around forever.
    const timer = setTimeout(() => setGhost(null), FLIGHT_MS + 280);
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
      clearTimeout(timer);
    };
  }, [ghost]);

  /** Attach to the ghost element's onTransitionEnd. */
  const handleTransitionEnd = useCallback((e) => {
    if (e.propertyName !== 'left' && e.propertyName !== 'top') return;
    setGhost((g) => {
      if (!g) return null;
      if (g.settle) return null;                       // settle hop done — swap
      const dst = g.opening ? miniRef.current : bigRef.current;
      const m = dst ? dst.getBoundingClientRect() : null;
      if (!m || !m.width) return null;
      const drift = Math.abs(m.left - g.to.left)
        + Math.abs(m.top - g.to.top)
        + Math.abs(m.width - g.to.width);
      if (drift < SETTLE_TOLERANCE) return null;       // close enough — swap
      return { ...g, settle: true, to: { left: m.left, top: m.top, width: m.width, height: m.height } };
    });
  }, [bigRef, miniRef]);

  /**
   * Inline style for the ghost element. Render it yourself so the caller
   * controls the image source and stacking context.
   */
  const ghostStyle = useCallback((accent) => {
    if (!ghost) return null;
    const r = flying ? ghost.to : ghost.from;
    const bigShadow = `0 24px 70px rgba(0,0,0,0.55), 0 0 0 1px rgba(${accent},0.4), inset 0 0 0 1px rgba(255,255,255,0.22)`;
    const miniShadow = `0 0 0 1px rgba(${accent},0.4), inset 0 0 0 1px rgba(255,255,255,0.22)`;
    const props = ['left', 'top', 'width', 'height', 'border-radius'];
    return {
      position: 'fixed',
      pointerEvents: 'none',
      // NOT rounded. Rounding the ghost meant it finished up to half a pixel
      // away from the real element it hands over to, and that mismatch showed
      // as a tiny snap at the moment of the swap — the "jitter". Sub-pixel
      // values hand over seamlessly.
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      borderRadius: flying ? ghost.radiusTo : ghost.radiusFrom,
      backgroundColor: '#111',
      // The artwork is an <img> child now (better downscaling than a CSS
      // background), so the ghost only needs to clip it to the morphing
      // radius rather than paint it.
      overflow: 'hidden',
      boxShadow: ghost.opening
        ? (flying ? miniShadow : bigShadow)
        : (flying ? bigShadow : miniShadow),
      transition: (ghost.settle
        ? props.map((p) => `${p} ${SETTLE_MS}ms cubic-bezier(0.33, 0, 0.15, 1)`)
        : [...props.map((p) => `${p} ${FLIGHT_MS}ms ${FLIGHT_EASE}`), `box-shadow ${FLIGHT_MS}ms ease`]
      ).join(', '),
    };
  }, [ghost, flying]);

  return {
    /** Truthy while a flight is in progress — hide BOTH real covers then. */
    inFlight: !!ghost,
    ghost,
    capture,
    ghostStyle,
    handleTransitionEnd,
  };
}

export default useCoverFlight;
