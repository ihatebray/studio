import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { presetById, getStoredFontId, loadGoogleFontForPreset } from './uiFonts.js';
import { TOKENS_CSS } from './accentTokens.js';

/* =========================================================================
 *  studio — onboarding
 *
 *  A first-run flow: wordmark reveal → Spotify sign-in → backup search keys
 *  (optional) → Soulseek (optional) → ready. Each step is a glass card over
 *  four slow-drifting lights in the flow's colours;
 *  steps crossfade/slide with pure CSS keyframes (no animation library —
 *  fewer deps, and the motions are simple enough that CSS is the clearest
 *  way to express them).
 *
 *  The credential panels are exported (SpotifyCredsPanel, SoulseekCredsPanel)
 *  so the home screen's settings sheet reuses the exact same UI — one place
 *  to fix bugs, and the settings sheet always matches what onboarding taught.
 * ========================================================================= */

const api = () => (typeof window !== 'undefined' ? window.electronAPI : null);

/** Shared keyframes + utility classes for the whole studio chrome. */
export function StudioMotionStyles() {
  return (
    <style>{`
      @keyframes stFadeUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes stFadeIn { from { opacity: 0; } to { opacity: 1; } }
      @keyframes stLetter { from { opacity: 0; transform: translateY(0.4em) scale(0.86); filter: blur(7px); } to { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); } }
      @keyframes stLine { from { transform: scaleX(0); } to { transform: scaleX(1); } }
      @keyframes stStepOut { to { opacity: 0; transform: translateY(-18px); } }
      @keyframes stPulse { 0%,100% { opacity: 0.5; } 50% { opacity: 1; } }
      @keyframes stSpin { to { transform: rotate(360deg); } }

      /* Direction-aware step transitions: forward, the old step leaves left
         and the new one arrives from the right; back reverses it. Movement
         that matches the direction of travel makes a sequence feel like a
         sequence rather than a slideshow. */
      @keyframes stInFwd  { from { opacity: 0; transform: translateX(38px) scale(0.97); } to { opacity: 1; transform: translateX(0) scale(1); } }
      @keyframes stOutFwd { from { opacity: 1; transform: translateX(0) scale(1); } to { opacity: 0; transform: translateX(-32px) scale(0.97); } }
      @keyframes stInBack  { from { opacity: 0; transform: translateX(-38px) scale(0.97); } to { opacity: 1; transform: translateX(0) scale(1); } }
      @keyframes stOutBack { from { opacity: 1; transform: translateX(0) scale(1); } to { opacity: 0; transform: translateX(32px) scale(0.97); } }

      /* Overshoot, not ease. Things that spring past their mark and settle
         read as friendly; things that glide to a stop read as corporate. */
      @keyframes stPop { 0% { opacity: 0; transform: scale(0.5) rotate(-8deg); } 55% { opacity: 1; transform: scale(1.14) rotate(3deg); } 100% { opacity: 1; transform: scale(1) rotate(0); } }
      @keyframes stRise { from { opacity: 0; transform: translateY(16px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }
      @keyframes stCheckPop { 0% { transform: scale(0.3); opacity: 0; } 55% { transform: scale(1.22); opacity: 1; } 78% { transform: scale(0.94); } 100% { transform: scale(1); opacity: 1; } }
      @keyframes stDraw { to { stroke-dashoffset: 0; } }
      @keyframes stWiggle { 0%,100% { transform: rotate(0); } 25% { transform: rotate(-7deg); } 75% { transform: rotate(7deg); } }
      @keyframes stConfetti { 0% { opacity: 0; transform: translateY(0) scale(0.4); } 22% { opacity: 1; } 100% { opacity: 0; transform: translateY(-90px) scale(1) rotate(var(--r, 90deg)); } }

      /* Every control here inherits studio's UI font. Buttons and inputs do
         NOT inherit font-family from an ancestor on their own — the app
         patches that globally in uiFonts.js, but onboarding paints its own
         controls, so it has to say so too or they fall back to the system
         face while the headings use Volte Rounded. */
      .st-onb, .st-onb button, .st-onb input, .st-onb select, .st-onb textarea { font-family: inherit; }

      /* ── Base controls ─────────────────────────────────────────────────
         StudioHome renders <StudioMotionStyles/> too, so everything in this
         sheet is GLOBAL. The credential panels are shared between onboarding
         and Settings → Connections, which is how the onboarding gradient
         button turned up on "Save credentials" in settings. Base rules stay
         plain and theme-neutral; the onboarding look is scoped to .st-onb
         below and cannot escape it. */
      /* Base controls (.st-input, .st-btn, .st-link) now live in the shared
         token sheet — accentTokens.js — appended at the end of this sheet. */
      .st-link { color: rgba(255,255,255,0.65); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; background: none; border: none; font-size: 12px; padding: 0; }
      .st-link:hover { color: #fff; }

      /* ── Onboarding-only ──────────────────────────────────────────────── */
      /* Onboarding uses the shared controls unchanged: accent-filled primary
         when the fields validate, a genuinely dim state when they don't. The
         brown gradient that read as disabled is gone. */
      .st-onb .st-link { font-size: 13px; font-weight: 600; text-decoration: none; color: var(--text-dim, #A1A1AA); transition: color 0.15s ease; }
      .st-onb .st-link:hover { color: var(--text, #F4F4F5); }

      /* Four slow lights behind the flow. Blurred discs in the flow's four
         colours, screened onto near-black so they only ever add light. */
      @keyframes stDriftA { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(7vw, 5vh) scale(1.14); } }
      @keyframes stDriftB { 0%,100% { transform: translate(0,0) scale(1.06); } 50% { transform: translate(-6vw, 4vh) scale(0.94); } }
      @keyframes stDriftC { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(5vw, -6vh) scale(1.1); } }
      @keyframes stDriftD { 0%,100% { transform: translate(0,0) scale(0.95); } 50% { transform: translate(-4vw, -4vh) scale(1.08); } }
      .st-onb-aura { position: absolute; inset: 0; overflow: hidden; pointer-events: none; transition: opacity 0.8s ease; animation: stFadeIn 1.6s ease both; }
      .st-onb-aura.is-dim { opacity: 0.55; }
      .st-onb-aura i { position: absolute; width: 44vmax; height: 44vmax; border-radius: 50%; filter: blur(96px); mix-blend-mode: screen; }
      .st-onb-aura i:nth-child(1) { background: #ff9d6e; left: -14vmax; top: -18vmax; opacity: 0.34; animation: stDriftA 24s ease-in-out infinite; }
      .st-onb-aura i:nth-child(2) { background: #8f6bff; right: -16vmax; top: -6vmax; opacity: 0.3; animation: stDriftB 28s ease-in-out infinite; }
      .st-onb-aura i:nth-child(3) { background: #ff86b4; left: 18vw; bottom: -26vmax; opacity: 0.28; animation: stDriftC 32s ease-in-out infinite; }
      .st-onb-aura i:nth-child(4) { background: #4fd1ae; right: 4vw; bottom: -24vmax; opacity: 0.2; animation: stDriftD 36s ease-in-out infinite; }
      .st-onb-aura::after { content: ''; position: absolute; inset: 0; background: radial-gradient(ellipse 70% 60% at 50% 45%, transparent 30%, rgba(5,5,7,0.65) 100%); }

      .st-onb-wordmark { margin: 0; font-size: 84px; font-weight: 800; letter-spacing: -0.03em; line-height: 1; color: #fff; }

      .st-onb-feats { margin: 42px auto 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; text-align: left; }
      .st-onb-feat { position: relative; padding: 16px 15px 18px; border-radius: 16px; overflow: hidden;
        background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.09);
        backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
        transition: transform 0.28s cubic-bezier(0.34,1.4,0.5,1), border-color 0.2s ease, background 0.2s ease; }
      /* Each card carries a little of its own colour, and more on hover. */
      .st-onb-feat::before { content: ''; position: absolute; right: -50px; top: -60px; width: 150px; height: 150px; border-radius: 50%;
        background: var(--c2); filter: blur(46px); opacity: 0.16; transition: opacity 0.3s ease; pointer-events: none; }
      .st-onb-feat:hover { transform: translateY(-4px); background: rgba(255,255,255,0.06); border-color: color-mix(in oklab, var(--c2) 45%, transparent); }
      .st-onb-feat:hover::before { opacity: 0.4; }
      .st-onb-feat h3 { position: relative; margin: 14px 0 0; font-size: 12px; font-weight: 800; letter-spacing: 0.07em; text-transform: uppercase; color: #fff; }
      .st-onb-feat p { position: relative; margin: 5px 0 0; font-size: 12.5px; line-height: 1.55; color: rgba(255,255,255,0.58); }
      @media (max-width: 760px) { .st-onb-feats { grid-template-columns: repeat(2, minmax(0, 1fr)); } .st-onb-wordmark { font-size: 64px; } }

      /* The big button: peach into pink, lit from inside. */
      .st-onb-cta { height: 48px; padding: 0 34px; border-radius: 999px; border: none; cursor: pointer;
        font-size: 15px; font-weight: 800; letter-spacing: 0.005em; color: #2a130e;
        background: linear-gradient(135deg, #ffd3ad 0%, #ff9d6e 48%, #ff86b4 100%);
        box-shadow: 0 12px 34px rgba(255,130,120,0.38), inset 0 1px 0 rgba(255,255,255,0.5);
        transition: transform 0.22s cubic-bezier(0.34,1.6,0.5,1), box-shadow 0.22s ease, filter 0.2s ease; }
      .st-onb-cta:hover { transform: translateY(-2px) scale(1.03); filter: brightness(1.05); box-shadow: 0 16px 44px rgba(255,130,120,0.5), inset 0 1px 0 rgba(255,255,255,0.55); }
      .st-onb-cta:active { transform: translateY(0) scale(0.99); }

      /* Setup steps: the same peach-to-pink on the primary buttons, only in
         here. Settings reuses these panels and keeps the accent. */
      .st-onb .st-btn-primary:not(:disabled) { background: linear-gradient(135deg, #ffd3ad 0%, #ff9d6e 48%, #ff86b4 100%); color: #2a130e;
        box-shadow: 0 8px 22px rgba(255,130,120,0.28), inset 0 1px 0 rgba(255,255,255,0.45); }
      .st-onb .st-btn-primary:not(:disabled):hover { filter: brightness(1.06); }
      .st-onb .st-btn-primary.st-onb-spotify:not(:disabled) { background: linear-gradient(135deg, #5cf08f, #1ed760); color: #062a14;
        box-shadow: 0 8px 24px rgba(30,215,96,0.3), inset 0 1px 0 rgba(255,255,255,0.45); height: 46px; font-size: 14.5px; gap: 10px; }

      .st-onb-stepcard { position: relative; padding: 28px 30px; border-radius: 18px; overflow: hidden;
        background: linear-gradient(rgba(12,12,15,0.84), rgba(12,12,15,0.84)) padding-box,
                    linear-gradient(135deg, color-mix(in oklab, var(--c2) 55%, transparent), rgba(255,255,255,0.08) 45%, rgba(255,134,180,0.3)) border-box;
        border: 1px solid transparent; backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
        box-shadow: 0 30px 80px rgba(0,0,0,0.45); }
      .st-onb-stepcard::before { content: ''; position: absolute; left: -60px; top: -80px; width: 220px; height: 220px; border-radius: 50%;
        background: var(--c2); filter: blur(70px); opacity: 0.16; pointer-events: none; }
      .st-onb-stepcard > * { position: relative; }

      .st-onb-signed { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 12px;
        background: rgba(30,215,96,0.08); border: 1px solid rgba(30,215,96,0.25); animation: stRise 0.4s cubic-bezier(0.34,1.4,0.5,1) both; }
      .st-onb-signed-ic { width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
        background: linear-gradient(135deg, #5cf08f, #1ed760); color: #062a14; animation: stCheckPop 0.5s cubic-bezier(0.34,1.6,0.5,1) both; }
      .st-onb-signed-name { font-size: 14px; font-weight: 800; color: #fff; }
      .st-onb-signed-sub { font-size: 12px; color: rgba(255,255,255,0.58); margin-top: 1px; }
      .st-onb-note { margin-top: 12px; padding: 10px 12px; border-radius: 10px; font-size: 12px; line-height: 1.6;
        background: rgba(255,200,120,0.08); border: 1px solid rgba(255,200,120,0.2); color: rgba(255,225,190,0.85); }

      .st-onb-tips { margin: 28px auto 0; max-width: 430px; display: grid; gap: 8px; text-align: left; }
      .st-onb-tip { display: flex; align-items: center; gap: 11px; padding: 10px 14px; border-radius: 12px; font-size: 12.5px; line-height: 1.5;
        color: rgba(255,255,255,0.62); background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); }
      .st-onb-tip i { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
      .st-onb-tip strong { color: #fff; font-weight: 800; }

      .st-back {
        display: inline-flex; align-items: center; gap: 5px; padding: 5px 11px 5px 8px;
        background: rgba(255,255,255,0.06); border: none; border-radius: 8px; cursor: pointer;
        font-size: 11.5px; font-weight: 700; color: rgba(255,255,255,0.55);
        transition: color 0.15s ease, background 0.15s ease, transform 0.2s cubic-bezier(0.34,1.7,0.5,1);
      }
      .st-back:hover { color: #fff; background: rgba(255,255,255,0.12); transform: translateX(-2px); }

      /* Chunky pill segments rather than dots — a dot says which of two, a
         filling pill says how far through and that there is an end. */
      .st-prog-seg { height: 4px; border-radius: 2px; background: rgba(255,255,255,0.13); overflow: hidden; transition: width 0.45s cubic-bezier(0.34,1.5,0.5,1); }
      .st-prog-seg > i { display: block; height: 100%; border-radius: 2px; background: linear-gradient(90deg, #ffcfa8, #ff86b4); transform-origin: left center; transition: transform 0.5s cubic-bezier(0.34,1.5,0.5,1); }

      @media (prefers-reduced-motion: reduce) {
        .st-onb *, .st-step, .st-step * { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; }
        .st-onb-aura i { animation: none !important; }
        .st-btn:hover, .st-back:hover, .st-input:focus { transform: none; }
      }
    ${TOKENS_CSS}`}</style>
  );
}

/** A big rounded colour tile with a glyph in it — the friendly bit. */
function IconTile({ from, to, delay = 0, children, size = 52, glow = null }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: size > 42 ? 13 : 11, flexShrink: 0,
      background: to ? `linear-gradient(135deg, ${from}, ${to})` : from,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: '#16121a',
      boxShadow: glow ? `0 8px 24px ${glow}55, inset 0 1px 0 rgba(255,255,255,0.45)` : 'none',
      animation: `stPop 0.6s cubic-bezier(0.34, 1.56, 0.5, 1) ${delay}s both`,
    }}>
      {children}
    </div>
  );
}

/** Tiny inline spinner used by save/test buttons. */
function Spinner() {
  return (
    <span aria-hidden style={{
      display: 'inline-block', width: 12, height: 12, marginRight: 8, verticalAlign: -1,
      border: '2px solid rgba(0,0,0,0.25)', borderTopColor: 'currentColor',
      borderRadius: '50%', animation: 'stSpin 0.7s linear infinite',
    }} />
  );
}

/** Success check — gradient ring, tick drawn on rather than just faded in. */
function CheckGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function CheckMark({ size = 44 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', margin: '0 auto',
      background: 'linear-gradient(135deg, #a8f0dc, #5fd3b4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: '0 12px 32px rgba(95,211,180,0.4)',
      animation: 'stCheckPop 0.6s cubic-bezier(0.34, 1.6, 0.5, 1) both',
    }}>
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none" stroke="#123a30"
        strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
        {/* Dash length covers the path so it can be drawn in rather than
            appearing all at once with the circle. */}
        <polyline points="20 6 9 17 4 12" strokeDasharray="30" strokeDashoffset="30"
          style={{ animation: 'stDraw 0.4s cubic-bezier(0.6, 0, 0.4, 1) 0.32s both' }} />
      </svg>
    </div>
  );
}

/**
 * HowTo — a collapsible "where do I find this?" disclosure.
 *
 * These panels appear in two places: full size during onboarding, and
 * `compact` inside Settings. The steps used to render only in the full
 * version, so anyone who skipped setup and came back later — the people
 * most likely to need them — got two unlabelled inputs and no way to find
 * out what to type. Now both get the instructions; compact just folds them
 * away by default so the settings row stays short.
 */
function HowTo({ children, label = 'Where do I find these?', open: openDefault = false, hint = null }) {
  const [open, setOpen] = useState(openDefault);
  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, padding: 0,
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'rgba(255,255,255,0.78)', fontSize: 12.5, fontWeight: 700, width: '100%',
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.18s ease' }}>
          <path d="M9 6l6 6-6 6" />
        </svg>
        {label}
        {hint ? <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 500, color: 'var(--text-faint, #6F6F78)' }}>{hint}</span> : null}
      </button>
      {/* Grid-rows so it animates to whatever height the copy actually is. */}
      <div style={{
        display: 'grid', gridTemplateRows: open ? '1fr' : '0fr',
        opacity: open ? 1 : 0,
        transition: 'grid-template-rows 0.26s cubic-bezier(0.22,1,0.36,1), opacity 0.18s ease',
      }}>
        <div style={{ overflow: 'hidden' }}>
          <div style={{ paddingTop: 10 }}>{children}</div>
        </div>
      </div>
    </div>
  );
}

/** Numbered steps, styled once so every panel's instructions match. */
function Steps({ children }) {
  return (
    <ol style={{
      margin: 0, paddingLeft: 18, color: 'rgba(255,255,255,0.6)',
      fontSize: 12.5, lineHeight: 1.85,
      // Instructions you may want to copy out of. See Lit above.
      userSelect: 'text', WebkitUserSelect: 'text',
    }}>
      {children}
    </ol>
  );
}

/**
 * An inline value the user has to reproduce exactly.
 *
 * index.html sets `user-select: none` on <body> for the whole app, which is
 * right for a music player and wrong here: the redirect URI has to be typed
 * into Spotify character-for-character, and it could not even be selected.
 * These are selectable AND click-to-copy, because retyping
 * `http://127.0.0.1:8888/callback` by hand is exactly how setup fails.
 */
function Lit({ children }) {
  const [copied, setCopied] = useState(false);
  const text = String(children);
  const copy = () => {
    try {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* selection still works as a fallback */ }
  };
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={copy}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copy(); } }}
      title={copied ? 'Copied' : 'Click to copy'}
      style={{
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11.5, color: copied ? '#a8f0dc' : 'rgba(255,255,255,0.85)',
        background: copied ? 'rgba(168,240,220,0.14)' : 'rgba(255,255,255,0.08)',
        borderRadius: 5, padding: '1px 5px', cursor: 'pointer',
        userSelect: 'text', WebkitUserSelect: 'text',
        transition: 'background 0.15s ease, color 0.15s ease',
      }}
    >{children}</span>
  );
}

/** Opens a URL in the real browser and reads as a link. */
function ExtLink({ href, children }) {
  return (
    <button type="button" className="st-link" onClick={() => api()?.openExternal?.(href)}>
      {children}
    </button>
  );
}

/* =========================================================================
 *  Credential panels (shared with the home settings sheet)
 * ========================================================================= */

/**
 * Spotify app credentials. Saving calls spotify:setCreds and reports back
 * via onSaved so the host can refresh anything keyed on creds state.
 */
export function SpotifyCredsPanel({ onSaved, onStatus, compact = false, onValidChange }) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { ok, text }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const st = await api()?.spotifyGetCredsState?.();
        if (!cancelled) { setConfigured(!!st?.configured); onStatus?.(!!st?.configured); }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const save = useCallback(async () => {
    const id = clientId.trim(); const secret = clientSecret.trim();
    if (!id || !secret || busy) return;
    setBusy(true); setMsg(null);
    try {
      const res = await api()?.spotifySetCredentials?.({ clientId: id, clientSecret: secret });
      if (res?.ok) {
        setConfigured(true);
        onStatus?.(true);
        setMsg({ ok: true, text: 'Saved. Studio falls back to these when your sign-in can’t answer.' });
        onSaved?.();
      } else {
        setMsg({ ok: false, text: res?.error || 'Couldn’t save credentials.' });
      }
    } catch (e) {
      setMsg({ ok: false, text: String(e?.message || e) });
    }
    setBusy(false);
  }, [clientId, clientSecret, busy, onSaved]);

  return (
    <div>
      {/* Open during onboarding, folded in settings — but present in both. */}
      <HowTo open={false} label={compact ? 'Where do I find these?' : 'How do I get a client ID and secret?'} hint={compact ? null : '6 steps, about a minute'}>
        <Steps>
          <li>
            Open the <ExtLink href="https://developer.spotify.com/dashboard">Spotify Developer Dashboard</ExtLink>
            {' '}and log in with your Spotify account. The first time, accept the developer terms (and confirm your email if it asks).
          </li>
          <li>Click <Lit>Create app</Lit>. The name and description can be anything; only you see them.</li>
          <li>Under Redirect URIs enter <Lit>http://127.0.0.1:8888/callback</Lit> and click Add. Spotify requires one even though Studio never uses it. It must be <Lit>127.0.0.1</Lit>; Spotify no longer accepts <Lit>localhost</Lit>.</li>
          <li>Under “Which API/SDKs are you planning to use?” tick <Lit>Web API</Lit>, agree to the terms, and click Save.</li>
          <li>On the app’s page, open <Lit>Settings</Lit>. Copy the <strong>Client ID</strong> shown under Basic Information.</li>
          <li>Click <Lit>View client secret</Lit> just below it and copy that too. Paste both here.</li>
        </Steps>
        <div style={{ marginTop: 10, fontSize: 11.5, color: 'rgba(255,255,255,0.45)', lineHeight: 1.6 }}>
          Lost them? They stay on that app’s Settings page, so you can copy them again any time (or reset the secret there).
          They’re stored on this machine only, and Studio uses them as a backup for search and song details when your Spotify sign-in can’t answer.
        </div>
      </HowTo>
      {configured && !msg && !compact ? (
        <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--success, #7BE0B0)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <CheckGlyph /> Credentials already saved. Saving again replaces them.
        </div>
      ) : null}
      <div className="st-fields" style={{ maxWidth: compact ? 420 : 'none' }}>
        <label className="st-field">
          <span className="st-field-lbl">Client ID</span>
          <input className="st-input" placeholder="Paste your client ID" value={clientId}
            onChange={(e) => { setClientId(e.target.value); onValidChange?.(!!e.target.value.trim() && !!clientSecret.trim()); }} spellCheck={false} />
        </label>
        <label className="st-field">
          <span className="st-field-lbl">Client secret</span>
          <input className="st-input" placeholder="Paste your client secret" type="password" value={clientSecret}
            onChange={(e) => { setClientSecret(e.target.value); onValidChange?.(!!clientId.trim() && !!e.target.value.trim()); }} spellCheck={false} />
        </label>
      </div>
      {msg ? (
        <div role="status" style={{ marginTop: 10, fontSize: 12, color: msg.ok ? 'var(--success, #7BE0B0)' : 'var(--danger, #FF8B8B)' }}>{msg.text}</div>
      ) : null}
      <div style={{ marginTop: 16 }}>
        <button type="button" className={`st-btn st-btn-primary${compact ? '' : ' st-btn-block'}`} disabled={!clientId.trim() || !clientSecret.trim() || busy} onClick={save}>
          {busy ? <Spinner /> : null}
          {compact ? 'Save credentials' : 'Save and continue'}
        </button>
      </div>
    </div>
  );
}

/**
 * Soulseek login. Optional — saving stores creds; "Test connection" does a
 * real login round-trip so the user knows it works before they need it.
 */
export function SoulseekCredsPanel({ compact = false, onStatus, onSaved }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const st = await api()?.soulseekGetCredsState?.();
        if (!cancelled) { setConfigured(!!st?.configured); onStatus?.(!!st?.configured); }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const save = useCallback(async () => {
    const u = username.trim();
    if (!u || !password || busy) return;
    setBusy(true); setMsg(null);
    try {
      const res = await api()?.soulseekSetCredentials?.({ username: u, password });
      if (res?.ok === false) setMsg({ ok: false, text: res.error || 'Couldn’t save.' });
      else { setConfigured(true); onStatus?.(true); onSaved?.(); setMsg({ ok: true, text: 'Saved.' }); }
    } catch (e) {
      setMsg({ ok: false, text: String(e?.message || e) });
    }
    setBusy(false);
  }, [username, password, busy]);

  const test = useCallback(async () => {
    if (testing) return;
    setTesting(true); setMsg(null);
    try {
      const res = await api()?.soulseekTest?.();
      if (res?.ok) setMsg({ ok: true, text: 'Connected — Soulseek is ready.' });
      else setMsg({ ok: false, text: res?.error || 'Connection failed — check the login.' });
    } catch (e) {
      setMsg({ ok: false, text: String(e?.message || e) });
    }
    setTesting(false);
  }, [testing]);

  return (
    <div>
      <HowTo open={false} label={compact ? 'Where do I find these?' : 'What username should I use?'}>
        <Steps>
          <li>Soulseek has no signup page. Pick any username and password here and the account is created the first time you log in.</li>
          <li>If the name is already taken the login fails — try another. <Lit>Test connection</Lit> below tells you either way.</li>
          <li>Nothing is shared from your machine unless you set up sharing in the official Soulseek client.</li>
        </Steps>
        <div style={{ marginTop: 10, fontSize: 11.5, color: 'rgba(255,255,255,0.4)', lineHeight: 1.6 }}>
          Optional. It is a second download source alongside YouTube, usually higher quality.
        </div>
      </HowTo>
      {configured && !msg && !compact ? (
        <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--success, #7BE0B0)', display: 'flex', alignItems: 'center', gap: 6 }}><CheckGlyph /> Login already saved.</div>
      ) : null}
      <div className="st-fields" style={{ maxWidth: compact ? 420 : 'none' }}>
        <label className="st-field">
          <span className="st-field-lbl">Username</span>
          <input className="st-input" placeholder="Your Soulseek username" value={username} onChange={(e) => setUsername(e.target.value)} spellCheck={false} />
        </label>
        <label className="st-field">
          <span className="st-field-lbl">Password</span>
          <input className="st-input" placeholder="Your Soulseek password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} spellCheck={false} />
        </label>
      </div>
      {msg ? (
        <div role="status" style={{ marginTop: 10, fontSize: 12, color: msg.ok ? 'var(--success, #7BE0B0)' : 'var(--danger, #FF8B8B)' }}>{msg.text}</div>
      ) : null}
      <div style={{ marginTop: 16, display: 'flex', gap: 10 }}>
        <button type="button" className="st-btn st-btn-primary" disabled={!username.trim() || !password || busy} onClick={save}>
          {busy ? <Spinner /> : null}
          Save login
        </button>
        <button type="button" className="st-btn st-btn-outline" disabled={testing || (!configured && (!username.trim() || !password))} onClick={test}>
          {testing ? <Spinner /> : null}
          Test connection
        </button>
      </div>
    </div>
  );
}

/* =========================================================================
 *  Spotify sign-in (onboarding)
 * ========================================================================= */

/**
 * The Spotify account: what plays Spotify songs in Studio (Premium), and
 * what My Spotify, artist pages and search run on. Settings → Connections
 * has the full version (test connection, playback check); this is the
 * first-run version of the same sign-in.
 */
function SpotifySignInPanel({ onSignedIn }) {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [helper, setHelper] = useState(null);   // { installed } from the playback helper
  const signedInRef = useRef(false);

  useEffect(() => {
    const a = api();
    if (!a?.spotifyPartnerState) return undefined;
    a.spotifyPartnerState().then((s) => setSt(s || { connected: false })).catch(() => setSt({ connected: false }));
    a.spotifyPlayerState?.().then(setHelper).catch(() => {});
    const off = a.onSpotifyPartnerChanged?.((next) => {
      setBusy(false);
      setSt(next);
      setErr(next?.error ? String(next.error) : '');
    });
    return () => off?.();
  }, []);

  useEffect(() => {
    if (st?.connected && !signedInRef.current) { signedInRef.current = true; onSignedIn?.(st); }
  }, [st, onSignedIn]);

  const signIn = async () => {
    const a = api();
    if (!a?.spotifyPartnerSignIn) return;
    setErr(''); setBusy(true);
    const r = await a.spotifyPartnerSignIn().catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (!r?.ok) { setBusy(false); setErr(r?.error || 'Couldn’t start sign-in.'); }
  };

  const premium = /premium/i.test(String(st?.product || ''));
  return (
    <div>
      <HowTo label="What does signing in do?" hint="on Spotify’s own login page">
        <Steps>
          <li>Your browser opens Spotify’s own login page. Studio never sees your password.</li>
          <li>With <Lit>Premium</Lit>, Spotify songs play right inside Studio, with nothing to download. Save adds one to your library whenever you like.</li>
          <li>On any account, you get My Spotify (Home and New Releases), full artist pages and search.</li>
          <li>It uses the same private interface as Spotify’s web player. That’s unofficial, so Spotify can change it without notice.</li>
        </Steps>
      </HowTo>

      {st?.connected ? (
        <div className="st-onb-signed">
          <span className="st-onb-signed-ic"><CheckGlyph /></span>
          <div style={{ minWidth: 0 }}>
            <div className="st-onb-signed-name">{st.displayName || 'Signed in'}</div>
            <div className="st-onb-signed-sub">
              {st.product ? `${st.product.charAt(0).toUpperCase()}${st.product.slice(1)} account` : 'Spotify account'}
              {st.product && !premium ? ' · songs play once you’re on Premium; everything else works now' : ''}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button type="button" className="st-btn st-btn-primary st-btn-block st-onb-spotify" onClick={signIn} disabled={busy || !api()?.spotifyPartnerSignIn}>
            {busy ? <Spinner /> : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.6 14.4a.62.62 0 0 1-.86.2c-2.35-1.44-5.3-1.76-8.79-.96a.62.62 0 1 1-.28-1.22c3.81-.87 7.09-.5 9.72 1.12.3.18.39.57.2.86zm1.22-2.73a.78.78 0 0 1-1.07.26c-2.69-1.65-6.8-2.13-9.98-1.17a.78.78 0 0 1-.45-1.5c3.64-1.1 8.16-.57 11.25 1.33.37.22.48.7.25 1.08zm.1-2.84C14.7 8.92 9.4 8.74 6.34 9.67a.94.94 0 1 1-.54-1.8c3.51-1.07 9.35-.86 13.04 1.33a.94.94 0 0 1-.96 1.62z" /></svg>
            )}
            {busy ? 'Waiting for your browser…' : 'Sign in with Spotify'}
          </button>
          {busy ? <div style={{ width: '100%', textAlign: 'center', fontSize: 12, color: 'var(--text-faint, #6F6F78)' }}>Finish in the browser tab that opened, then come back here.</div> : null}
        </div>
      )}
      {err ? <div role="status" style={{ marginTop: 10, fontSize: 12, color: 'var(--danger, #FF8B8B)' }}>{err}</div> : null}
      {helper && helper.installed === false ? (
        <div className="st-onb-note">
          Playback helper not built yet. In the Studio folder, run <Lit>npm run setup:spotify</Lit>, then restart Studio.
          Everything else works without it.
        </div>
      ) : null}
    </div>
  );
}

/* =========================================================================
 *  The onboarding flow itself
 * ========================================================================= */

/* The steps that ask for something. `welcome` and `ready` are moments, not
   steps, so they're outside this list: a progress rail that counts the
   splash screen as progress lies about how much is left. */
const SETUP_STEPS = [
  { id: 'account', label: 'Spotify' },
  { id: 'keys', label: 'Backup search' },
  { id: 'soulseek', label: 'Soulseek' },
];
const STEPS = ['welcome', 'account', 'keys', 'soulseek', 'ready'];

/* One colour per letter of "studio": white → peach → pink. Plain `color`, so
   it survives the per-letter blur/scale animation. */
const WORDMARK_RAMP = ['#ffffff', '#fff1e2', '#ffd9bd', '#ffc0ae', '#ffa8b8', '#ff9ec4'];

/* The four colours the flow is built from, one per idea. */
const HUES = {
  peach: ['#ffcfa8', '#ff9d6e'],
  violet: ['#c8b4ff', '#8f6bff'],
  mint: ['#a8f0dc', '#4fd1ae'],
  pink: ['#ffc4d8', '#ff86b4'],
  green: ['#8ff0b5', '#1ed760'],
};

export default function StudioOnboarding({ onComplete, onSpotifyCredsSaved }) {
  const [step, setStep] = useState('welcome');
  const [dir, setDir] = useState('fwd');
  const [leaving, setLeaving] = useState(null);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const go = useCallback((next, direction = 'fwd') => {
    clearTimeout(timerRef.current);
    setLeaving(direction);
    timerRef.current = setTimeout(() => {
      setStep(next);
      setDir(direction);
      setLeaving(null);
    }, 220);
  }, []);

  const idx = STEPS.indexOf(step);
  const back = useCallback(() => { if (idx > 0) go(STEPS[idx - 1], 'back'); }, [idx, go]);

  /* Esc leaves setup from any step but the last. The primary action stays a
     real button: binding Enter globally would fire it mid-way through
     typing a secret. */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && step !== 'ready') onComplete?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, onComplete]);

  /* Onboarding runs BEFORE the rest of the app mounts, so it can't assume
     App's font effect has fired yet. Ask for the stored preset ourselves and
     set the stack on this subtree (controls are covered by the .st-onb rule
     in StudioMotionStyles). */
  const fontStack = useMemo(() => {
    const preset = presetById(getStoredFontId());
    try { loadGoogleFontForPreset(preset); } catch { /* offline: the stack falls back */ }
    return preset.stack;
  }, []);

  const anim = leaving
    ? (leaving === 'fwd' ? 'stOutFwd 0.22s ease both' : 'stOutBack 0.22s ease both')
    : (dir === 'fwd'
      ? 'stInFwd 0.46s cubic-bezier(0.34, 1.4, 0.5, 1) both'
      : 'stInBack 0.46s cubic-bezier(0.34, 1.4, 0.5, 1) both');

  const stepN = SETUP_STEPS.findIndex((x) => x.id === step);

  return (
    <div className="st-onb" style={{
      position: 'fixed', inset: 0, zIndex: 100,
      fontFamily: fontStack,
      background: '#050507',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <StudioMotionStyles />

      {/* Colour: four slow lights drifting behind everything, brighter on
          the welcome and the finish, quieter while you're filling things in. */}
      <div className={`st-onb-aura${step === 'welcome' || step === 'ready' ? '' : ' is-dim'}`} aria-hidden>
        <i /><i /><i /><i />
      </div>

      <div style={{
        position: 'relative', flex: 1, minHeight: 0, display: 'flex',
        /* `safe`: a step taller than the window scrolls from its top rather
           than being centred with its first lines cut off. */
        alignItems: 'safe center', justifyContent: 'center',
        padding: '30px 28px 24px', overflowY: 'auto',
      }}>
      <div
        key={step}
        className="st-step"
        style={{
          position: 'relative', width: step === 'welcome' ? 'min(760px, calc(100vw - 56px))' : 'min(600px, calc(100vw - 56px))',
          animation: anim,
        }}
      >
        {step === 'welcome' ? (
          <div style={{ textAlign: 'center' }}>
            <h1 aria-label="studio" className="st-onb-wordmark">
              {'studio'.split('').map((ch, i) => (
                <span key={i} aria-hidden style={{
                  display: 'inline-block',
                  color: WORDMARK_RAMP[i],
                  textShadow: `0 0 34px ${WORDMARK_RAMP[i]}55, 0 6px 24px rgba(255, 140, 150, 0.22)`,
                  animation: `stLetter 0.72s cubic-bezier(0.34, 1.5, 0.5, 1) ${0.12 + i * 0.06}s both`,
                }}>{ch}</span>
              ))}
            </h1>

            <p style={{
              margin: '20px 0 0', fontSize: 16.5, fontWeight: 650, color: 'rgba(255,255,255,0.72)',
              animation: 'stFadeIn 0.8s ease 0.72s both',
            }}>
              A music library that actually feels like yours.
            </p>

            <div className="st-onb-feats">
              {[
                { hue: HUES.peach, delay: 0.9, title: 'Find it', body: 'Search millions of tracks and play them straight away.',
                  icon: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" /></> },
                { hue: HUES.violet, delay: 1.0, title: 'Own it', body: 'Save real files to your disk. No subscription, no rug pull.',
                  icon: <path d="M4 7v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7L9 5H6a2 2 0 0 0-2 2z" /> },
                { hue: HUES.mint, delay: 1.1, title: 'Live in it', body: 'Artwork, lyrics, credits and colour, all at your fingertips.',
                  icon: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.4" /></> },
                { hue: HUES.pink, delay: 1.2, title: 'Keep up', body: 'Follow artists and catch everything new they release.',
                  icon: <path d="M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.75L12 16.9l-5.2 2.7 1-5.75-4.2-4.1 5.8-.85z" /> },
              ].map((f) => (
                <div key={f.title} className="st-onb-feat"
                  style={{ '--c1': f.hue[0], '--c2': f.hue[1], animation: `stRise 0.6s cubic-bezier(0.34,1.4,0.5,1) ${f.delay}s both` }}>
                  <IconTile from={f.hue[0]} to={f.hue[1]} delay={f.delay + 0.1} size={38} glow={f.hue[1]}>
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      {f.icon}
                    </svg>
                  </IconTile>
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 38, animation: 'stRise 0.6s cubic-bezier(0.34,1.4,0.5,1) 1.34s both' }}>
              <button type="button" className="st-onb-cta" onClick={() => go('account')}>
                Let&rsquo;s go
              </button>
              <div style={{ marginTop: 16 }}>
                <button type="button" className="st-link" onClick={onComplete}>Skip — take me straight in</button>
              </div>
            </div>
          </div>
        ) : null}

        {step === 'account' ? (
          <StepCard
            progress={{ i: stepN, n: SETUP_STEPS.length, label: 'Spotify' }}
            title="Sign in to Spotify"
            subtitle="This is what plays Spotify songs in Studio and fills My Spotify, artist pages and search. Songs play with Premium; everything else works on any account."
            onBack={back}
            hue={HUES.green}
            icon={<><path d="M8 11.5c2.7-.8 6-.5 8.4 1" /><path d="M7.4 8.6c3.3-1 7.6-.7 10.6 1.1" /><path d="M8.6 14.3c2-.5 4.3-.3 6.2.8" /><circle cx="12" cy="12" r="9" /></>}
          >
            <SpotifySignInPanel onSignedIn={() => { timerRef.current = setTimeout(() => go('keys'), 1100); }} />
            <SkipRow onSkip={() => go('keys')} label="Skip for now — I'll sign in later" />
          </StepCard>
        ) : null}

        {step === 'keys' ? (
          <StepCard
            progress={{ i: stepN, n: SETUP_STEPS.length, label: 'Backup search' }}
            title="Add backup search keys"
            subtitle="Optional. A free Spotify developer app gives Studio a second way to search and fill in song details when your sign-in is busy or rate-limited. About a minute."
            onBack={back}
            hue={HUES.violet}
            icon={<><circle cx="8" cy="15" r="4" /><path d="M10.8 12.2 20 3M17 6l3 3M15 8l2 2" /></>}
          >
            <SpotifyCredsPanel onSaved={() => { onSpotifyCredsSaved?.(); timerRef.current = setTimeout(() => go('soulseek'), 700); }} />
            <SkipRow onSkip={() => go('soulseek')} label="Skip — sign-in covers it" />
          </StepCard>
        ) : null}

        {step === 'soulseek' ? (
          <StepCard
            progress={{ i: stepN, n: SETUP_STEPS.length, label: 'Soulseek' }}
            title="Add a second source"
            subtitle="Soulseek finds the rare stuff, usually in better quality. Totally optional; skip it and nothing breaks."
            onBack={back}
            hue={HUES.peach}
            icon={<><path d="M12 3v12" /><path d="M8 11l4 4 4-4" /><path d="M4 19h16" /></>}
          >
            <SoulseekCredsPanel />
            <SkipRow onSkip={() => go('ready')} label="Continue" primary />
          </StepCard>
        ) : null}

        {step === 'ready' ? (
          <div style={{ textAlign: 'center', position: 'relative' }}>
            <Confetti />
            <CheckMark size={68} />
            <h2 style={{
              margin: '26px 0 10px', fontSize: 34, fontWeight: 800, letterSpacing: '-0.025em',
              background: 'linear-gradient(90deg, #fff 0%, #ffd9bd 45%, #ff9ec4 100%)',
              WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
              animation: 'stRise 0.55s cubic-bezier(0.34,1.4,0.5,1) 0.2s both',
            }}>
              You&rsquo;re all set
            </h2>
            <p style={{
              margin: 0, fontSize: 14.5, fontWeight: 600, color: 'rgba(255,255,255,0.66)',
              animation: 'stRise 0.55s cubic-bezier(0.34,1.4,0.5,1) 0.32s both',
            }}>
              Search for something you love and hit play.
            </p>

            <div className="st-onb-tips" style={{ animation: 'stRise 0.55s cubic-bezier(0.34,1.4,0.5,1) 0.44s both' }}>
              {[
                [HUES.peach, <><strong>/</strong> opens search from anywhere.</>],
                [HUES.violet, <><strong>My Spotify → Home</strong> fills in as you listen, with new mixes every day.</>],
                [HUES.pink, <><strong>Follow</strong> an artist from their page, and their releases show in New Releases.</>],
                [HUES.mint, <>Anything you skipped is in <strong>Settings → Connections</strong>.</>],
              ].map(([hue, text], i) => (
                <div key={i} className="st-onb-tip"><i style={{ background: `linear-gradient(135deg, ${hue[0]}, ${hue[1]})` }} /><span>{text}</span></div>
              ))}
            </div>

            <div style={{ marginTop: 32, animation: 'stRise 0.6s cubic-bezier(0.34,1.4,0.5,1) 0.58s both' }}>
              <button type="button" className="st-onb-cta" onClick={onComplete}>Open studio</button>
            </div>
          </div>
        ) : null}
      </div>
      </div>
    </div>
  );
}

/** A short burst on the final screen. Decorative, so it never blocks a click. */
function Confetti() {
  const bits = [
    { x: -130, c: '#ffcfa8', r: '120deg', d: 0.06 }, { x: -96, c: '#ff86b4', r: '-90deg', d: 0.16 },
    { x: -58, c: '#8f6bff', r: '150deg', d: 0.02 }, { x: -20, c: '#4fd1ae', r: '-40deg', d: 0.12 },
    { x: 22, c: '#ffcfa8', r: '60deg', d: 0.22 }, { x: 58, c: '#4fd1ae', r: '-140deg', d: 0.2 },
    { x: 94, c: '#c8b4ff', r: '80deg', d: 0.1 }, { x: 130, c: '#ff9d6e', r: '-70deg', d: 0.24 },
  ];
  return (
    <div aria-hidden style={{ position: 'absolute', top: 40, left: '50%', width: 0, height: 0, pointerEvents: 'none' }}>
      {bits.map((b, i) => (
        <span key={i} style={{
          position: 'absolute', left: b.x, top: 0, width: 7, height: 7, borderRadius: 2,
          background: b.c, '--r': b.r,
          animation: `stConfetti 1.15s cubic-bezier(0.2, 0.7, 0.4, 1) ${b.d}s both`,
        }} />
      ))}
    </div>
  );
}

/** The card each setup step lives inside, with the step indicator directly
 *  above it. */
function StepCard({ title, subtitle, children, onBack, icon, hue = HUES.peach, progress = null }) {
  return (
    <div>
      {progress ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          {Array.from({ length: progress.n }).map((_, i) => (
            <div key={i} className="st-prog-seg" style={{ width: 32 }} aria-hidden>
              <i style={{ transform: `scaleX(${i <= progress.i ? 1 : 0})` }} />
            </div>
          ))}
          <span className="st-eyebrow" style={{ marginLeft: 8, color: 'rgba(255,255,255,0.6)' }}>
            Step {progress.i + 1} of {progress.n} · {progress.label}
          </span>
          {onBack ? (
            <button type="button" className="st-back" onClick={onBack} style={{ marginLeft: 'auto' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M15 6l-6 6 6 6" />
              </svg>
              Back
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="st-onb-stepcard" style={{ '--c1': hue[0], '--c2': hue[1] }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          {icon ? (
            <IconTile from={hue[0]} to={hue[1]} delay={0.06} size={44} glow={hue[1]}>
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {icon}
              </svg>
            </IconTile>
          ) : null}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: '2px 0 6px', fontSize: 21, fontWeight: 800, letterSpacing: '-0.012em', color: '#fff' }}>{title}</h2>
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: 'rgba(255,255,255,0.6)' }}>{subtitle}</p>
          </div>
        </div>
        <div style={{ marginTop: 22 }}>{children}</div>
      </div>
    </div>
  );
}

function SkipRow({ onSkip, label, primary = false }) {
  return (
    <div style={{ marginTop: 18, textAlign: 'center' }}>
      {primary ? (
        <button type="button" className="st-btn st-btn-ghost" onClick={onSkip}>{label}</button>
      ) : (
        <button type="button" className="st-link" onClick={onSkip}>{label}</button>
      )}
    </div>
  );
}
