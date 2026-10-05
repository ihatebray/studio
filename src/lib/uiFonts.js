/** UI fonts: rounded only. Google Fonts load on demand; fonts you add
 *  yourself (Settings → Font) live in customFonts.js. */

export const FONT_GROUPS = ['My fonts', 'Rounded', 'Rounded · Bold'];

const UI_FONT_PRESETS = [
  {
    id: 'volte-rounded',
    label: 'Volte Rounded',
    stack: "'Volte Rounded', 'Nunito', system-ui, sans-serif",
    google: null,
    customCss: 'https://db.onlinewebfonts.com/c/ef2f7e1114bac294ccb3cc8863d3dd51?family=Volte+Rounded',
    group: 'Rounded',
  },
  { id: 'nunito', label: 'Nunito', stack: "'Nunito', 'Nunito', system-ui, sans-serif", google: 'Nunito', group: 'Rounded' },
  { id: 'quicksand', label: 'Quicksand', stack: "'Quicksand', 'Nunito', system-ui, sans-serif", google: 'Quicksand', group: 'Rounded' },
  { id: 'comfortaa', label: 'Comfortaa', stack: "'Comfortaa', 'Nunito', system-ui, sans-serif", google: 'Comfortaa', group: 'Rounded' },
  { id: 'varela-round', label: 'Varela Round', stack: "'Varela Round', 'Nunito', system-ui, sans-serif", google: 'Varela Round', group: 'Rounded' },
  { id: 'm-plus-rounded', label: 'M PLUS Rounded 1c', stack: "'M PLUS Rounded 1c', 'Nunito', system-ui, sans-serif", google: 'M PLUS Rounded 1c', group: 'Rounded' },
  { id: 'zen-marugothic', label: 'Zen Maru Gothic', stack: "'Zen Maru Gothic', 'Nunito', system-ui, sans-serif", google: 'Zen Maru Gothic', group: 'Rounded' },
  { id: 'fredoka', label: 'Fredoka', stack: "'Fredoka', 'Nunito', system-ui, sans-serif", google: 'Fredoka', group: 'Rounded' },
  { id: 'dosis', label: 'Dosis', stack: "'Dosis', 'Nunito', system-ui, sans-serif", google: 'Dosis', group: 'Rounded' },
  { id: 'rubik', label: 'Rubik', stack: "'Rubik', 'Nunito', system-ui, sans-serif", google: 'Rubik', group: 'Rounded' },
  { id: 'kosugi-maru', label: 'Kosugi Maru', stack: "'Kosugi Maru', 'Nunito', system-ui, sans-serif", google: 'Kosugi Maru', group: 'Rounded' },
  { id: 'livvic', label: 'Livvic', stack: "'Livvic', 'Nunito', system-ui, sans-serif", google: 'Livvic', group: 'Rounded' },
  { id: 'coda', label: 'Coda', stack: "'Coda', 'Nunito', system-ui, sans-serif", google: 'Coda', group: 'Rounded' },
  { id: 'tilt-neon', label: 'Tilt Neon', stack: "'Tilt Neon', 'Nunito', system-ui, sans-serif", google: 'Tilt Neon', group: 'Rounded' },
  { id: 'bubbler-one', label: 'Bubbler One', stack: "'Bubbler One', 'Nunito', system-ui, sans-serif", google: 'Bubbler One', group: 'Rounded' },
  { id: 'baumans', label: 'Baumans', stack: "'Baumans', 'Nunito', system-ui, sans-serif", google: 'Baumans', group: 'Rounded' },
  { id: 'mochiy-pop-one', label: 'Mochiy Pop One', stack: "'Mochiy Pop One', 'Nunito', system-ui, sans-serif", google: 'Mochiy Pop One', group: 'Rounded · Bold' },
  { id: 'mochiy-pop-p-one', label: 'Mochiy Pop P One', stack: "'Mochiy Pop P One', 'Nunito', system-ui, sans-serif", google: 'Mochiy Pop P One', group: 'Rounded · Bold' },
  { id: 'rocknroll-one', label: 'RocknRoll One', stack: "'RocknRoll One', 'Nunito', system-ui, sans-serif", google: 'RocknRoll One', group: 'Rounded · Bold' },
  { id: 'tilt-warp', label: 'Tilt Warp', stack: "'Tilt Warp', 'Nunito', system-ui, sans-serif", google: 'Tilt Warp', group: 'Rounded · Bold' },
  { id: 'jua', label: 'Jua', stack: "'Jua', 'Nunito', system-ui, sans-serif", google: 'Jua', group: 'Rounded · Bold' },
  { id: 'baloo-2', label: 'Baloo 2', stack: "'Baloo 2', 'Nunito', system-ui, sans-serif", google: 'Baloo 2', group: 'Rounded · Bold' },
  { id: 'sniglet', label: 'Sniglet', stack: "'Sniglet', 'Nunito', system-ui, sans-serif", google: 'Sniglet', group: 'Rounded · Bold' },
  { id: 'concert-one', label: 'Concert One', stack: "'Concert One', 'Nunito', system-ui, sans-serif", google: 'Concert One', group: 'Rounded · Bold' },
  { id: 'titan-one', label: 'Titan One', stack: "'Titan One', 'Nunito', system-ui, sans-serif", google: 'Titan One', group: 'Rounded · Bold' },
  { id: 'coiny', label: 'Coiny', stack: "'Coiny', 'Nunito', system-ui, sans-serif", google: 'Coiny', group: 'Rounded · Bold' },
  { id: 'mitr', label: 'Mitr', stack: "'Mitr', 'Nunito', system-ui, sans-serif", google: 'Mitr', group: 'Rounded · Bold' },
  { id: 'grandstander', label: 'Grandstander', stack: "'Grandstander', 'Nunito', system-ui, sans-serif", google: 'Grandstander', group: 'Rounded · Bold' },
  { id: 'sour-gummy', label: 'Sour Gummy', stack: "'Sour Gummy', 'Nunito', system-ui, sans-serif", google: 'Sour Gummy', group: 'Rounded · Bold' },
  { id: 'gluten', label: 'Gluten', stack: "'Gluten', 'Nunito', system-ui, sans-serif", google: 'Gluten', group: 'Rounded · Bold' },
  { id: 'cherry-bomb-one', label: 'Cherry Bomb One', stack: "'Cherry Bomb One', 'Nunito', system-ui, sans-serif", google: 'Cherry Bomb One', group: 'Rounded · Bold' },
  { id: 'darumadrop-one', label: 'Darumadrop One', stack: "'Darumadrop One', 'Nunito', system-ui, sans-serif", google: 'Darumadrop One', group: 'Rounded · Bold' },
];

const STORAGE_KEY = 'studioPlayerUiFont';
const CUSTOM_FONTS_KEY = 'studioPlayerCustomFonts';

/** Fonts you added (their names; the files live in customFonts.js). */
export function getCustomFonts() {
  try {
    const raw = localStorage.getItem(CUSTOM_FONTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f) => f && typeof f.id === 'string' && typeof f.label === 'string' && typeof f.family === 'string');
  } catch {
    return [];
  }
}

export function saveCustomFonts(list) {
  try { localStorage.setItem(CUSTOM_FONTS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

function customToPreset(f) {
  return {
    id: f.id,
    label: f.label,
    stack: `'${f.family}', 'Nunito', system-ui, sans-serif`,
    google: null,
    group: 'My fonts',
    isCustom: true,
    weights: f.weights || [],
  };
}

/** Every font on offer: the built-in list plus the ones you added. */
export function getAllPresets() {
  return [...getCustomFonts().map(customToPreset), ...UI_FONT_PRESETS];
}

export function getStoredFontId() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v) {
      const all = getAllPresets();
      if (all.some((p) => p.id === v)) return v;
      // Modulus Pro used to be bundled (as empty placeholder files); once
      // you add its files yourself, keep it selected.
      if (v === 'modulus-pro') {
        const mine = getCustomFonts().find((f) => f.family.toLowerCase() === 'modulus pro');
        if (mine) return mine.id;
      }
    }
  } catch {
    /* ignore */
  }
  return UI_FONT_PRESETS[0].id;
}

export function storeFontId(id) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

export function presetById(id) {
  return getAllPresets().find((p) => p.id === id) || UI_FONT_PRESETS[0];
}

/**
 * Make form controls inherit the UI font.
 *
 * button, input, select and textarea do NOT inherit font-family — the UA
 * gives them the OS system font unless told otherwise, and no amount of
 * setting the family on <body> reaches them. Studio has ~208 <button> tags
 * and twelve of them said `font: inherit`, so the other ~196 — album cards,
 * the sidebar, the home tiles, the stats panel — quietly rendered in San
 * Francisco / Segoe while everything around them used the chosen font.
 *
 * font-FAMILY only, deliberately. The `font` shorthand would also reset
 * size, weight and line-height to the inherited values, which would resize
 * every control in the app; this changes the typeface and nothing else.
 *
 * Injected once, with no dependency on which preset is active — the rule is
 * `inherit`, so it follows the body whenever the font changes.
 */
export function ensureControlFontInheritance() {
  const id = 'studio-font-inherit';
  if (typeof document === 'undefined' || document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = 'button, input, select, textarea, optgroup { font-family: inherit; }';
  /* First child of <head> so any component stylesheet that wants a different
     face for one control still wins on source order. */
  document.head.insertBefore(style, document.head.firstChild);
}

/** Inject a Google Fonts, custom CDN, or bundled-font stylesheet once per preset. */
export function loadGoogleFontForPreset(preset) {
  const linkId = `studio-font-${preset.id}`;
  if (document.getElementById(linkId)) return;

  if (preset.customCss) {
    const link = document.createElement('link');
    link.id = linkId;
    link.rel = 'stylesheet';
    link.href = preset.customCss;
    document.head.appendChild(link);
    return;
  }

  if (!preset?.google) return;
  const spec = `${preset.google.replace(/ /g, '+')}:wght@400;500;600;700`;
  const link = document.createElement('link');
  link.id = linkId;
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${spec}&display=swap`;
  document.head.appendChild(link);
}

/** Just enough of a font to draw its own name in the picker: Google serves
 *  a subset with only those letters, a few KB each. */
export function loadFontPreview(preset, text = '') {
  if (typeof document === 'undefined' || !preset || preset.isCustom) return;
  if (document.getElementById(`studio-font-${preset.id}`)) return; // already fully loaded
  if (!preset.google) { loadGoogleFontForPreset(preset); return; }
  const id = `studio-fontpv-${preset.id}`;
  if (document.getElementById(id)) return;
  const chars = [...new Set(`${preset.label}${text}Aa`)].join('');
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${preset.google.replace(/ /g, '+')}:wght@500&text=${encodeURIComponent(chars)}&display=swap`;
  document.head.appendChild(link);
}
