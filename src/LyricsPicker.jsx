import React, { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';

/**
 * LyricsPickerButton — hover-reveal button that opens a lyrics picker modal.
 * Self-contained: manages its own open/loading/results state internally.
 *
 * Props:
 *   currentTrack  — the track to search for
 *   accent        — RGB accent triple
 *   visible       — whether the button is visible (hover state from parent)
 *   onApply       — fn(candidate) called when user picks a lyrics version
 *   appliedText   — plain text of the lyrics currently applied, used to mark
 *                   which candidate (if any) is the one in use right now
 */
export function LyricsPickerButton({
  currentTrack, accent, visible, onApply, appliedText, appliedId,
  // studio additions — both optional, existing call sites unaffected:
  openRequest = 0,     // increment to open the modal programmatically
  hideTrigger = false, // suppress the built-in hover trigger button
}) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Manual search box. The default search uses the track's CURRENT tags —
  // which is a dead end when the metadata and LRCLIB disagree (artist
  // renamed themselves, fixed a typo, translated a title…). Typing here
  // searches LRCLIB with exactly these words instead.
  const [queryText, setQueryText] = useState('');

  const runSearch = useCallback(async (customQuery) => {
    if (!currentTrack) return;
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.searchAllLyrics) {
      console.warn('[lyrics-picker] searchAllLyrics not available');
      return;
    }
    setLoading(true);
    setResults([]);
    setError('');
    try {
      const r = await api.searchAllLyrics({
        title: currentTrack.title, artist: currentTrack.artist,
        album: currentTrack.album, duration: currentTrack.duration,
        customQuery: String(customQuery || '').trim() || undefined,
      });
      if (r?.error) setError(r.error);
      setResults(r?.candidates || []);
    } catch (e) {
      console.error('[lyrics-picker] call failed:', e);
      setError(String(e?.message || e));
      setResults([]);
    }
    setLoading(false);
  }, [currentTrack]);

  const handleOpen = useCallback(() => {
    if (!currentTrack) return;
    setOpen(true);
    setQueryText('');
    runSearch('');
  }, [currentTrack, runSearch]);

  // Programmatic open (studio): the host bumps `openRequest` to pop the
  // modal without the built-in trigger button.
  const lastOpenReq = React.useRef(0);
  React.useEffect(() => {
    if (openRequest > 0 && openRequest !== lastOpenReq.current) {
      lastOpenReq.current = openRequest;
      handleOpen();
    }
  }, [openRequest, handleOpen]);

  // Signature of a lyrics body: strip LRC timestamps, take the first handful
  // of non-empty lines, normalize. Lets us tell which listed candidate is the
  // one currently applied — whether it got there via this picker or the
  // automatic fetch — without depending on an id we may not have.
  const sigOf = (text) => String(text || '')
    .replace(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g, '')
    .split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 6).join(' ')
    .toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const appliedSig = sigOf(appliedText);
  const targetSec = Number(currentTrack?.duration) || 0;

  // --- Dedupe --------------------------------------------------------
  // LRCLIB stores one entry per (track, album, uploader), so a popular song
  // returns a wall of entries carrying the EXACT same lyrics. Picking
  // "another" one changed nothing visible — which read as "is this even
  // working?". Collapse rows whose full body is byte-identical (synced text
  // INCLUDING timestamps — same words with different timing is a genuinely
  // different version and stays separate, labelled below). Representative:
  // the entry whose duration is closest to the playing track.
  const normBody = (t) => String(t || '')
    .split('\n').map((s) => s.trim()).filter(Boolean).join('\n');
  const groups = new Map();
  for (const c of results) {
    const key = c.syncedLyrics
      ? `S:${normBody(c.syncedLyrics)}`
      : `P:${normBody(c.plainLyrics)}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { rep: c, count: 1 });
    } else {
      g.count += 1;
      const dNew = (targetSec > 0 && c.duration > 0) ? Math.abs(c.duration - targetSec) : 1e9;
      const dOld = (targetSec > 0 && g.rep.duration > 0) ? Math.abs(g.rep.duration - targetSec) : 1e9;
      // Keep the closest-duration entry as the face of the group, but if
      // the applied id is in this group, IT must stay the representative
      // so the ✓ applied marker can find it.
      const repIsApplied = appliedId != null && g.rep.id != null && String(g.rep.id) === String(appliedId);
      const newIsApplied = appliedId != null && c.id != null && String(c.id) === String(appliedId);
      if (newIsApplied || (!repIsApplied && dNew < dOld)) g.rep = c;
    }
  }
  // Annotate: source count, first-line preview, and same-words-different-
  // timing detection (words-sig collision with an earlier kept row).
  const seenWordSigs = new Map();
  const rows = [...groups.values()].map(({ rep, count }, idx) => {
    const wordsSig = sigOf(rep.syncedLyrics || rep.plainLyrics || '');
    const altTiming = wordsSig && seenWordSigs.has(wordsSig);
    if (wordsSig && !altTiming) seenWordSigs.set(wordsSig, idx);
    const rawFirst = String(rep.plainLyrics || rep.syncedLyrics || '')
      .replace(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g, '')
      .split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
    return { rep, count, altTiming, preview: rawFirst };
  });

  // Exactly one row is ever "applied". Prefer an exact LRCLIB id match; if we
  // don't know the id (auto-fetched lyrics), fall back to the words-signature
  // but choose a single winner (closest duration) so multiple near-identical
  // versions of the same song don't all light up — and switching works.
  const appliedIndex = (() => {
    if (appliedId != null) {
      const byId = rows.findIndex(({ rep }) => rep.id != null && String(rep.id) === String(appliedId));
      if (byId >= 0) return byId;
    }
    if (!appliedSig) return -1;
    let best = -1; let bestDelta = Infinity;
    rows.forEach(({ rep }, i) => {
      if (sigOf(rep.syncedLyrics || rep.plainLyrics || '') !== appliedSig) return;
      const d = (targetSec > 0 && rep.duration > 0) ? Math.abs(rep.duration - targetSec) : 1e9;
      if (d < bestDelta) { bestDelta = d; best = i; }
    });
    return best;
  })();
  const matchColor = (absDelta) => {
    if (absDelta == null) return 'rgba(255,255,255,0.45)';
    if (absDelta <= 2) return '#5fd08a';
    if (absDelta <= 5) return '#e3c15a';
    return '#e57373';
  };

  return (
    <>
      {/* `hideTrigger` was declared but never honoured — the button was only
          made invisible via `visible`, so it stayed in the DOM as a 28px
          click-dead element pinned to the pane's top-right, overlapping
          whatever toolbar the host put there. Hosts that drive the modal
          through `openRequest` and supply their own button now get no
          trigger at all, which is what the prop always promised. */}
      {hideTrigger ? null : (
      <button type="button"
        onClick={handleOpen}
        title="Browse lyrics versions"
        aria-label="Browse lyrics versions"
        style={{
          position: 'absolute', top: 4, right: 72,
          width: 28, height: 28, borderRadius: 8,
          border: '1px solid rgba(255,255,255,0.08)',
          background: 'rgba(0,0,0,0.45)',
          color: 'rgba(255,255,255,0.75)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
          backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
          opacity: visible ? 1 : 0,
          pointerEvents: visible ? 'auto' : 'none',
          transform: visible ? 'translateY(0)' : 'translateY(-4px)',
          transition: 'opacity 0.18s ease, transform 0.18s ease, background 0.15s, color 0.15s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.background = 'rgba(0,0,0,0.7)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.75)'; e.currentTarget.style.background = 'rgba(0,0,0,0.45)'; }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      )}

      {open ? createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.45)' }}
            onClick={() => setOpen(false)} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 201,
            width: 'min(520px, 90vw)', maxHeight: '75vh',
            background: 'rgba(18,18,20,0.62)',
            backdropFilter: 'blur(30px) saturate(1.6)',
            WebkitBackdropFilter: 'blur(30px) saturate(1.6)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 16,
            boxShadow: '0 24px 60px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.07)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            {/* Header */}
            <div style={{ padding: '14px 18px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>Choose lyrics version</div>
                {currentTrack ? (
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 3 }}>
                    {currentTrack.artist} — {currentTrack.title}
                  </div>
                ) : null}
              </div>
              <button type="button" onClick={() => setOpen(false)}
                style={{ width: 26, height: 26, borderRadius: 7, border: 'none', background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = 'rgba(255,255,255,0.6)'; }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
              </button>
            </div>

            {/* Manual search — recovery path when the track's tags and
                LRCLIB disagree (e.g. the artist changed names and LRCLIB
                only knows the old one). */}
            <div style={{ padding: '10px 12px 8px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', gap: 6, flexShrink: 0 }}>
              <input
                type="text"
                value={queryText}
                onChange={(e) => setQueryText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !loading) runSearch(queryText);
                  e.stopPropagation();
                }}
                placeholder={`Search LRCLIB… e.g. an old artist name (current: ${currentTrack?.artist || ''} ${currentTrack?.title || ''})`}
                style={{
                  flex: 1, padding: '7px 10px', borderRadius: 8,
                  border: '1px solid rgba(255,255,255,0.1)',
                  background: 'rgba(255,255,255,0.05)',
                  color: '#fff', fontSize: 11.5, outline: 'none',
                }}
              />
              <button type="button"
                onClick={() => { if (!loading) runSearch(queryText); }}
                disabled={loading}
                style={{
                  padding: '7px 14px', borderRadius: 8, border: 'none',
                  background: `rgba(${accent},0.3)`,
                  color: '#fff', fontSize: 11.5, fontWeight: 700, cursor: loading ? 'default' : 'pointer',
                  opacity: loading ? 0.5 : 1,
                }}>
                Search
              </button>
            </div>

            {/* Results */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 6, scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.15) transparent' }}>
              {loading ? (
                <div style={{ padding: '28px 16px', textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>
                  Searching LRCLIB…
                </div>
              ) : results.length === 0 ? (
                <div style={{ padding: '28px 16px', textAlign: 'center', color: 'rgba(255,255,255,0.45)', fontSize: 12, lineHeight: 1.6 }}>
                  {error
                    ? <><div style={{ color: '#f37272', marginBottom: 6 }}>Error searching LRCLIB</div><div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.35)' }}>{error}</div></>
                    : 'No lyrics found on LRCLIB for this track\u2019s current tags \u2014 try searching above (an old artist name or alternate title often works).'}
                </div>
              ) : (
                rows.map(({ rep: c, count, altTiming, preview }, i) => {
                  const durStr = c.duration ? `${Math.floor(c.duration / 60)}:${String(Math.floor(c.duration % 60)).padStart(2, '0')}` : '';
                  const isApplied = i === appliedIndex;
                  const absDelta = targetSec > 0 && c.duration > 0 ? Math.abs(c.duration - targetSec) : null;
                  return (
                    <div key={c.id || i}
                      onClick={() => { onApply?.(c); setOpen(false); }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = `rgba(${accent},0.18)`; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = isApplied ? `rgba(${accent},0.1)` : 'transparent'; }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                        background: isApplied ? `rgba(${accent},0.1)` : 'transparent',
                        borderLeft: isApplied ? `3px solid rgb(${accent})` : '3px solid transparent',
                        transition: 'background 0.12s cubic-bezier(0.16,1,0.3,1)',
                      }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {c.trackName}
                        </div>
                        <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.45)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {c.artistName}{c.albumName ? ` · ${c.albumName}` : ''}
                          {durStr ? <> · <span style={{ color: matchColor(absDelta), fontWeight: 600 }}>{durStr}</span></> : null}
                          {count > 1 ? <span style={{ color: 'rgba(255,255,255,0.3)' }}> · {count} identical sources</span> : null}
                        </div>
                        {/* First line of the lyrics — makes each version
                            visibly distinct at a glance, so "did anything
                            change?" answers itself before clicking. */}
                        {preview ? (
                          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', fontStyle: 'italic', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            “{preview}”
                          </div>
                        ) : null}
                      </div>
                      <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }}>
                        {isApplied ? (
                          <span style={{
                            padding: '3px 7px', borderRadius: 6, fontSize: 9, fontWeight: 700,
                            letterSpacing: '0.06em', textTransform: 'uppercase',
                            background: `rgba(${accent},0.28)`, color: '#fff',
                            border: `1px solid rgba(${accent},0.5)`,
                          }}>✓ applied</span>
                        ) : null}
                        {altTiming ? (
                          <span style={{
                            padding: '3px 7px', borderRadius: 6, fontSize: 9, fontWeight: 700,
                            letterSpacing: '0.06em', textTransform: 'uppercase',
                            background: 'rgba(227,193,90,0.15)', color: '#f0d08a',
                            border: '1px solid rgba(227,193,90,0.35)',
                          }} title="Same words as a version above, but with different line timings">alt timing</span>
                        ) : null}
                        {c.hasSynced ? (
                          <span style={{
                            padding: '3px 7px', borderRadius: 6, fontSize: 9, fontWeight: 700,
                            letterSpacing: '0.06em', textTransform: 'uppercase',
                            background: `rgba(${accent},0.25)`, color: '#fff',
                          }}>synced</span>
                        ) : null}
                        {c.hasPlain ? (
                          <span style={{
                            padding: '3px 7px', borderRadius: 6, fontSize: 9, fontWeight: 700,
                            letterSpacing: '0.06em', textTransform: 'uppercase',
                            background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.6)',
                          }}>plain</span>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </>,
        document.body
      ) : null}
    </>
  );
}
