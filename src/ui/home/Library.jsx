import React, { useCallback, useEffect, useRef, useState } from 'react';
import { formatTime } from '../../lib/mediaUtils.js';
import { hoverPreload } from '../../lib/spotifyMediaElement.js';
import { CompactVizSlot } from '../CompactVisualizer.jsx';
import { ExplicitBadge, PlayIcon } from '../sharedUI.jsx';
import { PauseGlyph, PlayGlyph, PlayingBars } from './common.jsx';
import { SORT_LABELS } from './constants.js';

/* =========================================================================
 *  Pieces
 * ========================================================================= */


/** A titled section on the Home dashboard, with a "view all →" affordance. */






function ImportMenuItem({ label, hint, onClick }) {
  const [h, setH] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: '7px 9px', borderRadius: 8, border: 'none', cursor: 'pointer',
        background: h ? 'rgba(var(--st-fg-rgb), 0.08)' : 'transparent',
        transition: 'background 0.13s ease',
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--st-text)' }}>{label}</div>
      <div style={{ fontSize: 10, color: 'rgba(var(--st-sub-rgb), 0.42)', marginTop: 1 }}>{hint}</div>
    </button>
  );
}

/**
 * The header every library view wears.
 *
 * Replaces three near-identical blocks that each stacked an eyebrow, a 44px
 * title and a profile row — about 120px spent before any music appeared, on a
 * page whose whole job is showing music. It also put your name and a song
 * count in the same sentence, which are unrelated facts.
 *
 * One 52px row instead: what you're looking at, how much of it there is, and
 * the things you can do to it. The eyebrow is gone because the sidebar already
 * says Library, and the title shrinks to list-item scale because you just
 * clicked the tab that says the same word.
 *
 * Search now appears on EVERY view. It only rendered on Songs before, while
 * the filter it writes to was shared by all three — so a query typed in Songs
 * quietly filtered Albums with no visible box to explain why.
 */
/**
 * The active filter, shown only while there IS one.
 *
 * There's no search control here any more — not a bar, not an icon. Queries
 * are typed in the palette and Enter hands them over. What can't go away is
 * the STATE: a table showing eight of your four hundred songs, with nothing
 * on screen explaining why, reads as a library that has lost songs. That is
 * a worse bug than the clutter this replaces.
 *
 * So it renders nothing at rest and appears filled when a filter arrives.
 * It stays a live input rather than a static chip because refining a filter
 * you can already see ("keshi" to "keshi d") shouldn't need a round trip
 * back out to the palette.
 */
/**
 * Search: an icon at rest, a field once you open it.
 *
 * Open state is derived, not just stored — `open || !!filter` — so a view that
 * arrives with a filter already applied (switching tabs, restoring a session)
 * shows the query rather than an innocent-looking icon hiding an active
 * filter. That was the real hazard in the always-collapsed version: a list
 * silently showing a subset with nothing on screen to say so.
 *
 * Closing on blur only happens when the field is empty. Blurring away from a
 * typed query would either discard it or hide it, and both are worse than
 * leaving the field open.
 */
function LibFilterTag({ filter, onFilter, label = 'Search' }) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);
  const expanded = open || !!filter;

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  /* Blur on the way out. Without it focus stays on an input that is now
     clipped to zero width and tabIndex -1 — invisible, unreachable by tab,
     and still holding the caret. */
  const close = useCallback(() => {
    setOpen(false);
    onFilter('');
    inputRef.current?.blur();
  }, [onFilter]);

  return (
    <div className={`sth-libtag${expanded ? ' is-open' : ''}${filter ? ' is-on' : ''}`}>
      <button
        type="button"
        className="sth-libtag-btn"
        aria-label={expanded ? label : `${label} — open`}
        aria-expanded={expanded}
        title={label}
        onClick={() => {
          if (expanded) inputRef.current?.focus();
          else setOpen(true);
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.8-3.8" />
        </svg>
      </button>
      <input
        ref={inputRef}
        type="text"
        className="sth-libtag-in"
        value={filter}
        aria-label={label}
        placeholder={label}
        /* Unreachable by keyboard while collapsed — it's clipped, not hidden,
           so without this you could tab into an invisible field. */
        tabIndex={expanded ? 0 : -1}
        onChange={(e) => onFilter(e.target.value)}
        onBlur={() => { if (!filter) setOpen(false); }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          close();
        }}
      />
      {filter ? (
        <button type="button" className="sth-libtag-x" title="Clear search (esc)" aria-label="Clear search"
          onClick={close}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      ) : null}
    </div>
  );
}

/**
 * Sort picker for the songs table.
 *
 * A menu rather than a button that cycles: with four options, cycling makes
 * you click through the ones you don't want and never shows you what's
 * available. The current order is in the label, so the control reports state
 * as well as setting it.
 */
function LibSortMenu({ value, field, onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button type="button" className="sth-libact" onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu" aria-expanded={open}
        title="Change sort order"
        style={{ whiteSpace: 'nowrap' }}>
        <span className="sth-libact-label">{SORT_LABELS[field] || 'Title'}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open ? (
        <div role="menu" className="sth-libsortmenu">
          {Object.keys(SORT_LABELS).map((k) => (
            <button key={k} type="button" role="menuitemradio" aria-checked={field === k}
              className={`sth-libsortitem${field === k ? ' is-on' : ''}`}
              onClick={() => { onPick(k); setOpen(false); }}>
              {SORT_LABELS[k]}
            </button>
          ))}
          {/* Only offered once you've overridden — "follow the view" isn't a
              sort you pick, it's the absence of one. */}
          {value ? (
            <button type="button" role="menuitem" className="sth-libsortitem sth-libsortitem-reset"
              onClick={() => { onPick(null); setOpen(false); }}>
              Match the view
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function LibHeader({
  title, meta, filter, onFilter, searchPlaceholder,
  onPlayAll, onShuffle, sortValue, sortField, onPickSort, 
  onImportFiles, onImportFolder, onImportSpotify, importing = false,
}) {
  const [importOpen, setImportOpen] = useState(false);
  const canImport = !!(onImportFiles || onImportFolder || onImportSpotify);
  /* Two tiers only when the second one earns its height. Albums and Artists
     pass no playback or sort handlers, so theirs would carry a lone search
     icon — a row of reserved space with one thing in it. */
  const hasControls = !!(onPlayAll || onShuffle || onPickSort);

  return (
    <div className={`sth-libhead${hasControls ? '' : ' is-single'}`}>
      {/* Tier one — what this is. */}
      <span className="sth-libhead-tw">
        <span className="sth-libhead-t">{title}</span>
        {meta ? <span className="sth-libhead-m">{meta}</span> : null}
      </span>

      {!hasControls ? (
        <>
          <CompactVizSlot />
          <LibFilterTag filter={filter} onFilter={onFilter} label={searchPlaceholder} />
          {/* Also on the single-tier branch. Albums and Artists pass no
              playback or sort handlers and so take this path — without it,
              "Add" appeared in Songs and silently vanished in the other two
              views, which reads as a bug rather than a layout. */}
          {canImport ? (
            <LibImportMenu
              open={importOpen} onOpen={setImportOpen} importing={importing}
              onImportFiles={onImportFiles} onImportFolder={onImportFolder} onImportSpotify={onImportSpotify}
            />
          ) : null}
        </>
      ) : (
      /* Tier two — what you can do to it.
         Playback anchored left, list controls anchored right. Both ends are
         pinned, so the space between them can grow to any width without
         reading as a hole — that's the property single-row never had. */
      <span className="sth-libhead-r2">
        {onPlayAll ? (
          <button type="button" className="sth-libact sth-libact-primary" onClick={onPlayAll} style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
            <PlayIcon size={13} />
            <span className="sth-libact-label">Play all</span>
          </button>
        ) : null}
        {onShuffle ? (
          <button type="button" className="sth-libact" onClick={onShuffle} style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
            </svg>
            <span className="sth-libact-label">Shuffle</span>
          </button>
        ) : null}

        {/* The empty middle; in compact mode, the visualizer if one is picked. */}
        <CompactVizSlot />

        <LibFilterTag filter={filter} onFilter={onFilter} label={searchPlaceholder} />
        {onPickSort ? (
          <LibSortMenu value={sortValue} field={sortField} onPick={onPickSort} />
        ) : null}
        {canImport ? (
          <LibImportMenu
            open={importOpen} onOpen={setImportOpen} importing={importing}
            onImportFiles={onImportFiles} onImportFolder={onImportFolder} onImportSpotify={onImportSpotify}
          />
        ) : null}
      </span>
      )}
    </div>
  );
}

/**
 * Import menu for the library header.
 *
 * This is a restoration as much as an addition. The only import UI in the
 * app lived in LibPanelHeader, which nothing renders — so onImportFiles and
 * onImportFolder were threaded all the way down from App.jsx to a dead
 * component, and adding music by any route other than dragging it onto the
 * window was impossible. Putting the menu on the live header fixes that and
 * gives the Spotify importer somewhere to hang.
 */
function LibImportMenu({ open, onOpen, importing, onImportFiles, onImportFolder, onImportSpotify }) {
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button type="button" className="sth-libact" onClick={() => onOpen(!open)} disabled={importing}
        title="Import music" aria-label="Import music" aria-haspopup="menu" aria-expanded={open}
        style={{ flexShrink: 0, whiteSpace: 'nowrap', opacity: importing ? 0.5 : 1 }}>
        {importing ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M12 3a9 9 0 1 0 9 9">
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite" />
            </path>
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
        )}
        <span className="sth-libact-label">Import</span>
      </button>
      {open && !importing ? (
        <>
          {/* Click-away catcher rather than a document listener — a listener
              here has to dodge the button's own click, which is where that
              pattern usually goes wrong. */}
          <div onClick={() => onOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div role="menu" style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 41,
            minWidth: 196, padding: 5, borderRadius: 11,
            background: 'rgb(18, 18, 21)',
            border: '1px solid rgba(var(--st-fg-rgb), 0.1)',
            boxShadow: '0 14px 38px rgba(0,0,0,0.6)',
          }}>
            {onImportFiles ? (
              <ImportMenuItem label="Import files…" hint="Pick individual tracks"
                onClick={() => { onOpen(false); onImportFiles(); }} />
            ) : null}
            {onImportFolder ? (
              <ImportMenuItem label="Import folder…" hint="Scans subfolders too"
                onClick={() => { onOpen(false); onImportFolder(); }} />
            ) : null}
            {/* Ruled off: the two above read files you already have, this one
                goes and fetches them. Same menu because it's the same intent
                — get music into studio — but not the same operation. */}
            {onImportSpotify ? (
              <>
                {(onImportFiles || onImportFolder) ? (
                  <div style={{ height: 1, background: 'rgba(var(--st-fg-rgb), 0.07)', margin: '4px 6px' }} />
                ) : null}
                <ImportMenuItem label="From Spotify…" hint="Pick a playlist, choose tracks"
                  onClick={() => { onOpen(false); onImportSpotify(); }} />
              </>
            ) : null}
            <div style={{
              padding: '7px 9px 4px', fontSize: 10, lineHeight: 1.45,
              color: 'rgba(var(--st-sub-rgb), 0.35)',
              borderTop: '1px solid rgba(var(--st-fg-rgb), 0.07)', marginTop: 4,
            }}>
              Or drag files and folders anywhere onto the window.
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The play control that replaces a row's index on hover.
 *
 * It has to answer "what will clicking do", and for the row that's currently
 * playing the answer is pause — every row was hard-coded to a play triangle
 * that restarted the track instead. Three different row layouts each drew
 * their own copy of this, which is how they all had the same bug; there's one
 * copy now.
 *
 * The row being CURRENT and the row being AUDIBLE are different questions:
 * the current track paused shows play (clicking resumes), and only the
 * current track actually playing shows pause.
 */
export function RowPlayButton({ playing, isPlaying, title, onPlay, onTogglePlay, style }) {
  const showPause = playing && isPlaying;
  const label = showPause ? 'Pause' : 'Play';
  return (
    <button
      type="button"
      className="sth-lrow-play"
      style={style}
      onClick={(e) => {
        e.stopPropagation();
        // Resuming or pausing the current track must not restart it.
        if (playing && onTogglePlay) onTogglePlay();
        else onPlay();
      }}
      title={label}
      aria-label={title ? `${label} ${title}` : label}
    >
      {showPause ? <PauseGlyph size={12} /> : <PlayGlyph size={12} />}
    </button>
  );
}

export const LibRow = React.memo(function LibRow({ t, index, playing, isPlaying, acc, art, added, canManage, onPlay, onTogglePlay, onMenu,
  onOpenArtist, onOpenAlbum,
}) {
  return (
    <div
      className={`sth-lrow${playing ? ' is-playing' : ''}`}
      onDoubleClick={() => onPlay(t)}
      onContextMenu={canManage ? (e) => onMenu(e, t) : undefined}
    >
      <div className="sth-lrow-n" {...hoverPreload(t)}>
        {playing
          ? <PlayingBars acc={acc} playing={isPlaying} />
          : <span className="sth-lrow-num">{index + 1}</span>}
        <RowPlayButton
          playing={playing} isPlaying={isPlaying} title={t.title}
          onPlay={() => onPlay(t)} onTogglePlay={onTogglePlay}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <div style={{ width: 38, height: 38, borderRadius: 5, flexShrink: 0, background: art ? `url("${art}") center/cover` : 'rgba(var(--st-fg-rgb), 0.08)' }} />
        <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: playing ? `rgb(${acc})` : '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
          {t.explicit ? <ExplicitBadge /> : null}
        </div>
      </div>
      {/* Artist and album are navigation, not decoration.
          Buttons rather than divs with onClick: these are the only way to
          reach a record from the songs list, and a mouse-only route there
          would be no route at all for anyone tabbing. stopPropagation keeps
          a click off the row's own play/select behaviour — the row still
          plays on double-click, the cell still navigates on single. */}
      <div className="sth-lrow-dim" style={{ minWidth: 0 }}>
        {onOpenArtist && t.artist ? (
          <button type="button" className="sth-lcell-link"
            onClick={(e) => { e.stopPropagation(); onOpenArtist(t); }}
            onDoubleClick={(e) => e.stopPropagation()}
            title={`Go to ${t.artist}`}>
            {t.artist}
          </button>
        ) : t.artist}
      </div>
      <div className="sth-lrow-dim sth-lcol-album" style={{ minWidth: 0 }}>
        {onOpenAlbum && t.album ? (
          <button type="button" className="sth-lcell-link"
            onClick={(e) => { e.stopPropagation(); onOpenAlbum(t); }}
            onDoubleClick={(e) => e.stopPropagation()}
            title={`Go to ${t.album}`}>
            {t.album}
          </button>
        ) : t.album}
      </div>
      <div className="sth-lrow-dim sth-lcol-date">{added}</div>
      {/* Centred in its track, matching the clock in the header. Right-aligned
          with 6px padding put the digits' visual mass left of the icon above
          them, because the icon is 13px wide and "3:26" is nearer 28 — both
          ended at the same x, which is not the same as looking aligned. */}
      <div className="sth-lrow-dim" style={{ textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{formatTime(t.duration)}</div>
      <div>
        {canManage ? (
          <button type="button" className="sth-lrow-more" onClick={(e) => onMenu(e, t)} title="More" aria-label="More">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
          </button>
        ) : null}
      </div>
    </div>
  );
});

export function DetailAction({ title, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        width: 30, height: 30, borderRadius: 8, border: 'none', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'transparent', color: 'rgba(var(--st-sub-rgb), 0.62)',
        transition: 'color 0.15s ease, background 0.15s ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.background = 'rgba(var(--st-fg-rgb), 0.09)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(var(--st-fg-rgb), 0.62)'; e.currentTarget.style.background = 'transparent'; }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

export function PanelLabel({ children, inset = false }) {
  return (
    <div style={{
      fontSize: 9.5, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase',
      color: 'rgba(var(--st-sub-rgb), 0.4)', padding: inset ? '18px 0 8px' : '10px 9px 6px',
    }}>{children}</div>
  );
}
