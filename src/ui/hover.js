import { useCallback, useEffect, useRef, useState } from 'react';

/* Hover drawn by code (a style set on mouseenter, cleared on mouseleave)
   sticks when the mouseleave never comes: the pointer leaves the window
   fast, a menu or pop-out opens over the element, the page scrolls it out
   from under a still pointer. While something is hovered this watches the
   browser's own :hover and clears it the moment that's gone. Nothing is
   watched otherwise. */
function watch(el, off) {
  const stop = () => {
    window.removeEventListener('pointermove', check, true);
    window.removeEventListener('scroll', check, true);
    window.removeEventListener('blur', end);
    document.documentElement.removeEventListener('mouseleave', end);
  };
  const end = () => { stop(); off(); };
  function check() {
    // Gone from the page counts as no longer hovered.
    if (!el.isConnected || !el.matches(':hover')) end();
  }
  window.addEventListener('pointermove', check, true);
  window.addEventListener('scroll', check, true);
  window.addEventListener('blur', end);
  document.documentElement.addEventListener('mouseleave', end);
  return stop;
}

/** [hot, props, setHot]: spread props on the element; hot is whether it's hovered. */
export function useHot() {
  const [hot, setHot] = useState(false);
  const ref = useRef(null);
  useEffect(() => (hot && ref.current ? watch(ref.current, () => setHot(false)) : undefined), [hot]);
  const onMouseEnter = useCallback((e) => { ref.current = e.currentTarget; setHot(true); }, []);
  const onMouseLeave = useCallback(() => setHot(false), []);
  return [hot, { onMouseEnter, onMouseLeave }, setHot];
}

/** Handlers for a hover drawn straight onto the element's style:
 *  `on(el)` paints it, `off(el)` puts it back. */
export function hoverStyle(on, off) {
  return {
    onMouseEnter: (e) => { const el = e.currentTarget; on(el); watch(el, () => off(el)); },
    onMouseLeave: (e) => off(e.currentTarget),
  };
}
