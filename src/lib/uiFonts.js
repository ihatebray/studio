/** Rounded, soft geometric, and Y2K UI fonts (Google Fonts, on demand). */

// Bundled Modulus Pro — Vite processes these imports into hashed asset URLs
// that work correctly in both dev mode and packaged Electron builds.
import modulusProExtraLight from '../assets/fonts/ModulusPro-ExtraLight.woff2';
import modulusProLight from '../assets/fonts/ModulusPro-Light.woff2';
import modulusProRegular from '../assets/fonts/ModulusPro-Regular.woff2';
import modulusProMedium from '../assets/fonts/ModulusPro-Medium.woff2';
import modulusProSemiBold from '../assets/fonts/ModulusPro-SemiBold.woff2';
import modulusProBold from '../assets/fonts/ModulusPro-Bold.woff2';
import modulusProExtraBold from '../assets/fonts/ModulusPro-ExtraBold.woff2';
import modulusProBlack from '../assets/fonts/ModulusPro-Black.woff2';

const UI_FONT_PRESETS = [
  // ── Rounded (clean & versatile) ────────────────────────────────────────
  {
    id: 'volte-rounded',
    label: 'Volte Rounded',
    stack: "'Volte Rounded', 'Nunito', system-ui, sans-serif",
    google: null,
    customCss: 'https://db.onlinewebfonts.com/c/ef2f7e1114bac294ccb3cc8863d3dd51?family=Volte+Rounded',
    group: 'Rounded',
  },
  {
    id: 'modulus-pro',
    label: 'Modulus Pro',
    stack: "'Modulus Pro', 'Nunito', system-ui, sans-serif",
    google: null,
    bundled: true,
    group: 'Rounded',
  },
  {
    id: 'nunito',
    label: 'Nunito',
    stack: "'Nunito', system-ui, sans-serif",
    google: 'Nunito',
    group: 'Rounded',
  },
  {
    id: 'nunito-sans',
    label: 'Nunito Sans',
    stack: "'Nunito Sans', system-ui, sans-serif",
    google: 'Nunito Sans',
    group: 'Rounded',
  },
  {
    id: 'quicksand',
    label: 'Quicksand',
    stack: "'Quicksand', system-ui, sans-serif",
    google: 'Quicksand',
    group: 'Rounded',
  },
  {
    id: 'comfortaa',
    label: 'Comfortaa',
    stack: "'Comfortaa', system-ui, sans-serif",
    google: 'Comfortaa',
    group: 'Rounded',
  },
  {
    id: 'varela-round',
    label: 'Varela Round',
    stack: "'Varela Round', system-ui, sans-serif",
    google: 'Varela Round',
    group: 'Rounded',
  },
  {
    id: 'm-plus-rounded',
    label: 'M PLUS Rounded 1c',
    stack: "'M PLUS Rounded 1c', system-ui, sans-serif",
    google: 'M PLUS Rounded 1c',
    group: 'Rounded',
  },
  {
    id: 'fredoka',
    label: 'Fredoka',
    stack: "'Fredoka', system-ui, sans-serif",
    google: 'Fredoka',
    group: 'Rounded',
  },
  {
    id: 'dosis',
    label: 'Dosis',
    stack: "'Dosis', system-ui, sans-serif",
    google: 'Dosis',
    group: 'Rounded',
  },
  {
    id: 'rubik',
    label: 'Rubik',
    stack: "'Rubik', system-ui, sans-serif",
    google: 'Rubik',
    group: 'Rounded',
  },
  {
    id: 'outfit',
    label: 'Outfit',
    stack: "'Outfit', system-ui, sans-serif",
    google: 'Outfit',
    group: 'Rounded',
  },
  {
    id: 'poppins',
    label: 'Poppins',
    stack: "'Poppins', system-ui, sans-serif",
    google: 'Poppins',
    group: 'Rounded',
  },
  {
    id: 'signika',
    label: 'Signika',
    stack: "'Signika', system-ui, sans-serif",
    google: 'Signika',
    group: 'Rounded',
  },
  {
    id: 'signika-negative',
    label: 'Signika Negative',
    stack: "'Signika Negative', system-ui, sans-serif",
    google: 'Signika Negative',
    group: 'Rounded',
  },
  {
    id: 'secular-one',
    label: 'Secular One',
    stack: "'Secular One', system-ui, sans-serif",
    google: 'Secular One',
    group: 'Rounded',
  },
  {
    id: 'grandstander',
    label: 'Grandstander',
    stack: "'Grandstander', system-ui, sans-serif",
    google: 'Grandstander',
    group: 'Rounded',
  },
  {
    id: 'montserrat-alternates',
    label: 'Montserrat Alternates',
    stack: "'Montserrat Alternates', system-ui, sans-serif",
    google: 'Montserrat Alternates',
    group: 'Rounded',
  },
  {
    id: 'lemonada',
    label: 'Lemonada',
    stack: "'Lemonada', system-ui, sans-serif",
    google: 'Lemonada',
    group: 'Rounded',
  },

  // ── Rounded · Playful ───────────────────────────────────────────────────
  {
    id: 'sniglet',
    label: 'Sniglet',
    stack: "'Sniglet', system-ui, sans-serif",
    google: 'Sniglet',
    group: 'Rounded · Playful',
  },
  {
    id: 'baloo-2',
    label: 'Baloo 2',
    stack: "'Baloo 2', system-ui, sans-serif",
    google: 'Baloo 2',
    group: 'Rounded · Playful',
  },
  {
    id: 'happy-monkey',
    label: 'Happy Monkey',
    stack: "'Happy Monkey', system-ui, sans-serif",
    google: 'Happy Monkey',
    group: 'Rounded · Playful',
  },
  {
    id: 'bubblegum-sans',
    label: 'Bubblegum Sans',
    stack: "'Bubblegum Sans', system-ui, sans-serif",
    google: 'Bubblegum Sans',
    group: 'Rounded · Playful',
  },
  {
    id: 'chewy',
    label: 'Chewy',
    stack: "'Chewy', system-ui, sans-serif",
    google: 'Chewy',
    group: 'Rounded · Playful',
  },
  {
    id: 'coiny',
    label: 'Coiny',
    stack: "'Coiny', system-ui, sans-serif",
    google: 'Coiny',
    group: 'Rounded · Playful',
  },
  {
    id: 'lilita-one',
    label: 'Lilita One',
    stack: "'Lilita One', system-ui, sans-serif",
    google: 'Lilita One',
    group: 'Rounded · Playful',
  },
  {
    id: 'balsamiq-sans',
    label: 'Balsamiq Sans',
    stack: "'Balsamiq Sans', system-ui, sans-serif",
    google: 'Balsamiq Sans',
    group: 'Rounded · Playful',
  },
  {
    id: 'comic-neue',
    label: 'Comic Neue',
    stack: "'Comic Neue', system-ui, sans-serif",
    google: 'Comic Neue',
    group: 'Rounded · Playful',
  },
  {
    id: 'itim',
    label: 'Itim',
    stack: "'Itim', system-ui, sans-serif",
    google: 'Itim',
    group: 'Rounded · Playful',
  },
  {
    id: 'kodchasan',
    label: 'Kodchasan',
    stack: "'Kodchasan', system-ui, sans-serif",
    google: 'Kodchasan',
    group: 'Rounded · Playful',
  },
  {
    id: 'concert-one',
    label: 'Concert One',
    stack: "'Concert One', system-ui, sans-serif",
    google: 'Concert One',
    group: 'Rounded · Playful',
  },
  {
    id: 'mitr',
    label: 'Mitr',
    stack: "'Mitr', system-ui, sans-serif",
    google: 'Mitr',
    group: 'Rounded · Playful',
  },
  {
    id: 'chicle',
    label: 'Chicle',
    stack: "'Chicle', system-ui, sans-serif",
    google: 'Chicle',
    group: 'Rounded · Playful',
  },
  {
    id: 'mali',
    label: 'Mali',
    stack: "'Mali', system-ui, sans-serif",
    google: 'Mali',
    group: 'Rounded · Playful',
  },
  {
    id: 'short-stack',
    label: 'Short Stack',
    stack: "'Short Stack', system-ui, sans-serif",
    google: 'Short Stack',
    group: 'Rounded · Playful',
  },
  {
    id: 'delius',
    label: 'Delius',
    stack: "'Delius', system-ui, sans-serif",
    google: 'Delius',
    group: 'Rounded · Playful',
  },
  {
    id: 'pangolin',
    label: 'Pangolin',
    stack: "'Pangolin', system-ui, sans-serif",
    google: 'Pangolin',
    group: 'Rounded · Playful',
  },
  {
    id: 'boogaloo',
    label: 'Boogaloo',
    stack: "'Boogaloo', system-ui, sans-serif",
    google: 'Boogaloo',
    group: 'Rounded · Playful',
  },
  {
    id: 'acme',
    label: 'Acme',
    stack: "'Acme', system-ui, sans-serif",
    google: 'Acme',
    group: 'Rounded · Playful',
  },
  {
    id: 'patrick-hand',
    label: 'Patrick Hand',
    stack: "'Patrick Hand', system-ui, sans-serif",
    google: 'Patrick Hand',
    group: 'Rounded · Playful',
  },
  {
    id: 'jua',
    label: 'Jua',
    stack: "'Jua', system-ui, sans-serif",
    google: 'Jua',
    group: 'Rounded · Playful',
  },
  {
    id: 'shantell-sans',
    label: 'Shantell Sans',
    stack: "'Shantell Sans', system-ui, sans-serif",
    google: 'Shantell Sans',
    group: 'Rounded · Playful',
  },
  {
    id: 'unkempt',
    label: 'Unkempt',
    stack: "'Unkempt', system-ui, sans-serif",
    google: 'Unkempt',
    group: 'Rounded · Playful',
  },
  {
    id: 'galindo',
    label: 'Galindo',
    stack: "'Galindo', system-ui, sans-serif",
    google: 'Galindo',
    group: 'Rounded · Playful',
  },

  // ── Rounded · Display ───────────────────────────────────────────────────
  {
    id: 'titan-one',
    label: 'Titan One',
    stack: "'Titan One', system-ui, sans-serif",
    google: 'Titan One',
    group: 'Rounded · Display',
  },
  {
    id: 'carter-one',
    label: 'Carter One',
    stack: "'Carter One', system-ui, sans-serif",
    google: 'Carter One',
    group: 'Rounded · Display',
  },
  {
    id: 'pacifico',
    label: 'Pacifico',
    stack: "'Pacifico', system-ui, sans-serif",
    google: 'Pacifico',
    group: 'Rounded · Display',
  },
  {
    id: 'rowdies',
    label: 'Rowdies',
    stack: "'Rowdies', system-ui, sans-serif",
    google: 'Rowdies',
    group: 'Rounded · Display',
  },
  {
    id: 'tilt-neon',
    label: 'Tilt Neon',
    stack: "'Tilt Neon', system-ui, sans-serif",
    google: 'Tilt Neon',
    group: 'Rounded · Display',
  },
  {
    id: 'rammetto-one',
    label: 'Rammetto One',
    stack: "'Rammetto One', system-ui, sans-serif",
    google: 'Rammetto One',
    group: 'Rounded · Display',
  },
  {
    id: 'shrikhand',
    label: 'Shrikhand',
    stack: "'Shrikhand', system-ui, sans-serif",
    google: 'Shrikhand',
    group: 'Rounded · Display',
  },
  {
    id: 'sriracha',
    label: 'Sriracha',
    stack: "'Sriracha', system-ui, sans-serif",
    google: 'Sriracha',
    group: 'Rounded · Display',
  },
  {
    id: 'courgette',
    label: 'Courgette',
    stack: "'Courgette', system-ui, sans-serif",
    google: 'Courgette',
    group: 'Rounded · Display',
  },
  {
    id: 'kavoon',
    label: 'Kavoon',
    stack: "'Kavoon', system-ui, sans-serif",
    google: 'Kavoon',
    group: 'Rounded · Display',
  },
  {
    id: 'caprasimo',
    label: 'Caprasimo',
    stack: "'Caprasimo', system-ui, sans-serif",
    google: 'Caprasimo',
    group: 'Rounded · Display',
  },
  {
    id: 'yusei-magic',
    label: 'Yusei Magic',
    stack: "'Yusei Magic', system-ui, sans-serif",
    google: 'Yusei Magic',
    group: 'Rounded · Display',
  },
  {
    id: 'hachi-maru-pop',
    label: 'Hachi Maru Pop',
    stack: "'Hachi Maru Pop', system-ui, sans-serif",
    google: 'Hachi Maru Pop',
    group: 'Rounded · Display',
  },
  {
    id: 'mochiy-pop-one',
    label: 'Mochiy Pop One',
    stack: "'Mochiy Pop One', system-ui, sans-serif",
    google: 'Mochiy Pop One',
    group: 'Rounded · Display',
  },
  {
    id: 'zen-marugothic',
    label: 'Zen Maru Gothic',
    stack: "'Zen Maru Gothic', system-ui, sans-serif",
    google: 'Zen Maru Gothic',
    group: 'Rounded · Display',
  },

  // ── Soft geometric ──────────────────────────────────────────────────────
  {
    id: 'figtree',
    label: 'Figtree',
    stack: "'Figtree', system-ui, sans-serif",
    google: 'Figtree',
    group: 'Soft geometric',
  },
  {
    id: 'lexend',
    label: 'Lexend',
    stack: "'Lexend', system-ui, sans-serif",
    google: 'Lexend',
    group: 'Soft geometric',
  },
  {
    id: 'manrope',
    label: 'Manrope',
    stack: "'Manrope', system-ui, sans-serif",
    google: 'Manrope',
    group: 'Soft geometric',
  },
  {
    id: 'plus-jakarta-sans',
    label: 'Plus Jakarta Sans',
    stack: "'Plus Jakarta Sans', system-ui, sans-serif",
    google: 'Plus Jakarta Sans',
    group: 'Soft geometric',
  },
  {
    id: 'urbanist',
    label: 'Urbanist',
    stack: "'Urbanist', system-ui, sans-serif",
    google: 'Urbanist',
    group: 'Soft geometric',
  },
  {
    id: 'sora',
    label: 'Sora',
    stack: "'Sora', system-ui, sans-serif",
    google: 'Sora',
    group: 'Soft geometric',
  },
  {
    id: 'mulish',
    label: 'Mulish',
    stack: "'Mulish', system-ui, sans-serif",
    google: 'Mulish',
    group: 'Soft geometric',
  },
  {
    id: 'jost',
    label: 'Jost',
    stack: "'Jost', system-ui, sans-serif",
    google: 'Jost',
    group: 'Soft geometric',
  },
  {
    id: 'karla',
    label: 'Karla',
    stack: "'Karla', system-ui, sans-serif",
    google: 'Karla',
    group: 'Soft geometric',
  },
  {
    id: 'work-sans',
    label: 'Work Sans',
    stack: "'Work Sans', system-ui, sans-serif",
    google: 'Work Sans',
    group: 'Soft geometric',
  },
  {
    id: 'raleway',
    label: 'Raleway',
    stack: "'Raleway', system-ui, sans-serif",
    google: 'Raleway',
    group: 'Soft geometric',
  },
  {
    id: 'dm-sans',
    label: 'DM Sans',
    stack: "'DM Sans', system-ui, sans-serif",
    google: 'DM Sans',
    group: 'Soft geometric',
  },
  {
    id: 'albert-sans',
    label: 'Albert Sans',
    stack: "'Albert Sans', system-ui, sans-serif",
    google: 'Albert Sans',
    group: 'Soft geometric',
  },
  {
    id: 'epilogue',
    label: 'Epilogue',
    stack: "'Epilogue', system-ui, sans-serif",
    google: 'Epilogue',
    group: 'Soft geometric',
  },
  {
    id: 'chivo',
    label: 'Chivo',
    stack: "'Chivo', system-ui, sans-serif",
    google: 'Chivo',
    group: 'Soft geometric',
  },
  {
    id: 'public-sans',
    label: 'Public Sans',
    stack: "'Public Sans', system-ui, sans-serif",
    google: 'Public Sans',
    group: 'Soft geometric',
  },
  {
    id: 'asap',
    label: 'Asap',
    stack: "'Asap', system-ui, sans-serif",
    google: 'Asap',
    group: 'Soft geometric',
  },
  {
    id: 'cabin',
    label: 'Cabin',
    stack: "'Cabin', system-ui, sans-serif",
    google: 'Cabin',
    group: 'Soft geometric',
  },
  {
    id: 'catamaran',
    label: 'Catamaran',
    stack: "'Catamaran', system-ui, sans-serif",
    google: 'Catamaran',
    group: 'Soft geometric',
  },
  {
    id: 'hind',
    label: 'Hind',
    stack: "'Hind', system-ui, sans-serif",
    google: 'Hind',
    group: 'Soft geometric',
  },
  {
    id: 'kanit',
    label: 'Kanit',
    stack: "'Kanit', system-ui, sans-serif",
    google: 'Kanit',
    group: 'Soft geometric',
  },
  {
    id: 'be-vietnam-pro',
    label: 'Be Vietnam Pro',
    stack: "'Be Vietnam Pro', system-ui, sans-serif",
    google: 'Be Vietnam Pro',
    group: 'Soft geometric',
  },
  {
    id: 'spline-sans',
    label: 'Spline Sans',
    stack: "'Spline Sans', system-ui, sans-serif",
    google: 'Spline Sans',
    group: 'Soft geometric',
  },
  {
    id: 'space-grotesk',
    label: 'Space Grotesk',
    stack: "'Space Grotesk', system-ui, sans-serif",
    google: 'Space Grotesk',
    group: 'Soft geometric',
  },
  {
    id: 'red-hat-display',
    label: 'Red Hat Display',
    stack: "'Red Hat Display', system-ui, sans-serif",
    google: 'Red Hat Display',
    group: 'Soft geometric',
  },
  {
    id: 'red-hat-text',
    label: 'Red Hat Text',
    stack: "'Red Hat Text', system-ui, sans-serif",
    google: 'Red Hat Text',
    group: 'Soft geometric',
  },
  {
    id: 'inter',
    label: 'Inter',
    stack: "'Inter', system-ui, sans-serif",
    google: 'Inter',
    group: 'Soft geometric',
  },
  {
    id: 'source-sans-3',
    label: 'Source Sans 3',
    stack: "'Source Sans 3', system-ui, sans-serif",
    google: 'Source Sans 3',
    group: 'Soft geometric',
  },

  // ── Y2K & chrome ────────────────────────────────────────────────────────
  {
    id: 'exo-2',
    label: 'Exo 2',
    stack: "'Exo 2', system-ui, sans-serif",
    google: 'Exo 2',
    group: 'Y2K & chrome',
  },
  {
    id: 'orbitron',
    label: 'Orbitron',
    stack: "'Orbitron', system-ui, sans-serif",
    google: 'Orbitron',
    group: 'Y2K & chrome',
  },
  {
    id: 'audiowide',
    label: 'Audiowide',
    stack: "'Audiowide', system-ui, sans-serif",
    google: 'Audiowide',
    group: 'Y2K & chrome',
  },
  {
    id: 'oxanium',
    label: 'Oxanium',
    stack: "'Oxanium', system-ui, sans-serif",
    google: 'Oxanium',
    group: 'Y2K & chrome',
  },
  {
    id: 'chakra-petch',
    label: 'Chakra Petch',
    stack: "'Chakra Petch', system-ui, sans-serif",
    google: 'Chakra Petch',
    group: 'Y2K & chrome',
  },
  {
    id: 'michroma',
    label: 'Michroma',
    stack: "'Michroma', system-ui, sans-serif",
    google: 'Michroma',
    group: 'Y2K & chrome',
  },
  {
    id: 'syncopate',
    label: 'Syncopate',
    stack: "'Syncopate', system-ui, sans-serif",
    google: 'Syncopate',
    group: 'Y2K & chrome',
  },
  {
    id: 'righteous',
    label: 'Righteous',
    stack: "'Righteous', system-ui, sans-serif",
    google: 'Righteous',
    group: 'Y2K & chrome',
  },
  {
    id: 'russo-one',
    label: 'Russo One',
    stack: "'Russo One', system-ui, sans-serif",
    google: 'Russo One',
    group: 'Y2K & chrome',
  },
  {
    id: 'rajdhani',
    label: 'Rajdhani',
    stack: "'Rajdhani', system-ui, sans-serif",
    google: 'Rajdhani',
    group: 'Y2K & chrome',
  },
  {
    id: 'electrolize',
    label: 'Electrolize',
    stack: "'Electrolize', system-ui, sans-serif",
    google: 'Electrolize',
    group: 'Y2K & chrome',
  },
  {
    id: 'iceland',
    label: 'Iceland',
    stack: "'Iceland', system-ui, sans-serif",
    google: 'Iceland',
    group: 'Y2K & chrome',
  },
];

const STORAGE_KEY = 'studioPlayerUiFont';
const CUSTOM_FONTS_KEY = 'studioPlayerCustomFonts';

/** Load user-added custom fonts from localStorage. */
function getCustomFonts() {
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


/** Convert a custom font entry to a preset-compatible object. */
function customToPreset(f) {
  return {
    id: f.id,
    label: f.label,
    stack: `'${f.family}', system-ui, sans-serif`,
    google: null,
    customCss: f.cssUrl || null,
    group: 'My fonts',
    isCustom: true,
  };
}

/** All available presets — built-ins plus user-added custom fonts. */
function getAllPresets() {
  const custom = getCustomFonts().map(customToPreset);
  return [...UI_FONT_PRESETS, ...custom];
}


export function getStoredFontId() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v) {
      const all = getAllPresets();
      if (all.some((p) => p.id === v)) return v;
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

/** Inline @font-face declarations for bundled fonts. URLs come from Vite asset imports. */
const BUNDLED_FONT_FACES = {
  'modulus-pro': `
    @font-face { font-family: 'Modulus Pro'; font-weight: 200; font-style: normal; font-display: swap; src: url('${modulusProExtraLight}') format('woff2'); }
    @font-face { font-family: 'Modulus Pro'; font-weight: 300; font-style: normal; font-display: swap; src: url('${modulusProLight}') format('woff2'); }
    @font-face { font-family: 'Modulus Pro'; font-weight: 400; font-style: normal; font-display: swap; src: url('${modulusProRegular}') format('woff2'); }
    @font-face { font-family: 'Modulus Pro'; font-weight: 500; font-style: normal; font-display: swap; src: url('${modulusProMedium}') format('woff2'); }
    @font-face { font-family: 'Modulus Pro'; font-weight: 600; font-style: normal; font-display: swap; src: url('${modulusProSemiBold}') format('woff2'); }
    @font-face { font-family: 'Modulus Pro'; font-weight: 700; font-style: normal; font-display: swap; src: url('${modulusProBold}') format('woff2'); }
    @font-face { font-family: 'Modulus Pro'; font-weight: 800; font-style: normal; font-display: swap; src: url('${modulusProExtraBold}') format('woff2'); }
    @font-face { font-family: 'Modulus Pro'; font-weight: 900; font-style: normal; font-display: swap; src: url('${modulusProBlack}') format('woff2'); }
  `,
};

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

  if (preset.bundled && BUNDLED_FONT_FACES[preset.id]) {
    const style = document.createElement('style');
    style.id = linkId;
    style.textContent = BUNDLED_FONT_FACES[preset.id];
    document.head.appendChild(style);
    return;
  }

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
