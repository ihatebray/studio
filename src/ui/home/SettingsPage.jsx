import React from 'react';
import { api } from '../../lib/format.js';
import { CompactVizPicker } from '../CompactVisualizer.jsx';
import { SoulseekCredsPanel, SpotifyCredsPanel } from '../StudioOnboarding.jsx';
import { ToastPositionPicker } from '../Toasts.jsx';
import { hexToRgb, rgbToHex } from './common.jsx';
import { NP_BAR_DEFAULT, THEME_DEFAULTS } from './constants.js';
import FontSettings from './FontSettings.jsx';
import { RecordLayoutPicker } from './RecordPage.jsx';
import { SetHowTo, SetLit, SetRow, SetSeg, SetToggle, SpotifyAccountPanel, StudioColorPicker } from './Settings.jsx';

export default function SettingsPage({
  uiFontId,
  onSetUiFontId,
  accentFixed,
  accentMode,
  clearing,
  clearingAll,
  compactMode,
  compactViz,
  compactVizCover,
  connState,
  detailAlign,
  discordAppId,
  discordHideWhenPaused,
  discordPresenceDetail,
  discordPresenceEnabled,
  discordStatus,
  imgbbApiKey,
  listDensity,
  navStyle,
  npAnimatedBg,
  npBarColor,
  npWashTheme,
  onClearEverything,
  onClearLibrary,
  onReplayOnboarding,
  onSetDiscordAppId,
  onSetDiscordHideWhenPaused,
  onSetDiscordPresenceDetail,
  onSetDiscordPresenceEnabled,
  onSetImgbbApiKey,
  onSetTransitionMode,
  onSpotifyCredsSaved,
  pickAccentFixed,
  pickAccentMode,
  pickCompactMode,
  pickCompactViz,
  pickDetailAlign,
  pickListDensity,
  pickNpBarColor,
  rawAccent,
  setCat,
  setClearAllConfirm,
  setClearConfirm,
  setConnState,
  setDiscordPresenceDetailSafely,
  setNavStylePref,
  setSetCat,
  setThemeKey,
  showDateAdded,
  showPlayCounts,
  theme,
  toggleCompactVizCover,
  toggleDateAdded,
  toggleNpAnimatedBg,
  toggleShowPlayCounts,
  transitionMode,
}) {
  /* Brief, Settings: Playback and Discord merged into one System page
     (a navigation change — flagged in the brief for confirmation).
     Old stored categories map onto it. */
  const cat = setCat === 'playback' || setCat === 'discord' ? 'system' : setCat;
  const CATS = {
    colour: ['Color', 'Which surfaces take their colour from the artwork, and how strongly.'],
    font: ['Font', 'The typeface for the whole app. Rounded faces only; add your own under My fonts.'],
    layout: ['Layout', 'How pages and lists are arranged.'],
    library: ['Library', 'What the song table shows, and managing the library itself.'],
    system: ['System', 'Playback behaviour and what studio shares with Discord.'],
    connections: ['Connections', 'Services studio uses for search, metadata and downloads.'],
  };
  const navBtn = (id, label, icon) => (
    <button key={id} type="button" className={`sth-set-navi${cat === id ? ' on' : ''}`} aria-current={cat === id ? 'page' : undefined} onClick={() => setSetCat(id)}>
      <svg viewBox="0 0 24 24" aria-hidden>{icon}</svg>{label}
    </button>
  );
  const dim = npAnimatedBg ? { opacity: 0.4, pointerEvents: 'none' } : undefined;
  const ACCENT_SWATCHES = [['255, 122, 89', 'Coral'], ['120, 170, 255', 'Blue'], ['123, 224, 176', 'Mint'], ['214, 150, 255', 'Violet']];
  return (
    <div className="sth-set-wrap">
      <nav className="sth-set-rail" aria-label="Settings categories">
        <div className="lbl st-eyebrow">Appearance</div>
        {navBtn('colour', 'Color', <><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 0 18" /></>)}
        {navBtn('font', 'Font', <><path d="M5 19 10.5 5h1L17 19" /><path d="M7.5 13.5h7" /></>)}
        {navBtn('layout', 'Layout', <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>)}
        {navBtn('library', 'Library', <path d="M4 6h16M4 12h16M4 18h10" />)}
        <div className="lbl st-eyebrow">System</div>
        {navBtn('system', 'System', <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>)}
        {navBtn('connections', 'Connections', <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>)}
      </nav>

      <div className="sth-set-body">
        <div style={{ marginBottom: 20 }}>
          <h1 className="st-page-title">{CATS[cat]?.[0]}</h1>
          <p style={{ fontSize: 14, color: 'var(--text-dim)', margin: '8px 0 0' }}>{CATS[cat]?.[1]}</p>
        </div>

        {cat === 'colour' ? (
          <div className="sth-set-list">
            <SetRow title="Immerse" note="A slow gradient made from the artwork, behind the Now Playing bar and side panel. Overrides both settings below." wide={false}>
              <SetToggle label="Immerse" on={npAnimatedBg} onToggle={toggleNpAnimatedBg} />
            </SetRow>
            <SetRow title="Library pages" note="Background for Songs, Albums and Artists. Cover Art tints the top of the list; Full Color carries it all the way down.">
              <SetSeg label="Library pages" value={theme.pageSurface} onPick={(v) => setThemeKey('pageSurface', v)}
                options={[['off', 'Off'], ['colour', 'Color'], ['cover', 'Cover art'], ['coverFull', 'Full color']]} />
              {theme.pageSurface === 'colour' ? (
                <span className="sth-set-sub"><StudioColorPicker title="Library page color" value={rgbToHex(theme.pageColour)}
                  onChange={(hex) => { const v = hexToRgb(hex); if (v) setThemeKey('pageColour', v); }}
                  onReset={() => setThemeKey('pageColour', THEME_DEFAULTS.pageColour)} /></span>
              ) : null}
            </SetRow>
            <SetRow title="Side panel" note={npAnimatedBg ? 'Immerse is showing the artwork here.' : 'Background for the Queue, Lyrics and Info panel. Match Bar reuses the Now Playing bar surface so the two read as one piece.'}>
              <span style={{ display: 'contents', ...dim }}>
                <SetSeg label="Side panel" value={theme.panelSurface} onPick={(v) => setThemeKey('panelSurface', v)}
                  options={[['black', 'Black'], ['colour', 'Color'], ['cover', 'Cover art'], ['bar', 'Match bar']]} />
              </span>
              {theme.panelSurface === 'colour' && !npAnimatedBg ? (
                <span className="sth-set-sub"><StudioColorPicker title="Panel color" value={rgbToHex(theme.panelColour)}
                  onChange={(hex) => { const v = hexToRgb(hex); if (v) setThemeKey('panelColour', v); }}
                  onReset={() => setThemeKey('panelColour', THEME_DEFAULTS.panelColour)} /></span>
              ) : null}
            </SetRow>
            <SetRow title="Now Playing bar" note={npAnimatedBg ? 'Immerse is showing the artwork here.' : 'Background for the bar along the bottom. Cover Art follows whatever is playing; Color stays fixed.'}>
              <span style={{ display: 'contents', ...dim }}>
                <SetSeg label="Now Playing bar" value={theme.barSurface} onPick={(v) => setThemeKey('barSurface', v)}
                  options={[['colour', 'Color'], ['cover', 'Cover art']]} />
              </span>
              {theme.barSurface === 'colour' && !npAnimatedBg ? (
                <span className="sth-set-sub"><StudioColorPicker title="Now Playing bar color" value={npBarColor}
                  onChange={pickNpBarColor} onReset={() => pickNpBarColor(NP_BAR_DEFAULT)} /></span>
              ) : null}
            </SetRow>
            <SetRow title="Colour intensity" note="How saturated cover colours get. Off is greyscale; Full is the strongest and makes faint text harder to read.">
              <SetSeg label="Colour intensity" value={theme.colourIntensity} onPick={(v) => setThemeKey('colourIntensity', v)}
                options={[['off', 'Off'], ['muted', 'Muted'], ['balanced', 'Balanced'], ['vivid', 'Vivid'], ['full', 'Full']]} />
            </SetRow>
            <SetRow title="Accent" note="The colour used for buttons, toggles, the scrubber and focus rings. White is the default and reads on every surface; Follow artwork matches it to whatever is playing; Fixed pins one colour of your choosing.">
              <SetSeg label="Accent" value={accentMode} onPick={pickAccentMode}
                options={[['white', 'White'], ['artwork', 'Follow artwork'], ['fixed', 'Fixed']]} />
              {accentMode === 'fixed' ? (
                <span className="sth-set-sub" role="radiogroup" aria-label="Fixed accent colour" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                  {ACCENT_SWATCHES.map(([rgb, name]) => (
                    <button key={rgb} type="button" role="radio" aria-checked={accentFixed === rgb} aria-label={name} title={name}
                      onClick={() => pickAccentFixed(rgb)}
                      style={{ height: 30, borderRadius: 8, border: 'none', cursor: 'pointer', background: `rgb(${rgb})`,
                        boxShadow: accentFixed === rgb ? '0 0 0 2px var(--surface), 0 0 0 4px #fff' : 'none' }} />
                  ))}
                </span>
              ) : null}
            </SetRow>
          </div>
        ) : null}

        {cat === 'font' ? <FontSettings uiFontId={uiFontId} onSetUiFontId={onSetUiFontId} /> : null}

        {cat === 'layout' ? (
          <div className="sth-set-list">
            {/* Full width: seven drawings don't fit the settings' control column. */}
            <div className="sth-set-r" style={{ display: 'block' }}>
              <span className="txt"><b>Album and playlist layout</b><p>How album and playlist pages are arranged. Classic is the original page.</p></span>
              <div style={{ marginTop: 14 }}>
                <RecordLayoutPicker value={theme.recordLayout || 'classic'} onPick={(v) => setThemeKey('recordLayout', v)} />
              </div>
            </div>
            <SetRow title="Album and playlist pages" note="Where these pages take their background. Cover Art follows each release; Fixed uses one shade for all of them.">
              <SetSeg label="Album and playlist pages" value={theme.detailMode} onPick={(v) => setThemeKey('detailMode', v)}
                options={[['cover', 'Cover art'], ['fixed', 'Fixed']]} />
              {theme.detailMode === 'fixed' ? (
                <span className="sth-set-sub"><StudioColorPicker title="Page color" value={rgbToHex(theme.detailColor)}
                  onChange={(hex) => { const v = hexToRgb(hex); if (v) setThemeKey('detailColor', v); }} /></span>
              ) : null}
            </SetRow>
            {(theme.recordLayout || 'classic') === 'classic' ? (
              <SetRow title="Album header alignment" note="Where the title and artist sit relative to the cover art.">
                <SetSeg label="Album header alignment" value={detailAlign} onPick={pickDetailAlign}
                  options={[['flex-start', 'Top'], ['center', 'Center'], ['flex-end', 'Bottom']]} />
              </SetRow>
            ) : null}
            <SetRow title="Active tab marker" note="How the sidebar shows which library tab you are on.">
              <SetSeg label="Active tab marker" value={navStyle === 'glow' ? 'chip' : navStyle} onPick={setNavStylePref}
                options={[['chip', 'Chip'], ['bar', 'Bar'], ['underline', 'Underline'], ['dot', 'Dot']]} />
            </SetRow>
            <SetRow title="Window layout" note="Compact gives the whole window to the page you're on, with the Now Playing bar full width underneath. Touch the top or left edge to bring back the top bar or the library. Ctrl+Shift+C switches.">
              <SetSeg label="Window layout" value={compactMode ? 'compact' : 'standard'} onPick={(v) => pickCompactMode(v === 'compact')}
                options={[['standard', 'Standard'], ['compact', 'Compact']]} />
            </SetRow>
            <SetRow title="Compact bar visualizer" note="Fills the empty middle of the library bar in compact mode. Follows local files and Saved Spotify songs alike, and stays still when paused or when reduced motion is on.">
              <CompactVizPicker value={compactViz} onPick={pickCompactViz} palette={npWashTheme?.palette} accent={rawAccent} coverColours={compactVizCover} />
            </SetRow>
            <SetRow title="Visualizer colours from the cover" note="On, the visualizer takes its colours from the album playing. Off, it's drawn in white, whatever the album." wide={false}>
              <SetToggle label="Visualizer colours from the cover" on={compactVizCover} onToggle={toggleCompactVizCover} />
            </SetRow>
            <SetRow title="Notifications" note="Where notifications appear. Own lane makes room for them so they never cover anything; the player bar option shows them over the song info for a moment. Hover a notification to hold it.">
              <ToastPositionPicker />
            </SetRow>
            <SetRow title="List density" note="Row height in Songs, albums and playlists. Compact fits about half again as many rows on screen.">
              <SetSeg label="List density" value={listDensity} onPick={pickListDensity}
                options={[['compact', 'Compact'], ['default', 'Default'], ['roomy', 'Roomy']]} />
            </SetRow>
          </div>
        ) : null}

        {cat === 'library' ? (
          <>
            <div className="sth-set-list">
              <SetRow title="Date added column" note="Shows when each track joined your library. Hiding it gives the space to Title, Artist and Album." wide={false}>
                <SetToggle label="Date added column" on={showDateAdded} onToggle={toggleDateAdded} />
              </SetRow>
              <SetRow title="Play counts in lists" note="Adds a plays column to album and artist pages. Stats always counts plays either way." wide={false}>
                <SetToggle label="Play counts in lists" on={showPlayCounts} onToggle={toggleShowPlayCounts} />
              </SetRow>
            </div>
            {onClearLibrary || onClearEverything ? (
              <>
                <h2 className="st-section-title" style={{ fontSize: 16, margin: '36px 0 12px' }}>Danger zone</h2>
                {onClearLibrary ? (
                  <div className="sth-danger">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <b>Clear library</b>
                      <p>Removes every track, playlist and album note from studio. Your listening history is kept, so re-importing a song brings its play count back.</p>
                    </div>
                    <button type="button" className="st-btn st-btn-danger" disabled={clearing} onClick={() => setClearConfirm({ deleteFiles: false })}>
                      {clearing ? 'Clearing…' : 'Clear library'}
                    </button>
                  </div>
                ) : null}
                {onClearEverything ? (
                  <div className="sth-danger">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <b>Delete everything</b>
                      <p>Wipes the library, playlists, album notes and all listening history, then returns studio to its first-run setup screen.</p>
                    </div>
                    <button type="button" className="st-btn st-btn-danger" disabled={clearingAll} onClick={() => setClearAllConfirm({ deleteFiles: false })}>
                      {clearingAll ? 'Deleting…' : 'Delete everything'}
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}

        {cat === 'system' ? (
          <>
            <div className="st-eyebrow sth-set-subhead">Playback</div>
            <div className="sth-set-list">
              {onSetTransitionMode ? (
                <SetRow title="Gapless playback" note="Removes the silence between tracks. Best on live albums and continuous mixes." wide={false}>
                  <SetToggle label="Gapless playback" on={transitionMode === 'gapless'}
                    onToggle={() => onSetTransitionMode(transitionMode === 'gapless' ? 'none' : 'gapless')} />
                </SetRow>
              ) : null}
            </div>
            {onSetDiscordPresenceEnabled ? (
              <>
                <div className="st-eyebrow sth-set-subhead" style={{ marginTop: 32 }}>Discord</div>
                <div className="sth-set-list">
                  <SetRow title="Rich presence" wide={false}
                    note={discordPresenceEnabled
                      ? (discordStatus?.unavailable ? 'Enabled, but this build is missing the Discord module.'
                        : discordStatus?.connected ? 'Connected. Your profile shows what studio is playing.'
                          : 'Waiting for the Discord desktop app.')
                      : 'Show the playing track on your Discord profile. Requires the Discord desktop app.'}>
                    <SetToggle label="Rich presence" on={discordPresenceEnabled} onToggle={() => onSetDiscordPresenceEnabled(!discordPresenceEnabled)} />
                  </SetRow>
                  {onSetDiscordHideWhenPaused ? (
                    <SetRow title="Hide when paused" note="Clears your Discord status while playback is stopped." wide={false}>
                      <SetToggle label="Hide when paused" on={discordHideWhenPaused} onToggle={() => onSetDiscordHideWhenPaused(!discordHideWhenPaused)} />
                    </SetRow>
                  ) : null}
                  {discordPresenceEnabled && onSetDiscordPresenceDetail ? (
                    <SetRow title="Show on your profile" note="The album still appears when you hover the cover art on Discord either way.">
                      <SetSeg label="Show on your profile" value={discordPresenceDetail} onPick={setDiscordPresenceDetailSafely}
                        options={[['full', 'Title, artist, album'], ['basic', 'Title, artist']]} />
                    </SetRow>
                  ) : null}
                  {discordPresenceEnabled ? (
                    <SetRow title="Application ID" note="Optional. Use your own Discord application to change the name shown on your profile.">
                      <input className="st-input" placeholder="e.g. 1123581321345589" value={discordAppId}
                        onChange={(e) => onSetDiscordAppId?.(e.target.value)} spellCheck={false} aria-label="Discord application ID" />
                      <span className="sth-set-sub">
                        <SetHowTo label="How do I get an Application ID?">
                          <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.85 }}>
                            <li>Open the{' '}<button type="button" className="sth-set-link" onClick={() => api()?.openExternal?.('https://discord.com/developers/applications')}>Discord Developer Portal</button>{' '}and sign in.</li>
                            <li>Click <SetLit>New Application</SetLit>. Its name is what Discord shows on your profile.</li>
                            <li>Copy the <SetLit>Application ID</SetLit> from General Information and paste it here.</li>
                            <li>For artwork, upload images named <SetLit>immerse_logo</SetLit>, <SetLit>play</SetLit> and <SetLit>pause</SetLit> under Rich Presence, Art Assets.</li>
                          </ol>
                        </SetHowTo>
                      </span>
                    </SetRow>
                  ) : null}
                  {discordPresenceEnabled ? (
                    <SetRow title="imgbb API key" note="Optional. Lets custom local cover art appear on Discord by uploading it once to imgbb.">
                      <input className="st-input" placeholder="From api.imgbb.com" value={imgbbApiKey}
                        onChange={(e) => onSetImgbbApiKey?.(e.target.value)} spellCheck={false} aria-label="imgbb API key" />
                    </SetRow>
                  ) : null}
                </div>
                {discordStatus?.lastError ? (
                  <div role="status" style={{ fontSize: 12, color: 'var(--danger)', marginTop: 8 }}>{String(discordStatus.lastError)}</div>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}

        {cat === 'connections' ? (
          <div style={{ display: 'grid', gap: 16 }}>
            {/* The account does the work (playback, My Spotify, artist
                pages, search); the developer keys are a backup. */}
            <SpotifyAccountPanel />
            <section className="sth-conn">
              <div className="sth-conn-head">
                <div>
                  <h2>Spotify developer keys <span style={{ fontWeight: 600, color: 'var(--text-faint)', fontSize: '0.8em' }}>· optional</span></h2>
                  <p>A backup for search and song details when your Spotify sign-in is busy or rate-limited. Any free developer app works.</p>
                </div>
                {connState.spotify != null ? (
                  <span className={`st-status ${connState.spotify ? 'ok' : 'off'}`}>{connState.spotify ? 'Saved' : 'Not set'}</span>
                ) : null}
              </div>
              <SpotifyCredsPanel compact onSaved={onSpotifyCredsSaved}
                onStatus={(v) => setConnState((c2) => ({ ...c2, spotify: v }))} />
            </section>
            <section className="sth-conn">
              <div className="sth-conn-head">
                <div>
                  <h2>Soulseek</h2>
                  <p>Optional. A second download source, usually higher quality. Pick any username; the account is made on first login.</p>
                </div>
                {connState.soulseek != null ? (
                  <span className={`st-status ${connState.soulseek ? 'ok' : 'off'}`}>{connState.soulseek ? 'Connected' : 'Not connected'}</span>
                ) : null}
              </div>
              <SoulseekCredsPanel compact onStatus={(v) => setConnState((c2) => ({ ...c2, soulseek: v }))} />
            </section>
            {onReplayOnboarding ? (
              <section className="sth-conn" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h2>Run setup again</h2>
                  <p style={{ marginBottom: 0 }}>Replays the first-launch walkthrough. Your credentials and library are not touched.</p>
                </div>
                <button type="button" className="st-btn st-btn-outline" onClick={onReplayOnboarding}>Replay setup</button>
              </section>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
