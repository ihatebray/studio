
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { storeCoverFromDataUri, storeCoverFromUrl } from './coverArtStore.js';

let initPromise;
let SQL;
let db;

function userDataDir() {
  return app.getPath('userData');
}

function dbFilePath() {
  return path.join(userDataDir(), 'library.db');
}

function legacyJsonPath() {
  return path.join(userDataDir(), 'library.json');
}

async function ensureEngine() {
  if (SQL) return SQL;
  if (!initPromise) {
    /* The WebAssembly build: about 3.5x quicker to start and 5-7x quicker
       to query than the asm.js one this used, with the same file format.
       Its .wasm sits beside it in node_modules (inside app.asar, which
       Electron's fs reads). If it can't load for any reason, fall back to
       asm.js, so the library always opens. */
    initPromise = (async () => {
      try {
        const initSqlJs = (await import('sql.js/dist/sql-wasm.js')).default;
        const dir = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
        return await initSqlJs({ locateFile: (f) => path.join(dir, f) });
      } catch (e) {
        console.warn('[library] WebAssembly SQLite unavailable, using asm.js:', String(e?.message || e));
        const initSqlJs = (await import('sql.js/dist/sql-asm.js')).default;
        return initSqlJs();
      }
    })();
  }
  SQL = await initPromise;
  return SQL;
}

/* ---- Persistence -----------------------------------------------------
 *
 * persistAtomic() serialises the ENTIRE database out of WASM memory and
 * writes the whole file, synchronously, on the main process. That is fine
 * once. It is not fine in a loop.
 *
 * The releases refresh is exactly that loop: setItunesArtistIdForArtist
 * runs for every artist being resolved for the first time, and each call
 * rewrote the whole database — so a first refresh across a few hundred
 * followed artists paid for hundreds of full-file writes, each one blocking
 * IPC and stuttering the renderer.
 *
 * persistSoon() coalesces those into one write on a trailing timer, and is
 * what everyday edits use: imports, play counts, favourites, playlists,
 * lyrics, covers. Each of those used to rewrite the whole file on the spot,
 * so a playlist import or a busy listening session paid for a full-database
 * write per change, each one blocking the main process. Only one-time
 * migrations, the destructive clears and the writes that report a disk
 * error back to the caller still call persistAtomic(). A hard kill can lose
 * the last second and a half; closeLibraryDb() persists unconditionally and
 * runs on before-quit, so an ordinary exit (and an update) always flushes.
 */
let persistTimer = null;
let pendingPersist = false;
const PERSIST_DEBOUNCE_MS = 1500;

function persistAtomic() {
  if (!db) return;
  pendingPersist = false;
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  const dir = userDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = dbFilePath();
  const data = db.export();
  const buf = Buffer.from(data);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, filePath);
}

function persistSoon() {
  if (!db) return;
  pendingPersist = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (pendingPersist) persistAtomic();
  }, PERSIST_DEBOUNCE_MS);
  // Don't hold the process open for a cache write.
  if (typeof persistTimer.unref === 'function') persistTimer.unref();
}

function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY NOT NULL,
      file_path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT NOT NULL,
      duration REAL NOT NULL DEFAULT 0,
      cover_art_url TEXT,
      year INTEGER,
      genre TEXT,
      track_number INTEGER,
      disc_number INTEGER,
      added_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);');
  db.run('CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album);');
  db.run('CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title);');
  db.run(`
    CREATE TABLE IF NOT EXISTS lyrics_cache (
      cache_key TEXT PRIMARY KEY NOT NULL,
      synced_lyrics TEXT,
      plain_lyrics TEXT,
      instrumental INTEGER NOT NULL DEFAULT 0,
      fetched_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      cover_art_url TEXT,
      sort_index INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      added_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (playlist_id, track_id),
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );
  `);
  // Album DISPLAY-art overrides. Keyed by the same "albumName__primaryArtist"
  // string the library grouping uses. Purely cosmetic for album view — it
  // never touches any track's own cover_art_url, so per-song art (and what
  // actually plays) stays completely independent of what an album tile shows.
  db.run(`
    CREATE TABLE IF NOT EXISTS album_covers (
      album_key TEXT PRIMARY KEY NOT NULL,
      cover_art_url TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id, position);');
  db.run(`
    CREATE TABLE IF NOT EXISTS play_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      ms INTEGER,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_play_events_at ON play_events(at);');
  db.run('CREATE INDEX IF NOT EXISTS idx_play_events_track ON play_events(track_id, at);');
}

/** Existing DBs created before cover_art_url — add column without losing data. */
/**
 * Give play_events an identity that SURVIVES the track being deleted.
 *
 * Track ids come from uid() — timestamp plus randomness, minted fresh on every
 * import. So clearing the library and re-adding the same file produces a new
 * id, and every historical play_event points at an id that will never exist
 * again. The rows survive (clearLibrary doesn't touch this table, and FK
 * cascade never fires because PRAGMA foreign_keys is off), but they become
 * unattributable: the totals keep counting while Top Tracks empties out.
 *
 * Two keys, because neither alone is enough:
 *   file_path  — exact, no collisions, but breaks if you move or re-download
 *                a file to a different folder.
 *   track_key  — normalized "artist::title", survives moves and re-rips, but
 *                merges genuine duplicates (live vs studio, remaster vs
 *                original) into one line.
 * Matching prefers file_path and falls back to track_key.
 *
 * BACKFILL TIMING MATTERS: existing rows can only be filled in while the
 * tracks they reference still exist. Once the library is cleared the join has
 * nothing to join to and that history is permanently anonymous — so this runs
 * at open, before any clear can happen.
 */
/* Where saved lyrics came from: 'lrclib', 'genius', or 'user' (a version
   picked in the lyrics browser). NULL on rows saved before this column. */
function migrateLyricsSource() {
  try {
    const r = db.exec('PRAGMA table_info(lyrics_cache);');
    if (!r[0]?.values?.length) return;
    const cols = r[0].values.map((row) => row[1]);
    if (!cols.includes('source')) db.run('ALTER TABLE lyrics_cache ADD COLUMN source TEXT;');
  } catch (e) {
    console.error('migrateLyricsSource failed', e);
  }
}

function migratePlayEventsIdentity() {
  try {
    const r = db.exec('PRAGMA table_info(play_events);');
    if (!r[0]?.values?.length) return;
    const cols = r[0].values.map((row) => row[1]);
    if (!cols.includes('track_key')) db.run('ALTER TABLE play_events ADD COLUMN track_key TEXT;');
    if (!cols.includes('file_path')) db.run('ALTER TABLE play_events ADD COLUMN file_path TEXT;');
    /* How much of the track was actually heard, in milliseconds.
       NULL means "not measured" — every row written before this column
       existed. Stats fall back to the track's full duration for those, which
       is what they always did; the column exists so new rows stop guessing.
       Deliberately NOT backfilled: there is no honest value to backfill with,
       and writing the duration in here would make an estimate indistinguishable
       from a measurement forever after. */
    if (!cols.includes('ms')) db.run('ALTER TABLE play_events ADD COLUMN ms INTEGER;');

    // Backfill from tracks still present. LOWER/TRIM here must match
    // playTrackKey() in JS or the two halves won't meet.
    db.run(`
      UPDATE play_events
      SET track_key = (
        SELECT LOWER(TRIM(t.artist)) || '::' || LOWER(TRIM(t.title))
        FROM tracks t WHERE t.id = play_events.track_id
      )
      WHERE track_key IS NULL
        AND EXISTS (SELECT 1 FROM tracks t WHERE t.id = play_events.track_id);
    `);
    db.run(`
      UPDATE play_events
      SET file_path = (SELECT t.file_path FROM tracks t WHERE t.id = play_events.track_id)
      WHERE file_path IS NULL
        AND EXISTS (SELECT 1 FROM tracks t WHERE t.id = play_events.track_id);
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_play_events_key ON play_events(track_key);');
    db.run('CREATE INDEX IF NOT EXISTS idx_play_events_path ON play_events(file_path);');
  } catch (e) {
    console.error('migratePlayEventsIdentity', e);
  }
}

/** Stable stat key for a track. MUST match the SQL in the migration above. */
function playTrackKey(artist, title) {
  const a = String(artist || '').trim().toLowerCase();
  const t = String(title || '').trim().toLowerCase();
  if (!a && !t) return null;
  return `${a}::${t}`;
}

function migrateTracksCoverArtUrlColumn() {
  try {
    const r = db.exec('PRAGMA table_info(tracks);');
    if (!r[0]?.values?.length) return;
    const colNames = r[0].values.map((row) => row[1]);
    if (colNames.includes('cover_art_url')) return;
    db.run('ALTER TABLE tracks ADD COLUMN cover_art_url TEXT;');
  } catch (e) {
    console.error('migrateTracksCoverArtUrlColumn', e);
  }
}

/** Add year and genre columns to existing tracks tables that predate them. */
function migrateTracksYearGenreColumns() {
  try {
    const r = db.exec('PRAGMA table_info(tracks);');
    if (!r[0]?.values?.length) return;
    const colNames = r[0].values.map((row) => row[1]);
    if (!colNames.includes('year')) {
      db.run('ALTER TABLE tracks ADD COLUMN year INTEGER;');
    }
    if (!colNames.includes('genre')) {
      db.run('ALTER TABLE tracks ADD COLUMN genre TEXT;');
    }
  } catch (e) {
    console.error('migrateTracksYearGenreColumns', e);
  }
}

/** Add track_number and disc_number columns for proper album ordering. */
function migrateTracksTrackDiscColumns() {
  try {
    const r = db.exec('PRAGMA table_info(tracks);');
    if (!r[0]?.values?.length) return;
    const colNames = r[0].values.map((row) => row[1]);
    if (!colNames.includes('track_number')) {
      db.run('ALTER TABLE tracks ADD COLUMN track_number INTEGER;');
    }
    if (!colNames.includes('disc_number')) {
      db.run('ALTER TABLE tracks ADD COLUMN disc_number INTEGER;');
    }
  } catch (e) {
    console.error('migrateTracksTrackDiscColumns', e);
  }
}

/**
 * Add favorite flag, per-track notes, play tracking. Adds columns:
 *   is_favorite  INTEGER 0/1, default 0
 *   notes        TEXT
 *   play_count   INTEGER default 0
 *   last_played  INTEGER (unix ms timestamp), nullable
 */
function migrateTracksFavoritesNotesPlays() {
  try {
    const r = db.exec('PRAGMA table_info(tracks);');
    if (!r[0]?.values?.length) return;
    const colNames = r[0].values.map((row) => row[1]);
    if (!colNames.includes('is_favorite')) {
      db.run('ALTER TABLE tracks ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0;');
    }
    if (!colNames.includes('notes')) {
      db.run('ALTER TABLE tracks ADD COLUMN notes TEXT;');
    }
    if (!colNames.includes('play_count')) {
      db.run('ALTER TABLE tracks ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!colNames.includes('last_played')) {
      db.run('ALTER TABLE tracks ADD COLUMN last_played INTEGER;');
    }
  } catch (e) {
    console.error('migrateTracksFavoritesNotesPlays', e);
  }
}

/**
 * Tracks the EXPECTED explicit flag for each track, sourced from the streaming
 * service (Spotify / iTunes) at import time. NULL = unknown (track was
 * imported manually without metadata, or via "+ Folder" / "+ Files"). 0 = clean,
 * 1 = explicit. We don't trust the actual yt-dlp audio for this — we record what
 * the streaming service said the song SHOULD be, so the user can spot mismatches.
 */
function migrateTracksExplicit() {
  try {
    const r = db.exec('PRAGMA table_info(tracks);');
    if (!r[0]?.values?.length) return;
    const colNames = r[0].values.map((row) => row[1]);
    if (!colNames.includes('explicit')) {
      db.run('ALTER TABLE tracks ADD COLUMN explicit INTEGER;');
    }
  } catch (e) {
    console.error('migrateTracksExplicit', e);
  }
}

/**
 * Fetched artist portraits, keyed by lowercased artist name.
 *
 * Separate from `artist_headers` on purpose: that table is what the USER
 * decided, this one is what the network said. Keeping them apart means
 * re-fetching can never quietly overwrite someone's chosen picture, and
 * clearing the cache can never lose it.
 *
 * A row with a null url is a remembered MISS. Without it an artist nobody has
 * a photo of gets looked up again on every single visit to the grid.
 */
/**
 * Per-cover colour overrides.
 *
 * Extraction gets a record wrong often enough that a way to correct it is
 * worth more than any further tuning: one click beats an algorithm that is
 * right most of the time and unfixable when it isn't. Keyed by album key so a
 * choice covers every track on the record rather than needing repeating.
 */
function migrateCoverColoursTable() {
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS cover_colours (
        album_key TEXT PRIMARY KEY NOT NULL,
        rgb TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
      );
    `);
    /* Rows keyed by album name are from the first version of this and are
       wrong: a deluxe edition and its original share an album tag, so one
       colour applied to both with no way to separate them. Keys are the cover
       image now and start with "img:". The old rows can't be migrated — the
       name doesn't identify which artwork was meant — so they're dropped
       rather than left applying colours nothing can change. */
    db.run("DELETE FROM cover_colours WHERE album_key NOT LIKE 'img:%';");
  } catch (e) {
    console.error('migrateCoverColoursTable', e);
  }
}

function migrateArtistImageCacheTable() {
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS artist_image_cache (
        artist_key TEXT PRIMARY KEY NOT NULL,
        image_url TEXT,
        fetched_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
      );
    `);
  } catch (e) {
    console.error('migrateArtistImageCacheTable', e);
  }
}

/**
 * Per-artist header art.
 *
 * The artist page auto-fetches a header (TheAudioDB, then Spotify's avatar),
 * which is right most of the time and wrong often enough to matter — wrong
 * artist, ugly crop, or simply not the picture you'd have chosen. This table
 * holds the override: an optional image plus how it should sit in the band.
 *
 * `image_url` null with a non-default framing is a legitimate row: it means
 * "keep the fetched image, but frame it like this". Framing therefore has to
 * survive independently of the image.
 *
 * Keyed by lowercased artist name, matching the artist grouping's own key.
 */
function migrateArtistHeadersTable() {
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS artist_headers (
        artist_key TEXT PRIMARY KEY NOT NULL,
        image_url TEXT,
        focus_x REAL NOT NULL DEFAULT 50,
        focus_y REAL NOT NULL DEFAULT 50,
        zoom REAL NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
      );
    `);
  } catch (e) {
    console.error('migrateArtistHeadersTable', e);
  }
}

/**
 * Album notes — keyed by (album, primary_artist) pair since albums are
 * derived from track metadata rather than being their own DB entity.
 */
function migrateAlbumNotesTable() {
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS album_notes (
        album TEXT NOT NULL,
        artist TEXT NOT NULL,
        notes TEXT,
        updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
        PRIMARY KEY (album, artist)
      );
    `);
  } catch (e) {
    console.error('migrateAlbumNotesTable', e);
  }
}

/**
 * album_links — remembers which Spotify album a library album was resolved /
 * confirmed to, keyed by the same (album, artist) pair as album_notes. This
 * powers the "missing tracks" feature: once an album is matched to a Spotify
 * edition (auto or via the user's confirm/correct step), we store its ID so
 * future opens are exact instead of re-running the fuzzy name search.
 *   spotify_album_id  — the confirmed Spotify album ID
 *   confirmed         — 1 if the user explicitly confirmed, 0 if auto-resolved
 */
function migrateAlbumLinksTable() {
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS album_links (
        album TEXT NOT NULL,
        artist TEXT NOT NULL,
        spotify_album_id TEXT NOT NULL,
        confirmed INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
        PRIMARY KEY (album, artist)
      );
    `);
  } catch (e) {
    console.error('migrateAlbumLinksTable', e);
  }
}

/**
 * followed_artists — stores manual overrides for the "new releases" tracker.
 *   action='add'     → user explicitly follows (may not be in library)
 *   action='exclude' → user explicitly unfollows an auto-followed artist
 *
 * Auto-followed artists (anyone in the library with ≥ 2 tracks) are computed
 * at runtime from the library itself, so they don't need DB rows. This table
 * only records deviations from that default. The iTunes artist ID is resolved
 * lazily on first lookup and cached here to avoid repeated search API calls.
 */
function migrateFollowedArtistsTable() {
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS followed_artists (
        artist_name TEXT PRIMARY KEY NOT NULL COLLATE NOCASE,
        action TEXT NOT NULL DEFAULT 'add',
        itunes_artist_id INTEGER,
        created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
      );
    `);
  } catch (e) {
    console.error('migrateFollowedArtistsTable', e);
  }
}

/**
 * artist_releases_cache — stores releases (iTunes albums) that we've fetched
 * for followed artists. Lets the "new releases" tab render instantly without
 * re-hitting the iTunes API on every open. Records are refreshed in the
 * background; stale entries are pruned on write.
 */
function migrateArtistReleasesCacheTable() {
  try {
    /* The cache was briefly rekeyed on YouTube Music ids (ytmusic_channel_id
       / browse_id). This is a pure cache of re-fetchable data, so the
       migration is simply to drop that shape and rebuild on iTunes ids —
       no data worth preserving, and no column-rename gymnastics. */
    try {
      const info = db.exec("PRAGMA table_info(artist_releases_cache);");
      const cols = info?.[0]?.values?.map((r) => String(r[1])) || [];
      if (cols.length && !cols.includes('itunes_artist_id')) {
        db.run('DROP TABLE IF EXISTS artist_releases_cache;');
      }
    } catch { /* table doesn't exist yet — nothing to migrate */ }

    db.run(`
      CREATE TABLE IF NOT EXISTS artist_releases_cache (
        itunes_artist_id INTEGER NOT NULL,
        collection_id INTEGER NOT NULL,
        collection_name TEXT,
        artist_name TEXT,
        release_date TEXT,
        artwork_url TEXT,
        track_count INTEGER,
        cached_at INTEGER NOT NULL,
        PRIMARY KEY (itunes_artist_id, collection_id)
      );
    `);
    // Also an index on release_date for fast "recent releases" queries
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_artist_releases_release_date
      ON artist_releases_cache(release_date DESC);
    `);
  } catch (e) {
    console.error('migrateArtistReleasesCacheTable', e);
  }
}

/**
 * Move inline base64 cover art out of the DB and onto disk.
 *
 * Older versions stored entire `data:image/...;base64,...` strings in the
 * cover_art_url column. A DB with many large covers causes sql.js to run out
 * of WASM heap on SELECT *. This migration rewrites those rows to
 * `studio-cover://local/<hash>.<ext>` URLs and writes the actual image bytes
 * to the userData cover-cache folder. Idempotent — only acts on rows that
 * still start with "data:image/".
 *
 * Processes rows one id at a time (no SELECT *) to keep memory flat.
 */
function migrateInlineCoversToDisk() {
  try {
    // 1) Collect ids of rows that still carry an inline data URI. Fetching
    //    just (id, length) keeps the working set tiny even if a row is huge.
    const idsRes = db.exec("SELECT id FROM tracks WHERE cover_art_url LIKE 'data:image/%';");
    const ids = idsRes?.[0]?.values?.map((r) => r[0]) || [];
    if (ids.length === 0) return;

    console.log(`[cover migration] converting ${ids.length} inline covers to disk…`);
    let converted = 0;
    let failed = 0;

    const selectStmt = db.prepare('SELECT cover_art_url FROM tracks WHERE id = ?;');
    const updateStmt = db.prepare('UPDATE tracks SET cover_art_url = ? WHERE id = ?;');

    for (const id of ids) {
      let dataUri = null;
      try {
        selectStmt.bind([id]);
        if (selectStmt.step()) {
          const row = selectStmt.get();
          dataUri = row?.[0] || null;
        }
        selectStmt.reset();
      } catch (e) {
        console.error('[cover migration] select failed for', id, e);
        failed += 1;
        continue;
      }

      if (!dataUri || typeof dataUri !== 'string' || !dataUri.startsWith('data:image/')) continue;

      const url = storeCoverFromDataUri(dataUri);
      // Release the big string immediately so the next iteration has heap to work with
      dataUri = null;

      if (!url) {
        failed += 1;
        continue;
      }

      try {
        updateStmt.run([url, id]);
        converted += 1;
      } catch (e) {
        console.error('[cover migration] update failed for', id, e);
        failed += 1;
      }
    }

    selectStmt.free();
    updateStmt.free();

    console.log(`[cover migration] done — converted ${converted}, failed ${failed}`);
    if (converted > 0) persistAtomic();
  } catch (e) {
    console.error('migrateInlineCoversToDisk', e);
  }
}

/**
 * Pull existing remote cover URLs into the content-addressed store.
 *
 * The counterpart to the mirroring in upsertTracks, for rows already in the
 * DB. Runs in the background after open, never blocks it, and is idempotent:
 * a row is only touched if the mirror actually produced a studio-cover:// URL.
 *
 * Sequential, not parallel, and deliberately so — this is a background repair
 * of a cosmetic inconsistency, and saturating the connection on launch to fix
 * it would be a worse bug than the one it fixes. A few hundred covers trickle
 * through in well under a minute and the work is permanent.
 */
async function localizeRemoteCovers() {
  try {
    const res = db.exec(
      "SELECT DISTINCT cover_art_url FROM tracks WHERE cover_art_url LIKE 'http%';",
    );
    const urls = res?.[0]?.values?.map((r) => r[0]).filter(Boolean) || [];
    if (!urls.length) return;

    console.log(`[cover localize] mirroring ${urls.length} remote cover(s)…`);
    const mapped = []; // [remote, local]
    for (const remote of urls) {
      let local;
      try {
        local = await storeCoverFromUrl(remote);
      } catch {
        continue;
      }
      if (local && String(local).startsWith('studio-cover://')) mapped.push([remote, local]);
    }
    if (!mapped.length) { console.log('[cover localize] nothing localized'); return; }

    db.run('BEGIN;');
    try {
      const tracksStmt = db.prepare('UPDATE tracks SET cover_art_url = ? WHERE cover_art_url = ?;');
      for (const [remote, local] of mapped) tracksStmt.run([local, remote]);
      tracksStmt.free();

      /* Album cover pins point at the same remote URLs. Leaving them behind
         would reintroduce exactly the split this is closing — the pin would
         hand out a CDN URL while the tracks under it hand out a local one. */
      try {
        const pinStmt = db.prepare('UPDATE album_covers SET cover_art_url = ? WHERE cover_art_url = ?;');
        for (const [remote, local] of mapped) pinStmt.run([local, remote]);
        pinStmt.free();
      } catch { /* older DBs may not have the table */ }

      db.run('COMMIT;');
    } catch (e) {
      try { db.run('ROLLBACK;'); } catch { /* ignore */ }
      console.error('[cover localize] write failed', e);
      return;
    }
    persistAtomic();
    console.log(`[cover localize] done — ${mapped.length} of ${urls.length} localized`);
  } catch (e) {
    console.error('localizeRemoteCovers', e);
  }
}

function rowToTrack(row) {
  const url = row.cover_art_url && String(row.cover_art_url).trim();
  return {
    id: row.id,
    filePath: row.file_path,
    title: row.title,
    artist: row.artist,
    album: row.album,
    duration: row.duration,
    coverArt: url || null,
    year: row.year != null ? Number(row.year) : null,
    genre: row.genre || '',
    trackNumber: row.track_number != null ? Number(row.track_number) : null,
    discNumber: row.disc_number != null ? Number(row.disc_number) : null,
    isFavorite: row.is_favorite ? true : false,
    notes: row.notes || '',
    playCount: row.play_count != null ? Number(row.play_count) : 0,
    lastPlayed: row.last_played != null ? Number(row.last_played) : null,
    addedAt: row.added_at != null ? Number(row.added_at) : null,
    // explicit: null = unknown (typically a "+ Folder" import where Spotify
    // never told us). 0 = clean, 1 = explicit. This is what the streaming
    // service said the song SHOULD be, not what the actual audio file is.
    explicit: row.explicit == null ? null : (row.explicit ? 1 : 0),
  };
}

function normalizeTrackInput(track) {
  if (!track || typeof track !== 'object') return null;
  const filePath = typeof track.filePath === 'string' ? track.filePath.trim() : '';
  if (!filePath) return null;
  const rawCover = track.coverArtUrl ?? track.cover_art_url ?? track.coverArt;
  let cover_art_url = null;
  if (typeof rawCover === 'string' && rawCover.trim()) {
    const u = rawCover.trim();
    if (/^https?:\/\//i.test(u)) {
      cover_art_url = u.slice(0, 2048);
    } else if (u.startsWith('studio-cover://')) {
      cover_art_url = u.slice(0, 2048);
    } else if (u.startsWith('data:image/')) {
      // Persist to disk and store a lightweight URL in the DB
      const saved = storeCoverFromDataUri(u);
      if (saved) cover_art_url = saved;
    }
  }
  // Year: accept number or numeric string in the valid range
  let year = null;
  const rawYear = track.year;
  if (rawYear != null && rawYear !== '') {
    const n = Number(rawYear);
    if (Number.isFinite(n) && n >= 1000 && n <= 9999) year = Math.floor(n);
  }
  const genre = typeof track.genre === 'string' ? track.genre.trim().slice(0, 400) : '';
  // Track and disc numbers — accept positive integers, ignore anything else
  const clampInt = (v, max = 9999) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1 || n > max) return null;
    return Math.floor(n);
  };
  const track_number = clampInt(track.trackNumber ?? track.track_number);
  const disc_number = clampInt(track.discNumber ?? track.disc_number, 99);
  // Explicit: accept boolean true/false or 1/0; null/undefined means unknown.
  // We keep null distinct from 0 (clean) so we can show no badge vs a "clean" badge.
  let explicit = null;
  if (track.explicit === true || track.explicit === 1) explicit = 1;
  else if (track.explicit === false || track.explicit === 0) explicit = 0;
  return {
    id: typeof track.id === 'string' && track.id ? track.id : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    file_path: filePath,
    title: typeof track.title === 'string' ? track.title : path.basename(filePath, path.extname(filePath)),
    artist: typeof track.artist === 'string' ? track.artist : 'Unknown Artist',
    album: typeof track.album === 'string' ? track.album : 'Unknown Album',
    duration: typeof track.duration === 'number' && !Number.isNaN(track.duration) ? track.duration : 0,
    cover_art_url,
    year,
    genre: genre || null,
    track_number,
    disc_number,
    explicit,
  };
}

function migrateFromLegacyJsonIfNeeded() {
  const jsonPath = legacyJsonPath();
  if (!fs.existsSync(jsonPath)) return;

  const countRes = db.exec('SELECT COUNT(*) AS c FROM tracks;');
  const count = countRes?.[0]?.values?.[0]?.[0] ?? 0;
  if (count > 0) return;

  try {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const data = JSON.parse(raw);
    const list = data && Array.isArray(data.tracks) ? data.tracks : [];
    db.run('BEGIN;');
    for (const t of list) {
      const n = normalizeTrackInput(t);
      if (!n) continue;
      db.run(
        'INSERT OR IGNORE INTO tracks (id, file_path, title, artist, album, duration, cover_art_url, year, genre, track_number, disc_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
        [n.id, n.file_path, n.title, n.artist, n.album, n.duration, n.cover_art_url, n.year, n.genre, n.track_number, n.disc_number],
      );
    }
    db.run('COMMIT;');
    fs.renameSync(jsonPath, `${jsonPath}.migrated.bak`);
    persistAtomic();
  } catch (e) {
    console.error('library JSON migration failed', e);
    try {
      db.run('ROLLBACK;');
    } catch { /* ignore */ }
  }
}

let openPromise;

export async function ensureLibraryOpen() {
  if (db) return;
  if (!openPromise) {
    openPromise = (async () => {
      await ensureEngine();
      const filePath = dbFilePath();
      fs.mkdirSync(userDataDir(), { recursive: true });

      if (fs.existsSync(filePath)) {
        const fileBuffer = fs.readFileSync(filePath);
        db = new SQL.Database(fileBuffer);
      } else {
        db = new SQL.Database();
      }

      initSchema();
      migrateTracksCoverArtUrlColumn();
      migrateTracksYearGenreColumns();
      migrateTracksTrackDiscColumns();
      migrateTracksFavoritesNotesPlays();
      migrateTracksExplicit();
      migrateAlbumNotesTable();
      migrateAlbumLinksTable();
      migrateArtistHeadersTable();
      migrateArtistImageCacheTable();
      migrateCoverColoursTable();
      migrateFollowedArtistsTable();
      migrateArtistReleasesCacheTable();
      migratePlayEventsIdentity();
      migrateLyricsSource();
      migrateInlineCoversToDisk();
      migrateFromLegacyJsonIfNeeded();
      /* Deliberately NOT awaited. This one touches the network, and the
         library must be usable the instant the DB is readable — a slow or
         absent connection cannot be allowed to hold up launch for a repair
         that is purely cosmetic. Fires once per session; the on-disk map
         makes every later launch a no-op. */
      setTimeout(() => { localizeRemoteCovers(); }, 3000);
    })();
  }
  await openPromise;
}

export async function loadAllTracks() {
  await ensureLibraryOpen();
  if (!db) return [];
  const res = db.exec(
    'SELECT id, file_path, title, artist, album, duration, cover_art_url, year, genre, track_number, disc_number, is_favorite, notes, play_count, last_played, added_at, explicit FROM tracks ORDER BY added_at ASC, title COLLATE NOCASE ASC;',
  );
  if (!res?.[0]) return [];
  const { columns, values } = res[0];
  return values.map((row) => {
    const obj = {};
    columns.forEach((c, i) => {
      obj[c] = row[i];
    });
    return rowToTrack(obj);
  });
}

/**
 * All album display-art overrides as a plain object { albumKey: url }.
 * Loaded once alongside the library and merged into album grouping so the
 * override shows in album view without re-querying per tile.
 */
export async function loadAlbumCovers() {
  await ensureLibraryOpen();
  if (!db) return {};
  const out = {};
  try {
    const res = db.exec('SELECT album_key, cover_art_url FROM album_covers;');
    if (res?.[0]) {
      for (const [key, url] of res[0].values) {
        if (key && url) out[key] = url;
      }
    }
  } catch { /* table may not exist on very old dbs — treat as empty */ }
  return out;
}

/** Every per-cover colour override, keyed by album key. */
export async function loadCoverColours() {
  await ensureLibraryOpen();
  if (!db) return {};
  const out = {};
  try {
    const res = db.exec('SELECT album_key, rgb FROM cover_colours;');
    if (res?.[0]) for (const [k, v] of res[0].values) { if (k && v) out[k] = v; }
  } catch { /* older db */ }
  return out;
}

/** Set or clear one cover's colour. Passing a falsy rgb removes the override. */
export async function setCoverColour(albumKey, rgb) {
  await ensureLibraryOpen();
  if (!db || !albumKey) return { ok: false, error: 'No album key.' };
  try {
    if (!rgb) db.run('DELETE FROM cover_colours WHERE album_key = ?;', [albumKey]);
    else {
      db.run(
        `INSERT INTO cover_colours (album_key, rgb, updated_at)
         VALUES (?, ?, CAST(strftime('%s','now') AS INTEGER) * 1000)
         ON CONFLICT(album_key) DO UPDATE SET rgb = excluded.rgb, updated_at = excluded.updated_at;`,
        [albumKey, rgb],
      );
    }
    persistSoon();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** Cached artist portraits, with their age so callers can expire them. */
export async function loadArtistImageCache() {
  await ensureLibraryOpen();
  if (!db) return {};
  const out = {};
  try {
    const res = db.exec('SELECT artist_key, image_url, fetched_at FROM artist_image_cache;');
    if (res?.[0]) {
      for (const [key, url, at] of res[0].values) {
        if (key) out[key] = { url: url || null, at: Number(at) || 0 };
      }
    }
  } catch { /* older db — nothing cached yet */ }
  return out;
}

/**
 * Record portrait lookups. Entries are `{ key, url }`; a null url is stored
 * rather than skipped, because "we looked and there isn't one" is worth
 * remembering.
 */
export async function setArtistImageCache(entries) {
  await ensureLibraryOpen();
  if (!db || !Array.isArray(entries) || !entries.length) return { ok: true, saved: 0 };
  let saved = 0;
  try {
    for (const e of entries) {
      const key = String(e?.key || '').trim();
      if (!key) continue;
      db.run(
        `INSERT INTO artist_image_cache (artist_key, image_url, fetched_at)
         VALUES (?, ?, CAST(strftime('%s','now') AS INTEGER) * 1000)
         ON CONFLICT(artist_key) DO UPDATE SET
           image_url = excluded.image_url,
           fetched_at = excluded.fetched_at;`,
        [key, e.url || null],
      );
      saved += 1;
    }
    if (saved) persistSoon();
    return { ok: true, saved };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), saved };
  }
}

/** Every artist header override, keyed by lowercased artist name. */
export async function loadArtistHeaders() {
  await ensureLibraryOpen();
  if (!db) return {};
  const out = {};
  try {
    const res = db.exec('SELECT artist_key, image_url, focus_x, focus_y, zoom FROM artist_headers;');
    if (res?.[0]) {
      for (const [key, url, fx, fy, zoom] of res[0].values) {
        if (!key) continue;
        out[key] = {
          image: url || null,
          focusX: Number.isFinite(fx) ? fx : 50,
          focusY: Number.isFinite(fy) ? fy : 50,
          zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 1,
        };
      }
    }
  } catch { /* table missing on an older db — treat as no overrides */ }
  return out;
}

/**
 * Save one artist's header override. `image` may be null, which keeps the
 * auto-fetched picture and stores framing only. Callers persist data URIs via
 * coverArtStore first and pass the resulting stable studio-cover:// url.
 */
export async function setArtistHeader(artistKey, { image = null, focusX = 50, focusY = 50, zoom = 1 } = {}) {
  await ensureLibraryOpen();
  if (!db || !artistKey) return { ok: false, error: 'No artist key.' };
  try {
    db.run(
      `INSERT INTO artist_headers (artist_key, image_url, focus_x, focus_y, zoom, updated_at)
       VALUES (?, ?, ?, ?, ?, CAST(strftime('%s','now') AS INTEGER) * 1000)
       ON CONFLICT(artist_key) DO UPDATE SET
         image_url = excluded.image_url,
         focus_x = excluded.focus_x,
         focus_y = excluded.focus_y,
         zoom = excluded.zoom,
         updated_at = excluded.updated_at;`,
      // Number.isFinite, not `|| 50`: a picture framed right to its top or
      // left edge is at 0, which `||` turned back into the centre.
      [artistKey, image || null, Number.isFinite(Number(focusX)) ? Number(focusX) : 50,
        Number.isFinite(Number(focusY)) ? Number(focusY) : 50, Number(zoom) > 0 ? Number(zoom) : 1],
    );
    persistSoon();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** Drop an artist's override entirely — back to the auto-fetched header. */
export async function clearArtistHeader(artistKey) {
  await ensureLibraryOpen();
  if (!db || !artistKey) return { ok: false, error: 'No artist key.' };
  try {
    db.run('DELETE FROM artist_headers WHERE artist_key = ?;', [artistKey]);
    persistSoon();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Set (or replace) an album's display cover. `url` may be a data: URI, an
 * http(s) URL, or a studio-cover:// path — callers persist the image first
 * via coverArtStore and pass the resulting stable URL. Passing a falsy url
 * clears the override (album view falls back to a track cover again).
 */
export async function setAlbumCover(albumKey, url) {
  await ensureLibraryOpen();
  if (!db || !albumKey) return { ok: false, error: 'No album key.' };
  try {
    if (!url) {
      db.run('DELETE FROM album_covers WHERE album_key = ?;', [albumKey]);
    } else {
      db.run(
        `INSERT INTO album_covers (album_key, cover_art_url, updated_at)
         VALUES (?, ?, strftime('%s','now'))
         ON CONFLICT(album_key) DO UPDATE SET cover_art_url = excluded.cover_art_url, updated_at = excluded.updated_at;`,
        [albumKey, url],
      );
    }
    persistSoon();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Bulk AUTO-PIN of album display covers. Inserts only where no pin exists
 * (ON CONFLICT DO NOTHING) — a user-set cover is never overwritten — and
 * persists ONCE for the whole batch, so migrating a large existing library
 * costs a single write instead of one per album.
 */
export async function setAlbumCoversBulk(entries) {
  await ensureLibraryOpen();
  if (!db || !Array.isArray(entries) || entries.length === 0) return { ok: true, inserted: 0 };
  let inserted = 0;
  try {
    for (const e of entries) {
      if (!e?.key || !e?.url) continue;
      db.run(
        `INSERT INTO album_covers (album_key, cover_art_url, updated_at)
         VALUES (?, ?, strftime('%s','now'))
         ON CONFLICT(album_key) DO NOTHING;`,
        [e.key, e.url],
      );
      inserted += 1;
    }
    if (inserted > 0) persistSoon();
    return { ok: true, inserted };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), inserted };
  }
}

/**
 * Remove library rows by track id. Does not delete audio files on disk.
 * @param {string[]} ids
 */
export async function removeTracksByIds(ids) {
  await ensureLibraryOpen();
  if (!db || !Array.isArray(ids)) return { ok: false, error: 'Invalid request', removed: 0 };
  const clean = [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
  if (clean.length === 0) return { ok: true, removed: 0 };

  const placeholders = clean.map(() => '?').join(',');
  let stmt;
  db.run('BEGIN;');
  try {
    stmt = db.prepare(`DELETE FROM tracks WHERE id IN (${placeholders})`);
    stmt.run(clean);
    stmt.free();
    stmt = null;
    db.run('COMMIT;');
  } catch (e) {
    try {
      db.run('ROLLBACK;');
    } catch { /* ignore */ }
    try {
      stmt?.free();
    } catch { /* ignore */ }
    return { ok: false, error: String(e?.message || e), removed: 0 };
  }
  try {
    persistSoon();
  } catch (e) {
    return { ok: false, error: String(e?.message || e), removed: 0 };
  }
  return { ok: true, removed: clean.length };
}

/**
 * Nuke all library data from the DB: tracks, playlists, playlist mappings,
 * album notes, cached lyrics, release cache, and follow overrides. Returns the
 * list of file paths that WERE in the tracks table so the caller can
 * optionally delete the audio files from disk.
 *
 * Does NOT touch: app settings (UI preferences, gradient toggle), Spotify
 * credentials, UI font choice. Those are stored separately and should persist.
 */
export async function clearAllLibraryData() {
  await ensureLibraryOpen();
  if (!db) return { ok: false, error: 'DB not open', filePaths: [] };

  // Snapshot all file paths before we delete the rows — the caller may want
  // to remove the files from disk.
  let filePaths = [];
  try {
    const res = db.exec('SELECT file_path FROM tracks;');
    if (res?.[0]) {
      filePaths = res[0].values
        .map((row) => String(row[0] || '').trim())
        .filter(Boolean);
    }
  } catch (e) {
    console.error('clearAllLibraryData — snapshot', e);
  }

  db.run('BEGIN;');
  try {
    /* play_events is deliberately NOT cleared. Listening history outlives the
       library: clear everything, re-import later, and the plays reattach by
       file_path / track_key (see reattachPlayHistory). This used to be true
       only by accident — the table was simply never listed here, and the FK
       cascade never fires because PRAGMA foreign_keys is off. It's now the
       documented behaviour. 'Reset stats' is the separate, explicit action
       for wiping history. */
    // Tables that must always exist (created by base schema + migrations).
    db.run('DELETE FROM tracks;');
    db.run('DELETE FROM playlist_tracks;');
    db.run('DELETE FROM playlists;');
    db.run('DELETE FROM album_notes;');
    // Tables added by later migrations — safe to delete-if-exists:
    try { db.run('DELETE FROM followed_artists;'); } catch { /* table may not exist on very old DBs */ }
    try { db.run('DELETE FROM artist_releases_cache;'); } catch { /* same */ }
    try { db.run('DELETE FROM lyrics_cache;'); } catch { /* same */ }
    db.run('COMMIT;');
  } catch (e) {
    try { db.run('ROLLBACK;'); } catch { /* ignore */ }
    return { ok: false, error: String(e?.message || e), filePaths: [] };
  }
  try { persistAtomic(); } catch (e) {
    return { ok: false, error: String(e?.message || e), filePaths: [] };
  }
  return { ok: true, filePaths };
}

/**
 * Point orphaned play_events at whatever track now represents them, and
 * rebuild the denormalised play_count / last_played columns from the result.
 *
 * Runs after every import. Matching prefers file_path (exact) and falls back
 * to track_key (survives a move or re-download). Rows that match nothing are
 * left alone rather than deleted — the file may come back later, and until
 * then the event still counts toward totals.
 */
function reattachPlayHistory() {
  if (!db) return { relinked: 0 };
  db.run(`
    UPDATE play_events SET track_id = (
      SELECT t.id FROM tracks t WHERE t.file_path = play_events.file_path LIMIT 1
    )
    WHERE file_path IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM tracks t2 WHERE t2.id = play_events.track_id)
      AND EXISTS (SELECT 1 FROM tracks t3 WHERE t3.file_path = play_events.file_path);
  `);
  db.run(`
    UPDATE play_events SET track_id = (
      SELECT t.id FROM tracks t
      WHERE LOWER(TRIM(t.artist)) || '::' || LOWER(TRIM(t.title)) = play_events.track_key
      LIMIT 1
    )
    WHERE track_key IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM tracks t2 WHERE t2.id = play_events.track_id)
      AND EXISTS (
        SELECT 1 FROM tracks t3
        WHERE LOWER(TRIM(t3.artist)) || '::' || LOWER(TRIM(t3.title)) = play_events.track_key
      );
  `);
  // Rebuild the aggregates from the (now repaired) event log.
  db.run(`
    UPDATE tracks SET
      play_count = (SELECT COUNT(*) FROM play_events e WHERE e.track_id = tracks.id),
      last_played = (SELECT MAX(e.at) FROM play_events e WHERE e.track_id = tracks.id)
    WHERE EXISTS (SELECT 1 FROM play_events e WHERE e.track_id = tracks.id);
  `);
  return { ok: true };
}
export async function upsertTracks(tracks) {
  await ensureLibraryOpen();
  if (!db || !Array.isArray(tracks)) return { ok: false, inserted: 0 };

  /* Mirror any remote cover into the content-addressed store BEFORE the write.
     normalizeTrackInput is synchronous (it runs inside a transaction), so this
     has to happen out here where it can await. A download's CDN URL and a
     local file's embedded art are then the same sha1 whenever they're the same
     picture — which is what stops the two from being treated as two records by
     the theme sampler and every other URL-keyed surface. Failures fall back to
     the original URL, so a cover never goes missing because the network did. */
  const prepared = await Promise.all(tracks.map(async (t) => {
    const raw = t?.coverArtUrl ?? t?.cover_art_url ?? t?.coverArt;
    if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw.trim())) return t;
    try {
      const local = await storeCoverFromUrl(raw.trim());
      if (!local || local === raw.trim()) return t;
      return { ...t, coverArt: local, coverArtUrl: local };
    } catch {
      return t;
    }
  }));

  const sql = `
    INSERT INTO tracks (id, file_path, title, artist, album, duration, cover_art_url, year, genre, track_number, disc_number, explicit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      title = excluded.title,
      artist = excluded.artist,
      album = excluded.album,
      duration = excluded.duration,
      cover_art_url = excluded.cover_art_url,
      year = excluded.year,
      genre = excluded.genre,
      track_number = excluded.track_number,
      disc_number = excluded.disc_number,
      explicit = COALESCE(excluded.explicit, tracks.explicit);
  `;
  const stmt = db.prepare(sql);
  let n = 0;
  db.run('BEGIN;');
  try {
    for (const t of prepared) {
      const row = normalizeTrackInput(t);
      if (!row) continue;
      stmt.run([row.id, row.file_path, row.title, row.artist, row.album, row.duration, row.cover_art_url, row.year, row.genre, row.track_number, row.disc_number, row.explicit]);
      n += 1;
    }
    db.run('COMMIT;');
  } catch (e) {
    try {
      db.run('ROLLBACK;');
    } catch { /* ignore */ }
    stmt.free();
    return { ok: false, error: String(e?.message || e), inserted: 0 };
  }
  stmt.free();

  // Re-attach surviving listening history to the rows just inserted. Without
  // this a re-imported track comes back at zero plays even though its events
  // are sitting right there in play_events — the stats page would show
  // history the library page denied.
  try { reattachPlayHistory(); } catch (e) { console.error('reattachPlayHistory', e); }

  try {
    persistSoon();
  } catch (e) {
    console.error('library persist failed', e);
    return { ok: false, error: String(e?.message || e), inserted: n };
  }
  return { ok: true, inserted: n };
}

/**
 * Update metadata fields on an existing track by id.
 * Accepts a partial object: { title, artist, album, year, genre, coverArt } — only provided keys are updated.
 */
export async function updateTrackMetadata(id, fields) {
  await ensureLibraryOpen();
  if (!db) return { ok: false, error: 'DB not open' };
  if (typeof id !== 'string' || !id.trim()) return { ok: false, error: 'Invalid id' };
  if (!fields || typeof fields !== 'object') return { ok: false, error: 'No fields provided' };

  const sets = [];
  const args = [];

  if (typeof fields.title === 'string') {
    const v = fields.title.trim();
    if (!v) return { ok: false, error: 'Title cannot be empty' };
    sets.push('title = ?');
    args.push(v.slice(0, 500));
  }
  if (typeof fields.artist === 'string') {
    const v = fields.artist.trim();
    sets.push('artist = ?');
    args.push((v || 'Unknown Artist').slice(0, 500));
  }
  if (typeof fields.album === 'string') {
    const v = fields.album.trim();
    sets.push('album = ?');
    args.push((v || 'Unknown Album').slice(0, 500));
  }
  if ('year' in fields) {
    let y = null;
    if (fields.year != null && fields.year !== '') {
      const n = Number(fields.year);
      if (Number.isFinite(n) && n >= 1000 && n <= 9999) y = Math.floor(n);
      else return { ok: false, error: 'Year must be 1000–9999 or empty' };
    }
    sets.push('year = ?');
    args.push(y);
  }
  if ('genre' in fields) {
    const v = typeof fields.genre === 'string' ? fields.genre.trim().slice(0, 400) : '';
    sets.push('genre = ?');
    args.push(v || null);
  }
  if ('trackNumber' in fields) {
    let v = null;
    if (fields.trackNumber != null && fields.trackNumber !== '') {
      const n = Number(fields.trackNumber);
      if (Number.isFinite(n) && n >= 1 && n <= 9999) v = Math.floor(n);
      else return { ok: false, error: 'Track number must be 1–9999 or empty' };
    }
    sets.push('track_number = ?');
    args.push(v);
  }
  if ('discNumber' in fields) {
    let v = null;
    if (fields.discNumber != null && fields.discNumber !== '') {
      const n = Number(fields.discNumber);
      if (Number.isFinite(n) && n >= 1 && n <= 99) v = Math.floor(n);
      else return { ok: false, error: 'Disc number must be 1–99 or empty' };
    }
    sets.push('disc_number = ?');
    args.push(v);
  }
  if ('explicit' in fields) {
    // Explicit flag is stored as INTEGER 0/1/null (see schema in
    // ensureLibraryOpen above). Accept boolean true/false from callers
    // and convert; null means "unknown" and clears the column.
    let v = null;
    if (fields.explicit === true) v = 1;
    else if (fields.explicit === false) v = 0;
    else if (fields.explicit == null) v = null;
    else return { ok: false, error: 'Explicit must be boolean or null.' };
    sets.push('explicit = ?');
    args.push(v);
  }
  if ('coverArt' in fields) {
    let cover_art_url = null;
    const raw = fields.coverArt;
    if (raw == null || raw === '') {
      cover_art_url = null;
    } else if (typeof raw === 'string') {
      const u = raw.trim();
      if (/^https?:\/\//i.test(u)) {
        cover_art_url = u.slice(0, 2048);
      } else if (u.startsWith('studio-cover://')) {
        cover_art_url = u.slice(0, 2048);
      } else if (u.startsWith('data:image/')) {
        const saved = storeCoverFromDataUri(u);
        if (!saved) return { ok: false, error: 'Could not save cover image.' };
        cover_art_url = saved;
      } else {
        return { ok: false, error: 'Cover art must be a URL or image data.' };
      }
    } else {
      return { ok: false, error: 'Cover art must be a string, URL, or null.' };
    }
    sets.push('cover_art_url = ?');
    args.push(cover_art_url);
  }

  if (sets.length === 0) return { ok: true, updated: 0 };
  args.push(id);

  let stmt;
  try {
    // Use a prepared statement — same pattern as upsertTracks, more reliable for
    // large TEXT values like base64 data URIs.
    stmt = db.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE id = ?;`);
    stmt.run(args);
    stmt.free();
    stmt = null;

    // Confirm the row actually exists and the write landed
    const check = db.exec('SELECT changes() AS c;');
    const changes = check?.[0]?.values?.[0]?.[0] ?? 0;
    if (changes === 0) {
      return { ok: false, error: 'Track not found' };
    }

    persistSoon();
    return { ok: true, updated: 1 };
  } catch (e) {
    console.error('updateTrackMetadata failed:', e);
    try { stmt?.free(); } catch { /* ignore */ }
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Apply album-level metadata fields to a set of tracks in a single transaction.
 *
 * Accepts:
 *   trackIds — array of track ids to update
 *   fields   — partial object of { album, artist, year, genre, coverArt }
 *
 * Only the fields provided are updated; missing keys leave the column untouched.
 * All changes commit atomically — on any error the transaction rolls back.
 */
export async function updateAlbumMetadata(trackIds, fields) {
  await ensureLibraryOpen();
  if (!db) return { ok: false, error: 'DB not open' };
  if (!Array.isArray(trackIds) || trackIds.length === 0) {
    return { ok: false, error: 'No tracks provided' };
  }
  if (!fields || typeof fields !== 'object') {
    return { ok: false, error: 'No fields provided' };
  }

  // Validate and collect the SET clauses (same rules as updateTrackMetadata,
  // minus title/track-number/disc-number which are per-track).
  const sets = [];
  const baseArgs = [];

  if (typeof fields.artist === 'string') {
    const v = fields.artist.trim();
    sets.push('artist = ?');
    baseArgs.push((v || 'Unknown Artist').slice(0, 500));
  }
  if (typeof fields.album === 'string') {
    const v = fields.album.trim();
    sets.push('album = ?');
    baseArgs.push((v || 'Unknown Album').slice(0, 500));
  }
  if ('year' in fields) {
    let y = null;
    if (fields.year != null && fields.year !== '') {
      const n = Number(fields.year);
      if (Number.isFinite(n) && n >= 1000 && n <= 9999) y = Math.floor(n);
      else return { ok: false, error: 'Year must be 1000–9999 or empty' };
    }
    sets.push('year = ?');
    baseArgs.push(y);
  }
  if ('genre' in fields) {
    const v = typeof fields.genre === 'string' ? fields.genre.trim().slice(0, 400) : '';
    sets.push('genre = ?');
    baseArgs.push(v || null);
  }
  if ('explicit' in fields) {
    // Same conversion as updateTrackMetadata: boolean true/false → 1/0,
    // null clears the column. Bulk callers use this to flip an entire
    // album's explicit flag in one go.
    let v = null;
    if (fields.explicit === true) v = 1;
    else if (fields.explicit === false) v = 0;
    else if (fields.explicit == null) v = null;
    else return { ok: false, error: 'Explicit must be boolean or null.' };
    sets.push('explicit = ?');
    baseArgs.push(v);
  }
  if ('coverArt' in fields) {
    let cover_art_url = null;
    const raw = fields.coverArt;
    if (raw == null || raw === '') {
      cover_art_url = null;
    } else if (typeof raw === 'string') {
      const u = raw.trim();
      if (/^https?:\/\//i.test(u)) {
        cover_art_url = u.slice(0, 2048);
      } else if (u.startsWith('studio-cover://')) {
        cover_art_url = u.slice(0, 2048);
      } else if (u.startsWith('data:image/')) {
        const saved = storeCoverFromDataUri(u);
        if (!saved) return { ok: false, error: 'Could not save cover image.' };
        cover_art_url = saved;
      } else {
        return { ok: false, error: 'Cover art must be a URL or image data.' };
      }
    } else {
      return { ok: false, error: 'Cover art must be a string, URL, or null.' };
    }
    sets.push('cover_art_url = ?');
    baseArgs.push(cover_art_url);
  }

  if (sets.length === 0) return { ok: true, updated: 0 };

  // Only accept clean string ids — defensive against accidental nulls/objects
  const ids = trackIds.map(String).filter((s) => s && s.trim());
  if (ids.length === 0) return { ok: false, error: 'No valid track ids' };

  const sql = `UPDATE tracks SET ${sets.join(', ')} WHERE id = ?;`;
  let stmt;
  let updated = 0;
  db.run('BEGIN;');
  try {
    stmt = db.prepare(sql);
    for (const id of ids) {
      stmt.run([...baseArgs, id]);
      const check = db.exec('SELECT changes() AS c;');
      const changes = check?.[0]?.values?.[0]?.[0] ?? 0;
      if (changes > 0) updated += 1;
    }
    stmt.free();
    stmt = null;
    db.run('COMMIT;');
  } catch (e) {
    console.error('updateAlbumMetadata failed:', e);
    try { stmt?.free(); } catch { /* ignore */ }
    try { db.run('ROLLBACK;'); } catch { /* ignore */ }
    return { ok: false, error: String(e?.message || e) };
  }

  try {
    persistSoon();
  } catch (e) {
    console.error('persistAtomic after album update failed:', e);
    return { ok: false, error: String(e?.message || e), updated };
  }
  return { ok: true, updated };
}

/* ================= PLAYLISTS ================= */

function newPlaylistId() {
  return `pl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function normalizePlaylistCover(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') return null;
  const u = raw.trim();
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u.slice(0, 2048);
  if (u.startsWith('studio-cover://')) return u.slice(0, 2048);
  if (u.startsWith('data:image/')) {
    const saved = storeCoverFromDataUri(u);
    return saved || null;
  }
  return null;
}

/** Toggle or set a track's favorite status. Returns { ok, isFavorite }. */
export async function setTrackFavorite(id, isFavorite) {
  await ensureLibraryOpen();
  if (!db) return { ok: false, error: 'DB not open' };
  if (typeof id !== 'string' || !id.trim()) return { ok: false, error: 'Invalid id' };
  try {
    db.run('UPDATE tracks SET is_favorite = ? WHERE id = ?;', [isFavorite ? 1 : 0, id]);
    persistSoon();
    return { ok: true, isFavorite: !!isFavorite };
  } catch (e) {
    console.error('setTrackFavorite', e);
    return { ok: false, error: String(e?.message || e) };
  }
}


/**
 * Increment play_count + update last_played for a track AND append a
 * per-event row to play_events. Called when a track has been listened
 * to past a meaningful threshold (eg. 30s or 50% of duration).
 *
 * The two writes have to stay in sync — `tracks.play_count` is the
 * fast aggregate for "all-time plays" displays and sorts; `play_events`
 * is the per-event log that powers Day/Week/Month tabs and any future
 * time-windowed stats. Updating one without the other would drift them.
 */
/**
 * Record a play.
 *
 * `listenedMs` is how much of the track had actually been heard at the moment
 * the play crossed the scrobble threshold. It is a floor, not a total — the
 * listener is usually still playing — so the caller refines it through
 * updatePlayEventMs() when the track ends or is switched away from.
 *
 * Returns the new row's id so the caller can do that.
 */
export async function recordTrackPlay(id, listenedMs = null) {
  await ensureLibraryOpen();
  if (!db) return { ok: false };
  if (typeof id !== 'string' || !id.trim()) return { ok: false };
  try {
    const now = Date.now();
    db.run(
      'UPDATE tracks SET play_count = play_count + 1, last_played = ? WHERE id = ?;',
      [now, id],
    );
    // Write the durable keys alongside the id so this row stays meaningful
    // after the track it points at has been deleted.
    let key = null;
    let path = null;
    try {
      const r = db.exec('SELECT artist, title, file_path FROM tracks WHERE id = ?;', [id]);
      const row = r?.[0]?.values?.[0];
      if (row) { key = playTrackKey(row[0], row[1]); path = row[2] || null; }
    } catch { /* fall through — an event without keys is still a timestamp */ }
    const ms = Number.isFinite(Number(listenedMs)) && Number(listenedMs) > 0
      ? Math.round(Number(listenedMs))
      : null;
    db.run(
      'INSERT INTO play_events (track_id, at, track_key, file_path, ms) VALUES (?, ?, ?, ?, ?);',
      [id, now, key, path, ms],
    );
    let eventId = null;
    try {
      const r = db.exec('SELECT last_insert_rowid();');
      const v = r?.[0]?.values?.[0]?.[0];
      if (Number.isFinite(Number(v))) eventId = Number(v);
    } catch { /* the play is recorded either way; it just can't be refined */ }
    persistSoon();
    return { ok: true, eventId };
  } catch (e) {
    console.error('recordTrackPlay', e);
    return { ok: false };
  }
}

/**
 * Refine a play event with the listening time finally observed for it.
 *
 * Called when the track ends or the listener moves on, so the row stops being
 * "at least 30 seconds" and becomes what was actually heard. Monotonic by
 * design: it only ever raises the stored value, so a late duplicate flush,
 * or a replay that re-enters the same row, can never shrink real history.
 *
 * Uses the debounced persist rather than persistAtomic — the row is already
 * durable, this is a refinement of it, and persistAtomic serialises the whole
 * database to disk. Doing that once per finished track would make every track
 * change cost a full DB write.
 */
export async function updatePlayEventMs(eventId, listenedMs) {
  await ensureLibraryOpen();
  if (!db) return { ok: false };
  const rowId = Number(eventId);
  const ms = Math.round(Number(listenedMs));
  if (!Number.isFinite(rowId) || rowId <= 0) return { ok: false };
  // A day of continuous play on one event means something has gone wrong;
  // store nothing rather than poison the aggregates.
  if (!Number.isFinite(ms) || ms <= 0 || ms > 24 * 60 * 60 * 1000) return { ok: false };
  try {
    db.run(
      'UPDATE play_events SET ms = ? WHERE id = ? AND (ms IS NULL OR ms < ?);',
      [ms, rowId, ms],
    );
    persistSoon();
    return { ok: true };
  } catch (e) {
    console.error('updatePlayEventMs', e);
    return { ok: false };
  }
}

/**
 * Load play events for stats aggregation. With `sinceMs` we only return
 * events newer than that timestamp (used by Day/Week/Month tabs).
 * Without it, returns the full event log.
 *
 * Returns events sorted ascending by time, capped at 100k rows to keep
 * IPC payloads bounded (a heavy listener accumulating that many events
 * over years is still well-served by the most recent slice).
 */
/**
 * Health of the listening history: how many events are attached to a track
 * that currently exists, how many are waiting for a re-import, and how many
 * predate the identity migration and can never be attributed.
 *
 * Surfaced in the UI so 'my top tracks look wrong' has an answer instead of
 * being a mystery — orphaned events still count toward totals, and without
 * this the discrepancy is invisible.
 */
export async function getStatsHealth() {
  await ensureLibraryOpen();
  if (!db) return null;
  const one = (sql) => {
    try { const r = db.exec(sql); return Number(r?.[0]?.values?.[0]?.[0] || 0); } catch { return 0; }
  };
  const total = one('SELECT COUNT(*) FROM play_events;');
  const attached = one('SELECT COUNT(*) FROM play_events e WHERE EXISTS (SELECT 1 FROM tracks t WHERE t.id = e.track_id);');
  const recoverable = one(`
    SELECT COUNT(*) FROM play_events e
    WHERE NOT EXISTS (SELECT 1 FROM tracks t WHERE t.id = e.track_id)
      AND (e.file_path IS NOT NULL OR e.track_key IS NOT NULL);
  `);
  const anonymous = one(`
    SELECT COUNT(*) FROM play_events e
    WHERE NOT EXISTS (SELECT 1 FROM tracks t WHERE t.id = e.track_id)
      AND e.file_path IS NULL AND e.track_key IS NULL;
  `);
  const oldest = one('SELECT MIN(at) FROM play_events;');
  return { total, attached, recoverable, anonymous, oldest };
}

/**
 * Composition of the library itself — the 'what do I actually have' view that
 * needs no play history at all. Cheap aggregate queries rather than shipping
 * 500 rows to the renderer to count them there.
 */
/* Mirrors parseGenres() in mediaUtils.js. Duplicated rather than imported
   because this file is main-process and mediaUtils lives with the renderer
   modules; if the separator rules change, both move together. */
function splitGenreCell(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  const out = [];
  const seen = new Set();
  for (const part of value.split(/[;\u0000|,]+/)) {
    const g = part.trim().replace(/\s+/g, ' ');
    if (!g) continue;
    const k = g.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(g);
  }
  return out;
}

export async function getLibraryOverview() {
  await ensureLibraryOpen();
  if (!db) return null;
  const rows = (sql) => { try { return db.exec(sql)?.[0]?.values || []; } catch { return []; } };
  const one = (sql) => Number(rows(sql)?.[0]?.[0] || 0);
  return {
    tracks: one('SELECT COUNT(*) FROM tracks;'),
    artists: one('SELECT COUNT(DISTINCT LOWER(TRIM(artist))) FROM tracks;'),
    albums: one("SELECT COUNT(DISTINCT LOWER(TRIM(album)) || '::' || LOWER(TRIM(artist))) FROM tracks WHERE TRIM(album) <> '';"),
    totalMs: one('SELECT CAST(SUM(duration) * 1000 AS INTEGER) FROM tracks;'),
    missingArtwork: one("SELECT COUNT(*) FROM tracks WHERE cover_art_url IS NULL OR TRIM(cover_art_url) = '';"),
    unknownArtist: one("SELECT COUNT(*) FROM tracks WHERE TRIM(artist) = '' OR LOWER(TRIM(artist)) = 'unknown artist';"),
    neverPlayed: one('SELECT COUNT(*) FROM tracks WHERE COALESCE(play_count, 0) = 0;'),
    // Artists you own exactly one song by — the clearest 'go get more of this'
    // signal in the whole library, and invisible when scrolling a track list.
    singleTrackArtists: rows(`
      SELECT artist, COUNT(*) c FROM tracks
      GROUP BY LOWER(TRIM(artist)) HAVING c = 1 ORDER BY LOWER(TRIM(artist)) LIMIT 200;
    `).map((r) => String(r[0])),
    topArtistsByTracks: rows(`
      SELECT artist, COUNT(*) c FROM tracks
      GROUP BY LOWER(TRIM(artist)) ORDER BY c DESC, LOWER(TRIM(artist)) LIMIT 12;
    `).map((r) => ({ artist: String(r[0]), count: Number(r[1]) })),
    byDecade: rows(`
      SELECT (year / 10) * 10 d, COUNT(*) c FROM tracks
      WHERE year IS NOT NULL AND year > 1900 GROUP BY d ORDER BY d;
    `).map((r) => ({ decade: Number(r[0]), count: Number(r[1]) })),
    /* Genres are a delimited list in one column, so grouping on the raw value
       would file "Emo Rap; Hyperpop" as its own genre alongside "Emo Rap".
       Splitting in SQL needs a recursive CTE for something this small, so the
       rows come back whole and are counted in JS. A track counts toward every
       genre it carries. */
    byGenre: (() => {
      const counts = new Map();
      for (const r of rows("SELECT genre FROM tracks WHERE genre IS NOT NULL AND TRIM(genre) <> '';")) {
        for (const g of splitGenreCell(r[0])) {
          const k = g.toLowerCase();
          const cur = counts.get(k) || { genre: g, count: 0 };
          cur.count += 1;
          counts.set(k, cur);
        }
      }
      return [...counts.values()].sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre)).slice(0, 10);
    })(),
  };
}
export async function loadPlayEvents(sinceMs) {
  await ensureLibraryOpen();
  if (!db) return [];
  try {
    const cutoff = Number.isFinite(Number(sinceMs)) ? Number(sinceMs) : 0;
    const cols = 'id, track_id, at, track_key, file_path, ms';
    const res = cutoff > 0
      ? db.exec(`SELECT ${cols} FROM play_events WHERE at >= ` + Math.floor(cutoff) + ' ORDER BY at ASC LIMIT 100000;')
      : db.exec(`SELECT ${cols} FROM play_events ORDER BY at ASC LIMIT 100000;`);
    if (!res?.[0]) return [];
    const { values } = res[0];
    // `key` and `path` let the renderer re-attach an event to a track that
    // was deleted and re-imported under a new id.
    return values.map((row) => ({
      // `eid` is the play_events row id; `id` stays the TRACK id so every
      // existing consumer of this shape keeps working unchanged.
      eid: Number(row[0]),
      id: String(row[1]),
      at: Number(row[2]),
      key: row[3] ? String(row[3]) : null,
      path: row[4] ? String(row[4]) : null,
      ms: row[5] == null ? null : Number(row[5]),
    }));
  } catch (e) {
    console.error('loadPlayEvents', e);
    return [];
  }
}

/**
 * Reset all listening stats: zero play_count, null last_played on every
 * track, and delete every row in play_events. Used by the "Reset stats"
 * button in the Stats tab. Track rows themselves (and everything else)
 * are untouched.
 */
export async function clearAllStats() {
  await ensureLibraryOpen();
  if (!db) return { ok: false };
  try {
    db.run('UPDATE tracks SET play_count = 0, last_played = NULL;');
    db.run('DELETE FROM play_events;');
    persistAtomic();
    return { ok: true };
  } catch (e) {
    console.error('clearAllStats', e);
    return { ok: false, error: String(e?.message || e) };
  }
}






/* =========================================================================
 *  Followed artists + releases cache
 * ========================================================================= */

/**
 * Load all manual follow-overrides. Returns an array of
 *   { artistName, action, itunesArtistId, createdAt }
 * where action is 'add' (user explicitly follows) or 'exclude' (user has
 * explicitly un-followed an artist that would otherwise be auto-followed).
 */
export async function loadFollowedArtistOverrides() {
  await ensureLibraryOpen();
  if (!db) return [];
  try {
    const res = db.exec('SELECT artist_name, action, itunes_artist_id, created_at FROM followed_artists ORDER BY created_at DESC;');
    if (!res?.[0]) return [];
    return res[0].values.map((row) => ({
      artistName: String(row[0] || ''),
      action: String(row[1] || 'add'),
      itunesArtistId: row[2] != null ? Number(row[2]) : null,
      createdAt: Number(row[4] || 0),
    }));
  } catch (e) {
    console.error('loadFollowedArtistOverrides', e);
    return [];
  }
}

/**
 * Explicitly follow an artist. Idempotent — overwrites any existing 'exclude'
 * override for the same name. If `itunesArtistId` is provided
 * (user picked a specific artist from the disambiguation dropdown), it's stored so
 * the refresh never has to guess which artist this name refers to.
 */
export async function addFollowedArtist(artistName, itunesArtistId = null) {
  await ensureLibraryOpen();
  if (!db) return { ok: false, error: 'DB not open' };
  const name = String(artistName || '').trim();
  if (!name) return { ok: false, error: 'Artist name required' };
  const itunesId = Number.isFinite(Number(itunesArtistId)) && Number(itunesArtistId) > 0
    ? Number(itunesArtistId) : null;
  try {
    db.run(
      `INSERT INTO followed_artists (artist_name, action, itunes_artist_id, created_at)
       VALUES (?, 'add', ?, ?, ?)
       ON CONFLICT(artist_name) DO UPDATE SET action='add', itunes_artist_id=COALESCE(?, itunes_artist_id);`,
      [name, itunesId, Date.now(), itunesId],
    );
    persistSoon();
    return { ok: true };
  } catch (e) {
    console.error('addFollowedArtist', e);
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Mark an artist as excluded. Called when the user un-follows an artist that
 * was being auto-followed because they exist in the library. If the artist was
 * manually added previously, this converts that row to 'exclude'.
 */
export async function excludeFollowedArtist(artistName) {
  await ensureLibraryOpen();
  if (!db) return { ok: false, error: 'DB not open' };
  const name = String(artistName || '').trim();
  if (!name) return { ok: false, error: 'Artist name required' };
  try {
    db.run(
      `INSERT INTO followed_artists (artist_name, action, itunes_artist_id, created_at)
       VALUES (?, 'exclude', NULL, ?)
       ON CONFLICT(artist_name) DO UPDATE SET action='exclude';`,
      [name, Date.now()],
    );
    // Drop their cached releases too, so they stop showing in the New Releases
    // tab / welcome screen immediately (the tab also filters by followed set,
    // but this keeps the cache from carrying stale rows).
    try { db.run('DELETE FROM artist_releases_cache WHERE artist_name = ? COLLATE NOCASE;', [name]); } catch { /* non-fatal */ }
    persistSoon();
    return { ok: true };
  } catch (e) {
    console.error('excludeFollowedArtist', e);
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Delete an override row entirely (so the artist reverts to the default —
 * auto-followed if they're in the library, un-followed otherwise).
 */
export async function clearFollowedArtistOverride(artistName) {
  await ensureLibraryOpen();
  if (!db) return { ok: false, error: 'DB not open' };
  const name = String(artistName || '').trim();
  if (!name) return { ok: false, error: 'Artist name required' };
  try {
    db.run('DELETE FROM followed_artists WHERE artist_name = ?;', [name]);
    persistSoon();
    return { ok: true };
  } catch (e) {
    console.error('clearFollowedArtistOverride', e);
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Record the resolved iTunes artist ID for a given artist name so we don't
 * have to re-search on every refresh.
 */
export async function setItunesArtistIdForArtist(artistName, itunesArtistId) {
  await ensureLibraryOpen();
  if (!db) return { ok: false };
  const name = String(artistName || '').trim();
  if (!name) return { ok: false };
  const id = Number(itunesArtistId);
  if (!Number.isFinite(id)) return { ok: false };
  try {
    // Insert-or-update. If the row doesn't exist (e.g. auto-followed artist),
    // create one with action='add' so we can store the ID.
    db.run(
      `INSERT INTO followed_artists (artist_name, action, itunes_artist_id, created_at)
       VALUES (?, 'add', ?, ?)
       ON CONFLICT(artist_name) DO UPDATE SET itunes_artist_id=excluded.itunes_artist_id;`,
      [name, id, Date.now()],
    );
    // Debounced: this runs once per artist inside the releases refresh loop.
    persistSoon();
    return { ok: true };
  } catch (e) {
    console.error('setItunesArtistIdForArtist', e);
    return { ok: false };
  }
}

/**
 * Load all cached releases, newest first. Optionally filter to releases within
 * the last `withinDays` days (default 30).
 */
export async function loadCachedReleases({ withinDays = 30 } = {}) {
  await ensureLibraryOpen();
  if (!db) return [];
  const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000;
  /* Date-only, to match what's stored. itunesGetArtistAlbums truncates
     releaseDate to YYYY-MM-DD, and this column is TEXT, so the WHERE is a
     string comparison. Against a full ISO stamp ("2026-08-02T09:15:00.000Z")
     a same-day release ("2026-08-02") is a strict PREFIX, and a shorter
     string sorts before a longer one — so every release on the boundary day
     was excluded. */
  const cutoffIso = new Date(cutoff).toISOString().slice(0, 10);
  try {
    const res = db.exec(
      `SELECT itunes_artist_id, collection_id, collection_name, artist_name,
              release_date, artwork_url, track_count, cached_at
       FROM artist_releases_cache
       WHERE release_date >= ?
       ORDER BY release_date DESC;`,
      [cutoffIso],
    );
    if (!res?.[0]) return [];
    return res[0].values.map((row) => ({
      itunesArtistId: row[0] != null ? Number(row[0]) : null,
      collectionId: row[1] != null ? Number(row[1]) : null,
      collectionName: String(row[2] || ''),
      artistName: String(row[3] || ''),
      releaseDate: String(row[4] || ''),
      artworkUrl: String(row[5] || ''),
      trackCount: row[6] != null ? Number(row[6]) : 0,
      cachedAt: Number(row[7] || 0),
    }));
  } catch (e) {
    console.error('loadCachedReleases', e);
    return [];
  }
}

/**
 * Upsert an array of release records for a given artist. Called by the
 * main-process fetcher after pulling results from iTunes. Also prunes
 * cache entries older than 60 days (keep a window twice the filter size).
 */
export async function upsertArtistReleases(releases) {
  await ensureLibraryOpen();
  if (!db) return { ok: false };
  if (!Array.isArray(releases) || !releases.length) return { ok: true, count: 0 };
  try {
    db.run('BEGIN;');
    const stmt = db.prepare(
      `INSERT INTO artist_releases_cache
        (itunes_artist_id, collection_id, collection_name, artist_name,
         release_date, artwork_url, track_count, cached_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(itunes_artist_id, collection_id) DO UPDATE SET
         collection_name = excluded.collection_name,
         artist_name = excluded.artist_name,
         release_date = excluded.release_date,
         artwork_url = excluded.artwork_url,
         track_count = excluded.track_count,
         cached_at = excluded.cached_at;`,
    );
    const now = Date.now();
    let skipped = 0;
    for (const r of releases) {
      const artistId = Number(r.itunesArtistId) || 0;
      const collectionId = Number(r.collectionId) || 0;
      /* collection_id is half the primary key, so a row without one can't be
         stored. Counted and reported rather than dropped in silence: this
         guard swallowed the entire feed for months while the function went
         on returning ok:true with a count of everything it was handed, so a
         caller had no way to tell a successful write from a total no-op. */
      if (!artistId || !collectionId) { skipped += 1; continue; }
      stmt.run([
        artistId,
        collectionId,
        String(r.collectionName || ''),
        String(r.artistName || ''),
        String(r.releaseDate || ''),
        String(r.artworkUrl || ''),
        Number(r.trackCount) || 0,
        now,
      ]);
    }
    stmt.free();
    // Prune old entries to keep the table small
    // Date-only for the same reason as the read above — a full ISO stamp
    // here would prune the boundary day rather than keep it.
    const pruneCutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    db.run('DELETE FROM artist_releases_cache WHERE release_date < ?;', [pruneCutoff]);
    db.run('COMMIT;');
    persistSoon();
    if (skipped) {
      console.warn(`upsertArtistReleases: skipped ${skipped}/${releases.length} release(s) with no itunesArtistId/collectionId — check the shape returned by itunesGetArtistAlbums.`);
    }
    // The count is what was WRITTEN, not what was offered.
    return { ok: true, count: releases.length - skipped, skipped };
  } catch (e) {
    try { db.run('ROLLBACK;'); } catch { /* ignore */ }
    console.error('upsertArtistReleases', e);
    return { ok: false, error: String(e?.message || e) };
  }
}


/** Load all playlists (metadata only — tracks loaded separately). */
export async function loadAllPlaylists() {
  await ensureLibraryOpen();
  if (!db) return [];
  const res = db.exec(
    `SELECT p.id, p.name, p.cover_art_url, p.sort_index, p.created_at, p.updated_at,
            COUNT(pt.track_id) AS track_count
     FROM playlists p
     LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
     GROUP BY p.id
     ORDER BY p.sort_index ASC, p.created_at ASC;`,
  );
  if (!res?.[0]) return [];
  const { columns, values } = res[0];
  return values.map((row) => {
    const obj = {};
    columns.forEach((c, i) => { obj[c] = row[i]; });
    return {
      id: obj.id,
      name: obj.name,
      coverArt: obj.cover_art_url || null,
      sortIndex: obj.sort_index != null ? Number(obj.sort_index) : 0,
      createdAt: obj.created_at,
      updatedAt: obj.updated_at,
      trackCount: Number(obj.track_count) || 0,
    };
  });
}

/** Load the ordered list of track IDs in a playlist. */
export async function loadPlaylistTrackIds(playlistId) {
  await ensureLibraryOpen();
  if (!db) return [];
  if (typeof playlistId !== 'string' || !playlistId.trim()) return [];
  let stmt;
  const ids = [];
  try {
    stmt = db.prepare(
      'SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC, added_at ASC;',
    );
    stmt.bind([playlistId]);
    while (stmt.step()) {
      const row = stmt.get();
      if (row?.[0]) ids.push(row[0]);
    }
  } catch (e) {
    console.error('loadPlaylistTrackIds failed', e);
  } finally {
    try { stmt?.free(); } catch { /* ignore */ }
  }
  return ids;
}

/** Create a new playlist. Returns { ok, id }. */
export async function createPlaylist(fields) {
  await ensureLibraryOpen();
  if (!db) return { ok: false, error: 'DB not open' };
  const name = typeof fields?.name === 'string' ? fields.name.trim().slice(0, 200) : '';
  if (!name) return { ok: false, error: 'Playlist name required' };
  const coverArt = normalizePlaylistCover(fields?.coverArt);
  const id = newPlaylistId();

  // Append to end of list by giving it the next sort_index
  let nextSort = 0;
  try {
    const r = db.exec('SELECT COALESCE(MAX(sort_index), -1) + 1 AS s FROM playlists;');
    nextSort = r?.[0]?.values?.[0]?.[0] ?? 0;
  } catch { /* ignore */ }

  try {
    db.run(
      'INSERT INTO playlists (id, name, cover_art_url, sort_index) VALUES (?, ?, ?, ?);',
      [id, name, coverArt, nextSort],
    );
    persistSoon();
    return { ok: true, id };
  } catch (e) {
    console.error('createPlaylist failed', e);
    return { ok: false, error: String(e?.message || e) };
  }
}

/** Update a playlist's name and/or cover art. Partial updates supported. */
export async function updatePlaylist(id, fields) {
  await ensureLibraryOpen();
  if (!db) return { ok: false, error: 'DB not open' };
  if (typeof id !== 'string' || !id.trim()) return { ok: false, error: 'Invalid id' };
  if (!fields || typeof fields !== 'object') return { ok: false, error: 'No fields provided' };

  const sets = [];
  const args = [];

  if (typeof fields.name === 'string') {
    const v = fields.name.trim().slice(0, 200);
    if (!v) return { ok: false, error: 'Name cannot be empty' };
    sets.push('name = ?');
    args.push(v);
  }
  if ('coverArt' in fields) {
    const cover = fields.coverArt == null || fields.coverArt === ''
      ? null
      : normalizePlaylistCover(fields.coverArt);
    sets.push('cover_art_url = ?');
    args.push(cover);
  }

  if (sets.length === 0) return { ok: true, updated: 0 };
  sets.push("updated_at = strftime('%s','now')");
  args.push(id);

  try {
    db.run(`UPDATE playlists SET ${sets.join(', ')} WHERE id = ?;`, args);
    const check = db.exec('SELECT changes() AS c;');
    const changes = check?.[0]?.values?.[0]?.[0] ?? 0;
    if (changes === 0) return { ok: false, error: 'Playlist not found' };
    persistSoon();
    return { ok: true, updated: 1 };
  } catch (e) {
    console.error('updatePlaylist failed', e);
    return { ok: false, error: String(e?.message || e) };
  }
}

/** Rename a playlist. */
export async function renamePlaylist(id, name) {
  await ensureLibraryOpen();
  if (!db) return { ok: false, error: 'DB not open' };
  const n = String(name || '').trim();
  if (!id || !n) return { ok: false, error: 'Invalid name' };
  try {
    db.run('UPDATE playlists SET name = ? WHERE id = ?;', [n, id]);
    persistSoon();
    return { ok: true };
  } catch (e) {
    console.error('renamePlaylist failed', e);
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Remove one track from a playlist, then CLOSE THE GAP in `position`.
 *
 * Without the renumber, positions become sparse (0,1,3,4...) and every later
 * insert has to guess where the end is. Rewriting them keeps the column a
 * dense 0..n-1 sequence, which is also what drag-to-reorder will need when it
 * arrives — so that work is done either way.
 */
export async function removeTrackFromPlaylist(playlistId, trackId) {
  await ensureLibraryOpen();
  if (!db) return { ok: false, error: 'DB not open' };
  if (!playlistId || !trackId) return { ok: false, error: 'Invalid ids' };
  try {
    db.run('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?;', [playlistId, trackId]);
    const res = db.exec(
      'SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC, added_at ASC;',
      [playlistId],
    );
    const ids = res?.[0]?.values?.map((r) => String(r[0])) || [];
    ids.forEach((tid, i) => {
      db.run('UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?;', [i, playlistId, tid]);
    });
    persistSoon();
    return { ok: true };
  } catch (e) {
    console.error('removeTrackFromPlaylist failed', e);
    return { ok: false, error: String(e?.message || e) };
  }
}
/** Delete a playlist. Cascades to playlist_tracks via FK. */
export async function deletePlaylist(id) {
  await ensureLibraryOpen();
  if (!db) return { ok: false, error: 'DB not open' };
  if (typeof id !== 'string' || !id.trim()) return { ok: false, error: 'Invalid id' };
  try {
    // FK ON DELETE CASCADE isn't enforced without PRAGMA foreign_keys=ON — do it manually
    db.run('DELETE FROM playlist_tracks WHERE playlist_id = ?;', [id]);
    db.run('DELETE FROM playlists WHERE id = ?;', [id]);
    persistSoon();
    return { ok: true };
  } catch (e) {
    console.error('deletePlaylist failed', e);
    return { ok: false, error: String(e?.message || e) };
  }
}

/** Append tracks to a playlist, skipping ones already present. Returns { ok, added }. */
export async function addTracksToPlaylist(playlistId, trackIds) {
  await ensureLibraryOpen();
  if (!db) return { ok: false, error: 'DB not open' };
  if (typeof playlistId !== 'string' || !playlistId.trim()) return { ok: false, error: 'Invalid playlist id' };
  const ids = (trackIds || []).map(String).filter(Boolean);
  if (ids.length === 0) return { ok: true, added: 0 };

  // Verify the playlist exists
  try {
    const r = db.exec('SELECT 1 FROM playlists WHERE id = ? LIMIT 1;', [playlistId]);
    if (!r?.[0]?.values?.length) return { ok: false, error: 'Playlist not found' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }

  // Current max position so we append cleanly
  let nextPos = 0;
  try {
    const r = db.exec(
      'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM playlist_tracks WHERE playlist_id = ?;',
      [playlistId],
    );
    nextPos = r?.[0]?.values?.[0]?.[0] ?? 0;
  } catch { /* ignore */ }

  let stmt;
  let added = 0;
  db.run('BEGIN;');
  try {
    stmt = db.prepare(
      'INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?);',
    );
    for (const tid of ids) {
      stmt.run([playlistId, tid, nextPos]);
      const check = db.exec('SELECT changes() AS c;');
      const changes = check?.[0]?.values?.[0]?.[0] ?? 0;
      if (changes > 0) {
        added += 1;
        nextPos += 1;
      }
    }
    stmt.free();
    stmt = null;
    db.run(`UPDATE playlists SET updated_at = strftime('%s','now') WHERE id = ?;`, [playlistId]);
    db.run('COMMIT;');
  } catch (e) {
    console.error('addTracksToPlaylist failed', e);
    try { stmt?.free(); } catch { /* ignore */ }
    try { db.run('ROLLBACK;'); } catch { /* ignore */ }
    return { ok: false, error: String(e?.message || e) };
  }

  try { persistAtomic(); } catch (e) {
    return { ok: false, error: String(e?.message || e), added };
  }
  return { ok: true, added };
}

/** Remove tracks from a playlist. Returns { ok, removed }. */
export async function removeTracksFromPlaylist(playlistId, trackIds) {
  await ensureLibraryOpen();
  if (!db) return { ok: false, error: 'DB not open' };
  if (typeof playlistId !== 'string' || !playlistId.trim()) return { ok: false, error: 'Invalid playlist id' };
  const ids = (trackIds || []).map(String).filter(Boolean);
  if (ids.length === 0) return { ok: true, removed: 0 };

  let stmt;
  let removed = 0;
  db.run('BEGIN;');
  try {
    stmt = db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?;');
    for (const tid of ids) {
      stmt.run([playlistId, tid]);
      const check = db.exec('SELECT changes() AS c;');
      const changes = check?.[0]?.values?.[0]?.[0] ?? 0;
      if (changes > 0) removed += 1;
    }
    stmt.free();
    stmt = null;
    db.run(`UPDATE playlists SET updated_at = strftime('%s','now') WHERE id = ?;`, [playlistId]);
    db.run('COMMIT;');
  } catch (e) {
    console.error('removeTracksFromPlaylist failed', e);
    try { stmt?.free(); } catch { /* ignore */ }
    try { db.run('ROLLBACK;'); } catch { /* ignore */ }
    return { ok: false, error: String(e?.message || e) };
  }

  try { persistAtomic(); } catch (e) {
    return { ok: false, error: String(e?.message || e), removed };
  }
  return { ok: true, removed };
}


/**
 * Load cached lyrics from the DB. Returns { syncedLyrics, plainLyrics, instrumental } or null.
 */
export async function loadCachedLyrics(cacheKey) {
  await ensureLibraryOpen();
  if (!db) return null;
  let stmt;
  try {
    stmt = db.prepare('SELECT synced_lyrics, plain_lyrics, instrumental, source, fetched_at FROM lyrics_cache WHERE cache_key = ? LIMIT 1;');
    stmt.bind([cacheKey]);
    if (!stmt.step()) return null; // no row
    const row = stmt.get(); // returns [synced, plain, instrumental, source, fetched_at]
    return {
      syncedLyrics: row[0] || null,
      plainLyrics: row[1] || null,
      instrumental: !!row[2],
      source: row[3] || null,
      fetchedAt: Number(row[4]) || 0,
    };
  } catch {
    return null;
  } finally {
    try { stmt?.free(); } catch { /* ignore */ }
  }
}

/**
 * Save lyrics to the persistent DB cache.
 */
export async function saveCachedLyrics(cacheKey, { syncedLyrics, plainLyrics, instrumental, source }) {
  await ensureLibraryOpen();
  if (!db) return;
  try {
    db.run(
      `INSERT OR REPLACE INTO lyrics_cache (cache_key, synced_lyrics, plain_lyrics, instrumental, source, fetched_at)
       VALUES (?, ?, ?, ?, ?, strftime('%s','now'));`,
      [cacheKey, syncedLyrics || null, plainLyrics || null, instrumental ? 1 : 0, source || 'unknown'],
    );
    persistSoon();
  } catch (e) {
    console.error('saveCachedLyrics failed', e);
  }
}

/**
 * Remove a cached lyrics row by key. Used by the renderer's "refetch"
 * affordance to force a fresh network fetch even when stale or junky
 * data is cached. No-op if no row exists.
 */
export async function deleteCachedLyrics(cacheKey) {
  await ensureLibraryOpen();
  if (!db) return;
  try {
    db.run('DELETE FROM lyrics_cache WHERE cache_key = ?;', [cacheKey]);
    persistSoon();
  } catch (e) {
    console.error('deleteCachedLyrics failed', e);
  }
}

export function closeLibraryDb() {
  if (db) {
    try {
      persistAtomic();
    } catch { /* ignore */ }
    db.close();
    db = null;
    openPromise = null;
  }
}

/** file_path → id for rows that exist. An upsert keeps the existing id on
 *  conflict, so callers that need the real id read it back here. */
export async function idsForFilePaths(paths) {
  await ensureLibraryOpen();
  const out = new Map();
  if (!db || !Array.isArray(paths)) return out;
  const stmt = db.prepare('SELECT id FROM tracks WHERE file_path = ? LIMIT 1;');
  try {
    for (const p of paths) {
      stmt.bind([String(p || '')]);
      if (stmt.step()) out.set(p, stmt.getAsObject().id);
      stmt.reset();
    }
  } finally {
    stmt.free();
  }
  return out;
}

/** True if this absolute path is a row in the library (used to gate custom playback protocol). */
export function isPlaybackPathAllowed(filePath) {
  if (!db || typeof filePath !== 'string') return false;
  const p = filePath.trim();
  if (!p) return false;
  let stmt;
  try {
    stmt = db.prepare(
      'SELECT 1 AS x FROM tracks WHERE file_path = ? COLLATE NOCASE LIMIT 1;',
    );
    const row = stmt.get([p]);
    return row != null;
  } catch {
    return false;
  } finally {
    try {
      stmt?.free();
    } catch { /* ignore */ }
  }
}
