import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatTime, parseLRC } from './mediaUtils.js';

/* =========================================================================
 *  PanelLyricsEditor — add and time lyrics inside the docked panel.
 *
 *  A drop-in replacement for <LyricsEditor> at the panel's call site. Same
 *  props, same onSave(synced, plain) contract, same api.saveLyrics payload —
 *  so the panel keeps working exactly as it did and StudioShell remains the
 *  single owner of lyrics state.
 *
 *  ── WHY A SECOND EDITOR AND NOT A RESTYLE ────────────────────────────────
 *  LyricsEditor is built for the fullscreen stage: a full-height textarea,
 *  two large side-by-side actions, type sized for a room-away read. Dropped
 *  into a 376px dock it doesn't shrink gracefully — the textarea becomes a
 *  slot, and the actions wrap. Rather than thread a `compact` flag through a
 *  layout that wants to be a different shape, this is its own component and
 *  the fullscreen one is left alone.
 *
 *  The SAVE PATH is copied deliberately, not shared: the time-order sort, the
 *  0.3s self-heal for the old prefill bug, and the LRC formatting all encode
 *  fixes that cost real debugging. See handleSave.
 *
 *  ── THREE STEPS, AND YOU CAN LEAVE AT ANY OF THEM ────────────────────────
 *    paste  → one textarea, because pasting a sheet is what people do
 *    review → confirm the line split before spending effort timing it
 *    sync   → stamp each line, with the words still editable in place
 *
 *  Every step can save. Plain untimed lyrics are useful on their own, and
 *  forcing a sync step to get them is how this kind of flow gets abandoned.
 * ========================================================================= */

/** LRC timestamp, tolerant of `[m:ss]`, `[mm:ss.xx]` and `[mm:ss:xx]`. */
const LRC_RE = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/;

/** Split a pasted block into lines, lifting any timestamps it already has. */
function splitPaste(raw) {
  return String(raw || '').split('\n').map((row) => {
    const m = LRC_RE.exec(row);
    let time = null;
    if (m) {
      const frac = m[3] ? Number(`0.${m[3]}`) : 0;
      time = (Number(m[1]) * 60) + Number(m[2]) + frac;
    }
    return { text: row.replace(new RegExp(LRC_RE.source, 'g'), '').trim(), time };
  });
}

/** Existing lyrics → the editor's line model, timestamps preserved. */
function linesFromExisting(synced, plain) {
  if (synced && synced.length) return synced.map((l) => ({ text: l.text, time: l.time }));
  if (plain) return String(plain).split('\n').map((t) => ({ text: t.trim(), time: null }));
  return [];
}

const mono = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

export default function PanelLyricsEditor({
  track, currentTime = 0, existingSynced, existingPlain, accent = '255,255,255',
  onSave, onCancel, api = (typeof window !== 'undefined' ? window.electronAPI : null),
}) {
  const seeded = useMemo(
    () => linesFromExisting(existingSynced, existingPlain),
    [existingSynced, existingPlain],
  );

  /* Start on review when there's something to review, paste when there isn't.
     Opening a song that already has lyrics onto an empty textarea reads as
     "your lyrics are gone". */
  const [step, setStep] = useState(seeded.length ? 'review' : 'paste');
  const [paste, setPaste] = useState('');
  const [lines, setLines] = useState(seeded);
  const [saving, setSaving] = useState(false);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef(null);

  const stampedCount = lines.filter((l) => l.time !== null).length;
  const realCount = lines.filter((l) => l.text).length;

  /* ---- paste parsing, live -------------------------------------------- */
  const parsed = useMemo(() => splitPaste(paste), [paste]);
  const pasteReal = parsed.filter((l) => l.text).length;
  const pasteStamps = parsed.filter((l) => l.time !== null).length;

  const acceptPaste = useCallback(() => {
    setLines(parsed);
    /* A sheet that already carries timestamps doesn't need the sync step —
       going there anyway would ask the user to redo work they just pasted. */
    setStep('review');
  }, [parsed]);

  /* ---- line editing ---------------------------------------------------- */
  const setText = useCallback((i, text) => {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, text } : l)));
  }, []);
  const removeLine = useCallback((i) => {
    setLines((ls) => ls.filter((_, j) => j !== i));
  }, []);
  const addLine = useCallback(() => {
    setLines((ls) => [...ls, { text: '', time: null }]);
  }, []);

  /* ---- stamping -------------------------------------------------------- *
   * Toggle, not set: a second click on a stamped line clears it. Clearing
   * was a separate hover control in the old editor, which is a lot of target
   * for a 46px gutter, and "click it again" is what people try first. */
  const stamp = useCallback((i) => {
    setLines((ls) => ls.map((l, j) => (
      j === i ? { ...l, time: l.time === null ? Number(currentTime.toFixed(2)) : null } : l
    )));
    setCursor(Math.min(i + 1, lines.length - 1));
  }, [currentTime, lines.length]);

  /** Stamp the cursor line and advance — the keyboard/footer path. */
  const stampNext = useCallback(() => {
    if (cursor >= lines.length) return;
    setLines((ls) => ls.map((l, j) => (
      j === cursor ? { ...l, time: Number(currentTime.toFixed(2)) } : l
    )));
    setCursor((c) => Math.min(c + 1, lines.length - 1));
  }, [cursor, currentTime, lines.length]);

  /* Space stamps while syncing. Guarded on the editable targets so typing a
     space in a lyric doesn't stamp a line. */
  useEffect(() => {
    if (step !== 'sync') return undefined;
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName))) return;
      if (e.code === 'Space') { e.preventDefault(); stampNext(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, stampNext]);

  /* Keep the cursor line in view without yanking the list while the user is
     reading ahead — only scroll when it's actually off-screen. */
  useEffect(() => {
    if (step !== 'sync' || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-row="${cursor}"]`);
    if (!el) return;
    const box = listRef.current.getBoundingClientRect();
    const row = el.getBoundingClientRect();
    if (row.top < box.top + 8 || row.bottom > box.bottom - 8) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [cursor, step]);

  /* ---- save ------------------------------------------------------------ *
   * Copied from LyricsEditor.handleSave, including the self-heal. Both the
   * sort and the 0.3s duplicate drop are load-bearing — see the comments. */
  const persist = useCallback(async (withTiming) => {
    if (!track || !api?.saveLyrics) return;
    setSaving(true);

    const kept = lines.filter((l) => l.text || l.time !== null);
    let lrcStr = null;

    if (withTiming) {
      // Text order in the list; LRC needs time order. Sorted only on the way
      // out, where it can't reorder rows under the user's cursor.
      const timed = kept.filter((l) => l.time !== null).slice().sort((a, b) => a.time - b.time);
      // Identical text within 0.3s of itself is the fingerprint of the old
      // prefill bug (every chorus copy given one timestamp), not a sung
      // repeat — real repeats are seconds apart. One re-save repairs it.
      const healed = [];
      for (const l of timed) {
        const last = healed[healed.length - 1];
        if (last && last.text === l.text && Math.abs(last.time - l.time) < 0.3) continue;
        healed.push(l);
      }
      lrcStr = healed.map((l) => {
        const min = Math.floor(l.time / 60);
        const sec = l.time % 60;
        return `[${String(min).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}] ${l.text}`;
      }).join('\n') || null;
    }

    const plainStr = kept.map((l) => l.text).join('\n') || null;
    try {
      await api.saveLyrics({
        title: track.title || '',
        artist: track.artist || '',
        syncedLyrics: lrcStr,
        plainLyrics: plainStr,
      });
      onSave?.(lrcStr ? parseLRC(lrcStr) : [], plainStr);
    } catch (e) {
      console.error('Failed to save lyrics', e);
    } finally {
      setSaving(false);
    }
  }, [api, lines, onSave, track]);

  /* ---------------------------------------------------------------- styles
   * Inline rather than classed: the panel's stylesheet is shared with the
   * fullscreen stage, and adding classes there is how the two surfaces start
   * agreeing about things they shouldn't. */
  const S = {
    wrap: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 },
    head: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 8px' },
    title: { fontSize: 13, fontWeight: 800, color: '#fff', flex: 1, minWidth: 0 },
    sub: { fontSize: 11, color: 'rgba(255,255,255,0.42)', fontWeight: 600, marginTop: 1 },
    body: { flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.16) transparent' },
    foot: {
      display: 'flex', alignItems: 'center', gap: 6, padding: '9px 12px',
      borderTop: '1px solid rgba(255,255,255,0.08)', background: 'rgba(0,0,0,0.28)',
    },
    btn: {
      padding: '7px 12px', borderRadius: 99, fontSize: 12, fontWeight: 800, border: 0,
      background: 'rgba(255,255,255,0.07)', color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap',
    },
    ghost: { background: 'none', color: 'rgba(255,255,255,0.6)' },
    pri: { background: `rgb(${accent})`, color: '#12060c' },
    row: { display: 'flex', alignItems: 'flex-start', gap: 7, padding: '1px 8px 1px 4px' },
    gutter: {
      width: 48, flex: '0 0 48px', textAlign: 'right', fontFamily: mono, fontSize: 9.5,
      fontWeight: 700, padding: '9px 5px 0 0', borderRadius: 5, border: 0, background: 'none',
      cursor: 'pointer', lineHeight: 1.2,
    },
    text: {
      flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: 7, fontSize: 13.5, lineHeight: 1.42,
      fontWeight: 700, color: 'rgba(255,255,255,0.72)', outline: 'none',
      border: '1px solid transparent', background: 'transparent', whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    },
    del: {
      width: 20, height: 20, flex: '0 0 20px', borderRadius: 5, border: 0, background: 'none',
      color: 'rgba(255,255,255,0.26)', cursor: 'pointer', marginTop: 7, fontSize: 13, lineHeight: 1,
    },
    pill: {
      padding: '3px 8px', borderRadius: 99, fontSize: 10, fontWeight: 800,
      background: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.55)',
    },
  };

  const Head = ({ title, sub, back }) => (
    <div style={S.head}>
      {back ? (
        <button type="button" onClick={back} aria-label="Back"
          style={{ ...S.btn, ...S.ghost, padding: '5px 9px' }}>←</button>
      ) : null}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={S.title}>{title}</div>
        {sub ? <div style={S.sub}>{sub}</div> : null}
      </div>
    </div>
  );

  /* ===================================================== step 1 · paste  */
  if (step === 'paste') {
    return (
      <div style={S.wrap}>
        <Head title="Add lyrics" sub={track ? `${track.title || ''} · ${track.artist || ''}` : ''} />
        <div style={{ flex: 1, minHeight: 0, padding: '0 12px 8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            spellCheck={false}
            autoFocus
            placeholder={'Paste the lyrics here — one line per row.\n\nBlank lines become spacing.\nTimestamps like [00:12.30] are kept.'}
            style={{
              flex: 1, minHeight: 0, width: '100%', padding: '11px 12px', borderRadius: 11,
              background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.09)',
              color: 'rgba(255,255,255,0.9)', fontSize: 12.5, lineHeight: 1.7, fontWeight: 600,
              fontFamily: 'inherit', resize: 'none', outline: 'none',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'rgba(255,255,255,0.42)', fontWeight: 700 }}>
            <span style={S.pill}>{pasteReal} line{pasteReal === 1 ? '' : 's'}</span>
            {pasteStamps > 0 ? (
              <span style={{ ...S.pill, background: `rgba(${accent},0.2)`, color: `rgb(${accent})` }}>
                {pasteStamps} timed
              </span>
            ) : null}
          </div>
        </div>
        <div style={S.foot}>
          <button type="button" style={{ ...S.btn, ...S.ghost }} onClick={onCancel}>Cancel</button>
          <span style={{ flex: 1 }} />
          <button type="button" disabled={!pasteReal} onClick={acceptPaste}
            style={{ ...S.btn, ...S.pri, opacity: pasteReal ? 1 : 0.4, cursor: pasteReal ? 'pointer' : 'not-allowed' }}>
            Continue
          </button>
        </div>
      </div>
    );
  }

  /* ============================================ steps 2 & 3 · review/sync */
  const syncing = step === 'sync';

  return (
    <div style={S.wrap}>
      <Head
        title={syncing ? 'Tap to sync' : 'Check the lines'}
        sub={syncing
          ? `${stampedCount} of ${realCount} timed · ${formatTime(currentTime)}`
          : `${realCount} line${realCount === 1 ? '' : 's'}`}
        back={() => (syncing ? setStep('review') : setStep('paste'))}
      />

      <div ref={listRef} style={S.body}>
        {lines.map((l, i) => {
          const isCursor = syncing && i === cursor;
          const timed = l.time !== null;
          return (
            /* eslint-disable-next-line react/no-array-index-key */
            <div key={i} data-row={i} style={{
              ...S.row,
              background: isCursor ? `rgba(${accent},0.13)` : 'transparent',
              boxShadow: isCursor ? `inset 0 0 0 1px rgba(${accent},0.32)` : 'none',
              borderRadius: 9,
            }}
            >
              {syncing ? (
                <button
                  type="button"
                  onClick={() => stamp(i)}
                  title={timed ? 'Clear this stamp' : 'Stamp at the playhead'}
                  style={{ ...S.gutter, color: timed ? `rgb(${accent})` : 'rgba(255,255,255,0.26)' }}
                >
                  {timed ? formatTime(l.time) : '––––'}
                </button>
              ) : (
                <span style={{ ...S.gutter, color: 'rgba(255,255,255,0.22)', cursor: 'default' }}>{i + 1}</span>
              )}

              <div
                contentEditable="plaintext-only"
                suppressContentEditableWarning
                spellCheck={false}
                onBlur={(e) => setText(i, e.currentTarget.textContent)}
                onFocus={() => syncing && setCursor(i)}
                style={{ ...S.text, color: isCursor ? '#fff' : S.text.color }}
              >
                {l.text}
              </div>

              {!syncing ? (
                <button type="button" onClick={() => removeLine(i)} style={S.del} title="Delete line" aria-label="Delete line">×</button>
              ) : null}
            </div>
          );
        })}

        {!syncing ? (
          <button type="button" onClick={addLine}
            style={{ ...S.btn, ...S.ghost, margin: '6px 0 10px 56px', fontSize: 11.5 }}>
            + Add line
          </button>
        ) : null}
      </div>

      {syncing ? (
        <div style={{ padding: '9px 12px 0' }}>
          <button
            type="button"
            onClick={stampNext}
            disabled={cursor >= lines.length}
            style={{
              width: '100%', padding: '12px', borderRadius: 14, border: 0,
              background: `rgb(${accent})`, color: '#12060c', fontSize: 13.5, fontWeight: 900,
              cursor: 'pointer',
            }}
          >
            Tap on the beat
          </button>
          <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.38)', textAlign: 'center', marginTop: 6, fontWeight: 600 }}>
            Space works too · click a time to clear it
          </div>
        </div>
      ) : null}

      <div style={S.foot}>
        <button type="button" style={{ ...S.btn, ...S.ghost }} onClick={onCancel}>Cancel</button>
        <span style={{ flex: 1 }} />
        {/* Always available. Plain lyrics are a legitimate result, and making
            the sync step mandatory to save is how people give up here. */}
        <button type="button" disabled={saving || !realCount}
          onClick={() => persist(stampedCount > 0)}
          style={{ ...S.btn, opacity: realCount ? 1 : 0.4 }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {!syncing ? (
          <button type="button" disabled={!realCount}
            onClick={() => { setStep('sync'); setCursor(0); }}
            style={{ ...S.btn, ...S.pri, opacity: realCount ? 1 : 0.4 }}>
            {stampedCount ? 'Timing' : 'Add timing'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
