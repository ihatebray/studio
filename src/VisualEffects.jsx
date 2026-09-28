import React, { useEffect, useRef } from 'react';

function EdgeBleedBand({ accent }) {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        left: 0, right: 0, bottom: 0,
        height: 60,
        zIndex: 2,
        pointerEvents: 'none',
        // Tall ellipse anchored to the bottom centre. The radial gradient
        // gives a soft light-leak feel — strongest in the lower middle,
        // fading out at the top edge and to either side.
        background: `radial-gradient(ellipse 80% 100% at 50% 100%, rgba(${accent}, 0.32) 0%, rgba(${accent}, 0.10) 40%, rgba(${accent}, 0) 80%)`,
        // Multiply blend lets the underlying gradient field's colour
        // peek through, so the bleed reads as additive light rather
        // than an opaque overlay.
        mixBlendMode: 'screen',
        transition: 'background 600ms ease',
      }}
    />
  );
}

/**
 * Film-grain tile — tiny SVG turbulence texture, tiled + blended over the
 * colour field at very low opacity. Heavy Gaussian blur over dark gradients
 * causes visible 8-bit colour banding; a few percent of noise dithers the
 * gradient and dissolves the bands completely. This is the cheap trick that
 * makes the field look "expensive" — it's a static background-image, so it
 * costs nothing per frame.
 */
const GRAIN_TILE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='128' height='128'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`;

/** Opaque grayscale dither noise.
 *  Distinct from GRAIN_TILE: feTurbulence's raw output has a RANDOM ALPHA
 *  channel, so most of its pixels are partly transparent and its effective
 *  amplitude is a fraction of what it looks like. That's fine for decorative
 *  grain, useless for dithering — a dither has to reliably swing at least one
 *  8-bit level or it does nothing at all. feFuncA pins alpha to 1 and
 *  feColorMatrix drops it to grayscale, giving noise that actually bites.
 */
const DITHER_TILE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='d' x='0' y='0'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3CfeComponentTransfer%3E%3CfeFuncA type='discrete' tableValues='1'/%3E%3C/feComponentTransfer%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23d)'/%3E%3C/svg%3E")`;

function AnimatedGradientBg({
  accent, mid, wash, coverUrl, analyserRef, beatReactive, isPlaying,
  // Both default to the look this component has always had, so existing
  // callers (the now-playing page) are untouched. The fullscreen overlay
  // drives them from its Backdrop settings.
  vignette = true,
  brightness = 1,
}) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  // Pre-masked circular sprite of the cover (offscreen canvas), not the raw
  // image. Drawing rotating *squares* lets the hard corners survive the blur
  // as faint luminance swings; a radially feathered circle keeps the blobs
  // genuinely blobby at every rotation angle.
  const spriteRef = useRef(null);
  const coverUrlRef = useRef(null);
  // Beat state — all in refs so the long-lived RAF closure never restarts.
  //   fastEnv: quick-attack envelope of bass energy (the "now")
  //   slowEnv: long-window baseline of bass energy (the "recently")
  //   beatEnv: smoothed output actually driving the visuals
  // Beat = how far "now" exceeds "recently". Tracking the *difference*
  // instead of raw energy is what makes the field punch on kicks and relax
  // between them — raw energy just swells and stays swollen on any song
  // with a sustained bassline.
  const fastEnvRef = useRef(0);
  const slowEnvRef = useRef(0);
  const beatEnvRef = useRef(0);
  const lastTimeRef = useRef(0);
  // Frequency-data buffer; sized when the analyser first appears.
  const freqBufRef = useRef(null);
  // Latest props mirrored into refs so the RAF closure always reads current
  // values without restarting. Colours included — with [] effect deps the
  // closure would otherwise capture the FIRST render's accent/mid/wash
  // forever, leaving the no-cover fallback gradient stuck on track one.
  const propsRef = useRef({ analyserRef, beatReactive, isPlaying, accent, mid, wash });
  useEffect(() => {
    propsRef.current = { analyserRef, beatReactive, isPlaying, accent, mid, wash };
  }, [analyserRef, beatReactive, isPlaying, accent, mid, wash]);

  // Load the cover image whenever coverUrl changes, then bake it into a
  // radially-feathered circular sprite once.
  useEffect(() => {
    if (!coverUrl) {
      spriteRef.current = null;
      coverUrlRef.current = null;
      return;
    }
    if (coverUrl === coverUrlRef.current) return;
    coverUrlRef.current = coverUrl;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      // Guard against a stale load finishing after the track changed again.
      if (coverUrlRef.current !== coverUrl) return;
      const S = 96; // sprite resolution — plenty, it gets drawn at ≤ ~40px
      const off = document.createElement('canvas');
      off.width = S;
      off.height = S;
      const octx = off.getContext('2d');
      if (!octx) { spriteRef.current = img; return; }
      // Cover-fit the (possibly non-square) image into the square sprite.
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
      spriteRef.current = off;
    };
    img.onerror = () => {
      if (coverUrlRef.current === coverUrl) spriteRef.current = null;
    };
    img.src = coverUrl;
  }, [coverUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Run at extreme low resolution — CSS upscaling to full size creates
    // heavy natural blur. 32px → ~900px display = 28× scale, which completely
    // destroys any recognizable image structure.
    const W = 32;
    const H = 32;
    canvas.width = W;
    canvas.height = H;

    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // 6 params per layer:
    //   [relativeSize, orbitRadius, orbitSpeed, spinSpeed, initialAngle, beatWeight]
    // Orbit radius is in normalized units (0-1 of the canvas size).
    // Two big layers spin in place (orbit=0), two small ones orbit + spin.
    // beatWeight differentiates the pulse per layer: the big background
    // layers barely react while the small orbiting blobs dance — a uniform
    // pulse reads as the whole canvas "zooming", which looks mechanical.
    const layers = prefersReduced ? [
      [1.2,  0,    0,      0,     0,   0],
      [0.8,  0,    0,      0,     0,   0],
      [0.6,  0,    0,      0,     0,   0],
      [0.4,  0,    0,      0,     0,   0],
    ] : [
      [1.25, 0,    0.0,    0.022, 0,   0.45],  // huge, very slow spin in place
      [0.90, 0,    0.0,   -0.031, 1.1, 0.60],  // large, slow opposite spin
      [0.70, 0.18, 0.038,  0.055, 0.5, 1.00],  // medium, gentle orbit + spin
      [0.55, 0.24, -0.051, 0.07,  2.4, 1.25],  // smaller, slow orbit — dances hardest
    ];

    // Envelope time constants (seconds). Time-based smoothing keeps the
    // response identical at 60Hz and 120Hz — per-frame constants like the
    // old 0.45/0.06 run twice as fast on high-refresh displays.
    const FAST_ATTACK = 0.035;
    const FAST_RELEASE = 0.18;
    const SLOW_TAU = 1.2;      // baseline window — "what the bass has been doing lately"
    const OUT_ATTACK = 0.04;   // final visual envelope: snappy up…
    const OUT_RELEASE = 0.22;  // …silky down

    const cx = W / 2;
    const cy = H / 2;
    const startTime = performance.now();
    lastTimeRef.current = startTime;

    const frame = () => {
      const now = performance.now();
      const t = (now - startTime) / 1000; // seconds
      // Clamp dt so a backgrounded tab returning doesn't step the envelopes
      // by multiple seconds in one frame.
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTimeRef.current) / 1000));
      lastTimeRef.current = now;
      // dt-aware smoothing factor: fraction of the gap to close this frame.
      const k = (tau) => 1 - Math.exp(-dt / tau);

      /* ---- Beat detection ----
       * 1. Average the lowest ~50 bins (bass) → raw energy 0..1.
       * 2. fastEnv tracks it with a quick attack — "what's hitting now".
       * 3. slowEnv tracks it over ~1.2s — the recent baseline.
       * 4. onset = how far fast exceeds slow. This is the actual "beat":
       *    it spikes on kicks and returns to ~0 during sustained bass,
       *    instead of leaving the field permanently swollen.
       * 5. A small slice of raw energy is mixed back in so heavy sections
       *    still feel a touch fuller overall.
       * Reduced-motion users opt out of the kinetic boost regardless. */
      let beat = 0;
      const { analyserRef: aRef, beatReactive: br, isPlaying: ip, accent: acc, mid: midC, wash: washC } = propsRef.current;
      const analyser = aRef?.current;
      if (br && ip && analyser && !prefersReduced) {
        if (!freqBufRef.current || freqBufRef.current.length !== analyser.frequencyBinCount) {
          freqBufRef.current = new Uint8Array(analyser.frequencyBinCount);
        }
        analyser.getByteFrequencyData(freqBufRef.current);
        const bins = freqBufRef.current;
        const N = Math.min(50, bins.length);
        let sum = 0;
        for (let i = 0; i < N; i++) sum += bins[i];
        const energy = (sum / N) / 255; // 0..1

        const fast = fastEnvRef.current;
        fastEnvRef.current = energy > fast
          ? fast + (energy - fast) * k(FAST_ATTACK)
          : fast + (energy - fast) * k(FAST_RELEASE);
        slowEnvRef.current += (energy - slowEnvRef.current) * k(SLOW_TAU);

        const onset = Math.max(0, fastEnvRef.current - slowEnvRef.current);
        // Onset is small in absolute terms (energy deltas), so scale it up;
        // clamp keeps outlier transients from blowing past 1.
        const target = Math.min(1, onset * 3.2 + energy * 0.18);

        const env = beatEnvRef.current;
        beatEnvRef.current = target > env
          ? env + (target - env) * k(OUT_ATTACK)
          : env + (target - env) * k(OUT_RELEASE);
        beat = beatEnvRef.current;
      } else {
        // Decay everything to rest when reactivity is off, paused, or no analyser.
        beatEnvRef.current += (0 - beatEnvRef.current) * k(OUT_RELEASE);
        fastEnvRef.current *= 0.9;
        slowEnvRef.current *= 0.98;
        beat = beatEnvRef.current;
      }

      ctx.clearRect(0, 0, W, H);

      /* Blobs are sized off the geometric mean of the box, not its width.
         Width alone works while the box is roughly square, and falls apart on
         extreme aspect ratios: in the Now Playing bar (about 1150 x 84) a blob
         sized to the width is thirteen times taller than the bar, so all you
         ever see is the flat middle of one enormous blob — a pale haze with no
         structure, while the tall side panel showed the same colours as
         distinct fields. sqrt(W*H) keeps the blobs at a comparable visual size
         whatever shape the surface is. */
      const S = Math.sqrt(W * H);

      // Background fill using the extracted theme colours as a fallback
      // (shows when no image is loaded yet, or when image fails). Read from
      // propsRef so a track change actually updates the colours — a plain
      // closure read here would be frozen at mount time.
      const fallback = ctx.createRadialGradient(cx, cy * 0.6, 0, cx, cy, S * 0.9);
      fallback.addColorStop(0, `rgba(${acc}, 0.9)`);
      fallback.addColorStop(0.5, `rgba(${midC}, 0.7)`);
      fallback.addColorStop(1, `rgba(${washC}, 0.5)`);
      ctx.fillStyle = fallback;
      ctx.fillRect(0, 0, W, H);

      const sprite = spriteRef.current;
      if (sprite) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';

        for (const [relSize, orbitR, orbitSpeed, spinSpeed, initAngle, beatW] of layers) {
          const orbitAngle = initAngle + t * orbitSpeed;
          // Very slow sinusoidal wobble on the orbit radius so the drift
          // wanders instead of tracing perfect mechanical circles.
          const wobble = 1 + 0.15 * Math.sin(t * 0.11 + initAngle * 3.0);
          // Beat-modulated orbit & size — bass hits push layers outward and
          // grow them momentarily, scaled by this layer's beatWeight so the
          // small blobs dance while the big base layers stay anchored.
          const b = beat * beatW;
          const beatBoost = 1 + b * 0.22;
          const orbitBoost = (1 + b * 0.4) * wobble;
          const ox = cx + orbitR * orbitBoost * W * Math.cos(orbitAngle);
          const oy = cy + orbitR * orbitBoost * H * Math.sin(orbitAngle);
          const spinAngle = initAngle * 0.5 + t * spinSpeed;
          const size = relSize * beatBoost * S;

          ctx.save();
          ctx.translate(ox, oy);
          ctx.rotate(spinAngle);
          // Beat also pushes alpha up slightly so the colours feel "lit".
          ctx.globalAlpha = Math.min(1, 0.55 + b * 0.25);
          ctx.drawImage(sprite, -size / 2, -size / 2, size, size);
          ctx.restore();
        }

        // Faint additive glow on hits — kicks read as *light*, not just
        // motion. Deliberately subtle; past ~0.2 alpha it looks like a
        // camera flash.
        if (beat > 0.03) {
          const glow = ctx.createRadialGradient(cx, cy * 0.9, 0, cx, cy * 0.9, W * 0.7);
          glow.addColorStop(0, `rgba(${acc}, ${(beat * 0.16).toFixed(3)})`);
          glow.addColorStop(1, `rgba(${acc}, 0)`);
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = glow;
          ctx.fillRect(0, 0, W, H);
          ctx.globalCompositeOperation = 'source-over';
        }

        ctx.restore();
      }

      rafRef.current = requestAnimationFrame(frame);
    };

    rafRef.current = requestAnimationFrame(frame);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []); // long-lived loop; all changing values arrive via propsRef/spriteRef

  return (
    <>
      {/* The canvas renders tiny and is scaled up to full size.
          The bicubic upscaling + the CSS blur together create a very smooth
          smeared-colours effect identical to a heavy Gaussian blur. */}
      <canvas
        ref={canvasRef}
        aria-hidden
        style={{
          position: 'absolute', inset: 0,
          width: '100%', height: '100%',
          pointerEvents: 'none',
          // imageRendering: pixelated would break the blur — leave as default
          filter: `blur(40px) saturate(1.8)${brightness !== 1 ? ` brightness(${brightness.toFixed(3)})` : ''}`,
          transition: 'opacity 0.8s ease, filter 0.24s ease',
        }}
      />
      {/* Grain — dissolves the 8-bit banding the heavy blur produces on
          dark gradients. Static texture, zero per-frame cost. */}
      <div
        aria-hidden
        style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          backgroundImage: GRAIN_TILE,
          backgroundRepeat: 'repeat',
          opacity: 0.05,
          mixBlendMode: 'overlay',
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


export { EdgeBleedBand, AnimatedGradientBg, GRAIN_TILE, DITHER_TILE };
