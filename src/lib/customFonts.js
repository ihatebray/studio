/* Fonts you add yourself (Settings → Font → Add font files), such as
 * Modulus Pro. The files are kept in IndexedDB, in this app's own storage,
 * and registered with the page at startup; uiFonts.js keeps the list of
 * names so the picker and the saved choice can see them synchronously. */
import { getCustomFonts, saveCustomFonts } from './uiFonts.js';

const DB_NAME = 'studio-fonts';
const STORE = 'faces';
const EXTENSIONS = /\.(woff2|woff|ttf|otf)$/i;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const result = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(result?.result ?? result);
      t.onerror = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

const WEIGHTS = [
  [/^(thin|hairline)$/, 100],
  [/^(extra|ultra)light$/, 200],
  [/^light$/, 300],
  [/^(regular|normal|book|roman)$/, 400],
  [/^medium$/, 500],
  [/^(semi|demi)bold$/, 600],
  [/^bold$/, 700],
  [/^(extra|ultra)bold$|^heavy$/, 800],
  [/^(black|ultrablack)$/, 900],
];
const NOISE = /^(variablefont|variable|vf|wght|wdth|opsz|ital|webfont|web)$/;

/** "ModulusPro-SemiBoldItalic.otf" → { family: 'Modulus Pro', weight: 600, style: 'italic' }. */
export function parseFontFileName(name) {
  const base = name.replace(EXTENSIONS, '');
  const tokens = base.split(/[-_\s]+/).filter(Boolean);
  let weight = null;
  let style = 'normal';
  let variable = false;
  while (tokens.length > 1) {
    let t = tokens[tokens.length - 1].toLowerCase();
    if (NOISE.test(t)) { variable = variable || /variable|vf/.test(t); tokens.pop(); continue; }
    if (/(italic|oblique)$/.test(t)) { style = 'italic'; t = t.replace(/(italic|oblique)$/, ''); if (!t) { tokens.pop(); continue; } }
    const w = WEIGHTS.find(([re]) => re.test(t));
    if (!w) break;
    weight = w[1];
    tokens.pop();
  }
  const family = tokens.join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim() || base;
  return { family, weight: variable ? '100 900' : String(weight || 400), style };
}

const idFor = (family) => `custom-${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

function register({ family, weight, style, data }) {
  const face = new FontFace(family, data, { weight, style });
  return face.load().then((f) => { document.fonts.add(f); return f; });
}

/** Registers every saved font with the page, once. */
let loading = null;
export function loadCustomFonts() {
  if (!loading) loading = loadAll();
  return loading;
}

async function loadAll() {
  if (typeof indexedDB === 'undefined' || !getCustomFonts().length) return 0;
  try {
    const faces = await withStore('readonly', (s) => s.getAll());
    await Promise.all((faces || []).map((f) => register(f).catch(() => null)));
    return faces?.length || 0;
  } catch {
    return 0;
  }
}

/** Adds font files. Files of one family (one per weight) become one font.
 *  Returns { added: [family], skipped: [{ name, reason }] }. */
export async function addFontFiles(fileList) {
  const added = new Map();
  const skipped = [];
  for (const file of fileList) {
    if (!EXTENSIONS.test(file.name)) { skipped.push({ name: file.name, reason: 'not a font file' }); continue; }
    const { family, weight, style } = parseFontFileName(file.name);
    const data = await file.arrayBuffer();
    try {
      await register({ family, weight, style, data });
    } catch {
      skipped.push({ name: file.name, reason: 'could not be read as a font' });
      continue;
    }
    await withStore('readwrite', (s) => s.put({ key: `${family}|${weight}|${style}`, family, weight, style, data }));
    if (!added.has(family)) added.set(family, new Set());
    added.get(family).add(weight);
  }
  const list = getCustomFonts();
  for (const [family, weights] of added) {
    const id = idFor(family);
    const old = list.find((f) => f.id === id);
    const all = [...new Set([...(old?.weights || []), ...weights])].sort();
    if (old) old.weights = all;
    else list.push({ id, label: family, family, weights: all });
  }
  saveCustomFonts(list);
  return { added: [...added.keys()], skipped };
}

/** Forgets a font you added, files and all. */
export async function removeCustomFont(id) {
  const list = getCustomFonts();
  const font = list.find((f) => f.id === id);
  if (!font) return;
  saveCustomFonts(list.filter((f) => f.id !== id));
  try {
    const faces = await withStore('readonly', (s) => s.getAll());
    await withStore('readwrite', (s) => faces.filter((f) => f.family === font.family).forEach((f) => s.delete(f.key)));
  } catch { /* ignore */ }
  for (const f of [...document.fonts]) if (f.family.replace(/"/g, '') === font.family) document.fonts.delete(f);
}
