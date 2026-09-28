import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  sampleCoverTheme, washSourceFor, barTone, pageWash, isFallbackTheme,
} from './coverTheme.js';

/* =========================================================================
 *  LyricShare — pick lines, get an image.
 *
 *  ── WHY CANVAS 2D AND NOT SVG/foreignObject ──────────────────────────────
 *  Kept verbatim from the original because both failure modes are silent and
 *  cost real debugging time:
 *
 *   1. Cover art arrives over the custom `studio-cover://` protocol. Loading
 *      it inside a Blob-URL SVG TAINTS the canvas, and a tainted canvas
 *      makes `toBlob()` return null with no error thrown.
 *   2. SVG→canvas rasterisation is fragile in ways that don't announce
 *      themselves: `foreignObject` HTML sometimes doesn't paint, embedded
 *      `<image>` sometimes doesn't load, `<filter>` sometimes doesn't render.
 *
 *  Same reason the cover goes through a bare `<img crossOrigin="anonymous">`
 *  rather than fetch→blob→dataURL: the fetch path runs through different
 *  security plumbing and can produce a tainting result for custom protocols.
 *
 *  ── ONE CARD, NO PICKERS ─────────────────────────────────────────────────
 *  This replaces a card with three formats, three themes and a cover toggle —
 *  eighteen combinations of one idea. The formats existed because a fixed
 *  aspect ratio crops or letterboxes wherever it gets posted, but a card whose
 *  HEIGHT FOLLOWS ITS TEXT doesn't have that problem in the first place, so
 *  the picker was solving a problem the picker created. The themes were a
 *  second guess at the question the artwork already answers.
 *
 *  What's left: fixed width, derived height, colour from the artwork.
 *
 *    ┌──────────────────────────┐
 *    │ Lyric line one           │   ← the words, sized to the block
 *    │ lyric line two           │
 *    │                          │
 *    │                          │   ← slack, only at the height floor
 *    │ ▪ Title            1:04  │   ← footer: cover, meta, where in the song
 *    │   Artist                 │
 *    └──────────────────────────┘
 *
 *  ── WHY THE LYRICS LEAD, AND WHY THE GROUND IS FLAT ──────────────────────
 *  The quote is the payload; everything else is attribution, and attribution
 *  belongs under the thing it attributes. Reversing this (header first) made
 *  the card read as a track tile that happened to have words in it.
 *
 *  The ground is a single flat colour lifted from the artwork rather than the
 *  artwork blurred. Blur competes with the type at exactly the sizes the type
 *  gets small — long selections — and it costs a full-canvas filter pass for a
 *  texture nobody reads. One colour carries the same "this is that record"
 *  signal and leaves the words alone.
 *
 *  No wordmark. A card that has to sign itself isn't finished.
 *
 *  ── WHERE THE COLOUR COMES FROM ──────────────────────────────────────────
 *  The card samples the artwork itself and runs the result through the same
 *  barTone() → pageWash() pair the now-playing bar uses. It does NOT depend on
 *  being handed a colour.
 *
 *  It did, briefly, and that was wrong twice over. The prop it was given was
 *  `accent`, which is a TEXT colour — themeFromAverage() returns flat white for
 *  it on any sleeve dark enough that a coloured label wouldn't read, so the
 *  card came out white on exactly the records with the most colour to give.
 *  Renaming the prop then moved the failure rather than fixing it: a colour
 *  that has to be threaded through two call sites is a colour that can arrive
 *  as undefined, and the card had a reasonable-looking near-black to paint
 *  when it did. Two different records exported the identical #121218.
 *
 *  Calling the sampler here can't be wired wrong. The `surface` prop remains,
 *  but only as an override for a manual pick from the colour tray — the one
 *  case where there IS an answer the artwork can't supply.
 * ========================================================================= */

/** Export width. Height is derived — see the measure pass in rasterize(). */
const CARD_W = 1080;

/* Bounds on the derived height. The floor stops a one-word selection becoming
   a letterbox strip; the ceiling keeps a whole verse from exporting as a
   scroll nobody can read in a feed. Between them the card simply hugs. */
const MIN_H = 620;
const MAX_H = 1920;

/* Bounds the fit solver works between. The ceiling is what a two-word
   selection is allowed to grow to before the card stops trying to fill itself
   and just centres the quote instead — past roughly this size the words start
   reading as a poster rather than as a lyric. */
const MIN_LYRIC = 24;
const MAX_LYRIC = Math.round(CARD_W * 0.095);

/* Type steps down as the block grows, so two lines feel like a quote and
   twelve still fit without becoming a wall. Ratios of CARD_W, carried from
   the mockup's 320px card: 21 / 16 / 13.5 there → these at 1080.

   This is the STARTING size. When the card lands outside its height bounds the
   solver below overrides it in either direction. */
function lyricSizeFor(chars) {
  if (chars > 190) return Math.round(CARD_W * 0.0422);
  if (chars > 95) return Math.round(CARD_W * 0.0500);
  return Math.round(CARD_W * 0.0656);
}

const lumOf = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;

const FALLBACK_FIELD = [18, 18, 24];

/* Studio passes colours around as bare "r, g, b" strings, but the colour tray
   stores whatever the picker handed it, so accept hex too rather than silently
   painting the fallback over someone's manual pick.

   And it warns. The previous version of this returned the fallback without a
   sound, which is how the card shipped painting a flat near-black over every
   record: the value never arrived, the card had a perfectly reasonable colour
   to fall back to, and nothing anywhere said so. */
function parseRgb(str) {
  const raw = String(str || '').trim();
  if (!raw) return FALLBACK_FIELD;

  const hex = raw.replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  }
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return [0, 1, 2].map((i) => parseInt(hex[i] + hex[i], 16));
  }

  const p = raw.replace(/^rgba?\(|\)$/g, '').split(',').map((n) => parseInt(n.trim(), 10));
  if (p.length >= 3 && p.slice(0, 3).every((n) => Number.isFinite(n))) {
    return p.slice(0, 3).map((n) => Math.max(0, Math.min(255, n)));
  }

  console.warn('[lyric-share] unreadable surface colour, falling back to near-black:', str);
  return FALLBACK_FIELD;
}

/* Ink is decided by the field, not fixed. White on a pale field is the one way
   this card can come out unreadable, and pale fields are common — half the
   sleeves in a library are light. On those, the ink is the field's own colour
   run down to near-black, which keeps the card in one colour family instead of
   dropping a neutral grey into it. */
function inkFor(field) {
  const dark = lumOf(field) >= 150;
  const rgb = dark
    ? field.map((c) => Math.max(8, Math.round(c * 0.20)))
    : [255, 255, 255];
  const at = (a) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
  return { solid: at(1), dim: at(0.66), faint: at(0.48), hairline: at(0.22) };
}

export default function LyricShare({
  lines = [],
  track = null,
  coverUrl = null,
  surface = null,     // optional override: a manual pick from the colour tray
  startTime = null,   // seconds — the first selected line's stamp, if timed
  onClose,
  onNotify,           // (ok, message) → host toast
}) {
  const [busy, setBusy] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);
  const [fieldRgb, setFieldRgb] = useState(null);   // null = still resolving
  const [previewUrl, setPreviewUrl] = useState(null);
  const dialogRef = useRef(null);
  const coverImgRef = useRef(undefined);   // undefined = not loaded, null = failed

  const text = useMemo(
    () => lines.map((l) => String(l || '').trim()).filter(Boolean),
    [lines],
  );
  const title = (track?.title || '').trim() || 'Unknown track';
  const artist = (track?.artist || '').trim() || 'Unknown artist';

  const stamp = useMemo(() => {
    if (!Number.isFinite(startTime)) return null;
    const m = Math.floor(startTime / 60);
    const s = Math.floor(startTime % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }, [startTime]);

  /* Resolved once on mount. Falls back to the generic stack if the computed
     style is somehow empty (e.g. rendered outside the app shell). */
  const fontStack = useMemo(() => {
    if (typeof window === 'undefined') return 'system-ui, sans-serif';
    const s = window.getComputedStyle(document.body).fontFamily;
    return s && s.trim() ? s : 'system-ui, sans-serif';
  }, []);

  /* Canvas text does NOT wait for webfonts. Several presets load from Google
     or a CDN, and rasterising before they arrive silently draws in a fallback
     — worse, the fit solver measures that fallback, so the line breaks come
     out wrong too, with no error anywhere. Gate the first render on it. */
  useEffect(() => {
    let dead = false;
    const done = () => { if (!dead) setFontsReady(true); };
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(done).catch(done);
      const t = setTimeout(done, 2500);   // never block forever on a bad font
      return () => { dead = true; clearTimeout(t); };
    }
    done();
    return () => { dead = true; };
  }, []);

  /* The bar's colour, derived the bar's way.
     sampleCoverTheme() rather than a local 64x64 pass, because that function is
     the one the tuning lab is calibrated against — a second implementation of
     the same idea would agree with it right up until one of them was edited.
     A manual pick wins outright, exactly as it does for the bar. */
  useEffect(() => {
    let dead = false;
    if (surface) { setFieldRgb(parseRgb(surface)); return () => { dead = true; }; }
    (async () => {
      try {
        const theme = await sampleCoverTheme(coverUrl);
        if (dead) return;
        if (!theme || isFallbackTheme(theme)) { setFieldRgb(FALLBACK_FIELD); return; }
        setFieldRgb(parseRgb(pageWash(barTone(washSourceFor(theme)))));
      } catch (e) {
        console.warn('[lyric-share] could not sample the cover, using the neutral ground', e);
        if (!dead) setFieldRgb(FALLBACK_FIELD);
      }
    })();
    return () => { dead = true; };
  }, [surface, coverUrl]);

  useEffect(() => { dialogRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  /** See header note — bare <img>, crossOrigin set, never fetch→dataURL. */
  const loadCover = useCallback(() => new Promise((resolve) => {
    if (coverImgRef.current !== undefined) { resolve(coverImgRef.current); return; }
    if (!coverUrl) { coverImgRef.current = null; resolve(null); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { coverImgRef.current = img; resolve(img); };
    img.onerror = () => { coverImgRef.current = null; resolve(null); };
    img.src = coverUrl;
  }), [coverUrl]);

  /* ---------- Rasteriser ------------------------------------------------- */

  const rasterize = useCallback(async () => {
    const W = CARD_W;
    const cover = await loadCover();

    /* The app's own font, not a generic system stack — a card exported from
       studio should look like it came from studio. App.jsx applies the active
       preset to document.body, so reading the computed style picks up the
       user's choice without threading it through four components, and it
       follows automatically when they change it in Settings. */
    const font = (size, weight = 600) => `${weight} ${size}px ${fontStack}`;

    const PAD = Math.round(W * 0.078);
    const FOOT_ART = Math.round(W * 0.127);       // cover thumb in the footer
    const GAP = Math.round(W * 0.075);            // lyric block → footer
    const textW = W - PAD * 2;
    const LINE_RATIO = 1.30;

    /* ---- Pass 1: measure -------------------------------------------------
     * The canvas can't be sized until we know how tall the text is, and text
     * can't be measured without a context — so measurement runs on a scratch
     * canvas first, then the real one is created at the resolved height. */
    const scratch = document.createElement('canvas').getContext('2d');
    const wrapWith = (size) => {
      scratch.font = font(size, 800);
      const out = [];
      for (const para of text) {
        const words = para.split(/\s+/);
        let line = '';
        for (const w of words) {
          const attempt = line ? `${line} ${w}` : w;
          if (scratch.measureText(attempt).width <= textW || !line) line = attempt;
          else { out.push(line); line = w; }
        }
        out.push(line);
      }
      return out;
    };

    const chars = text.join(' ').length;
    let lyricSize = lyricSizeFor(chars);
    let wrapped = wrapWith(lyricSize);

    const chromeH = PAD + GAP + FOOT_ART + PAD;
    let H = Math.round(chromeH + wrapped.length * lyricSize * LINE_RATIO);

    /* Outside the bounds the height is pinned and the TYPE moves instead, in
       whichever direction is needed — one solver, both ways.

       It only shrank before, which left the floor doing something different in
       kind: a two-line quote hit MIN_H and the leftover room was simply dumped
       under the words as a band of empty colour. Growing the type to fill it is
       the same answer the ceiling already gives, pointed the other way, and it
       matches what a short quote wants to look like anyway. */
    if (H < MIN_H || H > MAX_H) {
      H = H < MIN_H ? MIN_H : MAX_H;
      const areaH = H - chromeH;
      /* Largest size whose wrapped block still fits the room. Wrapping makes
         this monotonic — bigger type only ever breaks into more lines — so a
         binary search is sound in both directions. */
      let lo = MIN_LYRIC;
      let hi = MAX_LYRIC;
      lyricSize = MIN_LYRIC;
      wrapped = wrapWith(MIN_LYRIC);
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const w2 = wrapWith(mid);
        if (w2.length * mid * LINE_RATIO <= areaH) { lyricSize = mid; wrapped = w2; lo = mid + 1; }
        else hi = mid - 1;
      }
    }

    /* ---- Pass 2: draw ---------------------------------------------------- */
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    const field = fieldRgb || FALLBACK_FIELD;
    const fieldCss = `rgb(${field[0]}, ${field[1]}, ${field[2]})`;
    const ink = inkFor(field);

    const roundRect = (x, y, w, h, r) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    };

    /* --- Ground: one flat colour from the artwork ------------------------- */
    ctx.fillStyle = fieldCss;
    ctx.fillRect(0, 0, W, H);

    /* --- Lyrics ----------------------------------------------------------- */
    /* Top-anchored, always. When the card is at its height floor the slack
       lands between the words and the footer, which is where a short quote
       wants it — centring it there instead pushes the type into the middle of
       an empty card and makes two lines look like a mistake. */
    ctx.textBaseline = 'alphabetic';
    ctx.font = font(lyricSize, 800);
    ctx.fillStyle = ink.solid;
    /* Any residual after the solver is split above and below rather than left
       under the words. It's usually a few pixels; it's only meaningful for a
       selection short enough to hit MAX_LYRIC and still not fill the card, and
       that one wants to sit centred rather than hang from the top edge. */
    const areaBottom = H - PAD - FOOT_ART - GAP;
    const blockH = wrapped.length * lyricSize * LINE_RATIO;
    const slack = Math.max(0, areaBottom - PAD - blockH);
    let y = Math.round(PAD + slack / 2 + lyricSize * 0.92);
    for (const line of wrapped) {
      ctx.fillText(line, PAD, y);
      y += lyricSize * LINE_RATIO;
    }

    /* --- Footer: artwork, meta, and where in the song this came from ------- */
    const footY = H - PAD - FOOT_ART;
    const radius = Math.round(FOOT_ART * 0.17);
    ctx.save();
    roundRect(PAD, footY, FOOT_ART, FOOT_ART, radius);
    ctx.clip();
    if (cover) {
      const s = Math.max(FOOT_ART / cover.naturalWidth, FOOT_ART / cover.naturalHeight);
      const dw = cover.naturalWidth * s;
      const dh = cover.naturalHeight * s;
      ctx.drawImage(cover, PAD + (FOOT_ART - dw) / 2, footY + (FOOT_ART - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = ink.hairline;
      ctx.fillRect(PAD, footY, FOOT_ART, FOOT_ART);
    }
    ctx.restore();
    /* Hairline in the ink colour, not white: the artwork and the field come
       from the same palette by construction, so a sleeve can sit on the card
       nearly invisibly without an edge to separate them. */
    ctx.save();
    roundRect(PAD + 0.5, footY + 0.5, FOOT_ART - 1, FOOT_ART - 1, radius);
    ctx.strokeStyle = ink.hairline;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    const metaSize = Math.round(W * 0.0400);
    const stampSize = Math.round(W * 0.0367);
    const tx = PAD + FOOT_ART + Math.round(W * 0.028);
    const mid = footY + FOOT_ART / 2;

    let stampW = 0;
    if (stamp) {
      ctx.font = font(stampSize, 600);
      stampW = ctx.measureText(stamp).width;
      ctx.fillStyle = ink.faint;
      ctx.fillText(stamp, W - PAD - stampW, mid + stampSize * 0.36);
      stampW += Math.round(W * 0.028);
    }

    const availW = W - PAD - tx - stampW;
    const ellipsize = (str, maxW, f) => {
      ctx.font = f;
      if (ctx.measureText(str).width <= maxW) return str;
      let s = str;
      while (s.length > 1 && ctx.measureText(`${s}\u2026`).width > maxW) s = s.slice(0, -1);
      return `${s}\u2026`;
    };

    ctx.fillStyle = ink.solid;
    ctx.font = font(metaSize, 700);
    ctx.fillText(ellipsize(title, availW, font(metaSize, 700)), tx, mid - metaSize * 0.16);
    ctx.fillStyle = ink.dim;
    ctx.font = font(metaSize, 500);
    ctx.fillText(ellipsize(artist, availW, font(metaSize, 500)), tx, mid + metaSize * 1.08);

    return canvas;
  }, [fieldRgb, text, title, artist, stamp, loadCover, fontStack]);

  /* ---------- Preview ---------------------------------------------------- */
  useEffect(() => {
    if (!fontsReady || !fieldRgb) return undefined;
    let dead = false;
    (async () => {
      try {
        const canvas = await rasterize();
        if (dead) return;
        canvas.toBlob((blob) => {
          if (dead || !blob) return;
          const url = URL.createObjectURL(blob);
          setPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
        }, 'image/png');
      } catch (e) {
        console.error('[lyric-share] preview failed', e);
      }
    })();
    return () => { dead = true; };
  }, [rasterize, fontsReady, fieldRgb]);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  /* ---------- Actions ---------------------------------------------------- */
  const withCanvas = useCallback(async (fn, failMsg) => {
    setBusy(true);
    try {
      const canvas = await rasterize();
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      // A tainted canvas resolves null rather than throwing — the silent
      // failure the whole <img crossOrigin> dance exists to prevent.
      if (!blob) throw new Error('Canvas produced no image (tainted?)');
      await fn(blob);
    } catch (e) {
      console.error('[lyric-share]', e);
      onNotify?.(false, failMsg);
    } finally {
      setBusy(false);
    }
  }, [rasterize, onNotify]);

  const copy = useCallback(() => withCanvas(async (blob) => {
    await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
    onNotify?.(true, 'Lyric card copied.');
    onClose?.();
  }, "Couldn't copy the lyric card."), [withCanvas, onNotify, onClose]);

  const save = useCallback(() => withCanvas(async (blob) => {
    const safe = `${artist} - ${title}`.replace(/[^\w\s-]/g, '').trim().slice(0, 60) || 'lyrics';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${safe}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    onNotify?.(true, 'Lyric card saved.');
    onClose?.();
  }, "Couldn't save the lyric card."), [withCanvas, onNotify, onClose, artist, title]);

  /* ---------- UI ---------------------------------------------------------
   * The card IS the interface. With nothing left to configure, the old 260px
   * control column would hold two buttons and a lot of air, so the actions sit
   * under the preview and the dialog is only as wide as the thing it shows. */
  /* The primary action wears the card's own colour, so the dialog previews the
     export twice — once at size, once as a swatch you're about to commit to. */
  const field = fieldRgb || FALLBACK_FIELD;
  const fieldCss = `rgb(${field[0]}, ${field[1]}, ${field[2]})`;
  const fieldInk = inkFor(field).solid;

  const btn = {
    padding: '11px 20px', borderRadius: 99, border: 0, cursor: 'pointer',
    fontSize: 13, fontWeight: 800, background: 'rgba(255,255,255,0.10)', color: '#fff',
  };

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      onClick={onClose}
      role="dialog"
      aria-label="Share lyrics"
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 20, padding: 34,
        background: 'rgba(4,4,6,0.86)',
        outline: 'none',
        animation: 'lyricShareIn 180ms ease-out',
      }}
    >
      <style>{`
        @keyframes lyricShareIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes lyricShareCard { from { opacity: 0; transform: translateY(12px) scale(0.98); } to { opacity: 1; transform: none; } }
      `}</style>

      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          minHeight: 0, display: 'flex', alignItems: 'center',
          animation: 'lyricShareCard 240ms cubic-bezier(0.22, 1, 0.3, 1) both',
        }}
      >
        {previewUrl ? (
          <img
            src={previewUrl}
            alt="Lyric card preview"
            style={{
              maxHeight: 'min(72vh, 860px)', maxWidth: 'min(90vw, 380px)',
              borderRadius: 20, display: 'block',
              boxShadow: '0 30px 90px rgba(0,0,0,0.6)',
            }}
          />
        ) : (
          <div style={{
            width: 320, height: 400, borderRadius: 20,
            background: 'rgba(255,255,255,0.05)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'rgba(255,255,255,0.4)', fontSize: 12,
          }}
          >
            {fontsReady ? 'Rendering…' : 'Loading font…'}
          </div>
        )}
      </div>

      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          display: 'flex', alignItems: 'center', gap: 9,
          animation: 'lyricShareCard 240ms cubic-bezier(0.22, 1, 0.3, 1) 40ms both',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          style={{ ...btn, background: 'transparent', color: 'rgba(255,255,255,0.6)' }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={copy}
          disabled={busy || !previewUrl}
          style={{ ...btn, opacity: busy ? 0.5 : 1 }}
        >
          Copy
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy || !previewUrl}
          style={{ ...btn, background: fieldCss, color: fieldInk, opacity: busy ? 0.5 : 1 }}
        >
          {busy ? 'Working…' : 'Save PNG'}
        </button>
      </div>
    </div>
  );
}
