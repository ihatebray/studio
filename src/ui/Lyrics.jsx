import React, { useState, useEffect, useRef, useCallback } from 'react';
import { formatTime, parseLRC, activeLyricIndex, sortStampedLines } from '../lib/mediaUtils.js';

/**
 * LyricsEditor — paste/type lyrics, then tap-to-sync timestamps onto them.
 *
 * Shared verbatim by all four mount points (the overlay's fullscreen lyrics
 * pane, its mini pane, its standalone modal, and StudioHome's lyrics panel),
 * so behaviour here is the behaviour everywhere.
 *
 * ── WHY THE LIST NEVER REORDERS ──────────────────────────────────────────
 * The editor used to re-sort on every stamp: stamped lines floated to the
 * top by time, unstamped sank to the bottom. That made a line's POSITION a
 * function of its timestamp, which caused every symptom people hit:
 *
 *   - Clearing a stamp left a null-timed line sitting mid-list, breaking the
 *     sort's own invariant. The next stamp re-sorted and that line teleported
 *     to the bottom — "lines moved somewhere else when I erased an edit".
 *   - `syncIdx` is a POSITION. After a sort it pointed at whatever line had
 *     moved into that slot, so the cursor silently jumped to a different
 *     line — "lines getting skipped".
 *   - Undo assumed `syncIdx - 1` was the most recently stamped line. After a
 *     sort it usually wasn't, so undo cleared an unrelated line.
 *   - Rows were keyed by array index while the array reordered, so React
 *     recycled DOM nodes across different logical lines mid-edit.
 *
 * None of that sorting bought anything: handleSave already sorts by time
 * when building the LRC, so the saved output is identical either way. The
 * sort only ever churned the view the user was working in.
 *
 * So: lines stay in the order they were typed, permanently. `syncIdx` is
 * therefore a stable index, ids are stable, and refs stay aligned. Stamping
 * out of order is surfaced as a warning with an opt-in "Sort by time" action
 * rather than silently corrected — a reorder the user asked for is fine, one
 * that happens under their cursor is not.
 *
 * Stamp recency is tracked with a monotonic `seq` ON EACH LINE rather than a
 * history ref, so undo works off pure state. A ref mutated inside a setState
 * updater would double-append under StrictMode's double-invoke; computing
 * `seq` from `prev` is idempotent.
 */
function LyricsEditor({ track, currentTime, existingSynced, existingPlain, accent, onSeek, onSave, onCancel }) {
  // 'edit' = editing text lines, 'sync' = tap-to-sync stamping mode
  const [step, setStep] = useState('edit');
  const [text, setText] = useState(() => {
    if (existingSynced?.length) return existingSynced.map((l) => l.text).join('\n');
    if (existingPlain) return existingPlain;
    return '';
  });
  // Array of { id, text, time: number|null, seq: number }
  const [stampedLines, setStampedLines] = useState([]);
  const [syncIdx, setSyncIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const syncContainerRef = useRef(null);
  const lineElsRef = useRef([]);
  const idSeq = useRef(0);
  const api = typeof window !== 'undefined' ? window.electronAPI : null;

  const nextId = () => { idSeq.current += 1; return `ln${idSeq.current}`; };
  const norm = (s) => String(s || '').trim().toLowerCase();

  /**
   * Parse the textarea into lines and carry timestamps across.
   *
   * Times are matched per-OCCURRENCE through queues rather than a
   * Map(text → time): a map collapses repeated lines (choruses, doubled
   * hooks) onto one timestamp, so every copy gets the same time. With
   * queues the first occurrence takes the earliest time, the second the
   * next, and repeats keep their real positions.
   *
   * Source priority matters. If the user is coming BACK from a text edit,
   * the work they've done this session wins over whatever was saved to the
   * DB — otherwise nipping back to fix a typo silently reverts every stamp
   * made since the last save.
   */
  const enterSyncMode = () => {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;

    const source = stampedLines.length ? stampedLines : (existingSynced || []);
    const queues = new Map();
    for (const l of source) {
      if (l.time == null) continue;
      const k = norm(l.text);
      if (!k) continue;
      if (!queues.has(k)) queues.set(k, []);
      queues.get(k).push(l.time);
    }
    // Earliest first, so occurrence N gets the Nth-earliest sung time.
    for (const q of queues.values()) q.sort((a, b) => a - b);

    let seq = 0;
    setStampedLines(lines.map((t) => {
      const q = queues.get(norm(t));
      const time = q && q.length ? q.shift() : null;
      seq += 1;
      return { id: nextId(), text: t, time, seq: time == null ? 0 : seq };
    }));
    setSyncIdx(0);
    setStep('sync');
  };

  // Live mirrors for the stamp handler. stampCurrent used to close over
  // syncIdx and currentTime per render — its identity churned with every
  // timeupdate (~4×/s), the keydown listener re-subscribed constantly, and
  // two rapid presses (key auto-repeat, double taps) could both fire against
  // the SAME stale index: one line stamped twice, the next line skipped.
  const syncIdxRef = useRef(0);
  useEffect(() => { syncIdxRef.current = syncIdx; }, [syncIdx]);
  const currentTimeRef = useRef(currentTime);
  useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);

  /**
   * Stamp the current playback time onto the cursor line.
   *
   * Stable identity (empty deps); everything volatile arrives via refs, and
   * the target is validated INSIDE the updater so batched rapid presses each
   * land on a fresh line instead of all resolving against one stale index.
   */
  const stampCurrent = useCallback(() => {
    setStampedLines((prev) => {
      let idx = syncIdxRef.current;
      // If the cursor is out of range or already stamped, a batched earlier
      // press took it — fall forward to the next unstamped line rather than
      // overwriting.
      if (!(idx >= 0 && idx < prev.length) || prev[idx].time !== null) {
        idx = prev.findIndex((l) => l.time === null);
      }
      if (idx === -1) return prev;

      // Derived from `prev`, so StrictMode's double-invoke produces the same
      // value twice instead of incrementing twice.
      const maxSeq = prev.reduce((m, l) => Math.max(m, l.seq || 0), 0);
      const next = [...prev];
      next[idx] = { ...next[idx], time: currentTimeRef.current, seq: maxSeq + 1 };

      // Advance to the next unstamped line BELOW the cursor; only if there
      // is none do we wrap back to fill an earlier gap. Jumping backwards on
      // every stamp is what made syncing feel like it skipped around.
      let target = -1;
      for (let j = idx + 1; j < next.length; j += 1) {
        if (next[j].time === null) { target = j; break; }
      }
      if (target === -1) target = next.findIndex((l) => l.time === null);
      setSyncIdx(target === -1 ? next.length : target);
      return next;
    });
  }, []);

  // Keyboard: space to stamp while in sync mode
  useEffect(() => {
    if (step !== 'sync') return undefined;
    const handler = (e) => {
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        // Held-key auto-repeat would machine-gun the same timestamp onto
        // every remaining line — only real presses count.
        if (!e.repeat) stampCurrent();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [step, stampCurrent]);

  // Auto-scroll to the cursor line — scoped to the container, never bubbles.
  useEffect(() => {
    if (step !== 'sync') return;
    const container = syncContainerRef.current;
    const el = lineElsRef.current[syncIdx];
    if (!container || !el) return;
    const targetTop = el.offsetTop - container.clientHeight / 2 + el.offsetHeight / 2;
    container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
  }, [syncIdx, step]);

  const handleSave = async () => {
    if (!track || !api?.saveLyrics) return;
    setSaving(true);
    // The list is in text order; LRC needs time order. This is the ONLY sort,
    // and it happens on the way out where it can't disturb the editing view.
    const synced = stampedLines.filter((l) => l.time !== null).slice().sort((a, b) => a.time - b.time);
    // Self-heal: identical text within 0.3s of itself is the fingerprint of
    // the old prefill bug (every chorus copy given the same timestamp), not a
    // sung repeat — real repeats are seconds apart. Dropping them here means
    // one re-save repairs lyrics corrupted before the fix.
    const healed = [];
    for (const l of synced) {
      const last = healed[healed.length - 1];
      if (last && last.text === l.text && Math.abs(last.time - l.time) < 0.3) continue;
      healed.push(l);
    }
    const lrcStr = healed.map((l) => {
      const min = Math.floor(l.time / 60);
      const sec = l.time % 60;
      return `[${String(min).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}] ${l.text}`;
    }).join('\n');
    const plainStr = stampedLines.map((l) => l.text).join('\n');
    try {
      await api.saveLyrics({
        title: track.title || '',
        artist: track.artist || '',
        syncedLyrics: lrcStr || null,
        plainLyrics: plainStr || null,
      });
      onSave(parseLRC(lrcStr), plainStr);
    } catch (e) {
      console.error('Failed to save lyrics', e);
    } finally {
      setSaving(false);
    }
  };

  // Quick-save plain only (no sync)
  const handleSavePlainOnly = async () => {
    if (!track || !api?.saveLyrics) return;
    setSaving(true);
    try {
      await api.saveLyrics({
        title: track.title || '',
        artist: track.artist || '',
        syncedLyrics: null,
        plainLyrics: text || null,
      });
      onSave([], text || null);
    } catch (e) {
      console.error('Failed to save lyrics', e);
    } finally {
      setSaving(false);
    }
  };

  /**
   * Undo the most recent stamp — the one with the highest `seq`, which is
   * genuinely the last one made. The old version cleared `syncIdx - 1`,
   * which was only the last stamp when nothing had reordered or been
   * clicked, i.e. rarely.
   */
  const undoLast = () => {
    let best = -1;
    let bestSeq = 0;
    stampedLines.forEach((l, i) => {
      if (l.time !== null && (l.seq || 0) > bestSeq) { bestSeq = l.seq || 0; best = i; }
    });
    if (best === -1) return;
    setStampedLines((prev) => prev.map((l, i) => (i === best ? { ...l, time: null, seq: 0 } : l)));
    setSyncIdx(best);
  };

  /** Clear one line's timestamp. The line does not move. */
  const clearStamp = (i) => {
    setStampedLines((prev) => prev.map((l, j) => (j === i ? { ...l, time: null, seq: 0 } : l)));
    setSyncIdx(i);
  };

  /**
   * Opt-in reorder. Sorting is legitimate when the user asks for it — the
   * problem was only ever doing it silently, mid-edit, under their cursor.
   */
  const sortByTime = () => {
    setStampedLines((prev) => sortStampedLines(prev));
    setSyncIdx(0);
  };

  const stampedCount = stampedLines.filter((l) => l.time !== null).length;
  const allStamped = stampedLines.length > 0 && stampedCount === stampedLines.length;
  const canUndo = stampedCount > 0;

  // Lines whose timestamp is earlier than one above them. Flagged rather
  // than auto-corrected, so the user can see exactly what went wrong.
  const outOfOrder = (() => {
    const flags = new Set();
    let last = -Infinity;
    stampedLines.forEach((l, i) => {
      if (l.time == null) return;
      if (l.time < last) flags.add(i);
      else last = l.time;
    });
    return flags;
  })();

  const pillStyle = (active) => ({
    padding: '5px 12px', borderRadius: 16, border: 'none',
    background: active ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)',
    color: active ? '#fff' : 'rgba(255,255,255,0.5)',
    fontSize: 10.5, fontWeight: 600, cursor: 'pointer',
    transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease, transform 0.15s cubic-bezier(0.16,1,0.3,1)',
  });

  const btnBase = {
    padding: '7px 14px', borderRadius: 10, border: 'none', fontSize: 11, fontWeight: 600,
    cursor: 'pointer', transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease, transform 0.15s cubic-bezier(0.16,1,0.3,1)',
  };

  if (step === 'edit') {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 0 }}>
        {/* Header */}
        <div style={{ padding: '10px 8px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', flex: 1 }}>Edit lyrics</div>
          <button type="button" onClick={onCancel} style={{ ...btnBase, background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.6)', padding: '5px 10px' }}>Cancel</button>
        </div>
        <div style={{ padding: '0 8px 6px', fontSize: 10, color: 'rgba(255,255,255,0.4)', lineHeight: 1.5 }}>
          One line per row. When you're done, tap <strong style={{ color: 'rgba(255,255,255,0.7)' }}>Tap to sync</strong> to add timestamps while the song plays.
          {stampedCount > 0 ? (
            <>
              {' '}
              <span style={{ color: `rgba(${accent},0.9)` }}>
                Your {stampedCount} timestamp{stampedCount === 1 ? '' : 's'} will be kept where the text still matches.
              </span>
            </>
          ) : null}
        </div>

        {/* Textarea */}
        <div style={{ flex: 1, padding: '0 8px', minHeight: 0 }}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'Paste or type lyrics here…\n\nOne line per row.\nEmpty lines are ignored.'}
            spellCheck={false}
            style={{
              width: '100%', height: '100%', boxSizing: 'border-box',
              padding: '12px 14px', borderRadius: 12,
              border: '1px solid rgba(255,255,255,0.08)',
              background: 'rgba(0,0,0,0.35)',
              color: 'rgba(255,255,255,0.85)',
              fontSize: 12.5, lineHeight: 1.7,
              resize: 'none', outline: 'none',
              fontFamily: 'inherit',
              scrollbarWidth: 'thin',
              scrollbarColor: 'rgba(255,255,255,0.15) transparent',
            }}
          />
        </div>

        {/* Actions */}
        <div style={{ padding: '10px 8px 8px', display: 'flex', gap: 6 }}>
          <button type="button" onClick={handleSavePlainOnly} disabled={!text.trim() || saving}
            style={{ ...btnBase, flex: 1, background: 'rgba(255,255,255,0.08)', color: '#fff', opacity: !text.trim() ? 0.4 : 1 }}>
            {saving ? 'Saving…' : 'Save without sync'}
          </button>
          <button type="button" onClick={enterSyncMode} disabled={!text.trim()}
            style={{ ...btnBase, flex: 1, background: `rgba(${accent},0.25)`, color: '#fff', opacity: !text.trim() ? 0.4 : 1 }}>
            Tap to sync →
          </button>
        </div>
      </div>
    );
  }

  // Step 2: Tap-to-sync
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 0, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '10px 8px 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" onClick={() => setStep('edit')} style={{ ...pillStyle(false), display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px' }}>
          <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" /></svg>
          Edit
        </button>
        <div style={{ flex: 1, fontSize: 12, fontWeight: 700, color: '#fff', textAlign: 'center' }}>Tap to sync</div>
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', fontVariantNumeric: 'tabular-nums' }}>
          {stampedCount}/{stampedLines.length}
        </div>
      </div>

      <div style={{ padding: '2px 8px 6px', fontSize: 10, color: 'rgba(255,255,255,0.4)', lineHeight: 1.5, textAlign: 'center' }}>
        Play the song, then tap the button or press <strong style={{ color: 'rgba(255,255,255,0.65)' }}>Space</strong> as each line is sung.
      </div>

      {/* Playback time indicator */}
      <div style={{ padding: '0 8px 6px', textAlign: 'center', fontSize: 11, color: 'rgba(255,255,255,0.5)', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
        {formatTime(currentTime)}
      </div>

      {/* Out-of-order notice — shown instead of silently reordering. */}
      {outOfOrder.size > 0 ? (
        <div style={{
          margin: '0 8px 6px', padding: '6px 9px', borderRadius: 8,
          background: 'rgba(240, 180, 60, 0.10)',
          border: '1px solid rgba(240, 180, 60, 0.28)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <div style={{ flex: 1, fontSize: 10, lineHeight: 1.45, color: 'rgba(240, 200, 130, 0.95)' }}>
            {outOfOrder.size} line{outOfOrder.size === 1 ? ' is' : 's are'} stamped earlier than the line above.
            Saving sorts by time regardless — fix the stamps, or reorder the list.
          </div>
          <button type="button" onClick={sortByTime}
            style={{
              flexShrink: 0, padding: '4px 9px', borderRadius: 7, border: '1px solid rgba(240,180,60,0.35)',
              background: 'rgba(240,180,60,0.14)', color: 'rgba(245,215,150,1)',
              fontSize: 10, fontWeight: 700, cursor: 'pointer',
            }}>
            Sort by time
          </button>
        </div>
      ) : null}

      {/* Lines list */}
      <div ref={syncContainerRef} style={{
        flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '0 4px',
        overscrollBehavior: 'contain',
        scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.12) transparent',
        maskImage: 'linear-gradient(to bottom, #000 0%, #000 90%, transparent 100%)',
        WebkitMaskImage: 'linear-gradient(to bottom, #000 0%, #000 90%, transparent 100%)',
      }}>
        {stampedLines.map((line, i) => {
          const isCurrent = i === syncIdx;
          const isStamped = line.time !== null;
          const isPast = isStamped && i < syncIdx;
          const isBadOrder = outOfOrder.has(i);
          return (
            <div
              // Keyed by stable id, not index. The list no longer reorders,
              // but ids also survive the opt-in "Sort by time" so React moves
              // rows instead of rewriting their contents in place.
              key={line.id}
              ref={(el) => { lineElsRef.current[i] = el; }}
              onClick={(e) => {
                // Plain click on a stamped line: seek audio AND move the sync
                //   cursor here, so you can scrub to a line and carry on.
                // Plain click on an unstamped line: just move the cursor
                //   (there's no timestamp to seek to yet).
                // Shift-click: move the cursor without touching playback.
                setSyncIdx(i);
                if (isStamped && !e.shiftKey && onSeek) onSeek(line.time);
              }}
              title={isStamped
                ? 'Click: resume syncing here (and seek). Shift-click: just move the cursor.'
                : 'Click: resume syncing here.'}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 8,
                padding: '6px 8px', borderRadius: 8,
                background: isCurrent ? `rgba(${accent},0.12)` : 'transparent',
                borderLeft: isCurrent ? `2px solid rgba(${accent},0.7)` : '2px solid transparent',
                transition: 'background 0.2s ease, border-color 0.2s ease, color 0.2s ease',
                cursor: 'pointer',
              }}
            >
              {/* Timestamp badge */}
              <div style={{
                flexShrink: 0, width: 42, fontSize: 9.5, fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
                color: isBadOrder ? 'rgba(240,190,90,0.95)' : isStamped ? 'rgba(29,185,84,0.8)' : 'rgba(255,255,255,0.2)',
                paddingTop: 2, textAlign: 'right',
              }}>
                {isStamped ? formatTime(line.time) : '—:——'}
              </div>

              {/* Line text */}
              <div style={{
                flex: 1, fontSize: 12.5,
                fontWeight: isCurrent ? 600 : 400,
                color: isCurrent ? '#fff' : isPast ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.65)',
                lineHeight: 1.5,
                transition: 'color 0.2s',
              }}>
                {line.text}
              </div>

              {/* Clear button for stamped lines */}
              {isStamped ? (
                <button type="button" onClick={(e) => { e.stopPropagation(); clearStamp(i); }}
                  title="Remove timestamp (the line stays put)"
                  style={{
                    flexShrink: 0, width: 18, height: 18, borderRadius: 9,
                    border: 'none', background: 'rgba(255,255,255,0.06)',
                    color: 'rgba(255,255,255,0.3)', fontSize: 10,
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: 0,
                  }}>
                  ×
                </button>
              ) : null}
            </div>
          );
        })}
        <div style={{ height: 60 }} />
      </div>

      {/* Bottom action bar */}
      <div style={{
        padding: '8px 8px 8px', display: 'flex', gap: 6,
        borderTop: '1px solid rgba(255,255,255,0.06)',
      }}>
        {!allStamped ? (
          <>
            <button type="button" onClick={undoLast} disabled={!canUndo}
              title="Undo the most recent stamp"
              style={{
                ...btnBase, padding: '8px 10px',
                background: 'rgba(255,255,255,0.06)',
                color: canUndo ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.2)',
              }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12.5 8c-2.65 0-5.05 1.04-6.83 2.73L2.5 7.5v9h9l-3.19-3.19C9.8 12.21 11.08 11.5 12.5 11.5c2.65 0 4.88 1.77 5.57 4.19l2.62-.87C19.68 11.17 16.38 8 12.5 8z" /></svg>
            </button>
            {/* Jump to the first unstamped line — handy after clicking around
                to preview lines and wanting to snap back to where syncing
                should resume. */}
            {(() => {
              const firstUnstamped = stampedLines.findIndex((l) => l.time === null);
              const canJump = firstUnstamped !== -1 && firstUnstamped !== syncIdx;
              return (
                <button type="button"
                  onClick={() => { if (firstUnstamped !== -1) setSyncIdx(firstUnstamped); }}
                  disabled={!canJump}
                  title="Jump to next unstamped line"
                  style={{
                    ...btnBase, padding: '8px 10px',
                    background: 'rgba(255,255,255,0.06)',
                    color: canJump ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.2)',
                  }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
              );
            })()}
            <button type="button" onClick={stampCurrent} disabled={syncIdx >= stampedLines.length}
              style={{
                ...btnBase, flex: 1, padding: '10px 14px',
                background: `rgba(${accent},0.3)`,
                color: '#fff', fontSize: 12, fontWeight: 700,
                border: `1px solid rgba(${accent},0.4)`,
                opacity: syncIdx >= stampedLines.length ? 0.4 : 1,
              }}>
              ⏎ Stamp line {syncIdx < stampedLines.length ? syncIdx + 1 : ''}
            </button>
          </>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving}
            style={{
              ...btnBase, flex: 1, padding: '10px 14px',
              background: '#1db954', color: '#000',
              fontSize: 12, fontWeight: 700,
            }}>
            {saving ? 'Saving…' : '✓ Save synced lyrics'}
          </button>
        )}
      </div>

      {/* Allow saving partially stamped */}
      {!allStamped && stampedCount > 0 ? (
        <div style={{ padding: '0 8px 8px' }}>
          <button type="button" onClick={handleSave} disabled={saving}
            style={{
              ...btnBase, width: '100%', padding: '6px 10px',
              background: 'rgba(255,255,255,0.05)',
              color: 'rgba(255,255,255,0.5)', fontSize: 10,
            }}>
            {saving ? 'Saving…' : `Save with ${stampedCount} synced line${stampedCount !== 1 ? 's' : ''}`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Karaoke-style synced lyrics — GPU-translated, no scroll.
 *
 * Past lines dim ~18%, future lines mid-grey, active line full white.
 */
function SyncedLyrics({
  lines, currentTime, accent, onSeek,
  fontSize = 15, lineHeight = 1.55,
  // --- Selection-for-sharing props ---
  // When `selection` is non-null, the panel enters "share-pick" mode:
  //   - Active-line auto-scroll freezes (so the user can read freely
  //     without the active line tugging the view away)
  //   - Clicks on lines extend/contract the highlight instead of seeking
  //   - Selected lines glow with the accent and a left-edge bar
  // Selection shape: { start: number, end: number } where end >= start,
  // both indices into `lines`.
  selection = null,
  onSelectLine,    // (idx) → toggle / extend selection
  onSelectStart,   // (idx) → enter selection mode anchored at idx
}) {
  const containerRef = useRef(null);
  const lineRefs = useRef([]);
  const [offset, setOffset] = useState(0);
  const activeIdx = activeLyricIndex(lines, currentTime);

  // Ensure refs array matches lines length.
  if (lineRefs.current.length !== lines.length) {
    lineRefs.current = Array(lines.length).fill(null);
  }

  const selecting = !!selection;

  // Compute translateY so the active line sits at the vertical center.
  // When the user is picking lines to share we FREEZE the offset — having
  // the lyric column auto-scroll under your finger would make it impossible
  // to select a stable range.
  useEffect(() => {
    if (selecting) return; // hold position while selecting
    const container = containerRef.current;
    // Selection mode scrolls the container NATIVELY (overflow:auto); the
    // normal mode positions via transform and assumes scrollTop === 0.
    // Without this reset, whatever scrollTop the user left behind stacks
    // on top of the transform when selection ends — deep into a song
    // that shoved the lyrics way off (often reading as "scrolled to top").
    if (container && container.scrollTop !== 0) container.scrollTop = 0;
    const el = lineRefs.current[activeIdx];
    if (!container || !el || activeIdx < 0) {
      setOffset(0);
      return;
    }
    const containerH = container.clientHeight;
    const elTop = el.offsetTop;
    const elH = el.offsetHeight;
    setOffset(-(elTop - containerH / 2 + elH / 2));
  }, [activeIdx, lines.length, selecting]);

  // Entering selection mode: transform switches off and native scrolling
  // takes over — hand the current position across so the view doesn't jump.
  useEffect(() => {
    if (!selecting) return;
    const container = containerRef.current;
    if (!container) return;
    const el = lineRefs.current[activeIdx >= 0 ? activeIdx : 0];
    const target = el
      ? el.offsetTop - container.clientHeight / 2 + el.offsetHeight / 2
      : 0;
    container.scrollTop = Math.max(0, target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selecting]);

  // Long-press tracking for entering selection mode. 380ms hold to match
  // the platform feel of a mobile long-press without being so slow that
  // a casual click ever triggers it.
  const pressTimerRef = useRef(null);
  const pressedRef = useRef(null); // {idx, t0, fired}
  const LONG_PRESS_MS = 380;
  const startPress = (idx, e) => {
    // Right-click also opens selection at this line — power-user shortcut.
    if (e && e.button === 2) return; // handled by onContextMenu
    pressedRef.current = { idx, t0: Date.now(), fired: false };
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
    pressTimerRef.current = setTimeout(() => {
      if (pressedRef.current && !pressedRef.current.fired) {
        pressedRef.current.fired = true;
        onSelectStart?.(idx);
      }
    }, LONG_PRESS_MS);
  };
  const endPress = (idx, e) => {
    // Non-left buttons never seek or extend. Right-click's mouseup used to
    // fall through here with a stale `selecting` closure and SEEK the song
    // at the same moment onContextMenu was starting a selection.
    if (e && typeof e.button === 'number' && e.button !== 0) return;
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    // No matching startPress (e.g. the press began as a right-click that
    // startPress ignored) → nothing to act on.
    if (!pressedRef.current) return;
    // If the long-press fired, the click is consumed by selection mode —
    // don't seek. If it didn't fire, this is a normal click.
    if (pressedRef.current.fired) {
      pressedRef.current = null;
      return;
    }
    pressedRef.current = null;
    if (selecting) {
      // In selection mode, taps extend/contract the highlight rather than seeking.
      onSelectLine?.(idx);
    } else {
      onSeek?.(lines[idx]?.time);
    }
  };
  const cancelPress = () => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    pressedRef.current = null;
  };

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        overflow: selecting ? 'auto' : 'hidden',
        scrollbarWidth: 'none',
        position: 'relative',
        maskImage: 'linear-gradient(to bottom, transparent 0%, #000 15%, #000 85%, transparent 100%)',
        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, #000 15%, #000 85%, transparent 100%)',
      }}
    >
      <div
        style={{
          transform: selecting ? 'none' : `translateY(${offset}px)`,
          transition: selecting ? 'none' : 'transform 0.55s cubic-bezier(0.25, 0.1, 0.25, 1)',
          willChange: selecting ? 'auto' : 'transform',
        }}
      >
        {lines.map((line, i) => {
          const isActive = i === activeIdx;
          const isPast = i < activeIdx;
          const isSelected = selecting && i >= selection.start && i <= selection.end;

          let styleColor;
          let styleOpacity;
          let styleWeight;
          if (isSelected) {
            styleColor = '#fff';
            styleOpacity = 1;
            styleWeight = 600;
          } else if (selecting) {
            // While selecting, fade unselected lines uniformly — past/future
            // distinction doesn't matter, the user is composing a share.
            styleColor = 'rgba(255,255,255,0.32)';
            styleOpacity = 0.85;
            styleWeight = 400;
          } else {
            styleColor = isActive ? '#fff' : isPast ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.45)';
            styleOpacity = isActive ? 1 : isPast ? 0.7 : 0.85;
            styleWeight = isActive ? 700 : 400;
          }

          return (
            <div
              key={`${i}-${line.time}`}
              ref={(el) => { lineRefs.current[i] = el; }}
              onMouseDown={(e) => startPress(i, e)}
              onMouseUp={(e) => endPress(i, e)}
              onMouseLeave={cancelPress}
              onTouchStart={() => startPress(i)}
              onTouchEnd={() => endPress(i)}
              onTouchCancel={cancelPress}
              onContextMenu={(e) => { e.preventDefault(); onSelectStart?.(i); }}
              style={{
                position: 'relative',
                padding: '8px 8px 8px 14px',
                fontSize,
                fontWeight: styleWeight,
                lineHeight,
                textAlign: 'left',
                color: styleColor,
                opacity: styleOpacity,
                borderRadius: isSelected ? 8 : 0,
                background: isSelected ? `rgba(${accent},0.18)` : 'transparent',
                textShadow: isActive && !selecting
                  ? `0 0 20px rgba(${accent},0.5), 0 1px 8px rgba(0,0,0,0.3)`
                  : isSelected
                    ? `0 0 18px rgba(${accent},0.35)`
                    : 'none',
                transition: 'color 0.25s ease, opacity 0.25s ease, font-weight 0.25s ease, text-shadow 0.25s ease, background 0.2s ease',
                cursor: 'pointer',
                userSelect: 'none',
                WebkitUserSelect: 'none',
              }}
            >
              {/* Accent bar on the left edge for selected lines — gives the
                  highlight a clean Apple-Music-like marker without depending
                  solely on background colour. */}
              {isSelected ? (
                <span
                  aria-hidden
                  style={{
                    position: 'absolute', left: 2, top: 8, bottom: 8, width: 3,
                    borderRadius: 999,
                    background: `rgb(${accent})`,
                    boxShadow: `0 0 10px rgba(${accent},0.7)`,
                  }}
                />
              ) : null}
              {line.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Plain (unsynced) lyrics — scrollable, left-aligned to match synced style.
 *
 * Supports the same share-selection vocabulary as SyncedLyrics: long-press
 * or right-click a line to enter selection mode, click further lines to
 * extend the range. Blank lines (verse separators) are skipped — selecting
 * them would just be empty space in the share card.
 */
function PlainLyrics(props) {
  // Early return outside the component that calls hooks (see below).
  return props.text ? <PlainLyricsBody {...props} /> : null;
}

function PlainLyricsBody({
  text, fontSize = 13, lineHeight = 1.55,
  accent = '128, 128, 128',
  selection = null,
  onSelectLine,
  onSelectStart,
}) {
  const lines = text.split('\n');
  const selecting = !!selection;

  const pressTimerRef = useRef(null);
  const pressedRef = useRef(null);
  const LONG_PRESS_MS = 380;
  const startPress = (idx, e) => {
    if (e && e.button === 2) return;
    pressedRef.current = { idx, fired: false };
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
    pressTimerRef.current = setTimeout(() => {
      if (pressedRef.current && !pressedRef.current.fired) {
        pressedRef.current.fired = true;
        onSelectStart?.(idx);
      }
    }, LONG_PRESS_MS);
  };
  const endPress = (idx, e) => {
    // Mirror SyncedLyrics: only a left-button release that had a matching
    // tracked press does anything.
    if (e && typeof e.button === 'number' && e.button !== 0) return;
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    if (!pressedRef.current) return;
    if (pressedRef.current.fired) {
      pressedRef.current = null;
      return;
    }
    pressedRef.current = null;
    // Plain lyrics have no seek target, so a quick tap only does anything
    // in selection mode (extend/contract).
    if (selecting) onSelectLine?.(idx);
  };
  const cancelPress = () => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    pressedRef.current = null;
  };

  return (
    <div style={{
      flex: 1,
      overflowY: 'auto',
      overflowX: 'hidden',
      scrollbarWidth: 'none',
      /* No edge fade and no dimming here: unsynced lyrics have no current
         line to bring forward, so every line reads at full strength. Little
         top padding: the "Not synced" note above already spaces it. */
      padding: '2px 8px 24px',
    }}
    >
      {lines.map((line, i) => {
        const isBlank = !line.trim();
        const isSelected = selecting && !isBlank && i >= selection.start && i <= selection.end;
        const dimmed = selecting && !isSelected && !isBlank;
        return (
          <div
            key={i}
            // Blank lines are non-interactive — selecting whitespace is meaningless.
            onMouseDown={isBlank ? undefined : (e) => startPress(i, e)}
            onMouseUp={isBlank ? undefined : (e) => endPress(i, e)}
            onMouseLeave={cancelPress}
            onTouchStart={isBlank ? undefined : () => startPress(i)}
            onTouchEnd={isBlank ? undefined : () => endPress(i)}
            onTouchCancel={cancelPress}
            onContextMenu={isBlank ? undefined : (e) => { e.preventDefault(); onSelectStart?.(i); }}
            style={{
              position: 'relative',
              padding: '4px 8px 4px 14px',
              fontSize,
              fontWeight: isSelected ? 600 : 400,
              lineHeight,
              textAlign: 'left',
              color: isBlank
                ? 'transparent'
                : isSelected
                  ? '#fff'
                  : dimmed
                    ? 'rgba(255,255,255,0.3)'
                    : 'rgba(255,255,255,0.9)',
              background: isSelected ? `rgba(${accent},0.18)` : 'transparent',
              borderRadius: isSelected ? 8 : 0,
              minHeight: isBlank ? 10 : undefined,
              cursor: isBlank ? 'default' : 'pointer',
              userSelect: 'none',
              WebkitUserSelect: 'none',
              transition: 'color 0.2s, background 0.2s, font-weight 0.2s',
            }}
          >
            {isSelected ? (
              <span
                aria-hidden
                style={{
                  position: 'absolute', left: 2, top: 4, bottom: 4, width: 3,
                  borderRadius: 999,
                  background: `rgb(${accent})`,
                  boxShadow: `0 0 10px rgba(${accent},0.7)`,
                }}
              />
            ) : null}
            {line.trim() || '\u00A0'}
          </div>
        );
      })}
    </div>
  );
}

export { LyricsEditor, SyncedLyrics, PlainLyrics };
