import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { Shuffle, Repeat, Repeat1 } from 'lucide-react';
import Icons from './Icons.jsx';
import { MetadataEditor, AlbumMetadataEditor } from './MetadataEditor.jsx';
import { formatTime, titleCollator } from './mediaUtils.js';
import { HeartSlider, DownloadProgressBar, useDownloadProgress, VideoPicker, PlayIcon } from './sharedUI.jsx';
import { useToast } from './Toasts.jsx';
import { SyncedLyrics, PlainLyrics, LyricsEditor } from './Lyrics.jsx';
import { LyricsPickerButton } from './LyricsPicker.jsx';
import { AnimatedGradientBg } from './VisualEffects.jsx';

/** Compact dock-scale control button for the fullscreen pill. The shared
 * MediaPlayPauseBtn/MediaSkipBtn are 56/40px — sized for the now-playing
 * page — so the pill uses these 28px equivalents instead. `emphasized`
 * gives play/pause a subtle filled chip so it reads as the primary action
 * without ballooning the pill. */
function FsDockBtn({ children, onClick, title, active = false, emphasized = false }) {
  const [hov, setHov] = useState(false);
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        width: emphasized ? 32 : 28, height: emphasized ? 32 : 28,
        borderRadius: emphasized ? '50%' : 8, border: 'none', padding: 0,
        background: 'transparent',
        color: emphasized
          ? (hov ? '#fff' : 'rgba(255,255,255,0.85)')
          : (active ? '#fff' : hov ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.6)'),
        cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        transition: 'color 0.15s, transform 0.15s',
        transform: emphasized && hov ? 'scale(1.08)' : 'scale(1)',
        flexShrink: 0,
      }}>
      {children}
    </button>
  );
}

/** Hover-revealed lyric actions pinned to a lyrics column's top-right:
 * pencil = open the editor (edit / add / tap-to-sync), list = browse
 * online versions. Revealed by the column's :hover via .fs-lyrcol. */
function LyricTools({ onEdit, onBrowse }) {
  const btn = {
    width: 28, height: 28, borderRadius: 8, padding: 0,
    border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer',
    background: 'rgba(0,0,0,0.45)', color: 'rgba(255,255,255,0.75)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
    transition: 'background 0.15s ease, color 0.15s ease',
  };
  const hov = (e) => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.background = 'rgba(0,0,0,0.7)'; };
  const out = (e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.75)'; e.currentTarget.style.background = 'rgba(0,0,0,0.45)'; };
  return (
    <div className="fs-lyrtools" style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 6, zIndex: 3 }}>
      {onEdit ? (
        <button type="button" title="Edit lyrics · tap-to-sync" style={btn} onMouseEnter={hov} onMouseLeave={out}
          onClick={(e) => { e.stopPropagation(); onEdit(); }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>
        </button>
      ) : null}
      {onBrowse ? (
        <button type="button" title="Browse lyrics versions" style={btn} onMouseEnter={hov} onMouseLeave={out}
          onClick={(e) => { e.stopPropagation(); onBrowse(); }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
      ) : null}
    </div>
  );
}

/**
 * DockCard — ONE element in two states. Closed: a small centered chip
 * peeking over the transport dock. Open: the SAME box stretches along the
 * dock into a short, wide strip (never a tall panel), so it hugs the bar
 * instead of climbing over the cover art or the lyrics. Width, height and
 * radius morph together on one spring; content is laid out horizontally
 * and rides in late / bails out first.
 */
function DockCard({ side, label, open, onToggle, accent, layout = 'lane', meta = null, dockBarH = 48, children }) {
  const [hov, setHov] = useState(false);
  const spring = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const TUCK = 6;          // how much of the chip hides behind the dock
  const VISIBLE = 27;      // the label band you can actually see
  const chipH = VISIBLE + TUCK;
  // 'wrap' sizes itself to its content: a ResizeObserver on an inner,
  // never-clipped wrapper reports the grid's TRUE height — re-wraps from
  // window resizes or late data loads re-measure automatically. Numeric
  // px, so the open/close morph still animates.
  const measureRef = useRef(null);
  const [wrapH, setWrapH] = useState(null);
  useLayoutEffect(() => {
    if (layout !== 'wrap') return undefined;
    const el = measureRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h > 0) setWrapH(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout]);
  // 34 header + 4/10 body padding + 2 safety.
  const openH = layout === 'wrap'
    ? Math.min(Math.max((wrapH || 112) + 50, 96), 260)
    : 176;
  return (
    <div
      role={open ? 'dialog' : 'button'}
      aria-label={label}
      tabIndex={open ? -1 : 0}
      onClick={open ? undefined : onToggle}
      onKeyDown={open ? undefined : (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        position: 'absolute', bottom: dockBarH - TUCK, [side]: 14, zIndex: open ? 2 : 1,
        pointerEvents: 'auto',
        width: open ? 'calc(100% - 28px)' : 128,
        height: open ? openH : chipH,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        borderRadius: open ? 16 : '10px 10px 0 0',
        border: '1px solid rgba(255,255,255,0.1)',
        background: open ? 'rgba(18,18,20,0.78)' : (hov ? 'rgba(26,26,30,0.72)' : 'rgba(18,18,20,0.62)'),
        backdropFilter: 'blur(30px) saturate(1.6)', WebkitBackdropFilter: 'blur(30px) saturate(1.6)',
        boxShadow: open
          ? `0 24px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(${accent},0.22)`
          : '0 -8px 24px rgba(0,0,0,0.35)',
        cursor: open ? 'default' : 'pointer',
        transform: !open && hov ? 'translateY(-4px)' : 'translateY(0)',
        transition: [
          `width 360ms ${spring}`,
          `height 360ms ${spring}`,
          `border-radius 360ms ${spring}`,
          `transform 200ms ${spring}`,
          'background 180ms ease',
          'box-shadow 360ms ease',
        ].join(', '),
      }}
    >
      {/* Header — the same text is chip label and strip title. Centered in
          the chip, slides to the leading edge as the strip stretches. */}
      <div
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        style={{
          position: 'relative', display: 'flex', alignItems: 'center', flexShrink: 0, cursor: 'pointer',
          height: open ? 34 : VISIBLE, padding: open ? '4px 84px 0 16px' : 0,
          transition: `padding 360ms ${spring}, height 360ms ${spring}`,
        }}
      >
        {/* Label — the ONLY element in flow, so the closed chip centers it
            perfectly; open slides it to the leading edge. */}
        <div style={{
          flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          textAlign: open ? 'left' : 'center',
          fontSize: open ? 11 : 9.5, fontWeight: 800, lineHeight: open ? '34px' : `${VISIBLE}px`,
          letterSpacing: '0.12em', textTransform: 'uppercase',
          color: open || hov ? '#fff' : 'rgba(255,255,255,0.55)',
          transition: `font-size 360ms ${spring}, color 0.15s ease`,
        }}>
          {label}
        </div>
        {/* Right cluster — meta + × float absolutely so they never shove the
            label off-center; they only materialize once the strip is open. */}
        <div style={{
          position: 'absolute', right: 12, top: 0, bottom: 0,
          display: 'flex', alignItems: 'center', gap: 10,
          opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none',
          transition: open ? 'opacity 180ms ease 180ms' : 'opacity 100ms ease',
        }}>
          {meta ? (
            <span style={{ fontSize: 9, letterSpacing: '0.06em', color: 'rgba(255,255,255,0.32)', whiteSpace: 'nowrap' }}>{meta}</span>
          ) : null}
          <button
            type="button" title="Close"
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            style={{
              width: 22, height: 22, borderRadius: 7, border: 'none', cursor: 'pointer',
              background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, flexShrink: 0,
            }}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      </div>
      {/* Body — fades/rises in once the strip has mostly stretched; leaves
          first on close so the box collapses empty. 'wrap' flows groups into
          rows so everything fits one page; 'lane' is a column-flow grid. */}
      <div style={{
        flex: 1, minHeight: 0,
        padding: '4px 14px 10px',
        ...(layout === 'wrap' ? {
          display: 'block', overflow: 'hidden',
        } : {
          display: 'grid', gridTemplateRows: 'repeat(3, 1fr)', gridAutoFlow: 'column',
          gridAutoColumns: 'minmax(210px, 250px)', gap: '1px 20px',
          overflowX: 'auto', overflowY: 'hidden',
        }),
        opacity: open ? 1 : 0,
        transform: open ? 'translateY(0)' : 'translateY(10px)',
        pointerEvents: open ? 'auto' : 'none',
        transition: open
          ? `opacity 220ms ease 150ms, transform 340ms ${spring} 130ms`
          : 'opacity 110ms ease, transform 150ms ease',
        scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.15) transparent',
      }}>
        {layout === 'wrap' ? (
          <div ref={measureRef} style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
            gridAutoRows: 'auto', alignContent: 'start', gap: '10px 16px',
          }}>
            {children}
          </div>
        ) : children}
      </div>
    </div>
  );
}

/** One labelled group inside the Credits card. */
function CreditGroup({ label, names, accent = '160,160,160', style }) {
  return (
    <div style={{
      minWidth: 0, minHeight: 42, overflow: 'hidden', padding: '2px 0 2px 10px',
      borderLeft: `2px solid rgba(${accent}, 0.4)`,
      display: 'flex', flexDirection: 'column', justifyContent: 'flex-start',
      ...style,
    }}>
      <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)', marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      <div style={{
        fontSize: 11.5, fontWeight: 500, color: 'rgba(255,255,255,0.9)', lineHeight: 1.4,
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }} title={names.join(', ')}>{names.join(', ')}</div>
    </div>
  );
}

/** Tiny 3-bar equalizer marking the playing row in the library panel.
 *  Animates while playing, freezes as short bars when paused. */
function FsEqBadge({ accent, playing = true }) {
  return (
    <span aria-label="Now playing" title="Now playing"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 2.5, height: 14, flexShrink: 0, verticalAlign: 'middle' }}>
      {[0, 1, 2].map((i) => (
        <span key={i} style={{
          width: 2.5, height: 5, borderRadius: 2,
          background: `rgb(${accent})`,
          boxShadow: `0 0 6px rgba(${accent}, 0.6)`,
          animation: playing ? `immerseFsEqBar 0.9s ease ${i * 0.18}s infinite` : 'none',
        }} />
      ))}
    </span>
  );
}

/**
 * Download button / inline progress bar for the command-center find rows.
 * TOP-LEVEL on purpose: a stable component identity means React updates the
 * existing DOM node across the overlay's frequent playback re-renders instead
 * of remounting it — keeping the progress animation running smoothly and the
 * button clickable mid-render.
 */
function DlBtn({ st, progress, accent, onClick, title: t }) {
  if (st === 'busy') {
    const pct = typeof progress?.pct === 'number' ? progress.pct : null;
    return (
      <div title={progress?.phase === 'processing' ? 'Processing…' : 'Downloading…'} style={{ width: 52, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
        <DownloadProgressBar pct={pct} accent={accent} height={5} />
      </div>
    );
  }
  return (
    <button type="button" title={st === 'failed' ? 'Retry' : t}
      disabled={st === 'done'}
      onClick={onClick}
      style={{
        width: 26, height: 26, borderRadius: 8, flexShrink: 0, border: 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: st === 'done' ? 'default' : 'pointer',
        background: st === 'done' ? `rgba(${accent},0.3)` : 'rgba(255,255,255,0.07)',
        color: st === 'failed' ? '#f0a0a0' : st === 'done' ? '#fff' : 'rgba(255,255,255,0.65)',
        transition: 'background 0.2s ease, color 0.2s ease',
      }}>
      {st === 'done' ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
      )}
    </button>
  );
}

function CoverFullscreenOverlay({
  coverUrl, title, artist, album, accent, mid, wash,
  isPlaying = false, currentTime = 0, duration = 0,
  shuffleOn = false, repeat = 'off',
  volume = 1, onSetVolume,
  nowPlayingSliderStyle = 'circle',
  onTogglePlay, onPrev, onNext, onSeek, onToggleShuffle, onToggleRepeat,
  lyricsData = null, hasSyncedLyrics = false, hasPlainLyrics = false,
  analyserRef = null, beatReactive = false,
  fullscreenLyricsMode = 'side',
  onSetFullscreenLyricsMode,
  library = [], onSelectTrack, currentTrackId = null,
  albumCoverOverrides = {},
  playEvents = [], releases = [],
  onTrackImported,
  // --- studio additions — all optional, so existing call sites that don't
  // pass them (Immerse) render exactly as before. ------------------------
  transitionMode = 'off',      // 'off' | 'gapless' | 'crossfade'
  onSetTransitionMode,         // present → gapless toggle appears in Settings
  onUpdateTrackMetadata,       // present → "Edit track info" appears
  onRemoveFromLibrary,         // present → "Remove from library" appears
  onUpdateAlbumMetadata,       // present → album pencil appears in the panel
  onSetAlbumCover,             // (albumKey, url|null) — pins album art
  onSaveLyricsEdited,          // (synced, plain) — editor saved; update cache
  onPickLyrics,                // (candidate) — lyrics browser pick
  upNext = [],                 // queue slice AFTER the playing track
  onClose,
}) {
  const dialogRef = useRef(null);

  // --- Metadata editor ----------------------------------------------------
  // Edits the CURRENTLY PLAYING track without leaving fullscreen. The
  // overlay only receives display strings (title/artist/album), so the full
  // track object is resolved from the library by id.
  // Which track the metadata editor is open FOR — any library track, not
  // just the playing one (the panel rows open it too). Deliberately NOT
  // auto-closed on track change: a gapless handoff mid-edit must not eat
  // the form.
  const [metaEditTarget, setMetaEditTarget] = useState(null);
  // Album-wide edit scope for AlbumMetadataEditor (panel album view).
  const [albumEditScope, setAlbumEditScope] = useState(null);
  // Lyrics editor modal (edit / add / tap-to-sync) + the lyrics-browser
  // open counter (the picker opens when this increments).
  const [lyricsEditing, setLyricsEditing] = useState(false);
  const [lyricsPickReq, setLyricsPickReq] = useState(0);

  // --- Dock cards: Credits + Up next -------------------------------------
  // Two glass cards peek from behind the transport dock; clicking a tab
  // raises its panel. Credits come from Genius via main (cached per track).
  const [dockCard, setDockCard] = useState(null); // null | 'credits' | 'queue'
  // The dock bar's measured height — the chips tuck EXACTLY 6px behind its
  // top edge, and the chip label centers in exactly what remains visible.
  // Measured, not assumed: the bar's height depends on its content.
  const dockBarRef = useRef(null);
  const [dockBarH, setDockBarH] = useState(48);
  useLayoutEffect(() => {
    const el = dockBarRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      const h = Math.round(el.getBoundingClientRect().height);
      if (h > 0) setDockBarH(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [creditsData, setCreditsData] = useState(null); // { state, credits? }
  const creditsCacheRef = useRef(new Map()); // trackId → result
  const creditsReqRef = useRef(0);
  useEffect(() => {
    // Track change: keep the open card, refetch credits for the new song.
    if (dockCard !== 'credits' || !currentTrackId) return undefined;
    const apiEl = typeof window !== 'undefined' ? window.electronAPI : null;
    const cached = creditsCacheRef.current.get(currentTrackId);
    if (cached) { setCreditsData(cached); return undefined; }
    if (!apiEl?.geniusCredits) { setCreditsData({ state: 'unavailable' }); return undefined; }
    const reqId = ++creditsReqRef.current;
    setCreditsData({ state: 'loading' });
    apiEl.geniusCredits({ title, artist }).then((res) => {
      if (creditsReqRef.current !== reqId) return;
      const data = res?.ok && res.credits ? { state: 'ok', credits: res.credits } : { state: 'none' };
      creditsCacheRef.current.set(currentTrackId, data);
      setCreditsData(data);
    }).catch(() => {
      if (creditsReqRef.current !== reqId) return;
      setCreditsData({ state: 'none' });
    });
    return undefined;
  }, [dockCard, currentTrackId, title, artist]);
  // Esc closes an open dock card before anything else would react.
  useEffect(() => {
    if (!dockCard) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopImmediatePropagation();
      setDockCard(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dockCard]);
  // A NEW track's lyrics under an open editor would be a lie — close it.
  useEffect(() => { setLyricsEditing(false); }, [currentTrackId]);
  const editableTrack = useMemo(
    () => (Array.isArray(library) ? library.find((t) => t.id === currentTrackId) : null) || null,
    [library, currentTrackId],
  );
  const canEditMeta = !!onUpdateTrackMetadata && !!editableTrack;
  // Esc while an editor is open closes the EDITOR, not fullscreen —
  // captured at the window, same pattern as the library panel and the
  // lyric-selection interceptors below.
  useEffect(() => {
    if (!metaEditTarget && !albumEditScope && !lyricsEditing) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopImmediatePropagation();
      setMetaEditTarget(null); setAlbumEditScope(null); setLyricsEditing(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [metaEditTarget, albumEditScope, lyricsEditing]);

  // --- Stage-view track menu (⋯ next to the title) ------------------------
  // Edit / remove the playing track (and its album) without opening the
  // command center. Same arm-then-confirm pattern as the home screen.
  const [fsMenu, setFsMenu] = useState(null); // { x, y, track }
  const [fsConfirm, setFsConfirm] = useState(null);
  const closeFsMenu = useCallback(() => { setFsMenu(null); setFsConfirm(null); }, []);
  useEffect(() => {
    if (!fsMenu) return undefined;
    const onDown = () => closeFsMenu();
    const onKey = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); closeFsMenu(); } };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onDown);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onDown);
    };
  }, [fsMenu, closeFsMenu]);
  /** Library tracks sharing a track's album (album + artist). */
  const albumMatesOf = useCallback((track) => {
    if (!track) return [];
    const alb = (track.album || '').toLowerCase().trim();
    const art = (track.artist || '').toLowerCase().trim();
    if (!alb || !Array.isArray(library)) return [track];
    return library.filter((t) => (t.album || '').toLowerCase().trim() === alb
      && (t.artist || '').toLowerCase().trim() === art);
  }, [library]);

  // Library browser panel (slide-in from the left). Lets you pick another
  // track without leaving fullscreen.
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [librarySearch, setLibrarySearch] = useState('');
  const [librarySelIndex, setLibrarySelIndex] = useState(0);
  const librarySearchRef = useRef(null);
  const libraryListRef = useRef(null);
  const prevLibOpenRef = useRef(false);
  const canBrowse = Array.isArray(library) && library.length > 0 && typeof onSelectTrack === 'function';

  // --- Search card tabs -------------------------------------------------
  // The card is a mini command center now: Library (search + full list),
  // Releases (a compact view of the Explore feed), Stats (recent listening
  // pulled from playEvents), Settings (fullscreen layout picker).
  const [cardTab, setCardTab] = useState('library');
  useEffect(() => { if (libraryOpen) setCardTab('library'); }, [libraryOpen]);
  // Coming back to Library from another section: the input is a brand-new
  // node, so it needs focus again (and the highlight should start at the top).
  useEffect(() => {
    if (!libraryOpen || cardTab !== 'library') return undefined;
    setLibrarySelIndex(0);
    const id = setTimeout(() => librarySearchRef.current?.focus(), 60);
    return () => clearTimeout(id);
  }, [cardTab, libraryOpen]);
  // Centered mode has no ghost flight to cover the card's exit — keep the
  // card mounted briefly so its Out animation can play. Rail mode needs the
  // same thing: it used to stay mounted only because a cover ghost happened
  // to exist, so any close without a ghost (or with a failed measurement)
  // yanked the card out of the DOM with no exit at all. cardExiting now owns
  // the exit in BOTH modes — the ghost is irrelevant to it.
  const [cardExiting, setCardExiting] = useState(false);
  const cardExitTimerRef = useRef(null);
  useEffect(() => () => { if (cardExitTimerRef.current) clearTimeout(cardExitTimerRef.current); }, []);
  // The close choreography, in reverse order of the entrance (which goes
  // card → menu → icons). Everything lands at 420ms, exactly when the
  // artwork touches back down in the center.
  const CARD_EXIT_MS = 260;

  // --- Movable command center ------------------------------------------
  // The card can be dragged anywhere on screen by its grip strip; the
  // offset persists across sessions. Double-click the grip to snap home
  // (animated). The translate lives on a WRAPPER, not the card itself —
  // the card's enter/exit keyframes fill their transform, which would
  // silently override an inline translate on the same element.
  const [cardOffset, setCardOffset] = useState(() => {
    try {
      const raw = window.localStorage.getItem('immerse:fsCardOffset');
      if (raw) {
        const v = JSON.parse(raw);
        if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) return { x: v.x, y: v.y };
      }
    } catch { /* ignore */ }
    return { x: 0, y: 0 };
  });
  const cardDragRef = useRef(null);
  const persistCardOffset = useCallback((off) => {
    try { window.localStorage.setItem('immerse:fsCardOffset', JSON.stringify(off)); } catch { /* ignore */ }
  }, []);
  const handleCardGripDown = useCallback((e) => {
    if (e.button !== 0) return;
    const cardEl = e.currentTarget.parentElement;
    if (!cardEl) return;
    const rect = cardEl.getBoundingClientRect();
    // Bounds keep the whole card on screen with a 12px margin.
    cardDragRef.current = {
      startX: e.clientX, startY: e.clientY,
      baseX: cardOffset.x, baseY: cardOffset.y,
      // +58: the docked side menu extends left of the card and must stay
      // on screen too.
      minX: cardOffset.x - rect.left + 12 + 58,
      maxX: cardOffset.x + (window.innerWidth - rect.right) - 12,
      minY: cardOffset.y - rect.top + 12,
      maxY: cardOffset.y + (window.innerHeight - rect.bottom) - 12,
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }, [cardOffset]);
  const handleCardGripMove = useCallback((e) => {
    const d = cardDragRef.current;
    if (!d) return;
    setCardOffset({
      x: Math.min(d.maxX, Math.max(d.minX, d.baseX + (e.clientX - d.startX))),
      y: Math.min(d.maxY, Math.max(d.minY, d.baseY + (e.clientY - d.startY))),
    });
  }, []);
  const handleCardGripUp = useCallback(() => {
    if (!cardDragRef.current) return;
    cardDragRef.current = null;
    setCardOffset((off) => { persistCardOffset(off); return off; });
  }, [persistCardOffset]);
  const resetCardOffset = useCallback(() => {
    setCardOffset({ x: 0, y: 0 });
    persistCardOffset({ x: 0, y: 0 });
  }, [persistCardOffset]);

  // --- Resizable command center ------------------------------------------
  // Drag the bottom-right grip to size the card freely; null means "default"
  // (the cover's square). The size persists like the offset does. The slot
  // stays CENTER-anchored, so the rail — which spans the card's height and
  // flex-centers itself — keeps riding the vertical middle at any size.
  const [cardSize, setCardSize] = useState(() => {
    try {
      const raw = window.localStorage.getItem('immerse:fsCardSize');
      if (raw) {
        const v = JSON.parse(raw);
        if (v && Number.isFinite(v.w) && Number.isFinite(v.h)) return { w: v.w, h: v.h };
      }
    } catch { /* ignore */ }
    return null;
  });
  const cardResizeRef = useRef(null);
  const persistCardSize = useCallback((sz) => {
    try {
      if (sz) window.localStorage.setItem('immerse:fsCardSize', JSON.stringify(sz));
      else window.localStorage.removeItem('immerse:fsCardSize');
    } catch { /* ignore */ }
  }, []);
  const handleCardResizeDown = useCallback((e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const cardEl = e.currentTarget.parentElement;
    const rect = cardEl?.getBoundingClientRect();
    if (!rect) return;
    cardResizeRef.current = { startX: e.clientX, startY: e.clientY, baseW: rect.width, baseH: rect.height };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);
  const handleCardResizeMove = useCallback((e) => {
    const d = cardResizeRef.current;
    if (!d) return;
    // The card is center-anchored, so both edges move when it grows — 2×
    // the pointer delta keeps the grip tracking under the cursor.
    setCardSize({
      w: Math.round(Math.min(window.innerWidth - 130, Math.max(300, d.baseW + (e.clientX - d.startX) * 2))),
      h: Math.round(Math.min(window.innerHeight - 60, Math.max(320, d.baseH + (e.clientY - d.startY) * 2))),
    });
  }, []);
  const handleCardResizeUp = useCallback(() => {
    if (!cardResizeRef.current) return;
    cardResizeRef.current = null;
    setCardSize((sz) => { persistCardSize(sz); return sz; });
  }, [persistCardSize]);
  const resetCardSize = useCallback(() => { setCardSize(null); persistCardSize(null); }, [persistCardSize]);

  const listeningStats = useMemo(() => {
    if (!libraryOpen || cardTab !== 'stats') return null;
    const now = Date.now();
    const DAY = 86400000;
    const libMap = new Map(library.map((t) => [t.id, t]));
    const trackCounts = new Map();
    const artistCounts = new Map();
    let plays7 = 0;
    let plays30 = 0;
    let listenMs30 = 0;
    for (const ev of playEvents || []) {
      const age = now - (ev?.at || 0);
      if (age > 30 * DAY) continue;
      plays30 += 1;
      if (age <= 7 * DAY) plays7 += 1;
      const t = libMap.get(ev.id);
      if (t?.duration) listenMs30 += t.duration * 1000;
      trackCounts.set(ev.id, (trackCounts.get(ev.id) || 0) + 1);
      const a = t?.artist;
      if (a) artistCounts.set(a, (artistCounts.get(a) || 0) + 1);
    }
    const topTracks = [...trackCounts.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([id, n]) => ({ track: libMap.get(id), n }))
      .filter((x) => x.track);
    const topArtists = [...artistCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    return { plays7, plays30, hours30: listenMs30 / 3600000, topTracks, topArtists };
  }, [libraryOpen, cardTab, playEvents, library]);

  // --- Lyric share selection (fullscreen) -------------------------------
  // Same vocabulary as the dock lyrics panel: long-press or right-click a
  // line to anchor a selection, tap other lines to extend/contract
  // (Apple-style: outside the range extends, inside snaps the nearer
  // edge), then Share copies the card image instantly via the headless
  // LyricShareOverlay. All chrome uses the fullscreen glass style.
  const [lyricSel, setLyricSel] = useState(null);            // {start,end} | null
  const [lyricShareRunning, setLyricShareRunning] = useState(false);
  const [lyricShareNote, setLyricShareNote] = useState(null); // {ok,msg} | null
  const lyricNoteTimerRef = useRef(null);

  const handleFsSelectStart = useCallback((idx) => {
    if (typeof idx !== 'number' || idx < 0) return;
    setLyricSel({ start: idx, end: idx });
  }, []);
  const handleFsSelectExtend = useCallback((idx) => {
    if (typeof idx !== 'number' || idx < 0) return;
    setLyricSel((cur) => {
      if (!cur) return { start: idx, end: idx };
      const { start, end } = cur;
      if (idx < start) return { start: idx, end };
      if (idx > end) return { start, end: idx };
      const distToStart = idx - start;
      const distToEnd = end - idx;
      if (distToStart <= distToEnd) return { start: idx, end };
      return { start, end: idx };
    });
  }, []);
  const clearLyricSel = useCallback(() => {
    setLyricSel(null);
    setLyricShareRunning(false);
  }, []);
  const showLyricNote = useCallback((ok, msg) => {
    setLyricShareNote({ ok, msg });
    if (lyricNoteTimerRef.current) clearTimeout(lyricNoteTimerRef.current);
    lyricNoteTimerRef.current = setTimeout(() => setLyricShareNote(null), 2200);
  }, []);
  useEffect(() => () => { if (lyricNoteTimerRef.current) clearTimeout(lyricNoteTimerRef.current); }, []);

  // --- Find & Download --------------------------------------------------
  // Three modes, same as the main Find tab:
  //   • Songs    — Spotify catalogue tracks, fetched via the yt-dlp matcher.
  //   • Albums   — Spotify catalogue albums; open one for its tracklist and
  //                grab the whole thing or pick songs off it.
  //   • Soulseek — raw peer files, downloaded + imported in the main process.
  // The choice persists so the card opens on whichever you actually use.
  const [findSource, setFindSource] = useState(() => {
    try {
      const v = window.localStorage.getItem('immerse:fsFindSource');
      return (v === 'soulseek' || v === 'albums') ? v : 'spotify';
    } catch { return 'spotify'; }
  });
  const [findQuery, setFindQuery] = useState('');
  const [findBusy, setFindBusy] = useState(false);
  const [findResults, setFindResults] = useState([]);
  const [findError, setFindError] = useState('');
  const [dlState, setDlState] = useState({}); // key → 'busy' | 'done' | 'failed'
  const markDl = useCallback((k, v) => setDlState((m) => ({ ...m, [k]: v })), []);
  const pushToast = useToast();
  const { dlProgress } = useDownloadProgress();
  /** Surface the real reason a download failed, in a toast. */
  const toastError = useCallback((msg, fallback) => {
    pushToast?.({ message: String(msg || fallback || 'Download failed.'), kind: 'error', durationMs: 7000 });
  }, [pushToast]);
  // Manual YouTube video picker for imports that fail automatic matching.
  // Portals above this fullscreen overlay (older builds punted on this).
  const [pick, setPick] = useState(null); // { meta, seed, dlKey } | null
  const openPicker = useCallback((meta, res, dlKey) => {
    setPick({ meta, seed: res && Array.isArray(res.candidates) ? res.candidates : null, dlKey });
  }, []);
  // Catalogue-album expansion (Find → Albums)
  const [openFindAlbum, setOpenFindAlbum] = useState(null);
  const [findAlbumTracks, setFindAlbumTracks] = useState({});
  const [findAlbumBusy, setFindAlbumBusy] = useState({});
  const pickFindSource = useCallback((s) => {
    setFindSource(s);
    setFindResults([]); setFindError(''); setOpenFindAlbum(null);
    setFindSsAlbums([]); setOpenFindSsAlbum(null);
    try { window.localStorage.setItem('immerse:fsFindSource', s); } catch { /* ignore */ }
  }, []);

  // "Do I already own this?" — title + primary artist, same normalisation the
  // New Releases tab uses, so ownership ticks agree across the app.
  const primaryArtistOf = (s) => (s ? String(s).split(/,|feat\.|ft\.|&|\bx\b/i)[0].trim().toLowerCase() : '');
  const ownedKeys = useMemo(() => {
    const set = new Set();
    for (const t of library || []) {
      if (t?.title) set.add(`${String(t.title).trim().toLowerCase()}|${primaryArtistOf(t.artist)}`);
    }
    return set;
  }, [library]);
  const alreadyOwned = useCallback(
    (title, artist) => ownedKeys.has(`${String(title || '').trim().toLowerCase()}|${primaryArtistOf(artist)}`),
    [ownedKeys],
  );

  // Soulseek album folders — grouped by soulseekClient in the main process
  // (same uploader + folder, quality-ranked). Expanded/collapsed per id;
  // whole-album downloads stream aggregate progress events.
  const [findSsAlbums, setFindSsAlbums] = useState([]);
  const [openFindSsAlbum, setOpenFindSsAlbum] = useState(null);
  const [findSsAlbumProg, setFindSsAlbumProg] = useState({}); // albumId → { completed, total }
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    const off = api?.onSoulseekAlbumProgress?.((pl) => {
      if (!pl?.albumId) return;
      setFindSsAlbumProg((m) => ({ ...m, [pl.albumId]: pl }));
    });
    return () => { try { off?.(); } catch { /* ignore */ } };
  }, []);

  /** Whole soulseek album folder → sequential download in the main process. */
  const downloadFindSsAlbum = useCallback(async (alb) => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.soulseekDownloadAlbum) return;
    const key = `ssa:${alb.id}`;
    if (dlState[key] === 'busy') return;
    markDl(key, 'busy');
    try {
      const res = await api.soulseekDownloadAlbum({ albumId: alb.id, tracks: alb.tracks });
      const got = Array.isArray(res?.tracks) ? res.tracks : [];
      for (const t of got) onTrackImported?.(t);
      markDl(key, got.length ? 'done' : 'failed');
      showLyricNote(got.length > 0, got.length
        ? `Saved “${alb.displayName}” (${got.length} ${got.length === 1 ? 'track' : 'tracks'})`
        : `Couldn’t download “${alb.displayName}”`);
      if (!got.length) toastError(res?.error, `Couldn’t download “${alb.displayName}”.`);
      else if (res?.partial) pushToast?.({ message: res.error || `Some tracks on “${alb.displayName}” couldn’t be downloaded.`, kind: 'warning', durationMs: 7000 });
    } catch (e) {
      markDl(key, 'failed');
      showLyricNote(false, 'Album download failed');
      toastError(e?.message || e, `Couldn’t download “${alb.displayName}”.`);
    }
  }, [dlState, markDl, onTrackImported, showLyricNote, pushToast, toastError]);

  const runFind = useCallback(async () => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    const q = findQuery.trim();
    if (!q || findBusy) return;
    setFindBusy(true); setFindError(''); setFindResults([]); setOpenFindAlbum(null);
    setFindSsAlbums([]); setOpenFindSsAlbum(null);
    try {
      if (findSource === 'spotify') {
        if (!api?.spotifySearch) { setFindError('Spotify search isn’t available — add your credentials in Settings.'); setFindBusy(false); return; }
        const list = await api.spotifySearch(q);
        const rows = Array.isArray(list) ? list.slice(0, 40) : [];
        setFindResults(rows);
        if (!rows.length) setFindError('No tracks found.');
      } else if (findSource === 'albums') {
        if (!api?.spotifySearchAlbums) { setFindError('Album search isn’t available — add your Spotify credentials in Settings.'); setFindBusy(false); return; }
        const list = await api.spotifySearchAlbums(q);
        const rows = Array.isArray(list) ? list.slice(0, 40) : [];
        setFindResults(rows);
        if (!rows.length) setFindError('No albums found.');
      } else {
        if (!api?.soulseekSearch) { setFindError('Soulseek isn’t available — configure it in Settings.'); setFindBusy(false); return; }
        const res = await api.soulseekSearch(q);
        if (res?.ok === false) { setFindError(res.error || 'Soulseek search failed.'); setFindBusy(false); return; }
        const rows = Array.isArray(res?.results) ? res.results.slice(0, 30) : [];
        const albs = Array.isArray(res?.albums) ? res.albums : [];
        setFindResults(rows);
        setFindSsAlbums(albs);
        if (!rows.length && !albs.length) setFindError('No results — try fewer words.');
      }
    } catch (e) {
      setFindError(String(e?.message || e));
    }
    setFindBusy(false);
  }, [findQuery, findBusy, findSource]);

  /** Spotify row → yt-dlp import. Mirrors FindTab's importSingle. */
  const downloadSpotifyRow = useCallback(async (row, opts = {}) => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.importFromYoutubeSearch) return;
    const key = `s:${row.spotifyId}`;
    const meta = {
      title: row.title, artists: row.artists, album: row.album || '',
      albumArtUrl: row.albumArtUrl || '', durationMs: row.durationMs ?? 0,
      spotifyId: row.spotifyId, trackNumber: row.trackNumber ?? null,
      discNumber: row.discNumber ?? null, explicit: row.explicit,
    };
    markDl(key, 'busy');
    try {
      const res = await api.importFromYoutubeSearch({ ...meta, progressId: key });
      if (res?.ok && res.track) {
        onTrackImported?.(res.track);
        markDl(key, 'done');
        showLyricNote(true, `Added “${row.title}” to your library`);
      } else {
        // Automatic matching failed — let the user choose the video. The picker
        // portals above this fullscreen overlay. In a batch we stay quiet and
        // leave the row retryable (retrying opens the picker).
        markDl(key, 'failed');
        if (opts.noPicker) { showLyricNote(false, `No clean match for “${row.title}”`); toastError(res?.error, `Couldn’t download “${row.title}”.`); }
        else openPicker(meta, res, key);
      }
    } catch (e) {
      markDl(key, 'failed');
      showLyricNote(false, 'Download failed');
      toastError(e?.message || e, `Couldn’t download “${row.title}”.`);
    }
  }, [onTrackImported, markDl, showLyricNote, toastError, openPicker]);

  /** Catalogue album → its tracklist (cached per albumId). */
  const toggleFindAlbum = useCallback(async (alb) => {
    const id = alb.albumId;
    setOpenFindAlbum((cur) => (cur === id ? null : id));
    if (findAlbumTracks[id] || findAlbumBusy[id]) return;
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.spotifyGetAlbumTracks) return;
    setFindAlbumBusy((m) => ({ ...m, [id]: true }));
    try {
      const res = await api.spotifyGetAlbumTracks(id);
      setFindAlbumTracks((m) => ({ ...m, [id]: Array.isArray(res?.tracks) ? res.tracks : [] }));
    } catch { /* the row just stays empty rather than exploding */ }
    setFindAlbumBusy((m) => ({ ...m, [id]: false }));
  }, [findAlbumTracks, findAlbumBusy]);

  /** Whole catalogue album — everything you don't already own, one at a time. */
  const downloadFindAlbum = useCallback(async (alb) => {
    const id = alb.albumId;
    const key = `sa:${id}`;
    markDl(key, 'busy');
    let tracks = findAlbumTracks[id];
    if (!tracks) {
      const api = typeof window !== 'undefined' ? window.electronAPI : null;
      try {
        const res = await api?.spotifyGetAlbumTracks?.(id);
        tracks = Array.isArray(res?.tracks) ? res.tracks : [];
        setFindAlbumTracks((m) => ({ ...m, [id]: tracks }));
      } catch { tracks = []; }
    }
    if (!tracks.length) {
      markDl(key, 'failed');
      showLyricNote(false, `Couldn’t load “${alb.name}”`);
      return;
    }
    const missing = tracks.filter((t) => !alreadyOwned(t.title, t.artists));
    if (!missing.length) {
      markDl(key, 'done');
      showLyricNote(true, 'You already have every track on this one');
      return;
    }
    showLyricNote(true, `Downloading “${alb.name}” — ${missing.length} track${missing.length === 1 ? '' : 's'}…`);
    for (const t of missing) {
      // eslint-disable-next-line no-await-in-loop
      await downloadSpotifyRow(t, { noPicker: true });
    }
    markDl(key, 'done');
    showLyricNote(true, `Finished “${alb.name}”`);
  }, [findAlbumTracks, alreadyOwned, downloadSpotifyRow, markDl, showLyricNote]);

  const downloadSoulseekRow = useCallback(async (row) => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.soulseekDownload) return;
    const key = `t:${row.id}`;
    markDl(key, 'busy');
    try {
      const res = await api.soulseekDownload({
        id: row.id, user: row.user, filePath: row.filePath,
        size: row.size, bitrate: row.bitrate, filename: row.filename,
      });
      if (res?.ok && res.track) {
        onTrackImported?.(res.track);
        markDl(key, 'done');
        showLyricNote(true, `Added “${res.track.title || row.filename}” to your library`);
      } else {
        markDl(key, 'failed');
        showLyricNote(false, `Couldn’t download “${row.filename}”`);
        toastError(res?.error, `Couldn’t download “${row.filename}”.`);
      }
    } catch (e) {
      markDl(key, 'failed');
      showLyricNote(false, 'Download failed');
      toastError(e?.message || e, `Couldn’t download “${row.filename}”.`);
    }
  }, [onTrackImported, markDl, showLyricNote, toastError]);

  // --- Library → Albums ---------------------------------------------------
  // The Library section has the same two views as the main library page:
  // Songs (the flat list) and Albums (tiles → album detail). The grouping,
  // sorting and cover-override handling below are lifted from LibraryTab so
  // the two views agree on what an "album" is, right down to which ones are
  // hidden (singles) and what art each tile shows.
  const [libraryView, setLibraryView] = useState('songs'); // 'songs' | 'albums'
  const [openAlbum, setOpenAlbum] = useState(null);        // album key

  const libraryAlbums = useMemo(() => {
    const primaryArtist = (str) => {
      if (!str) return 'Unknown Artist';
      const clean = str.split(/,|feat\.|ft\.|&|\bx\b/i)[0].trim();
      return clean || str.trim();
    };
    // Disc asc → track asc → (both untagged) added-at order → title. Same
    // comparator as the main view, which matters for batch-downloaded albums
    // whose files carry no track tags.
    const compareTracks = (a, b) => {
      const da = a.discNumber != null ? a.discNumber : 1;
      const db = b.discNumber != null ? b.discNumber : 1;
      if (da !== db) return da - db;
      const aHas = a.trackNumber != null;
      const bHas = b.trackNumber != null;
      if (aHas && bHas) {
        if (a.trackNumber !== b.trackNumber) return a.trackNumber - b.trackNumber;
      } else if (aHas !== bHas) {
        return aHas ? -1 : 1;
      } else {
        const aa = Number(a.addedAt) || 0;
        const bb = Number(b.addedAt) || 0;
        if (aa !== bb) return aa - bb;
      }
      return titleCollator.compare(String(a.title || ''), String(b.title || ''));
    };

    const map = new Map();
    for (const t of library || []) {
      const albumName = (t.album || '').trim() || 'Unknown Album';
      const primary = primaryArtist(t.artist);
      const key = `${albumName}__${primary}`;
      if (!map.has(key)) {
        map.set(key, { key, album: albumName, artist: primary, coverArt: null, tracks: [], discSet: new Set() });
      }
      const entry = map.get(key);
      if (!entry.coverArt && t.coverArt) entry.coverArt = t.coverArt;
      entry.discSet.add(t.discNumber != null ? t.discNumber : 1);
      entry.tracks.push(t);
    }
    for (const entry of map.values()) {
      entry.tracks.sort(compareTracks);
      entry.discs = [...entry.discSet].sort((a, b) => a - b);
      entry.hasMultipleDiscs = entry.discs.length >= 2;
      // Pinned album art wins over the track-derived cover — exactly what the
      // album tiles in the main view render.
      entry.displayCover = albumCoverOverrides[entry.key] || entry.coverArt;
      entry.duration = entry.tracks.reduce((n, t) => n + (t.duration || 0), 0);
    }
    return [...map.values()]
      // Singles stay in Songs view only — same rule as the main view.
      .filter((a) => a.tracks.length >= 2)
      .sort((a, b) => titleCollator.compare(a.album, b.album) || titleCollator.compare(a.artist, b.artist));
  }, [library, albumCoverOverrides]);

  const filteredAlbums = useMemo(() => {
    const q = librarySearch.trim().toLowerCase();
    if (!q) return libraryAlbums;
    return libraryAlbums.filter((a) => a.album.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q));
  }, [libraryAlbums, librarySearch]);

  const openAlbumData = useMemo(
    () => (openAlbum ? libraryAlbums.find((a) => a.key === openAlbum) || null : null),
    [libraryAlbums, openAlbum],
  );
  // With an album open, the search box searches WITHIN it — same as the main
  // view ("Search in {album}…").
  const openAlbumTracks = useMemo(() => {
    if (!openAlbumData) return [];
    const q = librarySearch.trim().toLowerCase();
    if (!q) return openAlbumData.tracks;
    return openAlbumData.tracks.filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(q));
  }, [openAlbumData, librarySearch]);

  // An album that disappears underneath us (last track removed) shouldn't
  // strand the detail view.
  useEffect(() => {
    if (openAlbum && !libraryAlbums.some((a) => a.key === openAlbum)) setOpenAlbum(null);
  }, [libraryAlbums, openAlbum]);

  // Switching view or opening an album clears the query, as in the main view.
  const pickLibraryView = useCallback((v) => {
    setLibraryView(v);
    setOpenAlbum(null);
    setLibrarySearch('');
  }, []);

  // --- Releases ----------------------------------------------------------
  // Same pipeline as the New Releases tab: iTunes for the tracklist
  // (lookupReleaseAlbumTracks), yt-dlp for the audio (importFromYoutubeSearch).
  // The old fullscreen version tried to guess an album off Soulseek, which is
  // why it rarely produced anything. Rows expand into their tracklist, each
  // track downloads on its own, and the album button grabs everything you
  // don't already own.
  const [expandedRelease, setExpandedRelease] = useState(null); // collectionId
  const [releaseTracks, setReleaseTracks] = useState({});       // id → track[]
  const [releaseTrackBusy, setReleaseTrackBusy] = useState({}); // id → bool
  const [releaseTrackErr, setReleaseTrackErr] = useState({});   // id → string

  const fetchReleaseTracks = useCallback(async (id) => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.lookupReleaseAlbumTracks) { setReleaseTrackErr((m) => ({ ...m, [id]: 'Track lookup unavailable' })); return null; }
    setReleaseTrackBusy((m) => ({ ...m, [id]: true }));
    try {
      const res = await api.lookupReleaseAlbumTracks(id);
      if (res?.ok && Array.isArray(res.tracks)) {
        setReleaseTracks((m) => ({ ...m, [id]: res.tracks }));
        return res.tracks;
      }
      setReleaseTrackErr((m) => ({ ...m, [id]: res?.error || 'Could not load tracks' }));
      return null;
    } catch (e) {
      setReleaseTrackErr((m) => ({ ...m, [id]: String(e?.message || e) }));
      return null;
    } finally {
      setReleaseTrackBusy((m) => ({ ...m, [id]: false }));
    }
  }, []);

  const toggleRelease = useCallback((r) => {
    const id = Number(r?.collectionId);
    if (!Number.isFinite(id)) return;
    setExpandedRelease((cur) => (cur === id ? null : id));
    if (releaseTracks[id] || releaseTrackBusy[id]) return;
    fetchReleaseTracks(id);
  }, [releaseTracks, releaseTrackBusy, fetchReleaseTracks]);

  const downloadReleaseTrack = useCallback(async (r, tk, opts = {}) => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.importFromYoutubeSearch) return;
    const key = `rt:${r.collectionId}:${tk.trackId}`;
    if (dlState[key] === 'busy' || dlState[key] === 'done') return;
    const meta = {
      title: tk.trackName,
      artists: tk.artistName || r.artistName,
      album: tk.collectionName || r.collectionName,
      albumArtUrl: tk.artworkUrl || r.artworkUrl,
      durationMs: tk.trackTimeMillis || 0,
      spotifyId: `itunes:${tk.trackId}`,
      trackNumber: tk.trackNumber || null,
      discNumber: null,
      explicit: tk.explicit,
    };
    markDl(key, 'busy');
    try {
      const res = await api.importFromYoutubeSearch({ ...meta, progressId: key });
      if (res?.ok && res.track) {
        onTrackImported?.(res.track);
        markDl(key, 'done');
      } else {
        markDl(key, 'failed');
        if (opts.noPicker) toastError(res?.error, `Couldn’t download “${tk.trackName}”.`);
        else openPicker(meta, res, key);
      }
    } catch (e) { markDl(key, 'failed'); toastError(e?.message || e, `Couldn’t download “${tk.trackName}”.`); }
  }, [dlState, markDl, onTrackImported, toastError, openPicker]);

  /** Whole album — fetch the tracklist if needed, then take everything missing,
   *  one at a time (a dozen parallel yt-dlp searches is a bad idea). */
  const downloadRelease = useCallback(async (r) => {
    const id = Number(r?.collectionId);
    const key = `r:${id || r.collectionName}`;
    markDl(key, 'busy');
    const list = releaseTracks[id] || await fetchReleaseTracks(id);
    if (!list?.length) {
      markDl(key, 'failed');
      showLyricNote(false, `Couldn’t load “${r.collectionName || r.name}”`);
      toastError(null, `Couldn’t load the tracklist for “${r.collectionName || r.name}”.`);
      return;
    }
    const missing = list.filter((tk) => !alreadyOwned(tk.trackName, tk.artistName || r.artistName));
    if (!missing.length) {
      markDl(key, 'done');
      showLyricNote(true, 'You already have every track on this one');
      return;
    }
    showLyricNote(true, `Downloading “${r.collectionName || r.name}” — ${missing.length} track${missing.length === 1 ? '' : 's'}…`);
    for (const tk of missing) {
      // eslint-disable-next-line no-await-in-loop
      await downloadReleaseTrack(r, tk, { noPicker: true });
    }
    markDl(key, 'done');
    showLyricNote(true, `Finished “${r.collectionName || r.name}”`);
  }, [releaseTracks, fetchReleaseTracks, alreadyOwned, downloadReleaseTrack, markDl, showLyricNote, toastError]);

  /** Small reusable download button for card rows. Turns into a live
   *  progress bar while a download is running (determinate once the source
   *  reports a percentage, indeterminate before then). */
  // DlBtn was hoisted to a top-level component (see below the overlay).
  // Defining it inline gave it a fresh component identity every overlay
  // render (which happens constantly during playback), so React REMOUNTED
  // every download button each tick — restarting the progress bar's
  // animation ("broken" bar) and replacing the button's DOM node mid-click
  // (clicks intermittently swallowed).


  // Esc while selecting cancels the SELECTION, not fullscreen — captured at
  // the window (same pattern as the library panel's Esc interception) so it
  // never reaches the overlay's own close handler.
  useEffect(() => {
    if (!lyricSel) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      clearLyricSel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [lyricSel != null, clearLyricSel]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear any live selection when the track changes underneath it.
  useEffect(() => { clearLyricSel(); }, [currentTrackId, clearLyricSel]);
  useEffect(() => {
    if (libraryOpen) {
      setLibrarySearch('');
      setLibrarySelIndex(0);
      prevLibOpenRef.current = true;
      const id = setTimeout(() => librarySearchRef.current?.focus(), 80);
      return () => clearTimeout(id);
    }
    // On close, hand focus back to the dialog. Otherwise it stays stuck on the
    // hidden search field and the dialog's key handler (B, space, arrows) never
    // fires until you click back into the window.
    if (prevLibOpenRef.current) {
      prevLibOpenRef.current = false;
      try { librarySearchRef.current?.blur(); } catch { /* ignore */ }
      dialogRef.current?.focus();
    }
    return undefined;
  }, [libraryOpen]);
  // The full library, alphabetized by title — the card is a real library
  // view now, not a suggestions popup, so it must show EVERYTHING in an
  // order a human can scan (the raw array arrives in added-at order).
  // 'title' | 'artist' | 'recent' — persisted; title keeps the A–Z rail.
  const [panelSort, setPanelSort] = useState(() => {
    try { const v = localStorage.getItem('studio:panelLibSort'); return ['title', 'artist', 'recent'].includes(v) ? v : 'title'; } catch { return 'title'; }
  });
  const pickPanelSort = useCallback((v) => {
    setPanelSort(v);
    try { localStorage.setItem('studio:panelLibSort', v); } catch { /* ignore */ }
  }, []);
  const sortedLibrary = useMemo(() => {
    if (!canBrowse) return [];
    const list = [...library];
    if (panelSort === 'artist') {
      list.sort((a, b) => titleCollator.compare(a.artist || '', b.artist || '')
        || titleCollator.compare(a.album || '', b.album || '')
        || (a.trackNumber || 0) - (b.trackNumber || 0));
    } else if (panelSort === 'recent') {
      list.sort((a, b) => (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0));
    } else {
      list.sort((a, b) => titleCollator.compare(a.title || '', b.title || ''));
    }
    return list;
  }, [canBrowse, library, panelSort]);

  const filteredLibrary = useMemo(() => {
    const q = librarySearch.trim().toLowerCase();
    if (!q) return sortedLibrary;
    return sortedLibrary.filter((t) =>
      (t.title || '').toLowerCase().includes(q) || (t.artist || '').toLowerCase().includes(q) || (t.album || '').toLowerCase().includes(q));
  }, [sortedLibrary, librarySearch]);

  // No caps: empty query = whole library, a query = every match. The list
  // itself is virtualized (fixed 52px rows), so DOM weight stays constant
  // no matter the library size.
  const spotlightResults = filteredLibrary;

  // A–Z rail — first row index per initial letter. Only meaningful when the
  // full list is title-sorted (no search, title sort); '#' catches digits
  // and symbols, which the collator sorts to the front.
  const azIndex = useMemo(() => {
    if (panelSort !== 'title' || librarySearch.trim()) return null;
    const map = new Map();
    spotlightResults.forEach((t, i) => {
      const ch = (t.title || '').trim().charAt(0).toUpperCase();
      const letter = /[A-Z]/.test(ch) ? ch : '#';
      if (!map.has(letter)) map.set(letter, i);
    });
    return map.size > 1 ? map : null;
  }, [spotlightResults, panelSort, librarySearch]);

  // Keep the highlighted row valid as results change; jump back to the top.
  useEffect(() => {
    setLibrarySelIndex(0);
    if (libraryListRef.current) libraryListRef.current.scrollTop = 0;
  }, [librarySearch]);

  // Virtualized list plumbing — fixed-height rows, absolute-positioned
  // visible slice (same pattern as the queue list).
  const LIB_ROW_H = 52;
  const [libSelByKey, setLibSelByKey] = useState(false);
  const [libScrollTop, setLibScrollTop] = useState(0);
  const [libViewH, setLibViewH] = useState(320);
  const libRoRef = useRef(null);
  // Attached via CALLBACK REF, not an effect keyed on libraryOpen. The list
  // is unmounted whenever you visit another section (Find / Releases /
  // Stats), and two things used to go wrong on the way back:
  //   1. Chromium fires a ResizeObserver notification with a 0×0 rect when
  //      an observed element leaves the DOM — so libViewH was set to 0.
  //   2. The effect only re-ran on libraryOpen, so the observer was never
  //      re-attached to the FRESH list node and 0 stuck.
  // With libViewH = 0 the virtualizer's `last` index collapses to ~4, which
  // is exactly the "library cuts off after four rows" symptom. A callback ref
  // re-measures on every mount, and zero-height readings are ignored.
  const attachLibList = useCallback((el) => {
    libraryListRef.current = el;
    if (libRoRef.current) { libRoRef.current.disconnect(); libRoRef.current = null; }
    if (!el) return;
    const measure = () => {
      const h = el.clientHeight;
      if (h > 0) setLibViewH(h);
    };
    measure();
    // A remounted node always starts at scrollTop 0; stale scroll state would
    // otherwise render a slice from the old offset into a list scrolled to
    // the top (blank rows).
    setLibScrollTop(0);
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      libRoRef.current = ro;
    }
  }, []);
  useEffect(() => () => { if (libRoRef.current) libRoRef.current.disconnect(); }, []);

  // Keep the highlighted row on screen during KEYBOARD nav — computed from
  // the index (scrollIntoView can't work when the row isn't rendered yet).
  // Gated on libSelByKey: hover also moves the selection index, and a
  // half-visible row scrolling itself into view under the cursor feels
  // like the list is fighting the mouse.
  useEffect(() => {
    if (!libraryOpen || !libSelByKey) return;
    const el = libraryListRef.current;
    if (!el) return;
    const rowTop = librarySelIndex * LIB_ROW_H;
    const rowBottom = rowTop + LIB_ROW_H;
    if (rowTop < el.scrollTop) el.scrollTop = rowTop;
    else if (rowBottom > el.scrollTop + el.clientHeight) el.scrollTop = rowBottom - el.clientHeight;
  }, [librarySelIndex, libraryOpen, libSelByKey]);

  // While the search is open, intercept Esc at the window in capture phase so
  // it closes the search and never reaches the parent page's Esc handler
  // (which would otherwise close the whole fullscreen view). Only attached
  // while open, so it can never interfere with opening (Enter, in handleKey).
  useEffect(() => {
    if (!libraryOpen) return undefined;
    const h = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); toggleLibrary(false); }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [libraryOpen]);

  // Honour the OS "reduce motion" setting — skip the entrance/scale animations.
  const reduceMotion = typeof window !== 'undefined' && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // --- Search morph: library-in-rail + cover relocation -----------------
  // Opening search no longer summons a floating spotlight panel. Instead
  // the composition ITSELF morphs: the big cover flies up to a compact
  // header above the lyrics (or above the rail when there's no lyrics
  // column), and the library browser takes over the cover's exact square —
  // same size, same radius — so the transport controls below never move.
  // The flight is a ghost-FLIP: measure the cover's rect before the layout
  // change, measure the destination after it commits, then fly a single
  // fixed-position ghost between the two while the real elements hide.
  const bigCoverRef = useRef(null);
  const miniCoverRef = useRef(null);
  const [coverGhost, setCoverGhost] = useState(null); // { from, to, radiusFrom, radiusTo }
  const [ghostFlying, setGhostFlying] = useState(false);
  const pendingGhostFromRef = useRef(null);
  const coverHomeRef = useRef(null); // settled big-cover rect + window size at capture
  const coverInFlight = !!coverGhost;
  // Height reserved for the relocated header. The slot ANIMATES between 0
  // and this on the same curve as the ghost flight, so the lyrics column
  // resizes continuously instead of snapping when the header mounts or
  // unmounts. Header content is absolutely anchored to the slot's TOP, so
  // its final position is identical at any slot height — which keeps the
  // ghost's measured destination exact even mid-animation.
  const MINI_HEADER_H = 88; // 72px cover + 16px breathing room

  // Staggered close: Esc first sends the song info on a long, unhurried
  // glide out (closePhase) while EVERYTHING else holds still — then, once
  // the text has left, the cover launches home and the slot collapses.
  // Sequencing instead of parallelism is what buys the text a genuinely
  // slow exit: inside the flight window it could never be smooth, it was
  // always clipped by the header's unmount at touchdown.
  const [closePhase, setClosePhase] = useState(false);
  const closePhaseTimerRef = useRef(null);
  const libraryOpenRef = useRef(false);
  useEffect(() => { libraryOpenRef.current = libraryOpen; }, [libraryOpen]);
  useEffect(() => () => { if (closePhaseTimerRef.current) clearTimeout(closePhaseTimerRef.current); }, []);

  const toggleLibrary = useCallback((open) => {
    if (open) {
      // Re-opening cancels an in-progress staggered close.
      if (closePhaseTimerRef.current) { clearTimeout(closePhaseTimerRef.current); closePhaseTimerRef.current = null; }
      if (cardExitTimerRef.current) { clearTimeout(cardExitTimerRef.current); cardExitTimerRef.current = null; }
      setClosePhase(false);
      setCardExiting(false);
      setLibraryOpen((cur) => {
        if (cur) return cur;
        if (!reduceMotion) {
          const rect = bigCoverRef.current ? bigCoverRef.current.getBoundingClientRect() : null;
          pendingGhostFromRef.current = rect;
          // The cover's SETTLED home — measured while the layout is fully
          // at rest. The close flight reuses this rect as its destination
          // instead of re-measuring mid-transition; measurement-time
          // corrections kept betraying us (the video showed the close
          // landing half a slot low despite mathematically-sound math).
          // The home cannot move between open and close short of a window
          // resize, which is checked at use.
          coverHomeRef.current = rect
            ? { rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, vw: window.innerWidth, vh: window.innerHeight }
            : null;
        }
        return true;
      });
      return;
    }
    if (!libraryOpenRef.current) return;
    if (reduceMotion) { setClosePhase(false); setCardExiting(false); setLibraryOpen(false); return; }
    // Holds the card in the tree while its Out animations run. Because the
    // element is NOT remounted, swapping the animation-name from In → Out on
    // the same node is what restarts the animation — clean, no flicker.
    const beginCardExit = () => {
      setCardExiting(true);
      if (cardExitTimerRef.current) clearTimeout(cardExitTimerRef.current);
      cardExitTimerRef.current = setTimeout(() => {
        cardExitTimerRef.current = null;
        setCardExiting(false);
      }, CARD_EXIT_MS);
    };
    // Centered mode: no relocated header, no ghost — the close is the card
    // contracting while the lyrics scale back in.
    if (centeredModeRef.current) {
      beginCardExit();
      setLibraryOpen(false);
      return;
    }
    if (closePhaseTimerRef.current) return; // already gliding out
    setClosePhase(true);
    // Arms the big centered song-info's return animation. Gated on a real
    // close so the block doesn't play a delayed rise-in on the overlay's
    // FIRST mount (where there's no cover flight to wait for).
    setInfoHomeAnim(true);
    closePhaseTimerRef.current = setTimeout(() => {
      closePhaseTimerRef.current = null;
      pendingGhostFromRef.current = miniCoverRef.current ? miniCoverRef.current.getBoundingClientRect() : null;
      setClosePhase(false);
      beginCardExit();
      setLibraryOpen(false);
    }, 200); // header text is 220ms + 50ms stagger — ghost lifts off as the
    // last letters fade, overlapping instead of waiting them out.
  }, [reduceMotion]);

  // The big centered title/artist under the cover. It's the counterpart to
  // the relocated header: it leaves as the artwork lifts away, and comes
  // home as the artwork lands back in the middle. Both directions are
  // keyframed (not a plain transition) so they can be staggered per line and
  // timed against the 420ms ghost flight.
  const [infoHomeAnim, setInfoHomeAnim] = useState(false);
  const bigInfoAnim = useCallback((line) => {
    if (reduceMotion) return 'none';
    if (libraryOpen) {
      // Leaving: reverse order (artist first, title trailing) and the exact
      // inverse easing curve of the entrance — the entrance played backwards.
      return `immerseFullscreenBigInfoOut 230ms cubic-bezier(0.55, 0, 0.55, 0.2) ${line === 'title' ? '60ms' : '0ms'} both`;
    }
    if (!infoHomeAnim) return 'none';
    // Returning: starts at 430ms — the moment the ghost touches down in the
    // center — so the text settles under the artwork, never ahead of it.
    // Same 560ms glide and 90ms title→artist stagger as the header's entrance.
    return `immerseFullscreenBigInfoIn 480ms cubic-bezier(0.22, 1, 0.36, 1) ${line === 'title' ? '400ms' : '470ms'} both`;
  }, [reduceMotion, libraryOpen, infoHomeAnim]);

  // Decode warmer — pre-decodes the artwork bitmap the moment the URL is
  // known, so no cover surface (header, ghost, big slot) ever paints its
  // placeholder color for a frame while Chromium decodes asynchronously.
  // That async decode was the single-frame "updating" flash on mount.
  useEffect(() => {
    if (!coverUrl) return;
    const img = new Image();
    img.src = coverUrl;
    if (img.decode) img.decode().catch(() => { /* best effort */ });
  }, [coverUrl]);

  // After the layout commits, measure the destination and launch the ghost.
  useLayoutEffect(() => {
    const from = pendingGhostFromRef.current;
    pendingGhostFromRef.current = null;
    if (!from || !from.width) return;
    const home = coverHomeRef.current;
    const homeValid = !libraryOpen && home
      && home.vw === window.innerWidth && home.vh === window.innerHeight;
    let to;
    if (homeValid) {
      // Close: fly to the pre-captured settled home — exact by construction.
      to = { ...home.rect };
    } else {
      const dstEl = libraryOpen ? miniCoverRef.current : bigCoverRef.current;
      if (!dstEl) return;
      const measured = dstEl.getBoundingClientRect();
      if (!measured.width) return;
      const slotEl = railSlotRef.current;
      to = { left: measured.left, top: correctRailTop(measured.top, libraryOpen), width: measured.width, height: measured.height };
    }

    setCoverGhost({
      from, to,
      radiusFrom: libraryOpen ? 16 : 12,
      radiusTo: libraryOpen ? 12 : 16,
      opening: libraryOpen,
    });
  }, [libraryOpen]);


  // Two-frame arm so the ghost paints at `from` before transitioning to `to`.
  useEffect(() => {
    if (!coverGhost) { setGhostFlying(false); return undefined; }
    let raf2;
    const raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => setGhostFlying(true)); });
    // Fallback cleanup in case transitionend is swallowed (tab blur, etc.)
    const timer = setTimeout(() => setCoverGhost(null), 700);
    return () => { cancelAnimationFrame(raf1); if (raf2) cancelAnimationFrame(raf2); clearTimeout(timer); };
  }, [coverGhost]);

  // Backdrop: 'cover' = blurred album art (beat-pulsed), 'field' = the same
  // animated colour field the now-playing page uses. Persisted locally.
  const [backdropMode, setBackdropMode] = useState(() => {
    try { return window.localStorage.getItem('immerse:fullscreenBackdrop') === 'field' ? 'field' : 'cover'; } catch { return 'cover'; }
  });
  const setBackdrop = useCallback((m) => {
    setBackdropMode(m);
    try { window.localStorage.setItem('immerse:fullscreenBackdrop', m); } catch { /* ignore */ }
  }, []);

  // ---- Beat-reactive backdrop ------------------------------------------
  // Mirrors AnimatedGradientBg's envelope: average the bass bins, climb fast
  // on hits, decay slowly. The envelope drives the blurred-cover backdrop's
  // brightness/saturation and a slight scale swell — applied directly to the
  // DOM node from a rAF loop so the pulse never triggers React re-renders.
  const backdropRef = useRef(null);
  const beatEnvRef = useRef(0);
  const freqBufRef = useRef(null);
  const beatStateRef = useRef({ beatReactive, isPlaying });
  useEffect(() => { beatStateRef.current = { beatReactive, isPlaying }; }, [beatReactive, isPlaying]);
  useEffect(() => {
    if (!beatReactive || reduceMotion || backdropMode !== 'cover') return undefined;
    let raf = 0;
    const frame = () => {
      const node = backdropRef.current;
      const { beatReactive: br, isPlaying: ip } = beatStateRef.current;
      const analyser = analyserRef?.current;
      let beat;
      if (br && ip && analyser) {
        if (!freqBufRef.current || freqBufRef.current.length !== analyser.frequencyBinCount) {
          freqBufRef.current = new Uint8Array(analyser.frequencyBinCount);
        }
        analyser.getByteFrequencyData(freqBufRef.current);
        const bins = freqBufRef.current;
        const N = Math.min(50, bins.length);
        let sum = 0;
        for (let i = 0; i < N; i++) sum += bins[i];
        const avg = (sum / N) / 255;
        const env = beatEnvRef.current;
        beat = avg > env ? env + (avg - env) * 0.45 : env + (avg - env) * 0.06;
      } else {
        beat = beatEnvRef.current * 0.92;
      }
      beatEnvRef.current = beat;
      if (node) {
        node.style.filter = `blur(90px) saturate(${(1.5 + beat * 0.7).toFixed(3)}) brightness(${(0.5 + beat * 0.3).toFixed(3)})`;
        node.style.transform = `scale(${(1 + beat * 0.05).toFixed(4)})`;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      const node = backdropRef.current;
      if (node) {
        node.style.filter = 'blur(90px) saturate(1.5) brightness(0.5)';
        node.style.transform = 'scale(1)';
      }
    };
  }, [beatReactive, reduceMotion, analyserRef, backdropMode]);

  // Idle auto-hide: after a few seconds with no mouse/key activity, fade out
  // the controls + cursor so the cover sits as clean ambient art. Any movement
  // or keypress brings them back.
  const [idle, setIdle] = useState(false);
  const [autoHideDock, setAutoHideDock] = useState(() => {
    try { return window.localStorage.getItem('studio:autoHideDock') !== 'off'; } catch { return true; }
  });
  const autoHideRef = useRef(true);
  autoHideRef.current = autoHideDock;
  const pickAutoHideDock = useCallback((on) => {
    setAutoHideDock(on);
    if (!on) setIdle(false);
    try { window.localStorage.setItem('studio:autoHideDock', on ? 'on' : 'off'); } catch { /* ignore */ }
  }, []);
  const idleTimerRef = useRef(null);
  const bumpActivity = useCallback(() => {
    setIdle((cur) => (cur ? false : cur));
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => { if (autoHideRef.current) setIdle(true); }, 3000);
  }, []);

  // On open: save the element that had focus (the cover button), move focus
  // into the dialog, and start the idle timer. On close: restore focus.
  useEffect(() => {
    const prev = typeof document !== 'undefined' ? document.activeElement : null;
    dialogRef.current?.focus();
    bumpActivity();
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      try { if (prev && typeof prev.focus === 'function') prev.focus(); } catch { /* ignore */ }
    };
  }, [bumpActivity]);

  // Controls fade together when idle.
  // When idle the controls don't just fade — they collapse to zero height, so
  // the rail (which is vertically centered) smoothly re-centers the cover +
  // title. The max-height transition animates that motion. maxHeight when open
  // is comfortably above the real content height so nothing clips.
  // The control bar is a floating overlay pinned to the bottom edge — it
  // fades and sinks away on idle. Crucially it is NOT part of the centered
  // composition, so the cover/title never move; fullscreen reads as art with
  // controls hovering over it, not a player page.
  const barFade = {
    opacity: idle ? 0 : 1,
    transform: idle ? 'translateY(14px)' : 'translateY(0)',
    pointerEvents: idle ? 'none' : 'auto',
    transition: 'opacity 0.4s ease, transform 0.45s cubic-bezier(0.2,0.7,0.2,1)',
  };

  // Keyboard control while the overlay has focus. We only act when focus is on
  // the backdrop itself — once the user tabs to a button or slider, that
  // control handles its own keys (so Space/arrows aren't double-fired). Esc and
  // F are intentionally left to bubble to the global handler that opened us.
  const handleKey = (e) => {
    // Modal editors own the keyboard while open (Space stamps sync lines
    // in the lyrics editor; letting it fall through would toggle play).
    if (metaEditTarget || albumEditScope || lyricsEditing) return;
    bumpActivity();
    // Trap Tab inside the overlay so focus can't wander to controls behind it.
    if (e.key === 'Tab') {
      const nodes = dialogRef.current
        ? dialogRef.current.querySelectorAll('button, [href], input, select, textarea, [role="slider"], [tabindex]:not([tabindex="-1"])')
        : [];
      const list = Array.prototype.filter.call(nodes, (el) => !el.disabled && el.offsetParent !== null);
      if (list.length === 0) { e.preventDefault(); dialogRef.current?.focus(); return; }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (active === dialogRef.current) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
      return;
    }
    const t = e.target;
    const tag = (t.tagName || '').toLowerCase();
    const interactive = tag === 'button' || tag === 'input' || tag === 'textarea'
      || (t.getAttribute && t.getAttribute('role') === 'slider');
    if (interactive) return;
    const vol = typeof volume === 'number' ? volume : 1;
    switch (e.key) {
      case ' ': case 'k':
        e.preventDefault(); e.stopPropagation(); onTogglePlay?.(); break;
      case 'ArrowLeft':
        e.preventDefault(); e.stopPropagation(); onSeek?.(Math.max(0, currentTime - 5)); break;
      case 'ArrowRight':
        e.preventDefault(); e.stopPropagation(); onSeek?.(Math.min(duration || 0, currentTime + 5)); break;
      case 'ArrowUp':
        e.preventDefault(); e.stopPropagation(); onSetVolume?.(Math.min(1, vol + 0.05)); break;
      case 'ArrowDown':
        e.preventDefault(); e.stopPropagation(); onSetVolume?.(Math.max(0, vol - 0.05)); break;
      case 'l': case 'L':
        if (flipMode) { e.preventDefault(); e.stopPropagation(); setFlipped((f) => !f); }
        break;
      case 'e': case 'E':
        // Edit the current track's metadata without touching any menus.
        if (canEditMeta) { e.preventDefault(); e.stopPropagation(); setMetaEditTarget(editableTrack); }
        break;
      case 'Enter':
        // Open the library search. Reliable here because the dialog holds
        // focus while fullscreen is open (and we hand focus back to it when
        // the search closes), so this handler always fires.
        if (canBrowse && !libraryOpen) { e.preventDefault(); e.stopPropagation(); toggleLibrary(true); }
        else if (libraryOpen) { e.preventDefault(); e.stopPropagation(); toggleLibrary(false); }
        break;
      case 'm': case 'M':
        e.preventDefault(); e.stopPropagation(); onSetVolume?.(vol > 0 ? 0 : 1); break;
      default: break; // Esc / f bubble up to the parent
    }
  };

  // Two lyric presentations, user-selectable in Settings:
  //  'side' — a chrome-free lyrics column floats beside the cover, sized to
  //           the cover's height, scrolling with the song.
  //  'flip' — the composition stays untouched; pressing L (or clicking the
  //           cover) flips the artwork over to a same-size lyric card.
  const hasAnyLyrics = hasSyncedLyrics || hasPlainLyrics;
  const sideLyrics = fullscreenLyricsMode === 'side' && hasAnyLyrics;
  const flipMode = fullscreenLyricsMode === 'flip' && hasAnyLyrics;
  // Centered: no big cover — song info sits top-center (the relocated-header
  // mount, permanently parked) with the lyrics centered wide beneath it.
  // Falls back to the plain cover view when the track has no lyrics.
  const centeredMode = fullscreenLyricsMode === 'centered' && hasAnyLyrics;
  const centeredModeRef = useRef(centeredMode);
  useEffect(() => { centeredModeRef.current = centeredMode; }, [centeredMode]);

  const railSlotRef = useRef(null);

  /**
   * Landing correction for the no-lyrics rail. The rail is vertically
   * centered, so its elements shift as the header slot animates; a rect
   * measured mid-transition is off by a slot-height-dependent amount:
   *   header final (open):  measured − (MINI_HEADER_H − slotNow) / 2
   *   cover final (close):  measured − slotNow / 2
   * Computed from the slot's LIVE height, this is exact at any moment of
   * the transition — launch, mid-flight retarget, whenever.
   */
  const correctRailTop = useCallback((measuredTop, opening) => {
    if (sideLyrics || centeredMode) return measuredTop;
    const slotEl = railSlotRef.current;
    const slotNow = slotEl ? slotEl.getBoundingClientRect().height : (opening ? 0 : MINI_HEADER_H);
    return opening
      ? measuredTop - (MINI_HEADER_H - slotNow) / 2
      : measuredTop - slotNow / 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideLyrics, centeredMode]);

  // Mid-flight retargeting. The destination can shift after launch —
  // layout settling, the card remounting at a dragged offset, anything.
  // Re-measure at two checkpoints and steer the running transition to the
  // fresh rect; CSS retargets in-progress transitions natively and
  // smoothly, so a corrected landing never reads as a jump.
  useEffect(() => {
    if (!coverGhost || !ghostFlying) return undefined;
    const retarget = () => {
      // Flying home to the pre-captured rect? Nothing to correct — a
      // mid-collapse measurement would only reintroduce the drift.
      const home = coverHomeRef.current;
      if (!libraryOpen && home && home.vw === window.innerWidth && home.vh === window.innerHeight) {
        return;
      }
      const dstEl = libraryOpen ? miniCoverRef.current : bigCoverRef.current;
      if (!dstEl) return;
      const m = dstEl.getBoundingClientRect();
      if (!m.width) return;
      const top = correctRailTop(m.top, libraryOpen);
      setCoverGhost((g) => {
        if (!g) return g;
        const drift = Math.abs(g.to.top - top) + Math.abs(g.to.left - m.left) + Math.abs(g.to.width - m.width);
        if (drift < 1.5) return g;
        return { ...g, to: { left: m.left, top, width: m.width, height: m.height } };
      });
    };
    const t1 = setTimeout(retarget, 150);
    const t2 = setTimeout(retarget, 320);
    return () => { clearTimeout(t1); clearTimeout(t2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghostFlying, libraryOpen, correctRailTop]);
  const [flipped, setFlipped] = useState(false);
  // Un-flip when the track changes or the mode stops supporting it.
  useEffect(() => { setFlipped(false); }, [title, flipMode]);

  // Compact cover + title header — where the artwork lands while search is
  // open. Rendered above the lyrics column (side mode) or above the rail's
  // square (flip / no-lyrics). Exactly one instance mounts at a time, so
  // miniCoverRef is always unambiguous.
  const miniHeader = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16, flexShrink: 0, minWidth: 0 }}>
      <div ref={miniCoverRef} style={{
        width: 72, height: 72, borderRadius: 12, flexShrink: 0,
        backgroundColor: '#111',
        backgroundImage: coverUrl ? `url("${coverUrl.replace(/"/g, '%22')}")` : 'none',
        backgroundSize: 'cover', backgroundPosition: 'center',
        // No drop shadow — just the accent ring. Dark glows read as smudges
        // on light ambient backdrops.
        boxShadow: `0 0 0 1px rgba(${accent},0.4), inset 0 0 0 1px rgba(255,255,255,0.22)`,
        // Hidden while a flight is PENDING or ACTIVE (it IS this element,
        // arriving) and while search is closed (the header stays mounted
        // permanently so the artwork bitmap never re-decodes — the old
        // remount caused a one-frame placeholder flash). The pending check
        // matters on first open: forced layout resolution would otherwise
        // transition 1 → 0 and flash before the ghost even launched.
        opacity: (!libraryOpen || coverInFlight || pendingGhostFromRef.current) ? 0 : 1,
        // NO transition, deliberately: at touchdown the ghost (opaque) and
        // this element show IDENTICAL pixels at the IDENTICAL rect, so the
        // correct reveal is an atomic same-frame swap. The old 120ms fade
        // made the artwork dip to transparent as the ghost vanished — that
        // was the "refresh" flash at landing.
      }} />
      <div style={{ minWidth: 0 }}>
        {/* Direction-aware, per-line. Entering: a long 560ms glide with a
            gentle deceleration, title first, artist trailing 90ms behind —
            the stagger is what reads as "silky" instead of a block popping
            in. Both start only AFTER the ghost's 420ms touchdown, so text
            never precedes its cover. Leaving: closePhase gives both lines
            one shared unhurried 380ms glide while everything else holds.
            Animation strings stay identical from closePhase through closed
            (play once, no replay) and flip cleanly on reopen. */}
        <div style={{
          fontSize: 16, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          animation: reduceMotion ? 'none' : ((libraryOpen && !closePhase)
            ? 'immerseFullscreenHeaderTextIn 480ms cubic-bezier(0.22, 1, 0.36, 1) 400ms both'
            // Title leaves LAST (80ms), mirroring the entrance where it
            // arrived FIRST. Same 14px travel, and the easing is the literal
            // inverse of the entrance curve — the entrance run backwards.
            : 'immerseFullscreenHeaderTextOut 220ms cubic-bezier(0.55, 0, 0.55, 0.2) 50ms both'),
        }}>
          {title || 'Unknown track'}
        </div>
        <div style={{
          fontSize: 12.5, color: 'rgba(255,255,255,0.55)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          animation: reduceMotion ? 'none' : ((libraryOpen && !closePhase)
            ? 'immerseFullscreenHeaderTextIn 480ms cubic-bezier(0.22, 1, 0.36, 1) 460ms both'
            : 'immerseFullscreenHeaderTextOut 220ms cubic-bezier(0.55, 0, 0.55, 0.2) both'),
        }}>
          {artist || 'Unknown artist'}
        </div>
      </div>
    </div>
  );

  // Parallax side menu — a slim icon rail docked to the command center's
  // left edge (it lives inside the same drag wrapper, so it travels with
  // the card). Emerges from BEHIND the card after it unfolds — smaller
  // travel, later start: that timing offset is the parallax. Icons cascade
  // in individually; the accent indicator GLIDES between sections instead
  // of repainting.
  const CC_SECTIONS = [
    ['library', 'Library', 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm12-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'],
    ['find', 'Find & Download', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3'],
    ['releases', 'Releases', 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm4.2-14.2l-2.1 6.3-6.3 2.1 2.1-6.3 6.3-2.1z'],
    ['stats', 'Stats', 'M4 20V10M10 20V4M16 20v-7M22 20H2'],
    ['settings', 'Settings', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-2.1-1.2L14.5 3h-5l-.4 2.7a7.6 7.6 0 0 0-2.1 1.2l-2.3-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1c.6.5 1.4.9 2.1 1.2l.4 2.7h5l.4-2.7a7.6 7.6 0 0 0 2.1-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z'],
  ];
  const ccActiveIndex = Math.max(0, CC_SECTIONS.findIndex(([id]) => id === cardTab));
  const ccBtn = 36;
  const ccGap = 6;
  // Rail footprint: 36px button + 6px padding either side = 48, plus the
  // 10px gap to the card. CC_NUDGE re-centers the PAIR (rail + card) on the
  // composition — the rail only ever hangs off the left, so without this the
  // whole assembly reads half a rail-width too far left.
  const CC_RAIL_W = ccBtn + 12;
  const CC_GUTTER = CC_RAIL_W + 10;
  const CC_NUDGE = Math.round(CC_GUTTER / 2);
  const commandMenu = (
    // OUTER: pure positioning. Spans the card's full height and centers its
    // child with flexbox — no percentage + translate trick.
    // This split exists because the pill's own keyframes end on
    // `transform: translateX(0) scale(1)`, and with fill-mode `both` that
    // final frame REPLACES any inline transform on the same element. The old
    // `top: 50%` + `translateY(-50%)` therefore lost its -50% the instant the
    // entrance animation settled, dropping the rail half its own height below
    // the card's center. (Same trap the card-drag offset already documents.)
    <div style={{
      position: 'absolute', right: `calc(100% + 10px)`, top: 0, bottom: 0,
      display: 'flex', alignItems: 'center',
      pointerEvents: 'none',
    }}>
    <div style={{
      position: 'relative',
      display: 'flex', flexDirection: 'column', gap: ccGap,
      padding: 6, borderRadius: 13,
      pointerEvents: 'auto',
      background: 'rgba(16,16,20,0.72)',
      border: '1px solid rgba(255,255,255,0.09)',
      backdropFilter: 'blur(26px) saturate(1.5)', WebkitBackdropFilter: 'blur(26px) saturate(1.5)',
      boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
      // Out mirrors In: same 26px slide + 0.94 scale, inverse easing curve
      // (cubic-bezier(0.8,0,0.8,0.2) is the literal time-reverse of the
      // entrance's 0.2,0.8,0.2,1). It retracts BEHIND the card at 80ms —
      // the parallax read backwards.
      animation: reduceMotion ? 'none' : (libraryOpen
        ? 'immerseFullscreenMenuIn 380ms cubic-bezier(0.2, 0.8, 0.2, 1) 240ms both'
        : 'immerseFullscreenMenuOut 200ms cubic-bezier(0.55, 0, 0.55, 0.2) 40ms both'),
    }}>
      {/* Gliding active indicator — sits UNDER the icons, slides between
          slots on a soft spring-ish curve. */}
      <div aria-hidden style={{
        position: 'absolute', left: 6, width: ccBtn, height: ccBtn,
        top: 6 + ccActiveIndex * (ccBtn + ccGap),
        borderRadius: 10,
        background: `rgba(${accent},0.28)`,
        border: `1px solid rgba(${accent},0.4)`,
        transition: reduceMotion ? 'none' : 'top 320ms cubic-bezier(0.3, 0.9, 0.3, 1)',
        pointerEvents: 'none',
      }} />
      {CC_SECTIONS.map(([id, label, path], i) => (
        <button key={id} type="button" title={label}
          onClick={() => setCardTab(id)}
          style={{
            position: 'relative', width: ccBtn, height: ccBtn,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: 'none', borderRadius: 10, cursor: 'pointer',
            background: 'transparent',
            color: cardTab === id ? '#fff' : 'rgba(255,255,255,0.5)',
            transition: 'color 0.2s ease',
            animation: reduceMotion ? 'none' : (libraryOpen
              ? `immerseFullscreenMenuIconIn 260ms cubic-bezier(0.2, 0.8, 0.2, 1) ${300 + i * 45}ms both`
              // Reverse cascade: the LAST icon leaves first, so the rail
              // unzips upward — the entrance run backwards.
              : `immerseFullscreenMenuIconOut 150ms cubic-bezier(0.55, 0, 0.55, 0.2) ${(CC_SECTIONS.length - 1 - i) * 18}ms both`),
          }}
          onMouseEnter={(e) => { if (cardTab !== id) e.currentTarget.style.color = 'rgba(255,255,255,0.85)'; }}
          onMouseLeave={(e) => { if (cardTab !== id) e.currentTarget.style.color = 'rgba(255,255,255,0.5)'; }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d={path} />
          </svg>
        </button>
      ))}
    </div>
    </div>
  );

  // Library browser card — fills the cover's exact square while search is
  // open. Same glass recipe as the rest of the fullscreen chrome.
  const libraryCard = (
    <div style={{
      position: 'absolute', inset: 0, borderRadius: 16, overflow: 'hidden',
      background: 'rgba(16,16,20,0.72)',
      border: '1px solid rgba(255,255,255,0.09)',
      backdropFilter: 'blur(26px) saturate(1.5)', WebkitBackdropFilter: 'blur(26px) saturate(1.5)',
      boxShadow: `0 24px 70px rgba(0,0,0,0.55), 0 0 0 1px rgba(${accent},0.25)`,
      display: 'flex', flexDirection: 'column',
      // Enter: settle up + unfold AFTER the cover has visibly vacated the
      // square (160ms hold). Exit: the card folds away LAST (120ms hold,
      // after the rail has tucked itself behind it), on the inverse of the
      // entrance curve, finishing exactly as the artwork lands home.
      animation: reduceMotion ? 'none' : (libraryOpen
        ? `immerseFullscreenSearchCardIn 360ms cubic-bezier(0.22, 1, 0.36, 1) ${centeredMode ? '50ms' : '140ms'} both`
        : 'immerseFullscreenSearchCardOut 240ms cubic-bezier(0.55, 0, 0.55, 0.2) both'),
    }}>
      {/* Grip — drag to move the command center; double-click snaps home. */}
      <div
        onPointerDown={handleCardGripDown}
        onPointerMove={handleCardGripMove}
        onPointerUp={handleCardGripUp}
        onPointerCancel={handleCardGripUp}
        onDoubleClick={resetCardOffset}
        title="Drag to move · double-click to reset"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          paddingTop: 8, marginBottom: -4, cursor: 'grab',
          flexShrink: 0, touchAction: 'none',
        }}
      >
        <div style={{ width: 36, height: 4, borderRadius: 999, background: 'rgba(255,255,255,0.18)' }} />
      </div>
      {/* Keyed content wrapper: every tab switch replays a soft rise-in, and
          on close the contents sink away a beat before the card itself does,
          so the card doesn't collapse with a frozen list inside it. */}
      <div key={cardTab} style={{
        flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
        animation: reduceMotion ? 'none' : (libraryOpen
          ? 'immerseFullscreenTabIn 240ms cubic-bezier(0.2,0.8,0.2,1) both'
          : 'immerseFullscreenTabOut 200ms cubic-bezier(0.8, 0, 0.8, 0.2) both'),
      }}>
      {cardTab === 'library' ? (<>
      <div style={{ padding: 12, borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        {/* Songs / Albums — the same two views as the main library page. */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 8, padding: 3, borderRadius: 9, background: 'rgba(255,255,255,0.05)' }}>
          {[['songs', 'Songs'], ['albums', 'Albums']].map(([id, label]) => (
            <button key={id} type="button" onClick={() => pickLibraryView(id)}
              style={{
                flex: 1, padding: '6px 0', borderRadius: 7, border: 'none', cursor: 'pointer',
                fontSize: 11.5, fontWeight: 700,
                background: libraryView === id ? `rgba(${accent},0.28)` : 'transparent',
                color: libraryView === id ? '#fff' : 'rgba(255,255,255,0.5)',
                transition: 'background 0.18s ease, color 0.18s ease',
              }}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ position: 'relative' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="2" strokeLinecap="round"
            style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', zIndex: 2 }}>
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            ref={librarySearchRef}
            value={librarySearch}
            onChange={(e) => setLibrarySearch(e.target.value)}
            onKeyDown={(e) => {
              // Arrow-key browsing only means anything in the flat song list.
              if (libraryView === 'songs' && !openAlbumData) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setLibSelByKey(true); setLibrarySelIndex((i) => Math.min(spotlightResults.length - 1, i + 1)); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setLibSelByKey(true); setLibrarySelIndex((i) => Math.max(0, i - 1)); return; }
              }
              // Enter never plays — songs are click-to-play by design.
              // Enter is the close gesture, mirroring the Enter that opened it.
              if (e.key === 'Enter') { e.preventDefault(); toggleLibrary(false); }
            }}
            placeholder={openAlbumData ? `Search in ${openAlbumData.album}…` : libraryView === 'albums' ? 'Search your albums…' : 'Search your library…'}
            style={{
              width: '100%', padding: '10px 12px 10px 36px',
              fontSize: 13.5, fontWeight: 400, color: '#fff',
              background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 10, outline: 'none',
            }}
          />
        </div>
        {/* Sort — songs list only; the album grid has its own order. */}
        {libraryView === 'songs' && !openAlbumData ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 8 }}>
            <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', marginRight: 2 }}>Sort</span>
            {[['title', 'Title'], ['artist', 'Artist'], ['recent', 'Recent']].map(([id, label]) => (
              <button key={id} type="button" onClick={() => pickPanelSort(id)}
                style={{
                  padding: '4px 10px', borderRadius: 7, border: 'none', cursor: 'pointer',
                  fontSize: 10.5, fontWeight: 700,
                  background: panelSort === id ? `rgba(${accent},0.28)` : 'rgba(255,255,255,0.05)',
                  color: panelSort === id ? '#fff' : 'rgba(255,255,255,0.5)',
                  transition: 'background 0.15s ease, color 0.15s ease',
                }}>
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {libraryView === 'songs' ? (
      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}>
      <div
        ref={attachLibList}
        onScroll={(e) => setLibScrollTop(e.currentTarget.scrollTop)}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: azIndex ? '6px 24px 6px 2px' : '6px 6px 6px 2px', scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.15) transparent', position: 'relative' }}
      >
        {spotlightResults.length > 0 ? (
          <div style={{ position: 'relative', height: spotlightResults.length * LIB_ROW_H }}>
          {(() => {
            const first = Math.max(0, Math.floor(libScrollTop / LIB_ROW_H) - 4);
            const last = Math.min(spotlightResults.length, Math.ceil((libScrollTop + libViewH) / LIB_ROW_H) + 4);
            return spotlightResults.slice(first, last).map((tr, k) => {
              const i = first + k;
            const sel = i === librarySelIndex;
            const isCurrent = currentTrackId && tr.id === currentTrackId;
            const canRowActions = !!(onUpdateTrackMetadata || onRemoveFromLibrary);
            return (
              <div
                key={tr.id}
                role="button"
                tabIndex={-1}
                data-sel={sel ? 'true' : 'false'}
                onClick={() => { onSelectTrack(tr); toggleLibrary(false); }}
                onContextMenu={canRowActions ? (e) => { e.preventDefault(); e.stopPropagation(); setFsConfirm(null); setFsMenu({ x: e.clientX, y: e.clientY, track: tr }); } : undefined}
                onMouseEnter={() => { setLibSelByKey(false); setLibrarySelIndex(i); }}
                title={(tr.title || 'Unknown') + ' — ' + (tr.artist || '')}
                className="fs-librow"
                style={{
                  position: 'absolute', top: i * LIB_ROW_H, left: 0, right: 0, height: LIB_ROW_H - 2,
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '0 8px 0 4px', borderRadius: 10, border: 'none', cursor: 'pointer',
                  textAlign: 'left',
                  background: sel && libSelByKey ? `rgba(${accent}, 0.2)` : 'transparent',
                  transition: 'background 0.12s ease',
                }}
              >
                {/* Row number — list position in the current sort. */}
                <span style={{
                  width: 20, textAlign: 'right', flexShrink: 0,
                  fontSize: 10.5, color: isCurrent ? `rgb(${accent})` : 'rgba(255,255,255,0.32)',
                  fontVariantNumeric: 'tabular-nums',
                }}>{i + 1}</span>
                <div style={{
                  width: 38, height: 38, borderRadius: 8, flexShrink: 0,
                  backgroundColor: 'rgba(255,255,255,0.06)',
                  backgroundImage: tr.coverArt ? `url("${tr.coverArt.replace(/"/g, '%22')}")` : 'none',
                  backgroundSize: 'cover', backgroundPosition: 'center',
                }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{
                    fontSize: 13, fontWeight: 500,
                    color: isCurrent ? `rgb(${accent})` : '#fff',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{tr.title || 'Unknown track'}</div>
                  <div style={{
                    fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 1,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{tr.artist || 'Unknown artist'}</div>
                </div>
                {/* Hovered row: pencil + ⋯ — Immerse's row actions. */}
                {canRowActions ? (
                  <div className="fs-librow-acts" style={{ display: 'flex', gap: 5, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                    {onUpdateTrackMetadata ? (
                      <button type="button" title="Edit track info"
                        onClick={() => setMetaEditTarget(tr)}
                        style={{ width: 26, height: 26, borderRadius: 8, border: 'none', cursor: 'pointer', background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>
                      </button>
                    ) : null}
                    <button type="button" title="More"
                      onClick={(e) => { setFsConfirm(null); setFsMenu({ x: e.clientX, y: e.clientY, track: tr }); }}
                      style={{ width: 26, height: 26, borderRadius: 8, border: 'none', cursor: 'pointer', background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
                    </button>
                  </div>
                ) : null}
                {isCurrent ? (
                  <span className={canRowActions ? 'fs-librow-time' : undefined} style={{ flexShrink: 0, display: 'flex', alignItems: 'center', height: 14, lineHeight: 0 }}><FsEqBadge accent={accent} playing={isPlaying} /></span>
                ) : tr.duration ? (
                  <span className={canRowActions ? 'fs-librow-time' : undefined} style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.32)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{formatTime(tr.duration)}</span>
                ) : null}
              </div>
            );
            });
          })()}
          </div>
        ) : librarySearch.trim() ? (
          <div style={{ padding: '22px 14px', textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontSize: 12.5 }}>
            No tracks match “{librarySearch}”.
          </div>
        ) : null}
      </div>
      {/* A–Z rail — floats over the right edge (title sort, no search).
          Click a letter to jump; letters absent from the library are dim. */}
      {azIndex ? (
        <div aria-hidden style={{
          position: 'absolute', top: 6, bottom: 6, right: 11, width: 14,
          display: 'flex', flexDirection: 'column', justifyContent: 'center',
          gap: 0, zIndex: 2, pointerEvents: 'auto',
        }}>
          {['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((L) => {
            const idx = azIndex.get(L);
            const has = idx !== undefined;
            return (
              <button key={L} type="button" tabIndex={-1}
                onClick={has ? () => { if (libraryListRef.current) libraryListRef.current.scrollTop = idx * LIB_ROW_H; } : undefined}
                style={{
                  flex: 1, minHeight: 0, padding: 0, border: 'none', background: 'transparent',
                  cursor: has ? 'pointer' : 'default',
                  fontSize: 8, fontWeight: 700, lineHeight: 1,
                  color: has ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.16)',
                  transition: 'color 0.12s ease',
                }}
                onMouseEnter={(e) => { if (has) e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = has ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.16)'; }}
              >{L}</button>
            );
          })}
        </div>
      ) : null}
      </div>
      ) : openAlbumData ? (
        /* Album detail — header, then the tracklist in disc/track order.
           Click any track to play it (the whole album becomes the context via
           onSelectTrack, same as clicking a track in the main album view). */
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 6, scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.15) transparent' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '4px 6px 10px' }}>
            <button type="button" title="Back to albums"
              onClick={() => { setOpenAlbum(null); setLibrarySearch(''); }}
              style={{
                width: 26, height: 26, borderRadius: 8, flexShrink: 0, border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.75)',
              }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <div style={{
              width: 46, height: 46, borderRadius: 9, flexShrink: 0,
              backgroundColor: 'rgba(255,255,255,0.06)',
              backgroundImage: openAlbumData.displayCover ? `url("${openAlbumData.displayCover.replace(/"/g, '%22')}")` : 'none',
              backgroundSize: 'cover', backgroundPosition: 'center',
              boxShadow: `0 0 0 1px rgba(${accent},0.3)`,
            }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{openAlbumData.album}</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {openAlbumData.artist} · {openAlbumData.tracks.length} tracks
                {openAlbumData.duration ? ` · ${Math.round(openAlbumData.duration / 60)} min` : ''}
              </div>
            </div>
            {onUpdateAlbumMetadata ? (
              <button type="button" title="Edit album info"
                onClick={() => setAlbumEditScope({
                  key: openAlbumData.key,
                  album: openAlbumData.album,
                  artist: openAlbumData.artist,
                  coverArt: openAlbumData.displayCover || null,
                  sampleTrack: openAlbumData.tracks[0] || null,
                  trackIds: openAlbumData.tracks.map((t) => t.id),
                })}
                style={{
                  width: 30, height: 30, borderRadius: 8, flexShrink: 0, border: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.78)',
                }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>
              </button>
            ) : null}
            <button type="button" title="Play album"
              onClick={() => { onSelectTrack?.(openAlbumData.tracks[0]); toggleLibrary(false); }}
              style={{
                width: 30, height: 30, borderRadius: '50%', flexShrink: 0, border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: `rgba(${accent},0.32)`, color: '#fff',
              }}>
              <PlayIcon size={12} />
            </button>
          </div>

          {openAlbumTracks.length ? openAlbumTracks.map((t, i) => {
            const isCurrent = currentTrackId && t.id === currentTrackId;
            const prev = openAlbumTracks[i - 1];
            const showDisc = openAlbumData.hasMultipleDiscs
              && (i === 0 || (prev?.discNumber ?? 1) !== (t.discNumber ?? 1));
            return (
              <React.Fragment key={t.id}>
                {showDisc ? (
                  <div style={{
                    fontSize: 9.5, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase',
                    color: 'rgba(255,255,255,0.35)', padding: '8px 8px 4px',
                  }}>
                    Disc {t.discNumber ?? 1}
                  </div>
                ) : null}
                <div role="button" tabIndex={-1} className="fs-albrow"
                  onClick={() => { onSelectTrack?.(t); toggleLibrary(false); }}
                  onContextMenu={(onUpdateTrackMetadata || onRemoveFromLibrary) ? (e) => { e.preventDefault(); e.stopPropagation(); setFsConfirm(null); setFsMenu({ x: e.clientX, y: e.clientY, track: t }); } : undefined}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                    padding: '7px 10px', borderRadius: 9, border: 'none',
                    background: 'transparent', cursor: 'pointer', textAlign: 'left',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                  <span style={{ width: 18, textAlign: 'right', fontSize: 11, color: 'rgba(255,255,255,0.32)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                    {t.trackNumber ?? '·'}
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{
                      fontSize: 12.5, color: isCurrent ? `rgb(${accent})` : '#fff',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{t.title || 'Untitled'}</div>
                  </div>
                  {(onUpdateTrackMetadata || onRemoveFromLibrary) ? (
                    <span className="fs-albrow-acts" style={{ display: 'flex', gap: 5, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                      {onUpdateTrackMetadata ? (
                        <button type="button" title="Edit track info" onClick={() => setMetaEditTarget(t)}
                          style={{ width: 24, height: 24, borderRadius: 7, border: 'none', cursor: 'pointer', background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>
                        </button>
                      ) : null}
                      <button type="button" title="More" onClick={(e) => { setFsConfirm(null); setFsMenu({ x: e.clientX, y: e.clientY, track: t }); }}
                        style={{ width: 24, height: 24, borderRadius: 7, border: 'none', cursor: 'pointer', background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
                      </button>
                    </span>
                  ) : null}
                  {isCurrent ? (
                    <span className="fs-albrow-time" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', height: 14, lineHeight: 0 }}><FsEqBadge accent={accent} playing={isPlaying} /></span>
                  ) : t.duration ? (
                    <span className="fs-albrow-time" style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.35)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                      {formatTime(t.duration)}
                    </span>
                  ) : null}
                </div>
              </React.Fragment>
            );
          }) : (
            <div style={{ padding: '18px 14px', textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontSize: 12.5 }}>
              No tracks match “{librarySearch}”.
            </div>
          )}
        </div>
      ) : (
        /* Album grid — cover-first tiles, exactly the entry point the main
           library's Albums view gives you. */
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8, scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.15) transparent' }}>
          {filteredAlbums.length ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
              {filteredAlbums.map((a) => {
                const isCurrent = currentTrackId && a.tracks.some((t) => t.id === currentTrackId);
                return (
                  <button key={a.key} type="button"
                    onClick={() => { setOpenAlbum(a.key); setLibrarySearch(''); }}
                    title={`${a.album} — ${a.artist}`}
                    style={{
                      display: 'flex', flexDirection: 'column', gap: 6, padding: 6,
                      border: 'none', borderRadius: 12, cursor: 'pointer', textAlign: 'left',
                      background: 'transparent', transition: 'background 0.15s ease',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                    <div style={{
                      width: '100%', aspectRatio: '1', borderRadius: 9,
                      backgroundColor: 'rgba(255,255,255,0.06)',
                      backgroundImage: a.displayCover ? `url("${a.displayCover.replace(/"/g, '%22')}")` : 'none',
                      backgroundSize: 'cover', backgroundPosition: 'center',
                      boxShadow: isCurrent ? `0 0 0 2px rgba(${accent},0.65)` : '0 6px 18px rgba(0,0,0,0.35)',
                    }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{
                        fontSize: 12, fontWeight: 600,
                        color: isCurrent ? `rgb(${accent})` : '#fff',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>{a.album}</div>
                      <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.5)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {a.artist}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div style={{ padding: '22px 14px', textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontSize: 12.5, lineHeight: 1.5 }}>
              {librarySearch.trim() ? `No albums match “${librarySearch}”.` : 'No albums yet — anything with two or more tracks shows up here.'}
            </div>
          )}
        </div>
      )}
      </>) : null}

      {cardTab === 'find' ? (<>
        <div style={{ padding: 12, borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
          {/* Source switch — Spotify (tagged, matched via yt-dlp) or Soulseek
              (raw peer files). Same two sources as the main Find tab. */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 8, padding: 3, borderRadius: 9, background: 'rgba(255,255,255,0.05)' }}>
            {[['spotify', 'Songs'], ['albums', 'Albums'], ['soulseek', 'Soulseek']].map(([id, label]) => (
              <button key={id} type="button" onClick={() => pickFindSource(id)}
                style={{
                  flex: 1, padding: '6px 0', borderRadius: 7, border: 'none', cursor: 'pointer',
                  fontSize: 11.5, fontWeight: 700, letterSpacing: '0.01em',
                  background: findSource === id ? `rgba(${accent},0.28)` : 'transparent',
                  color: findSource === id ? '#fff' : 'rgba(255,255,255,0.5)',
                  transition: 'background 0.18s ease, color 0.18s ease',
                }}>
                {label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="text"
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
              onKeyDown={(e) => {
                // In FIND, Enter searches (Esc still closes the card).
                if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); runFind(); }
              }}
              placeholder={findSource === 'albums' ? 'Search for an album…' : findSource === 'spotify' ? 'Search Spotify… artist and song' : 'Search Soulseek… artist and song'}
              style={{
                flex: 1, padding: '10px 12px', borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.1)',
                background: 'rgba(255,255,255,0.06)',
                color: '#fff', fontSize: 13, outline: 'none',
              }}
            />
            <button type="button" onClick={runFind} disabled={findBusy}
              style={{
                padding: '0 14px', borderRadius: 10, border: 'none',
                background: `rgba(${accent},0.3)`, color: '#fff',
                fontSize: 12, fontWeight: 700, cursor: findBusy ? 'default' : 'pointer',
                opacity: findBusy ? 0.55 : 1,
              }}>
              {findBusy ? '…' : 'Search'}
            </button>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 6, scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.15) transparent' }}>
          {/* Soulseek album folders — the good stuff first, songs after. */}
          {findSource === 'soulseek' && findSsAlbums.length ? (
            <>
              <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', padding: '4px 10px 6px' }}>
                Albums · {findSsAlbums.length}
              </div>
              {findSsAlbums.map((alb) => {
                const open = openFindSsAlbum === alb.id;
                const dl = dlState[`ssa:${alb.id}`];
                const prog = findSsAlbumProg[alb.id];
                const progressText = dl === 'busy' && prog?.total
                  ? `${Math.min(prog.completed ?? 0, prog.total)} / ${prog.total}`
                  : null;
                return (
                  <div key={alb.id} style={{ marginBottom: 2 }}>
                    <div onClick={() => setOpenFindSsAlbum((cur) => (cur === alb.id ? null : alb.id))}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 11, padding: '7px 10px', borderRadius: 10, cursor: 'pointer',
                        background: open ? 'rgba(255,255,255,0.05)' : 'transparent',
                        transition: 'background 0.15s ease',
                      }}>
                      <div style={{
                        width: 40, height: 40, borderRadius: 8, flexShrink: 0,
                        background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{alb.displayName}</div>
                        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {alb.trackCount} tracks
                          {alb.ext && alb.ext !== 'mixed' ? ` · ${String(alb.ext).toUpperCase()}` : ''}
                          {alb.bitrate ? ` · ${alb.bitrate}kbps` : ''}
                          {alb.totalSize ? ` · ${(alb.totalSize / 1048576).toFixed(0)} MB` : ''}
                          {` · ${alb.user}`}
                        </div>
                      </div>
                      {progressText ? (
                        <span style={{ fontSize: 10, color: `rgb(${accent})`, fontVariantNumeric: 'tabular-nums', flexShrink: 0, animation: 'immerseFullscreenIn 0.3s ease both' }}>
                          {progressText}
                        </span>
                      ) : null}
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                        style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 220ms cubic-bezier(0.3,0.9,0.3,1)' }}>
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                      <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexShrink: 0 }}>
                        <DlBtn st={dlState[`ssa:${alb.id}`]} progress={dlProgress[`ssa:${alb.id}`]} accent={accent} title="Download the whole album" onClick={() => downloadFindSsAlbum(alb)} />
                      </div>
                    </div>
                    {open ? (
                      <div style={{
                        margin: '2px 0 6px 12px', paddingLeft: 10,
                        borderLeft: `1px solid rgba(${accent},0.25)`,
                        animation: reduceMotion ? 'none' : 'immerseFullscreenTabIn 220ms cubic-bezier(0.2,0.8,0.2,1) both',
                      }}>
                        {alb.tracks.map((t) => (
                          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 8px 5px 2px', borderRadius: 8 }}>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontSize: 12, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.filename}</div>
                              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {t.bitrate ? `${t.bitrate} kbps · ` : ''}{t.size ? `${(t.size / 1048576).toFixed(1)} MB` : ''}
                              </div>
                            </div>
                            <DlBtn st={dlState[`t:${t.id}`]} progress={dlProgress[`t:${t.id}`]} accent={accent} title="Download this track" onClick={() => downloadSoulseekRow(t)} />
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {findResults.length ? (
                <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', padding: '8px 10px 6px' }}>
                  Songs · {findResults.length}
                </div>
              ) : null}
            </>
          ) : null}
          {(findResults.length || (findSource === 'soulseek' && findSsAlbums.length)) ? findResults.map((row) => (
            findSource === 'albums' ? (() => {
              const open = openFindAlbum === row.albumId;
              const tks = findAlbumTracks[row.albumId];
              return (
                <div key={row.albumId} style={{ marginBottom: 2 }}>
                  <div onClick={() => toggleFindAlbum(row)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 11, padding: '7px 10px', borderRadius: 10, cursor: 'pointer',
                      background: open ? 'rgba(255,255,255,0.05)' : 'transparent',
                      transition: 'background 0.15s ease',
                    }}>
                    <div style={{
                      width: 40, height: 40, borderRadius: 8, flexShrink: 0,
                      backgroundColor: 'rgba(255,255,255,0.06)',
                      backgroundImage: row.albumArtUrl ? `url("${String(row.albumArtUrl).replace(/"/g, '%22')}")` : 'none',
                      backgroundSize: 'cover', backgroundPosition: 'center',
                    }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.name}</div>
                      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {row.artists}
                        {row.releaseDate ? ` · ${String(row.releaseDate).slice(0, 4)}` : ''}
                        {row.totalTracks ? ` · ${row.totalTracks} ${row.totalTracks === 1 ? 'track' : 'tracks'}` : ''}
                      </div>
                    </div>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                      style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 220ms cubic-bezier(0.3,0.9,0.3,1)' }}>
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                    <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexShrink: 0 }}>
                      <DlBtn st={dlState[`sa:${row.albumId}`]} progress={dlProgress[`sa:${row.albumId}`]} accent={accent} title="Download the tracks you don’t have" onClick={() => downloadFindAlbum(row)} />
                    </div>
                  </div>
                  {open ? (
                    <div style={{
                      margin: '2px 0 6px 12px', paddingLeft: 10,
                      borderLeft: `1px solid rgba(${accent},0.25)`,
                      animation: reduceMotion ? 'none' : 'immerseFullscreenTabIn 220ms cubic-bezier(0.2,0.8,0.2,1) both',
                    }}>
                      {findAlbumBusy[row.albumId] ? (
                        <div style={{ padding: '12px 8px', fontSize: 11.5, color: 'rgba(255,255,255,0.45)' }}>Loading tracks…</div>
                      ) : (tks || []).map((t) => {
                        const owned = alreadyOwned(t.title, t.artists);
                        const key = `s:${t.spotifyId}`;
                        return (
                          <div key={t.spotifyId} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 8px 5px 2px', borderRadius: 8 }}>
                            <span style={{ width: 16, textAlign: 'right', fontSize: 10.5, color: 'rgba(255,255,255,0.32)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                              {t.trackNumber || '·'}
                            </span>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontSize: 12, color: owned ? 'rgba(255,255,255,0.5)' : '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {t.title}
                              </div>
                            </div>
                            {t.durationMs ? (
                              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                                {formatTime(Math.round(t.durationMs / 1000))}
                              </span>
                            ) : null}
                            {owned && dlState[key] !== 'done' ? (
                              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', flexShrink: 0 }}>owned</span>
                            ) : (
                              <DlBtn st={dlState[key]} progress={dlProgress[key]} accent={accent} title="Download this track" onClick={() => downloadSpotifyRow(t)} />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })() : findSource === 'spotify' ? (
              <div key={row.spotifyId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 10 }}>
                <div style={{
                  width: 34, height: 34, borderRadius: 7, flexShrink: 0,
                  backgroundColor: 'rgba(255,255,255,0.06)',
                  backgroundImage: row.albumArtUrl ? `url("${String(row.albumArtUrl).replace(/"/g, '%22')}")` : 'none',
                  backgroundSize: 'cover', backgroundPosition: 'center',
                }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {row.title || 'Unknown track'}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.5)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {row.artists || 'Unknown artist'}{row.album ? ` · ${row.album}` : ''}
                  </div>
                </div>
                {alreadyOwned(row.title, row.artists) && dlState[`s:${row.spotifyId}`] !== 'done' ? (
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', flexShrink: 0, marginRight: 2 }}>in library</span>
                ) : null}
                <DlBtn st={dlState[`s:${row.spotifyId}`]} progress={dlProgress[`s:${row.spotifyId}`]} accent={accent} title="Download to library" onClick={() => downloadSpotifyRow(row)} />
              </div>
            ) : (
              <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 10 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {row.filename || 'Unknown file'}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.5)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {row.bitrate ? `${row.bitrate} kbps · ` : ''}{row.size ? `${(row.size / 1048576).toFixed(1)} MB · ` : ''}{row.user}
                  </div>
                </div>
                <DlBtn st={dlState[`t:${row.id}`]} progress={dlProgress[`t:${row.id}`]} accent={accent} title="Download to library" onClick={() => downloadSoulseekRow(row)} />
              </div>
            )
          )) : (
            <div style={{ padding: '24px 16px', textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontSize: 12.5, lineHeight: 1.55 }}>
              {findBusy ? (findSource === 'soulseek' ? 'Searching the network…' : 'Searching Spotify…')
                : findError || (findSource === 'albums'
                  ? 'Search for an album — open it to grab single tracks.'
                  : 'Search for a song — downloads land straight in your library.')}
            </div>
          )}
        </div>
      </>) : null}

      {cardTab === 'releases' ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 6, scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.15) transparent' }}>
          {(releases || []).length ? releases.slice(0, 40).map((r, i) => {
            const cid = Number(r.collectionId);
            const open = expandedRelease === cid;
            const tks = releaseTracks[cid];
            const isSingle = (Number(r.trackCount) || 0) <= 1;
            const albumKey = `r:${cid || r.collectionName}`;
            return (
              <div key={r.collectionId || `${r.artistName}-${r.collectionName}-${i}`} style={{ marginBottom: 2 }}>
                <div
                  onClick={() => { if (!isSingle) toggleRelease(r); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 11, padding: '7px 10px', borderRadius: 10,
                    cursor: isSingle ? 'default' : 'pointer',
                    background: open ? 'rgba(255,255,255,0.05)' : 'transparent',
                    transition: 'background 0.15s ease',
                  }}>
                  <div style={{
                    width: 38, height: 38, borderRadius: 8, flexShrink: 0,
                    backgroundColor: 'rgba(255,255,255,0.06)',
                    backgroundImage: r.artworkUrl ? `url("${String(r.artworkUrl).replace(/"/g, '%22')}")` : 'none',
                    backgroundSize: 'cover', backgroundPosition: 'center',
                  }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.collectionName || r.name || 'Untitled'}</div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {r.artistName || 'Unknown artist'}
                      {(() => {
                        const d = r.releaseDate ? new Date(r.releaseDate) : null;
                        const ds = d && !Number.isNaN(d.getTime())
                          ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                          : null;
                        return ds ? ` · ${ds}` : '';
                      })()}
                      {r.trackCount ? ` · ${r.trackCount} ${r.trackCount === 1 ? 'track' : 'tracks'}` : ''}
                    </div>
                  </div>
                  {/* Chevron rotates open — the affordance for the tracklist. */}
                  {!isSingle ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                      style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 220ms cubic-bezier(0.3,0.9,0.3,1)' }}>
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  ) : null}
                  <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexShrink: 0 }}>
                    <DlBtn st={dlState[albumKey]} progress={dlProgress[albumKey]} accent={accent} title={isSingle ? 'Download' : 'Download the tracks you don’t have'} onClick={() => downloadRelease(r)} />
                  </div>
                </div>

                {open ? (
                  <div style={{
                    margin: '2px 0 6px 10px', paddingLeft: 10,
                    borderLeft: `1px solid rgba(${accent},0.25)`,
                    animation: reduceMotion ? 'none' : 'immerseFullscreenTabIn 220ms cubic-bezier(0.2,0.8,0.2,1) both',
                  }}>
                    {releaseTrackBusy[cid] ? (
                      <div style={{ padding: '12px 8px', fontSize: 11.5, color: 'rgba(255,255,255,0.45)' }}>Loading tracks…</div>
                    ) : releaseTrackErr[cid] && !tks?.length ? (
                      <div style={{ padding: '12px 8px', fontSize: 11.5, color: '#f0a0a0' }}>{releaseTrackErr[cid]}</div>
                    ) : (tks || []).map((tk) => {
                      const owned = alreadyOwned(tk.trackName, tk.artistName || r.artistName);
                      const key = `rt:${cid}:${tk.trackId}`;
                      return (
                        <div key={tk.trackId} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 8px 5px 2px', borderRadius: 8 }}>
                          <span style={{ width: 16, textAlign: 'right', fontSize: 10.5, color: 'rgba(255,255,255,0.32)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                            {tk.trackNumber || '·'}
                          </span>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: 12, color: owned ? 'rgba(255,255,255,0.5)' : '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {tk.trackName || 'Untitled'}
                            </div>
                          </div>
                          {tk.trackTimeMillis ? (
                            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                              {(() => { const s = Math.round(tk.trackTimeMillis / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; })()}
                            </span>
                          ) : null}
                          {owned && dlState[key] !== 'done' ? (
                            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', flexShrink: 0 }}>owned</span>
                          ) : (
                            <DlBtn st={dlState[key]} progress={dlProgress[key]} accent={accent} title="Download this track" onClick={() => downloadReleaseTrack(r, tk)} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          }) : (
            <div style={{ padding: '22px 14px', textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontSize: 12.5, lineHeight: 1.5 }}>
              No releases yet — follow artists in the Explore tab and they’ll show up here.
            </div>
          )}
        </div>
      ) : null}

      {cardTab === 'stats' && listeningStats ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 12px', scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.15) transparent' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
            {[[listeningStats.plays7, 'plays · 7d'], [listeningStats.plays30, 'plays · 30d'], [`${listeningStats.hours30.toFixed(1)}h`, 'heard · 30d']].map(([v, l]) => (
              <div key={l} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: '10px 6px', textAlign: 'center' }}>
                <div style={{ fontSize: 17, fontWeight: 800, color: '#fff', fontVariantNumeric: 'tabular-nums' }}>{v}</div>
                <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.45)', marginTop: 2, letterSpacing: '0.05em', textTransform: 'uppercase' }}>{l}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)', marginBottom: 6 }}>Top tracks</div>
          {listeningStats.topTracks.length ? listeningStats.topTracks.map(({ track: t, n }, i) => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 4px' }}>
              <span style={{ width: 16, textAlign: 'right', fontSize: 11, color: 'rgba(255,255,255,0.35)', fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
              <div style={{ width: 30, height: 30, borderRadius: 6, flexShrink: 0, backgroundColor: 'rgba(255,255,255,0.06)', backgroundImage: t.coverArt ? `url("${t.coverArt.replace(/"/g, '%22')}")` : 'none', backgroundSize: 'cover', backgroundPosition: 'center' }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</div>
              </div>
              <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.45)', fontVariantNumeric: 'tabular-nums' }}>{n}×</span>
            </div>
          )) : <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', padding: '8px 4px' }}>Nothing played in the last 30 days.</div>}
          {listeningStats.topArtists.length ? (<>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)', margin: '12px 0 6px' }}>Top artists</div>
            {listeningStats.topArtists.map(([name, n], i) => (
              <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 4px' }}>
                <span style={{ width: 16, textAlign: 'right', fontSize: 11, color: 'rgba(255,255,255,0.35)', fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: i === 0 ? `rgb(${accent})` : '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
                </div>
                <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.45)', fontVariantNumeric: 'tabular-nums' }}>{n} plays</span>
              </div>
            ))}
          </>) : null}
        </div>
      ) : null}

      {cardTab === 'settings' ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.15) transparent' }}>
          {/* Controls visibility — the dock (and dock cards) auto-hide after
              3s of stillness by default; this pins them on screen. */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)', marginBottom: 8 }}>Controls</div>
            <button
              type="button"
              onClick={() => pickAutoHideDock(!autoHideDock)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
                padding: '9px 10px', borderRadius: 10, cursor: 'pointer',
                border: autoHideDock ? `1px solid rgba(${accent},0.5)` : '1px solid rgba(255,255,255,0.08)',
                background: autoHideDock ? `rgba(${accent},0.18)` : 'rgba(255,255,255,0.04)',
                transition: 'background 0.18s ease, border-color 0.18s ease',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: '#fff' }}>Auto-hide controls</div>
                <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.5)', marginTop: 2, lineHeight: 1.4 }}>
                  {autoHideDock
                    ? 'The playback bar fades away after 3 seconds of stillness — move the mouse to bring it back.'
                    : 'Off — the playback bar stays on screen at all times.'}
                </div>
              </div>
              <div aria-hidden style={{
                width: 34, height: 20, borderRadius: 999, flexShrink: 0, position: 'relative',
                background: autoHideDock ? `rgba(${accent},0.85)` : 'rgba(255,255,255,0.14)',
                border: '1px solid rgba(255,255,255,0.18)',
                transition: 'background 0.18s ease',
              }}>
                <div style={{
                  position: 'absolute', top: 2, left: autoHideDock ? 15 : 2,
                  width: 14, height: 14, borderRadius: '50%', background: '#fff',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
                  transition: 'left 0.18s cubic-bezier(0.3, 0.9, 0.3, 1)',
                }} />
              </div>
            </button>
          </div>

          {/* Playback — gapless toggle. Only rendered when the host wires the
              setter (studio does; Immerse keeps this in its main Settings tab). */}
          {onSetTransitionMode ? (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)', marginBottom: 8 }}>Playback</div>
              <button
                type="button"
                onClick={() => onSetTransitionMode(transitionMode === 'gapless' ? 'off' : 'gapless')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
                  padding: '9px 10px', borderRadius: 10, cursor: 'pointer',
                  border: transitionMode === 'gapless' ? `1px solid rgba(${accent},0.5)` : '1px solid rgba(255,255,255,0.08)',
                  background: transitionMode === 'gapless' ? `rgba(${accent},0.18)` : 'rgba(255,255,255,0.04)',
                  transition: 'background 0.18s ease, border-color 0.18s ease',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: '#fff' }}>Gapless playback</div>
                  <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.5)', marginTop: 2, lineHeight: 1.4 }}>
                    {transitionMode === 'gapless'
                      ? 'The next track is preloaded and starts seamlessly — no gap between songs.'
                      : transitionMode === 'crossfade'
                        ? 'Crossfade is active. Turning this on switches to gapless instead.'
                        : 'Tracks currently change with a hard cut. Turn on to remove the gap.'}
                  </div>
                </div>
                {/* Switch pill */}
                <div aria-hidden style={{
                  width: 34, height: 20, borderRadius: 999, flexShrink: 0, position: 'relative',
                  background: transitionMode === 'gapless' ? `rgba(${accent},0.85)` : 'rgba(255,255,255,0.14)',
                  border: '1px solid rgba(255,255,255,0.18)',
                  transition: 'background 0.18s ease',
                }}>
                  <div style={{
                    position: 'absolute', top: 2, left: transitionMode === 'gapless' ? 15 : 2,
                    width: 14, height: 14, borderRadius: '50%', background: '#fff',
                    boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
                    transition: 'left 0.18s cubic-bezier(0.3, 0.9, 0.3, 1)',
                  }} />
                </div>
              </button>
            </div>
          ) : null}

        </div>
      ) : null}
      </div>

      <div style={{
        padding: '8px 10px', flexShrink: 0, textAlign: 'center',
        fontSize: 10.5, color: 'rgba(255,255,255,0.4)',
        borderTop: '1px solid rgba(255,255,255,0.06)',
      }}>
        {cardTab === 'library'
          ? (openAlbumData
            ? `${openAlbumTracks.length} ${openAlbumTracks.length === 1 ? 'track' : 'tracks'} · click plays · Enter or Esc closes`
            : libraryView === 'albums'
              ? `${filteredAlbums.length} ${filteredAlbums.length === 1 ? 'album' : 'albums'} · click one to open it`
              : `${spotlightResults.length} ${spotlightResults.length === 1 ? 'track' : 'tracks'} · ↑ ↓ browse · click plays · Enter or Esc closes`)
          : cardTab === 'find' ? (findSource === 'soulseek'
            ? 'Soulseek · Enter searches · downloads import automatically'
            : findSource === 'albums'
              ? 'Spotify · Enter searches · open an album for single tracks'
              : 'Spotify · Enter searches · downloads import automatically')
          : cardTab === 'releases' ? 'From artists you follow · click an album for its tracks'
            : cardTab === 'stats' ? 'Last 30 days of listening'
              : 'Applies instantly'}
      </div>
      {/* Resize grip — drag to size the card; double-click resets to the
          cover square. Corner-anchored so it never collides with content. */}
      <div
        onPointerDown={handleCardResizeDown}
        onPointerMove={handleCardResizeMove}
        onPointerUp={handleCardResizeUp}
        onPointerCancel={handleCardResizeUp}
        onDoubleClick={resetCardSize}
        title="Drag to resize · double-click to reset"
        style={{
          position: 'absolute', right: 0, bottom: 0, width: 20, height: 20,
          cursor: 'nwse-resize', touchAction: 'none', zIndex: 3,
          display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: 5,
        }}
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1.4" strokeLinecap="round">
          <path d="M9 1L1 9M9 5L5 9" />
        </svg>
      </div>
    </div>
  );

  // Centered mode's song-info mount — the same visual language as the
  // relocated header, parked permanently top-center. No refs, no ghost:
  // this mode has no big cover, so the info simply lives here.
  const centeredHeader = (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, minWidth: 0, maxWidth: '100%',
      animation: reduceMotion ? 'none' : 'immerseFullscreenCoverIn 340ms cubic-bezier(0.2,0.7,0.2,1) both',
    }}>
      <div style={{
        width: 84, height: 84, borderRadius: 13, flexShrink: 0,
        backgroundColor: '#111',
        backgroundImage: coverUrl ? `url("${coverUrl.replace(/"/g, '%22')}")` : 'none',
        backgroundSize: 'cover', backgroundPosition: 'center',
        boxShadow: `0 0 0 1px rgba(${accent},0.4), inset 0 0 0 1px rgba(255,255,255,0.22)`,
      }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 19, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {title || 'Unknown track'}
        </div>
        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {artist || 'Unknown artist'}{album ? <span style={{ color: 'rgba(255,255,255,0.35)' }}>{` · ${album}`}</span> : null}
        </div>
      </div>
    </div>
  );

  // The cover/controls rail — always the centered, chrome-free composition.
  const rail = (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 0, padding: '40px 36px',
      flexShrink: 0,
      // A dock card strip is open below: the stage glides up to hand it the
      // space, and settles back down when the strip collapses.
      transform: dockCard ? 'translateY(-86px)' : 'translateY(0)',
      transition: reduceMotion ? 'none' : 'transform 360ms cubic-bezier(0.22, 1, 0.36, 1)',
    }}>
      {/* While search is open in flip/no-lyrics modes, the relocated cover
          header lives at the top of the rail (side mode puts it above the
          lyrics column instead). Same animated slot: geometry stays
          continuous so the square below glides instead of jumping. */}
      {!sideLyrics ? (
        <div ref={railSlotRef} style={{
          height: libraryOpen ? MINI_HEADER_H : 0,
          transition: reduceMotion ? 'none' : 'height 420ms cubic-bezier(0.3, 0.7, 0.25, 1)',
          overflow: 'hidden', flexShrink: 0, position: 'relative', alignSelf: 'stretch',
        }}>
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0,
            visibility: (libraryOpen || coverInFlight) ? 'visible' : 'hidden',
            pointerEvents: libraryOpen ? 'auto' : 'none',
          }}>{miniHeader}</div>
        </div>
      ) : null}
      {/* Cover — in flip mode it's a two-sided card: artwork on the front,
          lyrics on the back, rotating on L / click. In side mode it shrinks
          a touch so cover + lyrics column fit as one centered pair. While
          search is open, this exact square hosts the library card instead —
          same footprint, so the transport controls below never move. */}
      <div
        ref={bigCoverRef}
        onClick={flipMode && !libraryOpen ? (e) => { e.stopPropagation(); setFlipped((f) => !f); } : undefined}
        title={flipMode && !libraryOpen ? (flipped ? 'Show cover (L)' : 'Show lyrics (L)') : undefined}
        style={{
          position: 'relative',
          width: sideLyrics ? 'min(52vh, 42vw)' : 'min(58vh, 46vw)',
          aspectRatio: '1',
          perspective: 1400,
          cursor: flipMode ? 'pointer' : 'default',
          animation: reduceMotion ? 'none' : 'immerseFullscreenCoverIn 300ms cubic-bezier(0.2,0.7,0.2,1)',
        }}>
        {(libraryOpen || cardExiting || (coverGhost && !coverGhost.opening)) ? (
          // key: this wrapper and the flip stack below are both keyless
          // <div>s in the same slot — React RECONCILED them into one
          // element and morphed the style, so at the close swap the
          // transform transitioned from translate(dragOffset) to
          // rotateY(0) over 0.6s: the real cover visibly slid in from the
          // card's dragged position. Distinct keys force a clean
          // unmount/mount — no transition between the two worlds.
          <div key="fs-card-slot" style={{
            position: 'absolute', zIndex: 3,
            ...(cardSize
              ? { left: '50%', top: '50%', width: cardSize.w, height: cardSize.h, marginLeft: -Math.round(cardSize.w / 2), marginTop: -Math.round(cardSize.h / 2) }
              : { inset: 0 }),
            // + CC_NUDGE: the rail hangs off the left edge only, so the card
            // alone being centered leaves the PAIR sitting left of center.
            // Rounded so a fractional offset can't blur the card's text.
            transform: `translate(${Math.round(cardOffset.x + CC_NUDGE)}px, ${Math.round(cardOffset.y)}px)`,
            // Direct follow while dragging; an eased glide for the
            // double-click snap-home.
            transition: cardDragRef.current ? 'none' : 'transform 280ms cubic-bezier(0.2, 0.8, 0.2, 1)',
          }}>{commandMenu}{libraryCard}</div>
        ) : (
        <div key="fs-flip-stack" style={{
          position: 'absolute', inset: 0,
          transformStyle: 'preserve-3d',
          transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
          transition: reduceMotion ? 'none' : 'transform 0.6s cubic-bezier(0.3,0.7,0.25,1)',
        }}>
          {/* Front: artwork.
              Rendered as a background-image (not an <img object-fit:cover>)
              on purpose. When this overlay opens from the now-playing page,
              the new <img> would be handed an already-decoded/cached bitmap
              and Chromium paints it once at the image's intrinsic ratio
              before object-fit:cover takes effect — so non-square covers
              showed bars until a track change forced a fresh load + relayout.
              background-size:cover is computed from the box immediately and
              has no such cached-image quirk (it's how every cover tile in the
              app already renders). */}
          <div style={{
            position: 'absolute', inset: 0, borderRadius: 16, overflow: 'hidden',
            boxShadow: `0 24px 70px rgba(0,0,0,0.55), 0 0 0 1px rgba(${accent},0.4), inset 0 0 0 1px rgba(255,255,255,0.22)`,
            background: '#111',
            backgroundImage: coverUrl ? `url("${coverUrl}")` : 'none',
            backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat',
            backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden',
          }}>
            {!coverUrl ? (
              <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#444' }}>
                <Icons.AlbumSidebar />
              </div>
            ) : null}
          </div>
          {/* Back: lyric card (flip mode only) */}
          {flipMode ? (
            <div onClick={(e) => e.stopPropagation()} style={{
              position: 'absolute', inset: 0, borderRadius: 16, overflow: 'hidden',
              transform: 'rotateY(180deg)',
              backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden',
              background: 'rgba(16,16,19,0.78)',
              backdropFilter: 'blur(30px) saturate(1.4)', WebkitBackdropFilter: 'blur(30px) saturate(1.4)',
              border: '1px solid rgba(255,255,255,0.1)',
              boxShadow: `0 24px 70px rgba(0,0,0,0.55), 0 0 0 1px rgba(${accent},0.35), inset 0 0 0 1px rgba(255,255,255,0.22)`,
              padding: '26px 26px', display: 'flex', flexDirection: 'column', cursor: 'default',
            }}>
              {hasSyncedLyrics ? (
                <SyncedLyrics lines={lyricsData.synced} currentTime={currentTime} accent={accent} onSeek={onSeek} fontSize={16} lineHeight={1.5}
                  selection={lyricSel} onSelectStart={handleFsSelectStart} onSelectLine={handleFsSelectExtend} />
              ) : (
                <PlainLyrics text={lyricsData.plain} fontSize={15} lineHeight={1.65} accent={accent}
                  selection={lyricSel} onSelectStart={handleFsSelectStart} onSelectLine={handleFsSelectExtend} />
              )}
            </div>
          ) : null}
        </div>
        )}
      </div>

      {/* Title / artist / album — while search is open the song info lives
          in the relocated header instead; this block fades and drifts down
          but KEEPS its layout space so the controls below stay planted. */}
      {/* Per-line, direction-aware — see bigInfoAnim. The block KEEPS its
          layout space either way so the transport controls below never move. */}
      <div style={{
        textAlign: 'center', marginTop: 22, maxWidth: '100%',
        pointerEvents: libraryOpen ? 'none' : 'auto',
      }}>
        <div style={{
          fontSize: 'clamp(19px, 2.4vmin, 26px)', fontWeight: 700, color: '#fff',
          letterSpacing: '-0.01em', lineHeight: 1.15, textShadow: '0 2px 20px rgba(0,0,0,0.6)',
          overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          animation: bigInfoAnim('title'),
        }}>{(title || 'No track').trim()}</div>
        {artist ? (
          <div style={{
            marginTop: 5, fontSize: 'clamp(12px, 1.4vmin, 14px)', color: 'rgba(255,255,255,0.65)', fontWeight: 500,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            animation: bigInfoAnim('artist'),
          }}>
            {artist.trim()}{album ? <span style={{ color: 'rgba(255,255,255,0.4)' }}>{` · ${album.trim()}`}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );

  return (
    <div
      ref={dialogRef} role="dialog" aria-modal="true"
      aria-label={`${title || 'Now playing'} — fullscreen`} tabIndex={-1}
      onKeyDown={handleKey} onMouseMove={bumpActivity}
      style={{
        position: 'fixed', inset: 0, zIndex: 120,
        // Sit ABOVE the app's window-drag title bar (z-index 99) and window
        // controls (z-index 101) — otherwise that drag region renders over the
        // top of the overlay and turns clicks on the close button into window
        // drags. The whole surface is no-drag; only the centre strip below
        // re-enables dragging the window.
        WebkitAppRegion: 'no-drag',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        // Constant bottom reserve so the centered composition clears the
        // floating dock pill. Never idle-dependent — the art doesn't move.
        paddingBottom: '9vh',
        background: '#000', animation: reduceMotion ? 'none' : 'immerseFullscreenIn 220ms ease-out', outline: 'none',
        cursor: idle ? 'none' : 'default',
      }}
    >
      <style>{`
        @keyframes immerseFullscreenIn { 0% { opacity: 0; } 100% { opacity: 1; } }
        @keyframes immerseFullscreenCoverIn { 0% { opacity: 0; transform: scale(0.96) translateY(8px); } 100% { opacity: 1; transform: none; } }
        @keyframes immerseFullscreenLyricsIn { 0% { opacity: 0; } 100% { opacity: 1; } }
        @keyframes immerseFullscreenSearchCardIn { 0% { opacity: 0; transform: scale(0.96) translateY(10px); } 100% { opacity: 1; transform: none; } }
        /* Out ends exactly where In starts — the entrance, reversed. */
        @keyframes immerseFullscreenSearchCardOut { 0% { opacity: 1; transform: scale(1) translateY(0); } 100% { opacity: 0; transform: scale(0.965) translateY(4px); } }
        @keyframes immerseFullscreenTabIn { 0% { opacity: 0; transform: translateY(8px); } 100% { opacity: 1; transform: none; } }
        @keyframes immerseFullscreenTabOut { 0% { opacity: 1; transform: translateY(0); } 100% { opacity: 0; transform: translateY(8px); } }
        @keyframes immerseFullscreenMenuIn { 0% { opacity: 0; transform: translateX(26px) scale(0.94); } 100% { opacity: 1; transform: none; } }
        @keyframes immerseFullscreenMenuOut { 0% { opacity: 1; transform: translateX(0) scale(1); } 100% { opacity: 0; transform: translateX(26px) scale(0.94); } }
        @keyframes immerseFullscreenMenuIconIn { 0% { opacity: 0; transform: translateX(10px); } 100% { opacity: 1; transform: none; } }
        @keyframes immerseFullscreenMenuIconOut { 0% { opacity: 1; transform: translateX(0); } 100% { opacity: 0; transform: translateX(10px); } }
        @keyframes immerseFullscreenSpin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        @keyframes immerseFullscreenHeaderTextIn { 0% { opacity: 0; transform: translateX(-14px); } 100% { opacity: 1; transform: translateX(0); } }
        /* Exit = the entrance played backwards: identical 14px travel (was
           22px, which read as a different, faster gesture), reversed stagger,
           and the inverse easing curve. */
        @keyframes immerseFullscreenHeaderTextOut { 0% { opacity: 1; transform: translateX(0); } 100% { opacity: 0; transform: translateX(-14px); } }
        /* Big centered song info — rises into place under the returning
           artwork, sinks away as it lifts off. */
        @keyframes immerseFullscreenBigInfoIn { 0% { opacity: 0; transform: translateY(12px); } 100% { opacity: 1; transform: translateY(0); } }
        @keyframes immerseFullscreenBigInfoOut { 0% { opacity: 1; transform: translateY(0); } 100% { opacity: 0; transform: translateY(10px); } }
        @keyframes immerseKaraokeLineIn { 0% { opacity: 0; transform: translateY(10px); } 100% { opacity: 1; transform: translateY(0); } }
        @keyframes immerseFsEqBar { 0%, 100% { height: 4px; } 50% { height: 13px; } }
        .fs-librow:hover { background: rgba(255,255,255,0.07) !important; }
        .fs-librow .fs-librow-acts { display: none !important; }
        .fs-librow:hover .fs-librow-acts { display: flex !important; }
        .fs-librow:hover .fs-librow-time { display: none; }
        .fs-lyrcol .fs-lyrtools { opacity: 0; pointer-events: none; transition: opacity 0.18s ease; }
        .fs-lyrcol:hover .fs-lyrtools { opacity: 1; pointer-events: auto; }
        .fs-albrow .fs-albrow-acts { display: none !important; }
        .fs-albrow:hover .fs-albrow-acts { display: flex !important; }
        .fs-albrow:hover .fs-albrow-time { display: none; }
      `}</style>

      {/* Backdrop — blurred album art (default) or the animated colour
          field from the now-playing page. The field component ships its own
          vignette; the radial one below belongs to cover mode only. */}
      {backdropMode === 'field' ? (
        <AnimatedGradientBg
          accent={accent} mid={mid} wash={wash} coverUrl={coverUrl}
          analyserRef={analyserRef} beatReactive={beatReactive} isPlaying={isPlaying}
        />
      ) : (
        <>
          {coverUrl ? (
            <div aria-hidden ref={backdropRef} style={{
              position: 'absolute', inset: -80, backgroundImage: `url(${coverUrl})`,
              backgroundSize: 'cover', backgroundPosition: 'center',
              filter: 'blur(90px) saturate(1.5) brightness(0.5)', opacity: 0.85, pointerEvents: 'none',
              willChange: beatReactive ? 'filter, transform' : 'auto',
            }} />
          ) : null}
          <div aria-hidden style={{
            position: 'absolute', inset: 0,
            background: 'radial-gradient(ellipse at center, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.6) 100%)', pointerEvents: 'none',
          }} />
        </>
      )}

      {/* Draggable strip — a fixed-width band in the CENTER of the top edge.
          Fixed insets (not %) guarantee the close button in the top-left
          corner is never inside the drag region, even on narrow windows where
          a percentage inset would creep over it and eat its clicks. */}
      <div aria-hidden onClick={(e) => e.stopPropagation()} style={{
        position: 'absolute', top: 0, left: 160, right: 160, height: 52, WebkitAppRegion: 'drag', zIndex: 4,
      }} />

      {/* Close — top-right circular glass button. Frameless window (no native
          OS controls), so the corner is free. Stays clickable even after the
          chrome idle-hides: opacity fades for clean viewing but pointer events
          remain, and hovering (or any movement) wakes the controls. */}
      <button type="button"
        onClick={(e) => { e.stopPropagation(); onClose?.(); }}
        onMouseEnter={(e) => {
          bumpActivity();
          e.currentTarget.style.background = `rgba(${accent}, 0.9)`;
          e.currentTarget.style.borderColor = `rgba(${accent}, 0.95)`;
          e.currentTarget.style.color = '#fff';
          e.currentTarget.style.transform = 'scale(1.06)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'rgba(255,255,255,0.07)';
          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.16)';
          e.currentTarget.style.color = 'rgba(255,255,255,0.82)';
          e.currentTarget.style.transform = idle ? 'scale(0.9)' : 'scale(1)';
        }}
        title="Close (Esc)" aria-label="Close fullscreen"
        style={{
          position: 'absolute', top: 18, right: 18, zIndex: 5, WebkitAppRegion: 'no-drag',
          width: 38, height: 38, borderRadius: 999, padding: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.16)',
          color: 'rgba(255,255,255,0.82)', cursor: 'pointer',
          backdropFilter: 'blur(18px) saturate(1.4)', WebkitBackdropFilter: 'blur(18px) saturate(1.4)',
          boxShadow: '0 6px 22px rgba(0,0,0,0.4)',
          // Idle fades the button out for distraction-free art, but it never
          // stops accepting clicks — any pointer movement re-reveals it.
          opacity: idle ? 0 : 1,
          pointerEvents: 'auto',
          transform: idle ? 'scale(0.9)' : 'scale(1)',
          transition: 'opacity 0.4s ease, transform 0.3s cubic-bezier(0.16,1,0.3,1), background 0.18s ease, border-color 0.18s ease, color 0.18s ease',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6 6 18" /><path d="M6 6l12 12" />
        </svg>
      </button>


      {/* Content: rail + (optional) lyrics centerpiece */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative', zIndex: 2, cursor: 'default',
          display: 'flex', alignItems: 'stretch', justifyContent: 'center',
          width: 'auto', height: 'auto',
          maxWidth: '100vw',
          gap: sideLyrics ? 'clamp(20px, 3.5vw, 56px)' : 0,
        }}
      >
        {centeredMode ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 28, padding: '40px 36px', width: '100%', maxWidth: 'min(66vw, 780px)', minWidth: 0,
          }}>
            {centeredHeader}
            {/* Lyrics and search card share this stage: lyrics gently scale
                back and yield while the card is up, then breathe back in. */}
            <div style={{ position: 'relative', width: '100%', height: 'min(56vh, 58vw)' }}>
              <div style={{
                position: 'absolute', inset: 0,
                display: 'flex', flexDirection: 'column', justifyContent: 'center',
                opacity: libraryOpen ? 0 : 1,
                transform: libraryOpen ? 'scale(0.975)' : 'scale(1)',
                transition: reduceMotion ? 'none' : 'opacity 300ms ease, transform 420ms cubic-bezier(0.3, 0.7, 0.25, 1)',
                pointerEvents: libraryOpen ? 'none' : 'auto',
                animation: reduceMotion ? 'none' : 'immerseFullscreenLyricsIn 360ms ease-out both',
                animationDelay: '80ms',
              }}>
                {lyricsEditing && onSaveLyricsEdited && editableTrack ? (
                  <LyricsEditor
                  track={editableTrack}
                  currentTime={currentTime}
                  existingSynced={lyricsData?.synced || []}
                  existingPlain={lyricsData?.plain || ''}
                  accent={accent}
                  onSeek={onSeek}
                  onSave={(newSynced, newPlain) => { onSaveLyricsEdited(newSynced, newPlain); setLyricsEditing(false); }}
                  onCancel={() => setLyricsEditing(false)}
                />
                ) : hasSyncedLyrics ? (
                  <SyncedLyrics lines={lyricsData.synced} currentTime={currentTime} accent={accent} onSeek={onSeek} fontSize={21} lineHeight={1.55}
                    selection={lyricSel} onSelectStart={handleFsSelectStart} onSelectLine={handleFsSelectExtend} />
                ) : (
                  <PlainLyrics text={lyricsData.plain} fontSize={20} lineHeight={1.7} accent={accent}
                    selection={lyricSel} onSelectStart={handleFsSelectStart} onSelectLine={handleFsSelectExtend} />
                )}
              </div>
              {(libraryOpen || cardExiting) ? (
                <div style={{
                  // Centering via flexbox rather than translate(-50%, -50%):
                  // transforms aren't snapped to the device-pixel grid, so a
                  // half-pixel from -50% on an odd-sized card blurs ALL the text
                  // inside it. Flex/layout centering IS pixel-snapped → crisp.
                  // Only the (integer-rounded) drag offset rides on a transform.
                  position: 'absolute', inset: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  pointerEvents: 'none',
                }}>
                  <div style={{
                    position: 'relative',
                    transform: `translate(${Math.round(cardOffset.x + CC_NUDGE)}px, ${Math.round(cardOffset.y)}px)`,
                    transition: cardDragRef.current ? 'none' : 'transform 280ms cubic-bezier(0.2, 0.8, 0.2, 1)',
                    width: cardSize ? Math.min(cardSize.w, window.innerWidth - 130) : 'min(460px, 92%)',
                    height: cardSize ? Math.min(cardSize.h, window.innerHeight - 60) : 'min(100%, 540px)',
                    pointerEvents: 'auto',
                  }}>
                    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                      {commandMenu}
                      {libraryCard}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : (<>
        {rail}
        {sideLyrics ? (
          <div className="fs-lyrcol" style={{
            // Chrome-free lyrics column: same height as the cover, floating
            // text only — no panel, no border, no frost.
            width: 'min(36vw, 460px)', height: 'min(52vh, 42vw)',
            alignSelf: 'center', minWidth: 0, position: 'relative',
            display: 'flex', flexDirection: 'column',
            animation: reduceMotion ? 'none' : 'immerseFullscreenLyricsIn 360ms ease-out both',
            animationDelay: '80ms',
            transform: dockCard ? 'translateY(-86px)' : 'translateY(0)',
            transition: reduceMotion ? 'none' : 'transform 360ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}>
            {(onSaveLyricsEdited || onPickLyrics) && !libraryOpen && !lyricsEditing ? (
              <LyricTools
                onEdit={onSaveLyricsEdited ? () => setLyricsEditing(true) : null}
                onBrowse={onPickLyrics ? () => setLyricsPickReq((n) => n + 1) : null}
              />
            ) : null}
            {/* Relocated cover + song info — the ghost's landing pad while
                search is open. The slot below is ALWAYS mounted; only its
                height animates (flight curve), so the lyrics never pop. */}
            <div style={{
              height: libraryOpen ? MINI_HEADER_H : 0,
              transition: reduceMotion ? 'none' : 'height 420ms cubic-bezier(0.3, 0.7, 0.25, 1)',
              // hidden: during the height animation the absolute header used
              // to paint OVER whatever sat beneath the slot (worst with no
              // lyrics, where it overlapped the card). Clipping to the slot
              // keeps the reveal tied to the geometry; the arriving ghost is
              // position:fixed so it's never clipped, and the text starts
              // only after the slot is fully grown.
              overflow: 'hidden', flexShrink: 0, position: 'relative',
            }}>
              {/* Permanently mounted: the artwork stays decoded and the
                  text animations retrigger via name changes, never via
                  remount. Hidden (not unmounted) when search is closed. */}
              <div style={{
                position: 'absolute', top: 0, left: 0, right: 0,
                visibility: (libraryOpen || coverInFlight) ? 'visible' : 'hidden',
                pointerEvents: libraryOpen ? 'auto' : 'none',
              }}>{miniHeader}</div>
            </div>
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              {lyricsEditing && onSaveLyricsEdited && editableTrack ? (
                <LyricsEditor
                  track={editableTrack}
                  currentTime={currentTime}
                  existingSynced={lyricsData?.synced || []}
                  existingPlain={lyricsData?.plain || ''}
                  accent={accent}
                  onSeek={onSeek}
                  onSave={(newSynced, newPlain) => { onSaveLyricsEdited(newSynced, newPlain); setLyricsEditing(false); }}
                  onCancel={() => setLyricsEditing(false)}
                />
              ) : hasSyncedLyrics ? (
                <SyncedLyrics lines={lyricsData.synced} currentTime={currentTime} accent={accent} onSeek={onSeek} fontSize={20} lineHeight={1.5}
                  selection={lyricSel} onSelectStart={handleFsSelectStart} onSelectLine={handleFsSelectExtend} />
              ) : (
                <PlainLyrics text={lyricsData.plain} fontSize={19} lineHeight={1.7} accent={accent}
                  selection={lyricSel} onSelectStart={handleFsSelectStart} onSelectLine={handleFsSelectExtend} />
              )}
            </div>
          </div>
        ) : null}
        </>)}
      </div>

      {/* Dock cards — Credits + Up next. Tabs peek from behind the dock's
          top edge (they sit at zIndex 3, the dock at 4, so their lower half
          is tucked underneath). Clicking a tab raises its glass panel. They
          ride the same idle fade as the dock. */}
      {!libraryOpen ? (
        <div onClick={(e) => e.stopPropagation()} style={{
          position: 'absolute', left: 0, right: 0, bottom: 22, zIndex: 3,
          display: 'flex', justifyContent: 'center', pointerEvents: 'none',
          ...barFade,
        }}>
          <div style={{ width: 'min(690px, 94vw)', position: 'relative', height: 0 }}>
            <DockCard side="left" label="Credits" open={dockCard === 'credits'} accent={accent} layout="wrap" dockBarH={dockBarH}
              meta={creditsData?.state === 'ok'
                ? `via Genius${creditsData.credits.releaseDate ? ` · ${creditsData.credits.releaseDate}` : ''}`
                : null}
              onToggle={() => setDockCard((c) => (c === 'credits' ? null : 'credits'))}>
                {(!creditsData || creditsData.state === 'loading') ? (
                  <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, color: 'rgba(255,255,255,0.5)', animation: 'immerseFullscreenIn 0.9s ease infinite alternate' }}>
                    Looking up credits…
                  </div>
                ) : creditsData.state === 'unavailable' ? (
                  <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, color: 'rgba(255,255,255,0.5)', lineHeight: 1.5 }}>
                    Credits need the Genius module — see geniusCredits.js + main.js.
                  </div>
                ) : creditsData.state === 'none' ? (
                  <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, color: 'rgba(255,255,255,0.5)' }}>
                    No credits found for this track.
                  </div>
                ) : (
                  <>
                    {creditsData.credits.primary?.length ? (
                      <CreditGroup label="Performed by" names={creditsData.credits.primary} accent={accent} />
                    ) : null}
                    {creditsData.credits.writers?.length ? (
                      <CreditGroup label="Written by" names={creditsData.credits.writers} accent={accent} />
                    ) : null}
                    {creditsData.credits.producers?.length ? (
                      <CreditGroup label="Produced by" names={creditsData.credits.producers} accent={accent} />
                    ) : null}
                    {(creditsData.credits.performances || []).slice(0, 3).map((p, i) => (
                      <CreditGroup key={p.label} label={p.label} names={p.names} accent={accent}
                        style={i === 0 ? { gridColumnStart: 1 } : undefined} />
                    ))}
                  </>
                )}
            </DockCard>
            <DockCard side="right" label={upNext.length ? `Up next · ${upNext.length}` : 'Up next'} open={dockCard === 'queue'} accent={accent} dockBarH={dockBarH}
              onToggle={() => setDockCard((c) => (c === 'queue' ? null : 'queue'))}>
                {upNext.length ? upNext.slice(0, 30).map((t, i) => (
                  <div
                    key={`${t.id}-${i}`}
                    role="button"
                    tabIndex={-1}
                    title={`${t.title || 'Unknown'} — ${t.artist || ''}`}
                    onClick={() => onSelectTrack?.(t)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '3px 8px 3px 4px', borderRadius: 9, cursor: 'pointer', minWidth: 0,
                      transition: 'background 0.13s ease',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{ width: 16, textAlign: 'right', flexShrink: 0, fontSize: 9.5, color: 'rgba(255,255,255,0.32)', fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
                    <div style={{
                      width: 32, height: 32, borderRadius: 7, flexShrink: 0,
                      backgroundColor: 'rgba(255,255,255,0.06)',
                      backgroundImage: t.coverArt ? `url("${String(t.coverArt).replace(/"/g, '%22')}")` : 'none',
                      backgroundSize: 'cover', backgroundPosition: 'center',
                      boxShadow: '0 0 0 1px rgba(255,255,255,0.08)',
                    }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 11.5, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title || 'Unknown track'}</div>
                      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.artist || ''}</div>
                    </div>
                  </div>
                )) : (
                  <div style={{ gridRow: '1 / -1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, color: 'rgba(255,255,255,0.5)', minWidth: 220 }}>
                    Nothing queued after this track.
                  </div>
                )}
                {upNext.length > 30 ? (
                  <div style={{ display: 'flex', alignItems: 'center', padding: '3px 8px', fontSize: 10.5, color: 'rgba(255,255,255,0.4)', whiteSpace: 'nowrap' }}>
                    +{upNext.length - 30} more in queue
                  </div>
                ) : null}
            </DockCard>
          </div>
        </div>
      ) : null}

      {/* Floating control dock — compact frosted pill. A 1fr/auto/1fr grid
          keeps the seek bar dead-center regardless of how wide the transport
          and volume clusters are. Buttons are dock-scale (28px), not the
          56px now-playing-page media buttons. */}
      <div onClick={(e) => e.stopPropagation()} style={{
        position: 'absolute', left: 0, right: 0, bottom: 22, zIndex: 4,
        display: 'flex', justifyContent: 'center',
        ...barFade,
      }}>
        <div ref={dockBarRef} style={{
          display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 14,
          width: 'min(690px, 94vw)',
          padding: '8px 16px', borderRadius: 16,
          background: 'rgba(18,18,20,0.62)',
          backdropFilter: 'blur(30px) saturate(1.6)',
          WebkitBackdropFilter: 'blur(30px) saturate(1.6)',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.07)',
        }}>
          {/* Transport — compact */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, justifySelf: 'start' }}>
            <FsDockBtn onClick={onToggleShuffle} title="Shuffle" active={shuffleOn}>
              <Shuffle size={15} strokeWidth={2} />
            </FsDockBtn>
            <FsDockBtn onClick={onPrev} title="Previous">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 4L7 12l10 8" />
              </svg>
            </FsDockBtn>
            <FsDockBtn onClick={onTogglePlay} title={isPlaying ? 'Pause' : 'Play'} emphasized>
              {isPlaying ? (
                <svg width="21" height="21" viewBox="0 0 32 32" fill="currentColor" stroke="none">
                  <rect x="10.5" y="7" width="4" height="18" rx="2" />
                  <rect x="17.5" y="7" width="4" height="18" rx="2" />
                </svg>
              ) : (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="none" style={{ marginLeft: 1 }}>
                  <path d="M8 5.6c-1.4-1-3.5 0-3.5 1.7v9.4c0 1.75 2.1 2.75 3.5 1.7l8-5c1.4-.85 1.4-2.65 0-3.5l-8-4.3z" />
                </svg>
              )}
            </FsDockBtn>
            <FsDockBtn onClick={onNext} title="Next">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 4l10 8-10 8" />
              </svg>
            </FsDockBtn>
            <FsDockBtn onClick={onToggleRepeat} title={`Repeat: ${repeat}`} active={repeat !== 'off'}>
              {repeat === 'one' ? (
                <Repeat1 size={15} strokeWidth={2} />
              ) : (
                <Repeat size={15} strokeWidth={2} />
              )}
            </FsDockBtn>
          </div>

          {/* Seek — dead-center */}
          <div style={{ width: 'clamp(190px, 26vw, 260px)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 10, fontVariantNumeric: 'tabular-nums', minWidth: 30, textAlign: 'right', flexShrink: 0 }}>{formatTime(currentTime)}</span>
            <HeartSlider value={currentTime} max={duration || 0} onChange={(v) => onSeek?.(v)} accent={accent} ariaLabel="Seek" thumbSize={11} thumbShape={nowPlayingSliderStyle} />
            <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 10, fontVariantNumeric: 'tabular-nums', minWidth: 30, flexShrink: 0 }}>{formatTime(duration)}</span>
          </div>

          {/* Volume — right */}
          {onSetVolume ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, justifySelf: 'end' }}>
              <FsDockBtn onClick={() => onSetVolume?.(volume > 0 ? 0 : 1)} title={volume > 0 ? 'Mute (M)' : 'Unmute (M)'}>
                {volume <= 0 ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 5L6 9H2v6h4l5 4V5z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" />
                  </svg>
                ) : volume < 0.5 ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 5L6 9H2v6h4l5 4V5z" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 5L6 9H2v6h4l5 4V5z" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  </svg>
                )}
              </FsDockBtn>
              <div style={{ width: 72, display: 'flex' }}>
                <HeartSlider value={volume} max={1} onChange={(v) => onSetVolume?.(v)} accent={accent} ariaLabel="Volume" thumbSize={10} thumbShape={nowPlayingSliderStyle} />
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Cover ghost — a single fixed element flying the artwork between
          the rail square and the relocated header (both directions). The
          real covers hide underneath it, so what the eye sees is ONE cover
          gliding, shrinking, and rounding off — then the ghost evaporates
          exactly on its landing pad. */}
      {coverGhost ? (
        <div
          aria-hidden
          onTransitionEnd={(e) => {
            if (e.propertyName !== 'left' && e.propertyName !== 'top') return;
            // Verified landing. Prediction kept losing to reality when the
            // card had been dragged — so at touchdown, measure where the
            // destination ACTUALLY is right now (flight over, layout
            // settled, measurement trivially correct). Off by more than a
            // pixel? Glide the difference in a short settle hop instead of
            // letting the swap snap. Two-phase max, then release.
            setCoverGhost((g) => {
              if (!g) return null;
              if (g.settle) return null; // settle hop finished — swap
              const dstEl = g.opening ? miniCoverRef.current : bigCoverRef.current;
              const m = dstEl ? dstEl.getBoundingClientRect() : null;
              if (!m || !m.width) return null;
              const drift = Math.abs(m.left - g.to.left) + Math.abs(m.top - g.to.top)
                + Math.abs(m.width - g.to.width);
              if (drift < 1.5) return null; // landed true — swap
              return { ...g, settle: true, to: { left: m.left, top: m.top, width: m.width, height: m.height } };
            });
          }}
          style={{
            position: 'fixed', zIndex: 8, pointerEvents: 'none',
            left: Math.round((ghostFlying ? coverGhost.to : coverGhost.from).left),
            top: Math.round((ghostFlying ? coverGhost.to : coverGhost.from).top),
            width: Math.round((ghostFlying ? coverGhost.to : coverGhost.from).width),
            height: Math.round((ghostFlying ? coverGhost.to : coverGhost.from).height),
            borderRadius: ghostFlying ? coverGhost.radiusTo : coverGhost.radiusFrom,
            backgroundColor: '#111',
            backgroundImage: coverUrl ? `url("${coverUrl.replace(/"/g, '%22')}")` : 'none',
            backgroundSize: 'cover', backgroundPosition: 'center',
            // Direction-aware: the shadow morphs from the SOURCE cover's
            // style to the DESTINATION's — big → soft on the way up, soft →
            // big on the way home — so both handoffs are seamless.
            boxShadow: (() => {
              const bigS = `0 24px 70px rgba(0,0,0,0.55), 0 0 0 1px rgba(${accent},0.4), inset 0 0 0 1px rgba(255,255,255,0.22)`;
              const miniS = `0 0 0 1px rgba(${accent},0.4), inset 0 0 0 1px rgba(255,255,255,0.22)`;
              if (coverGhost.opening) return ghostFlying ? miniS : bigS;
              return ghostFlying ? bigS : miniS;
            })(),
            transition: (coverGhost.settle
              ? ['left', 'top', 'width', 'height', 'border-radius']
                  .map((p) => `${p} 130ms cubic-bezier(0.25, 0.6, 0.3, 1)`)
              : [
                'left 420ms cubic-bezier(0.3, 0.7, 0.25, 1)',
                'top 420ms cubic-bezier(0.3, 0.7, 0.25, 1)',
                'width 420ms cubic-bezier(0.3, 0.7, 0.25, 1)',
                'height 420ms cubic-bezier(0.3, 0.7, 0.25, 1)',
                'border-radius 420ms cubic-bezier(0.3, 0.7, 0.25, 1)',
                'box-shadow 420ms ease',
              ]).join(', '),
          }}
        />
      ) : null}

      {/* Lyric selection action bar — fullscreen glass, bottom center. */}
      {lyricSel ? (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            // Top-center: the bottom band belongs to the now-playing
            // controls and dock — the selection bar must never cover them.
            position: 'fixed', left: '50%', top: 26, transform: 'translateX(-50%)',
            zIndex: 6, display: 'flex', alignItems: 'center', gap: 12,
            padding: '10px 12px 10px 16px', borderRadius: 14,
            background: 'rgba(16,16,20,0.72)',
            border: '1px solid rgba(255,255,255,0.09)',
            backdropFilter: 'blur(26px)', WebkitBackdropFilter: 'blur(26px)',
            boxShadow: '0 12px 44px rgba(0,0,0,0.55)',
            animation: reduceMotion ? 'none' : 'immerseFullscreenLyricsIn 200ms ease-out',
          }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.7)', fontVariantNumeric: 'tabular-nums' }}>
            {lyricSel.end - lyricSel.start + 1} line{lyricSel.end - lyricSel.start === 0 ? '' : 's'} selected
          </span>
          <button type="button"
            onClick={() => setLyricShareRunning(true)}
            disabled={lyricShareRunning}
            style={{
              padding: '7px 16px', borderRadius: 10, border: `1px solid rgba(${accent},0.45)`,
              background: `rgba(${accent},0.3)`, color: '#fff',
              fontSize: 12, fontWeight: 700, cursor: lyricShareRunning ? 'default' : 'pointer',
              opacity: lyricShareRunning ? 0.6 : 1,
            }}>
            {lyricShareRunning ? 'Copying\u2026' : 'Share'}
          </button>
          <button type="button"
            onClick={clearLyricSel}
            style={{
              padding: '7px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.7)',
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}>
            Cancel
          </button>
        </div>
      ) : null}

      {/* Copy confirmation — sits just above where the action bar was. */}
      {lyricShareNote ? (
        <div style={{
          position: 'fixed', left: '50%', top: 30, transform: 'translateX(-50%)',
          zIndex: 6, padding: '9px 16px', borderRadius: 11,
          fontSize: 12, fontWeight: 700, color: '#fff',
          // Success wears the track's accent (same glass recipe as the
          // action bar, tinted); only failure gets a semantic red.
          background: lyricShareNote.ok
            ? `linear-gradient(rgba(${accent},0.32), rgba(${accent},0.32)), rgba(16,16,20,0.72)`
            : 'rgba(150,42,42,0.88)',
          border: lyricShareNote.ok
            ? `1px solid rgba(${accent},0.45)`
            : '1px solid rgba(255,255,255,0.12)',
          backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
          boxShadow: '0 10px 36px rgba(0,0,0,0.5)',
        }}>
          {lyricShareNote.msg}
        </div>
      ) : null}

      {/* Headless share — rasterize + copy, no interstitial UI (matches the
          dock panel's instant-share flow). */}
      {lyricShareRunning && lyricSel ? (() => {
        let pickedLines = [];
        if (hasSyncedLyrics) {
          pickedLines = (lyricsData?.synced || [])
            .slice(lyricSel.start, lyricSel.end + 1)
            .map((l) => l.text || '');
        } else if (hasPlainLyrics) {
          pickedLines = (lyricsData?.plain || '')
            .split('\n')
            .slice(lyricSel.start, lyricSel.end + 1);
        }
        return (
          <LyricShareOverlay
            headless
            lines={pickedLines}
            track={{ title, artist }}
            coverUrl={coverUrl}
            accent={accent}
            onDone={(ok, msg) => showLyricNote(ok, msg)}
            onClose={clearLyricSel}
          />
        );
      })() : null}

      {/* Stage-view ⋯ menu — edit / remove the playing track or its whole
          album, right from the title. Destructive items arm on first click. */}
      {fsMenu && fsMenu.track ? (() => {
        const menuTrack = fsMenu.track;
        const mates = albumMatesOf(menuTrack);
        const canAlbum = !!onRemoveFromLibrary && (menuTrack.album || '').trim() && mates.length > 1;
        const itemStyle = (danger, armed) => ({
          display: 'flex', alignItems: 'center', gap: 10, width: '100%',
          padding: '8px 12px', border: 'none', cursor: 'pointer', textAlign: 'left',
          borderRadius: 9, fontSize: 12, fontWeight: 600,
          background: armed ? 'rgba(255,90,90,0.18)' : 'transparent',
          color: danger ? (armed ? 'rgb(255,140,140)' : 'rgba(255,150,150,0.9)') : 'rgba(255,255,255,0.88)',
          transition: 'background 0.13s ease',
        });
        return (
          <div
            role="menu"
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: 'fixed', zIndex: 60,
              left: Math.min(fsMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 9999) - 236),
              top: Math.min(fsMenu.y, (typeof window !== 'undefined' ? window.innerHeight : 9999) - (canAlbum ? 150 : 116)),
              width: 224, padding: 6, borderRadius: 14,
              background: 'rgba(16,16,20,0.92)', border: '1px solid rgba(255,255,255,0.12)',
              backdropFilter: 'blur(24px) saturate(1.4)', WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
              boxShadow: '0 16px 50px rgba(0,0,0,0.6)',
            }}
          >
            {onUpdateTrackMetadata ? (
              <button
                type="button"
                style={itemStyle(false, false)}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                onClick={() => { setMetaEditTarget(menuTrack); closeFsMenu(); }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>
                Edit info
              </button>
            ) : null}
            {onRemoveFromLibrary ? (
              <button
                type="button"
                style={itemStyle(true, fsConfirm === 'track')}
                onMouseEnter={(e) => { if (fsConfirm !== 'track') e.currentTarget.style.background = 'rgba(255,90,90,0.1)'; }}
                onMouseLeave={(e) => { if (fsConfirm !== 'track') e.currentTarget.style.background = 'transparent'; }}
                onClick={() => {
                  if (fsConfirm !== 'track') { setFsConfirm('track'); return; }
                  onRemoveFromLibrary([menuTrack.id]);
                  closeFsMenu();
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                {fsConfirm === 'track' ? 'Click again to remove' : 'Remove from library'}
              </button>
            ) : null}
            {canAlbum ? (
              <button
                type="button"
                style={itemStyle(true, fsConfirm === 'album')}
                onMouseEnter={(e) => { if (fsConfirm !== 'album') e.currentTarget.style.background = 'rgba(255,90,90,0.1)'; }}
                onMouseLeave={(e) => { if (fsConfirm !== 'album') e.currentTarget.style.background = 'transparent'; }}
                onClick={() => {
                  if (fsConfirm !== 'album') { setFsConfirm('album'); return; }
                  onRemoveFromLibrary(mates.map((m) => m.id));
                  closeFsMenu();
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.5" /></svg>
                {fsConfirm === 'album' ? `Remove ${mates.length} tracks?` : `Remove album · ${mates.length} tracks`}
              </button>
            ) : null}
          </div>
        );
      })() : null}

      {/* Lyrics editor — edit lines, then tap-to-sync (Space stamps the
          current playback time onto each line as it's sung). The editor
          persists via lyrics:save itself; onSave installs the result in the
          shell's cache so the panel updates instantly. */}
      {lyricsEditing && editableTrack && onSaveLyricsEdited && !sideLyrics && !centeredMode ? (
        <div
          style={{
            position: 'absolute', inset: 0, zIndex: 55,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.55)',
            backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
          }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) setLyricsEditing(false); }}
        >
          <div style={{
            width: 'min(440px, 92vw)', height: 'min(620px, 88vh)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            borderRadius: 16, padding: '4px 8px 8px',
            background: 'rgba(16,16,20,0.92)', border: '1px solid rgba(255,255,255,0.12)',
            boxShadow: `0 24px 70px rgba(0,0,0,0.6), 0 0 0 1px rgba(${accent},0.2)`,
          }}>
            <LyricsEditor
              track={editableTrack}
              currentTime={currentTime}
              existingSynced={lyricsData?.synced || []}
              existingPlain={lyricsData?.plain || ''}
              accent={accent}
              onSeek={onSeek}
              onSave={(newSynced, newPlain) => { onSaveLyricsEdited(newSynced, newPlain); setLyricsEditing(false); }}
              onCancel={() => setLyricsEditing(false)}
            />
          </div>
        </div>
      ) : null}

      {/* Lyrics browser — Immerse's picker, trigger hidden; opens whenever
          lyricsPickReq bumps (panel hover button or the dock button). Its
          modal portals to document.body, above the overlay. */}
      {onPickLyrics && editableTrack ? (
        <LyricsPickerButton
          currentTrack={editableTrack}
          accent={accent}
          visible={false}
          openRequest={lyricsPickReq}
          onApply={onPickLyrics}
          appliedText={lyricsData
            ? (lyricsData.synced?.length
              ? lyricsData.synced.map((l) => l.text).join('\n')
              : (lyricsData.plain || ''))
            : ''}
          appliedId={lyricsData?.lyricId ?? null}
        />
      ) : null}

      {/* Metadata editor — floating glass modal above everything else in the
          overlay, editing the currently playing track without leaving
          fullscreen. Saves flow through the host's onUpdateTrackMetadata
          (same pipeline the library page uses: DB write, tag write, library
          reload, live-queue patch). */}
      {metaEditTarget && onUpdateTrackMetadata ? (
        <MetadataEditor
          track={metaEditTarget}
          accent={accent}
          onSave={async (fields) => {
            const r = await onUpdateTrackMetadata(metaEditTarget.id, fields);
            if (r?.ok) setMetaEditTarget(null);
            return r;
          }}
          onClose={() => setMetaEditTarget(null)}
        />
      ) : null}

      {/* Album-wide metadata editor — same component Immerse's library uses.
          A cover set here also pins as the album's display art. */}
      {albumEditScope && onUpdateAlbumMetadata ? (
        <AlbumMetadataEditor
          scope={albumEditScope}
          accent={accent}
          onSave={async (fields) => {
            const r = await onUpdateAlbumMetadata(albumEditScope.trackIds, fields);
            if (r?.ok) {
              if ('coverArt' in fields && albumEditScope.key) onSetAlbumCover?.(albumEditScope.key, fields.coverArt || null);
              setAlbumEditScope(null);
            }
            return r;
          }}
          onClose={() => setAlbumEditScope(null)}
        />
      ) : null}

      <VideoPicker
        open={!!pick}
        meta={pick?.meta}
        seed={pick?.seed}
        accent={accent}
        pushToast={pushToast}
        onClose={() => setPick(null)}
        onImported={(track) => { if (pick?.dlKey) markDl(pick.dlKey, 'done'); onTrackImported?.(track); }}
      />
    </div>
  );
}


/* =========================================================================
 *  LyricShareOverlay — share a passage of lyrics as a beautifully
 *  composed card. Modelled on iOS / Apple Music's "Share Lyrics" sheet,
 *  re-skinned to match Immerse: blurred cover backdrop, accent-tinted
 *  glass, the cover thumb anchoring the composition, the selected lyric
 *  lines set in a generous editorial type, and a tasteful "immerse"
 *  wordmark in the corner.
 *
 *  Why a dedicated component:
 *    - The export pipeline (serialize to PNG / copy to clipboard / save
 *      to disk) is non-trivial and benefits from being all in one place.
 *    - The card itself is rendered as an SVG with `foreignObject` for
 *      the text. SVG is what we serialize to a PNG via canvas, so the
 *      visible preview and the exported image are by construction the
 *      same pixels.
 *    - Sits at z-index 50, the same layer as CoverFullscreenOverlay,
 *      so neither can be open over the other.
 *
 *  Esc closes. Click outside the card closes. Inside the card, clicks
 *  do nothing (won't accidentally dismiss while interacting with a
 *  button).
 * ========================================================================= */
function LyricShareOverlay({
  lines,
  track,
  coverUrl,
  accent,
  onClose,
  // Headless mode: render NOTHING — just rasterize the card, copy it to
  // the clipboard, report via onDone(ok, message), and close. This is the
  // instant-share path: same pixels as the preview (same rasterizer, same
  // fonts, same layout), zero interstitial UI.
  headless = false,
  onDone,
}) {
  const dialogRef = useRef(null);
  const cardRef = useRef(null);
  useEffect(() => { dialogRef.current?.focus(); }, []);

  // Esc closes the share overlay.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Toast within the overlay — tiny self-contained confirmation, fades
  // out automatically. We don't reach into the app-wide toast bus from
  // here because the overlay is z:50 and would visually sit above any
  // global toasts anyway.
  const [innerToast, setInnerToast] = useState(null);
  const showInner = useCallback((msg) => {
    setInnerToast(msg);
    setTimeout(() => setInnerToast(null), 1800);
  }, []);

  const title = (track?.title || '').trim() || 'Unknown track';
  const artist = (track?.artist || '').trim() || 'Unknown artist';

  // Filter blank lines and keep just the visible ones.
  const trimmed = lines.filter((l) => l && l.trim().length > 0);
  const lineCount = trimmed.length;

  // --- Export helpers ---------------------------------------------------
  // The card is a 1080×1350 portrait (4:5 — IG portrait / Apple Music
  // share-card aspect). Rendering goes through the Canvas 2D API directly,
  // not through SVG `foreignObject`. Reasons:
  //   1. Cover art comes through Immerse's custom `studio-cover://` protocol.
  //      Loading it inside a Blob-URL SVG taints the canvas (silent failure
  //      mode: `canvas.toBlob()` returns null with no error).
  //   2. Browser SVG-to-canvas raster has a long history of fragile edge
  //      cases — `foreignObject` HTML doesn't always paint, embedded
  //      `<image>` doesn't always load, `<filter>` doesn't always render.
  //   3. Canvas 2D wrapping/text/clipping/gradients are all stable in
  //      Electron's Chromium and let us match Apple Music's widget look
  //      pixel-for-pixel.
  const SHARE_W = 1080;
  const SHARE_H = 1350;
  // Safe area for the lyric block — leaves room for the header (cover
  // thumb + title/artist) above and the IMMERSE footer below.
  const TEXT_PADDING_X = 100;          // horizontal inset for lyric column
  const TEXT_AREA_TOP = 360;           // below the header band
  const TEXT_AREA_BOTTOM = SHARE_H - 200; // above the footer band
  const TEXT_AREA_H = TEXT_AREA_BOTTOM - TEXT_AREA_TOP;
  const TEXT_AREA_W = SHARE_W - TEXT_PADDING_X * 2 - 32; // minus accent-bar gutter

  /**
   * Load the cover image into an HTMLImageElement that's drawable to a
   * canvas. Critical detail: we DO NOT use `fetch().then(blob).then(dataURL)`
   * because that path goes through different security plumbing than a
   * direct `<img>` load and can produce a canvas-tainting result for
   * `studio-cover://` URLs. A bare `<img src=...>` with `crossOrigin =
   * 'anonymous'` works because Electron registers `studio-cover` as a
   * standard protocol (see main.js `protocol.handle('studio-cover', ...)`)
   * and the in-renderer load is same-origin from the canvas's POV.
   *
   * Returns null if the cover fails to load, so the rest of the card can
   * still render with a placeholder.
   */
  const loadCoverImage = useCallback(() => {
    return new Promise((resolve) => {
      if (!coverUrl) { resolve(null); return; }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => {
        // Retry without crossOrigin — some custom protocols (file://,
        // studio-cover://) reject the CORS preflight but still load when
        // accessed without it.
        const fallback = new Image();
        fallback.onload = () => resolve(fallback);
        fallback.onerror = (e) => {
          console.warn('cover load failed (both attempts):', e);
          resolve(null);
        };
        fallback.src = coverUrl;
      };
      img.src = coverUrl;
    });
  }, [coverUrl]);

  /**
   * Wrap text into lines that fit a max pixel width, given a measured
   * canvas context. Returns an array of strings (the wrapped lines).
   * Splits on whitespace; doesn't break inside words.
   */
  const wrapTextLine = (ctx, text, maxWidth) => {
    const words = String(text).split(/\s+/).filter(Boolean);
    if (!words.length) return [''];
    const out = [];
    let line = words[0];
    for (let i = 1; i < words.length; i += 1) {
      const probe = `${line} ${words[i]}`;
      if (ctx.measureText(probe).width <= maxWidth) {
        line = probe;
      } else {
        out.push(line);
        line = words[i];
      }
    }
    out.push(line);
    return out;
  };

  /**
   * Pick the largest font size whose wrapped lyric block fits inside the
   * safe area. Measurement uses the same canvas context the rasterizer
   * will use, so the on-screen preview and the export agree.
   */
  const fitFontSize = (ctx) => {
    const candidates = [72, 64, 58, 52, 46, 40, 34, 30, 26, 22, 18];
    for (const size of candidates) {
      ctx.font = `700 ${size}px -apple-system, system-ui, "Segoe UI", Roboto, sans-serif`;
      const lineHeight = size * 1.28;
      const paragraphGap = size * 0.32;
      let totalH = 0;
      for (let i = 0; i < trimmed.length; i += 1) {
        const wrapped = wrapTextLine(ctx, trimmed[i], TEXT_AREA_W);
        totalH += wrapped.length * lineHeight;
        if (i < trimmed.length - 1) totalH += paragraphGap;
      }
      if (totalH <= TEXT_AREA_H) return size;
    }
    return candidates[candidates.length - 1];
  };

  /**
   * Render the share card directly to an offscreen canvas using Canvas
   * 2D primitives. Returns a PNG Blob ready for clipboard write or
   * download. Throws if the canvas operation itself fails.
   */
  const rasterize = useCallback(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = SHARE_W;
    canvas.height = SHARE_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');

    const cover = await loadCoverImage();

    // --- Backdrop --------------------------------------------------
    // The cover, scaled to fill, with a heavy blur on top via stacked
    // canvas filters. Canvas `filter` property supports CSS filters in
    // Chromium / Electron.
    if (cover) {
      ctx.save();
      ctx.filter = 'blur(60px) saturate(1.45) brightness(0.5)';
      // Cover-fit the image, bleeding past the canvas edges so the blur
      // doesn't show seams.
      const scale = Math.max(
        (SHARE_W + 200) / cover.naturalWidth,
        (SHARE_H + 200) / cover.naturalHeight,
      );
      const drawW = cover.naturalWidth * scale;
      const drawH = cover.naturalHeight * scale;
      ctx.drawImage(
        cover,
        (SHARE_W - drawW) / 2,
        (SHARE_H - drawH) / 2,
        drawW, drawH,
      );
      ctx.restore();
    } else {
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, SHARE_W, SHARE_H);
    }

    // --- Vignette (top→bottom darkening) ---------------------------
    const vignette = ctx.createLinearGradient(0, 0, 0, SHARE_H);
    vignette.addColorStop(0, 'rgba(0,0,0,0.32)');
    vignette.addColorStop(0.5, 'rgba(0,0,0,0.5)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.78)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, SHARE_W, SHARE_H);

    // --- Accent glow from bottom-center ----------------------------
    const glow = ctx.createRadialGradient(
      SHARE_W / 2, SHARE_H, 0,
      SHARE_W / 2, SHARE_H, SHARE_H * 0.9,
    );
    glow.addColorStop(0, `rgba(${accent}, 0.45)`);
    glow.addColorStop(0.6, `rgba(${accent}, 0.1)`);
    glow.addColorStop(1, `rgba(${accent}, 0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, SHARE_W, SHARE_H);

    // --- Cover thumb -----------------------------------------------
    const COVER_X = TEXT_PADDING_X;
    const COVER_Y = 130;
    const COVER_SIZE = 130;
    const COVER_RADIUS = 18;
    ctx.save();
    // Rounded-rect clip for the cover.
    const r = COVER_RADIUS;
    ctx.beginPath();
    ctx.moveTo(COVER_X + r, COVER_Y);
    ctx.lineTo(COVER_X + COVER_SIZE - r, COVER_Y);
    ctx.quadraticCurveTo(COVER_X + COVER_SIZE, COVER_Y, COVER_X + COVER_SIZE, COVER_Y + r);
    ctx.lineTo(COVER_X + COVER_SIZE, COVER_Y + COVER_SIZE - r);
    ctx.quadraticCurveTo(COVER_X + COVER_SIZE, COVER_Y + COVER_SIZE, COVER_X + COVER_SIZE - r, COVER_Y + COVER_SIZE);
    ctx.lineTo(COVER_X + r, COVER_Y + COVER_SIZE);
    ctx.quadraticCurveTo(COVER_X, COVER_Y + COVER_SIZE, COVER_X, COVER_Y + COVER_SIZE - r);
    ctx.lineTo(COVER_X, COVER_Y + r);
    ctx.quadraticCurveTo(COVER_X, COVER_Y, COVER_X + r, COVER_Y);
    ctx.closePath();
    ctx.clip();
    if (cover) {
      // Cover-fit the source image into the thumb rect.
      const sScale = Math.max(
        COVER_SIZE / cover.naturalWidth,
        COVER_SIZE / cover.naturalHeight,
      );
      const sW = cover.naturalWidth * sScale;
      const sH = cover.naturalHeight * sScale;
      ctx.drawImage(
        cover,
        COVER_X + (COVER_SIZE - sW) / 2,
        COVER_Y + (COVER_SIZE - sH) / 2,
        sW, sH,
      );
    } else {
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(COVER_X, COVER_Y, COVER_SIZE, COVER_SIZE);
    }
    ctx.restore();

    // --- Title + artist -------------------------------------------
    const META_X = COVER_X + COVER_SIZE + 24;
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '700 34px -apple-system, system-ui, "Segoe UI", Roboto, sans-serif';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 1;
    // Truncate title/artist to fit one line each.
    const maxMetaW = SHARE_W - META_X - TEXT_PADDING_X;
    const fitOneLine = (text, fontSpec) => {
      ctx.font = fontSpec;
      if (ctx.measureText(text).width <= maxMetaW) return text;
      let s = text;
      while (s.length > 1 && ctx.measureText(`${s}…`).width > maxMetaW) {
        s = s.slice(0, -1);
      }
      return `${s}…`;
    };
    ctx.font = '700 34px -apple-system, system-ui, "Segoe UI", Roboto, sans-serif';
    const fittedTitle = fitOneLine(title, ctx.font);
    ctx.fillText(fittedTitle, META_X, COVER_Y + 52);
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.font = '500 26px -apple-system, system-ui, "Segoe UI", Roboto, sans-serif';
    const fittedArtist = fitOneLine(artist, ctx.font);
    ctx.fillText(fittedArtist, META_X, COVER_Y + 92);
    // Reset shadow before drawing further elements that don't want it.
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // --- Accent bar -----------------------------------------------
    const BAR_X = TEXT_PADDING_X;
    const BAR_Y = TEXT_AREA_TOP + 6;
    const BAR_H = TEXT_AREA_H - 12;
    const BAR_W = 6;
    ctx.fillStyle = `rgb(${accent})`;
    // Rounded pill
    ctx.beginPath();
    const rb = BAR_W / 2;
    ctx.moveTo(BAR_X + rb, BAR_Y);
    ctx.lineTo(BAR_X + BAR_W - rb, BAR_Y);
    ctx.quadraticCurveTo(BAR_X + BAR_W, BAR_Y, BAR_X + BAR_W, BAR_Y + rb);
    ctx.lineTo(BAR_X + BAR_W, BAR_Y + BAR_H - rb);
    ctx.quadraticCurveTo(BAR_X + BAR_W, BAR_Y + BAR_H, BAR_X + BAR_W - rb, BAR_Y + BAR_H);
    ctx.lineTo(BAR_X + rb, BAR_Y + BAR_H);
    ctx.quadraticCurveTo(BAR_X, BAR_Y + BAR_H, BAR_X, BAR_Y + BAR_H - rb);
    ctx.lineTo(BAR_X, BAR_Y + rb);
    ctx.quadraticCurveTo(BAR_X, BAR_Y, BAR_X + rb, BAR_Y);
    ctx.closePath();
    ctx.fill();

    // --- Lyric text -----------------------------------------------
    // Pick the largest font that fits, then render the wrapped lines
    // centered vertically inside the safe area.
    const bodyFontPx = fitFontSize(ctx);
    ctx.font = `700 ${bodyFontPx}px -apple-system, system-ui, "Segoe UI", Roboto, sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 2;

    const lineHeight = bodyFontPx * 1.28;
    const paragraphGap = bodyFontPx * 0.32;
    // Pre-wrap so we can vertically center.
    const wrappedParagraphs = trimmed.map((line) => wrapTextLine(ctx, line, TEXT_AREA_W));
    let totalH = 0;
    wrappedParagraphs.forEach((lines2, i) => {
      totalH += lines2.length * lineHeight;
      if (i < wrappedParagraphs.length - 1) totalH += paragraphGap;
    });
    const blockTop = TEXT_AREA_TOP + (TEXT_AREA_H - totalH) / 2;
    const textX = BAR_X + BAR_W + 26;
    let cursorY = blockTop + lineHeight * 0.8; // alphabetic baseline offset
    wrappedParagraphs.forEach((lines2, pIdx) => {
      lines2.forEach((ln) => {
        ctx.fillText(ln, textX, cursorY);
        cursorY += lineHeight;
      });
      if (pIdx < wrappedParagraphs.length - 1) cursorY += paragraphGap;
    });
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // --- Footer: IMMERSE wordmark + accent orb ---------------------
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '600 22px -apple-system, system-ui, "Segoe UI", Roboto, sans-serif';
    // Letter-spaced uppercase wordmark. Canvas 2D has no letter-spacing,
    // so we draw glyph-by-glyph with a manual tracking offset.
    const wordmark = 'IMMERSE';
    const trackPx = 13; // approximates 0.6em letter-spacing at this size
    let wx = TEXT_PADDING_X;
    const wy = SHARE_H - 90;
    for (const ch of wordmark) {
      ctx.fillText(ch, wx, wy);
      wx += ctx.measureText(ch).width + trackPx;
    }
    // Accent orb — three concentric circles, smallest filled, two outer
    // rings stroked at reducing opacities for the radar / sound-wave feel.
    const orbX = SHARE_W - 115;
    const orbY = SHARE_H - 100;
    ctx.beginPath();
    ctx.arc(orbX, orbY, 30, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${accent}, 0.18)`;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(orbX, orbY, 22, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${accent}, 0.35)`;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(orbX, orbY, 14, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${accent}, 0.85)`;
    ctx.fill();

    // --- Export ----------------------------------------------------
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('canvas.toBlob returned null (canvas may be tainted)'));
      }, 'image/png', 0.95);
    });
  }, [accent, title, artist, trimmed, loadCoverImage, fitFontSize, wrapTextLine,
      SHARE_W, SHARE_H, TEXT_AREA_TOP, TEXT_AREA_H, TEXT_AREA_W, TEXT_PADDING_X]);

  const handleShareWithFriends = useCallback(async () => {
    try {
      const blob = await rasterize();
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
        throw new Error('ClipboardItem not supported');
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showInner('Image copied — paste in any chat');
    } catch (err) {
      console.error('share with friends failed:', err);
      const msg = /denied|permission|notallowed/i.test(String(err?.message || err))
        ? 'Clipboard blocked'
        : 'Copy failed';
      showInner(msg);
    }
  }, [rasterize, showInner]);

  // Headless auto-run: copy on mount, exactly once (ref-guarded against
  // StrictMode double-invoke and rasterize identity churn).
  const headlessRanRef = useRef(false);
  useEffect(() => {
    if (!headless || headlessRanRef.current) return;
    headlessRanRef.current = true;
    (async () => {
      try {
        const blob = await rasterize();
        if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
          throw new Error('ClipboardItem not supported');
        }
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        onDone?.(true, 'Lyric card copied — paste it anywhere');
      } catch (err) {
        console.error('headless lyric share failed:', err);
        const msg = /denied|permission|notallowed/i.test(String(err?.message || err))
          ? 'Clipboard blocked by the system'
          : 'Could not copy the lyric card';
        onDone?.(false, msg);
      } finally {
        onClose?.();
      }
    })();
  }, [headless, rasterize, onClose, onDone]);

  if (headless) return null;

  // --- Render ----------------------------------------------------------
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Share lyric"
      tabIndex={-1}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: 'clamp(12px, 3vmin, 28px)',
        background: '#000',
        cursor: 'zoom-out',
        animation: 'immerseFullscreenIn 220ms ease-out',
        outline: 'none',
        overflow: 'auto',
      }}
    >
      <style>{`
        @keyframes immerseShareCardIn {
          0%   { opacity: 0; transform: scale(0.96) translateY(8px); }
          100% { opacity: 1; transform: none; }
        }
        @keyframes immerseShareToastIn {
          0%   { opacity: 0; transform: translate(-50%, 12px); }
          100% { opacity: 1; transform: translate(-50%, 0); }
        }
      `}</style>

      {/* Blurred cover backdrop — identical technique to CoverFullscreenOverlay. */}
      {coverUrl ? (
        <div
          aria-hidden
          style={{
            position: 'absolute', inset: -80,
            backgroundImage: `url(${coverUrl})`,
            backgroundSize: 'cover', backgroundPosition: 'center',
            filter: 'blur(80px) saturate(1.45) brightness(0.5)',
            opacity: 0.85,
            pointerEvents: 'none',
          }}
        />
      ) : null}
      <div
        aria-hidden
        style={{
          position: 'absolute', inset: 0,
          background: `radial-gradient(ellipse at center, rgba(0,0,0,0) 0%, rgba(0,0,0,0.55) 100%),
                       radial-gradient(ellipse at 50% 90%, rgba(${accent},0.25) 0%, rgba(${accent},0) 60%)`,
          pointerEvents: 'none',
        }}
      />

      {/* Close — top-left so it does not overlap the window close button (top-right). */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onClose?.(); }}
        title="Close (Esc)"
        aria-label="Close"
        style={{
          position: 'absolute', top: 16, left: 16, zIndex: 2,
          WebkitAppRegion: 'no-drag',
          width: 36, height: 36, borderRadius: 999,
          background: 'rgba(0,0,0,0.55)',
          border: '1px solid rgba(255,255,255,0.14)',
          color: 'rgba(255,255,255,0.85)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
          backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.8)'; e.currentTarget.style.color = '#fff'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.55)'; e.currentTarget.style.color = 'rgba(255,255,255,0.85)'; }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      <div
        ref={cardRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative', zIndex: 1,
          width: 'min(440px, calc((100vh - 200px) * 0.8))',
          aspectRatio: '4 / 5',
          borderRadius: 22, overflow: 'hidden',
          boxShadow: `0 32px 120px rgba(0,0,0,0.65), 0 0 0 1px rgba(${accent},0.4), 0 0 60px rgba(${accent},0.12)`,
          background: '#111',
          animation: 'immerseShareCardIn 320ms cubic-bezier(0.2, 0.7, 0.2, 1)',
          cursor: 'default',
          containerType: 'inline-size',
        }}
      >
        {/* Backdrop layer of the card itself — same cover, blurred. */}
        {coverUrl ? (
          <div
            aria-hidden
            style={{
              position: 'absolute', inset: -40,
              backgroundImage: `url(${coverUrl})`,
              backgroundSize: 'cover', backgroundPosition: 'center',
              filter: 'blur(60px) saturate(1.4) brightness(0.55)',
            }}
          />
        ) : (
          <div aria-hidden style={{ position: 'absolute', inset: 0, background: '#0a0a0a' }} />
        )}
        {/* Vignette + accent glow */}
        <div
          aria-hidden
          style={{
            position: 'absolute', inset: 0,
            background: `linear-gradient(180deg, rgba(0,0,0,0.32) 0%, rgba(0,0,0,0.5) 60%, rgba(0,0,0,0.78) 100%),
                         radial-gradient(ellipse at 50% 95%, rgba(${accent},0.45) 0%, rgba(${accent},0) 65%)`,
          }}
        />

        <div style={{
          position: 'absolute',
          top: '9.6%', left: '9.2%', right: '9.2%',
          display: 'flex', alignItems: 'center', gap: '4%',
        }}>
          <div style={{
            width: '26%', aspectRatio: '1',
            borderRadius: 12, overflow: 'hidden',
            background: '#1a1a1a', flexShrink: 0,
            boxShadow: '0 2px 14px rgba(0,0,0,0.55)',
          }}>
            {coverUrl ? (
              <img src={coverUrl} alt="" draggable={false}
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            ) : (
              <div style={{
                width: '100%', height: '100%', display: 'flex',
                alignItems: 'center', justifyContent: 'center', color: '#444',
              }}>
                <Icons.AlbumSidebar />
              </div>
            )}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{
              fontSize: 'clamp(15px, 3.3cqi, 20px)', fontWeight: 700, color: '#fff',
              letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              textShadow: '0 1px 8px rgba(0,0,0,0.6)',
            }}>
              {title}
            </div>
            <div style={{
              marginTop: 3,
              fontSize: 'clamp(12px, 2.6cqi, 15px)', color: 'rgba(255,255,255,0.72)', fontWeight: 500,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              textShadow: '0 1px 8px rgba(0,0,0,0.6)',
            }}>
              {artist}
            </div>
          </div>
        </div>

        <div style={{
          position: 'absolute',
          top: '27%', bottom: '15%',
          left: '9.2%', right: '9.2%',
          display: 'flex',
          gap: '4%',
        }}>
          <div style={{
            width: 5, borderRadius: 999,
            background: `rgb(${accent})`,
            boxShadow: `0 0 16px rgba(${accent},0.7)`,
            flexShrink: 0,
          }} />
          <div style={{
            flex: 1, minWidth: 0,
            display: 'flex', flexDirection: 'column', justifyContent: 'center',
            fontSize: (() => {
              if (lineCount <= 1) return 'clamp(28px, 8.2cqi, 56px)';
              if (lineCount <= 2) return 'clamp(24px, 7.2cqi, 48px)';
              if (lineCount <= 4) return 'clamp(20px, 6cqi, 40px)';
              if (lineCount <= 6) return 'clamp(17px, 5cqi, 32px)';
              if (lineCount <= 8) return 'clamp(15px, 4.2cqi, 28px)';
              return 'clamp(13px, 3.5cqi, 22px)';
            })(),
            fontWeight: 700, lineHeight: 1.28, color: '#fff',
            letterSpacing: '-0.015em',
            textShadow: '0 2px 18px rgba(0,0,0,0.5)',
            wordBreak: 'normal',
            overflowWrap: 'break-word',
          }}>
            {trimmed.map((line, i) => (
              <div key={i} style={{ marginBottom: i < trimmed.length - 1 ? '0.32em' : 0 }}>
                {line}
              </div>
            ))}
          </div>
        </div>

        <div style={{
          position: 'absolute', left: '9.2%', right: '9.2%',
          bottom: '7%',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <div style={{
            fontSize: 'clamp(10px, 2.2cqi, 14px)', fontWeight: 600,
            color: 'rgba(255,255,255,0.6)',
            letterSpacing: '0.55em', textTransform: 'uppercase',
          }}>
            IMMERSE
          </div>
          <div style={{ position: 'relative', width: 'clamp(28px, 7cqi, 38px)', aspectRatio: '1', flexShrink: 0 }}>
            <div style={{
              position: 'absolute', inset: 0, borderRadius: '50%',
              border: `2px solid rgba(${accent},0.18)`,
            }} />
            <div style={{
              position: 'absolute', inset: 4, borderRadius: '50%',
              border: `2px solid rgba(${accent},0.35)`,
            }} />
            <div style={{
              position: 'absolute', inset: 9, borderRadius: '50%',
              background: `rgba(${accent},0.85)`,
              boxShadow: `0 0 12px rgba(${accent},0.6)`,
            }} />
          </div>
        </div>
      </div>

      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative', zIndex: 1,
          marginTop: 'clamp(16px, 3vmin, 24px)',
          cursor: 'default',
        }}
      >
        <ShareActionButton
          accent={accent}
          primary
          onClick={handleShareWithFriends}
          label="Share with friends"
          icon={(
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
            </svg>
          )}
        />
      </div>

      {/* Inner toast — confirms a copy/save action. */}
      {innerToast ? (
        <div
          style={{
            position: 'fixed',
            left: '50%', bottom: 'clamp(40px, 8vmin, 80px)',
            transform: 'translateX(-50%)',
            padding: '10px 18px', borderRadius: 999,
            background: 'rgba(20,20,22,0.92)',
            border: `1px solid rgba(${accent},0.4)`,
            backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)',
            color: '#fff', fontSize: 12, fontWeight: 600,
            boxShadow: '0 8px 28px rgba(0,0,0,0.55)',
            zIndex: 3, pointerEvents: 'none',
            animation: 'immerseShareToastIn 220ms ease-out',
          }}
        >
          {innerToast}
        </div>
      ) : null}
    </div>
  );
}

/** ShareActionButton — small glass pill used in the LyricShareOverlay
 *  action bar. Two variants: standard (subtle glass) and primary (accent
 *  fill, used for the headline action). Hovers brighten predictably. */
function ShareActionButton({ icon, label, onClick, accent, primary = false }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 16px', borderRadius: 999,
        border: primary
          ? `1px solid rgba(${accent},${hover ? 0.7 : 0.55})`
          : `1px solid rgba(255,255,255,${hover ? 0.18 : 0.1})`,
        background: primary
          ? `rgba(${accent},${hover ? 0.42 : 0.32})`
          : `rgba(20,20,22,${hover ? 0.85 : 0.7})`,
        backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
        color: '#fff', fontSize: 12, fontWeight: 700, letterSpacing: '0.01em',
        cursor: 'pointer',
        boxShadow: primary
          ? `0 6px 22px rgba(${accent},0.35)`
          : '0 4px 14px rgba(0,0,0,0.35)',
        transition: 'background 0.15s, border-color 0.15s, transform 0.1s',
        transform: hover ? 'translateY(-1px)' : 'translateY(0)',
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}


/* =========================================================================
 *  EdgeBleedBand — thin gradient strip at the bottom of the immersive
 *  stage, tinted with the playing track's accent colour. Like the cover
 *  is "leaking light" into the bottom of the room.
 *
 *  Fixed-position so it sits above the gradient field but below the dock
 *  pill and side panel. Pointer-events disabled so it never intercepts
 *  clicks meant for things below it (which there aren't any of, but
 *  defensive). Accent updates pick up automatically via the inline style
 *  — no animation hooks needed.
 *
 *  60px tall: enough to read as ambient light, not enough to dominate
 *  the cover composition. Gradient fades from accent at the bottom edge
 *  to transparent at the top via a bottom-aligned ellipse, so the band
 *  feels diffuse rather than a sharp line.
 * ========================================================================= */

export { CoverFullscreenOverlay, LyricShareOverlay, ShareActionButton };
