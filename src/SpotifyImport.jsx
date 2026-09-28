import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * SpotifyImport — bring a Spotify playlist into the library.
 *
 * WHY THIS IS A RENDERER-ONLY COMPONENT
 *
 * The whole backend for this already existed and was fully wired: OAuth
 * (`spotify:beginUserAuth`), the playlist list (`spotify:getMyPlaylists`),
 * the track fetch with its Feb-2026 `items`/`tracks` shape handling
 * (`spotify:fetchPlaylist`), duplicate detection against the library
 * (`playlist:detectConflicts`), the sequential downloader with per-track
 * progress events (`playlist:importBatch`), and both yt-dlp and Soulseek
 * source paths. Not one of those channels had a caller — the UI went out
 * with the Immerse views and was never rebuilt, leaving the handlers as
 * dead surface on the IPC boundary.
 *
 * So this adds no main-process code. It is the missing half.
 *
 * FOUR STEPS, because they fail differently
 *
 *   pick      choose a playlist (yours, or any URL you can read)
 *   select    choose the tracks, with duplicates already flagged
 *   run       download them, one at a time, live
 *   done      what landed, what didn't, and a way to retry
 *
 * Selection is deliberately its own step rather than folded into picking.
 * Downloading forty tracks takes real minutes and real bandwidth, and the
 * duplicate check can only run once the track list is known — so the moment
 * you can see "31 of these are already in your library" is the moment you
 * should be able to act on it, before anything starts.
 */

const SOURCES = [
  ['ytdlp', 'YouTube', 'Finds a match on YouTube and pulls the audio. Works for almost anything.'],
  ['soulseek', 'Soulseek', 'Takes the best peer result. Better quality when it hits, misses more often.'],
];

export default function SpotifyImport({
  open,
  onClose,
  accent = '255, 255, 255',
  accentInk = '#000',
  onImported,          // (tracks) => void — library reload
  onCreatePlaylist,    // ({ name, coverArt }) => { ok, id }
  onAddTracksToPlaylist, // (playlistId, trackIds) => void
  pushToast,
}) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null;

  const [step, setStep] = useState('pick');
  const [auth, setAuth] = useState(null);        // { connected, displayName }
  const [lists, setLists] = useState([]);
  const [listsBusy, setListsBusy] = useState(false);
  const [listQuery, setListQuery] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [error, setError] = useState('');

  const [playlist, setPlaylist] = useState(null); // { name, imageUrl, tracks: [] }
  const [fetchBusy, setFetchBusy] = useState(false);
  const [conflicts, setConflicts] = useState(new Set()); // spotifyIds already in library
  const [sel, setSel] = useState(new Set());
  const [trackQuery, setTrackQuery] = useState('');
  const [source, setSource] = useState('ytdlp');
  const [alsoCreate, setAlsoCreate] = useState(true);

  const [progress, setProgress] = useState({});   // spotifyId → 'starting'|'done'|'failed'|'skipped'
  const [runAt, setRunAt] = useState({ index: 0, total: 0 });
  const [result, setResult] = useState(null);
  const cancelledRef = useRef(false);

  /* ---- auth ---------------------------------------------------------- */

  const readAuth = useCallback(async () => {
    if (!api?.spotifyUserAuthState) return;
    try { setAuth(await api.spotifyUserAuthState()); } catch { setAuth({ connected: false }); }
  }, [api]);

  const loadLists = useCallback(async () => {
    if (!api?.spotifyGetMyPlaylists) return;
    setListsBusy(true);
    setError('');
    try {
      const r = await api.spotifyGetMyPlaylists();
      if (r?.ok) setLists(r.playlists || []);
      else setError(r?.error || 'Could not load your playlists.');
    } catch (e) { setError(String(e?.message || e)); }
    finally { setListsBusy(false); }
  }, [api]);

  useEffect(() => {
    if (!open) return undefined;
    setStep('pick');
    setError('');
    setPlaylist(null);
    setResult(null);
    setProgress({});
    readAuth();
    return undefined;
  }, [open, readAuth]);

  useEffect(() => {
    if (auth?.connected) loadLists();
  }, [auth?.connected, loadLists]);

  // The OAuth round trip happens in a browser window the main process opens,
  // so the answer arrives as a push event rather than a return value.
  useEffect(() => {
    if (!api?.onSpotifyUserAuthChanged) return undefined;
    return api.onSpotifyUserAuthChanged(() => { readAuth(); });
  }, [api, readAuth]);

  /* ---- fetching a playlist ------------------------------------------- */

  const openPlaylist = useCallback(async (idOrUrl, hint) => {
    if (!api?.spotifyFetchPlaylist) return;
    setFetchBusy(true);
    setError('');
    try {
      const r = await api.spotifyFetchPlaylist(idOrUrl);
      if (!r?.ok) { setError(r?.error || 'Could not read that playlist.'); return; }
      const pl = { ...r.playlist, imageUrl: r.playlist.imageUrl || hint?.imageUrl || '' };
      setPlaylist(pl);
      setTrackQuery('');

      /* Duplicate check before anything is selected, so the default
         selection can already exclude what you have. Fuzzy on normalised
         title+artist, so it survives a track being re-released under a new
         Spotify ID. Non-fatal: a failure here just means nothing is
         pre-excluded. */
      let dupes = new Set();
      try {
        const c = await api.playlistDetectConflicts?.(pl.tracks);
        if (c?.ok) dupes = new Set((c.conflicts || []).map((x) => x.spotifyId));
      } catch { /* leave empty */ }
      setConflicts(dupes);
      setSel(new Set(pl.tracks.filter((t) => !dupes.has(t.spotifyId)).map((t) => t.spotifyId)));
      setStep('select');
    } catch (e) { setError(String(e?.message || e)); }
    finally { setFetchBusy(false); }
  }, [api]);

  /* ---- running ------------------------------------------------------- */

  useEffect(() => {
    if (!api?.onPlaylistImportProgress) return undefined;
    return api.onPlaylistImportProgress((p) => {
      if (!p?.spotifyId) return;
      setProgress((cur) => ({ ...cur, [p.spotifyId]: p.state }));
      if (typeof p.index === 'number') setRunAt({ index: p.index + 1, total: p.total || 0 });
    });
  }, [api]);

  const run = useCallback(async (only) => {
    if (!api?.playlistImportBatch || !playlist) return;
    const ids = only || sel;
    const chosen = playlist.tracks.filter((t) => ids.has(t.spotifyId));
    if (!chosen.length) return;
    cancelledRef.current = false;
    setProgress({});
    setRunAt({ index: 0, total: chosen.length });
    setResult(null);
    setStep('run');
    try {
      const r = await api.playlistImportBatch({ tracks: chosen, source });
      if (!r?.ok) { setError(r?.error || 'Import failed.'); setStep('select'); return; }

      /* Reload the library BEFORE filing anything into a playlist — the
         imported tracks don't exist in the renderer's copy until it does,
         and a playlist built from IDs the UI can't resolve renders as a
         list of blanks. */
      if (r.importedTracks?.length) await onImported?.(r.importedTracks);

      if (alsoCreate && r.importedTracks?.length && onCreatePlaylist) {
        try {
          const made = await onCreatePlaylist({ name: playlist.name, coverArt: playlist.imageUrl || null });
          if (made?.ok && made.id) {
            await onAddTracksToPlaylist?.(made.id, r.importedTracks.map((t) => t.id));
          }
        } catch { /* the tracks are in the library either way */ }
      }
      setResult(r);
      setStep('done');
    } catch (e) {
      setError(String(e?.message || e));
      setStep('select');
    }
  }, [api, playlist, sel, source, alsoCreate, onImported, onCreatePlaylist, onAddTracksToPlaylist]);

  /* ---- derived ------------------------------------------------------- */

  const shownLists = useMemo(() => {
    const q = listQuery.trim().toLowerCase();
    return q ? lists.filter((p) => (p.name || '').toLowerCase().includes(q)) : lists;
  }, [lists, listQuery]);

  const shownTracks = useMemo(() => {
    if (!playlist) return [];
    const q = trackQuery.trim().toLowerCase();
    return q
      ? playlist.tracks.filter((t) => `${t.title} ${t.artists} ${t.album}`.toLowerCase().includes(q))
      : playlist.tracks;
  }, [playlist, trackQuery]);

  const newCount = useMemo(
    () => (playlist ? playlist.tracks.filter((t) => !conflicts.has(t.spotifyId)).length : 0),
    [playlist, conflicts],
  );

  if (!open) return null;

  const acc = accent;
  const failedIds = new Set((result?.failures || []).map((f) => f.spotifyId));

  /* Bulk actions operate on what's VISIBLE, not on everything. With a filter
     typed in, "Select all" meaning "all 400 tracks including the 380 you
     just filtered out" is a trap; scoping to the filter is what makes the
     search box useful for selection rather than just for looking. */
  const setAllShown = (on) => {
    setSel((cur) => {
      const next = new Set(cur);
      for (const t of shownTracks) { if (on) next.add(t.spotifyId); else next.delete(t.spotifyId); }
      return next;
    });
  };

  return createPortal(
    <div style={S.scrim} onClick={step === 'run' ? undefined : onClose}>
      <div style={S.panel} onClick={(e) => e.stopPropagation()}>

        <div style={S.head}>
          <div>
            <div style={S.title}>Import from Spotify</div>
            <div style={S.sub}>
              {step === 'pick' && (auth?.connected ? `Connected as ${auth.displayName || 'you'}` : 'Connect your account to see your playlists')}
              {step === 'select' && playlist ? `${playlist.name} · ${playlist.tracks.length} tracks` : null}
              {step === 'run' && `Downloading ${runAt.index} of ${runAt.total}`}
              {step === 'done' && 'Finished'}
            </div>
          </div>
          {step !== 'run' ? (
            <button type="button" onClick={onClose} style={S.x} aria-label="Close">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          ) : null}
        </div>

        {error ? <div style={S.err}>{error}</div> : null}

        {/* ---------- STEP 1: pick ---------- */}
        {step === 'pick' ? (
          <>
            <div style={S.body}>
              {!auth?.connected ? (
                <div style={S.empty}>
                  <p style={S.emptyP}>
                    Spotify locked playlist contents to user tokens in November 2024, so reading
                    a playlist needs your account connected — an app-level key is no longer enough.
                  </p>
                  <button type="button" style={{ ...S.primary, background: `rgb(${acc})`, color: accentInk }}
                    onClick={() => api?.spotifyBeginUserAuth?.()}>
                    Connect Spotify
                  </button>
                </div>
              ) : (
                <>
                  <input value={listQuery} onChange={(e) => setListQuery(e.target.value)}
                    placeholder="Search your playlists…" style={S.input} />
                  {listsBusy ? <div style={S.note}>Loading your playlists…</div> : null}
                  {shownLists.map((p) => (
                    <button type="button" key={p.id} style={S.row} onClick={() => openPlaylist(p.id, p)} disabled={fetchBusy}>
                      <span style={{ ...S.art, backgroundImage: p.imageUrl ? `url("${p.imageUrl}")` : undefined }} />
                      <span style={S.rowTxt}>
                        <span style={S.rowName}>{p.name}</span>
                        <span style={S.rowSub}>{p.totalTracks} tracks · {p.owner}</span>
                      </span>
                    </button>
                  ))}
                  {!listsBusy && !shownLists.length ? <div style={S.note}>No playlists match.</div> : null}
                </>
              )}
            </div>
            <div style={S.foot}>
              {/* A paste field as well as the list. Dev-mode Spotify apps can
                  only read playlists you own or collaborate on, but an
                  Extended Quota app can read more than getMyPlaylists
                  returns — and this is also the only route to a playlist
                  you follow but don't own. */}
              <input value={urlInput} onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && urlInput.trim()) openPlaylist(urlInput.trim()); }}
                placeholder="…or paste a playlist link" style={{ ...S.input, marginTop: 0, flex: 1 }} />
              <button type="button" disabled={!urlInput.trim() || fetchBusy}
                onClick={() => openPlaylist(urlInput.trim())}
                style={{ ...S.primary, background: `rgb(${acc})`, color: accentInk, opacity: urlInput.trim() ? 1 : 0.4 }}>
                {fetchBusy ? 'Reading…' : 'Open'}
              </button>
            </div>
          </>
        ) : null}

        {/* ---------- STEP 2: select ---------- */}
        {step === 'select' && playlist ? (
          <>
            <div style={S.bar}>
              <input value={trackQuery} onChange={(e) => setTrackQuery(e.target.value)}
                placeholder="Filter tracks…" style={{ ...S.input, marginTop: 0, flex: 1 }} />
              <button type="button" style={S.chip} onClick={() => setAllShown(true)}>All</button>
              <button type="button" style={S.chip} onClick={() => setAllShown(false)}>None</button>
              {/* The one that matters. Re-downloading 31 tracks you already
                  own is the default failure mode of every playlist importer. */}
              <button type="button" style={S.chip}
                onClick={() => setSel(new Set(playlist.tracks.filter((t) => !conflicts.has(t.spotifyId)).map((t) => t.spotifyId)))}>
                New only ({newCount})
              </button>
            </div>

            <div style={S.body}>
              {shownTracks.map((t) => {
                const on = sel.has(t.spotifyId);
                const dupe = conflicts.has(t.spotifyId);
                return (
                  <button type="button" key={t.spotifyId} style={S.row}
                    onClick={() => setSel((cur) => {
                      const n = new Set(cur);
                      if (n.has(t.spotifyId)) n.delete(t.spotifyId); else n.add(t.spotifyId);
                      return n;
                    })}>
                    <span style={{ ...S.art, backgroundImage: t.albumArtUrl ? `url("${t.albumArtUrl}")` : undefined }} />
                    <span style={S.rowTxt}>
                      <span style={S.rowName}>{t.title}</span>
                      <span style={S.rowSub}>
                        {t.artists}
                        {dupe ? <em style={{ ...S.tag, color: `rgb(${acc})` }}> · already in library</em> : null}
                      </span>
                    </span>
                    <span style={{ ...S.box, ...(on ? { background: `rgb(${acc})`, borderColor: `rgb(${acc})`, color: accentInk } : null) }}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6.5L9.2 17.3 4 12.1" /></svg>
                    </span>
                  </button>
                );
              })}
              {!shownTracks.length ? <div style={S.note}>No tracks match.</div> : null}
            </div>

            <div style={{ ...S.foot, flexDirection: 'column', alignItems: 'stretch', gap: 9 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {SOURCES.map(([id, label, hint]) => (
                  <button type="button" key={id} title={hint} onClick={() => setSource(id)}
                    style={{ ...S.srcBtn, ...(source === id ? { borderColor: `rgb(${acc})`, color: `rgb(${acc})`, background: `rgba(${acc},0.1)` } : null) }}>
                    {label}
                  </button>
                ))}
                <label style={S.check}>
                  <input type="checkbox" checked={alsoCreate} onChange={(e) => setAlsoCreate(e.target.checked)} />
                  Also make a studio playlist
                </label>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => setStep('pick')} style={S.ghost}>Back</button>
                <button type="button" disabled={!sel.size} onClick={() => run()}
                  style={{ ...S.primary, flex: 2, background: sel.size ? `rgb(${acc})` : 'rgba(255,255,255,0.09)', color: sel.size ? accentInk : 'rgba(200,200,210,0.5)' }}>
                  Download {sel.size} track{sel.size === 1 ? '' : 's'}
                </button>
              </div>
            </div>
          </>
        ) : null}

        {/* ---------- STEP 3: run ---------- */}
        {step === 'run' && playlist ? (
          <>
            <div style={S.progWrap}>
              <div style={{ ...S.progFill, width: `${runAt.total ? (runAt.index / runAt.total) * 100 : 0}%`, background: `rgb(${acc})` }} />
            </div>
            <div style={S.body}>
              {playlist.tracks.filter((t) => sel.has(t.spotifyId)).map((t) => {
                const st = progress[t.spotifyId];
                return (
                  <div key={t.spotifyId} style={{ ...S.row, cursor: 'default', opacity: st ? 1 : 0.45 }}>
                    <span style={{ ...S.art, backgroundImage: t.albumArtUrl ? `url("${t.albumArtUrl}")` : undefined }} />
                    <span style={S.rowTxt}>
                      <span style={S.rowName}>{t.title}</span>
                      <span style={S.rowSub}>{t.artists}</span>
                    </span>
                    <span style={{ ...S.state, color: st === 'failed' ? '#e0645c' : st === 'done' ? `rgb(${acc})` : 'rgba(200,200,210,0.45)' }}>
                      {st === 'starting' ? 'Downloading…' : st === 'done' ? 'Added' : st === 'failed' ? 'Failed' : st === 'skipped' ? 'Skipped' : 'Waiting'}
                    </span>
                  </div>
                );
              })}
            </div>
            <div style={S.foot}>
              {/* No cancel button. importBatch runs the whole list in the main
                  process with no abort signal, so a button here could only
                  lie about stopping it — the honest thing is to say what's
                  actually true. */}
              <div style={S.note}>Downloading a few at a time. You can keep using studio; this window can stay open.</div>
            </div>
          </>
        ) : null}

        {/* ---------- STEP 4: done ---------- */}
        {step === 'done' && result ? (
          <>
            <div style={S.body}>
              <div style={S.tally}>
                <b style={{ color: `rgb(${acc})` }}>{result.completed}</b> added
                {result.failed ? <> · <b style={{ color: '#e0645c' }}>{result.failed}</b> failed</> : null}
                {result.skipped ? <> · {result.skipped} skipped</> : null}
              </div>
              {(result.failures || []).map((f) => (
                <div key={f.spotifyId} style={{ ...S.row, cursor: 'default' }}>
                  <span style={S.rowTxt}>
                    <span style={S.rowName}>{playlist?.tracks.find((t) => t.spotifyId === f.spotifyId)?.title || f.spotifyId}</span>
                    <span style={{ ...S.rowSub, color: 'rgba(224,100,92,0.75)' }}>{f.error}</span>
                  </span>
                </div>
              ))}
            </div>
            <div style={S.foot}>
              {result.failed ? (
                /* Retry only the failures. Most are transient — a YouTube
                   match that didn't resolve, a peer that dropped — and
                   re-running the whole playlist to get them would re-download
                   everything that already worked. */
                <button type="button" onClick={() => run(failedIds)} style={S.ghost}>
                  Retry {result.failed} failed
                </button>
              ) : null}
              <button type="button" onClick={onClose}
                style={{ ...S.primary, flex: 1, background: `rgb(${acc})`, color: accentInk }}>
                Done
              </button>
            </div>
          </>
        ) : null}

      </div>
    </div>,
    document.body,
  );
}

/* Styles kept in one object rather than a stylesheet: this component is
   mounted once and its surfaces don't need to be themed from outside. */
const S = {
  scrim: { position: 'fixed', inset: 0, zIndex: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(4,4,6,0.82)' },
  panel: { width: 'min(520px, 94vw)', maxHeight: '82vh', display: 'flex', flexDirection: 'column', borderRadius: 15, background: 'rgb(15,15,18)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 24px 70px rgba(0,0,0,0.65)', overflow: 'hidden' },
  head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '15px 17px 13px', borderBottom: '1px solid rgba(255,255,255,0.07)' },
  title: { fontSize: 14.5, fontWeight: 700, color: '#f2f2f4' },
  sub: { fontSize: 11, color: 'rgba(200,200,210,0.45)', marginTop: 3 },
  x: { width: 26, height: 26, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', color: 'rgba(200,200,210,0.5)', cursor: 'pointer', flexShrink: 0 },
  body: { overflowY: 'auto', padding: '8px 9px', minHeight: 120, flex: 1 },
  bar: { display: 'flex', gap: 6, padding: '10px 12px 4px', alignItems: 'center' },
  foot: { display: 'flex', gap: 8, alignItems: 'center', padding: '11px 12px', borderTop: '1px solid rgba(255,255,255,0.07)' },
  input: { width: '100%', boxSizing: 'border-box', marginTop: 4, padding: '8px 11px', borderRadius: 9, outline: 'none', border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.4)', color: '#f2f2f4', fontSize: 12.5, fontFamily: 'inherit' },
  row: { width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', borderRadius: 9, border: 'none', background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit' },
  art: { width: 34, height: 34, borderRadius: 5, flexShrink: 0, background: 'rgba(255,255,255,0.08) center/cover' },
  rowTxt: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  rowName: { fontSize: 12.5, fontWeight: 600, color: '#f2f2f4', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rowSub: { fontSize: 10.5, color: 'rgba(200,200,210,0.45)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  tag: { fontStyle: 'normal', fontWeight: 650 },
  box: { width: 19, height: 19, borderRadius: 5, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1.5px solid rgba(255,255,255,0.22)', color: 'transparent' },
  chip: { padding: '7px 11px', borderRadius: 8, flexShrink: 0, border: '1px solid rgba(255,255,255,0.12)', background: 'transparent', color: 'rgba(200,200,210,0.75)', fontSize: 11.5, fontWeight: 650, cursor: 'pointer', fontFamily: 'inherit' },
  srcBtn: { flex: 1, padding: '7px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: 'transparent', color: 'rgba(200,200,210,0.7)', fontSize: 11.5, fontWeight: 650, cursor: 'pointer', fontFamily: 'inherit' },
  check: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'rgba(200,200,210,0.6)', cursor: 'pointer', flexShrink: 0 },
  primary: { padding: '9px 15px', borderRadius: 9, border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 },
  ghost: { flex: 1, padding: '9px 15px', borderRadius: 9, border: '1px solid rgba(255,255,255,0.12)', background: 'transparent', color: 'rgba(200,200,210,0.75)', fontSize: 12, fontWeight: 650, cursor: 'pointer', fontFamily: 'inherit' },
  note: { fontSize: 11, color: 'rgba(200,200,210,0.4)', padding: '8px 4px', lineHeight: 1.5 },
  err: { margin: '10px 12px 0', padding: '9px 11px', borderRadius: 9, background: 'rgba(224,100,92,0.12)', border: '1px solid rgba(224,100,92,0.3)', color: '#e8a09a', fontSize: 11.5, lineHeight: 1.5 },
  empty: { padding: '22px 14px', textAlign: 'center' },
  emptyP: { fontSize: 12, color: 'rgba(200,200,210,0.55)', lineHeight: 1.6, margin: '0 0 16px' },
  progWrap: { height: 3, background: 'rgba(255,255,255,0.08)', flexShrink: 0 },
  progFill: { height: '100%', transition: 'width 0.3s ease' },
  state: { fontSize: 10.5, fontWeight: 650, flexShrink: 0 },
  tally: { fontSize: 13, color: 'rgba(200,200,210,0.7)', padding: '14px 8px 10px' },
};
