import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import InstantSearch from './InstantSearch.jsx';
import { HOME_CSS } from './home/styles.js';
import { StudioMotionStyles } from './StudioOnboarding.jsx';
import { applyAccent } from '../lib/accentTokens.js';
import { setPlaybackTime } from '../lib/playbackClock.js';
import { ensureControlFontInheritance, getStoredFontId, loadGoogleFontForPreset, presetById } from '../lib/uiFonts.js';
import { loadCustomFonts } from '../lib/customFonts.js';

/* =========================================================================
 *  A playlist in a window of its own (playlistWindows.js in main)
 *
 *  The same view as the app's playlist pop-out (InstantSearch, windowed),
 *  so the two look and behave alike, Immerse included. Music plays from the
 *  app's window: it pushes what this shows (the playlist, the song playing,
 *  the theme) and this sends back what you ask for (play, skip, edit).
 * ========================================================================= */

const EMPTY = [];
const noop = () => {};

export default function PlaylistWindow({ wkey }) {
  const api = window.electronAPI;
  const cmd = useCallback((name, args) => api?.plwinCmd?.(name, args), [api]);

  /* What the app pushes. The playing position comes four times a second,
     so it goes straight to the clock and only the parts showing it redraw. */
  const [theme, setTheme] = useState(null);
  const [now, setNow] = useState(null);
  const [rec, setRec] = useState(null);
  const [lyrics, setLyrics] = useState(null);
  const recRef = useRef(null);
  recRef.current = rec;
  const waiting = useRef([]);
  useEffect(() => {
    const off = api?.onPlwinState?.((d) => {
      if (!d) return;
      if (typeof d.time === 'number') setPlaybackTime(d.time);
      if (d.theme) setTheme(d.theme);
      if ('now' in d) setNow(d.now);
      if ('lyrics' in d) setLyrics(d.lyrics);
      // The playlist was deleted: nothing left to show.
      if (d.record?.gone) { api?.close?.(); return; }
      if (d.record) {
        setRec(d.record);
        recRef.current = d.record;
        waiting.current.splice(0).forEach((fn) => fn(d.record.tracks));
      }
    });
    cmd('hello');
    return () => off?.();
  }, [api, cmd]);

  // The app's colors and font, as its window has them.
  useEffect(() => {
    if (!theme) return;
    const r = document.documentElement.style;
    r.setProperty('--st-bg-rgb', theme.bg);
    r.setProperty('--st-text-rgb', theme.text);
    r.setProperty('--st-sub-rgb', theme.sub);
    r.setProperty('--st-fg-rgb', theme.fg || theme.text);
    r.setProperty('--st-text', `rgb(${theme.text})`);
    if (theme.accent) applyAccent(theme.accent);
  }, [theme]);
  useEffect(() => {
    loadCustomFonts();
    const preset = presetById(getStoredFontId());
    loadGoogleFontForPreset(preset);
    ensureControlFontInheritance();
    document.body.style.fontFamily = preset.stack;
  }, []);
  useEffect(() => { if (rec?.name) document.title = `${rec.name} · studio`; }, [rec?.name]);

  /* The record the view opens: made once, when the playlist first arrives.
     Everything it does goes to the app; its songs as they change come in
     as liveRecord. */
  const ready = !!rec;
  const record = useMemo(() => {
    const r = recRef.current;
    if (!r) return null;
    const can = r.can || {};
    return {
      focusId: null,
      album: {
        albumId: wkey, name: r.name, artists: r.artists || '', albumArtUrl: r.albumArtUrl || '', label: r.label || 'Playlist',
        collection: true, playlist: true, lib: !!r.lib, context: r.context || null, empty: r.empty || '',
        load: () => (recRef.current?.tracks ? Promise.resolve(recRef.current.tracks) : new Promise((res) => waiting.current.push(res))),
        // The rows in the order they show (sorted or not), for the app to match.
        play: (rows, index = 0, shuffle = false) => cmd('play', { index, shuffle, ids: rows.map((r) => r.libTrack?.id ?? r.spotifyId ?? null) }),
        move: can.move ? (trackId, row) => cmd('move', { trackId, row }) : null,
        editor: can.rename || can.cover || can.remove || can.del ? {
          rename: can.rename ? (name) => cmd('rename', { name }) : null,
          setCover: can.cover ? (coverArt) => cmd('cover', { coverArt }) : null,
          remove: can.remove ? (trackId) => cmd('remove', { trackId }) : null,
          del: can.del ? () => cmd('delete') : null,
        } : null,
      },
    };
  }, [ready, wkey, cmd]); // eslint-disable-line react-hooks/exhaustive-deps
  const liveRecord = useMemo(() => (rec ? { albumId: wkey, tracks: rec.tracks || EMPTY, name: rec.name, albumArtUrl: rec.albumArtUrl || '' } : null), [rec, wkey]);

  const owned = useMemo(() => new Set(rec?.owned || EMPTY), [rec?.owned]);
  const nowIds = useMemo(() => new Set(now?.spotifyIds || EMPTY), [now?.spotifyIds]);
  const nowPlaying = useMemo(() => (now ? { id: now.id, isRow: (row) => !!row?.spotifyId && nowIds.has(row.spotifyId), playing: !!now.playing } : null), [now, nowIds]);
  const mini = useMemo(() => (now ? {
    track: now.track, art: now.art, playing: !!now.playing, duration: now.duration,
    onToggle: () => cmd('toggle'), onPrev: () => cmd('prev'), onNext: () => cmd('next'), onSeek: (t) => cmd('seek', { t }),
    shuffleOn: !!now.shuffleOn, repeat: now.repeat || 'off',
    onToggleShuffle: () => cmd('shuffle'), onToggleRepeat: () => cmd('repeat'),
    volume: now.volume ?? 1, onSetVolume: (v) => cmd('volume', { v }),
    gainBoost: now.gainBoost ?? 1, onSetGainBoost: (b) => cmd('boost', { b }),
  } : null), [now, cmd]);

  // Keep on top, back into the app, minimize, close.
  const [pinned, setPinned] = useState(false);
  const windowBar = (
    <>
      <button type="button" className={`isx-winbtn${pinned ? ' is-on' : ''}`} aria-pressed={pinned}
        title={pinned ? 'Keep on Top: On' : 'Keep on Top'} aria-label="Keep on Top"
        onClick={async () => setPinned(!!(await api?.plwinPin?.(!pinned)))}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z" /><path d="M12 15v6" />
        </svg>
      </button>
      <button type="button" className="isx-winbtn" title="Return to App" aria-label="Return to the app" onClick={() => api?.plwinReturn?.()}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="3" width="18" height="18" rx="3" /><path d="M16 8l-7 7M9 10v5h5" />
        </svg>
      </button>
      <button type="button" className="isx-winbtn" title="Minimize" aria-label="Minimize" onClick={() => api?.minimize?.()}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M5 12h14" /></svg>
      </button>
      <button type="button" className="isx-winbtn is-close" title="Close" aria-label="Close" onClick={() => api?.close?.()}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </>
  );

  const dark = !!theme?.dark;
  return (
    <div className="sth-root" data-dark={dark ? '' : undefined} style={{
      position: 'absolute', inset: 0, overflow: 'hidden', background: theme ? `rgb(${theme.bg})` : '#000',
      ...(theme ? {
        '--st-bg-rgb': theme.bg, '--st-text-rgb': theme.text, '--st-sub-rgb': theme.sub,
        '--st-fg-rgb': theme.fg || theme.text, '--st-text': `rgb(${theme.text})`,
      } : null),
    }}>
      <StudioMotionStyles />
      <style>{HOME_CSS}</style>
      {record && theme ? (
        <InstantSearch
          open
          windowed
          windowBar={windowBar}
          onClose={noop}
          record={record}
          liveRecord={liveRecord}
          look={theme.look || 'dark'}
          nowPlaying={nowPlaying}
          onTogglePlay={() => cmd('toggle')}
          mini={mini}
          lyrics={lyrics}
          library={EMPTY}
          alreadyOwned={(_t, _a, _al, sid) => !!sid && owned.has(sid)}
          coverFor={() => null}
          onGetSpotifyTrack={(row) => cmd('get', { row })}
          onPlaySpotifyRows={(rows, index, opts) => cmd('playRows', { rows, index, opts: opts ? { shuffle: !!opts.shuffle, context: opts.context || null, source: opts.source || null } : null })}
          onOpenArtist={(a) => cmd('openArtist', { name: a?.name })}
        />
      ) : null}
    </div>
  );
}
