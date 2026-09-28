import React, { useState, useEffect, useRef, useCallback } from 'react';
import Icons from './Icons.jsx';
import { formatTime, getFileFormatLabel, parseGenres, formatGenres, hasGenre } from './mediaUtils.js';

/**
 * Genre chips.
 *
 * Genres are stored as one delimited string (see parseGenres in mediaUtils),
 * so the value in and out of this control is still a plain string — nothing
 * downstream has to know it came from a chip UI. What the chips buy is that
 * the boundaries become explicit: typing "Hip Hop, R&B" into a text box left
 * you guessing whether that was one genre or two, and the old field silently
 * stored it as one.
 *
 * Enter or comma commits the current word; Backspace on an empty field
 * removes the last chip, which is the behaviour every other tag input has.
 */
function GenreChips({ value, onChange, accent, inputStyle, placeholder = 'Add a genre…' }) {
  const genres = parseGenres(value);
  const [draft, setDraft] = useState('');
  const commit = (raw) => {
    const next = parseGenres(raw);
    if (!next.length) { setDraft(''); return; }
    // parseGenres already dedupes within the addition; hasGenre stops it
    // colliding with a chip that's already there under different casing.
    const merged = [...genres];
    for (const g of next) if (!hasGenre(merged, g)) merged.push(g);
    onChange(formatGenres(merged));
    setDraft('');
  };
  const removeAt = (i) => onChange(formatGenres(genres.filter((_, n) => n !== i)));
  return (
    <div
      style={{ ...inputStyle, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5, minHeight: 34, height: 'auto', cursor: 'text', padding: '5px 8px' }}
      onClick={(e) => { const inp = e.currentTarget.querySelector('input'); if (inp) inp.focus(); }}
    >
      {genres.map((g, i) => (
        <span key={`${g}-${i}`} style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: '100%',
          padding: '3px 5px 3px 9px', borderRadius: 999, fontSize: 11.5, fontWeight: 650,
          background: `rgba(${accent},0.16)`, color: `rgb(${accent})`, border: `1px solid rgba(${accent},0.32)`,
        }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g}</span>
          <button type="button" onClick={(e) => { e.stopPropagation(); removeAt(i); }} aria-label={`Remove ${g}`} title={`Remove ${g}`}
            style={{
              width: 15, height: 15, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 0, border: 'none', borderRadius: '50%', cursor: 'pointer',
              background: `rgba(${accent},0.22)`, color: `rgb(${accent})`,
            }}>
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(e) => {
          // A separator typed mid-word commits immediately, so pasting
          // "Rock, Metal, Jazz" lands as three chips rather than one.
          if (/[;,|]/.test(e.target.value)) commit(e.target.value);
          else setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(draft); }
          else if (e.key === 'Backspace' && !draft && genres.length) { e.preventDefault(); removeAt(genres.length - 1); }
        }}
        onBlur={() => commit(draft)}
        placeholder={genres.length ? '' : placeholder}
        style={{
          flex: 1, minWidth: 90, border: 'none', outline: 'none', background: 'transparent',
          color: '#fff', font: 'inherit', fontSize: 12.5, padding: '3px 2px',
        }}
      />
    </div>
  );
}


function MetadataEditor({ track, onSave, onClose, accent }) {
  const [title, setTitle] = useState(track.title || '');
  const [artist, setArtist] = useState(track.artist || '');
  const [album, setAlbum] = useState(track.album || '');
  const [year, setYear] = useState(track.year != null ? String(track.year) : '');
  const [genre, setGenre] = useState(track.genre || '');
  const [trackNumber, setTrackNumber] = useState(track.trackNumber != null ? String(track.trackNumber) : '');
  const [discNumber, setDiscNumber] = useState(track.discNumber != null ? String(track.discNumber) : '');
  // Explicit flag — boolean only. The DB stores 0/1/null but for the
  // UI we treat null and 0 the same way (no E badge). Initialize from
  // whatever the DB has, coerced to a clean boolean.
  const [explicit, setExplicit] = useState(track.explicit === 1 || track.explicit === true);
  // Cover art — null = removed, string = current data URI or URL
  const [coverArt, setCoverArt] = useState(track.coverArt || null);
  const [coverDirty, setCoverDirty] = useState(false); // tracks whether user changed the cover
  const [coverMode, setCoverMode] = useState('preview'); // 'preview' | 'url'
  const [urlInput, setUrlInput] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [coverHover, setCoverHover] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Online refetch — busy flag plus a note about what the lookup found.
  const [refetching, setRefetching] = useState(false);
  const [refetchNote, setRefetchNote] = useState('');

  const fileInputRef = useRef(null);
  const firstInputRef = useRef(null);

  /* Pull this track's details from the online catalogue into the form as
     PENDING edits. Deliberately not a save: the usual reason to press this is
     to make a local file agree with its downloaded twin, and you want to see
     what it is about to agree to first. A lookup that silently overwrote a
     hand-corrected album name would be worse than no button at all. Nothing is
     written until Save; Cancel discards it like any other edit. */
  const handleRefetch = useCallback(async () => {
    if (refetching) return;
    setRefetching(true);
    setRefetchNote('');
    setError('');
    try {
      const api = window.electronAPI;
      if (!api?.refetchTrackMetadata) {
        setError('Metadata refetch is unavailable in this build.');
        return;
      }
      const res = await api.refetchTrackMetadata(track.id);
      if (!res?.ok) {
        setError(res?.error || 'Could not refetch metadata.');
        return;
      }
      const m = res.match || {};
      const changed = [];
      const applyIf = (value, current, setter, label) => {
        if (value == null || value === '') return;
        const next = String(value);
        if (next.trim() === String(current ?? '').trim()) return;
        setter(next);
        changed.push(label);
      };
      applyIf(m.title, title, setTitle, 'title');
      applyIf(m.artist, artist, setArtist, 'artist');
      applyIf(m.album, album, setAlbum, 'album');
      applyIf(m.year, year, setYear, 'year');
      applyIf(m.genre, genre, setGenre, 'genre');
      applyIf(m.trackNumber, trackNumber, setTrackNumber, 'track no.');
      applyIf(m.discNumber, discNumber, setDiscNumber, 'disc no.');
      if (typeof m.explicit === 'boolean' && m.explicit !== explicit) {
        setExplicit(m.explicit);
        changed.push('explicit');
      }
      if (m.coverArt && m.coverArt !== coverArt) {
        setCoverArt(m.coverArt);
        setCoverDirty(true);
        setCoverMode('preview');
        changed.push('cover');
      }
      setRefetchNote(changed.length
        ? `${res.source}: updated ${changed.join(', ')} — review, then Save.`
        : `${res.source}: everything already matches.`);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setRefetching(false);
    }
  }, [refetching, track.id, title, artist, album, year, genre, trackNumber, discNumber, explicit, coverArt]);

  // Dirty-state check — only submit changed fields
  const initialExplicit = track.explicit === 1 || track.explicit === true;
  const hasChanges
    = title.trim() !== (track.title || '').trim()
    || artist.trim() !== (track.artist || '').trim()
    || album.trim() !== (track.album || '').trim()
    || year.trim() !== (track.year != null ? String(track.year) : '').trim()
    || formatGenres(genre) !== formatGenres(track.genre)
    || trackNumber.trim() !== (track.trackNumber != null ? String(track.trackNumber) : '').trim()
    || discNumber.trim() !== (track.discNumber != null ? String(track.discNumber) : '').trim()
    || explicit !== initialExplicit
    || coverDirty;

  useEffect(() => {
    firstInputRef.current?.focus();
    firstInputRef.current?.select();
  }, []);

  // Close on Escape
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const readFileToDataUri = (file) => new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('File must be an image.'));
      return;
    }
    if (file.size > 25_000_000) {
      reject(new Error('Image too large (max 25MB source file).'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read image.'));
    reader.readAsDataURL(file);
  });

  const handleFileSelect = async (file) => {
    if (!file) return;
    setError('');
    try {
      const data = await readFileToDataUri(file);
      if (data.length > 35_000_000) {
        setError('Image too large after encoding. Try a smaller image (~25MB source or less).');
        return;
      }
      setCoverArt(data);
      setCoverDirty(true);
      setCoverMode('preview');
    } catch (e) {
      setError(e?.message || 'Could not load image.');
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFileSelect(file);
  };

  const handleUrlApply = () => {
    const u = urlInput.trim();
    if (!u) {
      setCoverArt(null);
      setCoverDirty(true);
      setCoverMode('preview');
      setUrlInput('');
      return;
    }
    if (!/^https?:\/\//i.test(u)) {
      setError('URL must start with http:// or https://');
      return;
    }
    setError('');
    setCoverArt(u);
    setCoverDirty(true);
    setCoverMode('preview');
    setUrlInput('');
  };

  const handleRemoveCover = () => {
    setCoverArt(null);
    setCoverDirty(true);
    setCoverMode('preview');
    setError('');
  };

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (!hasChanges || saving) return;
    setError('');
    setSaving(true);

    // Validate year
    const y = year.trim();
    if (y) {
      const n = Number(y);
      if (!Number.isFinite(n) || n < 1000 || n > 9999) {
        setError('Year must be 4 digits between 1000 and 9999 (or leave blank).');
        setSaving(false);
        return;
      }
    }

    // Validate track/disc numbers
    const tn = trackNumber.trim();
    if (tn) {
      const n = Number(tn);
      if (!Number.isFinite(n) || n < 1 || n > 9999) {
        setError('Track number must be between 1 and 9999 (or leave blank).');
        setSaving(false);
        return;
      }
    }
    const dn = discNumber.trim();
    if (dn) {
      const n = Number(dn);
      if (!Number.isFinite(n) || n < 1 || n > 99) {
        setError('Disc number must be between 1 and 99 (or leave blank).');
        setSaving(false);
        return;
      }
    }

    const fields = {};
    if (title.trim() !== (track.title || '').trim()) fields.title = title.trim();
    if (artist.trim() !== (track.artist || '').trim()) fields.artist = artist.trim();
    if (album.trim() !== (track.album || '').trim()) fields.album = album.trim();
    if (y !== (track.year != null ? String(track.year) : '').trim()) {
      fields.year = y ? Number(y) : null;
    }
    if (formatGenres(genre) !== formatGenres(track.genre)) fields.genre = formatGenres(genre);
    if (tn !== (track.trackNumber != null ? String(track.trackNumber) : '').trim()) {
      fields.trackNumber = tn ? Number(tn) : null;
    }
    if (dn !== (track.discNumber != null ? String(track.discNumber) : '').trim()) {
      fields.discNumber = dn ? Number(dn) : null;
    }
    if (explicit !== initialExplicit) fields.explicit = explicit;
    if (coverDirty) fields.coverArt = coverArt;

    const r = await onSave(fields);
    setSaving(false);
    if (!r?.ok) setError(r?.error || 'Could not save.');
  };

  const inputStyle = {
    width: '100%', boxSizing: 'border-box', padding: '8px 11px', borderRadius: 9,
    background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)',
    color: '#fff', fontSize: 12.5, outline: 'none',
    transition: 'border-color 0.15s, background 0.15s',
  };

  const fieldLabelStyle = {
    fontSize: 10, color: 'rgba(255,255,255,0.55)', marginBottom: 4,
    fontWeight: 600, letterSpacing: '0.02em', textTransform: 'uppercase',
  };

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      style={{
        position: 'absolute', inset: 0, zIndex: 50,
        background: 'rgba(0,0,0,0.28)',
        // no backdrop blur on the scrim — let the panel's own glass sample the app, matching the context menu
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
    >
      <form onSubmit={handleSubmit}
        style={{
          width: 'min(460px, 100%)',
          maxHeight: 'calc(100vh - 80px)', overflowY: 'auto',
          borderRadius: 16,
          background: 'rgba(18,18,20,0.62)',
          backdropFilter: 'blur(30px) saturate(1.6)', WebkitBackdropFilter: 'blur(30px) saturate(1.6)',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.07)',
        }}>
        {/* Hidden file input */}
        <input ref={fileInputRef} type="file" accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFileSelect(file);
            e.target.value = ''; // allow re-selecting the same file
          }} />

        {/* Header with close button */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px 8px',
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>Edit metadata</div>
          <button type="button" onClick={onClose} title="Close" aria-label="Close"
            style={{
              width: 26, height: 26, borderRadius: 7, border: 'none',
              background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.55)',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 0, flexShrink: 0,
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = '#fff'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = 'rgba(255,255,255,0.55)'; }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Cover art + title/artist row */}
        <div style={{ display: 'flex', gap: 14, padding: '4px 16px 14px', alignItems: 'flex-start' }}>
          {/* Cover art editor */}
          <div style={{ flexShrink: 0 }}>
            <div
              onClick={() => fileInputRef.current?.click()}
              onMouseEnter={() => setCoverHover(true)}
              onMouseLeave={() => setCoverHover(false)}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              title="Click to choose image — or drop one here"
              style={{
                width: 96, height: 96, borderRadius: 14, overflow: 'hidden',
                background: coverArt
                  ? '#0f0f0f'
                  : `linear-gradient(150deg, rgba(${accent},0.22), rgba(${accent},0.06) 55%, rgba(255,255,255,0.02))`,
                cursor: 'pointer', position: 'relative',
                border: dragOver ? `2px solid rgba(${accent},0.85)` : '1px solid rgba(255,255,255,0.12)',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 6px 18px rgba(0,0,0,0.4)',
                transition: 'border-color 0.15s, transform 0.15s cubic-bezier(0.16,1,0.3,1)',
                transform: coverHover && !coverArt ? 'translateY(-1px)' : 'none',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
              {coverArt ? (
                <img src={coverArt} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              ) : (
                // Empty state — clear accent-tinted "add image" affordance.
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, color: coverHover ? `rgba(${accent},1)` : `rgba(${accent},0.9)`, opacity: coverHover ? 1 : 0.92, transition: 'opacity 0.15s, color 0.15s', pointerEvents: 'none' }}>
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="3" />
                    <circle cx="8.5" cy="8.5" r="1.6" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: coverHover ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.55)', transition: 'color 0.15s' }}>Add cover</span>
                </div>
              )}
              {/* Hover/drag overlay — only when there's already a cover (so it
                  replaces the image) or while dragging. On the empty state the
                  gradient "Add cover" affordance IS the hover cue, so we don't
                  stack a second label over it. Fully opaque so nothing bleeds. */}
              {((coverHover && coverArt) || dragOver) ? (
                <div style={{
                  position: 'absolute', inset: 0,
                  background: dragOver ? `rgba(${accent},0.5)` : 'rgba(12,12,14,0.82)',
                  backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  gap: 6, color: '#fff', fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
                  pointerEvents: 'none',
                }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                  <span>{dragOver ? 'Drop to set' : 'Change'}</span>
                </div>
              ) : null}
            </div>
            {/* Small action row under cover */}
            <div style={{ display: 'flex', gap: 5, marginTop: 8, justifyContent: 'center' }}>
              <button type="button" onClick={() => setCoverMode((m) => m === 'url' ? 'preview' : 'url')}
                title="Paste an image URL"
                style={{
                  padding: '4px 10px', borderRadius: 999,
                  border: coverMode === 'url' ? `1px solid rgba(${accent},0.5)` : '1px solid rgba(255,255,255,0.12)',
                  background: coverMode === 'url' ? `rgba(${accent},0.2)` : 'rgba(255,255,255,0.03)',
                  color: coverMode === 'url' ? '#fff' : 'rgba(255,255,255,0.6)',
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer',
                  transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease, transform 0.15s cubic-bezier(0.16,1,0.3,1)',
                }}>
                URL
              </button>
              {coverArt ? (
                <button type="button" onClick={handleRemoveCover}
                  title="Remove cover art"
                  style={{
                    padding: '4px 10px', borderRadius: 999,
                    border: '1px solid rgba(255,255,255,0.12)',
                    background: 'rgba(255,255,255,0.03)',
                    color: 'rgba(255,255,255,0.55)',
                    fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer',
                    transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease, transform 0.15s cubic-bezier(0.16,1,0.3,1)',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = '#f37272'; e.currentTarget.style.borderColor = 'rgba(243,114,114,0.4)'; e.currentTarget.style.background = 'rgba(243,114,114,0.1)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.55)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'; e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}>
                  Remove
                </button>
              ) : null}
            </div>
          </div>

          {/* Right side: track name preview + URL input when in URL mode */}
          <div style={{ flex: 1, minWidth: 0, paddingTop: 2 }}>
            {coverMode === 'url' ? (
              <>
                <div style={fieldLabelStyle}>Image URL</div>
                <input type="text" value={urlInput} onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleUrlApply(); } }}
                  placeholder="https://…/cover.jpg" style={inputStyle} autoFocus
                  onFocus={(e) => { e.currentTarget.style.borderColor = `rgba(${accent},0.5)`; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }} />
                <div style={{ display: 'flex', gap: 5, marginTop: 6 }}>
                  <button type="button" onClick={handleUrlApply}
                    style={{
                      padding: '4px 12px', borderRadius: 7, border: 'none',
                      background: `rgba(${accent},0.3)`, color: '#fff',
                      fontSize: 10.5, fontWeight: 700, cursor: 'pointer',
                    }}>
                    Apply
                  </button>
                  <button type="button" onClick={() => { setCoverMode('preview'); setUrlInput(''); }}
                    style={{
                      padding: '4px 12px', borderRadius: 7,
                      border: '1px solid rgba(255,255,255,0.1)',
                      background: 'transparent', color: 'rgba(255,255,255,0.7)',
                      fontSize: 10.5, fontWeight: 600, cursor: 'pointer',
                    }}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <div style={{
                fontSize: 11, color: 'rgba(255,255,255,0.5)', lineHeight: 1.5,
                display: 'flex', flexDirection: 'column', gap: 3,
              }}>
                <span style={{
                  color: 'rgba(255,255,255,0.9)', fontWeight: 700, fontSize: 12.5,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{track.title || 'Untitled'}</span>
                <span style={{
                  fontSize: 11, color: 'rgba(255,255,255,0.7)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{track.artist || '—'}</span>
                {(track.album || track.year) ? (
                  <span style={{
                    fontSize: 10.5, color: 'rgba(255,255,255,0.45)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {[track.album, track.year].filter(Boolean).join(' · ')}
                  </span>
                ) : null}
                {/* Compact fact chips fill the space below — format, length,
                    track no., and play count, each only when known. These are
                    read-only context while editing the fields below. */}
                {(() => {
                  const fmt = getFileFormatLabel(track.filePath);
                  const facts = [
                    fmt || null,
                    track.duration ? formatTime(track.duration) : null,
                    track.trackNumber != null && String(track.trackNumber).trim()
                      ? `Track ${track.trackNumber}` : null,
                    (Number(track.playCount) || 0) > 0
                      ? `${track.playCount} play${Number(track.playCount) === 1 ? '' : 's'}` : null,
                  ].filter(Boolean);
                  return facts.length ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 5 }}>
                      {facts.map((f, idx) => (
                        <span key={idx} style={{
                          padding: '2px 7px', borderRadius: 6,
                          fontSize: 9.5, fontWeight: 600, letterSpacing: 0.2,
                          background: 'rgba(255,255,255,0.05)',
                          border: '1px solid rgba(255,255,255,0.07)',
                          color: 'rgba(255,255,255,0.5)',
                          whiteSpace: 'nowrap',
                        }}>{f}</span>
                      ))}
                    </div>
                  ) : null;
                })()}
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginTop: 5 }}>
                  Click cover to choose an image, drop one in, or paste a URL.
                </span>
              </div>
            )}
          </div>
        </div>

        <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '0 16px' }} />

        {/* Form body */}
        <div style={{ padding: '14px 16px 12px' }}>
          <div style={fieldLabelStyle}>Title</div>
          <input ref={firstInputRef} type="text" value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="Song title" style={{ ...inputStyle, marginBottom: 10 }}
            onFocus={(e) => { e.currentTarget.style.borderColor = `rgba(${accent},0.5)`; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }} />

          <div style={fieldLabelStyle}>Artist</div>
          <input type="text" value={artist} onChange={(e) => setArtist(e.target.value)}
            placeholder="Artist" style={{ ...inputStyle, marginBottom: 10 }}
            onFocus={(e) => { e.currentTarget.style.borderColor = `rgba(${accent},0.5)`; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }} />

          <div style={fieldLabelStyle}>Album</div>
          <input type="text" value={album} onChange={(e) => setAlbum(e.target.value)}
            placeholder="Album" style={{ ...inputStyle, marginBottom: 10 }}
            onFocus={(e) => { e.currentTarget.style.borderColor = `rgba(${accent},0.5)`; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }} />

          {/* Year + Genre side by side */}
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: '0 0 90px' }}>
              <div style={fieldLabelStyle}>Year</div>
              <input type="text" inputMode="numeric" maxLength={4} value={year}
                onChange={(e) => setYear(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="2024" style={inputStyle}
                onFocus={(e) => { e.currentTarget.style.borderColor = `rgba(${accent},0.5)`; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={fieldLabelStyle}>Genres</div>
              <GenreChips value={genre} onChange={setGenre} accent={accent} inputStyle={inputStyle} />
            </div>
          </div>

          {/* Track # + Disc # side by side */}
          <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={fieldLabelStyle}>Track #</div>
              <input type="text" inputMode="numeric" maxLength={4} value={trackNumber}
                onChange={(e) => setTrackNumber(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="1" style={inputStyle}
                onFocus={(e) => { e.currentTarget.style.borderColor = `rgba(${accent},0.5)`; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={fieldLabelStyle}>Disc #</div>
              <input type="text" inputMode="numeric" maxLength={2} value={discNumber}
                onChange={(e) => setDiscNumber(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="1" style={inputStyle}
                onFocus={(e) => { e.currentTarget.style.borderColor = `rgba(${accent},0.5)`; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }} />
            </div>
          </div>

          {/* Explicit toggle. Two-state — on or off. Off covers both
              "clean" and "unset" since the UI doesn't distinguish them
              (the E badge only shows when explicit === true). */}
          <div
            onClick={() => setExplicit((v) => !v)}
            style={{
              marginTop: 12,
              display: 'flex', alignItems: 'center', gap: 11,
              padding: '10px 12px', borderRadius: 9,
              background: explicit ? `rgba(${accent},0.10)` : 'rgba(0,0,0,0.25)',
              border: `1px solid ${explicit ? `rgba(${accent},0.45)` : 'rgba(255,255,255,0.08)'}`,
              cursor: 'pointer',
              transition: 'background 0.15s, border-color 0.15s',
              userSelect: 'none',
            }}
          >
            {/* Big E pill that visually mirrors the actual badge so the
                user can see exactly what flipping this does. */}
            <div style={{
              width: 22, height: 22, borderRadius: 5,
              background: explicit ? `rgb(${accent})` : 'rgba(255,255,255,0.08)',
              color: explicit ? '#000' : 'rgba(255,255,255,0.4)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 800, letterSpacing: 0,
              flexShrink: 0,
              transition: 'background 0.15s, color 0.15s',
            }}>
              E
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: '#fff', fontWeight: 500 }}>
                Explicit
              </div>
              <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.55)', marginTop: 1 }}>
                {explicit
                  ? 'Shows the E badge in your library.'
                  : 'No E badge. Tap to mark this track as explicit.'}
              </div>
            </div>
          </div>

          {error ? (
            <div style={{
              marginTop: 10, padding: '7px 10px', borderRadius: 8,
              background: 'rgba(243,114,114,0.1)', border: '1px solid rgba(243,114,114,0.3)',
              color: '#f37272', fontSize: 10.5, lineHeight: 1.4,
            }}>
              {error}
            </div>
          ) : null}

          {refetchNote ? (
            <div style={{
              marginTop: 10, padding: '7px 10px', borderRadius: 8,
              background: `rgba(${accent},0.10)`, border: `1px solid rgba(${accent},0.28)`,
              color: 'rgba(255,255,255,0.8)', fontSize: 10.5, lineHeight: 1.4,
            }}>
              {refetchNote}
            </div>
          ) : null}

          <div style={{
            marginTop: 10, fontSize: 9.5, color: 'rgba(255,255,255,0.35)',
            lineHeight: 1.4,
          }}>
            Changes are saved to the library only — the audio file is not modified.
          </div>
        </div>

        {/* Footer actions */}
        <div style={{
          display: 'flex', gap: 8, padding: '12px 16px 14px',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(0,0,0,0.15)',
          alignItems: 'center',
        }}>
          {/* Read-only file format pill. Not editable — it's a property
              of the file on disk, derived from the path extension. The
              underlying audio file type isn't something the user can
              change without re-encoding, so we surface it for awareness
              rather than for editing. */}
          {(() => {
            const fmt = getFileFormatLabel(track.filePath);
            return fmt ? (
              <div title={`Audio file format: ${fmt}`}
                style={{
                  padding: '4px 9px', borderRadius: 7,
                  fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: 'rgba(255,255,255,0.55)',
                  whiteSpace: 'nowrap',
                  fontFamily: 'ui-monospace, SF Mono, Menlo, Consolas, monospace',
                }}>
                {fmt}
              </div>
            ) : null;
          })()}
          <button type="button" onClick={handleRefetch} disabled={refetching || saving}
            title="Look this track up in the online catalogue and fill in what it finds"
            style={{
              padding: '8px 12px', borderRadius: 9,
              border: '1px solid rgba(255,255,255,0.1)',
              background: 'transparent',
              color: refetching ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.75)',
              fontSize: 11.5, fontWeight: 600,
              cursor: refetching || saving ? 'default' : 'pointer',
              whiteSpace: 'nowrap',
              transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease',
            }}
            onMouseEnter={(e) => { if (!refetching && !saving) { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = '#fff'; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = refetching ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.75)'; }}>
            {refetching ? 'Looking up…' : 'Refetch'}
          </button>
          <button type="button" onClick={onClose}
            style={{
              flex: 1, padding: '8px 14px', borderRadius: 9,
              border: '1px solid rgba(255,255,255,0.1)',
              background: 'transparent', color: 'rgba(255,255,255,0.75)',
              fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
              transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease, transform 0.15s cubic-bezier(0.16,1,0.3,1)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = '#fff'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.75)'; }}>
            Cancel
          </button>
          <button type="submit" disabled={!hasChanges || saving}
            style={{
              flex: 1, padding: '8px 14px', borderRadius: 9, border: 'none',
              background: !hasChanges || saving ? 'rgba(255,255,255,0.06)' : `rgba(${accent},0.3)`,
              color: !hasChanges || saving ? 'rgba(255,255,255,0.35)' : '#fff',
              fontSize: 11.5, fontWeight: 700,
              cursor: !hasChanges || saving ? 'default' : 'pointer',
              transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease, transform 0.15s cubic-bezier(0.16,1,0.3,1)',
              boxShadow: !hasChanges || saving ? 'none' : `0 2px 12px rgba(${accent},0.2)`,
            }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}


/**
 * AlbumMetadataEditor — edit album-level metadata (album name, artist, year,
 * genre, cover art) across all tracks in an album, or scoped to a single disc.
 *
 * scope: { album, artist, coverArt, trackIds, sampleTrack, discNumber }
 *   discNumber === null  → whole-album scope
 *   discNumber === 1,2,… → only tracks on that disc
 */
function AlbumMetadataEditor({ scope, onSave, onClose, accent }) {
  const { album: initAlbum, artist: initArtist, coverArt: initCover, sampleTrack, trackIds, discNumber } = scope;

  // Year/genre come from the sample track — since the grouping logic already
  // treats album metadata as consistent per-album, this is safe.
  const initYear = sampleTrack?.year != null ? String(sampleTrack.year) : '';
  const initGenre = sampleTrack?.genre || '';

  const [albumName, setAlbumName] = useState(initAlbum || '');
  const [artist, setArtist] = useState(initArtist || '');
  const [year, setYear] = useState(initYear);
  const [genre, setGenre] = useState(initGenre);
  // Explicit flag for bulk editor — TRI-state since some tracks in the
  // selection might be explicit and others not. Values:
  //   null       — leave each track's existing flag alone (default)
  //   true       — mark every selected track as explicit
  //   false      — mark every selected track as NOT explicit
  const [explicitBulk, setExplicitBulk] = useState(null);
  const [coverArt, setCoverArt] = useState(initCover || null);
  const [coverDirty, setCoverDirty] = useState(false);
  const [coverMode, setCoverMode] = useState('preview'); // 'preview' | 'url'
  const [urlInput, setUrlInput] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [coverHover, setCoverHover] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const fileInputRef = useRef(null);
  const firstInputRef = useRef(null);

  const hasChanges
    = albumName.trim() !== (initAlbum || '').trim()
    || artist.trim() !== (initArtist || '').trim()
    || year.trim() !== initYear.trim()
    || formatGenres(genre) !== formatGenres(initGenre)
    || explicitBulk !== null
    || coverDirty;

  useEffect(() => {
    firstInputRef.current?.focus();
    firstInputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const readFileToDataUri = (file) => new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('File must be an image.'));
      return;
    }
    if (file.size > 25_000_000) {
      reject(new Error('Image too large (max 25MB source file).'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read image.'));
    reader.readAsDataURL(file);
  });

  const handleFileSelect = async (file) => {
    if (!file) return;
    setError('');
    try {
      const data = await readFileToDataUri(file);
      if (data.length > 35_000_000) {
        setError('Image too large after encoding. Try a smaller image (~25MB source or less).');
        return;
      }
      setCoverArt(data);
      setCoverDirty(true);
      setCoverMode('preview');
    } catch (e) {
      setError(e?.message || 'Could not load image.');
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFileSelect(file);
  };

  const handleUrlApply = () => {
    const u = urlInput.trim();
    if (!u) {
      setCoverArt(null);
      setCoverDirty(true);
      setCoverMode('preview');
      setUrlInput('');
      return;
    }
    if (!/^https?:\/\//i.test(u)) {
      setError('URL must start with http:// or https://');
      return;
    }
    setError('');
    setCoverArt(u);
    setCoverDirty(true);
    setCoverMode('preview');
    setUrlInput('');
  };

  const handleRemoveCover = () => {
    setCoverArt(null);
    setCoverDirty(true);
    setCoverMode('preview');
    setError('');
  };

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (!hasChanges || saving) return;
    setError('');
    setSaving(true);

    const y = year.trim();
    if (y) {
      const n = Number(y);
      if (!Number.isFinite(n) || n < 1000 || n > 9999) {
        setError('Year must be 4 digits between 1000 and 9999 (or leave blank).');
        setSaving(false);
        return;
      }
    }

    const fields = {};
    if (albumName.trim() !== (initAlbum || '').trim()) fields.album = albumName.trim();
    if (artist.trim() !== (initArtist || '').trim()) fields.artist = artist.trim();
    if (y !== initYear.trim()) fields.year = y ? Number(y) : null;
    if (formatGenres(genre) !== formatGenres(initGenre)) fields.genre = formatGenres(genre);
    if (explicitBulk !== null) fields.explicit = explicitBulk;
    if (coverDirty) fields.coverArt = coverArt;

    const r = await onSave(fields);
    setSaving(false);
    if (!r?.ok) setError(r?.error || 'Could not save.');
  };

  const inputStyle = {
    width: '100%', boxSizing: 'border-box', padding: '8px 11px', borderRadius: 9,
    background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)',
    color: '#fff', fontSize: 12.5, outline: 'none',
    transition: 'border-color 0.15s, background 0.15s',
  };

  const fieldLabelStyle = {
    fontSize: 10, color: 'rgba(255,255,255,0.55)', marginBottom: 4,
    fontWeight: 600, letterSpacing: '0.02em', textTransform: 'uppercase',
  };

  const titleText = discNumber != null ? `Edit disc ${discNumber}` : 'Edit album';
  const scopeText = discNumber != null
    ? `${trackIds.length} tracks on disc ${discNumber} of “${initAlbum}”`
    : `${trackIds.length} tracks in “${initAlbum}”`;

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      style={{
        position: 'absolute', inset: 0, zIndex: 50,
        background: 'rgba(0,0,0,0.28)',
        // no backdrop blur on the scrim — let the panel's own glass sample the app, matching the context menu
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
    >
      <form onSubmit={handleSubmit}
        style={{
          width: 'min(460px, 100%)',
          maxHeight: 'calc(100vh - 80px)', overflowY: 'auto',
          borderRadius: 16,
          background: 'rgba(18,18,20,0.62)',
          backdropFilter: 'blur(30px) saturate(1.6)', WebkitBackdropFilter: 'blur(30px) saturate(1.6)',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.07)',
        }}>
        <input ref={fileInputRef} type="file" accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFileSelect(file);
            e.target.value = '';
          }} />

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px 8px',
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{titleText}</div>
          <button type="button" onClick={onClose} title="Close" aria-label="Close"
            style={{
              width: 26, height: 26, borderRadius: 7, border: 'none',
              background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.55)',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 0, flexShrink: 0,
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = '#fff'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = 'rgba(255,255,255,0.55)'; }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Cover + scope context */}
        <div style={{ display: 'flex', gap: 14, padding: '4px 16px 14px', alignItems: 'flex-start' }}>
          <div style={{ flexShrink: 0 }}>
            <div
              onClick={() => fileInputRef.current?.click()}
              onMouseEnter={() => setCoverHover(true)}
              onMouseLeave={() => setCoverHover(false)}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              title="Click to choose image — or drop one here"
              style={{
                width: 96, height: 96, borderRadius: 10, overflow: 'hidden',
                background: '#0f0f0f', cursor: 'pointer', position: 'relative',
                border: dragOver ? `2px solid rgba(${accent},0.8)` : '2px solid transparent',
                boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
                transition: 'border-color 0.15s',
              }}>
              {coverArt ? (
                <img src={coverArt} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              ) : (
                <div style={{
                  width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#2a2a2a', background: 'rgba(255,255,255,0.02)',
                }}>
                  <span style={{ transform: 'scale(1.8)' }}><Icons.AlbumSidebar /></span>
                </div>
              )}
              {(coverHover || dragOver) ? (
                <div style={{
                  position: 'absolute', inset: 0,
                  background: 'rgba(0,0,0,0.6)',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  gap: 4,
                  color: '#fff', fontSize: 10.5, fontWeight: 600,
                }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                  <span>{dragOver ? 'Drop to set' : coverArt ? 'Change' : 'Add cover'}</span>
                </div>
              ) : null}
            </div>
            <div style={{ display: 'flex', gap: 4, marginTop: 6, justifyContent: 'center' }}>
              <button type="button" onClick={() => setCoverMode((m) => m === 'url' ? 'preview' : 'url')}
                title="Paste an image URL"
                style={{
                  padding: '3px 8px', borderRadius: 6, border: 'none',
                  background: coverMode === 'url' ? 'rgba(255,255,255,0.12)' : 'transparent',
                  color: coverMode === 'url' ? '#fff' : 'rgba(255,255,255,0.55)',
                  fontSize: 9.5, fontWeight: 600, cursor: 'pointer',
                  transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease, transform 0.15s cubic-bezier(0.16,1,0.3,1)',
                }}>
                URL
              </button>
              {coverArt ? (
                <button type="button" onClick={handleRemoveCover}
                  title="Remove cover art"
                  style={{
                    padding: '3px 8px', borderRadius: 6, border: 'none',
                    background: 'transparent',
                    color: 'rgba(255,255,255,0.5)',
                    fontSize: 9.5, fontWeight: 600, cursor: 'pointer',
                    transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease, transform 0.15s cubic-bezier(0.16,1,0.3,1)',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = '#f37272'; e.currentTarget.style.background = 'rgba(243,114,114,0.1)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.5)'; e.currentTarget.style.background = 'transparent'; }}>
                  Remove
                </button>
              ) : null}
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 0, paddingTop: 2 }}>
            {coverMode === 'url' ? (
              <>
                <div style={fieldLabelStyle}>Image URL</div>
                <input type="text" value={urlInput} onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleUrlApply(); } }}
                  placeholder="https://…/cover.jpg" style={inputStyle} autoFocus
                  onFocus={(e) => { e.currentTarget.style.borderColor = `rgba(${accent},0.5)`; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }} />
                <div style={{ display: 'flex', gap: 5, marginTop: 6 }}>
                  <button type="button" onClick={handleUrlApply}
                    style={{
                      padding: '4px 12px', borderRadius: 7, border: 'none',
                      background: `rgba(${accent},0.3)`, color: '#fff',
                      fontSize: 10.5, fontWeight: 700, cursor: 'pointer',
                    }}>
                    Apply
                  </button>
                  <button type="button" onClick={() => { setCoverMode('preview'); setUrlInput(''); }}
                    style={{
                      padding: '4px 12px', borderRadius: 7,
                      border: '1px solid rgba(255,255,255,0.1)',
                      background: 'transparent', color: 'rgba(255,255,255,0.7)',
                      fontSize: 10.5, fontWeight: 600, cursor: 'pointer',
                    }}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <div style={{
                fontSize: 11, color: 'rgba(255,255,255,0.5)', lineHeight: 1.5,
                display: 'flex', flexDirection: 'column', gap: 4,
              }}>
                <span style={{ color: 'rgba(255,255,255,0.9)', fontWeight: 600, fontSize: 12 }}>
                  Applies to {scopeText}
                </span>
                {initArtist ? (
                  <span style={{
                    fontSize: 11, color: 'rgba(255,255,255,0.6)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{initArtist}</span>
                ) : null}
                {/* Read-only context chips fill the space — current album facts.
                    Each only shows when known. */}
                {(() => {
                  const fmt = getFileFormatLabel(sampleTrack?.filePath);
                  const facts = [
                    initYear || null,
                    (initGenre || '').trim() || null,
                    fmt || null,
                    `${trackIds.length} track${trackIds.length === 1 ? '' : 's'}`,
                  ].filter(Boolean);
                  return facts.length ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 4 }}>
                      {facts.map((f, idx) => (
                        <span key={idx} style={{
                          padding: '2px 8px', borderRadius: 6,
                          fontSize: 9.5, fontWeight: 600, letterSpacing: 0.2,
                          background: 'rgba(255,255,255,0.05)',
                          border: '1px solid rgba(255,255,255,0.07)',
                          color: 'rgba(255,255,255,0.5)', whiteSpace: 'nowrap',
                        }}>{f}</span>
                      ))}
                    </div>
                  ) : null;
                })()}
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.32)', marginTop: 4 }}>
                  All tracks in this {discNumber != null ? 'disc' : 'album'} will get these values.
                </span>
              </div>
            )}
          </div>
        </div>

        <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '0 16px' }} />

        {/* Form fields */}
        <div style={{ padding: '14px 16px 12px' }}>
          <div style={fieldLabelStyle}>Album</div>
          <input ref={firstInputRef} type="text" value={albumName} onChange={(e) => setAlbumName(e.target.value)}
            placeholder="Album name" style={{ ...inputStyle, marginBottom: 10 }}
            onFocus={(e) => { e.currentTarget.style.borderColor = `rgba(${accent},0.5)`; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }} />

          <div style={fieldLabelStyle}>Artist</div>
          <input type="text" value={artist} onChange={(e) => setArtist(e.target.value)}
            placeholder="Artist" style={{ ...inputStyle, marginBottom: 10 }}
            onFocus={(e) => { e.currentTarget.style.borderColor = `rgba(${accent},0.5)`; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }} />

          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: '0 0 90px' }}>
              <div style={fieldLabelStyle}>Year</div>
              <input type="text" inputMode="numeric" maxLength={4} value={year}
                onChange={(e) => setYear(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="2024" style={inputStyle}
                onFocus={(e) => { e.currentTarget.style.borderColor = `rgba(${accent},0.5)`; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={fieldLabelStyle}>Genres</div>
              <GenreChips value={genre} onChange={setGenre} accent={accent} inputStyle={inputStyle} />
            </div>
          </div>

          {/* Explicit flag — tri-state in bulk because some tracks in
              the selection might be explicit and others not. "Leave
              unchanged" doesn't touch the field; "Explicit" / "Clean"
              force the value across every selected track. */}
          <div style={{ marginTop: 12 }}>
            <div style={fieldLabelStyle}>Explicit</div>
            <div style={{
              display: 'flex', gap: 6,
              background: 'rgba(0,0,0,0.25)',
              padding: 4, borderRadius: 9,
              border: '1px solid rgba(255,255,255,0.06)',
            }}>
              {[
                { value: null, label: 'Leave unchanged' },
                { value: true, label: 'Mark all explicit' },
                { value: false, label: 'Mark all clean' },
              ].map((opt) => {
                const active = explicitBulk === opt.value;
                return (
                  <button
                    key={String(opt.value)}
                    type="button"
                    onClick={() => setExplicitBulk(opt.value)}
                    style={{
                      flex: 1, padding: '6px 8px',
                      borderRadius: 6, border: 'none',
                      background: active ? `rgba(${accent},0.22)` : 'transparent',
                      color: active ? '#fff' : 'rgba(255,255,255,0.55)',
                      fontSize: 10.5, fontWeight: 600,
                      cursor: 'pointer',
                      transition: 'background 0.15s, color 0.15s',
                    }}
                    onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                    onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {error ? (
            <div style={{
              marginTop: 10, padding: '7px 10px', borderRadius: 8,
              background: 'rgba(243,114,114,0.1)', border: '1px solid rgba(243,114,114,0.3)',
              color: '#f37272', fontSize: 10.5, lineHeight: 1.4,
            }}>
              {error}
            </div>
          ) : null}

          <div style={{
            marginTop: 10, fontSize: 9.5, color: 'rgba(255,255,255,0.35)',
            lineHeight: 1.4,
          }}>
            Changes are saved to the library only — audio files are not modified.
          </div>
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', gap: 8, padding: '12px 16px 14px',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(0,0,0,0.15)',
        }}>
          <button type="button" onClick={onClose}
            style={{
              flex: 1, padding: '8px 14px', borderRadius: 9,
              border: '1px solid rgba(255,255,255,0.1)',
              background: 'transparent', color: 'rgba(255,255,255,0.75)',
              fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
              transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease, transform 0.15s cubic-bezier(0.16,1,0.3,1)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = '#fff'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.75)'; }}>
            Cancel
          </button>
          <button type="submit" disabled={!hasChanges || saving}
            style={{
              flex: 1, padding: '8px 14px', borderRadius: 9, border: 'none',
              background: !hasChanges || saving ? 'rgba(255,255,255,0.06)' : `rgba(${accent},0.3)`,
              color: !hasChanges || saving ? 'rgba(255,255,255,0.35)' : '#fff',
              fontSize: 11.5, fontWeight: 700,
              cursor: !hasChanges || saving ? 'default' : 'pointer',
              transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease, transform 0.15s cubic-bezier(0.16,1,0.3,1)',
              boxShadow: !hasChanges || saving ? 'none' : `0 2px 12px rgba(${accent},0.2)`,
            }}>
            {saving ? 'Saving…' : `Save to ${trackIds.length} track${trackIds.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </form>
    </div>
  );
}

export { MetadataEditor, AlbumMetadataEditor };
