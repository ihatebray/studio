import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const NodeID3 = require('node-id3');

/**
 * @param {string} filePath
 * @param {{ title: string, artist: string, album: string, year: number|null, genre: string, coverAction: 'keep'|'replace'|'clear', coverImageBuffer?: Buffer|null, coverMime?: string|null }} fields
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function applyMp3Metadata(filePath, fields) {
  const tags = {
    title: fields.title || '',
    artist: fields.artist || '',
    album: fields.album || '',
    genre: fields.genre || '',
  };
  if (fields.year != null && Number.isFinite(fields.year)) {
    tags.year = String(Math.round(fields.year));
  }

  try {
    if (fields.coverAction === 'clear') {
      const rem = NodeID3.removeTags(filePath);
      if (rem !== true) {
        const err = rem instanceof Error ? rem.message : String(rem);
        return { ok: false, error: err || 'Failed to strip ID3 tags' };
      }
      const w = NodeID3.write(tags, filePath);
      if (w !== true) {
        const err = w instanceof Error ? w.message : String(w);
        return { ok: false, error: err || 'Failed to write ID3 tags' };
      }
      return { ok: true };
    }

    if (fields.coverAction === 'replace' && fields.coverImageBuffer?.length && fields.coverMime) {
      tags.image = {
        mime: fields.coverMime,
        type: { id: 3 },
        description: 'Cover',
        imageBuffer: fields.coverImageBuffer,
      };
    }

    const w = NodeID3.update(tags, filePath);
    if (w !== true) {
      const err = w instanceof Error ? w.message : String(w);
      return { ok: false, error: err || 'Failed to update ID3 tags' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
