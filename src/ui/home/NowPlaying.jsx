import React, { useEffect, useMemo, useRef, useState } from 'react';
import { readableAccent } from '../../lib/coverTheme.js';
import { formatTime, getFileFormatLabel, parseGenres } from '../../lib/mediaUtils.js';
import PanelLyricsEditor from '../PanelLyricsEditor.jsx';
import VolumeControl from '../VolumeControl.jsx';
import { AnimatedGradientBg } from '../VisualEffects.jsx';
import { PauseIcon, PlayIcon } from '../sharedUI.jsx';
import { PlainLyrics, SyncedLyrics } from '../Lyrics.jsx';
import { NP_FULL_TABS, NP_PANEL_TABS, NP_PANEL_W } from './constants.js';
import { PauseGlyph, PlayGlyph, PlayingBars } from './common.jsx';
import { coverLayers } from '../../lib/coverUrl.js';
import { useStudioFollows, isStudioFollowed, followArtist, unfollowArtist } from '../../lib/studioFollows.js';
import { playContextFor } from '../../lib/playContext.js';
import { spotifyIdOf } from '../../lib/spotifyMediaElement.js';
import { usePlaybackTime } from '../../lib/playbackClock.js';
import { BoundedMap } from '../../lib/boundedMap.js';

export function NowPlayingFullView({
  track, art, accent, isPlaying = false, onSeek,
  onTogglePlay, onPrev, onNext, shuffleOn = false, repeat = 'off', onToggleShuffle, onToggleRepeat,
  volume = 1, onSetVolume, gainBoost = 1, onSetGainBoost, getGainReduction = null, onToggleFavorite, onAddToPlaylist, onMore,
  savedTrack = null, onSaveToLibrary = null, saveBusy = false, saveFailed = false,
  onCopyLink, copyBusy = false, onZoomCover,
  animatedBg = false, immersePalette = null,
  tab = null, onTab, onClose,
  coverFor, upNext = [], onSelectTrack, onReorderQueue, queueOffset = 0,
  lyricsData, onLyricsSaved, onBrowseLyrics,
  lyricSelection = null, onLyricSelectStart, onLyricSelectLine,
  artistInfo, credits, plays = 0,
}) {
  const acc = readableAccent(accent);
  const currentTime = usePlaybackTime();
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
              style={{ backgroundImage: coverLayers(art), cursor: 'zoom-in' }} />
          ) : (
            <div className="sth-full-cover" style={{ backgroundImage: art ? coverLayers(art) : undefined }} />
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
              <div className="sth-npbar-seek-fill" style={{ width: `${pct}%` }}>
                <span className="sth-npbar-seek-knob" />
              </div>
            </div>
            <span className="sth-npbar-t st-num">{fmt(dur)}</span>
          </div>

          <div className="sth-full-transport">
            {onToggleShuffle ? (
              <button type="button" className={`sth-npbtn is-toggle${shuffleOn ? ' is-on' : ''}`} onClick={onToggleShuffle}
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
                {isPlaying ? <PauseIcon size={24} /> : <PlayIcon size={24} />}
              </button>
            ) : null}
            {onNext ? (
              <button type="button" className="sth-npbtn sth-full-skip" onClick={onNext} title="Next" aria-label="Next">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7" /></svg>
              </button>
            ) : null}
            {onToggleRepeat ? (
              <button type="button" className={`sth-npbtn is-toggle${repeat !== 'off' ? ' is-on' : ''}`} onClick={onToggleRepeat}
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
            <LibraryActions track={track} saved={savedTrack} onSave={onSaveToLibrary} saveBusy={saveBusy} saveFailed={saveFailed}
              onToggleFavorite={onToggleFavorite} onAddToPlaylist={onAddToPlaylist} />
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
                onSelectTrack={onSelectTrack} isPlaying={isPlaying}
                onReorder={onReorderQueue} queueOffset={queueOffset} />
            ) : tab === 'lyrics' ? (
              <LyricsTab lyricsData={lyricsData} onLyricsSaved={onLyricsSaved} track={track}
                onBrowseLyrics={onBrowseLyrics}
                selection={lyricSelection} onSelectStart={onLyricSelectStart} onSelectLine={onLyricSelectLine}
                accent={accent} onSeek={onSeek} />
            ) : (
              <InfoTab track={track} art={art} artistInfo={artistInfo} credits={credits} plays={plays} />
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
  isPlaying = false, onSeek, onExpand,
  onReorderQueue, queueOffset = 0,
  artistInfo, credits, plays = 0,
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
            onSelectTrack={onSelectTrack} isPlaying={isPlaying}
            onReorder={onReorderQueue} queueOffset={queueOffset} />
        ) : tab === 'lyrics' ? (
          <LyricsTab lyricsData={lyricsData} onLyricsSaved={onLyricsSaved} track={track}
            onBrowseLyrics={onBrowseLyrics}
            selection={lyricSelection} onSelectStart={onLyricSelectStart} onSelectLine={onLyricSelectLine}
            accent={accent} onSeek={onSeek} />
        ) : (
          <InfoTab track={track} art={art} artistInfo={artistInfo} credits={credits} plays={plays} />
        )}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ queue
 * A plain list, the way Spotify lays it out: Now playing, then what's next,
 * with the place it's playing from when Studio knows it. Rows are just the
 * cover, title and artist over a hairline; hovering shows play on the cover
 * and a handle to drag the row to a new place.
 * ------------------------------------------------------------------------ */

const QUEUE_CSS = `
.sth-q { flex: 1; min-height: 0; overflow-y: auto; padding: 0 10px 14px; }
.sth-q-h { display: flex; align-items: baseline; gap: 8px; padding: 14px 6px 6px; font-size: 12.5px; font-weight: 700; color: rgba(var(--st-sub-rgb), 0.62); }
.sth-q-h:first-child { padding-top: 4px; }
.sth-q-h b { font-weight: 700; color: rgba(var(--st-text-rgb), 0.9); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.sth-q-h .m { margin-left: auto; flex-shrink: 0; font-size: 11.5px; font-weight: 600; color: rgba(var(--st-sub-rgb), 0.42); font-variant-numeric: tabular-nums; }
.sth-q-row { position: relative; display: flex; align-items: center; gap: 12px; padding: 7px 6px; border-radius: 8px; user-select: none; outline: none; }
.sth-q-row::after { content: ''; position: absolute; left: 6px; right: 6px; bottom: 0; height: 1px; background: rgba(var(--st-fg-rgb), 0.07); }
.sth-q-row:last-child::after, .sth-q-row.is-now::after { display: none; }
.sth-q-row.can-play { cursor: pointer; }
.sth-q-row.can-drag { cursor: grab; }
.sth-q-row:hover, .sth-q-row:focus-visible { background: rgba(var(--st-fg-rgb), 0.07); }
.sth-q-row:hover::after, .sth-q-row:focus-visible::after { opacity: 0; }
.sth-q-row.is-drop { box-shadow: inset 0 2px 0 rgb(var(--q-acc)); }
.sth-q-row.is-dragged { opacity: 0.4; }
.sth-q-art { position: relative; width: 42px; height: 42px; border-radius: 6px; flex-shrink: 0; overflow: hidden; background: rgba(var(--st-fg-rgb), 0.1) center/cover no-repeat; }
.sth-q-art .ov { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.5); color: #fff; opacity: 0; transition: opacity 0.12s ease; }
.sth-q-row:hover .sth-q-art .ov, .sth-q-row.is-now .sth-q-art .ov { opacity: 1; }
.sth-q-row.is-now .sth-q-art .ov { background: rgba(0,0,0,0.42); }
.sth-q-txt { flex: 1; min-width: 0; }
.sth-q-txt b { display: block; font-size: 14px; font-weight: 600; color: var(--st-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sth-q-row.is-now .sth-q-txt b { color: rgb(var(--q-acc)); }
.sth-q-txt small { display: block; margin-top: 1px; font-size: 12px; color: rgba(var(--st-sub-rgb), 0.55); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sth-q-grip { flex-shrink: 0; color: rgba(var(--st-sub-rgb), 0.5); opacity: 0; transition: opacity 0.12s ease; }
.sth-q-row:hover .sth-q-grip { opacity: 1; }
.sth-q-empty { padding: 6px 6px; font-size: 12.5px; color: rgba(var(--st-sub-rgb), 0.45); }
`;

/**
 * One queue row. Module-level so its type is stable: declared inside
 * QueueTab it was a new component every render (QueueTab re-renders on every
 * tick of currentTime), which remounted each row and threw away hover.
 *
 * A div, not a button: Chromium won't reliably start an HTML5 drag from a
 * <button>, and buttons don't inherit the app's font.
 */
function QueueRow({
  t, index, playing = false, onClick, coverFor, isPlaying = false,
  onReorder, queueOffset = 0, dragFrom, dragOver, setDragFrom, setDragOver,
}) {
  const at = index - 1; // position within upNext
  const canDrag = !!onReorder && !playing;
  const art = coverFor?.(t);
  return (
    <div role="button" tabIndex={0} onClick={onClick}
      className={[
        'sth-q-row', playing && 'is-now', onClick && 'can-play', canDrag && 'can-drag',
        dragFrom !== null && dragOver === at && dragFrom !== at && !playing && 'is-drop',
        dragFrom === at && !playing && 'is-dragged',
      ].filter(Boolean).join(' ')}
      onKeyDown={(e) => { if (onClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); } }}
      draggable={canDrag}
      onDragStart={(e) => {
        if (!canDrag) return;
        setDragFrom(at);
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(at)); } catch { /* ignore */ }
      }}
      onDragOver={(e) => {
        if (dragFrom === null || playing) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (dragOver !== at) setDragOver(at);
      }}
      onDrop={(e) => {
        if (dragFrom === null || playing) return;
        e.preventDefault();
        if (dragFrom !== at) onReorder(queueOffset + dragFrom, queueOffset + at);
        setDragFrom(null); setDragOver(null);
      }}
      onDragEnd={() => { setDragFrom(null); setDragOver(null); }}
      title={onClick ? `Play ${t.title}` : undefined}
    >
      <span className="sth-q-art" style={art ? { backgroundImage: `url("${art}")` } : undefined}>
        <span className="ov">
          {playing ? <PlayingBars acc="255,255,255" playing={isPlaying} /> : <PlayIcon size={13} nudge={false} />}
        </span>
      </span>
      <span className="sth-q-txt">
        <b>{t.title}</b>
        <small>{t.artist}</small>
      </span>
      {canDrag ? (
        <span className="sth-q-grip" aria-hidden>
          <svg width="10" height="14" viewBox="0 0 10 12" fill="currentColor">
            <circle cx="3" cy="2" r="1.1" /><circle cx="7" cy="2" r="1.1" />
            <circle cx="3" cy="6" r="1.1" /><circle cx="7" cy="6" r="1.1" />
            <circle cx="3" cy="10" r="1.1" /><circle cx="7" cy="10" r="1.1" />
          </svg>
        </span>
      ) : null}
    </div>
  );
}

/* Memoised, like InfoTab: the fullscreen view redraws as the song plays
   (its scrubber), and neither tab needs to follow it. */
const QueueTab = React.memo(function QueueTab({
  current, upNext, acc, coverFor, onSelectTrack, isPlaying = false,
  onReorder, queueOffset = 0,
}) {
  /* The row being dragged and where it would land, local until the drop. */
  const [dragFrom, setDragFrom] = useState(null);
  const [dragOver, setDragOver] = useState(null);

  /* How long what's next runs. Tracks with no length are left out and the
     total says "+" when any were. */
  const runtime = useMemo(() => {
    let secs = 0; let missing = false;
    for (const t of upNext) {
      if (Number.isFinite(t?.duration) && t.duration > 0) secs += t.duration;
      else missing = true;
    }
    if (!secs) return null;
    const h = Math.floor(secs / 3600);
    const m = Math.round((secs % 3600) / 60);
    return `${h >= 1 ? `${h} hr ${m} min` : `${Math.max(1, m)} min`}${missing ? '+' : ''}`;
  }, [upNext]);

  /* "Next from: …" when every song still to come was started from the same
     album or playlist page (Studio notes that for Spotify plays). */
  const from = useMemo(() => {
    let name = null;
    for (const t of upNext) {
      const n = playContextFor(spotifyIdOf(t))?.context?.name || null;
      if (!n || (name && n !== name)) return null;
      name = n;
    }
    return name;
  }, [upNext]);

  const rowProps = { coverFor, isPlaying, onReorder, queueOffset, dragFrom, dragOver, setDragFrom, setDragOver };

  return (
    <div className="sth-q sth-libscroll" style={{ '--q-acc': acc }}>
      <style>{QUEUE_CSS}</style>
      {current ? (
        <>
          <div className="sth-q-h">Now playing</div>
          <QueueRow {...rowProps} t={current} playing index={0} />
        </>
      ) : null}
      <div className="sth-q-h">
        {from ? <>Next from: <b>{from}</b></> : 'Next up'}
        {upNext.length ? <span className="m">{upNext.length} {upNext.length === 1 ? 'song' : 'songs'}{runtime ? ` · ${runtime}` : ''}</span> : null}
      </div>
      {upNext.length ? upNext.map((t, i) => (
        <QueueRow {...rowProps} key={`${t.id}-${i}`} t={t} index={i + 1} onClick={() => onSelectTrack?.(t)} />
      )) : (
        <div className="sth-q-empty">Nothing queued after this song.</div>
      )}
    </div>
  );
});

const LYRICS_CSS = `
.ly-empty { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 20px 28px 48px; text-align: center; }
.ly-empty .ic { color: rgba(var(--st-sub-rgb), 0.45); margin-bottom: 6px; }
.ly-empty b { font-size: 15px; font-weight: 800; color: var(--st-text); }
.ly-empty p { margin: 0 0 10px; font-size: 12.5px; line-height: 1.5; color: rgba(var(--st-sub-rgb), 0.55); max-width: 240px; }
.ly-acts { display: flex; align-items: center; gap: 10px; font-size: 13px; color: rgba(var(--st-sub-rgb), 0.35); }
.ly-link { border: none; background: none; padding: 2px 0; cursor: pointer; font: inherit; font-size: 13px; font-weight: 700; color: rgba(var(--st-text-rgb), 0.7); }
.ly-link:hover { color: var(--st-text); }
.ly-link.is-pri { color: rgb(var(--ly-acc)); font-weight: 800; }
.ly-link.is-pri:hover { text-decoration: underline; text-underline-offset: 3px; }
.ly-note { display: flex; align-items: center; gap: 8px; margin: 0 0 14px; padding: 2px 2px 10px; border-bottom: 1px solid rgba(var(--st-fg-rgb), 0.08);
  font-size: 12px; font-weight: 600; color: rgba(var(--st-sub-rgb), 0.55); }
.ly-note .ly-link { margin-left: auto; font-size: 12px; }
.ly-tools { position: absolute; right: 10px; bottom: 8px; display: flex; gap: 0; opacity: 0; transition: opacity .16s ease; }
.ly-wrap:hover .ly-tools, .ly-tools:focus-within { opacity: 1; }
.ly-tools button { width: 30px; height: 30px; border-radius: 6px; border: none; cursor: pointer; background: transparent; color: rgba(var(--st-text-rgb), 0.55);
  display: inline-flex; align-items: center; justify-content: center; transition: background .14s ease, color .14s ease; }
.ly-tools button:hover { background: rgba(var(--st-fg-rgb), 0.1); color: var(--st-text); }
.ly-hint { position: absolute; left: 16px; bottom: 16px; font-size: 11px; font-weight: 600; color: rgba(var(--st-sub-rgb), 0.36); pointer-events: none;
  opacity: 0; transition: opacity .16s ease; }
.ly-wrap:hover .ly-hint { opacity: 1; }
`;

const LyIcon = {
  pen: <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />,
  clock: <><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2M9 2h6" /></>,
  list: <path d="M4 6h16M4 12h16M4 18h10" />,
  quote: <><path d="M6.6 4.5h10.8a3 3 0 0 1 3 3v6.6a3 3 0 0 1-3 3H12l-3.9 3.4v-3.4H6.6a3 3 0 0 1-3-3V7.5a3 3 0 0 1 3-3z" /><path fill="currentColor" stroke="none" d="M9.90 8.30A1.30 1.30 0 0 1 11.20 9.60C11.20 11.20 10.30 12.40 8.80 13.00L8.50 12.50C9.40 12.00 9.80 11.40 9.90 10.90A1.30 1.30 0 0 1 9.90 8.30Z M14.30 8.30A1.30 1.30 0 0 1 15.60 9.60C15.60 11.20 14.70 12.40 13.20 13.00L12.90 12.50C13.80 12.00 14.20 11.40 14.30 10.90A1.30 1.30 0 0 1 14.30 8.30Z" /></>,
};
const Ly = ({ d, size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>
);

function LyricsTab({
  lyricsData, onLyricsSaved, track, accent, onSeek,
  onBrowseLyrics, selection = null, onSelectStart, onSelectLine,
}) {
  const synced = lyricsData?.synced?.length ? lyricsData.synced : null;
  const plain = lyricsData?.plain || null;
  const hasLyrics = !!(synced || plain);
  const acc = readableAccent(accent);
  const currentTime = usePlaybackTime();

  /* null, or the editor open in 'text' or 'sync'. Closed for a new song: its
     words aren't the ones being edited. */
  const [editing, setEditing] = useState(null);
  useEffect(() => { setEditing(null); }, [track ? track.id : null]);

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
          initialMode={editing}
          onSave={(newSynced, newPlain) => { onLyricsSaved?.(newSynced, newPlain, track?.id); setEditing(null); }}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  /* Instrumental is a fact about the song, not a gap to fill. */
  if (!hasLyrics) {
    const instrumental = !!lyricsData?.instrumental;
    return (
      <div className="ly-empty" style={{ '--ly-acc': acc }}>
        <style>{LYRICS_CSS}</style>
        <span className="ic"><Ly d={LyIcon.quote} size={24} /></span>
        <b>{instrumental ? 'Instrumental' : 'No lyrics yet'}</b>
        <p>{instrumental ? 'This song has no words to show.' : 'Paste them in, then time them to the song.'}</p>
        {track && !instrumental ? (
          <div className="ly-acts">
            <button type="button" className="ly-link is-pri" onClick={() => setEditing('text')}>Add lyrics</button>
            {onBrowseLyrics ? <><span aria-hidden>·</span><button type="button" className="ly-link" onClick={onBrowseLyrics}>Search online</button></> : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="ly-wrap" style={{ flex: 1, minHeight: 0, display: 'flex', padding: '0 4px 12px', position: 'relative', '--ly-acc': acc }}>
      <style>{LYRICS_CSS}</style>
      {synced ? (
        /* Selection props make the lines shareable — click one, drag to
           extend. The confirm bar and the card overlay are rendered once at
           the StudioHome level and are position:fixed, so they serve the dock
           and the fullscreen stage without either owning them. */
        <SyncedLyrics lines={synced} currentTime={currentTime} accent={accent} onSeek={onSeek} fontSize={16} lineHeight={1.5}
          selection={selection} onSelectStart={onSelectStart} onSelectLine={onSelectLine} />
      ) : (
        <div className="sth-libscroll" style={{ flex: 1, overflowY: 'auto', padding: '4px 12px' }}>
          {/* Untimed lyrics don't follow the song; say so quietly, with the fix. */}
          <div className="ly-note">
            <Ly d={LyIcon.clock} size={14} />
            Not synced to the song
            <button type="button" className="ly-link is-pri" onClick={() => setEditing('sync')}>Sync</button>
          </div>
          <PlainLyrics text={plain} accent={accent} fontSize={15} lineHeight={1.7}
            selection={selection} onSelectStart={onSelectStart} onSelectLine={onSelectLine} />
        </div>
      )}

      {/* Edit, sync and versions: small, out of the reading column, and
          faded until the pointer is over the lyrics. */}
      {track ? (
        <div className="ly-tools">
          <button type="button" onClick={() => setEditing('text')} title="Edit lyrics" aria-label="Edit lyrics"><Ly d={LyIcon.pen} size={13} /></button>
          <button type="button" onClick={() => setEditing('sync')} title={synced ? 'Adjust sync' : 'Sync'} aria-label="Sync"><Ly d={LyIcon.clock} size={14} /></button>
          {onBrowseLyrics ? (
            <button type="button" onClick={onBrowseLyrics} title="Other versions" aria-label="Other lyrics versions"><Ly d={LyIcon.list} size={14} /></button>
          ) : null}
        </div>
      ) : null}

      {synced && onSelectStart && !selection ? <div className="ly-hint">Click a line to share it</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------- info
 * The artist as a banner (photo, monthly listeners, Follow), a short bio,
 * this song's facts as chips, and its credits grouped by role.
 *
 * The bio and monthly listeners come from Spotify's artist overview (the
 * same one artist pages use, cached in main for an hour); without it the
 * banner shows followers and the genres stand in for the bio.
 * ------------------------------------------------------------------------ */

const INFO_CSS = `
.ni { flex: 1; min-height: 0; overflow-y: auto; padding: 0 12px 18px; }
.ni-ban { position: relative; height: 158px; border-radius: 16px; overflow: hidden; background: rgba(var(--st-fg-rgb), 0.08) center 30%/cover no-repeat; }
.ni-ban::after { content: ''; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,0.72)); }
.ni-ban .in { position: absolute; left: 14px; right: 14px; bottom: 12px; z-index: 1; }
.ni-ban .k { font-size: 10px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255,255,255,0.75); }
.ni-ban h3 { margin: 2px 0 1px; font-size: 22px; font-weight: 800; letter-spacing: -0.01em; color: #fff; line-height: 1.15;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ni-ban .s { font-size: 12px; color: rgba(255,255,255,0.78); }
.ni-fol { position: absolute; right: 10px; top: 10px; z-index: 1; height: 28px; padding: 0 12px; border-radius: 999px; border: none; cursor: pointer;
  font: inherit; font-size: 12px; font-weight: 800; background: rgba(0,0,0,0.38); color: #fff; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.35);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); transition: background .14s ease; }
.ni-fol:hover { background: rgba(0,0,0,0.55); }
.ni-fol.on { background: rgba(255,255,255,0.92); color: #111; box-shadow: none; }
.ni-bio { margin: 11px 2px 0; font-size: 12.5px; line-height: 1.55; color: rgba(var(--st-text-rgb), 0.75); white-space: pre-line; }
.ni-h + .ni-bio { margin-top: 0; }
.ni-bio.clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.ni-more { border: none; background: none; padding: 0; margin: 3px 2px 0; cursor: pointer; font: inherit; font-size: 12px; font-weight: 800; color: var(--st-text); }
.ni-h { margin: 18px 2px 8px; font-size: 13px; font-weight: 800; color: var(--st-text); }
/* A plain label / value list, one fact per row, hairlines between. */
.ni-facts { margin: 0 2px; }
.ni-facts > div { display: flex; align-items: baseline; gap: 16px; padding: 8px 0; font-size: 13px; }
.ni-facts > div + div { border-top: 1px solid rgba(var(--st-fg-rgb), 0.07); }
.ni-facts dt { flex-shrink: 0; font-weight: 600; color: rgba(var(--st-sub-rgb), 0.55); }
.ni-facts dd { margin: 0 0 0 auto; min-width: 0; font-weight: 700; text-align: right; color: rgba(var(--st-text-rgb), 0.88);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.ni-role { margin: 11px 2px 3px; font-size: 10.5px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(var(--st-sub-rgb), 0.45); }
.ni-role:first-of-type { margin-top: 0; }
.ni-names { margin: 0 2px; font-size: 13px; font-weight: 700; line-height: 1.5; color: rgba(var(--st-text-rgb), 0.88); }
.ni-none { margin: 0 2px; font-size: 12.5px; color: rgba(var(--st-sub-rgb), 0.45); line-height: 1.5; }
`;

/* One overview per artist per session, shared by every InfoTab. */
const overviewCache = new BoundedMap(120);
const isSpotifyId = (id) => /^[0-9A-Za-z]{22}$/.test(String(id || ''));
const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

const InfoTab = React.memo(function InfoTab({ track, art, artistInfo, credits, plays = 0 }) {
  const follows = useStudioFollows();
  const sid = isSpotifyId(artistInfo?.id) ? artistInfo.id : null;
  const [ov, setOv] = useState(() => (sid ? overviewCache.get(sid) || null : null));
  const [bioOpen, setBioOpen] = useState(false);
  useEffect(() => { setBioOpen(false); }, [sid]);
  useEffect(() => {
    if (!sid) { setOv(null); return undefined; }
    if (overviewCache.has(sid)) { setOv(overviewCache.get(sid)); return undefined; }
    setOv(null);
    let live = true;
    window.electronAPI?.spotifyPartnerArtist?.(sid).then((r) => {
      const data = r?.ok ? r.data : null;
      if (data) overviewCache.set(sid, data);
      if (live) setOv(data);
    }).catch(() => {});
    return () => { live = false; };
  }, [sid]);

  const name = artistInfo?.name || ov?.name || track?.artist || '';
  const image = ov?.header || artistInfo?.image || ov?.avatar || art || null;
  const listeners = Number.isFinite(ov?.monthlyListeners) ? `${compact(ov.monthlyListeners)} monthly listeners`
    : Number.isFinite(artistInfo?.followers) ? `${compact(artistInfo.followers)} followers` : null;
  const bio = ov?.biography || null;
  const genres = (artistInfo?.genres || []).slice(0, 3);
  const followed = name ? isStudioFollowed({ id: sid, name }, follows) : false;
  const toggleFollow = () => {
    if (followed) unfollowArtist({ id: sid, name });
    else followArtist({ id: sid, spotifyId: sid, name, image: artistInfo?.image || ov?.avatar || null });
  };

  const genre = parseGenres(track?.genre);
  const facts = [
    ['Album', track?.album],
    ['Year', track?.year],
    ['Track', Number.isFinite(track?.trackNumber) ? `${track.trackNumber}${track.trackTotal ? ` of ${track.trackTotal}` : ''}` : null],
    ['Length', track?.duration ? formatTime(track.duration) : null],
    [genre.length > 1 ? 'Genres' : 'Genre', genre.length ? genre.join(', ') : null],
    ['Plays', plays > 0 ? plays.toLocaleString() : null],
    ['Format', track?.filePath ? getFileFormatLabel(track.filePath) : null],
  ].filter(([, v]) => v != null && v !== '');

  return (
    <div className="ni sth-libscroll">
      <style>{INFO_CSS}</style>
      <div className="ni-ban" style={image ? { backgroundImage: `url("${image}")` } : undefined}>
        {name ? (
          <button type="button" className={`ni-fol${followed ? ' on' : ''}`} onClick={toggleFollow}
            title={followed ? 'Unfollow in Studio' : 'Follow in Studio (New Releases and countdowns)'}>
            {followed ? 'Following' : 'Follow'}
          </button>
        ) : null}
        <div className="in">
          <div className="k">Artist</div>
          <h3>{name || 'Unknown artist'}</h3>
          {listeners ? <div className="s">{listeners}</div> : null}
        </div>
      </div>

      {bio ? (
        <>
          {name ? <div className="ni-h">About {name}</div> : null}
          <p className={`ni-bio${bioOpen ? '' : ' clamp'}`}>{bio}</p>
          {bio.length > 160 ? <button type="button" className="ni-more" onClick={() => setBioOpen((v) => !v)}>{bioOpen ? 'Less' : 'More'}</button> : null}
        </>
      ) : genres.length ? <p className="ni-bio">{genres.join(' · ')}</p> : !artistInfo ? (
        <p className="ni-bio" style={{ color: 'rgba(var(--st-sub-rgb), 0.5)' }}>Connect Spotify in Settings for the artist&rsquo;s photo, bio and listeners.</p>
      ) : null}

      {facts.length ? (
        <>
          <div className="ni-h">This song</div>
          <dl className="ni-facts">
            {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd title={String(v)}>{v}</dd></div>)}
          </dl>
        </>
      ) : null}

      <div className="ni-h">Credits</div>
      {credits?.length ? credits.map((c, i) => (
        <React.Fragment key={`${c.role}-${i}`}>
          <div className="ni-role">{c.role}</div>
          <div className="ni-names">{c.name}</div>
        </React.Fragment>
      )) : (
        <p className="ni-none">{credits === null ? 'Looking up credits…' : 'No credits found for this song.'}</p>
      )}
    </div>
  );
});

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
/* The heart and add-to-playlist, for the bar and the full view. A song
   played straight from Spotify (a copied link, My Spotify) isn't in the
   library, so there's nothing to heart yet: the + saves it. Like Spotify's,
   the + turns into a tick the moment it's clicked (with a little pop), holds
   it until the save has landed and been seen, then gives way to the heart
   and add-to-playlist, which slide in. A save that fails puts the + back.
   Once saved, `saved` is the song's library row and the two act on that. */
const CHECK_HOLD_MS = 900;
function LibraryActions({ track, saved = null, onSave, saveBusy = false, saveFailed = false, onToggleFavorite, onAddToPlaylist }) {
  // null: nothing to show off · 'check': the tick · 'reveal': the two arriving
  const [phase, setPhase] = useState(null);
  const shownAt = useRef(0);
  useEffect(() => { setPhase(null); }, [track.id]);
  useEffect(() => {
    if (phase === 'check' && saveFailed && !saved) { setPhase(null); return undefined; }
    if (phase !== 'check' || !saved) return undefined;
    const t = setTimeout(() => setPhase('reveal'), Math.max(0, CHECK_HOLD_MS - (Date.now() - shownAt.current)));
    return () => clearTimeout(t);
  }, [phase, saved, saveFailed]);
  useEffect(() => {
    if (phase !== 'reveal') return undefined;
    const t = setTimeout(() => setPhase(null), 600);
    return () => clearTimeout(t);
  }, [phase]);

  if (phase === 'check' || (track.streamOnly && !saved && saveBusy)) {
    return (
      <button type="button" className="sth-npbtn sth-saved-tick" disabled title="Saved to your library" aria-label="Saved to your library">
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
          <circle cx="12" cy="12" r="9.5" fill="#fff" />
          <path d="M7.8 12.3l2.9 2.9 5.6-5.8" fill="none" stroke="#0b0b0d" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    );
  }
  if (track.streamOnly && !saved) {
    return onSave ? (
      <button type="button" className="sth-npbtn" onClick={() => { shownAt.current = Date.now(); setPhase('check'); onSave(track); }}
        title="Save to your library" aria-label="Save to your library">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="8.5" /><path d="M12 8.5v7M8.5 12h7" />
        </svg>
      </button>
    ) : null;
  }
  const t = saved || track;
  const arrive = phase === 'reveal';
  return (
    <>
      {onToggleFavorite ? (
        <button type="button" className={`sth-npbtn${t.isFavorite ? ' is-on' : ''}${arrive ? ' sth-lib-arrive' : ''}`} onClick={() => onToggleFavorite(t.id)}
          title={t.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          aria-label={t.isFavorite ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={!!t.isFavorite}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill={t.isFavorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.8 8.6a5 5 0 0 0-8.8-2.6A5 5 0 0 0 3.2 8.6c0 4.2 5.5 7.6 8.8 10.4 3.3-2.8 8.8-6.2 8.8-10.4z" />
          </svg>
        </button>
      ) : null}
      {onAddToPlaylist ? (
        <button type="button" className={`sth-npbtn${arrive ? ' sth-lib-arrive is-second' : ''}`} onClick={(e) => onAddToPlaylist(e, t)}
          title="Add to playlist" aria-label="Add to playlist" aria-haspopup="menu">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="8.5" /><path d="M12 8.5v7M8.5 12h7" />
          </svg>
        </button>
      ) : null}
    </>
  );
}

export function NowPlayingBar(props) {
  return props.track ? <NowPlayingBarBody {...props} /> : null;
}

function NowPlayingBarBody({ track, isPlaying, art, accent, immersePalette = null, onZoomCover, onCopyLink, copyBusy = false, onTogglePlay, onPrev, onNext, volume = 1, onSetVolume, gainBoost = 1, onSetGainBoost, getGainReduction = null, animatedBg = false, solidWash = null, onSeek, onFullscreen, onToggleQueue, queueOpen = false, onToggleLyrics, lyricsOpen = false, onToggleFavorite, onAddToPlaylist, onMore, savedTrack = null, onSaveToLibrary = null, saveBusy = false, saveFailed = false, compact = false, shuffleOn = false, repeat = 'off', onToggleShuffle, onToggleRepeat }) {
  const currentTime = usePlaybackTime();
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
          {/* Beside the title rather than in the right-hand cluster, which
              they crowded at full size: the heart and add-to-playlist are
              about the song. Compact's bar keeps them on the right. */}
          {!compact ? (
            <div className="sth-npbar-lib">
              <LibraryActions track={track} saved={savedTrack} onSave={onSaveToLibrary} saveBusy={saveBusy} saveFailed={saveFailed}
                onToggleFavorite={onToggleFavorite} onAddToPlaylist={onAddToPlaylist} />
            </div>
          ) : null}
        </div>

        {/* ---- Centre: transport, scrubber directly beneath ---- */}
        <div className="sth-npbar-mid">
          <div className="sth-npbar-transport">
            {onToggleShuffle ? (
              <button type="button" className={`sth-npbtn is-toggle${shuffleOn ? ' is-on' : ''}`} onClick={onToggleShuffle}
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
              <button type="button" className={`sth-npbtn is-toggle${repeat !== 'off' ? ' is-on' : ''}`} onClick={onToggleRepeat}
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
              <div className="sth-npbar-seek-fill" style={{ width: `${shownPct}%` }}>
                <span className="sth-npbar-seek-knob" />
              </div>
            </div>
            <span className="sth-npbar-t st-num">{fmtT(dur)}</span>
          </div>
        </div>

        {/* ---- Right, 282px: three clusters ---- */}
        <div className="sth-npbar-right">
          {compact ? (
            <>
              <div className="sth-npbar-cluster">
                <LibraryActions track={track} saved={savedTrack} onSave={onSaveToLibrary} saveBusy={saveBusy} saveFailed={saveFailed}
                  onToggleFavorite={onToggleFavorite} onAddToPlaylist={onAddToPlaylist} />
              </div>
              <span aria-hidden className="sth-npbtn-rule" />
            </>
          ) : null}
          <div className="sth-npbar-cluster">
            {onToggleQueue ? (
              <button type="button" className={`sth-npbtn is-toggle${queueOpen ? ' is-on' : ''}`} onClick={onToggleQueue}
                title="Queue" aria-label="Queue" aria-pressed={queueOpen}>
                {/* Queue: the song playing now (the pill) over what's next. */}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="5.5" rx="2.75" /><path d="M3 14.5h18M3 19.5h18" />
                </svg>
              </button>
            ) : null}
            {onToggleLyrics ? (
              <button type="button" className={`sth-npbtn is-toggle${lyricsOpen ? ' is-on' : ''}`} onClick={onToggleLyrics}
                title="Lyrics" aria-label="Lyrics" aria-pressed={lyricsOpen}>
                {/* Lyrics: a speech bubble with quote marks. */}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6.6 4.5h10.8a3 3 0 0 1 3 3v6.6a3 3 0 0 1-3 3H12l-3.9 3.4v-3.4H6.6a3 3 0 0 1-3-3V7.5a3 3 0 0 1 3-3z" /><path fill="currentColor" stroke="none" d="M9.90 8.30A1.30 1.30 0 0 1 11.20 9.60C11.20 11.20 10.30 12.40 8.80 13.00L8.50 12.50C9.40 12.00 9.80 11.40 9.90 10.90A1.30 1.30 0 0 1 9.90 8.30Z M14.30 8.30A1.30 1.30 0 0 1 15.60 9.60C15.60 11.20 14.70 12.40 13.20 13.00L12.90 12.50C13.80 12.00 14.20 11.40 14.30 10.90A1.30 1.30 0 0 1 14.30 8.30Z" />
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
