import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseLRC } from '../lib/mediaUtils.js';

/* =========================================================================
 *  PanelLyricsEditor — add, edit and time lyrics (side panel and fullscreen)
 *
 *  A plain toolbar: Cancel · Lyrics | Sync · Save.
 *    Lyrics → the lyrics as plain text, one line per row. Adding, removing and
 *             fixing lines is just typing; pasting a sheet is the usual start.
 *             Timestamps pasted in ([0:12.30] …) are picked up.
 *    Sync   → the lines with their times. Press Space (or the on-screen key)
 *             as each line starts; undo the last tap; go back 3s; nudge any
 *             time ±0.1s or clear it; click a time to stamp or clear it; the
 *             words stay editable in place.
 *  Save works from either; untimed lyrics are a fine result on their own.
 *
 *  Times survive going back to Text: an edited line keeps its time when the
 *  line count is unchanged, and otherwise lines are matched by their words.
 *
 *  The save path (time-order sort, the 0.3s self-heal for the old prefill
 *  bug, LRC formatting) is unchanged from the previous editor. See persist.
 * ========================================================================= */

/** LRC timestamp, tolerant of `[m:ss]`, `[mm:ss.xx]` and `[mm:ss:xx]`. */
const LRC_RE = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/;

/** Text into lines, lifting any timestamps it carries. */
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

/** New text, old lines → new lines carrying over the times they had. */
function mergeTimes(prev, text) {
  const next = splitPaste(text);
  if (prev.length === next.length) {
    return next.map((l, i) => (l.time !== null || !l.text ? l : { ...l, time: prev[i].time }));
  }
  let k = 0;
  return next.map((l) => {
    if (l.time !== null || !l.text) return l;
    for (let j = k; j < Math.min(prev.length, k + 12); j += 1) {
      if (prev[j].text === l.text) { k = j + 1; return { ...l, time: prev[j].time }; }
    }
    return l;
  });
}

const toText = (lines) => lines.map((l) => l.text).join('\n');
const nextLine = (lines, from) => {
  for (let i = Math.max(0, from); i < lines.length; i += 1) if (lines[i].text) return i;
  return lines.length;
};

const CSS = `
.le { flex: 1; min-height: 0; display: flex; flex-direction: column; color: #fff; }
.le-bar { display: flex; align-items: center; height: 40px; padding: 0 14px; border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0; }
.le-txt { border: none; background: none; padding: 6px 0; cursor: pointer; font: inherit; font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.6); }
.le-txt:hover { color: #fff; }
.le-txt.is-save { font-weight: 800; color: rgb(var(--le-acc)); }
.le-txt:disabled { opacity: 0.35; cursor: default; }
.le-tabs { flex: 1; display: flex; justify-content: center; gap: 18px; align-self: stretch; }
.le-tabs button { position: relative; border: none; background: none; padding: 0 2px; cursor: pointer; font: inherit; font-size: 13px; font-weight: 700; color: rgba(255,255,255,0.45); }
.le-tabs button:hover:not(:disabled) { color: rgba(255,255,255,0.8); }
.le-tabs button.on { color: #fff; }
.le-tabs button.on::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; border-radius: 2px 2px 0 0; background: #fff; }
.le-tabs button:disabled { cursor: default; opacity: 0.4; }
.le-tabs button:focus { outline: none; }

.le-ta { flex: 1; min-height: 0; margin: 12px 12px 0; padding: 12px 14px; border-radius: 14px; resize: none; outline: none;
  background: rgba(0,0,0,0.22); border: 1px solid rgba(255,255,255,0.08); color: rgba(255,255,255,0.92);
  font: inherit; font-size: 14px; line-height: 1.65; font-weight: 600; transition: border-color .14s ease; }
.le-ta:focus { border-color: rgba(255,255,255,0.2); }
.le-ta::placeholder { color: rgba(255,255,255,0.32); }
.le-foot { display: flex; align-items: center; gap: 4px; min-height: 44px; padding: 0 10px 0 16px; border-top: 1px solid rgba(255,255,255,0.08); flex-shrink: 0;
  font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.45); font-variant-numeric: tabular-nums; }
.le-foot b { color: rgba(255,255,255,0.8); font-weight: 700; }

.le-list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 0; }
/* The sync list as it originally was: a small time in a gutter (the app's
   font with even-width digits; the old monospace stack fell back to Courier), the
   words editable in place, the line to sync next in a tinted box. */
.le-row { position: relative; display: flex; align-items: flex-start; gap: 7px; padding: 1px 8px 1px 4px; border-radius: 9px; }
.le-row.is-cur { background: rgba(var(--le-acc), 0.13); box-shadow: inset 0 0 0 1px rgba(var(--le-acc), 0.32); }
.le-time { width: 48px; flex: 0 0 48px; text-align: right; font-family: inherit; font-size: 11px; font-variant-numeric: tabular-nums; letter-spacing: 0.01em;
  font-weight: 700; padding: 8px 5px 0 0; border-radius: 5px; border: 0; background: none; cursor: pointer; line-height: 1.2; color: rgba(255,255,255,0.26); }
.le-time.is-set { color: rgb(var(--le-acc)); }
.le-line { flex: 1; min-width: 0; padding: 6px 8px; border-radius: 7px; font-size: 13.5px; line-height: 1.42; font-weight: 700; color: rgba(255,255,255,0.72);
  outline: none; border: 1px solid transparent; background: transparent; white-space: pre-wrap; word-break: break-word; }
.le-row.is-cur .le-line { color: #fff; }
/* The synced line the song is on right now. */
.le-row.is-live .le-line { color: rgb(var(--le-acc)); }
.le-adj { position: absolute; right: 2px; top: 50%; transform: translateY(-50%); display: flex; gap: 1px; padding: 2px; border-radius: 7px;
  background: rgba(16,10,12,0.88); box-shadow: 0 0 0 1px rgba(255,255,255,0.08); visibility: hidden; }
.le-row.is-set:hover .le-adj { visibility: visible; }
.le-adj button { border: none; background: none; cursor: pointer; padding: 0 5px; height: 20px; font: inherit; font-size: 11.5px; font-weight: 700;
  color: rgba(255,255,255,0.4); border-radius: 4px; }
.le-adj button:hover { color: #fff; background: rgba(255,255,255,0.08); }

.le-ic { width: 32px; height: 32px; border: none; background: none; border-radius: 6px; cursor: pointer; color: rgba(255,255,255,0.6);
  display: inline-flex; align-items: center; justify-content: center; }
.le-ic:hover:not(:disabled) { color: #fff; background: rgba(255,255,255,0.07); }
.le-ic:disabled { opacity: 0.3; cursor: default; }
.le-count { margin-left: 6px; }
.le-tapwrap { margin-left: auto; display: flex; align-items: center; gap: 7px; color: rgba(255,255,255,0.6); }
.le-key { min-width: 52px; height: 26px; padding: 0 10px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; font: inherit; font-size: 11.5px; font-weight: 700; color: rgba(255,255,255,0.9);
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.22); border-bottom-width: 3px; border-radius: 6px;
  transition: transform .06s ease, border-bottom-width .06s ease, background .1s ease; }
.le-key:hover:not(:disabled) { background: rgba(255,255,255,0.1); }
.le-key.is-down, .le-key:active:not(:disabled) { transform: translateY(2px); border-bottom-width: 1px; background: rgba(var(--le-acc), 0.25); }
.le-key:disabled { opacity: 0.35; cursor: default; }
`;

const I = {
  back: <path d="M15 6l-6 6 6 6" />,
  undo: <><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></>,
  rewind: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></>,
};
const Icon = ({ d, size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>
);

export default function PanelLyricsEditor({
  track, currentTime = 0, existingSynced, existingPlain, accent = '255,255,255',
  onSave, onCancel, onSeek, initialMode = 'text',
  api = (typeof window !== 'undefined' ? window.electronAPI : null),
}) {
  const seeded = useMemo(
    () => linesFromExisting(existingSynced, existingPlain),
    [existingSynced, existingPlain],
  );

  const [lines, setLines] = useState(seeded);
  const [text, setText] = useState(() => toText(seeded));
  const [mode, setMode] = useState(seeded.some((l) => l.text) ? initialMode : 'text');
  const [cursor, setCursor] = useState(() => nextLine(seeded, seeded.findIndex((l) => l.text && l.time === null)));
  const [history, setHistory] = useState([]);
  const [saving, setSaving] = useState(false);
  const listRef = useRef(null);

  /* The text box is the truth in Text mode, the lines in Sync mode. */
  const textLines = useMemo(() => (mode === 'text' ? mergeTimes(lines, text) : lines), [mode, lines, text]);
  const realCount = textLines.filter((l) => l.text).length;
  const timedCount = textLines.filter((l) => l.text && l.time !== null).length;

  const toSync = useCallback(() => {
    const next = mergeTimes(lines, text);
    setLines(next);
    setHistory([]);
    const firstOpen = next.findIndex((l) => l.text && l.time === null);
    setCursor(nextLine(next, firstOpen < 0 ? 0 : firstOpen));
    setMode('sync');
    // Space taps from here on; it mustn't also press whatever was clicked.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, [lines, text]);
  const toText_ = useCallback(() => { setText(toText(lines)); setMode('text'); }, [lines]);

  /* ---- syncing --------------------------------------------------------- */
  const tap = useCallback(() => {
    if (cursor >= lines.length) return;
    const at = Number(currentTime.toFixed(2));
    setLines((ls) => ls.map((l, j) => (j === cursor ? { ...l, time: at } : l)));
    setHistory((h) => [...h, cursor]);
    setCursor((c) => nextLine(lines, c + 1));
  }, [cursor, currentTime, lines]);

  const undo = useCallback(() => {
    if (!history.length) return;
    const i = history[history.length - 1];
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, time: null } : l)));
    setCursor(i);
    setHistory(history.slice(0, -1));
  }, [history]);

  /** A time's own button: clear it, or stamp this line now. */
  const toggleTime = useCallback((i) => {
    const had = lines[i]?.time !== null;
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, time: had ? null : Number(currentTime.toFixed(2)) } : l)));
    if (had) setCursor(i);
    else { setHistory((h) => [...h, i]); setCursor(nextLine(lines, i + 1)); }
  }, [currentTime, lines]);


  const rewind = useCallback(() => onSeek?.(Math.max(0, currentTime - 3)), [currentTime, onSeek]);

  /** The words of one line, edited in place in the sync list. */
  const setLineText = useCallback((i, t) => {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, text: String(t || '').trim() } : l)));
  }, []);

  /** Move one line's time a tenth of a second either way. */
  const nudge = useCallback((i, d) => {
    setLines((ls) => ls.map((l, j) => (j === i && l.time !== null ? { ...l, time: Math.max(0, Number((l.time + d).toFixed(2))) } : l)));
  }, []);
  const clearTime = useCallback((i) => {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, time: null } : l)));
    setHistory((h) => h.filter((x) => x !== i));
    setCursor(i);
  }, []);

  /* The Space key on screen dips when a tap lands, from the keyboard too. */
  const [keyDown, setKeyDown] = useState(false);
  const tapWithKey = useCallback(() => {
    tap();
    setKeyDown(true);
    setTimeout(() => setKeyDown(false), 110);
  }, [tap]);

  /* ---- save ------------------------------------------------------------ *
   * Unchanged from the previous editor: the time-order sort and the 0.3s
   * duplicate drop are both load-bearing. */
  const persist = useCallback(async () => {
    const all = mode === 'text' ? mergeTimes(lines, text) : lines;
    if (!track || !api?.saveLyrics) return;
    setSaving(true);

    const kept = all.filter((l) => l.text || l.time !== null);
    let lrcStr = null;

    if (kept.some((l) => l.time !== null)) {
      // Text order in the list; LRC needs time order.
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
  }, [api, lines, mode, onSave, text, track]);

  /* ---- keys ------------------------------------------------------------ *
   * Sync: Space taps, Ctrl+Z undoes, ← goes back 3s. Ctrl+S saves anywhere.
   * Keys typed into the text box are left alone. */
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (realCount && !saving) persist(); return; }
      if (mode !== 'sync') return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName))) return;
      if (e.code === 'Space') { e.preventDefault(); tapWithKey(); } else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); } else if (e.key === 'ArrowLeft') { e.preventDefault(); rewind(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, persist, realCount, rewind, saving, tapWithKey, undo]);

  /* Keep the line to tap in view, without yanking the list while it's on
     screen. */
  useEffect(() => {
    if (mode !== 'sync' || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-row="${cursor}"]`);
    if (!el) return;
    const box = listRef.current.getBoundingClientRect();
    const row = el.getBoundingClientRect();
    if (row.top < box.top + 24 || row.bottom > box.bottom - 24) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [cursor, mode]);

  const syncing = mode === 'sync';
  const done = cursor >= lines.length;
  const cursorNo = done ? realCount : lines.slice(0, cursor + 1).filter((l) => l.text).length;
  /* The synced line the song is on right now (the latest time not after the
     playhead), so playing it back shows whether the times land. */
  let live = -1;
  if (syncing) {
    let best = -Infinity;
    lines.forEach((l, i) => { if (l.text && l.time !== null && l.time <= currentTime + 0.05 && l.time > best) { best = l.time; live = i; } });
  }
  const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

  return (
    <div className="le" style={{ '--le-acc': accent }}>
      <style>{CSS}</style>
      <div className="le-bar">
        <button type="button" className="le-txt" onClick={onCancel}>Cancel</button>
        <div className="le-tabs" role="tablist" aria-label="Edit mode">
          <button type="button" role="tab" aria-selected={!syncing} className={syncing ? '' : 'on'} onClick={syncing ? toText_ : undefined}>Lyrics</button>
          <button type="button" role="tab" aria-selected={syncing} className={syncing ? 'on' : ''} disabled={!realCount}
            onClick={syncing ? undefined : toSync} title={realCount ? 'Sync each line to the song' : 'Add some lyrics first'}>Sync</button>
        </div>
        <button type="button" className="le-txt is-save" disabled={!realCount || saving} onClick={persist}>{saving ? 'Saving…' : 'Save'}</button>
      </div>

      {!syncing ? (
        <>
          <textarea className="le-ta sth-libscroll" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
            autoFocus={!text} aria-label="Lyrics"
            placeholder={'Paste or type the lyrics, one line per row.\nA blank line separates verses.\nTimes like [0:12.30] are kept.'} />
          <div className="le-foot">
            <span><b>{realCount}</b> {realCount === 1 ? 'line' : 'lines'}{timedCount ? <> · <b>{timedCount}</b> synced</> : null}</span>
          </div>
        </>
      ) : (
        <>
          <div ref={listRef} className="le-list sth-libscroll">
            {lines.map((l, i) => {
              const set = l.time !== null;
              const cls = ['le-row', i === cursor && 'is-cur', set && 'is-set', i === live && 'is-live'].filter(Boolean).join(' ');
              return (
                // eslint-disable-next-line react/no-array-index-key
                <div key={i} data-row={i} className={cls}>
                  <button type="button" className={`le-time${set ? ' is-set' : ''}`} onClick={() => toggleTime(i)}
                    title={set ? 'Clear this stamp' : 'Stamp at the playhead'}>
                    {set ? fmt(l.time) : '––––'}
                  </button>
                  <div
                    className="le-line"
                    contentEditable="plaintext-only"
                    suppressContentEditableWarning
                    spellCheck={false}
                    onBlur={(e) => setLineText(i, e.currentTarget.textContent)}
                    onFocus={() => setCursor(i)}
                  >
                    {l.text}
                  </div>
                  {set ? (
                    <span className="le-adj">
                      <button type="button" onClick={() => nudge(i, -0.1)} title="0.1s earlier" aria-label="Earlier">−.1</button>
                      <button type="button" onClick={() => nudge(i, 0.1)} title="0.1s later" aria-label="Later">+.1</button>
                      <button type="button" onClick={() => clearTime(i)} title="Clear this time" aria-label="Clear time">✕</button>
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="le-foot">
            <button type="button" className="le-ic" onClick={rewind} disabled={!onSeek} title="Back 3 seconds (←)" aria-label="Back 3 seconds"><Icon d={I.rewind} size={15} /></button>
            <button type="button" className="le-ic" onClick={undo} disabled={!history.length} title="Undo last tap (Ctrl+Z)" aria-label="Undo last tap"><Icon d={I.undo} size={15} /></button>
            <span className="le-count">{done ? 'All timed' : <><b>{cursorNo}</b> / {realCount}</>}</span>
            <span className="le-tapwrap">
              {done ? <span>All synced</span> : (
                <>
                  <span>Tap</span>
                  <button type="button" className={`le-key${keyDown ? ' is-down' : ''}`} onClick={tapWithKey} aria-label="Tap Space to sync this line">Space</button>
                  <span>to Sync</span>
                </>
              )}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
