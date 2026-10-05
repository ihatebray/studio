import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { importSpotifyPlaylist, playlistIdFrom } from './playlistImport.js';

/**
 * SpotifyImport — bring Spotify playlists into Studio.
 *
 * Uses the same Spotify sign-in as the rest of the app (Settings →
 * Connections) and the same import as setup's playlist step
 * (playlistImport.js): each playlist's songs join the library as streamed
 * tracks, and a Studio playlist with the same name and cover holds them.
 * Nothing is downloaded.
 *
 * It used to drive an older importer that needed a separate Spotify
 * developer sign-in and downloaded every song, so it showed "Connect
 * Spotify" even when the account was connected, and did nothing.
 *
 * Pick any of your playlists (and Liked Songs), or paste a link to one.
 */
export default function SpotifyImport({
  open,
  onClose,
  accent = '255, 255, 255',
  accentInk = '#000',
  onImported,            // () => void — library reload
  onCreatePlaylist,      // ({ name, coverArt }) => { ok, id }
  onAddTracksToPlaylist, // (playlistId, trackIds) => void
}) {
  const a = typeof window !== 'undefined' ? window.electronAPI : null;

  const [lists, setLists] = useState(null);   // null while loading
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const [status, setStatus] = useState({});   // id → { text, kind }
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);     // playlists made, once finished
  const [link, setLink] = useState('');
  const [linkNote, setLinkNote] = useState(null); // { text, kind }

  const load = useCallback(async () => {
    setLists(null);
    setError('');
    const r = await a?.spotifyFeedMyPlaylists?.().catch(() => null);
    if (r?.ok) { setSignedOut(false); setLists(r.data || []); return; }
    setLists([]);
    if (r?.step === 'signin') setSignedOut(true);
    else setError(r?.error || 'Couldn’t load your playlists.');
  }, [a]);

  useEffect(() => {
    if (!open) return;
    setPicked(new Set());
    setStatus({});
    setDone(null);
    setQuery('');
    setLink('');
    setLinkNote(null);
    load();
  }, [open, load]);

  // Signing in happens in the browser; the answer arrives as an event.
  useEffect(() => {
    if (!open || !a?.onSpotifyPartnerChanged) return undefined;
    return a.onSpotifyPartnerChanged((s) => { if (s?.connected) load(); });
  }, [open, a, load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? (lists || []).filter((p) => (p.name || '').toLowerCase().includes(q)) : (lists || []);
  }, [lists, query]);

  const toggle = (id) => {
    if (busy || done !== null) return;
    setPicked((s0) => { const s1 = new Set(s0); if (s1.has(id)) s1.delete(id); else s1.add(id); return s1; });
  };
  const say = (id, text, kind = '') => setStatus((m) => ({ ...m, [id]: { text, kind } }));
  const deps = { onCreatePlaylist, onAddTracksToPlaylist };

  const run = async () => {
    setBusy(true);
    let made = 0;
    for (const item of (lists || []).filter((x) => picked.has(x.id))) {
      try {
        if (await importSpotifyPlaylist(a, item, { ...deps, say: (t, k) => say(item.id, t, k) })) made += 1;
      } catch (e) {
        say(item.id, 'Failed', 'bad');
        console.warn('[import] playlist failed:', item.name, e);
      }
    }
    await onImported?.();
    setBusy(false);
    setDone(made);
  };

  const runLink = async () => {
    const id = playlistIdFrom(link);
    if (!id) { setLinkNote({ text: 'That doesn’t look like a Spotify playlist link.', kind: 'bad' }); return; }
    setBusy(true);
    try {
      let item = (lists || []).find((x) => x.id === id);
      if (!item) {
        const meta = await a?.spotifyFeedPlaylistMeta?.(id).catch(() => null);
        item = { id, kind: 'playlist', name: meta?.ok ? meta.data.name : '', cover: meta?.ok ? meta.data.cover : '' };
      }
      const n = await importSpotifyPlaylist(a, item, { ...deps, say: (text, kind) => setLinkNote({ text, kind }) });
      if (n) {
        setLinkNote({ text: `Added “${item.name || 'Spotify playlist'}” with ${n} songs. It’s under Playlists in the sidebar.`, kind: 'ok' });
        setLink('');
        await onImported?.();
      }
    } catch (e) {
      setLinkNote({ text: 'Couldn’t import that playlist.', kind: 'bad' });
      console.warn('[import] link failed:', e);
    }
    setBusy(false);
  };

  if (!open) return null;
  const n = picked.size;
  const primary = { ...S.primary, background: `rgb(${accent})`, color: accentInk };
  const noteColor = (k) => (k === 'ok' ? '#8ff0b5' : k === 'bad' ? '#ff9a9a' : 'rgba(200,200,210,0.6)');

  return createPortal(
    <div style={S.scrim} onClick={busy ? undefined : onClose}>
      <div style={S.panel} onClick={(e) => e.stopPropagation()}>
        <div style={S.head}>
          <div>
            <div style={S.title}>Import from Spotify</div>
            <div style={S.sub}>
              {signedOut ? 'Sign in to Spotify to see your playlists'
                : 'Each one becomes a Studio playlist with the same name and cover'}
            </div>
          </div>
          {!busy ? (
            <button type="button" onClick={onClose} style={S.x} aria-label="Close">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          ) : null}
        </div>

        {error ? <div style={S.err}>{error}</div> : null}

        <div style={S.body}>
          {signedOut ? (
            <div style={S.empty}>
              <p style={S.emptyP}>Studio reads your playlists through your Spotify account. Sign in once and they show up here.</p>
              <button type="button" style={primary} onClick={() => a?.spotifyPartnerSignIn?.()}>Sign in to Spotify</button>
            </div>
          ) : lists === null ? (
            <div style={S.note}>Loading your playlists…</div>
          ) : (
            <>
              {lists.length > 6 ? (
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your playlists…" style={{ ...S.input, marginBottom: 6 }} />
              ) : null}
              {shown.map((p) => {
                const on = picked.has(p.id);
                const st = status[p.id];
                return (
                  <button type="button" key={p.id} style={{ ...S.row, background: on ? 'rgba(255,255,255,0.08)' : 'transparent' }}
                    onClick={() => toggle(p.id)} aria-pressed={on}>
                    <span style={{ ...S.art, backgroundImage: p.image ? `url("${p.image}")` : undefined }} />
                    <span style={S.rowTxt}>
                      <span style={S.rowName}>{p.name}</span>
                      {p.sub ? <span style={S.rowSub}>{p.sub}</span> : null}
                    </span>
                    {st ? <span style={{ ...S.state, color: noteColor(st.kind) }}>{st.text}</span> : (
                      <span style={{ ...S.box, background: on ? '#fff' : 'transparent', borderColor: on ? '#fff' : 'rgba(255,255,255,0.3)' }} aria-hidden>
                        {on ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#0b0b0c" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="5 12.5 10 17.5 19 7" /></svg> : null}
                      </span>
                    )}
                  </button>
                );
              })}
              {lists.length && !shown.length ? <div style={S.note}>No playlists match.</div> : null}
              {!lists.length && !error ? <div style={S.note}>No playlists on this Spotify account yet. You can still paste a link below.</div> : null}
            </>
          )}
        </div>

        {!signedOut ? (
          <div style={S.foot}>
            {done !== null ? (
              <>
                <span style={S.footNote}>{done ? `Added ${done} ${done === 1 ? 'playlist' : 'playlists'}. They’re under Playlists in the sidebar.` : 'Nothing could be added this time.'}</span>
                <button type="button" style={primary} onClick={onClose}>Done</button>
              </>
            ) : (
              <>
                <span style={S.footNote}>{n ? `${n} selected` : 'Pick the ones you want'}</span>
                <button type="button" style={{ ...primary, opacity: n && !busy ? 1 : 0.4 }} disabled={!n || busy} onClick={run}>
                  {busy && n ? 'Importing…' : n > 1 ? `Import ${n} playlists` : 'Import playlist'}
                </button>
              </>
            )}
          </div>
        ) : null}

        {!signedOut ? (
          <div style={{ ...S.foot, flexWrap: 'wrap' }}>
            <input value={link} onChange={(e) => { setLink(e.target.value); setLinkNote(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && link.trim() && !busy) runLink(); }}
              placeholder="…or paste a playlist link" style={{ ...S.input, marginTop: 0, flex: 1 }} disabled={busy} />
            <button type="button" disabled={!link.trim() || busy} onClick={runLink}
              style={{ ...S.ghostBtn, opacity: link.trim() && !busy ? 1 : 0.4 }}>
              Import
            </button>
            {linkNote ? <div style={{ flexBasis: '100%', fontSize: 11.5, lineHeight: 1.5, color: noteColor(linkNote.kind) }}>{linkNote.text}</div> : null}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

const S = {
  scrim: { position: 'fixed', inset: 0, zIndex: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(4,4,6,0.82)' },
  panel: { width: 'min(520px, 94vw)', maxHeight: '82vh', display: 'flex', flexDirection: 'column', borderRadius: 15, background: 'rgb(15,15,18)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 24px 70px rgba(0,0,0,0.65)', overflow: 'hidden' },
  head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '15px 17px 13px', borderBottom: '1px solid rgba(255,255,255,0.07)' },
  title: { fontSize: 14.5, fontWeight: 700, color: '#f2f2f4' },
  sub: { fontSize: 11, color: 'rgba(200,200,210,0.45)', marginTop: 3 },
  x: { width: 26, height: 26, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', color: 'rgba(200,200,210,0.5)', cursor: 'pointer', flexShrink: 0 },
  body: { overflowY: 'auto', padding: '8px 9px', minHeight: 120, flex: 1 },
  foot: { display: 'flex', gap: 8, alignItems: 'center', padding: '11px 12px', borderTop: '1px solid rgba(255,255,255,0.07)' },
  footNote: { flex: 1, minWidth: 0, fontSize: 12, color: 'rgba(200,200,210,0.55)' },
  input: { width: '100%', boxSizing: 'border-box', marginTop: 4, padding: '8px 11px', borderRadius: 9, outline: 'none', border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.4)', color: '#f2f2f4', fontSize: 12.5, fontFamily: 'inherit' },
  row: { width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', borderRadius: 9, border: 'none', color: 'inherit', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit' },
  art: { width: 38, height: 38, borderRadius: 6, flexShrink: 0, background: 'rgba(255,255,255,0.08) center/cover' },
  rowTxt: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  rowName: { fontSize: 13, fontWeight: 600, color: '#f2f2f4', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rowSub: { fontSize: 11, color: 'rgba(200,200,210,0.45)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  box: { width: 19, height: 19, borderRadius: 6, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1.5px solid', boxSizing: 'border-box' },
  primary: { padding: '9px 16px', borderRadius: 999, border: 'none', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 },
  ghostBtn: { padding: '8px 14px', borderRadius: 9, border: '1px solid rgba(255,255,255,0.14)', background: 'transparent', color: '#f2f2f4', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 },
  note: { fontSize: 12, color: 'rgba(200,200,210,0.5)', padding: '10px 6px', lineHeight: 1.5 },
  err: { margin: '10px 12px 0', padding: '9px 11px', borderRadius: 9, background: 'rgba(224,100,92,0.12)', border: '1px solid rgba(224,100,92,0.3)', color: '#e8a09a', fontSize: 11.5, lineHeight: 1.5 },
  empty: { padding: '22px 14px', textAlign: 'center' },
  emptyP: { fontSize: 12.5, color: 'rgba(200,200,210,0.6)', lineHeight: 1.6, margin: '0 0 16px' },
  state: { fontSize: 11.5, fontWeight: 700, flexShrink: 0, fontVariantNumeric: 'tabular-nums' },
};
