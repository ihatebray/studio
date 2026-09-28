import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { presetById, getStoredFontId, loadGoogleFontForPreset } from './uiFonts.js';
import { TOKENS_CSS } from './accentTokens.js';

/* =========================================================================
 *  studio — onboarding
 *
 *  A cinematic first-run flow: wordmark reveal → Spotify credentials →
 *  Soulseek (optional) → ready. Each step is a glass card on a black stage;
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

      .st-onb-grid { margin: 40px auto 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; text-align: left; }
      .st-onb-card { padding: 22px; border-radius: 16px; background: var(--surface-raised, #0E0E11); border: 1px solid var(--border, #191919); }
      .st-onb-card h3 { margin: 18px 0 0; font-size: 15px; font-weight: 800; color: var(--text, #F4F4F5); }
      .st-onb-card p { margin: 6px 0 0; font-size: 13px; line-height: 1.55; color: var(--text-dim, #A1A1AA); }
      @media (max-width: 620px) { .st-onb-grid { grid-template-columns: minmax(0, 1fr); } }

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
      .st-prog-seg > i { display: block; height: 100%; border-radius: 2px; background: var(--accent, #ff7a59); transform-origin: left center; transition: transform 0.5s cubic-bezier(0.34,1.5,0.5,1); }

      @media (prefers-reduced-motion: reduce) {
        .st-onb *, .st-step, .st-step * { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; }
        .st-btn:hover, .st-back:hover, .st-input:focus { transform: none; }
      }
    ${TOKENS_CSS}`}</style>
  );
}

/** A big rounded colour tile with a glyph in it — the friendly bit. */
function IconTile({ from, to, delay = 0, children, size = 52 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: size > 42 ? 12 : 10, flexShrink: 0,
      background: to ? `linear-gradient(135deg, ${from}, ${to})` : from,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--accent-ink, #0B0B0C)',
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
        setMsg({ ok: true, text: 'Saved. Spotify search is live.' });
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
      <HowTo open={false} label={compact ? 'Where do I find these?' : 'How do I get a client ID and secret?'} hint={compact ? null : '5 steps, about a minute'}>
        <Steps>
          <li>
            Open the <ExtLink href="https://developer.spotify.com/dashboard">Spotify Developer Dashboard</ExtLink>
            {' '}and log in. Any free Spotify account works — you do not need Premium.
          </li>
          <li>Click <Lit>Create app</Lit>. The name and description can be anything; they are only shown to you.</li>
          <li>For Redirect URI enter <Lit>http://127.0.0.1:8888/callback</Lit> and click Add. Spotify requires one even though search does not use it.</li>
          <li>Tick <Lit>Web API</Lit>, agree to the terms, and save.</li>
          <li>On the app page open <Lit>Settings</Lit>, then copy the Client ID, and <Lit>View client secret</Lit> for the second value.</li>
        </Steps>
        <div style={{ marginTop: 10, fontSize: 11.5, color: 'rgba(255,255,255,0.4)', lineHeight: 1.6 }}>
          These stay on this machine and are only used to search Spotify's catalog for metadata and artwork.
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
 *  The onboarding flow itself
 * ========================================================================= */

/* The two steps that ask for something. `welcome` and `ready` are moments,
   not steps, so they are deliberately outside this list — a progress rail
   that counts the splash screen as progress lies about how much is left. */
const SETUP_STEPS = [
  { id: 'spotify', label: 'Spotify' },
  { id: 'soulseek', label: 'Soulseek' },
];
const STEPS = ['welcome', 'spotify', 'soulseek', 'ready'];

/* One colour per letter of "studio", stepped along the same white → peach →
   pink ramp the rest of the flow uses. Plain `color`, so it survives the
   per-letter blur/scale animation. */
const WORDMARK_RAMP = ['#ffffff', '#fff1e2', '#ffd9bd', '#ffc0ae', '#ffa8b8', '#ff9ec4'];

export default function StudioOnboarding({ onComplete, onSpotifyCredsSaved }) {
  const [step, setStep] = useState('welcome');
  const [dir, setDir] = useState('fwd');
  const [leaving, setLeaving] = useState(null);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const go = useCallback((next, direction = 'fwd') => {
    setLeaving(direction);
    timerRef.current = setTimeout(() => {
      setStep(next);
      setDir(direction);
      setLeaving(null);
    }, 220);
  }, []);

  const idx = STEPS.indexOf(step);
  const back = useCallback(() => { if (idx > 0) go(STEPS[idx - 1], 'back'); }, [idx, go]);

  /* Esc leaves setup, but only once past the welcome screen — the same rule
     the "Skip setup" link follows, or Esc would be an undocumented way to do
     exactly what that screen no longer offers.

     Each individual step can still be skipped; what's gone is skipping the
     whole thing before seeing any of it. The primary action stays a real
     button — binding Enter globally would fire it mid-way through typing a
     secret. */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && idx > 0 && step !== 'ready') onComplete?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, idx, onComplete]);

  /* Onboarding runs BEFORE the rest of the app mounts, so it cannot assume
     App's font effect has fired yet — and Volte Rounded loads from a CDN, so
     "already on the page" is not a safe bet either. Ask for the stored preset
     ourselves and set the stack on this subtree. Controls are covered by the
     .st-onb rule in StudioMotionStyles, since buttons and inputs never
     inherit font-family on their own. */
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

  return (
    <div className="st-onb" style={{
      position: 'fixed', inset: 0, zIndex: 100,
      fontFamily: fontStack,
      /* studio's own near-black. The drifting colour blobs are gone: the app
         stepped away from the fullscreen stage, and nothing else in it looks
         like that any more, so an ambient light show here set an expectation
         the rest of the product no longer meets. The shine stays where it is
         attached to something real — the buttons, the tiles, the wordmark. */
      background: '#000',
      /* Never scrolls. The rail lives in normal flow underneath the step
         rather than floating over it, so the two cannot collide — which is
         what was clipping it before. The step region takes the remaining
         height and centres inside it. */
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <StudioMotionStyles />

      <div style={{
        flex: 1, minHeight: 0, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        padding: '30px 28px 10px',
      }}>
      <div
        key={step}
        className="st-step"
        style={{
          position: 'relative', width: step === 'welcome' ? 'min(700px, calc(100vw - 56px))' : 'min(640px, calc(100vw - 56px))',
          animation: anim,
        }}
      >
        {step === 'welcome' ? (
          <div style={{ textAlign: 'center' }}>
            {/* Glow halved (brief): the wordmark shouldn't promise more visual
                drama than the app itself delivers. White into the accent. */}
            <h1 aria-label="studio" style={{
              margin: 0, fontSize: 78, fontWeight: 800, letterSpacing: '-0.03em',
              lineHeight: 1, color: '#fff',
            }}>
              {'studio'.split('').map((ch, i) => (
                <span key={i} aria-hidden style={{
                  display: 'inline-block',
                  color: `color-mix(in oklab, var(--accent, #ff7a59) ${Math.round((i / 5) * 100)}%, #ffffff)`,
                  textShadow: '0 4px 18px rgba(var(--accent-rgb, 255, 122, 89), 0.14)',
                  animation: `stLetter 0.72s cubic-bezier(0.34, 1.5, 0.5, 1) ${0.12 + i * 0.06}s both`,
                }}>{ch}</span>
              ))}
            </h1>

            <p style={{
              margin: '18px 0 0', fontSize: 16, fontWeight: 600, color: 'var(--text-dim, #A1A1AA)',
              animation: 'stFadeIn 0.8s ease 0.72s both',
            }}>
              A music library that actually feels like yours.
            </p>

            {/* 2x2 of equal-height cards (was 3+1, which orphaned Keep up). */}
            <div className="st-onb-grid">
              {[
                { mix: 100, delay: 0.9, title: 'Find it', body: 'Search millions of tracks and grab the ones you want.',
                  icon: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" /></> },
                { mix: 55, delay: 1.0, title: 'Own it', body: 'Real files on your disk. No subscription, no rug pull.',
                  icon: <path d="M4 7v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7L9 5H6a2 2 0 0 0-2 2z" /> },
                { mix: 78, delay: 1.1, title: 'Live in it', body: 'Artwork, lyrics, credits and colour, all at your fingertips.',
                  icon: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.4" /></> },
                { mix: 40, delay: 1.2, title: 'Keep up', body: 'Follow artists and see anything new they release.',
                  icon: <path d="M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.75L12 16.9l-5.2 2.7 1-5.75-4.2-4.1 5.8-.85z" /> },
              ].map((f) => (
                <div key={f.title} className="st-onb-card" style={{ animation: `stRise 0.6s cubic-bezier(0.34,1.4,0.5,1) ${f.delay}s both` }}>
                  <IconTile from={`color-mix(in oklab, var(--accent, #ff7a59) ${f.mix}%, #ffffff)`} delay={f.delay + 0.1} size={40}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      {f.icon}
                    </svg>
                  </IconTile>
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 36, animation: 'stRise 0.6s cubic-bezier(0.34,1.4,0.5,1) 1.34s both' }}>
              <button type="button" className="st-btn st-btn-primary st-btn-lg" style={{ minWidth: 132, boxShadow: '0 6px 18px rgba(var(--accent-rgb, 255, 122, 89), 0.14)' }} onClick={() => go('spotify')}>
                Let&rsquo;s go
              </button>
              <div style={{ marginTop: 14, fontSize: 12.5, color: 'var(--text-faint, #6F6F78)' }}>
                Takes about two minutes. You can change all of it later.
              </div>
            </div>
          </div>
        ) : null}

        {step === 'spotify' ? (
          <StepCard
            progress={{ i: 0, n: SETUP_STEPS.length, label: 'Spotify' }}
            title="Search"
            subtitle="studio borrows Spotify's catalogue to find songs, then downloads real files to your own library. A free account is all you need, and the keys stay on this machine."
            onBack={null}
            icon={<><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" /></>}
          >
            <SpotifyCredsPanel onSaved={() => { onSpotifyCredsSaved?.(); timerRef.current = setTimeout(() => go('soulseek'), 700); }} />
            <SkipRow onSkip={() => go('soulseek')} label="Skip for now — I'll add it later" />
          </StepCard>
        ) : null}

        {step === 'soulseek' ? (
          <StepCard
            progress={{ i: 1, n: SETUP_STEPS.length, label: 'Soulseek' }}
            title="Add a second source"
            subtitle="Soulseek finds the rare stuff, usually in better quality. Totally optional — skip it and nothing breaks."
            onBack={back}
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
              margin: '26px 0 10px', fontSize: 32, fontWeight: 800, letterSpacing: '-0.025em', color: '#fff',
              animation: 'stRise 0.55s cubic-bezier(0.34,1.4,0.5,1) 0.2s both',
            }}>
              You&rsquo;re all set
            </h2>
            <p style={{
              margin: 0, fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.6)',
              animation: 'stRise 0.55s cubic-bezier(0.34,1.4,0.5,1) 0.32s both',
            }}>
              Search for something you love and hit play.
            </p>

            <div style={{
              margin: '28px auto 0', maxWidth: 400, padding: '14px 18px', borderRadius: 14,
              background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)',
              fontSize: 12, lineHeight: 1.65, color: 'rgba(255,255,255,0.52)',
              animation: 'stRise 0.55s cubic-bezier(0.34,1.4,0.5,1) 0.44s both',
            }}>
              Follow an artist from their page and studio watches for new
              releases. Anything you skipped is under{' '}
              <strong style={{ color: 'rgba(255,255,255,0.85)', fontWeight: 800 }}>Settings → Connections</strong>.
            </div>

            <div style={{ marginTop: 34, animation: 'stRise 0.6s cubic-bezier(0.34,1.4,0.5,1) 0.58s both' }}>
              <button type="button" className="st-btn st-btn-primary" onClick={onComplete}>Open studio</button>
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
    { x: -108, c: '#ffd9a8', r: '120deg', d: 0.06 }, { x: -74, c: '#ff9ec4', r: '-90deg', d: 0.16 },
    { x: -38, c: '#9b7bff', r: '150deg', d: 0.02 }, { x: 40, c: '#5fd3b4', r: '-140deg', d: 0.2 },
    { x: 76, c: '#ffd9a8', r: '80deg', d: 0.1 }, { x: 110, c: '#ff9d6e', r: '-70deg', d: 0.24 },
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
 *  above it (brief: it used to be stranded at the bottom of the window). */
function StepCard({ title, subtitle, children, onBack, icon, progress = null }) {
  return (
    <div>
      {progress ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          {Array.from({ length: progress.n }).map((_, i) => (
            <div key={i} className="st-prog-seg" style={{ width: 32 }} aria-hidden>
              <i style={{ transform: `scaleX(${i <= progress.i ? 1 : 0})` }} />
            </div>
          ))}
          <span className="st-eyebrow" style={{ marginLeft: 8, color: 'var(--text-dim, #A1A1AA)' }}>
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
      <div style={{
        padding: '28px 30px', borderRadius: 16,
        background: 'var(--surface-raised, #0E0E11)', border: '1px solid var(--border, #191919)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          {icon ? (
            <IconTile from="var(--accent, #ff7a59)" delay={0.06} size={42}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {icon}
              </svg>
            </IconTile>
          ) : null}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: '2px 0 6px', fontSize: 20, fontWeight: 800, letterSpacing: '-0.01em', color: 'var(--text, #F4F4F5)' }}>{title}</h2>
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: 'var(--text-dim, #A1A1AA)' }}>{subtitle}</p>
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
