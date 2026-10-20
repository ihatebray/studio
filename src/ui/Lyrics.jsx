import React, { useState, useEffect, useRef } from 'react';
import { activeLyricIndex } from '../lib/mediaUtils.js';

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
  activeColor = null, // "r, g, b": the playing line in this colour instead of white
}) {
  const containerRef = useRef(null);
  const lineRefs = useRef([]);
  const [offset, setOffset] = useState(0);
  /* The line can only step back for a real seek. A clock that wobbles back
     a few tenths of a second (a late position report) would otherwise
     light the previous line again for a moment and bounce the view. */
  const rawIdx = activeLyricIndex(lines, currentTime);
  const held = useRef({ idx: -1, time: 0, lines: null });
  let activeIdx = rawIdx;
  if (held.current.lines === lines && rawIdx < held.current.idx && held.current.time - currentTime < 0.5) activeIdx = held.current.idx;
  held.current = { idx: activeIdx, time: Math.max(currentTime, activeIdx === held.current.idx ? held.current.time : 0), lines };

  // Ensure refs array matches lines length.
  if (lineRefs.current.length !== lines.length) {
    lineRefs.current = Array(lines.length).fill(null);
  }

  const selecting = !!selection;

  // Compute translateY so the active line sits at the vertical center.
  // When the user is picking lines to share we FREEZE the offset — having
  // the lyric column auto-scroll under your finger would make it impossible
  // to select a stable range.
  const [boxH, setBoxH] = useState(0);
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return undefined;
    const ro = new ResizeObserver(() => setBoxH(c.clientHeight));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);
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
  }, [activeIdx, lines.length, selecting, boxH]);

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
            styleColor = isActive ? (activeColor ? `rgb(${activeColor})` : '#fff') : isPast ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.45)';
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
              {/* The line's height is set by an invisible bold copy of it,
                  so turning bold when it plays (or back when it's done)
                  can't make it wrap differently and shift the lines around
                  it. That shift, after the centering offset was already
                  measured, is what made the lyrics give a little bounce. */}
              <span style={{ display: 'grid' }}>
                <span aria-hidden style={{ gridArea: '1 / 1', visibility: 'hidden', fontWeight: 700 }}>{line.text}</span>
                <span style={{ gridArea: '1 / 1' }}>{line.text}</span>
              </span>
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

export { SyncedLyrics, PlainLyrics };
