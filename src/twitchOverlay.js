/**
 * twitchOverlay.js — a tiny local HTTP server that exposes Immerse's
 * now-playing state as an OBS / Streamlabs **browser source** overlay.
 *
 * How it's used:
 *   1. The user enables the overlay in Immerse (Settings → toggles this on).
 *   2. Immerse starts this server on a localhost port and shows the URL.
 *   3. The user adds a Browser Source in OBS pointing at:
 *          http://127.0.0.1:<port>/overlay
 *   4. The renderer pushes the current track via `setNowPlaying(...)` on every
 *      playback change (mirroring the Discord presence flow). The overlay page
 *      polls `/nowplaying.json` and animates updates.
 *
 * Design notes:
 *   - No external dependencies — Node's built-in `http` only.
 *   - Bound to 127.0.0.1 so it's not exposed on the network.
 *   - Cover art: the renderer passes whatever URL it has (http(s) or a
 *     `studio-cover://`/data URL). For OBS, http(s) and data: URLs work
 *     directly; if only embedded art exists the renderer can pass a data URL.
 *   - The overlay HTML is styled to match Immerse: dark glass, the user's
 *     accent, thin large type, cover-art-as-environment bleed.
 */

import http from 'http';
import fs from 'fs';
import { resolveCoverFilePath, mimeForCoverPath } from './coverArtStore.js';

let server = null;
let port = 0;
let state = {
  title: '',
  artist: '',
  album: '',
  coverArtUrl: '',
  isPlaying: false,
  accent: '210,95,70',
  // Visual options the user can tweak from settings:
  theme: 'glass',        // 'glass' | 'minimal' | 'bar'
  showWhenPaused: true,
  updatedAt: 0,
};

function overlayHtml() {
  // Self-contained page. Polls /nowplaying.json and crossfades on change.
  // Three layouts ship in one page; the active one is chosen by the `theme`
  // field (glass | led | island), toggled via body[data-theme].
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Immerse — Now Playing</title>
<style>
  :root { --acc: 210,95,70; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { background:transparent; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }

  /* Only the active theme's container is shown. */
  .ov { display:none; }
  body[data-theme="glass"]   .ov-glass,
  body[data-theme="minimal"] .ov-glass,
  body[data-theme="led"]     .ov-led,
  body[data-theme="island"]  .ov-island { display:flex; }

  /* Shared entrance */
  .ov { opacity:0; transform:translateY(10px); transition:opacity .5s cubic-bezier(0.16,1,0.3,1), transform .5s cubic-bezier(0.16,1,0.3,1); }
  .ov.show { opacity:1; transform:translateY(0); }

  /* Shared EQ */
  .eqbars { display:flex; align-items:flex-end; gap:2px; height:11px; }
  .eqbars span { width:3px; background:rgb(var(--acc)); border-radius:2px; animation:eq 0.9s ease-in-out infinite; }
  .eqbars span:nth-child(2){ animation-delay:.2s } .eqbars span:nth-child(3){ animation-delay:.4s } .eqbars span:nth-child(4){ animation-delay:.1s }
  @keyframes eq { 0%,100%{ height:3px } 50%{ height:11px } }
  body.paused .eqbars span { animation-play-state:paused; opacity:0.4; }
  .label { font-size:9.5px; font-weight:800; letter-spacing:0.18em; text-transform:uppercase; color:rgba(255,255,255,0.55); }
  .ell { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

  /* ── GLASS (default) ─────────────────────────────────────── */
  .ov-glass {
    position:relative; align-items:center; gap:18px;
    width:420px; max-width:calc(100vw - 16px); margin:8px;
    padding:14px 20px 14px 14px; border-radius:18px; overflow:hidden;
    background:rgba(18,18,20,0.55);
    backdrop-filter:blur(30px) saturate(1.6); -webkit-backdrop-filter:blur(30px) saturate(1.6);
    border:1px solid rgba(255,255,255,0.08);
    box-shadow:0 20px 60px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06);
  }
  .ov-glass .bloom { position:absolute; inset:-30%; z-index:0; background-size:cover; background-position:center; filter:blur(48px) saturate(1.7); opacity:0.5; transform:scale(1.2); }
  .ov-glass .tint { position:absolute; inset:0; z-index:0; background:linear-gradient(90deg, rgba(var(--acc),0.18), transparent 70%); }
  .ov-glass .cover { position:relative; z-index:1; width:64px; height:64px; flex-shrink:0; border-radius:12px; background-size:cover; background-position:center; background-color:rgba(0,0,0,0.4); box-shadow:0 10px 26px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.08); }
  .ov-glass .meta { position:relative; z-index:1; flex:1; min-width:0; }
  .ov-glass .eqrow { display:flex; align-items:center; gap:7px; margin-bottom:6px; }
  .ov-glass .title { font-size:18px; font-weight:300; letter-spacing:-0.01em; color:#fff; line-height:1.2; }
  .ov-glass .artist { font-size:13px; color:rgba(255,255,255,0.6); margin-top:3px; }
  body[data-theme="minimal"] .ov-glass { background:transparent; backdrop-filter:none; -webkit-backdrop-filter:none; border:none; box-shadow:none; padding:8px; }
  body[data-theme="minimal"] .ov-glass .bloom, body[data-theme="minimal"] .ov-glass .tint { display:none; }

  /* ── LED MARQUEE ─────────────────────────────────────────── */
  .ov-led {
    position:relative; align-items:center; gap:12px; margin:8px;
    width:440px; max-width:calc(100vw - 16px); height:60px;
    padding:8px 16px 8px 8px; border-radius:12px; overflow:hidden;
    background:#08090c; border:1px solid rgba(var(--acc),0.35);
    box-shadow:0 12px 36px rgba(0,0,0,0.6), inset 0 0 24px rgba(var(--acc),0.08);
  }
  .ov-led::after { content:''; position:absolute; inset:0; pointer-events:none; background-image:radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1px); background-size:4px 4px; }
  /* cover — no accent glow, just a soft neutral shadow */
  .ov-led .cover { position:relative; z-index:1; width:44px; height:44px; border-radius:8px; background-size:cover; background-position:center; background-color:rgba(0,0,0,0.4); flex-shrink:0; box-shadow:0 3px 10px rgba(0,0,0,0.55); }
  .ov-led .pp { position:relative; z-index:1; color:rgb(var(--acc)); font-size:12px; flex-shrink:0; text-shadow:0 0 8px rgb(var(--acc)); animation:blink 1.4s steps(1) infinite; }
  @keyframes blink { 50% { opacity:0.25; } }
  body.paused .ov-led .pp { animation:none; opacity:.4; }
  .ov-led .track { position:relative; z-index:1; flex:1; overflow:hidden; -webkit-mask-image:linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent); mask-image:linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent); }
  .ov-led .scroll { display:inline-block; white-space:nowrap; font-family:'Courier New', monospace; font-weight:700; font-size:17px; letter-spacing:0.06em; color:rgb(var(--acc)); text-shadow:0 0 10px rgba(var(--acc),0.6); animation:marquee 13s linear infinite; }
  body.paused .ov-led .scroll { animation-play-state:paused; }
  @keyframes marquee { 0% { transform:translateX(30%); } 100% { transform:translateX(-100%); } }

  /* ── DYNAMIC ISLAND ──────────────────────────────────────── */
  .ov-island {
    align-items:center; gap:12px; margin:8px;
    width:fit-content; height:56px; padding:8px 18px 8px 8px; border-radius:28px;
    max-width:calc(100vw - 16px);
    background:#050507; border:1px solid rgba(255,255,255,0.06);
    box-shadow:0 14px 38px rgba(0,0,0,0.6);
  }
  .ov-island .cover { width:40px; height:40px; border-radius:12px; background-size:cover; background-position:center; background-color:rgba(0,0,0,0.4); flex-shrink:0; }
  .ov-island .meta { min-width:0; max-width:240px; }
  .ov-island .title { font-size:13.5px; font-weight:600; color:#fff; }
  .ov-island .artist { font-size:11.5px; color:rgba(255,255,255,0.55); margin-top:1px; }
  .ov-island .eqbars { height:18px; margin-left:4px; flex-shrink:0; }
  .ov-island .eqbars span { animation-name:eqIsle; }
  @keyframes eqIsle { 0%,100%{ height:4px } 50%{ height:18px } }
</style></head>
<body data-theme="glass">
  <!-- GLASS -->
  <div class="ov ov-glass">
    <div class="bloom j-bloom"></div><div class="tint"></div>
    <div class="cover j-cover"></div>
    <div class="meta">
      <div class="eqrow"><span class="eqbars"><span></span><span></span><span></span><span></span></span><span class="label j-label">Now Playing</span></div>
      <div class="title j-title ell">—</div>
      <div class="artist j-artist ell"></div>
    </div>
  </div>
  <!-- LED -->
  <div class="ov ov-led">
    <div class="cover j-cover"></div>
    <span class="pp">●</span>
    <div class="track"><span class="scroll j-scroll">—</span></div>
  </div>
  <!-- ISLAND -->
  <div class="ov ov-island">
    <div class="cover j-cover"></div>
    <div class="meta"><div class="title j-title ell">—</div><div class="artist j-artist ell"></div></div>
    <span class="eqbars"><span></span><span></span><span></span><span></span></span>
  </div>
<script>
  const THEMES = ['glass', 'led', 'island', 'minimal'];
  const covers = document.querySelectorAll('.j-cover, .j-bloom');
  const titles = document.querySelectorAll('.j-title');
  const artists = document.querySelectorAll('.j-artist');
  const labels = document.querySelectorAll('.j-label');
  const scrolls = document.querySelectorAll('.j-scroll');
  const containers = { glass: document.querySelector('.ov-glass'), led: document.querySelector('.ov-led'), island: document.querySelector('.ov-island') };
  let last = '';
  let coverVersion = 0;
  function activeContainer(theme) { return containers[theme] || containers.glass; }
  async function tick() {
    try {
      const r = await fetch('/nowplaying.json', { cache:'no-store' });
      const s = await r.json();
      const theme = THEMES.includes(s.theme) ? s.theme : 'glass';
      // accent + theme + play-state applied every tick (cheap; no anim restart)
      document.documentElement.style.setProperty('--acc', s.accent || '210,95,70');
      document.body.dataset.theme = theme;
      document.body.classList.toggle('paused', !s.isPlaying);

      const has = !!(s.title);
      const visible = has && (s.isPlaying || s.showWhenPaused);

      // Heavy field updates only when the track actually changes, so the
      // marquee animation isn't reset on every poll.
      const key = s.title + '|' + s.artist + '|' + s.album + '|' + s.coverArtUrl + '|' + s.isPlaying;
      if (key !== last) {
        last = key;
        coverVersion += 1;
        // Always load the cover through the server's /cover endpoint (relative
        // URL) so OBS gets real bytes regardless of how the app stores it.
        const art = s.coverArtUrl ? 'url("/cover?v=' + coverVersion + '")' : 'none';
        covers.forEach((el) => { el.style.backgroundImage = art; });
        const artistLine = [s.artist, s.album].filter(Boolean).join(' — ');
        titles.forEach((el) => { el.textContent = s.title || ''; });
        artists.forEach((el) => { el.textContent = artistLine; });
        labels.forEach((el) => { el.textContent = s.isPlaying ? 'Now Playing' : 'Paused'; });
        const ticker = 'NOW PLAYING — ' + [s.title, s.artist, s.album].filter(Boolean).join(' · ').toUpperCase() + '     ';
        scrolls.forEach((el) => { el.textContent = ticker; });
      }

      // Show only the active theme's container (every tick so theme switches
      // mid-track take effect immediately).
      Object.values(containers).forEach((el) => { if (el) el.classList.remove('show'); });
      if (visible) { const a = activeContainer(theme); if (a) a.classList.add('show'); }
    } catch (e) { /* server gone — keep last frame */ }
  }
  tick();
  setInterval(tick, 1000);
</script>
</body></html>`;
}

/** Start the overlay server. Returns { ok, port, url } or { ok:false, error }. */
export function start(preferredPort = 7355) {
  if (server) return { ok: true, port, url: `http://127.0.0.1:${port}/overlay` };
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = (req.url || '/').split('?')[0];
      // CORS so OBS's CEF (any origin) can poll without complaint.
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (url === '/nowplaying.json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(state));
        return;
      }
      if (url === '/cover') {
        // Serve the current cover so OBS (which can't load the app's
        // studio-cover:// protocol) gets real image bytes from a plain URL.
        const c = state.coverArtUrl || '';
        try {
          if (c.startsWith('data:')) {
            const m = /^data:([^;]+);base64,(.+)$/s.exec(c);
            if (m) {
              res.writeHead(200, { 'Content-Type': m[1], 'Cache-Control': 'no-store' });
              res.end(Buffer.from(m[2], 'base64'));
              return;
            }
          } else if (c.startsWith('studio-cover://')) {
            const fp = resolveCoverFilePath(c);
            if (fp && fs.existsSync(fp)) {
              res.writeHead(200, { 'Content-Type': mimeForCoverPath(fp), 'Cache-Control': 'no-store' });
              fs.createReadStream(fp).pipe(res);
              return;
            }
          } else if (/^https?:\/\//i.test(c)) {
            // Remote art (e.g. a Spotify URL) — bounce OBS straight to it.
            res.writeHead(302, { Location: c });
            res.end();
            return;
          }
        } catch (e) { /* fall through to 404 */ }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('no cover');
        return;
      }
      if (url === '/overlay' || url === '/' || url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(overlayHtml());
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });
    srv.on('error', (e) => {
      // Port in use — try a couple of fallbacks before giving up.
      if (e && e.code === 'EADDRINUSE' && preferredPort < 7360) {
        resolve(start(preferredPort + 1));
      } else {
        resolve({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    });
    srv.listen(preferredPort, '127.0.0.1', () => {
      server = srv;
      port = preferredPort;
      resolve({ ok: true, port, url: `http://127.0.0.1:${port}/overlay` });
    });
  });
}

export function stop() {
  if (!server) return { ok: true };
  try { server.close(); } catch { /* ignore */ }
  server = null;
  port = 0;
  return { ok: true };
}

/** Update the now-playing payload the overlay shows. Pass null to clear. */
export function setNowPlaying(payload) {
  if (payload == null) {
    state = { ...state, title: '', artist: '', album: '', coverArtUrl: '', isPlaying: false, updatedAt: Date.now() };
    return { ok: true };
  }
  state = {
    ...state,
    title: String(payload.title || ''),
    artist: String(payload.artist || ''),
    album: String(payload.album || ''),
    coverArtUrl: String(payload.coverArtUrl || ''),
    isPlaying: !!payload.isPlaying,
    accent: payload.accent ? String(payload.accent) : state.accent,
    theme: payload.theme || state.theme,
    showWhenPaused: payload.showWhenPaused != null ? !!payload.showWhenPaused : state.showWhenPaused,
    updatedAt: Date.now(),
  };
  return { ok: true };
}

/** Update only visual options (accent/theme/showWhenPaused) without a track. */
export function setOptions(opts = {}) {
  if (opts.accent != null) state.accent = String(opts.accent);
  if (opts.theme != null) state.theme = opts.theme;
  if (opts.showWhenPaused != null) state.showWhenPaused = !!opts.showWhenPaused;
  state.updatedAt = Date.now();
  return { ok: true };
}

export function status() {
  return { ok: true, running: !!server, port, url: server ? `http://127.0.0.1:${port}/overlay` : '' };
}
