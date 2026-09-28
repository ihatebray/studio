import React, { useMemo } from 'react';
import { PlayIcon } from './sharedUI.jsx';

/* =========================================================================
 *  Home — New Releases and the right rail.
 *
 *  Implementation brief, "Home — New Releases": the page is two columns with
 *  no greeting and no page title. New Releases takes the left two thirds at
 *  full height; the rail sits on the right. Nothing scrolls sideways.
 *
 *  The behaviour that matters here: studio finds releases through the
 *  catalogue but plays only local files, so a release you don't own cannot be
 *  played. Every release carries a download state and Play appears only once
 *  the files exist. Per-track control is the point — on a sixteen-track
 *  deluxe edition people want three songs, not the album.
 *
 *  All the plumbing (lookup, download, progress, ownership) is passed in from
 *  StudioHome; this file is layout, state labels and the expansion.
 * ========================================================================= */

export const HOME_CSS = `
.sth-home { position: absolute; inset: 0; display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 24px; padding: 28px; }
@media (max-width: 1120px) { .sth-home { grid-template-columns: minmax(0, 1fr); } .sth-home-rail { display: none; } }
.sth-home-col { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.sth-home-scroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.14) transparent; }
.sth-home-scroll::-webkit-scrollbar { width: 10px; }
.sth-home-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.14); border-radius: 5px; border: 3px solid transparent; background-clip: content-box; }

/* ---- Header row ---- */
.sth-nr-head { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; flex-wrap: wrap; }
.sth-nr-head h1 { font-size: 32px; font-weight: 800; letter-spacing: -0.02em; margin: 0; color: var(--text); }
.sth-nr-live { font-size: 13px; font-weight: 700; color: var(--accent-line); }
.sth-nr-head-r { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.sth-nr-checked { font-size: 12.5px; color: var(--text-faint); }
.sth-nr-filter { display: flex; padding: 3px; gap: 2px; border-radius: var(--r-ctl-m); border: 1px solid var(--border-control); }
.sth-nr-filter button { height: 28px; padding: 0 12px; border: none; border-radius: var(--r-ctl-s); background: transparent; color: var(--text-dim); font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; }
.sth-nr-filter button.on { background: rgba(255,255,255,0.1); color: var(--text); font-weight: 700; }

/* ---- Date headings + rows ---- */
.sth-nr-date { font-size: 10.5px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: var(--text-faint); margin: 20px 0 8px; }
.sth-nr-date:first-child { margin-top: 0; }
.sth-nr-item { border-radius: var(--r-panel); overflow: hidden; margin-bottom: 8px; border: 1px solid transparent; }
.sth-nr-item.is-open { background: var(--surface-raised); border-color: var(--border); }
.sth-nr-row { display: flex; align-items: center; gap: 14px; width: 100%; height: 74px; padding: 0 12px; background: transparent; border: none; text-align: left; cursor: pointer; color: inherit; font: inherit; border-radius: var(--r-panel); }
.sth-nr-row:hover { background: rgba(255,255,255,0.03); }
.sth-nr-art { width: 54px; height: 54px; border-radius: var(--r-art); flex-shrink: 0; background-size: cover; background-position: center; background-color: rgba(255,255,255,0.06); }
.sth-nr-name { display: flex; align-items: center; gap: 8px; min-width: 0; }
.sth-nr-name > span { font-size: 15px; font-weight: 700; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sth-nr-meta { font-size: 12.5px; color: var(--text-faint); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sth-nr-state { font-size: 12.5px; color: var(--text-faint); white-space: nowrap; }
.sth-nr-state.ok { color: var(--success); }
.sth-nr-chev { color: var(--text-faint); transition: transform 180ms ease; flex-shrink: 0; }
.sth-nr-item.is-open .sth-nr-chev { transform: rotate(180deg); }

/* ---- Expanded track list ---- */
.sth-nr-panel { padding: 0 12px 12px; }
.sth-nr-panel-head { display: flex; align-items: center; justify-content: space-between; height: 30px; padding: 0 4px;
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: var(--text-faint); border-bottom: 1px solid var(--border); }
.sth-nr-track { display: grid; grid-template-columns: 28px minmax(0, 1fr) 52px 150px; align-items: center; gap: 12px; height: 46px; padding: 0 4px; }
.sth-nr-track:hover { background: rgba(255,255,255,0.025); border-radius: var(--r-ctl-s); }
.sth-nr-track .n { font-size: 12.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.sth-nr-track .t { font-size: 13.5px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sth-nr-track .d { font-size: 12.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; text-align: right; }
.sth-nr-track .s { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.sth-nr-inlib { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; color: var(--success); }
.sth-nr-pct { font-size: 12px; font-weight: 700; color: var(--accent-line); font-variant-numeric: tabular-nums; }
.sth-nr-more { display: block; margin: 10px auto 2px; background: none; border: none; color: var(--text-dim); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; padding: 6px 10px; border-radius: var(--r-ctl-s); }
.sth-nr-more:hover { color: var(--text); background: rgba(255,255,255,0.05); }

/* ---- Right rail ---- */
.sth-rail-h { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 26px 0 12px; }
.sth-rail-h h2 { font-size: 20px; font-weight: 800; letter-spacing: -0.01em; color: var(--text); margin: 0; }
.sth-rail-h span { font-size: 12px; color: var(--text-faint); }
.sth-jump { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.sth-jump button { display: flex; align-items: center; gap: 10px; height: 56px; padding: 0 10px 0 0; border: none; border-radius: var(--r-ctl-m);
  background: rgba(255,255,255,0.05); cursor: pointer; text-align: left; overflow: hidden; font: inherit; }
.sth-jump button:hover { background: rgba(255,255,255,0.09); }
.sth-jump .art { width: 56px; height: 56px; flex-shrink: 0; background-size: cover; background-position: center; background-color: rgba(255,255,255,0.08); }
.sth-jump .nm { font-size: 12.5px; font-weight: 700; color: var(--text); line-height: 1.2; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sth-jump .sb { font-size: 11px; color: var(--text-faint); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sth-repeat { display: flex; flex-direction: column; }
.sth-repeat button { display: flex; align-items: center; gap: 12px; height: 50px; padding: 0 8px; border: none; border-radius: var(--r-ctl-s); background: transparent; cursor: pointer; text-align: left; font: inherit; }
.sth-repeat button:hover { background: rgba(255,255,255,0.05); }
.sth-repeat .art { width: 38px; height: 38px; border-radius: var(--r-art-s); flex-shrink: 0; background-size: cover; background-position: center; background-color: rgba(255,255,255,0.08); }
.sth-repeat .nm { font-size: 13px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sth-repeat .sb { font-size: 11.5px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sth-repeat .ct { margin-left: auto; font-size: 12.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.sth-home-empty { font-size: 13px; color: var(--text-faint); line-height: 1.6; padding: 8px 2px 24px; }
`;

const fmtDur = (sec) => {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const m = Math.floor(sec / 60); const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

function ageLabel(iso) {
  if (!iso) return '';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (Number.isNaN(d)) return '';
  if (d <= 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 30) return `${d} days ago`;
  return `${Math.floor(d / 30)} mo ago`;
}

/** Download state for a whole release, from its tracklist and what's owned. */
export function releaseState(rel, tracks, owns, dlState) {
  if (!tracks || !tracks.length) return { known: false, owned: 0, total: rel.trackCount || 0 };
  const owned = tracks.filter((tk) => owns(tk)).length;
  const busy = tracks.some((tk) => dlState(tk) === 'busy');
  return { known: true, owned, total: tracks.length, busy };
}

function TrackStateControl({ owned, dl, progress, onDownload, onCancel }) {
  if (owned || dl === 'done') {
    return (
      <span className="sth-nr-inlib">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6L9 17l-5-5" /></svg>
        In library
      </span>
    );
  }
  if (dl === 'busy') {
    /* useDownloadProgress reports pct as 0..1, and null before the first
       byte — which is exactly the "Queued" state. */
    const raw = progress?.pct;
    const pct = typeof raw === 'number' ? Math.max(0, Math.min(100, Math.round(raw * 100))) : 0;
    return (
      <>
        <span className="st-progress" style={{ width: 66 }}><i style={{ width: `${pct || 4}%` }} /></span>
        <span className="sth-nr-pct">{pct ? `${pct}%` : 'Queued'}</span>
        {onCancel ? (
          <button type="button" className="st-icon-btn is-sm" onClick={onCancel} title="Cancel" aria-label="Cancel download">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        ) : null}
      </>
    );
  }
  return (
    <button type="button" className="st-btn st-btn-outline st-btn-sm" onClick={onDownload}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3v12M7 11l5 5 5-5M5 21h14" /></svg>
      {dl === 'failed' ? 'Retry' : 'Download'}
    </button>
  );
}

/**
 * One release row plus, when open, its track panel. Clicking the row expands
 * it in place rather than navigating, and only one is open at a time.
 */
function ReleaseRow({
  rel, open, tracks, busy, onToggle, owns, dlFor, progressFor,
  onDownloadTrack, onDownloadAll, onPlay, showAll, onShowAll,
}) {
  const id = Number(rel.collectionId);
  const st = releaseState(rel, tracks, owns, (tk) => dlFor(rel, tk));
  const meta = [
    rel.artistName,
    rel.trackCount ? `${rel.trackCount} track${rel.trackCount === 1 ? '' : 's'}` : null,
    ageLabel(rel.releaseDate),
  ].filter(Boolean).join(' · ');

  let stateLabel = 'Not downloaded';
  let stateClass = '';
  if (st.known && st.owned === st.total && st.total) { stateLabel = `All ${st.total} downloaded`; stateClass = 'ok'; }
  else if (st.known && st.owned > 0) stateLabel = `${st.owned} of ${st.total} downloaded`;
  else if (st.known) stateLabel = 'Not downloaded';
  else stateLabel = '';

  const allOwned = st.known && st.total > 0 && st.owned === st.total;
  const someOwned = st.known && st.owned > 0 && !allOwned;

  const shown = tracks && !showAll && tracks.length > 8 ? tracks.slice(0, 7) : (tracks || []);

  return (
    <div className={`sth-nr-item${open ? ' is-open' : ''}`}>
      <button type="button" className="sth-nr-row" onClick={onToggle} aria-expanded={open}>
        <span className="sth-nr-art" style={{ backgroundImage: rel.artworkUrl ? `url("${rel.artworkUrl}")` : undefined }} aria-hidden />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span className="sth-nr-name">
            <span>{rel.collectionName}</span>
            {rel.isNew ? <span className="st-badge-new">New</span> : null}
          </span>
          <span className="sth-nr-meta" style={{ display: 'block' }}>{meta}</span>
        </span>
        <span className={`sth-nr-state ${stateClass}`}>{stateLabel}</span>
        {allOwned ? (
          <span className="st-btn st-btn-success st-btn-sm" role="button" tabIndex={-1}
            onClick={(e) => { e.stopPropagation(); onPlay(rel, tracks); }}>
            <PlayIcon size={13} /> Play
          </span>
        ) : (
          <span className={`st-btn st-btn-sm ${someOwned ? 'st-btn-primary' : 'st-btn-outline'}`} role="button" tabIndex={-1}
            onClick={(e) => { e.stopPropagation(); onDownloadAll(rel); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3v12M7 11l5 5 5-5M5 21h14" /></svg>
            {someOwned ? 'Finish download' : 'Download'}
          </span>
        )}
        <svg className="sth-nr-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open ? (
        <div className="sth-nr-panel">
          <div className="sth-nr-panel-head">
            <span>Tracks</span>
            <span>{st.known ? `${st.owned} of ${st.total} in your library` : ''}</span>
          </div>
          {busy ? (
            <div className="sth-home-empty">Loading tracklist…</div>
          ) : !tracks || !tracks.length ? (
            <div className="sth-home-empty">Couldn&rsquo;t load the tracklist for this release.</div>
          ) : (
            <>
              {shown.map((tk, i) => (
                <div className="sth-nr-track" key={tk.trackId || i}>
                  <span className="n">{tk.trackNumber || i + 1}</span>
                  <span className="t">{tk.trackName}</span>
                  <span className="d">{fmtDur(Math.round((tk.trackTimeMillis || 0) / 1000))}</span>
                  <span className="s">
                    <TrackStateControl
                      owned={owns(tk)}
                      dl={dlFor(rel, tk)}
                      progress={progressFor(rel, tk)}
                      onDownload={() => onDownloadTrack(rel, tk)}
                    />
                  </span>
                </div>
              ))}
              {tracks.length > shown.length ? (
                <button type="button" className="sth-nr-more" onClick={() => onShowAll(id)}>
                  Show all {tracks.length} tracks
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The left column: header row, date groupings, rows. */
export function NewReleases({
  releases = [], openId, onToggle, tracksById = {}, busyById = {},
  owns, dlFor, progressFor, onDownloadTrack, onDownloadAll, onPlay,
  filter, onFilter, checkedAt, refreshing, onRefresh, onManageFollows,
  showAllFor, onShowAll, downloadingCount = 0, emptyNote,
}) {
  const notDownloaded = releases.filter((r) => {
    const st = releaseState(r, tracksById[Number(r.collectionId)], owns, (tk) => dlFor(r, tk));
    return !(st.known && st.total > 0 && st.owned === st.total);
  });
  const list = filter === 'missing' ? notDownloaded : releases;

  const groups = useMemo(() => {
    const week = []; const month = []; const older = [];
    for (const r of list) {
      const days = r.releaseDate ? Math.floor((Date.now() - new Date(r.releaseDate).getTime()) / 86400000) : 999;
      if (days <= 7) week.push(r); else if (days <= 31) month.push(r); else older.push(r);
    }
    return [['This week', week], ['Earlier this month', month], ['Older', older]].filter(([, g]) => g.length);
  }, [list]);

  return (
    <>
      <div className="sth-nr-head">
        <h1>New Releases</h1>
        {downloadingCount ? <span className="sth-nr-live">{downloadingCount} downloading</span> : null}
        <div className="sth-nr-head-r">
          {checkedAt ? <span className="sth-nr-checked">Checked {ageLabel(checkedAt).toLowerCase()}</span> : null}
          {onRefresh ? (
            <button type="button" className="st-icon-btn" onClick={onRefresh} disabled={refreshing}
              title="Check for new releases" aria-label="Check for new releases">
              {refreshing ? (
                <svg className="st-spin" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                  <path d="M12 3a9 9 0 1 0 9 9" />
                </svg>
              ) : (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />
                </svg>
              )}
            </button>
          ) : null}
          <div className="sth-nr-filter" role="radiogroup" aria-label="Filter releases">
            <button type="button" role="radio" aria-checked={filter !== 'missing'} className={filter !== 'missing' ? 'on' : ''} onClick={() => onFilter('all')}>All {releases.length}</button>
            <button type="button" role="radio" aria-checked={filter === 'missing'} className={filter === 'missing' ? 'on' : ''} onClick={() => onFilter('missing')}>Not downloaded {notDownloaded.length}</button>
          </div>
          {onManageFollows ? (
            <button type="button" className="st-btn st-btn-outline" onClick={onManageFollows}>Manage follows</button>
          ) : null}
        </div>
      </div>

      {!list.length ? (
        <div className="sth-home-empty">{emptyNote || 'Nothing new from the artists you follow.'}</div>
      ) : null}

      {groups.map(([label, items]) => (
        <section key={label}>
          <h2 className="sth-nr-date">{label}</h2>
          {items.map((rel) => {
            const id = Number(rel.collectionId);
            return (
              <ReleaseRow
                key={id}
                rel={rel}
                open={openId === id}
                tracks={tracksById[id]}
                busy={!!busyById[id]}
                onToggle={() => onToggle(rel)}
                owns={owns}
                dlFor={dlFor}
                progressFor={progressFor}
                onDownloadTrack={onDownloadTrack}
                onDownloadAll={onDownloadAll}
                onPlay={onPlay}
                showAll={showAllFor === id}
                onShowAll={onShowAll}
              />
            );
          })}
        </section>
      ))}
    </>
  );
}

/** The right rail: shuffle everything, Jump back in, On repeat this week. */
export function HomeRail({ onShuffleAll, jumpBackIn = [], onRepeat = [], onOpen, onPlayTrack }) {
  return (
    <>
      {onShuffleAll ? (
        <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={onShuffleAll} style={{ alignSelf: 'flex-start' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
          </svg>
          Shuffle everything
        </button>
      ) : null}

      {jumpBackIn.length ? (
        <>
          <div className="sth-rail-h"><h2>Jump back in</h2><span>Last 7 days</span></div>
          <div className="sth-jump">
            {jumpBackIn.slice(0, 6).map((it) => (
              <button key={it.key} type="button" onClick={() => onOpen(it)}>
                <span className="art" aria-hidden style={{ backgroundImage: it.art ? `url("${it.art}")` : undefined }} />
                <span style={{ minWidth: 0 }}>
                  <span className="nm" style={{ display: 'block' }}>{it.name}</span>
                  <span className="sb" style={{ display: 'block' }}>{it.sub}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      {onRepeat.length ? (
        <>
          <div className="sth-rail-h"><h2>On repeat this week</h2><span>By plays</span></div>
          <div className="sth-repeat">
            {onRepeat.slice(0, 9).map((r) => (
              <button key={r.track.id} type="button" onClick={() => onPlayTrack(r.track, onRepeat.map((x) => x.track))}>
                <span className="art" aria-hidden style={{ backgroundImage: r.art ? `url("${r.art}")` : undefined }} />
                <span style={{ minWidth: 0 }}>
                  <span className="nm" style={{ display: 'block' }}>{r.track.title}</span>
                  <span className="sb" style={{ display: 'block' }}>{r.track.artist}</span>
                </span>
                <span className="ct">{r.plays}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
