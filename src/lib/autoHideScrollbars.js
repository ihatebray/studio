/* =========================================================================
 *  studio — scrollbars show only when they're wanted
 *
 *  A scrollbar is invisible until the pointer is over its area or it's
 *  scrolling, and fades back out about a second after scrolling stops. The
 *  hiding itself is CSS in index.html: a thumb is transparent unless its
 *  scroller has .sb-hover or .sb-active. Both are classes set here, because
 *  Chromium doesn't repaint a scrollbar when only :hover changes, but does
 *  when a class does.
 *
 *  .sb-active  for a moment after each scroll: the wheel, the keyboard, or
 *              code scrolling a list into view with the pointer elsewhere.
 *  .sb-hover   every scrollable box the pointer is currently inside.
 * ========================================================================= */

const HOLD_MS = 900;
const timers = new WeakMap();
let hovered = new Set();

function onScroll(e) {
  const el = e.target === document ? document.documentElement : e.target;
  if (!(el instanceof Element)) return;
  el.classList.add('sb-active');
  clearTimeout(timers.get(el));
  timers.set(el, setTimeout(() => el.classList.remove('sb-active'), HOLD_MS));
}

function scrollable(el) {
  if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) return false;
  const cs = getComputedStyle(el);
  return /(auto|scroll|overlay)/.test(cs.overflowY + cs.overflowX);
}

function onPointerOver(e) {
  const next = new Set();
  for (let el = e.target instanceof Element ? e.target : null; el; el = el.parentElement) {
    if (scrollable(el)) next.add(el);
  }
  for (const el of hovered) if (!next.has(el)) el.classList.remove('sb-hover');
  for (const el of next) if (!hovered.has(el)) el.classList.add('sb-hover');
  hovered = next;
}

function clearHover() {
  for (const el of hovered) el.classList.remove('sb-hover');
  hovered = new Set();
}

if (typeof document !== 'undefined') {
  // Scroll events don't bubble, so listen in the capture phase.
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  document.addEventListener('pointerover', onPointerOver, { passive: true });
  document.documentElement.addEventListener('pointerleave', clearHover, { passive: true });
  window.addEventListener('blur', clearHover);
}
