import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';


/**
 * Film-grain tile — tiny SVG turbulence texture, tiled + blended over the
 * colour field at very low opacity. Heavy Gaussian blur over dark gradients
 * causes visible 8-bit colour banding; a few percent of noise dithers the
 * gradient and dissolves the bands completely. This is the cheap trick that
 * makes the field look "expensive" — it's a static background-image, so it
 * costs nothing per frame.
 */
const GRAIN_TILE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='128' height='128'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`;


/* ---- One sky for every surface (Immerse) --------------------------------
 * With `field`, a gradient doesn't paint its own little world: it paints its
 * slice of ONE gradient laid over the whole window, on one shared clock. The
 * Now Playing bar, the side panel and the library page each show the part of
 * it behind them, so the colour runs continuously from one surface to the
 * next instead of three unrelated drifts side by side — and stays lined up
 * while the panel slides or compact mode reflows, because each slice is
 * measured against the window every frame.
 *
 * The motion is a calm, steady drift: each shape glides along its own slow
 * curve (two sine waves per axis at unrelated speeds, so the paths never
 * visibly repeat), turns a little and breathes in size. The big shapes stay
 * near the middle and anchor the colour; the smaller ones travel further and
 * carry most of the movement. Paused, the drift eases down to a crawl and
 * picks back up on play, never stopping or jumping. Reduced motion holds it
 * still. The clock is shared, so every surface stays one piece. */
const UNIT = 28;          // px of screen per scene pixel: the shapes are drawn this coarse
const OUT = 8;            // px of screen per pixel of the canvas you see, which holds the blur
const BLUR = 40;          // px of blur, as it reads on screen
const BLEED = 48;         // px drawn past each edge so the blur never fades to empty at the border
/* The blur is done inside the canvas, at OUT px per pixel, not as a CSS
   filter on a full-window layer. A CSS blur(40px) made the GPU re-blur the
   whole window every frame, once per surface (bar, panel, page), and that
   is what slowed weaker GPUs, worst of all with a game running beside it.
   The same 40px of blur on a canvas about 250x150 is nearly free, and the
   compositor then only has to scale a small texture up. */

/*  [size, reachX, reachY, speedX, speedY, phase, spin]
    reach is a share of the window, speed in radians per second of the
    shared clock. Two big shapes anchor the field near the middle; two
    smaller ones travel further. */
const LAYERS = [
  [1.25, 0.10, 0.08, 0.046, 0.061, 0.0, 0.024],
  [0.95, 0.15, 0.12, 0.064, 0.052, 2.1, -0.032],
  [0.72, 0.26, 0.20, 0.083, 0.104, 4.0, 0.046],
  [0.56, 0.30, 0.24, 0.107, 0.078, 1.3, -0.058],
];
/* Where a layer sits at clock time t, in field units around the centre. */
function layerAt(l, i, t) {
  const [, rx, ry, fx, fy, ph] = l;
  // A main curve plus a slower, smaller second one bends each path so it
  // never settles into an ellipse.
  const x = rx * (Math.sin(t * fx + ph) * 0.8 + Math.sin(t * fx * 0.43 + ph * 1.7 + i) * 0.2);
  const y = ry * (Math.sin(t * fy + ph * 0.6 + 1.1) * 0.8 + Math.sin(t * fy * 0.51 + ph * 2.3) * 0.2);
  return [x, y];
}

const PLAY_RATE = 1;
const PAUSE_RATE = 0.25;
const sky = { last: 0, t: 0, rate: PLAY_RATE };
const ez = (dt, tau) => 1 - Math.exp(-dt / Math.max(1e-3, tau));
/* Advance the shared clock. Every instance calls it each frame; the first
   in a frame does the work. The rate eases between playing and paused, so
   the drift slows and resumes without a jolt. */
function skyStep(now, playing, still) {
  if (!sky.last) sky.last = now;
  const dt = Math.min(0.05, (now - sky.last) / 1000);
  if (dt < 0.004 || still) { if (dt >= 0.004) sky.last = now; return sky; }
  sky.last = now;
  sky.rate += ((playing ? PLAY_RATE : PAUSE_RATE) - sky.rate) * ez(dt, 1.2);
  sky.t += dt * sky.rate;
  return sky;
}

const parseRgb = (s) => String(s || '').split(',').map((n) => Number(n) || 0).slice(0, 3);
const rgbStr = (c) => c.map((n) => Math.round(n)).join(', ');

function AnimatedGradientBg({
  accent, mid, wash, coverUrl, isPlaying,
  // Both default to the look this component has always had.
  vignette = true,
  brightness = 1,
  field = false,
}) {
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const rafRef = useRef(null);
  /* Pre-masked circular sprites of the cover (offscreen canvases), not the
     raw image: rotating squares let their corners survive the blur as faint
     swings of light, a feathered circle stays a blob at every angle. Two of
     them during a change of song, the old one fading out under the new. */
  const spritesRef = useRef({ cur: null, prev: null, at: 0 });
  const coverUrlRef = useRef(null);
  const lastTimeRef = useRef(0);
  // Latest props mirrored into a ref so the long-lived loop reads them.
  const propsRef = useRef({ isPlaying, accent, mid, wash, field, brightness });
  useEffect(() => {
    propsRef.current = { isPlaying, accent, mid, wash, field, brightness };
  }, [isPlaying, accent, mid, wash, field, brightness]);

  // Load the cover whenever it changes and bake it into a feathered sprite;
  // the previous one stays on to fade out.
  useEffect(() => {
    if (!coverUrl) { coverUrlRef.current = null; return; }
    if (coverUrl === coverUrlRef.current) return;
    coverUrlRef.current = coverUrl;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      // Guard against a stale load finishing after the track changed again.
      if (coverUrlRef.current !== coverUrl) return;
      const S = 96; // sprite resolution — plenty, it gets drawn small
      const off = document.createElement('canvas');
      off.width = S;
      off.height = S;
      const octx = off.getContext('2d');
      let sprite = img;
      if (octx) {
        const scale = Math.max(S / img.naturalWidth, S / img.naturalHeight);
        const dw = img.naturalWidth * scale;
        const dh = img.naturalHeight * scale;
        octx.drawImage(img, (S - dw) / 2, (S - dh) / 2, dw, dh);
        // Feather: opaque core, fading to fully transparent at the edge.
        const mask = octx.createRadialGradient(S / 2, S / 2, S * 0.22, S / 2, S / 2, S * 0.5);
        mask.addColorStop(0, 'rgba(0,0,0,1)');
        mask.addColorStop(0.7, 'rgba(0,0,0,0.85)');
        mask.addColorStop(1, 'rgba(0,0,0,0)');
        octx.globalCompositeOperation = 'destination-in';
        octx.fillStyle = mask;
        octx.fillRect(0, 0, S, S);
        sprite = off;
      }
      const sp = spritesRef.current;
      spritesRef.current = { cur: sprite, prev: sp.cur, at: performance.now() };
    };
    img.src = coverUrl;
  }, [coverUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const out = canvas.getContext('2d');
    // The shapes are drawn into a small scene canvas, then blurred onto the visible one.
    const scene = sceneRef.current || (sceneRef.current = document.createElement('canvas'));
    const ctx = scene.getContext('2d');
    if (!ctx || !out) return undefined;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const FADE_S = 1.2;        // a new cover's colours fade in over this long

    // The colours on screen, eased toward the props so a new song's palette
    // blends in instead of cutting.
    const shown = { acc: parseRgb(propsRef.current.accent), mid: parseRgb(propsRef.current.mid), wash: parseRgb(propsRef.current.wash), bright: propsRef.current.brightness ?? 1 };
    const ownStart = performance.now();
    lastTimeRef.current = ownStart;

    const frame = () => {
      const now = performance.now();
      /* 30 frames a second: a heavily blurred drift looks the same at half
         the rate. 15 while Studio isn't the window you're using (a game in
         front, say), so it leaves the GPU alone. Motion is time-based, so
         skipping frames doesn't slow it. */
      const fps = document.hasFocus() ? 30 : 15;
      if (now - lastTimeRef.current < 1000 / fps - 2) { rafRef.current = requestAnimationFrame(frame); return; }
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTimeRef.current) / 1000));
      lastTimeRef.current = now;
      const P = propsRef.current;

      /* Motion: the shared sky (field), or this instance's own slow drift. */
      const t = P.field ? skyStep(now, !!P.isPlaying, still).t : (still ? 0 : (now - ownStart) / 1000);

      /* ---- Size: the box this canvas covers, at one pixel per UNIT ---- */
      let W; let H; let ox0 = 0; let oy0 = 0; let VW; let VH;
      const r = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : { left: 0, top: 0, width: 300, height: 150 };
      if (P.field) {
        W = Math.max(2, Math.ceil((r.width + BLEED * 2) / UNIT));
        H = Math.max(2, Math.ceil((r.height + BLEED * 2) / UNIT));
        ox0 = (r.left - BLEED) / UNIT;
        oy0 = (r.top - BLEED) / UNIT;
        VW = window.innerWidth / UNIT;
        VH = window.innerHeight / UNIT;
      } else {
        W = 32; H = 32; VW = 32; VH = 32;
      }
      if (scene.width !== W) scene.width = W;
      if (scene.height !== H) scene.height = H;
      // The visible canvas: the element's own size at OUT px per pixel.
      const bleed = P.field ? BLEED * 2 : 0;
      const OW = Math.max(2, Math.ceil((r.width + bleed) / OUT));
      const OH = Math.max(2, Math.ceil((r.height + bleed) / OUT));
      if (canvas.width !== OW) canvas.width = OW;
      if (canvas.height !== OH) canvas.height = OH;

      // Ease the colours toward the current song's.
      const ease = 1 - Math.exp(-dt / (FADE_S / 3));
      for (const [key, src] of [['acc', P.accent], ['mid', P.mid], ['wash', P.wash]]) {
        const to = parseRgb(src);
        shown[key] = shown[key].map((v, i) => v + (to[i] - v) * ease);
      }
      shown.bright += ((P.brightness ?? 1) - shown.bright) * ez(dt, 0.08);
      const acc = rgbStr(shown.acc);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      // From here on, draw in field coordinates; the transform picks out
      // this canvas's slice of it.
      ctx.setTransform(1, 0, 0, 1, -ox0, -oy0);
      const cx = VW / 2;
      const cy = VH / 2;
      // Shapes are sized off the field's geometric mean, so they keep a
      // comparable size whatever its shape.
      const S = Math.sqrt(VW * VH);

      // Background: the palette as a soft radial field.
      const fallback = ctx.createRadialGradient(cx, cy * 0.6, 0, cx, cy, S * 0.9);
      fallback.addColorStop(0, `rgba(${acc}, 0.8)`);
      fallback.addColorStop(0.5, `rgba(${rgbStr(shown.mid)}, 0.7)`);
      fallback.addColorStop(1, `rgba(${rgbStr(shown.wash)}, 0.55)`);
      ctx.fillStyle = fallback;
      ctx.fillRect(ox0, oy0, W, H);

      const { cur, prev, at } = spritesRef.current;
      const p = cur ? Math.min(1, (now - at) / (FADE_S * 1000)) : 0;
      if (p >= 1 && prev) spritesRef.current = { cur, prev: null, at };
      const drawLayers = (sprite, alphaScale) => {
        if (!sprite || alphaScale <= 0.001) return;
        LAYERS.forEach((l, i) => {
          const [relSize, , , , , ph, spin] = l;
          const [dx, dy] = layerAt(l, i, t);
          // A slow breath in size, out of step between shapes.
          const size = relSize * S * (1 + 0.06 * Math.sin(t * 0.17 + ph * 2));
          ctx.save();
          ctx.translate(cx + dx * VW, cy + dy * VH);
          ctx.rotate(ph * 0.5 + t * spin);
          ctx.globalAlpha = 0.55 * alphaScale;
          ctx.drawImage(sprite, -size / 2, -size / 2, size, size);
          ctx.restore();
        });
      };
      // The old cover fades out under the new one.
      const smooth = p * p * (3 - 2 * p);
      if (prev) drawLayers(prev, 1 - smooth);
      drawLayers(cur, prev ? smooth : 1);

      // Scene → visible canvas, stretched to fit and blurred on the way.
      out.setTransform(1, 0, 0, 1, 0, 0);
      out.clearRect(0, 0, OW, OH);
      out.imageSmoothingEnabled = true;
      out.imageSmoothingQuality = 'high';
      out.filter = `blur(${(BLUR / OUT).toFixed(2)}px) saturate(1.8)${Math.abs(shown.bright - 1) > 0.002 ? ` brightness(${shown.bright.toFixed(3)})` : ''}`;
      out.drawImage(scene, 0, 0, OW, OH);
      out.filter = 'none';

      rafRef.current = requestAnimationFrame(frame);
    };

    rafRef.current = requestAnimationFrame(frame);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []); // long-lived loop; all changing values arrive via propsRef/spritesRef

  return (
    <>
      {/* The canvas renders tiny and is scaled up to full size; the upscale
          plus the CSS blur make a smooth smear of colour. In field mode it
          reaches BLEED px past every edge, so the blur has colour to work
          with right up to the border (the parent clips it). */}
      <canvas
        ref={canvasRef}
        aria-hidden
        style={{
          position: 'absolute',
          ...(field ? { left: -BLEED, top: -BLEED, width: `calc(100% + ${BLEED * 2}px)`, height: `calc(100% + ${BLEED * 2}px)` } : { inset: 0, width: '100%', height: '100%' }),
          pointerEvents: 'none',
          transition: 'opacity 0.8s ease',
        }}
      />
      {/* Grain — dissolves the 8-bit banding the heavy blur produces on
          dark gradients. A plain layer, not mix-blend-mode: overlay, which
          made the GPU composite the whole window once more every frame. */}
      <div
        aria-hidden
        style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          backgroundImage: GRAIN_TILE,
          backgroundRepeat: 'repeat',
          opacity: 0.035,
        }}
      />
      {/* Vignette — bottom darkens more so track info stays readable */}
      {vignette ? (
        <div
          aria-hidden
          style={{
            position: 'absolute', inset: 0, pointerEvents: 'none',
            background: 'linear-gradient(180deg, rgba(0,0,0,0.18) 0%, rgba(0,0,0,0.65) 50%, rgba(0,0,0,0.94) 100%)',
          }}
        />
      ) : null}
    </>
  );
}


const MemoAnimatedGradientBg = React.memo(AnimatedGradientBg);
export { MemoAnimatedGradientBg as AnimatedGradientBg };

/* A layer that fades in when it appears and stays mounted while it fades
   out, instead of cutting. Immerse's surfaces sit in these, so switching
   it off (or dark mode on) dissolves the field on every surface together. */
export const LAYER_FADE_MS = 600;
export function FadeLayer({ show, ms = LAYER_FADE_MS, className, style, children }) {
  const [mounted, setMounted] = useState(show);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (show) {
      setMounted(true);
      // Two frames: the first paints it at 0, so the change to 1 transitions.
      let inner = 0;
      const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => setShown(true)); });
      return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(t);
  }, [show, ms]);
  if (!mounted) return null;
  return (
    <div aria-hidden className={className} style={{
      position: 'absolute', inset: 0, pointerEvents: 'none', ...style,
      opacity: shown ? 1 : 0, transition: `opacity ${ms}ms ease`,
    }}>
      {children}
    </div>
  );
}

/* Cross-fades between looks. Each change of `swapKey` (a surface setting, or
   the colour it paints) fades the new layers in while the old ones fade out
   over the same time; a null `children` fades the old ones out to nothing.
   FadeLayer does this for Immerse being on or off; this is the same thing
   for surfaces that change rather than come and go: Color, Cover Art, Full
   Color and the colour itself as the song changes. */
const SWAP_CSS = '@keyframes stSwapIn{from{opacity:0}}@keyframes stSwapOut{to{opacity:0}}';
export function FadeSwap({ swapKey, ms = LAYER_FADE_MS, style, children }) {
  const [leaving, setLeaving] = useState([]); // [{ id, node }]
  const prevRef = useRef({ key: swapKey, node: children });
  const idRef = useRef(0);
  const timers = useRef(new Set());
  useLayoutEffect(() => {
    const prev = prevRef.current;
    if (prev.key !== swapKey && prev.node) {
      idRef.current += 1;
      const id = idRef.current;
      setLeaving((l) => [...l, { id, node: prev.node }]);
      const t = setTimeout(() => { timers.current.delete(t); setLeaving((l) => l.filter((x) => x.id !== id)); }, ms);
      timers.current.add(t);
    }
    prevRef.current = { key: swapKey, node: children };
  });
  useEffect(() => () => { for (const t of timers.current) clearTimeout(t); }, []);
  const layer = { position: 'absolute', inset: 0, pointerEvents: 'none', ...style };
  return (
    <>
      <style>{SWAP_CSS}</style>
      {leaving.map((l) => (
        <div key={`out-${l.id}`} aria-hidden style={{ ...layer, animation: `stSwapOut ${ms}ms ease both` }}>{l.node}</div>
      ))}
      {children ? (
        <div key={`in-${swapKey}`} aria-hidden style={{ ...layer, animation: `stSwapIn ${ms}ms ease both` }}>{children}</div>
      ) : null}
    </>
  );
}
