import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PICKER_PRESETS } from './constants.js';
import { titleCase } from '../../lib/format.js';

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
      background: 'rgba(var(--st-fg-rgb), 0.09)', borderRadius: 5, padding: '1px 5px', overflowWrap: 'anywhere',
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
export function StudioColorPicker({ value, onChange, onReset, title, size = 24, buttonStyle = null }) {
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
          ...buttonStyle,
        }} />

      {/* Portalled to <body>.
          `position: fixed` is only fixed relative to the nearest ancestor that
          has a transform, filter or running animation — and the settings
          scroller has one. That made a stacking context the popover couldn't
          escape, so it sat behind the docked Queue/Lyrics panel no matter how
          high its z-index went. Out here it has no ancestor to be trapped by. */}
      {open ? createPortal((
        <div ref={popRef} role="dialog" aria-label={title} data-colour-picker
          style={{
            position: 'fixed', top: pos.top, left: pos.left, width: 232, zIndex: 200,
            borderRadius: 14, padding: 12,
            /* The app's card colour, like every other floating layer. */
            background: 'var(--surface)',
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
    if (!r?.ok) { setBusy(false); setErr(r?.error || 'Couldn’t start sign-in.'); }
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
          <h2>Spotify Account</h2>
          <p>
            Plays Spotify songs in Studio with Premium and powers My Spotify, search and artist
            pages on any account. Saving songs to Studio doesn’t change your Spotify library.
            This uses Spotify’s unofficial web player connection, which can change without notice.
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
              {testing ? 'Testing…' : 'Test Connection'}
            </button>
            <button type="button" className="st-btn st-btn-outline" onClick={signOut}>Sign out</button>
          </>
        ) : (
          <>
            <button type="button" className="st-btn st-btn-primary" onClick={signIn} disabled={busy}>
              {busy ? 'Waiting for your browser…' : 'Sign In with Spotify'}
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
        if (ev.event === 'unavailable') setNote('Spotify says this song can’t be played on this account.');
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
          : status === 'error' ? 'Not available' : 'Starts when you play a Spotify song';
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
          <button type="button" className="st-btn st-btn-primary" onClick={onReauth}>Sign In Again</button>
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
              placeholder="Paste a Spotify song link to test playback"
              aria-label="Spotify song link" spellCheck={false} />
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

export function SetRow({ title, note, children, wide = true }) {
  return (
    <div className="sth-set-r">
      <span className="txt"><b>{titleCase(title)}</b>{note ? <p>{note}</p> : null}</span>
      <span className={`ctl${wide ? ' is-col' : ''}`}>{children}</span>
    </div>
  );
}

/** A segmented picker. Options are [value, label] pairs. Fills its column. */
export function SetSeg({ value, options, onPick, label }) {
  return (
    <span className="st-segs" role="radiogroup" aria-label={label}>
      {/* An option may carry an icon as its third item, drawn before the label. */}
      {options.map(([id, lbl, icon]) => (
        <button key={String(id)} type="button" role="radio" aria-checked={value === id}
          className={value === id ? 'on' : ''} onClick={() => onPick(id)}
          style={icon ? { display: 'inline-flex', alignItems: 'center', gap: 8 } : undefined}>
          {icon || null}{titleCase(lbl)}
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
