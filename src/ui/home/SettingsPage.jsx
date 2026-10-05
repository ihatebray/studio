import React, { useEffect, useState } from 'react';
import { ago, api } from '../../lib/format.js';
import { CompactVizPicker } from '../CompactVisualizer.jsx';
import { SoulseekCredsPanel, SpotifyCredsPanel } from '../StudioOnboarding.jsx';
import { ToastPositionPicker } from '../Toasts.jsx';
import { hexToRgb, rgbToHex } from './common.jsx';
import { NP_BAR_DEFAULT, THEME_DEFAULTS } from './constants.js';
import FontSettings from './FontSettings.jsx';
import { RecordLayoutPicker, recordLayoutOf } from './RecordPage.jsx';
import { SetHowTo, SetLit, SetRow, SetSeg, SetToggle, SpotifyAccountPanel, StudioColorPicker } from './Settings.jsx';
import { checkForUpdate, installUpdate, useUpdate } from '../updates.js';
import Changelog from '../Changelog.jsx';

export default function SettingsPage({
  tour = false,
  onEndTour,
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
  const [tourStep, setTourStep] = useState(0);
  const tourCat = tour ? TOUR[tourStep]?.cat : null;
  useEffect(() => { if (tourCat) setSetCat(tourCat); }, [tourCat]); // eslint-disable-line react-hooks/exhaustive-deps
  const navBtn = (id, label, icon) => (
    <button key={id} type="button" className={`sth-set-navi${cat === id ? ' on' : ''}${tour && TOUR[tourStep]?.mark && tourCat === id ? ' is-tour' : ''}`} aria-current={cat === id ? 'page' : undefined} onClick={() => setSetCat(id)} title={label}>
      <svg viewBox="0 0 24 24" aria-hidden>{icon}</svg><span className="t">{label}</span>
    </button>
  );
  const dim = npAnimatedBg ? { opacity: 0.4, pointerEvents: 'none' } : undefined;
  const ACCENT_SWATCHES = [['255, 122, 89', 'Coral'], ['120, 170, 255', 'Blue'], ['123, 224, 176', 'Mint'], ['214, 150, 255', 'Violet']];
  /* Each tour step starts at the top of its page, where the card is. */
  const bodyRef = React.useRef(null);
  useEffect(() => {
    if (tour && bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [tour, tourStep, cat]);
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

      <div className="sth-set-body" ref={bodyRef}>
        {/* The tour sits at the top of the page, above the title, so it
            pushes the settings down instead of covering any of them. */}
        {tour ? <SettingsTour step={tourStep} setStep={setTourStep} onEnd={onEndTour} /> : null}
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
            {/* Full width: the drawings don't fit the settings' control column. */}
            <div className="sth-set-r" style={{ display: 'block' }}>
              <span className="txt"><b>Album Layout</b><p>How album pages are arranged. Classic is the original page.</p></span>
              <div style={{ marginTop: 14 }}>
                <RecordLayoutPicker label="Album layout" value={recordLayoutOf(theme.recordLayout)} onPick={(v) => setThemeKey('recordLayout', v)} />
              </div>
            </div>
            <div className="sth-set-r" style={{ display: 'block' }}>
              <span className="txt"><b>Playlist Layout</b><p>How playlist pages are arranged. Until you pick one, playlists use the album layout.</p></span>
              <div style={{ marginTop: 14 }}>
                <RecordLayoutPicker label="Playlist layout" value={recordLayoutOf(theme.playlistLayout ?? theme.recordLayout)} onPick={(v) => setThemeKey('playlistLayout', v)} />
              </div>
            </div>
            <SetRow title="Home page" note="Show or hide My Spotify's Home. Hidden, it leaves the sidebar, Studio opens on New Releases, and album countdowns show at the top of New Releases instead.">
              <SetSeg label="Home page" value={theme.showHome === false ? 'hide' : 'show'} onPick={(v) => setThemeKey('showHome', v === 'show')}
                options={[['show', 'Show'], ['hide', 'Hide']]} />
            </SetRow>
            <SetRow title="Album songs" note="Album pages show the songs you own, or the whole album from Spotify with the ones you don't have dimmed, ready to play or save.">
              <SetSeg label="Album songs" value={theme.albumSongs === 'full' ? 'full' : 'owned'} onPick={(v) => setThemeKey('albumSongs', v)}
                options={[['owned', 'Songs you own'], ['full', 'Whole album']]} />
            </SetRow>
            <SetRow title="Album and playlist pages" note="Where these pages take their background. Cover Art follows each release; Fixed uses one shade for all of them.">
              <SetSeg label="Album and playlist pages" value={theme.detailMode} onPick={(v) => setThemeKey('detailMode', v)}
                options={[['cover', 'Cover art'], ['fixed', 'Fixed']]} />
              {theme.detailMode === 'fixed' ? (
                <span className="sth-set-sub"><StudioColorPicker title="Page color" value={rgbToHex(theme.detailColor)}
                  onChange={(hex) => { const v = hexToRgb(hex); if (v) setThemeKey('detailColor', v); }} /></span>
              ) : null}
            </SetRow>
            {recordLayoutOf(theme.recordLayout) === 'classic' || recordLayoutOf(theme.playlistLayout ?? theme.recordLayout) === 'classic' ? (
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
              <SetRow title="Auto-follow artists" note="Follows an artist in Studio once you have more than 5 of their songs, so their new releases and countdowns show up. It checks every time songs are added, imports included. Artists are looked up on Spotify one at a time so your account doesn’t get rate-limited, which means a big import can take a few minutes to finish following. Unfollowing an artist stops it for them.">
                <SetSeg label="Auto-follow artists" value={theme.autoFollow === false ? 'off' : 'on'} onPick={(v) => setThemeKey('autoFollow', v === 'on')}
                  options={[['on', 'On'], ['off', 'Off']]} />
              </SetRow>
              <SetRow title="Date added column" note="Shows when each track joined your library. Hiding it gives the space to Title, Artist and Album." wide={false}>
                <SetToggle label="Date added column" on={showDateAdded} onToggle={toggleDateAdded} />
              </SetRow>
              <SetRow title="Play counts in lists" note="Adds a plays column to album and artist pages. Stats always counts plays either way." wide={false}>
                <SetToggle label="Play counts in lists" on={showPlayCounts} onToggle={toggleShowPlayCounts} />
              </SetRow>
            </div>
            {onClearLibrary || onClearEverything ? (
              <>
                <h2 className="st-section-title" style={{ fontSize: 16, margin: '36px 0 12px' }}>Danger Zone</h2>
                {onClearLibrary ? (
                  <div className="sth-danger">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <b>Clear Library</b>
                      <p>Removes every track, playlist and album note from studio. Your listening history is kept, so re-importing a song brings its play count back.</p>
                    </div>
                    <button type="button" className="st-btn st-btn-danger" disabled={clearing} onClick={() => setClearConfirm({ deleteFiles: false })}>
                      {clearing ? 'Clearing…' : 'Clear Library'}
                    </button>
                  </div>
                ) : null}
                {onClearEverything ? (
                  <div className="sth-danger">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <b>Delete Everything</b>
                      <p>Wipes the library, playlists, album notes and all listening history, then returns studio to its first-run setup screen.</p>
                    </div>
                    <button type="button" className="st-btn st-btn-danger" disabled={clearingAll} onClick={() => setClearAllConfirm({ deleteFiles: false })}>
                      {clearingAll ? 'Deleting…' : 'Delete Everything'}
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}

        {cat === 'system' ? (
          <>
            <div className="st-eyebrow sth-set-subhead">Updates</div>
            <div className="sth-set-list"><UpdatesRow /><ChangelogRow /></div>
            <div className="st-eyebrow sth-set-subhead" style={{ marginTop: 32 }}>Playback</div>
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
                  <h2>Spotify Developer Keys <span style={{ fontWeight: 600, color: 'var(--text-faint)', fontSize: '0.8em' }}>· Optional</span></h2>
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
                  <h2>Run Setup Again</h2>
                  <p style={{ marginBottom: 0 }}>Replays the first-launch walkthrough. Your credentials and library are not touched.</p>
                </div>
                <button type="button" className="st-btn st-btn-outline" onClick={onReplayOnboarding}>Replay Setup</button>
              </section>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ tour
 * Shown once, right after setup: a small card in the corner walks through
 * each part of Settings, opening it and marking it in the list on the left.
 * Nothing is blocked, so anything can be changed along the way. */

/** Settings → System: what came with each version. */
function ChangelogRow() {
  const [open, setOpen] = useState(false);
  const { status: s } = useUpdate();
  return (
    <SetRow title="Changelog" note="What's new in each version of Studio." wide={false}>
      <button type="button" className="st-btn st-btn-outline" onClick={() => setOpen(true)}>View changelog</button>
      {open ? <Changelog current={s.current} onClose={() => setOpen(false)} /> : null}
    </SetRow>
  );
}

/** Settings → System: which version this is, and getting the next one. */
function UpdatesRow() {
  const { status: s } = useUpdate();
  const busy = s.state === 'checking' || s.state === 'downloading';
  const note = {
    checking: 'Checking for a new version…',
    downloading: `Downloading Studio ${s.version} in the background…`,
    ready: `Studio ${s.version} is downloaded. Restart to update; your library and settings stay as they are.`,
    available: `Studio ${s.version} is out. This copy can’t update itself, so download it from GitHub.`,
    none: `Up to date${s.checkedAt ? `, checked ${ago(s.checkedAt)}` : ''}. Studio checks every hour and lets you know in notifications.`,
    error: s.error || 'Couldn’t check for updates.',
  }[s.state] || 'Studio checks for new versions every hour and lets you know in notifications.';
  return (
    <SetRow title={s.current ? `Studio ${s.current}` : 'Studio'} note={note} wide={false}>
      {s.state === 'ready' || s.state === 'available' ? (
        <button type="button" className="st-btn st-btn-primary" onClick={() => { installUpdate(); }}>
          {s.state === 'ready' ? 'Restart to update' : 'Download'}
        </button>
      ) : (
        <button type="button" className="st-btn st-btn-outline" disabled={busy} onClick={() => { checkForUpdate(); }}>
          {s.state === 'checking' ? 'Checking…' : 'Check for updates'}
        </button>
      )}
    </SetRow>
  );
}

const TOUR = [
  { cat: 'colour', mark: false, title: 'Make Studio yours',
    body: 'A quick look at each part of Settings. Each one opens as we go, and anything you change sticks right away. Leave the tour whenever you like.' },
  { cat: 'colour', mark: true, title: 'Color',
    points: [
      ['Immerse', 'a slow gradient from the cover behind the Now Playing bar and side panel'],
      ['Library pages', 'the background of Songs, Albums and Artists'],
      ['Side panel and Now Playing bar', 'plain, one colour, or tinted by the cover'],
      ['Colour intensity', 'how strong cover colours get, from greyscale to full'],
      ['Accent', 'buttons, toggles and the scrubber: white, the cover’s colour, or one you pick'],
    ] },
  { cat: 'font', mark: true, title: 'Font',
    points: [
      ['Rounded fonts', 'pick the typeface for the whole app; each is shown in its own style'],
      ['My fonts', 'add font files you own (select all of a font’s weights at once)'],
    ] },
  { cat: 'layout', mark: true, title: 'Layout',
    points: [
      ['Album and playlist layouts', 'six ways to lay out those pages, set separately'],
      ['Home page', 'show or hide Home; hidden, countdowns move to New Releases'],
      ['Album songs', 'just the songs you own, or the whole album'],
      ['Page background', 'from each cover or one fixed shade, plus header alignment for Classic'],
      ['Sidebar and window', 'the active-tab marker, and Standard or Compact layout'],
      ['Also here', 'the compact bar visualizer, where notifications appear, and list density'],
    ] },
  { cat: 'library', mark: true, title: 'Library',
    points: [
      ['Auto-follow artists', 'artists with more than 5 songs in your library are followed for you, a few at a time'],
      ['Columns', 'show or hide Date added, and play counts on album and artist pages'],
      ['Clear Library', 'removes songs and playlists but keeps your listening history'],
      ['Delete Everything', 'wipes it all, history included, and starts setup again'],
    ] },
  { cat: 'system', mark: true, title: 'System',
    points: [
      ['Updates', 'your version, a button to check for a new one, and the changelog; new versions also show up in notifications'],
      ['Gapless playback', 'no silence between songs, for live albums and mixes'],
      ['Discord', 'show what you’re playing on your profile, hide it when paused, use your own app name'],
      ['imgbb key', 'optional; lets covers of your own files show on Discord'],
    ] },
  { cat: 'connections', mark: true, title: 'Connections',
    points: [
      ['Spotify', 'your sign-in, which plays Spotify songs and fills My Spotify'],
      ['Spotify developer keys', 'optional backup search when your sign-in is busy'],
      ['Soulseek', 'optional second source for rarer songs'],
      ['Run setup again', 'goes back through setup; your library stays'],
    ] },
];

const TOUR_CSS = `
.sth-set-navi.is-tour { box-shadow: 0 0 0 2px rgba(var(--accent-rgb, 255,255,255), 0.85); animation: sthTourPulse 1.6s ease-in-out infinite; }
@keyframes sthTourPulse { 0%, 100% { box-shadow: 0 0 0 2px rgba(var(--accent-rgb, 255,255,255), 0.85); } 50% { box-shadow: 0 0 0 5px rgba(var(--accent-rgb, 255,255,255), 0.25); } }
.sth-tour { position: relative; margin: 0 0 26px; padding: 16px 18px 14px; border-radius: 14px; box-sizing: border-box;
  background: rgba(var(--st-fg-rgb), 0.05); box-shadow: inset 0 0 0 1px rgba(var(--st-fg-rgb), 0.1); animation: sthTourIn .28s cubic-bezier(0.22,1,0.36,1) both; }
@keyframes sthTourIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.sth-tour-top { display: flex; align-items: center; gap: 4px; margin-bottom: 10px; }
.sth-tour-top i { width: 14px; height: 4px; border-radius: 2px; background: rgba(var(--st-fg-rgb), 0.18); }
.sth-tour-top i.on { width: 22px; background: rgb(var(--accent-rgb, 255,255,255)); }
.sth-tour-top i.done { background: rgba(var(--st-fg-rgb), 0.5); }
.sth-tour-skip { margin-left: auto; border: none; background: none; padding: 0; cursor: pointer; font: inherit; font-size: 12px; font-weight: 600; color: rgba(var(--st-sub-rgb), 0.55); }
.sth-tour-skip:hover { color: var(--st-text); }
.sth-tour b { display: block; font-size: 16px; font-weight: 800; color: var(--st-text); }
.sth-tour p { margin: 5px 0 14px; font-size: 13px; line-height: 1.55; color: rgba(var(--st-text-rgb), 0.72); }
.sth-tour ul { margin: 8px 0 14px; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 7px 22px; }
.sth-tour li { position: relative; padding-left: 13px; font-size: 12.5px; line-height: 1.45; color: rgba(var(--st-text-rgb), 0.66); }
.sth-tour li::before { content: ''; position: absolute; left: 0; top: 7px; width: 5px; height: 5px; border-radius: 50%; background: rgba(var(--st-fg-rgb), 0.35); }
.sth-tour li strong { color: var(--st-text); font-weight: 700; }
.sth-tour-acts { display: flex; align-items: center; gap: 8px; }
.sth-tour-acts .n { font-size: 12px; font-weight: 600; color: rgba(var(--st-sub-rgb), 0.45); font-variant-numeric: tabular-nums; }
`;

function SettingsTour({ step, setStep, onEnd }) {
  const last = step >= TOUR.length - 1;
  const s = TOUR[step];
  return (
    <div className="sth-tour" role="dialog" aria-label="Settings tour">
      <style>{TOUR_CSS}</style>
      <div className="sth-tour-top">
        {TOUR.map((t, i) => <i key={t.title} className={i === step ? 'on' : i < step ? 'done' : ''} />)}
        <button type="button" className="sth-tour-skip" onClick={() => onEnd?.(false)}>{last ? 'Close' : 'Skip tour'}</button>
      </div>
      <b>{s.title}</b>
      {s.body ? <p>{s.body}</p> : null}
      {s.points ? (
        <ul>{s.points.map(([k, v]) => <li key={k}><strong>{k}</strong>: {v}</li>)}</ul>
      ) : null}
      <div className="sth-tour-acts">
        <span className="n">{step + 1} of {TOUR.length}</span>
        <span style={{ flex: 1 }} />
        {step > 0 ? <button type="button" className="st-btn st-btn-sm st-btn-ghost" onClick={() => setStep(step - 1)}>Back</button> : null}
        {last
          ? <button type="button" className="st-btn st-btn-sm st-btn-primary" onClick={() => onEnd?.(true)}>Start listening</button>
          : <button type="button" className="st-btn st-btn-sm st-btn-primary" onClick={() => setStep(step + 1)}>{step === 0 ? 'Show me' : 'Next'}</button>}
      </div>
    </div>
  );
}
