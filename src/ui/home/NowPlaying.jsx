import React, { useEffect, useMemo, useRef, useState } from 'react';
import { accentTextColor, readableAccent } from '../../lib/coverTheme.js';
import { formatTime, getFileFormatLabel, parseGenres } from '../../lib/mediaUtils.js';
import PanelLyricsEditor from '../PanelLyricsEditor.jsx';
import VolumeControl from '../VolumeControl.jsx';
import { AnimatedGradientBg } from '../VisualEffects.jsx';
import { PauseIcon, PlayIcon } from '../sharedUI.jsx';
import { PlainLyrics, SyncedLyrics } from '../Lyrics.jsx';
import { NP_FULL_TABS, NP_PANEL_TABS, NP_PANEL_W } from './constants.js';
import { PanelLabel } from './Library.jsx';
import { PauseGlyph, PlayGlyph, PlayingBars, toolBtn } from './common.jsx';

export function NowPlayingFullView({
  track, art, accent, isPlaying = false, currentTime = 0, onSeek,
  onTogglePlay, onPrev, onNext, shuffleOn = false, repeat = 'off', onToggleShuffle, onToggleRepeat,
  volume = 1, onSetVolume, gainBoost = 1, onSetGainBoost, getGainReduction = null, onToggleFavorite, onAddToPlaylist, onMore,
  onCopyLink, copyBusy = false, onZoomCover,
  animatedBg = false, immersePalette = null,
  tab = null, onTab, onClose,
  coverFor, upNext = [], onSelectTrack, onReorderQueue, queueOffset = 0,
  lyricsData, onLyricsSaved, onBrowseLyrics,
  lyricSelection = null, onLyricSelectStart, onLyricSelectLine,
  artistInfo, credits,
}) {
  const acc = readableAccent(accent);
  const dur = Number.isFinite(track.duration) && track.duration > 0 ? track.duration : 0;

  /* Scrubbing — same contract as the bar: follow the pointer while held,
     seek once on release. */
  const [scrub, setScrub] = useState(null);
  const seekRef = useRef(null);
  const posFrom = (x) => {
    const el = seekRef.current; if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (x - r.left) / r.width));
  };
  const beginScrub = (e) => {
    if (!onSeek || !dur) return;
    e.preventDefault();
    setScrub(posFrom(e.clientX));
    const move = (ev) => setScrub(posFrom(ev.clientX));
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setScrub(null);
      onSeek(posFrom(ev.clientX) * dur);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onSeekKey = (e) => {
    if (!onSeek || !dur) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); onSeek(Math.min(dur, currentTime + 5)); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); onSeek(Math.max(0, currentTime - 5)); }
  };
  const shownTime = scrub != null ? scrub * dur : currentTime;
  const pct = dur ? Math.min(100, Math.max(0, (shownTime / dur) * 100)) : 0;
  const fmt = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  };


  const gradBase = immersePalette?.accent || accent;
  const gradMid = immersePalette?.mid || gradBase.split(',').map((n) => Math.round(Number(n) * 0.82)).join(', ');
  const gradWash = immersePalette?.wash || gradBase.split(',').map((n) => Math.round(Number(n) * 0.45)).join(', ');

  const meta2 = [track.artist, track.album].filter(Boolean);

  return (
    <div className={`sth-full${tab ? ' has-panel' : ''}`} role="dialog" aria-modal="true" aria-label="Now playing, fullscreen">
      {/* Backdrop: Immerse's moving gradient when that's on, otherwise the
          artwork blurred under a scrim — the dock's cover treatment, scaled
          up. Both sit behind everything and take no pointer events. */}
      {animatedBg ? (
        <div aria-hidden className="sth-full-bg">
          <AnimatedGradientBg accent={gradBase} mid={gradMid} wash={gradWash} coverUrl={art} isPlaying={isPlaying} vignette={false} brightness={1} />
        </div>
      ) : art ? (
        <div aria-hidden className="sth-full-bg" style={{
          inset: -80, backgroundImage: `url("${art}")`, backgroundSize: 'cover', backgroundPosition: 'center',
          filter: 'blur(80px) saturate(1.6)', opacity: 0.55,
        }} />
      ) : null}
      <div aria-hidden className="sth-full-bg" style={{
        background: `linear-gradient(180deg, rgba(0,0,0,0.30) 0%, rgba(0,0,0,0.46) 55%, rgba(0,0,0,0.62) 100%), linear-gradient(135deg, rgba(${acc},0.10), transparent 60%)`,
      }} />

      {/* ---- Top strip: drag region, panel tabs, exit ---- */}
      <div className="sth-full-top">
        <span className="sth-full-eyebrow">Now playing</span>
        <span style={{ flex: 1 }} />
        <div className="sth-full-tabs" role="tablist" aria-label="Side panel">
          {NP_FULL_TABS.map(([id, label, key]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id}
              className={`sth-full-tab${tab === id ? ' on' : ''}`}
              onClick={() => onTab?.(id)} title={`${label} (${key})`}>
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="sth-npbtn sth-full-exit" onClick={onClose}
          title="Exit fullscreen (Esc)" aria-label="Exit fullscreen">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
          </svg>
        </button>
      </div>

      <div className="sth-full-body">
        {/* ---- Stage: cover, song, transport — centred ---- */}
        <section className="sth-full-stage">
          {art && onZoomCover ? (
            <button type="button" className="sth-full-cover" onClick={() => onZoomCover(art)}
              title="View cover art" aria-label="View cover art full size"
              style={{ backgroundImage: `url("${art}")`, cursor: 'zoom-in' }} />
          ) : (
            <div className="sth-full-cover" style={{ backgroundImage: art ? `url("${art}")` : undefined }} />
          )}

          <div className="sth-full-meta">
            {onCopyLink ? (
              <button type="button" className="sth-full-title is-link" onClick={() => onCopyLink(track)} disabled={copyBusy}
                title={copyBusy ? 'Looking up on Spotify…' : 'Click to copy Spotify link'}
                aria-label={`Copy Spotify link for ${track.title}`}>{track.title}</button>
            ) : (
              <div className="sth-full-title">{track.title}</div>
            )}
            {meta2.length ? <div className="sth-full-sub" title={meta2.join(' · ')}>{meta2.join(' · ')}</div> : null}
          </div>

          <div className="sth-full-scrub">
            <span className="sth-npbar-t st-num" style={{ textAlign: 'right' }}>{fmt(shownTime)}</span>
            <div className="sth-npbar-seek" ref={seekRef}
              onPointerDown={onSeek && dur ? beginScrub : undefined} onKeyDown={onSeekKey}
              role="slider" aria-label="Seek" tabIndex={0}
              aria-valuemin={0} aria-valuemax={Math.round(dur) || 0} aria-valuenow={Math.round(shownTime)}
              aria-valuetext={`${fmt(shownTime)} of ${fmt(dur)}`}>
              <div className="sth-npbar-seek-fill" style={{ width: `${pct}%`, transition: scrub != null ? 'none' : 'width 0.25s linear' }}>
                <span className="sth-npbar-seek-knob" />
              </div>
            </div>
            <span className="sth-npbar-t st-num">{fmt(dur)}</span>
          </div>

          <div className="sth-full-transport">
            {onToggleShuffle ? (
              <button type="button" className={`sth-npbtn${shuffleOn ? ' is-on' : ''}`} onClick={onToggleShuffle}
                title={shuffleOn ? 'Shuffle on' : 'Shuffle off'} aria-label="Shuffle" aria-pressed={shuffleOn}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 3h5v5" /><path d="M4 20L21 3" /><path d="M21 16v5h-5" /><path d="M15 15l6 6" /><path d="M4 4l5 5" />
                </svg>
              </button>
            ) : null}
            {onPrev ? (
              <button type="button" className="sth-npbtn sth-full-skip" onClick={onPrev} title="Previous" aria-label="Previous">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
              </button>
            ) : null}
            {onTogglePlay ? (
              <button type="button" className="sth-full-play" onClick={onTogglePlay}
                title={isPlaying ? 'Pause' : 'Play'} aria-label={isPlaying ? 'Pause' : 'Play'}>
                {isPlaying ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
              </button>
            ) : null}
            {onNext ? (
              <button type="button" className="sth-npbtn sth-full-skip" onClick={onNext} title="Next" aria-label="Next">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7" /></svg>
              </button>
            ) : null}
            {onToggleRepeat ? (
              <button type="button" className={`sth-npbtn${repeat !== 'off' ? ' is-on' : ''}`} onClick={onToggleRepeat}
                title={repeat === 'one' ? 'Repeat this track' : repeat === 'all' ? 'Repeat queue' : 'Repeat off'}
                aria-label={repeat === 'one' ? 'Repeat: this track' : repeat === 'all' ? 'Repeat: queue' : 'Repeat: off'} aria-pressed={repeat !== 'off'}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
                  <polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
                  {repeat === 'one' ? <text x="12" y="15" textAnchor="middle" fontSize="9" fontWeight="700" fill="currentColor" stroke="none">1</text> : null}
                </svg>
              </button>
            ) : null}
          </div>

          <div className="sth-full-actions">
            {onToggleFavorite ? (
              <button type="button" className={`sth-npbtn${track.isFavorite ? ' is-on' : ''}`} onClick={() => onToggleFavorite(track.id)}
                title={track.isFavorite ? 'Remove from favourites' : 'Add to favourites'}
                aria-label={track.isFavorite ? 'Remove from favourites' : 'Add to favourites'} aria-pressed={!!track.isFavorite}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill={track.isFavorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20.8 8.6a5 5 0 0 0-8.8-2.6A5 5 0 0 0 3.2 8.6c0 4.2 5.5 7.6 8.8 10.4 3.3-2.8 8.8-6.2 8.8-10.4z" />
                </svg>
              </button>
            ) : null}
            {onAddToPlaylist ? (
              <button type="button" className="sth-npbtn" onClick={(e) => onAddToPlaylist(e, track)}
                title="Add to playlist" aria-label="Add to playlist" aria-haspopup="menu">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="8.5" /><path d="M12 8.5v7M8.5 12h7" />
                </svg>
              </button>
            ) : null}
            {onMore ? (
              <button type="button" className="sth-npbtn" onClick={(e) => onMore(e, track)}
                title="More" aria-label="More actions" aria-haspopup="menu">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                  <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
                </svg>
              </button>
            ) : null}
            {onSetVolume ? (
              <>
                <span aria-hidden className="sth-npbtn-rule" />
                <VolumeControl volume={volume} onSetVolume={onSetVolume} width={96}
                  boost={gainBoost} onSetBoost={onSetGainBoost} getGainReduction={getGainReduction} />
              </>
            ) : null}
          </div>
        </section>

        {/* ---- Panel: lyrics / queue / info ---- */}
        {tab ? (
          <aside className="sth-full-panel" aria-label={tab === 'lyrics' ? 'Lyrics' : tab === 'queue' ? 'Queue' : 'Info'}>
            {tab === 'queue' ? (
              <QueueTab current={track} upNext={upNext} acc={acc} coverFor={coverFor}
                onSelectTrack={onSelectTrack} currentTime={currentTime} isPlaying={isPlaying}
                onReorder={onReorderQueue} queueOffset={queueOffset} />
            ) : tab === 'lyrics' ? (
              <LyricsTab lyricsData={lyricsData} onLyricsSaved={onLyricsSaved} track={track}
                onBrowseLyrics={onBrowseLyrics}
                selection={lyricSelection} onSelectStart={onLyricSelectStart} onSelectLine={onLyricSelectLine}
                currentTime={currentTime} accent={accent} onSeek={onSeek} />
            ) : (
              <InfoTab track={track} art={art} artistInfo={artistInfo} credits={credits} />
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

export function NowPlayingPanelDock({
  open, tab, onTab, onClose,
  track, art, accent, coverFor,
  surface = 'cover', barWash = null, customColor = null, immersePalette = null,
  upNext = [], onSelectTrack,
  lyricsData, onLyricsSaved, onBrowseLyrics,
  lyricSelection = null, onLyricSelectStart, onLyricSelectLine,
  currentTime = 0, isPlaying = false, onSeek, onExpand,
  onReorderQueue, queueOffset = 0,
  artistInfo, credits,
}) {
  if (!open) return null;
  const acc = readableAccent(accent);

  return (
    <aside style={{
      /* Inset to match .sth-scroll's BOX, not the window.
         This is mounted at StudioHome's root — a sibling of the top bar, not a
         child of the content column — so `top: 0` was the top of the app and
         the panel ran up behind the tabs. The wrapper it should line up with
         starts at TOPBAR_H + the column's 4px padding, and ends 104px from the
         bottom (the Now Playing bar's clearance). */
      position: 'absolute', top: 'var(--shell-top, 62px)', right: 'var(--gutter)', bottom: 'var(--np-reserve)', width: NP_PANEL_W,
      zIndex: 5, display: 'flex', flexDirection: 'column',
      borderRadius: 'var(--r-card)', overflow: 'hidden',
      /* `bar` paints the Now Playing bar's own colour, undimmed, so the two
         surfaces are the same. The cover treatment below is a blurred photo
         under a 52-62% black scrim, which is why it always landed darker than
         the bar however bright the artwork was. */
      background: surface === 'custom' && customColor
        ? `rgb(${customColor})`
        : (surface === 'bar' && barWash ? `rgb(${barWash})` : '#0a0a0b'),
      transition: 'background 0.5s ease',
      animation: 'sthPanelIn 0.26s cubic-bezier(0.22,1,0.3,1) both',
    }}>
      {/* Cover wash — the same treatment the popouts had, which is what stops
          this reading as a flat card bolted to the side. */}
      {surface === 'immerse' && art ? (
        <div aria-hidden style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}>
          <AnimatedGradientBg
            accent={immersePalette?.accent || acc}
            mid={immersePalette?.mid || acc}
            wash={immersePalette?.wash || acc}
            coverUrl={art} isPlaying vignette={false} brightness={1}
          />
        </div>
      ) : null}
      {/* Just enough to hold text, and only down the left where it sits. */}
      {surface === 'immerse' ? (
        <div aria-hidden style={{
          position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
          background: 'linear-gradient(180deg, rgba(0,0,0,0.34) 0%, rgba(0,0,0,0.14) 26%, rgba(0,0,0,0.30) 100%)',
        }} />
      ) : null}

      {art && surface === 'cover' ? (
        <div aria-hidden style={{
          position: 'absolute', inset: -60, zIndex: 0, pointerEvents: 'none',
          backgroundImage: `url("${art}")`, backgroundSize: 'cover', backgroundPosition: 'center',
          filter: 'blur(64px) saturate(1.7)', opacity: 0.5,
        }} />
      ) : null}
      {surface === 'cover' ? (
        <div aria-hidden style={{
          position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
          /* Was rgba(0,0,0,0.84) at the bottom, which drained the cover colour
             away to flat black over the lower two-thirds. Held at 0.62 with a
             faint accent underneath so the tint carries the full height. */
          background: `linear-gradient(165deg, rgba(${acc},0.16) 0%, rgba(0,0,0,0.52) 38%, rgba(0,0,0,0.62) 100%), linear-gradient(180deg, rgba(${acc},0.05), rgba(${acc},0.10))`,
        }} />
      ) : null}
      {/* On the bar surface the only overlay is a whisper of depth — anything
          heavier reintroduces the very gap this option exists to close. */}
      {(surface === 'bar' && barWash) || surface === 'custom' ? (
        <div aria-hidden style={{
          position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
          background: 'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(0,0,0,0.10) 100%)',
        }} />
      ) : null}

      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
        {/* Tabs. One panel with switchable content, rather than one panel per
            thing — the three are alternate views of the same track. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '11px 10px 9px' }}>
          {NP_PANEL_TABS.map(([id, label]) => {
            const on = tab === id;
            return (
              <button key={id} type="button" onClick={() => onTab(id)}
                style={{
                  padding: '6px 12px', borderRadius: 999, border: 'none', cursor: 'pointer',
                  background: on ? 'rgba(var(--st-fg-rgb), 0.11)' : 'transparent',
                  color: on ? '#fff' : 'rgba(var(--st-fg-rgb), 0.5)',
                  fontSize: 12, fontWeight: on ? 700 : 600,
                  transition: 'background 0.15s ease, color 0.15s ease',
                }}>
                {label}
              </button>
            );
          })}
          <div style={{ flex: 1 }} />
          {onExpand ? (
            <button type="button" onClick={onExpand} title="Open fullscreen" aria-label="Open fullscreen"
              style={{ width: 26, height: 26, borderRadius: 8, border: 'none', background: 'rgba(var(--st-fg-rgb), 0.07)', color: 'rgba(var(--st-sub-rgb), 0.6)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17L17 7M9 7h8v8" /></svg>
            </button>
          ) : null}
          <button type="button" onClick={onClose} title="Close panel" aria-label="Close panel"
            style={{ width: 26, height: 26, borderRadius: 8, border: 'none', background: 'rgba(var(--st-fg-rgb), 0.07)', color: 'rgba(var(--st-sub-rgb), 0.6)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        {tab === 'queue' ? (
          <QueueTab current={track} upNext={upNext} acc={acc} coverFor={coverFor}
            onSelectTrack={onSelectTrack} currentTime={currentTime} isPlaying={isPlaying}
            onReorder={onReorderQueue} queueOffset={queueOffset} />
        ) : tab === 'lyrics' ? (
          <LyricsTab lyricsData={lyricsData} onLyricsSaved={onLyricsSaved} track={track}
            onBrowseLyrics={onBrowseLyrics}
            selection={lyricSelection} onSelectStart={onLyricSelectStart} onSelectLine={onLyricSelectLine}
            currentTime={currentTime} accent={accent} onSeek={onSeek} />
        ) : (
          <InfoTab track={track} art={art} artistInfo={artistInfo} credits={credits} />
        )}
      </div>
    </aside>
  );
}

/**
 * The queue.
 *
 * It was two flat lists of title-and-artist and nothing else: no position, no
 * durations, no sense of how much music is actually lined up, and no way to
 * tell where you are in the current track without looking at the bar. All of
 * that is already in hand — it just wasn't being shown.
 */
/**
 * One queue row.
 *
 * Module-level on purpose. It used to be declared inside QueueTab, which means
 * a NEW component type on every render — and QueueTab re-renders on every tick
 * of currentTime. React sees a different type and remounts the whole list each
 * second, throwing away each row's hover state, so hovering appeared not to
 * work at all. Declared out here the type is stable and the rows just update.
 */
function QueueRow({
  t, index, playing = false, onClick, acc, coverFor, progress = 0, isPlaying = false,
  onReorder, queueOffset = 0, dragFrom, dragOver, setDragFrom, setDragOver, dur,
}) {
  const [hot, setHot] = useState(false);
    return (
      /* A div, not a button, for two reasons.
         Chromium will not reliably begin an HTML5 drag from a <button> — the
         element's own mousedown handling swallows it, which is why dragging
         did nothing. And a <button> does NOT inherit font-family from its
         ancestors; it falls back to the UA default, which is why the queue was
         set in a different typeface from the rest of the app while every other
         row here sets `font: inherit` explicitly. */
      <div role="button" tabIndex={0} onClick={onClick}
        onKeyDown={(e) => { if (onClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); } }}
        onMouseEnter={() => setHot(true)} onMouseLeave={() => setHot(false)}
        draggable={!!onReorder && !playing}
        onDragStart={(e) => {
          if (!onReorder || playing) return;
          setDragFrom(index - 1);
          e.dataTransfer.effectAllowed = 'move';
          // Firefox refuses to start a drag without payload.
          try { e.dataTransfer.setData('text/plain', String(index - 1)); } catch { /* ignore */ }
        }}
        onDragOver={(e) => {
          if (dragFrom === null || playing) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (dragOver !== index - 1) setDragOver(index - 1);
        }}
        onDrop={(e) => {
          if (dragFrom === null || playing) return;
          e.preventDefault();
          if (dragFrom !== index - 1) onReorder(queueOffset + dragFrom, queueOffset + (index - 1));
          setDragFrom(null); setDragOver(null);
        }}
        onDragEnd={() => { setDragFrom(null); setDragOver(null); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left',
          padding: '7px 9px', borderRadius: 9, border: 'none', font: 'inherit',
          userSelect: 'none',
          cursor: onReorder && !playing ? 'grab' : (onClick ? 'pointer' : 'default'),
          background: playing ? `rgba(${acc},0.16)` : (hot ? 'rgba(var(--st-fg-rgb), 0.07)' : 'transparent'),
          /* The gap opens where the row would land, so the drop is a preview
             rather than a guess. */
          boxShadow: dragOver === index - 1 && dragFrom !== null && dragFrom !== index - 1
            ? `inset 0 2px 0 rgb(${acc})` : 'none',
          opacity: dragFrom === index - 1 ? 0.4 : 1,
          transition: 'background 0.14s ease, opacity 0.14s ease',
        }}>
        {/* Position, replaced on hover by the thing clicking will do. */}
        <span style={{
          width: 16, flexShrink: 0, textAlign: 'right', fontSize: 11, fontWeight: 700,
          fontVariantNumeric: 'tabular-nums',
          color: playing ? `rgb(${acc})` : `rgba(var(--st-sub-rgb), ${hot ? 0.85 : 0.32})`,
        }}>
          {playing
            ? <PlayingBars acc={acc} playing={isPlaying} />
            /* Was the text character U+25B6 — a glyph from the system font,
               with hard corners and no relation to the play button drawn
               everywhere else. */
            : (hot ? <PlayIcon size={11} nudge={false} /> : index)}
        </span>

        <span style={{
          position: 'relative', width: 38, height: 38, borderRadius: 6, flexShrink: 0,
          background: coverFor?.(t) ? `url("${coverFor(t)}") center/cover` : 'rgba(var(--st-fg-rgb), 0.1)',
          boxShadow: 'inset 0 0 0 1px rgba(var(--st-fg-rgb), 0.1)',
        }}>
          {/* The current track carries its own progress, so the queue answers
              "how far in are we" without a trip back to the bar. */}
          {playing && progress > 0 ? (
            <span style={{
              position: 'absolute', left: 3, right: 3, bottom: 3, height: 2.5, borderRadius: 2,
              background: 'rgba(0,0,0,0.5)', overflow: 'hidden',
            }}>
              <span style={{
                display: 'block', height: '100%', width: `${progress * 100}%`,
                background: `rgb(${acc})`, transition: 'width 0.4s linear',
              }} />
            </span>
          ) : null}
        </span>

        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{
            display: 'block', fontSize: 12.5, fontWeight: 650,
            color: playing ? `rgb(${acc})` : 'var(--st-text)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{t.title}</span>
          <span style={{
            display: 'block', fontSize: 10.5, color: 'rgba(var(--st-sub-rgb), 0.5)', marginTop: 1,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{t.artist}</span>
        </span>

        <span style={{
          flexShrink: 0, fontSize: 10.5, fontWeight: 650, fontVariantNumeric: 'tabular-nums',
          color: 'rgba(var(--st-sub-rgb), 0.38)',
        }}>{dur(t.duration)}</span>

        {onReorder && !playing ? (
          <span aria-hidden style={{
            flexShrink: 0, width: 10, marginLeft: -3, color: 'rgba(var(--st-sub-rgb), 0.42)',
            opacity: hot ? 1 : 0, transition: 'opacity 0.14s ease',
          }}>
            <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor">
              <circle cx="3" cy="2" r="1" /><circle cx="7" cy="2" r="1" />
              <circle cx="3" cy="6" r="1" /><circle cx="7" cy="6" r="1" />
              <circle cx="3" cy="10" r="1" /><circle cx="7" cy="10" r="1" />
            </svg>
          </span>
        ) : null}
      </div>
    );
}

function QueueTab({
  current, upNext, acc, coverFor, onSelectTrack, currentTime = 0, isPlaying = false,
  onReorder, queueOffset = 0,
}) {
  /* Which row is being dragged, and where it would land. Local so the list
     reflows under the cursor without committing anything until you let go —
     a drop that lands where the preview showed it. */
  const [dragFrom, setDragFrom] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  /* How long the queue runs, so "12 tracks" becomes something you can plan
     around. Tracks missing a duration are skipped rather than counted as zero,
     and the total says "at least" when any were. */
  const { total, partial } = useMemo(() => {
    let secs = 0; let missing = false;
    for (const t of upNext) {
      if (Number.isFinite(t?.duration) && t.duration > 0) secs += t.duration;
      else missing = true;
    }
    return { total: secs, partial: missing };
  }, [upNext]);

  const runtime = (() => {
    if (!total) return null;
    const h = Math.floor(total / 3600);
    const m = Math.round((total % 3600) / 60);
    const text = h >= 1 ? `${h} hr ${m} min` : `${Math.max(1, m)} min`;
    return partial ? `${text}+` : text;
  })();

  const dur = (secs) => {
    if (!Number.isFinite(secs) || secs <= 0) return '';
    const m = Math.floor(secs / 60);
    const ss = Math.floor(secs % 60);
    return `${m}:${String(ss).padStart(2, '0')}`;
  };

  const progress = current && Number.isFinite(current.duration) && current.duration > 0
    ? Math.min(1, Math.max(0, currentTime / current.duration))
    : 0;

  const rowProps = {
    acc, coverFor, isPlaying, dur, onReorder, queueOffset,
    dragFrom, dragOver, setDragFrom, setDragOver,
  };

  return (
    <div className="sth-libscroll" style={{ overflowY: 'auto', padding: '0 8px 14px', minHeight: 0, flex: 1 }}>
      {current ? (
        <>
          <PanelLabel>Now playing</PanelLabel>
          <QueueRow {...rowProps} t={current} playing index={0} progress={progress} />
        </>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '0 9px' }}>
        <PanelLabel>{`Next up${upNext.length ? ` \u00b7 ${upNext.length}` : ''}`}</PanelLabel>
        {runtime ? (
          <span style={{ fontSize: 10.5, fontWeight: 650, color: 'rgba(var(--st-sub-rgb), 0.3)', marginLeft: 'auto' }}>
            {runtime}
          </span>
        ) : null}
      </div>

      {upNext.length ? upNext.map((t, i) => (
        <QueueRow {...rowProps} key={`${t.id}-${i}`} t={t} index={i + 1} onClick={() => onSelectTrack?.(t)} />
      )) : (
        <div style={{ fontSize: 11.5, color: 'rgba(var(--st-sub-rgb), 0.4)', padding: '6px 9px', lineHeight: 1.5 }}>
          Nothing queued after this track.
        </div>
      )}
    </div>
  );
}

function LyricsTab({
  lyricsData, onLyricsSaved, track, currentTime, accent, onSeek,
  onBrowseLyrics, selection = null, onSelectStart, onSelectLine,
}) {
  const synced = lyricsData?.synced?.length ? lyricsData.synced : null;
  const plain = lyricsData?.plain || null;
  const hasLyrics = !!(synced || plain);
  const acc = readableAccent(accent);

  /* Editing lives HERE, not only in the expanded view.
   *
   * NpLyricsView (the fullscreen stage) has had an edit pencil for a while;
   * this tab is a different component and never got one, so from the dock —
   * which is where most people actually read lyrics — there was no way to fix
   * a bad line or time an untimed sheet. Same editor, same save contract, just
   * reachable from the surface you're already looking at. */
  const [editing, setEditing] = useState(false);
  // A new track means a new set of words; staying in the editor would apply
  // the previous song's edits to it.
  useEffect(() => { setEditing(false); }, [track ? track.id : null]);

  if (editing) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <PanelLyricsEditor
          track={track}
          currentTime={currentTime}
          existingSynced={synced}
          existingPlain={plain}
          accent={acc}
          onSeek={onSeek}
          onSave={(newSynced, newPlain) => { onLyricsSaved?.(newSynced, newPlain, track?.id); setEditing(false); }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  /* Instrumental is a fact about the track, not a gap to fill — offering
     "Add lyrics" there invites work that shouldn't be done. */
  if (!hasLyrics) {
    return (
      <div style={{
        flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 12, padding: '20px 22px', textAlign: 'center',
      }}
      >
        <div style={{ fontSize: 12.5, color: 'rgba(var(--st-sub-rgb), 0.5)', lineHeight: 1.55, fontWeight: 600 }}>
          {lyricsData?.instrumental ? 'This track is instrumental.' : 'No lyrics for this track yet.'}
        </div>
        {track && !lyricsData?.instrumental ? (
          <button type="button" onClick={() => setEditing(true)}
            style={{
              padding: '8px 15px', borderRadius: 99, border: 0, cursor: 'pointer',
              background: `rgb(${acc})`, color: accentTextColor(acc), fontSize: 12.5, fontWeight: 800,
            }}
          >
            Add lyrics
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', padding: '0 4px 12px', position: 'relative' }}>
      {synced ? (
        /* Selection props make the lines shareable — click one, drag to
           extend. The confirm bar and the card overlay are rendered once at
           the StudioHome level and are position:fixed, so they serve the dock
           and the fullscreen stage without either owning them. */
        <SyncedLyrics lines={synced} currentTime={currentTime} accent={accent} onSeek={onSeek} fontSize={16} lineHeight={1.5}
          selection={selection} onSelectStart={onSelectStart} onSelectLine={onSelectLine} />
      ) : (
        <div className="sth-libscroll" style={{ flex: 1, overflowY: 'auto', padding: '4px 12px' }}>
          {/* Untimed lyrics don't scroll with the song, which looks broken
              rather than incomplete. Say so, and make the fix one click. */}
          <button type="button" onClick={() => setEditing(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
              margin: '0 0 10px', padding: '8px 10px', borderRadius: 10, cursor: 'pointer',
              background: `rgba(${acc}, 0.13)`, border: `1px solid rgba(${acc}, 0.26)`,
            }}
          >
            <span style={{ flex: 1, fontSize: 11.5, fontWeight: 700, color: 'rgba(var(--st-text-rgb), 0.92)' }}>
              These lyrics aren’t timed
              <span style={{ display: 'block', fontSize: 10.5, fontWeight: 600, color: 'rgba(var(--st-sub-rgb), 0.55)', marginTop: 1 }}>
                They won’t follow the song
              </span>
            </span>
            <span style={{ fontSize: 10.5, fontWeight: 800, color: `rgb(${acc})`, flexShrink: 0 }}>Add timing</span>
          </button>
          <PlainLyrics text={plain} accent={accent} fontSize={15} lineHeight={1.7} />
        </div>
      )}

      {/* Floating toolbar, bottom-right, out of the reading column. Same pair
          and same icons as the fullscreen stage's LyricTools, so the two
          surfaces don't disagree about what these buttons look like. */}
      {track ? (
        <div style={{
          position: 'absolute', right: 12, bottom: 8, display: 'flex', gap: 5,
          padding: 3, borderRadius: 11,
          background: 'rgba(0,0,0,0.42)', backdropFilter: 'blur(14px)',
          border: '1px solid rgba(var(--st-fg-rgb), 0.10)',
        }}
        >
          <button type="button" onClick={() => setEditing(true)} style={toolBtn}
            title="Edit lyrics · tap to sync" aria-label="Edit lyrics">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
            </svg>
          </button>
          {onBrowseLyrics ? (
            <button type="button" onClick={onBrowseLyrics} style={toolBtn}
              title="Pick a different version" aria-label="Browse lyrics versions">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Discoverability, not decoration: line selection has no affordance of
          its own, so the one hint says how to start it. Hidden once a
          selection exists — the confirm bar takes over from there. */}
      {synced && onSelectStart && !selection ? (
        <div style={{
          position: 'absolute', left: 14, bottom: 15, fontSize: 10, fontWeight: 700,
          color: 'rgba(var(--st-sub-rgb), 0.34)', pointerEvents: 'none',
        }}
        >
          Click a line to share it
        </div>
      ) : null}
    </div>
  );
}

/**
 * InfoTab — everything known about the current track and its artist.
 *
 * Deliberately shows only what studio can actually source. Spotify's Web API
 * does NOT expose monthly listeners or the artist bio — those come from an
 * internal service their own clients use — so followers is shown instead, and
 * labelled as followers rather than dressed up as listeners.
 */
function InfoTab({ track, art, artistInfo, credits }) {
  const fmtNum = (n) => (Number.isFinite(n) ? n.toLocaleString() : null);

  /* Details as compact pairs. Album is omitted deliberately — it's already the
     first thing under the artist card, and repeating it here was half the
     reason the old list felt padded. */
  const details = [
    ['Album', track?.album],
    ['Year', track?.year],
    /* Rendered by the pair list below, which now takes an array for genres so
       each one gets its own pill instead of the delimiter showing through. */
    ['Genre', parseGenres(track?.genre)],
    ['Track', Number.isFinite(track?.trackNumber) ? `${track.trackNumber}${track.trackTotal ? `/${track.trackTotal}` : ''}` : null],
    ['Format', track?.filePath ? getFileFormatLabel(track.filePath) : null],
    ['Length', track?.duration ? formatTime(track.duration) : null],
  ].filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0));

  return (
    <div className="sth-libscroll" style={{ overflowY: 'auto', minHeight: 0, flex: 1, padding: '0 12px 16px' }}>

      {/* Artist card first — it's the one block with real presence, and it's
          where this panel will grow (bio, top tracks, related). Everything
          below is reference material you scan rather than look at. */}
      {artistInfo ? (
        <div style={{ borderRadius: 12, overflow: 'hidden', background: 'rgba(var(--st-fg-rgb), 0.045)' }}>
          {artistInfo.image ? (
            <div style={{ height: 128, backgroundImage: `url("${artistInfo.image}")`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
          ) : null}
          <div style={{ padding: '11px 13px 13px' }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--st-text)' }}>{artistInfo.name}</div>
            {Number.isFinite(artistInfo.followers) ? (
              <div style={{ fontSize: 11.5, color: 'rgba(var(--st-sub-rgb), 0.55)', marginTop: 3 }}>
                {fmtNum(artistInfo.followers)} followers on Spotify
              </div>
            ) : null}
            {artistInfo.genres?.length ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 9 }}>
                {artistInfo.genres.slice(0, 4).map((g) => (
                  <span key={g} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 999, background: 'rgba(var(--st-fg-rgb), 0.08)', color: 'rgba(var(--st-text-rgb), 0.68)' }}>{g}</span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div style={{ borderRadius: 12, background: 'rgba(var(--st-fg-rgb), 0.045)', padding: '13px', fontSize: 11.5, color: 'rgba(var(--st-sub-rgb), 0.42)', lineHeight: 1.55 }}>
          Connect Spotify in Settings to show artist details here.
        </div>
      )}

      {/* Artwork at 34px, inline with the title rather than above it. Big
          enough to identify the record, small enough that it reads as part of
          the label row instead of a second hero — the full-bleed version cost
          a third of the panel and duplicated the Now Playing bar 40px below.
          No artist line for the same reason: the bar always shows it. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginTop: 18 }}>
        <div style={{
          width: 34, height: 34, borderRadius: 6, flexShrink: 0,
          background: art ? `url("${art}") center/cover` : 'rgba(var(--st-fg-rgb), 0.08)',
          boxShadow: '0 0 0 1px rgba(var(--st-fg-rgb), 0.08)',
        }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(var(--st-sub-rgb), 0.36)' }}>Song</div>
          <div style={{ fontSize: 13.5, fontWeight: 650, color: 'var(--st-text)', marginTop: 2, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={track?.title}>{track?.title}</div>
        </div>
      </div>

      {/* Details and credits share ONE block. They're the same kind of thing —
          flat facts about the track — and splitting them into two labelled
          sections put a heading and a gap between "Year 2021" and "Written by",
          which is most of why this panel felt long.
          Short values sit two-per-row; credits run full width because names
          are long and wrap. */}
      {(details.length || credits?.length) ? (
        <div style={{ marginTop: 13 }}>
          {details.length ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '11px 12px' }}>
              {details.map(([k, v]) => (
                <div key={k} style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'rgba(var(--st-sub-rgb), 0.36)' }}>
                    {/* "Genre" pluralises itself rather than being two labels. */}
                    {k === 'Genre' && Array.isArray(v) && v.length > 1 ? 'Genres' : k}
                  </div>
                  {/* A list value wraps to as many lines as it needs — these
                      sit in a 1fr column, and a nowrap ellipsis would hide the
                      second and third genre entirely. */}
                  {Array.isArray(v) ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                      {v.map((item) => (
                        <span key={item} style={{
                          maxWidth: '100%', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                          background: 'rgba(var(--st-fg-rgb), 0.08)', color: 'rgba(var(--st-text-rgb), 0.82)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }} title={item}>{item}</span>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: 'rgba(var(--st-text-rgb), 0.88)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={String(v)}>{v}</div>
                  )}
                </div>
              ))}
            </div>
          ) : null}

          {credits?.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 11, marginTop: details.length ? 13 : 0 }}>
              {credits.map((c, i) => (
                <div key={`${c.role}-${i}`}>
                  <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'rgba(var(--st-sub-rgb), 0.36)' }}>{c.role}</div>
                  <div style={{ fontSize: 12, color: 'rgba(var(--st-text-rgb), 0.88)', marginTop: 3, lineHeight: 1.45 }}>{c.name}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}


/**
 * CoverLightbox — the artwork, big, with the two things you'd want from it.
 *
 * "Save to Downloads" writes the EXACT bytes the app is displaying, via the
 * existing covers:export handler — not a re-encode, not a re-fetch, the same
 * file the cover store holds. That matters: a separately downloaded jpg of the
 * same artwork is a different encoding at a different size, and the whole
 * class of bug this came out of was two encodings of one picture being treated
 * as two different records.
 *
 * "Use for this whole album" is the one that actually prevents a recurrence.
 * Exporting gives you a file; pinning makes every track on the record resolve
 * to ONE cover URL through coverFor, regardless of what each individual file
 * happens to carry in its tags. A local rip and an in-app download of the same
 * album stop being able to disagree, because neither is asked.
 */
export function CoverLightbox({ url, track, accent, albumKey, onPin, onClose }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const acc = readableAccent(accent);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const exportName = [track?.artist, track?.album || track?.title]
    .filter(Boolean).join(' - ') || 'cover';

  const save = async (saveAs) => {
    if (busy) return;
    setBusy(true);
    setNote('saving…');
    try {
      const api = window.electronAPI;
      const fn = saveAs ? api?.exportCoverSaveAs : api?.exportCover;
      if (!fn) { setNote('export unavailable in this build'); return; }
      const r = await fn(url, exportName);
      if (r?.ok) {
        const kb = Math.round((r.bytes || 0) / 1024);
        setNote(saveAs ? `saved (${kb} KB)` : `saved to Downloads (${kb} KB)`);
      } else {
        setNote(r?.error || 'could not save');
      }
    } catch (e) {
      setNote(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const pin = async () => {
    if (busy || !albumKey || !onPin) return;
    setBusy(true);
    setNote('applying…');
    try {
      await onPin(albumKey, url);
      setNote('this cover now applies to the whole album');
    } catch (e) {
      setNote(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const btn = {
    padding: '9px 14px', borderRadius: 10, cursor: busy ? 'default' : 'pointer',
    border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.06)',
    color: busy ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.9)',
    fontSize: 12, fontWeight: 650, whiteSpace: 'nowrap',
    transition: 'background 0.15s ease, color 0.15s ease',
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Cover art"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 20,
        background: 'rgba(0,0,0,0.82)',
        backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)',
        animation: 'sthCoverZoomIn 200ms cubic-bezier(0.22, 1, 0.36, 1) both',
        padding: 32,
      }}
    >
      {/* Stop clicks on the artwork itself from dismissing — only the
          backdrop closes, which is what every image viewer does. */}
      <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, maxWidth: '100%' }}>
        {url ? (
          <img
            src={url}
            alt={track?.album || track?.title || 'Cover art'}
            draggable={false}
            style={{
              width: 'min(72vh, 72vw)', height: 'min(72vh, 72vw)',
              objectFit: 'cover', borderRadius: 14, display: 'block',
              boxShadow: `0 30px 90px rgba(0,0,0,0.7), 0 0 0 1px rgba(${acc},0.35)`,
            }}
          />
        ) : null}

        <div style={{ textAlign: 'center', minWidth: 0, maxWidth: '80vw' }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {track?.album || track?.title || ''}
          </div>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {track?.artist || ''}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button type="button" style={btn} disabled={busy} onClick={() => save(false)}
            title="Write the exact image being displayed into your Downloads folder">
            Save to Downloads
          </button>
          <button type="button" style={btn} disabled={busy} onClick={() => save(true)}
            title="Choose where to write the exact image being displayed">
            Save as…
          </button>
          {albumKey && onPin ? (
            <button type="button" disabled={busy} onClick={pin}
              style={{ ...btn, background: `rgba(${acc},0.22)`, borderColor: `rgba(${acc},0.4)` }}
              title="Make every track on this album use this exact cover">
              Use for this whole album
            </button>
          ) : null}
        </div>

        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', minHeight: 15, textAlign: 'center' }}>
          {note || 'Esc or click outside to close'}
        </div>
      </div>
    </div>
  );
}

/* The action cluster is two groups, not one row of five.
 *
 * Left of the rule: things done TO THE SONG — favourite, add to a playlist,
 * and the overflow menu, which is the same menu a right-click on any library
 * row opens. Right of the rule: things done to the VIEW — which panel is
 * showing, how the bar is coloured, whether the stage is up. They were
 * interleaved before, so "queue" and "add to playlist" sat next to each other
 * looking like a pair when one queues a song for now and the other files it
 * forever.
 *
 * The "Song & artist info" toggle is gone from here. It was a third way to
 * open a panel whose own tab strip already switches between info, lyrics and
 * queue — three buttons for a two-button job. Lyrics and queue stay because
 * they're the two people reach for mid-song; info is one tab away once either
 * is open.
 */
/* The early return lives out here: the bar's body calls hooks, and a return
   above them changes how many run the moment playback stops (React throws). */
export function NowPlayingBar(props) {
  return props.track ? <NowPlayingBarBody {...props} /> : null;
}

function NowPlayingBarBody({ track, isPlaying, art, accent, immersePalette = null, onZoomCover, onCopyLink, copyBusy = false, onTogglePlay, onPrev, onNext, volume = 1, onSetVolume, gainBoost = 1, onSetGainBoost, getGainReduction = null, animatedBg = false, solidWash = null, currentTime = 0, onSeek, onFullscreen, onToggleQueue, queueOpen = false, onToggleLyrics, lyricsOpen = false, onToggleFavorite, onAddToPlaylist, onMore, shuffleOn = false, repeat = 'off', onToggleShuffle, onToggleRepeat }) {
  /* 0.82 / 0.45, not 0.55 / 0.22. These feed AnimatedGradientBg's mid and
     wash stops; at the old values the gradient started dark before anything
     else touched it. The fullscreen stage keeps the darker pair because it
     fills the screen behind large type — an 84px bar doesn't have that
     problem. */
  /* Immerse shows the RECORD. Its three colours are three colours FROM the
     sleeve, not one value scaled to 82% and 45% of itself — that only ever
     produced three shades of the same thing, which is what made it look like
     a tint rather than the artwork. */
  const gradBase = immersePalette?.accent || accent;
  const gradMid = immersePalette?.mid || gradBase.split(',').map((n) => Math.round(Number(n) * 0.82)).join(', ');
  const gradWash = immersePalette?.wash || gradBase.split(',').map((n) => Math.round(Number(n) * 0.45)).join(', ');
  const dur = Number.isFinite(track.duration) && track.duration > 0 ? track.duration : 0;
  // While dragging the seek bar, show the dragged position instead of the
  // live one so the handle tracks the cursor smoothly; commit on release.
  const [scrub, setScrub] = useState(null); // 0..1 while dragging, else null
  const seekTrackRef = useRef(null);
  const shownPct = scrub != null ? scrub * 100 : (dur ? Math.min(100, Math.max(0, (currentTime / dur) * 100)) : 0);
  const fmtT = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60); const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };
  const posFromEvent = (clientX) => {
    const el = seekTrackRef.current; if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  const beginScrub = (e) => {
    if (!onSeek || !dur) return;
    e.stopPropagation(); e.preventDefault();
    const frac = posFromEvent(e.clientX);
    setScrub(frac);
    const move = (ev) => setScrub(posFromEvent(ev.clientX));
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const f = posFromEvent(ev.clientX);
      setScrub(null);
      onSeek(f * dur);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const shownTime = scrub != null ? scrub * dur : currentTime;
  const onSeekKey = (e) => {
    if (!onSeek || !dur) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); onSeek(Math.min(dur, currentTime + 5)); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); onSeek(Math.max(0, currentTime - 5)); }
  };
  return (
    /* Implementation brief, Now Playing bar: a detached card — same left and
       right edges as the content card, a 12px gap above it, 16px radius on all
       four corners, 86px tall. Three zones: 282 | flexible | 282. The scrubber
       sits directly under the transport at 420px instead of spanning the bar,
       which is what made the old bar read as two storeys that didn't line up.
       Copy-link, colour and fullscreen moved into the overflow menu. */
    <div className="sth-npbar" role="region" aria-label="Now playing" style={
      solidWash ? { background: `rgb(${solidWash})` } : (animatedBg ? { background: '#000' } : undefined)
    }>
      {animatedBg && !solidWash ? (
        <>
          <div aria-hidden style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}>
            <AnimatedGradientBg accent={gradBase} mid={gradMid} wash={gradWash} coverUrl={art} isPlaying={isPlaying} vignette={false} brightness={1} />
          </div>
          <div aria-hidden style={{
            position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
            background: 'linear-gradient(90deg, rgba(0,0,0,0.42) 0%, rgba(0,0,0,0.16) 22%, rgba(0,0,0,0) 38%)',
          }} />
        </>
      ) : null}

      <div className="sth-npbar-grid">
        {/* ---- Left, 282px: what's playing ---- */}
        <div className="sth-npbar-left">
          {art && onZoomCover ? (
            <button type="button" className="sth-npbar-art" onClick={() => onZoomCover(art)}
              title="View cover art" aria-label="View cover art full size"
              style={{ background: `url("${art}") center/cover`, cursor: 'zoom-in' }} />
          ) : (
            <div className="sth-npbar-art" style={{ background: art ? `url("${art}") center/cover` : 'rgba(255,255,255,0.08)' }} />
          )}
          <div style={{ minWidth: 0 }}>
            {onCopyLink ? (
              <button type="button" className="sth-npbar-title is-link" onClick={() => onCopyLink(track)} disabled={copyBusy}
                title={copyBusy ? 'Looking up on Spotify…' : `${track.title} · click to copy Spotify link`}
                aria-label={`Copy Spotify link for ${track.title}`}>{track.title}</button>
            ) : (
              <div className="sth-npbar-title" title={track.title}>{track.title}</div>
            )}
            <div className="sth-npbar-artist" title={track.artist}>{track.artist}</div>
          </div>
        </div>

        {/* ---- Centre: transport, scrubber directly beneath ---- */}
        <div className="sth-npbar-mid">
          <div className="sth-npbar-transport">
            {onToggleShuffle ? (
              <button type="button" className={`sth-npbtn${shuffleOn ? ' is-on' : ''}`} onClick={onToggleShuffle}
                title={shuffleOn ? 'Shuffle on' : 'Shuffle off'} aria-label="Shuffle" aria-pressed={shuffleOn}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 3h5v5" /><path d="M4 20L21 3" /><path d="M21 16v5h-5" /><path d="M15 15l6 6" /><path d="M4 4l5 5" />
                </svg>
              </button>
            ) : null}
            {onPrev ? (
              <button type="button" className="sth-npbtn" onClick={onPrev} title="Previous" aria-label="Previous">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 5l-7 7 7 7" />
                </svg>
              </button>
            ) : null}
            {onTogglePlay ? (
              <button type="button" className="sth-npbar-play" onClick={onTogglePlay}
                title={isPlaying ? 'Pause' : 'Play'} aria-label={isPlaying ? 'Pause' : 'Play'}>
                {isPlaying ? <PauseGlyph size={17} /> : <PlayGlyph size={17} />}
              </button>
            ) : null}
            {onNext ? (
              <button type="button" className="sth-npbtn" onClick={onNext} title="Next" aria-label="Next">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 5l7 7-7 7" />
                </svg>
              </button>
            ) : null}
            {onToggleRepeat ? (
              <button type="button" className={`sth-npbtn${repeat !== 'off' ? ' is-on' : ''}`} onClick={onToggleRepeat}
                title={repeat === 'one' ? 'Repeat this track' : repeat === 'all' ? 'Repeat queue' : 'Repeat off'}
                aria-label={repeat === 'one' ? 'Repeat: this track' : repeat === 'all' ? 'Repeat: queue' : 'Repeat: off'} aria-pressed={repeat !== 'off'}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
                  <polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
                  {repeat === 'one' ? <text x="12" y="15" textAnchor="middle" fontSize="9" fontWeight="700" fill="currentColor" stroke="none">1</text> : null}
                </svg>
              </button>
            ) : null}
          </div>

          <div className="sth-npbar-scrub">
            <span className="sth-npbar-t st-num" style={{ textAlign: 'right' }}>{fmtT(shownTime)}</span>
            <div
              className="sth-npbar-seek"
              ref={seekTrackRef}
              onPointerDown={onSeek && dur ? beginScrub : undefined}
              onKeyDown={onSeekKey}
              role="slider"
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={Math.round(dur) || 0}
              aria-valuenow={Math.round(shownTime)}
              aria-valuetext={`${fmtT(shownTime)} of ${fmtT(dur)}`}
              tabIndex={0}
            >
              <div className="sth-npbar-seek-fill" style={{ width: `${shownPct}%`, transition: scrub != null ? 'none' : 'width 0.25s linear' }}>
                <span className="sth-npbar-seek-knob" />
              </div>
            </div>
            <span className="sth-npbar-t st-num">{fmtT(dur)}</span>
          </div>
        </div>

        {/* ---- Right, 282px: three clusters ---- */}
        <div className="sth-npbar-right">
          <div className="sth-npbar-cluster">
            {onToggleFavorite ? (
              <button type="button" className={`sth-npbtn${track.isFavorite ? ' is-on' : ''}`} onClick={() => onToggleFavorite(track.id)}
                title={track.isFavorite ? 'Remove from favourites' : 'Add to favourites'}
                aria-label={track.isFavorite ? 'Remove from favourites' : 'Add to favourites'}
                aria-pressed={!!track.isFavorite}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill={track.isFavorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20.8 8.6a5 5 0 0 0-8.8-2.6A5 5 0 0 0 3.2 8.6c0 4.2 5.5 7.6 8.8 10.4 3.3-2.8 8.8-6.2 8.8-10.4z" />
                </svg>
              </button>
            ) : null}
            {onAddToPlaylist ? (
              <button type="button" className="sth-npbtn" onClick={(e) => onAddToPlaylist(e, track)}
                title="Add to playlist" aria-label="Add to playlist" aria-haspopup="menu">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="8.5" /><path d="M12 8.5v7M8.5 12h7" />
                </svg>
              </button>
            ) : null}
          </div>
          <span aria-hidden className="sth-npbtn-rule" />
          <div className="sth-npbar-cluster">
            {onToggleQueue ? (
              <button type="button" className={`sth-npbtn${queueOpen ? ' is-on' : ''}`} onClick={onToggleQueue}
                title="Queue" aria-label="Queue" aria-pressed={queueOpen}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h12M3 11h12M3 16h7" /><path d="M21 5v9.2" /><circle cx="19" cy="15.4" r="2.1" />
                </svg>
              </button>
            ) : null}
            {onToggleLyrics ? (
              <button type="button" className={`sth-npbtn${lyricsOpen ? ' is-on' : ''}`} onClick={onToggleLyrics}
                title="Lyrics" aria-label="Lyrics" aria-pressed={lyricsOpen}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 6h16M4 11h16M4 16h10" />
                </svg>
              </button>
            ) : null}
            {onFullscreen ? (
              <button type="button" className="sth-npbtn" onClick={onFullscreen}
                title="Fullscreen" aria-label="Open fullscreen player">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
                </svg>
              </button>
            ) : null}
            {onMore ? (
              <button type="button" className="sth-npbtn" onClick={(e) => onMore(e, track)}
                title="More" aria-label="More actions" aria-haspopup="menu">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                  <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
                </svg>
              </button>
            ) : null}
          </div>
          {onSetVolume ? (
            <>
              <span aria-hidden className="sth-npbtn-rule sth-npbar-vol" />
              <div className="sth-npbar-cluster sth-npbar-vol">
                <VolumeControl volume={volume} onSetVolume={onSetVolume} width={72}
                  boost={gainBoost} onSetBoost={onSetGainBoost} getGainReduction={getGainReduction} />
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
