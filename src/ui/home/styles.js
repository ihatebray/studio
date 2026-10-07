

/* ---------------------------------------------------------------------------
 * Artwork identity, and why a URL isn't it.
 *
 * The now-playing square cross-dissolves on every track change. That reads as
 * a swap when the picture genuinely changes and as nothing at all when it
 * doesn't — provided "doesn't" is decided on the PICTURE. Decided on the URL
 * string it's wrong constantly, because one record reaches the app by more
 * than one route and each route names the same image differently:
 *
 *   in-app download  → studio-cover://local/<sha1 of the fetched jpeg>.jpg
 *   local file       → studio-cover://local/<sha1 of the embedded jpeg>.jpg,
 *                      or a data: URI for the rest of the session it was
 *                      imported in
 *
 * Byte-identical artwork gives an identical sha1 and therefore an identical
 * URL — but re-encoding, a different source resolution, or a tagger rewriting
 * the APIC frame changes the bytes without changing the picture, and then the
 * two URLs differ. Chromium has no idea they're the same image, so it has to
 * fetch and rasterise the second one; the square paints empty for a frame or
 * two while that happens, and that blank frame is the blink.
 * ------------------------------------------------------------------------- */



 // url → { img, promise }


  // 72px cover + 16px breathing room — matches
                              // the overlay's MINI_HEADER_H exactly.































/** Rounded glass card that wraps a group of result rows. */
/* =========================================================================
 *  Find — search results
 *
 *  One surface, split in two: everything that matched on the left, the thing
 *  you picked on the right. Neither column is a card; they sit directly on the
 *  content panel and are separated by whichever device is chosen in
 *  Settings → Appearance (hairline / accent wash / gutter).
 *
 *  What the right column shows depends on what's selected, and in every case
 *  it's the thing you'd otherwise have to guess at:
 *    Spotify album  → the tracklist, with what you already own marked
 *    Spotify song   → the song, and the album it came from
 *    Soulseek folder→ every file in it, and what the whole thing weighs
 *    Soulseek song  → EVERY peer offering it, ranked, so "which one do I
 *                     take" becomes a visible choice rather than a lucky dip
 *
 *  That last one is the reason this view exists. A search for one album comes
 *  back as ~90 rows that are really 12 songs offered by 30 people; the old
 *  view rendered all 90 as bare filenames with no format, no availability and
 *  no way to compare them.
 * ========================================================================= */




/* FindResults, FindGetBtn, FindGhostBtn, ResultsCard and FolderGlyph lived
 * here. The Find page is gone: the palette answers the same question in
 * fewer keystrokes without leaving the page you were on, so a second
 * full-screen results surface was two implementations of one feature.
 * Chevron / ResultRow / RowBtn below survive — Discover and the release
 * panel use them too. */

/* Every StudioHome surface's styles, injected once by StudioHome. */
export const HOME_CSS = `
        /* Redefine stFadeUp to settle at transform: none rather than
           translateY(0). A lingering identity transform keeps the element (and
           .sth-scroll, which wraps all content) on a composited GPU layer, and
           that layer + backdrop-filter is what renders text subtly blurry in
           Chromium. Ending at "none" declassifies the layer so text stays crisp
           while the fade-up motion is unchanged. */
        @keyframes stFadeUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
        /* Inset panel: the content sits in its own rounded surface rather
           than bleeding to the window edges, so the shell reads as chrome and
           this reads as the thing you're looking at. margin (not padding) on
           the outside, because the rounded corners have to clip the scrolling
           content — padding would let it run under them. */
        /* Bottom margin is 104, not 12: the Now Playing bar is position: fixed
           at bottom 12 and 84 tall, so the panel has to end above it (96) plus
           a gap, or the last row of content sits underneath.
           Pure black, exactly like the bar and the shell — so the panel is
           defined by its BORDER, not by a difference in fill. The border
           carries all the weight here, which is why it's 0.11 rather than the
           0.05 hairline used elsewhere: at 0.05 against an identical
           background the edge simply disappears. */
        .sth-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 26px 90px; margin: 0 12px 104px; border-radius: 16px; background: rgb(var(--st-bg-rgb)); border: 1px solid rgba(var(--st-fg-rgb), 0.11); scrollbar-width: none; -ms-overflow-style: none; }
        /* Album / playlist page fills the wrapper edge to edge.
           The wrapper's own 18/26/90 padding is right for a scrolling page of
           sections, but here it inset the page inside the panel — visible as a
           second rounded rectangle and ~90px of dead space at the bottom. The
           page scrolls its own tracklist, so this container mustn't scroll too
           or the two fight each other. */
        /* Album / playlist page fills the wrapper exactly.
           A flex:1 rule on every child wasn't enough: the scroller has several children
           (one per section) and the ones that render null still left the flex
           maths splitting space, so the page came up short and the wrapper's
           black showed underneath. Absolute inset removes the flex chain from
           the equation entirely — the page is pinned to all four edges. */
        .sth-scroll.is-page { padding: 0; overflow: hidden; position: relative; }
        .sth-scroll.is-page > .sth-libpage { position: absolute; inset: 0; }
        /* Scrollbar hidden — the panel has rounded corners and a visible
           gutter running down the inside of them looked like a defect. */
        .sth-scroll::-webkit-scrollbar { width: 0; height: 0; display: none; }
        .sth-scroll::-webkit-scrollbar { width: 6px; }
        .sth-scroll::-webkit-scrollbar-thumb { background: rgba(var(--st-fg-rgb), 0.14); border-radius: 999px; }
        /* --- library song table --- */
        /* =================== Find: results split view ====================
           One surface, not two. An earlier pass gave each column the
           .sth-libpanel treatment (fill + border + radius) and the result was
           a card inside the content panel's card — a box in a box. Here the
           columns sit directly on the page and are told apart by ONE device,
           chosen in Settings → Appearance:
             rule  — a 1px hairline, same weight as the table dividers
             wash  — no rules; the detail side carries a cover-accent gradient
             gap   — nothing but space
           The page header spans both columns. Giving each column its own
           header is the other half of what made them read as two widgets. */
        /* Falls off over 280px so it reads as light on the surface rather than
           a panel with a coloured top. Behind everything (z-index on content). */

        /* Section labels stick to the top of their own column. Solid bg, not
           translucent: rows scrolling under a blurred label is the one place
           backdrop-filter reliably looks like a smear. */

        /* The selected row points AT the detail column instead of being
           outlined — an outline on a row sitting on a flat page just draws a
           small card again, which is the thing this layout removed. */
        /* Plain facts get dot separators; badges and the slot tag don't, since
           they're already visually bounded and a dot in front of a pill reads
           as a bullet list. Only .sth-fmi carries the dot, and only when it
           follows another .sth-fmi — so "keshi · 2025 · 3 tracks" gets them
           while "[FLAC] keshi · 3 sources ●Free slot" doesn't get a stray one
           after the badge. */


        /* Filter chips. The old ones were flat dark pills with a label and no
           other signal — you couldn't tell a toggle from a button, or on from
           off at a glance. Now: a state box on the left that fills and checks
           when active, and a count of what the filter is actually doing, so
           the chip reports as well as controls. */
        /* Drawn rather than a glyph so it scales with the box and inherits the
           accent's contrast colour. */

        /* Detail column */
        /* One peer offering one song. Stretched rather than tabular: the path
           needs a full line of its own and the numbers are all short. */
        /* rtl keeps the END of a long path visible — the filename matters, the
           first 40 characters of someone's directory tree do not. */

        /* Below 1120 there isn't room for two columns — the list becomes the
           page and picking something swaps to the detail, with a back button
           that only exists at this width. Matches .sth-lib2's behaviour. */

        /* ===================== Top bar search =========================
           A real field at rest, not an invisible one that appears on focus.
           It's the only input in the chrome and the way into the whole Find
           view, so it reads as a control you can aim at — but the fill is low
           enough (0.05) that it still sits behind the active nav tab.
           Pill, not the 11–13px radius used elsewhere: nothing else in the app
           is a text field, and the shape is what says "type here" before you
           read anything. */
        .sth-searchbar { display: flex; align-items: center; gap: 10px; width: 100%; height: 40px; padding: 0 10px 0 14px; box-sizing: border-box;
          border-radius: 11px; cursor: text; background: rgba(var(--st-fg-rgb), 0.055); border: 1px solid rgba(var(--st-fg-rgb), 0.07);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
          transition: background 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease; }
        .sth-searchbar:hover { background: rgba(var(--st-fg-rgb), 0.08); border-color: rgba(var(--st-fg-rgb), 0.12); }
        .sth-searchbar:focus-within { background: rgba(var(--st-fg-rgb), 0.08); border-color: rgba(var(--st-acc-rgb), 0.45); box-shadow: 0 0 0 3px rgba(var(--st-acc-rgb), 0.1); }
        .sth-searchbar-icon { flex-shrink: 0; color: rgba(var(--st-fg-rgb), 0.4); transition: color 0.18s ease; }
        .sth-searchbar:focus-within .sth-searchbar-icon { color: rgb(var(--st-acc-rgb)); }
        .sth-searchbar-input { flex: 1; min-width: 0; background: transparent; border: none; outline: none; font-family: inherit;
          color: var(--st-text); font-size: 13.5px; font-weight: 500; padding: 0; cursor: text; }
        .sth-searchbar-input::placeholder { color: rgba(var(--st-sub-rgb), 0.38); font-weight: 500; }
        .sth-searchbar-end { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
        .sth-kbd { display: inline-flex; align-items: center; justify-content: center; min-width: 17px; height: 17px; padding: 0 4px; border-radius: 5px;
          background: rgba(var(--st-fg-rgb), 0.09); border: 1px solid rgba(var(--st-fg-rgb), 0.1); font-size: 10px; font-weight: 700;
          color: rgba(var(--st-fg-rgb), 0.5); font-family: inherit; line-height: 1; }
        /* The / hint is a whisper — it disappears the moment you engage. */
        .sth-searchbar-slash { opacity: 0.6; transition: opacity 0.18s ease; }
        .sth-searchbar:hover .sth-searchbar-slash { opacity: 1; }
        /* Bare glyph, no filled square. The old X sat in its own grey tile at
           the field's edge and read as a separate widget parked next to the
           search rather than part of it. */

        /* Listening calendar. 13px cells + 3px gutters = 16px per week column,
           which the month labels index against. */

        /* --- library album cards --- */
        .sth-alb { border: none; background: transparent; padding: 0; cursor: pointer; text-align: left; color: inherit; min-width: 0; }
        /* Album art stays clean and flush with the grid. The old multi-layer
           black halo created visible bands above and below the first row. */
        .sth-albart { position: relative; aspect-ratio: 1; border-radius: 13px; overflow: hidden; background: rgba(var(--st-fg-rgb), 0.05); border: 1px solid rgba(var(--st-fg-rgb), 0.07); box-shadow: none; transition: transform 0.22s cubic-bezier(0.2,0.9,0.3,1), border-color 0.2s ease, filter 0.2s ease; }
        /* A short lift and gentle brightness change keep hover feedback without
           enlarging or clipping the artwork at the scroll container's edge. */
        .sth-alb:hover .sth-albart { transform: translateY(-2px); border-color: rgba(var(--st-fg-rgb), 0.16); filter: brightness(1.045); }
        .sth-albimg { position: absolute; inset: 0; background-position: center; background-size: cover; transition: filter 0.22s ease; }

        /* ---- Library two-pane layout (Songs / Albums / Artists) ---- */
        /* Both columns are fixed to the viewport height and scroll INTERNALLY,
           so the page itself never scrolls — you scroll within whichever panel
           has more content. Sized for the 1400px default window. */
        /* Expanded: the fullscreen button on the Now Playing panel hides the
           library list entirely and lets the detail/Now Playing pane span the
           whole grid. The page header above is hidden too, so the panel claims
           that height as well. */
        /* Edge to edge: no rounding or border when it fills the whole area. */
        /* Bar mode: the opposite of expanded — the Now Playing pane collapses
           into a floating bar (rendered separately), so the list takes the
           whole grid. Extra bottom room is left for the bar to float over. */

        /* Now Playing bar.
           Left edge is SIDEBAR_W + 12 so the bar starts where the content
           wrapper starts — it used to run the full window width and extend
           under the library sidebar, which the reference doesn't do.
           12px gutters elsewhere — the SAME value as the content panel's
           margin, so the two line up exactly. At 8px the bar overhung the
           panel by 4px a side, which is what made it look wider.
           Driven by --np-bar-bg, set on the root from Settings → Appearance.
           Solid rather than #000: with no border, an all-black bar on
           an all-black shell had nothing to separate it — it read as a hole
           rather than a surface. A slightly lifted neutral does the job the
           border used to, which is how the reference handles it.
           When immerse is on, the gradient layers paint over this, so it only
           shows in the off state.
           No border: the panel needs one because it encloses scrolling
           content, but the bar sits against the window edge and the reference
           has none. Drop shadow gone with it — there's nothing behind it to
           cast onto. The pointer cursor is gone too: the bar stopped being
           click-to-expand, so the hand cursor was promising an action that
           no longer exists. */
        .sth-npbar { position: fixed; left: var(--np-bar-left, 238px); right: 12px; bottom: 12px; height: 84px; z-index: 30; border-radius: 14px; overflow: hidden; background: var(--np-bar-bg, #20242f); border: none; animation: sthBarIn 0.28s cubic-bezier(0.22,1,0.36,1) both; }
        @keyframes sthPanelIn { from { opacity: 0; transform: translateX(18px); } to { opacity: 1; transform: none; } }
        /* Popovers grow from the control that opened them, rather than sliding
           in from the right the way the docked panel does. */
        @keyframes sthPopIn { from { opacity: 0; transform: translateY(-4px) scale(0.97); } to { opacity: 1; transform: none; } }
        /* Chevron nudge: two peeks out from behind the bar, then a rest.
           Continuous motion turns into jitter you learn to ignore; the pause
           is what makes it read as a gesture being repeated. Runs on transform
           so it composites off the main thread and cannot fight the
           left transition the button already uses for its resting position. */
        /* Hint exit: wind up left, then run right and in behind the tab.
           The backswing is anticipation — a move that starts by going the wrong
           way reads as gathering itself, and it makes the launch feel driven
           rather than merely fast. Travel comes in on --suck-x so the distance
           stays derived in JS instead of hard-coded here.
           Opacity carries a midpoint at 70%: left to the accelerating curve it
           would sit at full brightness and then blink off near the end, which
           is the thing that looked wrong before. */
        @keyframes sthHintSuck {
          0%   { transform: translateX(0) scale(1); opacity: 1;
                 animation-timing-function: cubic-bezier(0.25, 0, 0.25, 1); }
          24%  { transform: translateX(-15px) scale(1); opacity: 1;
                 animation-timing-function: cubic-bezier(0.5, 0, 0.85, 0.4); }
          70%  { opacity: 0.34; }
          100% { transform: translateX(var(--suck-x, 104px)) scale(0.92); opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes sthHintSuck { 0% { opacity: 1; } 100% { opacity: 0; } }
        }
        @keyframes sthChevNudge {
          0%   { transform: translateX(0); }
          9%   { transform: translateX(-6px); }
          19%  { transform: translateX(0); }
          28%  { transform: translateX(-6px); }
          38%  { transform: translateX(0); }
          100% { transform: translateX(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes sthChevNudge { 0%, 100% { transform: translateX(0); } }
        }
        @keyframes sthBarIn { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
        .sth-npbar-play { width: 38px; height: 38px; display: flex; align-items: center; justify-content: center; border-radius: 50%; border: none; cursor: pointer; flex-shrink: 0; transition: filter 0.14s ease, transform 0.1s ease; }
        .sth-npbar-play:hover { filter: brightness(1.1); }
        .sth-npbar-play:active { transform: scale(0.94); }

        /* Bottom-edge seek bar. Thin at rest, thicker on hover; the fill and a
           handle track playback, and the whole strip is click/drag-to-scrub.
           Sits inside the bar's rounded bottom corners. */
        /* Inline in the transport column, not pinned to the bar's bottom edge.
           As an absolute full-width strip it ran under the artwork, which is
           what put the duration label on top of the cover. */
        .sth-npbar-seek { position: relative; flex: 1; min-width: 0; height: 14px; display: flex; align-items: center; cursor: pointer; touch-action: none; }
        .sth-npbar-seek::before { content: ''; position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%); height: 4px; border-radius: 999px; background: rgba(var(--st-fg-rgb), 0.16); transition: height 0.12s ease; }
        .sth-npbar-seek:hover::before, .sth-npbar-seek:focus-visible::before { height: 6px; }
        /* No transition on width: the position steps four times a second, each
           step under a pixel on a normal song, and animating width between
           them meant a layout on every frame for as long as music played. */
        .sth-npbar-seek-fill { position: absolute; left: 0; top: 50%; transform: translateY(-50%); height: 4px; border-radius: 999px; z-index: 1; transition: height 0.12s ease; }
        .sth-npbar-seek:hover .sth-npbar-seek-fill, .sth-npbar-seek:focus-visible .sth-npbar-seek-fill { height: 6px; }
        .sth-npbar-seek-knob { position: absolute; right: -6px; top: 50%; margin-top: -6px; width: 12px; height: 12px; border-radius: 50%; box-shadow: 0 1px 4px rgba(0,0,0,0.5); opacity: 0; transform: scale(0.6); transition: opacity 0.12s ease, transform 0.12s ease; }
        .sth-npbar-seek:hover .sth-npbar-seek-knob, .sth-npbar-seek:focus-visible .sth-npbar-seek-knob { opacity: 1; transform: scale(1); }
        /* Each pane is a solid panel matching Stats/Find, not the glassy card. */
        /* The scrolling region inside a panel */
        /* ---- Header/body column alignment ---------------------------------
           The header row is a SIBLING of this scroller, not a child. So the
           body loses width to the scrollbar and the header doesn't, and every
           body column sits a scrollbar-width left of the header above it —
           which reads as "the duration is misaligned" but is really the whole
           grid being offset.

           Two halves to the fix, and they must agree:
             1. Pin the scrollbar to a KNOWN width, so the offset isn't at the
                mercy of the OS (Windows ~17px, overlay scrollbars 0).
             2. Reserve exactly that much on the header's right edge.
           --lib-sbw is the single source for both, so they can't drift apart.
           scrollbar-gutter: stable keeps the space reserved even on short
           lists, so columns don't shift when a scrollbar appears. */
        .sth-ltable { --lib-sbw: 10px; }
        .sth-libscroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; }
        /* Fallback matters: .sth-libscroll is also used outside .sth-ltable
           (the lyrics pane, for one), where the variable isn't in scope. An
           unresolved var() would invalidate the declaration and drop those
           back to the OS scrollbar, so the default is spelled out. */
        .sth-libscroll::-webkit-scrollbar { width: var(--lib-sbw, 10px); }
        .sth-libscroll::-webkit-scrollbar-track { background: transparent; }
        .sth-libscroll::-webkit-scrollbar-thumb { background: rgba(var(--st-fg-rgb), 0.16); border-radius: 999px; border: 3px solid transparent; background-clip: content-box; }
        .sth-libscroll::-webkit-scrollbar-thumb:hover { background: rgba(var(--st-fg-rgb), 0.26); background-clip: content-box; }
        /* Fade the last few pixels instead of slicing a row in half.
           A scroll container almost never ends on a row boundary, so at rest
           there's a sliver of the next row pinned to the bottom edge — it reads
           as a rendering fault rather than "there's more below". The mask makes
           the same information look intentional, and the extra bottom padding
           lets the final row scroll fully clear of the edge. */
        .sth-lfade {
          -webkit-mask-image: linear-gradient(180deg, #000 calc(100% - 26px), transparent 100%);
          mask-image: linear-gradient(180deg, #000 calc(100% - 26px), transparent 100%);
        }
        .sth-lfade > :last-child { margin-bottom: 26px; }
        .sth-mi { display: flex; align-items: center; gap: 11px; width: 100%; text-align: left; padding: 8px 11px; border-radius: 8px; border: none; cursor: pointer; background: transparent; color: rgba(var(--st-fg-rgb), 0.86); font-size: 12.5px; font-weight: 550; font-family: inherit; transition: background 0.12s ease; }
        .sth-mi:hover { background: rgba(var(--mi-accent), 0.14); }
        .sth-mi.is-danger { color: rgb(238,124,124); }
        .sth-mi.is-danger:hover { background: rgba(230,90,90,0.13); }
        .sth-mi-sub { display: block; font-size: 10.5px; color: rgba(var(--st-fg-rgb), 0.4); font-weight: 500; margin-top: 1px; }
        /* Hero entry — text rises and fades as the track changes. Short and
           small: a big move here reads as the page reloading rather than the
           header updating. */
        @keyframes sthHeroIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        /* ---- Compact library header (52px, one row) ---- */
        /* The now-playing wash is absolutely positioned with z-index 0, and the
           header and lists are static. CSS paints in-flow non-positioned boxes
           BEFORE positioned ones, so the wash landed on top of the content
           regardless of DOM order — an 85%-opaque layer over white text, which
           is why the header read as grey and its avatar looked desaturated. It
           faded downward, so rows further down looked fine and the cause looked
           like blur rather than an overlay. Lifting the real content into the
           positioned layer puts the decoration back underneath it. */
        .sth-libpage > *:not([aria-hidden="true"]) { position: relative; z-index: 1; }
        /* ---- Settings: grouped rows ----
           Cards gave a one-line toggle the same visual weight as a five-option
           picker, so nothing was ranked. Rows put every control on the same
           left edge with its label, and weight follows what a setting needs
           rather than how it's marked up. */
        /* ---- Settings shell: category rail + body + optional preview -------
           Replaces one 760px scroll containing every group. Six groups is
           already past the point where a single column is browsable, and the
           rail means adding a seventh costs one row instead of making the
           scroll longer. */
        /* Fills the page and owns its own scrolling, so the rail and the
           category heading stay put while only the settings move. Previously
           the whole page scrolled as one block: the rail slid away with the
           content, which is the one thing a persistent nav must not do. */
        .sth-set-wrap { display: flex; gap: 0; align-items: stretch; position: absolute; inset: 0; min-height: 0; }
        .sth-set-rail { width: 196px; flex: 0 0 196px; display: flex; flex-direction: column; gap: 2px;
          padding: 22px 18px 22px 26px; overflow-y: auto; scrollbar-width: none; }
        .sth-set-rail::-webkit-scrollbar { width: 0; display: none; }
        .sth-set-rail .lbl { font-size: 9.5px; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(var(--st-fg-rgb), 0.24); font-weight: 800; padding: 14px 10px 5px; }
        .sth-set-navi { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 9px; font-size: 12.5px; font-weight: 700; color: rgba(var(--st-sub-rgb), 0.62); text-align: left; background: none; border: 0; cursor: pointer; transition: background 140ms, color 140ms; width: 100%; }
        .sth-set-navi:hover { background: rgba(var(--st-fg-rgb), 0.05); color: var(--st-text); }
        .sth-set-navi.on { background: rgba(var(--st-fg-rgb), 0.09); color: var(--st-text); }
        .sth-set-navi svg { width: 15px; height: 15px; flex: 0 0 15px; stroke: currentColor; fill: none; stroke-width: 1.9; }
        /* Solid glyphs (the play triangle, the Discord mark) are shapes, not
           outlines — the rail's stroke default turns them into mush. */
        .sth-set-navi svg.is-solid { fill: currentColor; stroke: none; }
        .sth-set-body { flex: 1; min-width: 0; padding: 22px 26px 60px; overflow-y: auto;
          border-left: 1px solid rgba(var(--st-fg-rgb), 0.07); scrollbar-width: thin;
          scrollbar-color: rgba(var(--st-fg-rgb), 0.14) transparent; }
        .sth-set-body::-webkit-scrollbar { width: 10px; }
        .sth-set-body::-webkit-scrollbar-thumb { background: rgba(var(--st-fg-rgb), 0.14); border-radius: 999px; border: 3px solid transparent; background-clip: content-box; }
        /* Below this the three columns can't all hold their minimums, so the
           preview is the one that goes — it's the optional part. */

        /* The first group in a category shouldn't be pushed down by a margin
           that exists to separate it from the group ABOVE it — and there
           isn't one. :first-child stopped matching once the category
           heading became the body's first element, so this targets the
           first section wherever it lands instead. */
        /* A section heading was 10.5px uppercase at 34% — quieter than the row
           labels underneath it, so the thing meant to introduce a group was the
           least visible text in it. Full-size and full-strength now, with the
           explanation on its own line beneath rather than trailing off the end
           of it. */
        /* .sth-set-h removed: each category gets ONE heading now, rendered by
           the body from SET_CATS. The per-section version printed the same
           title a second time directly beneath it. Deleted rather than left
           unused so nobody re-adds a heading by reaching for the class. */
        /* NO CONTAINER. This was a filled, rounded, outlined box wrapping every
           group, so each setting read as a card sitting on the page — six
           stacked panels competing with the rail beside them for the role of
           "the structure". With a category rail doing the grouping, the box is
           saying the same thing twice, and boxing content that's already
           inside a bordered page wrapper is a box in a box.
           Rows now sit on the page and are separated by a hairline, which is
           the least ink that still says "these are separate settings". */
        .sth-set-list { border-radius: 0; overflow: visible; background: none; box-shadow: none; }
        .sth-set-r { display: flex; align-items: center; gap: 24px; padding: 15px 2px;
          box-shadow: inset 0 -1px 0 rgba(var(--st-fg-rgb), 0.06); }
        .sth-set-r:last-child { box-shadow: none; }
        .sth-set-r > .txt { flex: 1; min-width: 0; }
        .sth-set-r .txt b { display: block; font-size: 13px; font-weight: 700; color: var(--st-text); letter-spacing: -0.005em; }
        /* Capped at ~58 characters. Some of these notes run four lines, and a
           measure that wide is genuinely harder to read — it also drags the
           row tall enough that its control floats away from its label. */
        .sth-set-r .txt p { margin: 4px 0 0; font-size: 11.5px; font-weight: 500; line-height: 1.5;
          color: rgba(var(--st-sub-rgb), 0.45); max-width: 58ch; }
        .sth-set-r > .ctl { flex-shrink: 0; display: flex; align-items: center; gap: 8px; }
        /* Stacks the control under its label when a row gets tight, instead of
           squeezing a three-option picker into 90px. */
        @media (max-width: 900px) {
          .sth-set-r { flex-direction: column; align-items: stretch; gap: 10px; }
          .sth-set-r > .ctl { justify-content: flex-start; }
        }
        .sth-set-link { border: none; background: transparent; cursor: pointer; font: inherit; font-size: 11.5px;
          font-weight: 700; color: rgba(var(--st-sub-rgb), 0.45); padding: 4px 2px; white-space: nowrap; }
        .sth-set-link:hover { color: var(--st-text); }
        /* No fixed height. A 52px height plus align-items:center is what put ~17px
           of empty band above a 17px title and made it read as off-centre —
           the row was sized to a number, not to its contents. Now the content
           sets the height and min-height only stops it collapsing when a view
           passes no meta. */
        /* Two tiers: identity, then controls.
           One row meant the actions had to be pinned somewhere, and pinned
           right they sat across a span of empty header that grew with the
           window — worst with the side panels closed, which is exactly when
           there's most width. Neither row here has anything at a far edge, so
           widening the window adds margin instead of a gap.
           It also gives the title its own line, which is what the 44px
           single-row version never had: 41px of content in a 44px box left
           about 1.5px of air and read as crammed however the type was set. */
        .sth-libhead { display: flex; flex-direction: column; align-items: stretch; gap: 18px;
          flex-shrink: 0; padding: 8px 0 16px;
          margin-bottom: 10px; box-shadow: inset 0 -1px 0 rgba(var(--st-fg-rgb), 0.08); }
        .sth-libhead-r2 { display: flex; align-items: center; gap: 8px; min-width: 0; }
        /* Albums and Artists have no playback or sort controls — their second
           tier held one 32px search icon and an 18px gap above it, so the
           header was mostly reserved space for a row that had nothing in it.
           With one control there's nothing to separate, so it collapses to a
           single row and the search sits inline. Same title size; only the
           empty tier goes. */
        .sth-libhead.is-single { flex-direction: row; align-items: center; gap: 14px;
          padding: 10px 0 14px; }
        /* Title and meta share the top line on a common baseline. Stacking
           them was what let the title grow inside a single-row header; with
           its own tier there's no height to save, and side by side the meta
           reads as a caption to the title rather than a second heading.
           min-width: 0 so a long meta string ellipsises instead of widening
           the row. */
        .sth-libhead-tw { display: flex; align-items: baseline; gap: 12px;
          min-height: 32px; min-width: 0; flex-shrink: 1; }
        /* 850 at -0.022em was heavy AND tight — the letters were pressed
           together at the same moment the box was, which is most of why this
           looked unfinished. 700 at -0.014em is still emphatic but the
           counters open up; 25px reads as deliberate without being a banner. */
        .sth-libhead-t { font-size: 25px; font-weight: 700; letter-spacing: -0.014em; color: var(--st-text);
          line-height: 1.2; white-space: nowrap; flex-shrink: 0; }
        /* The active-filter tag. Only ever on screen when a filter is set,
           so it needs no collapsed state and no width animation — the old
           icon-to-field transition existed to hide a control nobody had
           asked for yet. Accent-tinted because it reports STATE, not a
           control you operate. */
        /* Icon at rest, field when opened.
           The version before this returned null until a filter was already
           set, so the page offered no way to search until you had searched —
           the control only announced itself after you had found it some other
           way. An always-visible icon fixes that without a bar sitting there
           permanently.
           ONE element animates: the container's width, with overflow hidden.
           The input is always flex:1 inside it and simply gets clipped when
           collapsed, so there's no flex-basis transition to go wrong and no
           second tree to swap in. */
        /* Icon at rest, field when opened.
           The version before this returned null until a filter was already
           set, so the page offered no way to search until you had searched —
           the control only announced itself after you had found it some other
           way. An always-visible icon fixes that without a bar sitting there
           permanently.

           Shaped like .sth-libact, its neighbour in this row: 8px radius, no
           border, a fill that only appears on hover. A 999px bordered pill was
           the odd one out in a UI whose controls are all soft rectangles — it
           read as borrowed from somewhere else, and the ring stayed visible
           when collapsed.

           ONE element animates: the container's width, with overflow hidden.
           The input is always flex:1 inside and simply gets clipped when
           collapsed, so there's no flex-basis transition to go wrong and no
           second tree to swap in. */
        .sth-libtag { display: flex; align-items: center; flex-shrink: 0;
          height: 32px; width: 32px; padding: 0; border-radius: 8px; overflow: hidden;
          border: none; background: rgba(var(--st-fg-rgb), 0.05);
          color: rgba(var(--st-sub-rgb), 0.62);
          transition: width 0.22s cubic-bezier(0.22, 1, 0.36, 1), padding 0.22s cubic-bezier(0.22, 1, 0.36, 1),
                      background 0.15s ease, color 0.15s ease; }
        .sth-libtag:hover { background: rgba(var(--st-fg-rgb), 0.07); color: var(--st-text); }
        .sth-libtag.is-open { width: 200px; padding: 0 6px 0 9px;
          background: rgba(var(--st-fg-rgb), 0.07); color: var(--st-text); }
        .sth-libtag.is-on { background: rgba(var(--st-acc-rgb), 0.16); }
        /* Scoped to is-open. Unscoped, clicking the icon focused the button and
           that focus survived the collapse, so a closed control kept painting a
           ring — the circle that wouldn't go away. */
        .sth-libtag.is-open:focus-within { box-shadow: inset 0 0 0 1px rgba(var(--st-acc-rgb), 0.45); }
        .sth-libtag-btn { flex: none; width: 30px; height: 30px; padding: 0; border: none;
          background: transparent; color: inherit; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          transition: width 0.22s cubic-bezier(0.22, 1, 0.36, 1); }
        .sth-libtag.is-open .sth-libtag-btn { width: 15px; cursor: text; }
        .sth-libtag-in { flex: 1; min-width: 0; margin-left: 8px; border: none; outline: none;
          background: transparent; opacity: 0; pointer-events: none;
          font: inherit; font-size: 12.5px; font-weight: 500; color: var(--st-text); padding: 0;
          transition: opacity 0.16s ease; }
        .sth-libtag.is-open .sth-libtag-in { opacity: 1; pointer-events: auto; }
        .sth-libtag-in::placeholder { color: rgba(var(--st-fg-rgb), 0.3); font-weight: 500; }
        .sth-libtag-x { width: 17px; height: 17px; flex-shrink: 0; padding: 0; border: none;
          border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center;
          background: rgba(var(--st-fg-rgb), 0.16); color: rgba(var(--st-fg-rgb), 0.75); }
        .sth-libtag-x:hover { background: rgba(var(--st-fg-rgb), 0.3); color: #fff; }
        /* Lighter and one step further from the title. At 650 it was competing
           with a 700 title for the same job; a count is supporting text. */
        .sth-libhead-m { font-size: 12px; font-weight: 500; color: rgba(var(--st-sub-rgb), 0.42);
          white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        /* A dark well rather than a white veil.
           A 5%-white fill over the now-playing wash just tints itself with
           whatever is playing, so the field vanished into a red page and
           glowed on a pale one. Black at low alpha reads as a recess against
           any wash, and the hairline stays white so the edge holds. */
        /* .sth-libhead-s and its input rules went with the filter box.
           The chip above replaces it: same state, no text entry. */
        /* The bar has to survive the now-playing panel taking a third of the
           width. Meta goes first (a count is nice, not needed), then the
           action labels, leaving icons that still work. */
        /* The meta used to be dropped below 1180px because it shared a row
           with the actions and was the first thing to give. On its own tier
           it has the full width to itself and fits at any size the app runs
           at, so hiding it would only be deleting information. */
        @media (max-width: 980px) { .sth-libact-label { display: none; } }

        /* Equaliser — three 2.5px bars, glow, centred. Matches the overlay's
           badge. Animates scaleY (not height) so it composites on the GPU and
           never triggers layout: this can be on screen while a 500-row list is
           being scrolled. transform-origin is centre so it grows both ways and
           stays optically centred in the column. */
        .sth-eq { display: inline-flex; align-items: center; gap: 2.5px; height: 14px; flex-shrink: 0; vertical-align: middle; }
        .sth-eq i { display: block; width: 2.5px; height: 11px; border-radius: 2px; background: currentColor; box-shadow: 0 0 6px currentColor; transform-origin: center; animation: sthEq 0.9s ease infinite; will-change: transform; }
        .sth-eq i:nth-child(1) { animation-delay: 0s; }
        .sth-eq i:nth-child(2) { animation-delay: 0.18s; }
        .sth-eq i:nth-child(3) { animation-delay: 0.36s; }
        .sth-eq.is-paused i { animation: none; transform: scaleY(0.36); }
        @keyframes sthEq { 0%, 100% { transform: scaleY(0.36); } 50% { transform: scaleY(1); } }
        .sth-libact { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-radius: 8px; border: none; cursor: pointer; background: transparent; color: rgba(var(--st-sub-rgb), 0.62); font-size: 12.5px; font-weight: 600; font-family: inherit; transition: color 0.15s ease, background 0.15s ease; }
        .sth-libact:hover { color: var(--st-text); background: rgba(var(--st-fg-rgb), 0.07); }
        /* Play all is the primary action; Shuffle is an alternative to it.
           Rendered identically they read as a pair of equals and you have to
           read the labels to tell which is which. A quiet accent tint is
           enough of a difference to skip that step — no size change, so the
           cluster still aligns. */
        .sth-libsortmenu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 40;
          min-width: 176px; padding: 5px; border-radius: 11px;
          background: rgba(22, 22, 24, 0.98); border: 1px solid rgba(var(--st-fg-rgb), 0.11);
          box-shadow: 0 14px 38px rgba(0, 0, 0, 0.5);
          display: flex; flex-direction: column; gap: 1px; }
        .sth-libsortitem { display: block; width: 100%; text-align: left; padding: 8px 11px;
          border: none; border-radius: 7px; cursor: pointer; background: transparent;
          font: inherit; font-size: 12.5px; font-weight: 600; color: rgba(var(--st-fg-rgb), 0.72); }
        .sth-libsortitem:hover { background: rgba(var(--st-fg-rgb), 0.08); color: #fff; }
        .sth-libsortitem.is-on { color: #fff; background: rgba(var(--st-acc-rgb), 0.2); }
        .sth-libsortitem-reset { margin-top: 4px; padding-top: 10px; font-weight: 500;
          color: rgba(var(--st-fg-rgb), 0.5); border-top: 1px solid rgba(var(--st-fg-rgb), 0.08);
          border-radius: 0 0 7px 7px; }
        .sth-libact-primary { color: var(--st-text); background: rgba(var(--st-acc-rgb), 0.16); }
        .sth-libact-primary:hover { background: rgba(var(--st-acc-rgb), 0.26); }
        .sth-plcover-veil { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #fff; background: rgba(0,0,0,0.55); opacity: 0; transition: opacity 0.16s ease; }
        .sth-plcover:hover .sth-plcover-veil { opacity: 1; }


        /* Selectable rows in the left list pane */
        /* Play button removed from rows — actions live on the right instead.
           The heart persists once set; the others reveal on hover. */


        /* Panel actions: icon-only shuffle, filled Play */

        /* A–Z jump rail */

        /* Now Playing transport + volume */
                /* 32, not 26: the bar is 84px tall now and the icons went to 16–17px,
           so the old hit area barely contained them. */
        /* Now-playing title as a copy control. Inherits the bar's text colour
           and carries no button chrome at rest, so it reads as the title it
           replaced until you point at it. */
        /* flex-shrink: 0 is load-bearing, not tidiness. These sit in the
           now-playing bar's flex row, and without it a crowded bar squeezes
           them horizontally: the height stays 32px, the width drops, and a
           border-radius:50% box becomes a visible OVAL. Invisible while the
           background is transparent, obvious the moment a toggle goes active
           and paints its accent circle — which is why lyrics-on looked wrong
           and nothing else did. The rule divider beside them already had it. */
        .sth-npbtn { width: 32px; height: 32px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: 50%; border: none; background: transparent; color: rgba(var(--st-fg-rgb), 0.62); cursor: pointer; transition: color 0.14s ease, background 0.14s ease, transform 0.1s ease; }
        /* :hover / :active for .sth-npbtn are defined further down the sheet
           and would win on cascade order regardless — not duplicated here. */
        /* Large transport buttons that flank the artwork in fullscreen. */
        /* Fullscreen transport — a compact centered dock (matches the overlay),
           with the view toggles and exit tucked in the corners. */
        /* Credits/Up-next dock cards float just above the transport bar. */
        /* Fullscreen credits — accent-bordered cards in a centered grid. */
        @keyframes sthCreditIn { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: translateX(0); } }
        /* Fullscreen library list. */
        @keyframes sthEqBar { 0%, 100% { transform: scaleY(0.5); } 50% { transform: scaleY(1); } }
        /* Add-lyrics UI (shown when a track has no lyrics). */
        @keyframes sthLyricsFadeIn { from { opacity: 0; } to { opacity: 1; } }
        .sth-npbtn:hover { color: #fff; background: rgba(var(--st-fg-rgb), 0.08); }
        .sth-npbtn:active { transform: scale(0.92); }
        /* Divider between the song actions and the view toggles. Inset top
           and bottom so it's shorter than the buttons either side — a rule
           the same height as its neighbours reads as a wall between two
           toolbars rather than a seam inside one. */
        .sth-npbtn-rule { width: 1px; height: 18px; flex-shrink: 0; margin: 0 5px; background: rgba(var(--st-fg-rgb), 0.14); border-radius: 1px; }
        /* Playlist picker rows. Hover and selection are CSS rather than
           inline styles written from JS handlers — the sheet re-renders on
           every tick, and inline hover state gets wiped on each pass. */
        .sth-plpick { width: 100%; display: flex; align-items: center; gap: 9px; padding: 6px 7px; border-radius: 9px; border: none; background: transparent; color: inherit; text-align: left; cursor: pointer; font-family: inherit; transition: background 0.13s ease; }
        .sth-plpick:hover { background: rgba(var(--st-fg-rgb), 0.06); }
        .sth-plpick.is-editing { cursor: default; }
        .sth-plpick.is-editing:hover { background: transparent; }
        .sth-plpick-art { width: 32px; height: 32px; border-radius: 5px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: rgba(var(--st-fg-rgb), 0.08); color: var(--st-text); overflow: hidden; }
        .sth-plpick-art.is-new { background: transparent; border: 1px dashed rgba(var(--st-fg-rgb), 0.22); }
        .sth-plpick-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
        .sth-plpick-name { font-size: 12px; font-weight: 600; color: var(--st-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sth-plpick-sub { font-size: 10px; color: rgba(var(--st-sub-rgb), 0.45); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        /* The pending-change note rides the accent so it reads as a
           consequence of the tick rather than more metadata. */
        .sth-plpick-sub em { font-style: normal; font-weight: 650; color: rgb(var(--pl-acc, 255, 255, 255)); }
        /* A square, not a circle. Circles are for one-of-many; this is
           several independent yes/nos, and the shape should say so. */
        .sth-plpick-box { width: 18px; height: 18px; border-radius: 5px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border: 1.5px solid rgba(var(--st-fg-rgb), 0.22); color: transparent; transition: background 0.13s ease, border-color 0.13s ease, color 0.13s ease; }
        .sth-plpick.is-on .sth-plpick-box { background: rgb(var(--pl-acc, 255, 255, 255)); border-color: rgb(var(--pl-acc, 255, 255, 255)); color: var(--pl-acc-fg, #000); }
        .sth-plpick:hover .sth-plpick-box { border-color: rgba(var(--st-fg-rgb), 0.4); }
        .sth-plpick.is-on:hover .sth-plpick-box { border-color: rgb(var(--pl-acc, 255, 255, 255)); }
        /* Click-to-play cover: the veil only appears on hover, so at rest the
           artwork is completely unobstructed. */
        /* Fullscreen Now Playing overlay (portaled to body) — covers the app
           content and nav rail, but sits BELOW the window controls and drag
           strip (z99/z101 in App) so they stay clickable. */
        @keyframes sthNpFullIn { from { opacity: 0; } to { opacity: 1; } }
        /* Now Playing stage — artwork column, and a lyrics column that grows in
           beside it (expanded mode). flex-basis + opacity transitions carry the
           whole thing: the artwork slides left as the lyrics take their space. */
        /* Geometry matched 1:1 to the overlay's fullscreen stage (side-lyrics
           mode) so the command center and its cover flight port across
           without re-deriving anything.

           The overlay sizes the pair off the VIEWPORT, not off percentages of
           a padded container: cover is min(52vh, 42vw) square, the lyrics
           column is min(36vw, 460px) wide at exactly the cover's height, and
           the two are centered as a unit with a clamp(20px, 3.5vw, 56px) gap.
           Percentage flex-basis inside a 6vw-padded row gave a different
           cover size at every window width, which is why the two surfaces
           never quite matched. */
        /* No lyrics: the overlay lets the cover breathe wider. */
        /* ONE cover size, always. The overlay grows its cover when lyrics are
           off (58vh/46vw vs 52vh/42vw) but that means toggling lyrics resizes
           the artwork under you, and the command center — which takes over
           this exact square — would resize with it. Fixed at the with-lyrics
           size so the square is stable no matter what's toggled. */
        /* Only the lyrics body flexes. This used to be a bare child selector, which also hit
           the mini-header slot and stretched it from 88px to fill the column —
           pushing the lyrics far down the screen. */
        @keyframes sthSpin { to { transform: rotate(360deg); } }
        .sth-vol { -webkit-appearance: none; appearance: none; height: 3px; border-radius: 2px; outline: none; cursor: pointer; }
        .sth-vol::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 11px; height: 11px; border-radius: 50%; background: #fff; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.5); transition: transform 0.12s ease; }
        .sth-vol:hover::-webkit-slider-thumb { transform: scale(1.15); }

        /* Detail-pane track rows (compact, numbered) */
        .sth-alb:hover .sth-albimg { filter: saturate(1.04); }
        /* --- redesign: hero band (discover feature + library collection) --- */
        /* --- redesign: discover release cards --- */
        /* ---- Library table ----
           One grid template shared by the header and every row, so the columns
           can't drift apart — the header is a row with different styling
           rather than a separate layout. */
        /* Fixed 56px for duration, not 64 with a min-content squeeze: at
           narrow widths the grid was shrinking that track and clipping "3:52"
           to "3". A fixed column can't be compressed by its neighbours. */
        /* height is FIXED, not derived from content: the virtualiser converts
           scrollTop to a row index by division, so a variable row height would
           make the window drift out of sync with the scrollbar. */
        .sth-lrow { display: grid; grid-template-columns: 44px minmax(160px, 2.2fr) minmax(110px, 1.4fr) minmax(110px, 1.6fr) 108px 56px 40px; align-items: center; gap: 12px; padding: 6px 8px; border-radius: 8px; height: 50px; box-sizing: border-box; }
        /* Shed columns as the TABLE narrows (container query, not viewport):
           the side panel takes 372px out of this column while the window stays
           the same size, so a media query would never fire. Album goes first,
           then Date added — the two you can infer from context. */
        .sth-ltable { container-type: inline-size; }
        @container (max-width: 720px) {
          .sth-lrow { grid-template-columns: 44px minmax(150px, 2.4fr) minmax(110px, 1.5fr) 108px 56px 40px; }
          .sth-lrow > .sth-lcol-album { display: none; }
        }
        @container (max-width: 560px) {
          .sth-lrow { grid-template-columns: 44px minmax(140px, 1fr) minmax(100px, 1fr) 56px 40px; }
          .sth-lrow > .sth-lcol-date { display: none; }
        }

        /* Date added hidden by preference (Settings → Library).
           The COLUMN TRACK has to go, not just the cell: display:none on the
           child leaves its 108px track in the template, so the row keeps a
           hole where the dates were and everything stays put. Dropping the
           track lets Title/Artist/Album absorb the width, which is the point
           of hiding it. Same technique the container queries above use.
           Written as its own rule after them so it wins at any width. */
        .sth-ltable.no-date .sth-lrow { grid-template-columns: 44px minmax(160px, 2.2fr) minmax(110px, 1.4fr) minmax(110px, 1.8fr) 56px 40px; }
        .sth-ltable.no-date .sth-lrow > .sth-lcol-date { display: none; }
        @container (max-width: 720px) {
          .sth-ltable.no-date .sth-lrow { grid-template-columns: 44px minmax(150px, 2.4fr) minmax(110px, 1.5fr) 56px 40px; }
        }
        @container (max-width: 560px) {
          .sth-ltable.no-date .sth-lrow { grid-template-columns: 44px minmax(140px, 1fr) minmax(100px, 1fr) 56px 40px; }
        }
        /* Right padding = row padding + the reserved scrollbar gutter. See
           the .sth-libscroll block above for why. */
        /* height: 28px, because this shares .sth-lrow with the data rows and
           was inheriting their 50px — a 12px label sitting in a 50px box, plus
           10px padding and a 6px margin, for a ~66px band of mostly nothing
           between the title and the first song. Labels don't need a track
           height; only rows with 38px artwork in them do. */
        .sth-lrow-head { height: 28px; padding: 0 calc(8px + var(--lib-sbw, 0px)) 8px 8px; font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: rgba(var(--st-fg-rgb), 0.32); border-bottom: 1px solid rgba(var(--st-fg-rgb), 0.06); margin-bottom: 4px; position: sticky; top: 0; z-index: 1; }
        /* The header already reserves the scrollbar's width so its columns
           line up with the rows beneath. The rail takes another 16px out of
           the same row width, so the header has to account for that too or
           every column heading drifts left of its data. */
        .sth-ltable.has-az .sth-lrow-head { padding-right: calc(8px + var(--lib-sbw, 0px) + 16px); }
        .sth-lrow:not(.sth-lrow-head):hover { background: rgba(var(--st-fg-rgb), 0.05); }
        .sth-lrow.is-playing { background: rgba(var(--st-fg-rgb), 0.04); }
        /* Cell links. Underline on hover only — a permanently underlined
           album column would read as a page full of links and compete with
           the title for attention. Inherits colour so it sits in the row
           rather than on top of it. */
        .sth-lcell-link { display: block; width: 100%; text-align: left; padding: 0; border: none; background: none;
          font: inherit; color: inherit; cursor: pointer; min-width: 0;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          transition: color 0.12s ease; }
        .sth-lcell-link:hover { color: rgba(var(--st-fg-rgb), 0.95); text-decoration: underline; text-underline-offset: 2px; }
        .sth-lcell-link:focus-visible { outline: 2px solid rgba(var(--st-fg-rgb), 0.4); outline-offset: 2px; border-radius: 3px; }

        /* A–Z rail. A flex column beside the scroll area — NOT absolute, and
           not overlapping the scrollbar, which is what put the letters on top
           of it. justify-content is flex-start with each letter flexing, so
           the strip fills the list's height exactly rather than floating
           centred in a taller box. */
        .sth-azrail { flex-shrink: 0; width: 16px; padding: 2px 0 6px;
          display: flex; flex-direction: column;
          user-select: none; }
        .sth-azrail button { flex: 1; min-height: 0; padding: 0; border: none; background: transparent;
          font-size: 8.5px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums;
          transition: color 0.1s ease, transform 0.1s ease; }
        .sth-azrail button.has { color: rgba(var(--st-fg-rgb), 0.5); cursor: pointer; }
        .sth-azrail button.no { color: rgba(var(--st-fg-rgb), 0.14); cursor: default; }
        .sth-azrail button.has:hover { color: rgb(var(--st-fg-rgb)); transform: scale(1.35); }
        .sth-lrow-dim { font-size: 13.5px; color: rgba(var(--st-fg-rgb), 0.5); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        /* LEFT, not centre. The header "#" is left-aligned in this track, so
           centring the numbers under it put every row a few px right of its
           own label — the wider the track, the more obviously off. Aligning
           both to the same edge is what makes the column read as a column.
           justify-content:flex-start rather than text-align because this is a
           flex row (the number and the hover play button share the cell). */
        .sth-lrow-n { position: relative; display: flex; align-items: center; justify-content: flex-start; height: 38px; }
        .sth-lrow-num { font-size: 12px; color: rgba(var(--st-fg-rgb), 0.35); font-variant-numeric: tabular-nums; }
        /* The play button replaces the index on hover rather than sitting
           beside it, so the column stays 44px wide either way. */
        /* Left, matching .sth-lrow-n. The old inset:0 + margin:auto centred it in
           the track, which was right while the number was centred too — now
           the number sits left, so a centred button would make the two swap
           places the instant the pointer arrives. Pinned left, centred only
           vertically. */
        .sth-lrow-play { position: absolute; left: -6px; top: 0; bottom: 0; margin: auto 0; width: 26px; height: 26px; border-radius: 50%; border: none; background: transparent; color: #fff; cursor: pointer; display: none; align-items: center; justify-content: center; }
        /* Hover hides whatever occupies the index slot — number OR equaliser —
           so the play button can take its place. Without the .sth-eq rule the
           bars stayed put and the button appeared on top of them. */
        .sth-lrow:hover .sth-lrow-num, .sth-lrow:hover .sth-eq { opacity: 0; }
        .sth-lrow:hover .sth-lrow-play { display: flex; }
        .sth-lrow-more { width: 28px; height: 28px; border-radius: 7px; border: none; background: transparent; color: rgba(var(--st-fg-rgb), 0.4); cursor: pointer; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.14s ease, color 0.14s ease; }
        .sth-lrow:hover .sth-lrow-more { opacity: 1; }
        .sth-lrow-more:hover { color: #fff; background: rgba(var(--st-fg-rgb), 0.08); }
        /* Discover section headers — accent rule + source eyebrow + title. */
        /* --- redesign: detail drawer (release tracklist) --- */
        /* Inline release expansion — height animated in JS (ReleaseExpansion).
           The bottom breathing space lives in the padding wrapper so it's part
           of the measured height, and clips to nothing when collapsed. */
        /* --- redesign: chart song grid --- */
        /* --- redesign: library collection hero + control bar --- */
        /* Album detail panel entrance — slides in from the right, settling at
           transform: none so panel text stays crisp (no lingering GPU layer). */
        @keyframes sthPanelIn { from { opacity: 0; transform: translateX(18px); } to { opacity: 1; transform: none; } }
        /* Rows inside the panel's scroller slide in HORIZONTALLY: a vertical
           slide temporarily extends the scrollable area and flashes the
           scrollbar; sideways overflow is simply clipped (overflowX hidden). */
        @keyframes sthRowIn { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: none; } }

        /* ---- Now Playing swap transitions ----
           STRICTLY transform + opacity. Both are composited on the GPU, so
           these never trigger layout or paint. (The previous version animated
           filter: blur(), which forces a full repaint every frame — that was
           the lag.) translate3d pins each element to its own layer.

           New character: the text slides sideways (out to the left, in from
           the right) while the artwork cross-dissolves with a gentle scale —
           crisp and directional on the small type, calm on the big element. */
        @keyframes sthNpTxtOut { 0% { opacity: 1; transform: translate3d(0,0,0); } 100% { opacity: 0; transform: translate3d(-22px,0,0); } }
        @keyframes sthNpTxtIn  { 0% { opacity: 0; transform: translate3d(22px,0,0); } 100% { opacity: 1; transform: translate3d(0,0,0); } }
        @keyframes sthCoverZoomIn { 0% { opacity: 0; } 100% { opacity: 1; } }
        @keyframes sthNpArtOut { 0% { opacity: 1; transform: scale3d(1,1,1); } 100% { opacity: 0; transform: scale3d(0.94,0.94,1); } }
        @keyframes sthNpArtIn  { 0% { opacity: 0; transform: scale3d(1.05,1.05,1); } 100% { opacity: 1; transform: scale3d(1,1,1); } }
        @keyframes sthNpMetaIn { 0% { opacity: 0; transform: translate3d(0,7px,0); } 100% { opacity: 1; transform: translate3d(0,0,0); } }

        /* ---- Library scroll performance ----
           content-visibility lets Chromium skip layout AND paint for tiles
           that are off-screen, which is what keeps the album grid and artist
           list cheap without hand-rolling grid virtualisation. The
           intrinsic-size hint stops the scrollbar jumping as tiles resolve. */
        /* Manage follows — solid panel, search, artist cards. */
        /* Leaderboard rows. Fixed columns shared by the tracks and artists
           views so switching tabs doesn't shift anything sideways. */
        /* --- Streak badge -------------------------------------------------
           Three layered motions, all cheap: the badge breathes, a halo behind
           it pulses, and the flame itself flickers on a deliberately odd
           duration so the two never sync into an obvious loop. Only the
           streak card gets .is-flame — the other two habit cards use the same
           component but stay still, since constant motion on three tiles at
           once is noise rather than emphasis. */
        /* Halo sits behind, never intercepts the pointer, and scales with the
           tier's own colour so a hotter streak glows harder. */
        @keyframes sthStreakGlow { 0%, 100% { opacity: 0.45; transform: scale(0.94); } 50% { opacity: 1; transform: scale(1.06); } }
        /* Anchored at the base like a real flame: the tip moves, the foot doesn't. */
        @keyframes sthStreakFlicker {
          0%, 100% { transform: scale(1) translateY(0); }
          28%      { transform: scale(1.07, 1.11) translateY(-0.6px); }
          52%      { transform: scale(0.97, 1.03) translateY(0.3px); }
          76%      { transform: scale(1.04, 1.07) translateY(-0.3px); }
        }
        /* One-shot when a new tier is reached — fires on the badge, not the
           card, so the text stays readable while it plays. */
        @keyframes sthStreakPop {
          0%   { transform: scale(1); box-shadow: 0 0 0 0 rgba(var(--tone), 0.55); }
          35%  { transform: scale(1.16); }
          100% { transform: scale(1); box-shadow: 0 0 0 16px rgba(var(--tone), 0); }
        }

        /* Wrong code — a shake rather than a message, since the field is only
           76px wide and there's nowhere to put a sentence. */
        @keyframes sthCodeShake {
          0%, 100% { transform: translateX(0); }
          20%      { transform: translateX(-4px); }
          45%      { transform: translateX(3px); }
          70%      { transform: translateX(-2px); }
        }

        /* The three habit figures. */

        /* ==================================================================
           REDESIGN (implementation brief) — overrides for the shared shell.
           Kept together at the end of the sheet so they win on cascade order
           and are easy to find.
           ================================================================== */
        /* Content card: one rounded card on the black window, 16px gutter at
           right and bottom, and only reserves the bar's space when it's up. */
        .sth-scroll { margin: 0 var(--gutter) var(--np-reserve) 0; border-radius: var(--r-card); background: var(--surface); border: 1px solid var(--border); padding: 28px 28px 32px; }
        .sth-scroll.is-page { padding: 0; }
        /* Now Playing bar — detached card aligned to the content card. */
        .sth-npbar { left: var(--np-bar-left); right: var(--gutter); bottom: var(--gutter); height: 86px; border-radius: var(--r-card); background: var(--np-bar-bg, var(--surface)); border: 1px solid var(--border); }
        .sth-npbar-grid { position: relative; z-index: 1; height: 100%; display: grid; grid-template-columns: 282px minmax(0, 1fr) 282px; align-items: center; padding: 0 16px; gap: 16px; }
        .sth-npbar-left { display: flex; align-items: center; gap: 12px; min-width: 0; transition: opacity 0.24s ease, transform 0.36s cubic-bezier(0.22,1,0.36,1); }
        /* A notification docked in the bar sits over the song info. */
        :root[data-st-toast-in-bar] .sth-npbar-left { opacity: 0; transform: translateX(-10px); pointer-events: none; }
        /* Saving a song from the bar: the + becomes a tick with a pop and a
           ring (as Spotify does), then the heart and add-to-playlist slide in
           from where it was. */
        .sth-saved-tick { position: relative; opacity: 1 !important; cursor: default; }
        .sth-npbtn.sth-saved-tick, .sth-npbtn.sth-saved-tick:hover { background: transparent; }
        .sth-saved-tick svg { animation: sthTickPop 0.42s cubic-bezier(0.2, 1.4, 0.4, 1) both; }
        .sth-saved-tick::after { content: ''; position: absolute; inset: 6px; border-radius: 50%; border: 2px solid #fff; pointer-events: none;
          animation: sthTickRing 0.55s ease-out both; }
        @keyframes sthTickPop { 0% { transform: scale(0.3); opacity: 0; } 55% { transform: scale(1.18); opacity: 1; } 100% { transform: scale(1); } }
        @keyframes sthTickRing { 0% { transform: scale(0.6); opacity: 0.75; } 100% { transform: scale(1.55); opacity: 0; } }
        .sth-lib-arrive { animation: sthLibIn 0.38s cubic-bezier(0.22, 1, 0.36, 1) both; }
        .sth-lib-arrive.is-second { animation-delay: 0.07s; }
        @keyframes sthLibIn { from { opacity: 0; transform: translateX(-6px) scale(0.7); } to { opacity: 1; transform: none; } }
        @media (prefers-reduced-motion: reduce) {
          .sth-saved-tick svg, .sth-saved-tick::after, .sth-lib-arrive { animation-duration: 0.01s; animation-delay: 0s; }
        }
        /* Clear of the title: their hover square mustn't touch the text. */
        .sth-npbar-lib { display: flex; align-items: center; gap: 2px; flex-shrink: 0; margin-left: 2px; }
        .sth-npbar-art { width: 52px; height: 52px; border-radius: var(--r-art); flex-shrink: 0; padding: 0; border: none; box-shadow: 0 0 0 1px rgba(255,255,255,0.06); }
        .sth-npbar-title { font-size: 14px; font-weight: 700; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        /* Title doubles as the Spotify link: click to copy. */
        .sth-npbar-title.is-link { display: block; max-width: 100%; padding: 0; margin: 0; border: 0; background: none; font-family: inherit; line-height: inherit; text-align: left; cursor: pointer; }
        .sth-npbar-title.is-link:hover { text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; }
        .sth-npbar-title.is-link:disabled { cursor: progress; opacity: 0.6; }
        /* ---- Fullscreen Now Playing (NowPlayingFullView) ---- */
        .sth-full { position: absolute; inset: 10px; z-index: 42; border-radius: var(--r-card); overflow: hidden; background: #0a0a0b; border: 1px solid var(--border); display: flex; flex-direction: column; animation: sthFullIn 0.28s cubic-bezier(0.22,1,0.36,1) both; }
        @keyframes sthFullIn { from { opacity: 0; transform: scale(0.985); } to { opacity: 1; transform: none; } }
        .sth-full-bg { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
        .sth-full-top { position: relative; z-index: 1; flex-shrink: 0; height: 52px; display: flex; align-items: center; gap: 10px; padding: 0 12px 0 20px; -webkit-app-region: drag; }
        .sth-full-top button { -webkit-app-region: no-drag; }
        .sth-full-eyebrow { font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255,255,255,0.5); }
        .sth-full-tabs { display: flex; gap: 2px; padding: 3px; border-radius: 999px; background: rgba(0,0,0,0.28); -webkit-app-region: no-drag; }
        .sth-full-tab { height: 28px; padding: 0 14px; border-radius: 999px; border: none; cursor: pointer; background: transparent; color: rgba(255,255,255,0.6); font-family: inherit; font-size: 12.5px; font-weight: 600; transition: background 0.15s ease, color 0.15s ease; }
        .sth-full-tab:hover { color: #fff; }
        .sth-full-tab.on { background: rgba(255,255,255,0.14); color: #fff; font-weight: 700; }
        .sth-full-body { position: relative; z-index: 1; flex: 1; min-height: 0; display: flex; gap: 14px; padding: 0 14px 14px; }
        .sth-full-stage { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0; padding: 8px 24px 20px; }
        .sth-full-cover { flex-shrink: 1; width: min(46vh, 460px, 72%); aspect-ratio: 1 / 1; min-height: 0; border-radius: 14px; border: none; padding: 0; background-color: rgba(255,255,255,0.06); background-size: cover; background-position: center; box-shadow: 0 30px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06); transition: width 0.3s cubic-bezier(0.22,1,0.36,1); }
        .sth-full.has-panel .sth-full-cover { width: min(40vh, 400px, 80%); }
        .sth-full-meta { width: 100%; max-width: 560px; margin-top: 26px; text-align: center; min-width: 0; }
        .sth-full-title { display: block; max-width: 100%; margin: 0 auto; font-size: clamp(22px, 3.2vh, 32px); font-weight: 800; letter-spacing: -0.02em; line-height: 1.2; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sth-full-title.is-link { padding: 0; border: 0; background: none; font-family: inherit; cursor: pointer; }
        .sth-full-title.is-link:hover { text-decoration: underline; text-underline-offset: 4px; text-decoration-thickness: 2px; }
        .sth-full-title.is-link:disabled { cursor: progress; opacity: 0.6; }
        .sth-full-sub { margin-top: 6px; font-size: 15px; color: rgba(255,255,255,0.66); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sth-full-scrub { width: 100%; max-width: 520px; margin-top: 22px; display: grid; grid-template-columns: 40px minmax(0, 1fr) 40px; align-items: center; gap: 10px; }
        .sth-full-transport { margin-top: 12px; display: flex; align-items: center; gap: 14px; }
        .sth-full-skip { width: 42px; height: 42px; }
        /* Same as the bar's play button: a plain white glyph, no filled plate,
           a soft square behind it on hover. */
        .sth-full-play { width: 52px; height: 52px; border-radius: var(--r-ctl-m); border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; background: transparent; color: #fff; transition: transform 0.1s ease, background 0.14s ease; }
        /* Play buttons have no hover state, anywhere. */
        .sth-full-play:hover { background: transparent; }
        .sth-full-play:active { transform: scale(0.95); }
        .sth-full-actions { margin-top: 14px; display: flex; align-items: center; gap: 4px; }
        .sth-full-panel { position: relative; flex-shrink: 0; width: clamp(340px, 36%, 520px); min-height: 0; display: flex; flex-direction: column; border-radius: var(--r-card); overflow: hidden; background: rgba(0,0,0,0.34); border: 1px solid rgba(255,255,255,0.07); animation: sthPanelIn 0.26s cubic-bezier(0.22,1,0.3,1) both; }
        @media (max-height: 640px) { .sth-full-meta { margin-top: 16px; } .sth-full-scrub { margin-top: 14px; } }
        /* The fullscreen panel has no tab row above its content (the side
           panel's gives that room), so Info's banner and the queue started
           flush with the panel's top edge and its rounded corner cut them. */
        .sth-full-panel > .ni, .sth-full-panel > .sth-q { padding-top: 12px; }
        @media (prefers-reduced-motion: reduce) { .sth-full, .sth-full-panel { animation: none; } .sth-full-cover { transition: none; } }
        /* Compact mode: no page title in the library views. Tier one (title +
           count) goes; the controls row and table move up to the top of the
           card. Single-row headers (Albums, Artists) keep their search and
           Import, pushed right by the existing spacer. */
        .sth-root.is-compact .sth-libhead-tw { display: none; }
        .sth-root.is-compact .sth-libhead { gap: 0; padding-top: 0; }
        .sth-root.is-compact .sth-libhead.is-single { padding-top: 0; min-height: 34px; }
        /* Compact mode: the top bar slides down over the card on edge peek. */
        .sth-topbar.is-compact { transform: translateY(-100%); visibility: hidden; pointer-events: none; transition: transform 0.18s ease, visibility 0s linear 0.18s; }
        .sth-topbar.is-compact.is-peek { transform: none; visibility: visible; pointer-events: auto; box-shadow: 0 12px 36px rgba(0,0,0,0.45); transition: transform 0.22s cubic-bezier(0.22,1,0.36,1); }
        .sth-npbar-artist { font-size: 12.5px; color: var(--text-dim); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sth-npbar-mid { display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; }
        .sth-npbar-transport { display: flex; align-items: center; gap: 10px; }
        /* The original treatment: a plain white glyph, no filled plate behind
           it. Same size as the rest of the transport, just brighter. */
        .sth-npbar-play { width: 40px; height: 40px; border-radius: var(--r-ctl-m); background: transparent; color: #fff; }
        .sth-npbar-play:hover { background: transparent; filter: none; }
        .sth-npbar-scrub { display: grid; grid-template-columns: 36px 420px 36px; align-items: center; gap: 10px; max-width: 100%; }
        @media (max-width: 1180px) { .sth-npbar-scrub { grid-template-columns: 36px minmax(120px, 1fr) 36px; width: 100%; } }
        .sth-npbar-t { font-size: 11px; color: var(--text-faint); }
        .sth-npbar-seek::before { border-radius: 2px; background: rgba(255,255,255,0.14); }
        .sth-npbar-seek-fill { border-radius: 2px; background: var(--accent-line); }
        .sth-npbar-seek-knob { background: #fff; }
        .sth-npbar-right { display: flex; align-items: center; justify-content: flex-end; gap: 4px; min-width: 0; }
        .sth-npbar-cluster { display: flex; align-items: center; gap: 2px; }
        /* White, not the flat grey token — these sit on a colour wash that
           turns #A1A1AA muddy. */
        .sth-npbtn { width: 32px; height: 32px; border-radius: var(--r-ctl-s); color: rgba(255,255,255,0.68); }
        .sth-npbtn:hover { color: #fff; background: rgba(255,255,255,0.08); }
        .sth-npbtn.is-on { color: #fff; }
        /* On/off toggles (shuffle, repeat, queue, lyrics): off is dimmer, on
           is full white on a soft circle, so the state reads at a glance
           rather than as a shade of grey. */
        .sth-npbtn.is-toggle { position: relative; color: rgba(255,255,255,0.5); }
        .sth-npbtn.is-toggle:hover { color: rgba(255,255,255,0.85); }
        .sth-npbtn.is-toggle.is-on { color: #fff; background: rgba(255,255,255,0.14); }
        .sth-npbar-title { color: #fff; }
        .sth-npbar-artist { color: rgba(255,255,255,0.6); }
        .sth-npbar-t { color: rgba(255,255,255,0.55); }
        .sth-npbar-seek-fill { background: #fff; }
        .sth-npbtn-rule { background: rgba(255,255,255,0.16); }
        .sth-npbtn-rule { height: 20px; margin: 0 6px; background: rgba(255,255,255,0.1); }
        /* The bar's room depends on the sidebar and the window, so it reads
           its own width: past these points the song info narrows, then the
           volume slider goes, so the play controls never slide under the
           buttons on the right. */
        .sth-npbar { container: npbar / inline-size; }
        @container npbar (max-width: 1080px) { .sth-npbar-grid { grid-template-columns: minmax(150px, 220px) minmax(260px, 1fr) auto; } }
        @container npbar (max-width: 880px) { .sth-npbar-vol { display: none !important; } }

        /* Sidebar */
        .sth-side-eyebrow { display: flex; align-items: center; justify-content: space-between; padding: 0 12px; height: 28px; margin-top: 4px; }
        .sth-side-item { display: flex; align-items: center; gap: 14px; width: 100%; text-align: left; height: 40px; padding: 0 12px; border-radius: var(--r-ctl-m); border: none; cursor: pointer; background: transparent; color: var(--text-dim); font: inherit; font-size: 14.5px; font-weight: 500; transition: background 140ms ease, color 140ms ease; position: relative; }
        .sth-side-item:hover { background: rgba(255,255,255,0.04); color: var(--text); }
        .sth-side-item.on { color: var(--text); font-weight: 700; }
        .sth-side-item.on.m-chip { background: rgba(255,255,255,0.08); }
        .sth-side-item.on.m-bar::before { content: ''; position: absolute; left: 0; top: 10px; bottom: 10px; width: 3px; border-radius: 2px; background: var(--accent-line); }
        .sth-side-item.on.m-underline span.lbl { text-decoration: underline; text-decoration-color: var(--accent-line); text-decoration-thickness: 2px; text-underline-offset: 5px; }
        .sth-side-item.on.m-dot::after { content: ''; position: absolute; right: 12px; top: 50%; margin-top: -3px; width: 6px; height: 6px; border-radius: 50%; background: var(--accent-line); }
        .sth-side-pl { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; padding: 7px 12px; border-radius: var(--r-ctl-m); border: none; cursor: pointer; background: transparent; font: inherit; transition: background 140ms ease; }
        .sth-side-pl:hover { background: rgba(255,255,255,0.04); }
        .sth-side-pl.on { background: rgba(255,255,255,0.08); }
        .sth-side-pl .art { width: 34px; height: 34px; border-radius: var(--r-art-s); flex-shrink: 0; background-size: cover; background-position: center; }
        .sth-side-pl .nm { font-size: 13.5px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sth-side-pl .ct { font-size: 11.5px; color: var(--text-faint); margin-top: 1px; }
        /* Top bar tabs */
        .sth-searchbar { border-radius: var(--r-ctl-m); background: var(--surface); border-color: var(--border-control); }


        /* ---- Song table (shared by Songs, album, playlist, artist) ---- */
        .sth-lrow { height: var(--row-h, 54px); border-radius: var(--r-ctl-s); }
        .sth-lrow.sth-lrow-head { height: 30px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: rgba(255,255,255,0.4); border-bottom: 1px solid rgba(255,255,255,0.08); }
        .sth-lrow > div:nth-child(2) > div > div:first-child { border-radius: var(--r-art-s); }
        .sth-lrow-dim { font-size: 13px; color: var(--text-dim); }
        .sth-lrow-num, .sth-lrow-dim.st-num { font-variant-numeric: tabular-nums; }
        .sth-findfield { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px; width: 220px;
          border-radius: var(--r-ctl-m); background: rgba(0,0,0,0.25); border: 1px solid var(--border-control); color: var(--text-faint); }
        .sth-findfield:focus-within { border-color: rgba(var(--accent-rgb), 0.55); }
        .sth-findfield input { flex: 1; min-width: 0; background: transparent; border: none; outline: none; color: var(--text); font: inherit; font-size: 13px; }
        .sth-findfield input::placeholder { color: var(--text-faint); }

        /* ---- Library headers, album + artist grids ---- */
        .sth-libhead-t { font-size: 32px; font-weight: 800; letter-spacing: -0.02em; }
        .sth-libhead-m { font-size: 13px; color: var(--text-faint); }
        /* No outlines. Borders on these read as boxes floating on the page's
           colour wash — the original borderless treatment is right, and only
           Play all is emphasised, by fill rather than by an edge. */
        .sth-libact { height: 34px; border-radius: var(--r-ctl-m); border: none; color: rgba(255,255,255,0.68); font-size: 13px; font-weight: 600; background: transparent; }
        .sth-libact:hover { background: rgba(255,255,255,0.08); color: #fff; }
        .sth-libact-primary { background: rgba(255,255,255,0.14); color: #fff; }
        .sth-libact-primary:hover { background: rgba(255,255,255,0.22); color: #fff; filter: none; }
        .sth-alb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 28px 20px; }
        .sth-albart { border-radius: var(--r-art); }
        .sth-alb-play { position: absolute; right: 10px; bottom: 10px; width: 40px; height: 40px; border-radius: var(--r-ctl-m);
          display: flex; align-items: center; justify-content: center; border: none; cursor: pointer;
          /* The bar's play button, on a dark glass square so it reads on any cover. */
          background: rgba(12,12,14,0.58); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); color: #fff;
          opacity: 0; transform: translateY(6px);
          transition: opacity 150ms ease, transform 150ms ease, background 140ms ease; }
        .sth-alb:hover .sth-alb-play, .sth-alb:focus-within .sth-alb-play { opacity: 1; transform: translateY(0); }
        @media (prefers-reduced-motion: reduce) { .sth-alb-play { transition: none; } }

        /* ---- Radius pass (brief, Tokens and primitives) --------------------
           8px for controls up to 30px tall, 10px from 32 to 42, 12px above.
           Circular icon buttons become rounded squares at the same radii.
           Two exceptions, both deliberate: toggle switches keep their capsule,
           and artist artwork stays circular because it's a portrait. */
        .sth-lrow-play, .sth-lrow-more { border-radius: var(--r-ctl-s) !important; }
        .sth-searchbar, .sth-libtag, .sth-libact, .sth-libact-primary, .sth-set-navi { border-radius: var(--r-ctl-m) !important; }
        .sth-libact, .sth-libact-primary, .sth-libtag { border: none !important; }
        .sth-npbar, .sth-scroll { border-radius: var(--r-card); }
        .sth-albart { border-radius: var(--r-art) !important; }
        /* Scrollbar thumbs and progress bars keep their pill shape — they are
           rails, not controls. */

        /* ---- Icons and focus ---- */
        .sth-npbtn svg, .sth-side-item svg, .sth-set-navi svg, .sth-libact svg, .st-btn svg, .st-icon-btn svg { stroke-width: 1.5; }
        .sth-lrow, .sth-nr-row, .sth-side-pl, .sth-jump button, .sth-repeat button,
        .sth-alb, .stag-tile { -webkit-user-select: none; user-select: none; }

        /* ---- Alphabet rail ----
           24px hit targets with a visible label, rather than 10px of
           near-invisible glyphs pressed against the window edge. */
        .sth-azrail { width: 24px; padding: 2px 4px 6px; }
        /* ---- Settings ---- */
        .sth-set-rail { width: 206px; flex: 0 0 206px; padding: 24px 14px; border-right: 1px solid var(--border); }
        .sth-set-rail .lbl { padding: 14px 12px 6px; }
        .sth-set-rail .lbl:first-child { padding-top: 0; }
        .sth-set-navi { height: 38px; padding: 0 12px; border-radius: var(--r-ctl-m); font-size: 14px; font-weight: 600; color: var(--text-dim); gap: 12px; }
        .sth-set-navi.on { background: rgba(255,255,255,0.08); color: var(--text); }
        .sth-set-navi svg { width: 17px; height: 17px; flex: 0 0 17px; stroke-width: 1.5; }
        .sth-set-body { border-left: none; }
        /* Settings fill the window and grow with it: the controls column is
           a share of the width (320px up to 560px), and the gaps, padding and
           text step up in bigger windows, so a maximised window isn't a
           narrow column surrounded by empty space. */
        .sth-set-body { padding: 28px clamp(28px, 3.2vw, 64px) 48px; }
        .sth-set-body > * { box-sizing: border-box; }
        .sth-set-list { border-top: 1px solid var(--border); }
        .sth-set-r { display: grid; grid-template-columns: minmax(0, 1fr) clamp(320px, 34%, 560px); align-items: center; gap: clamp(32px, 4vw, 96px); padding: clamp(20px, 1.4vw, 26px) 0; box-shadow: none; border-bottom: 1px solid var(--border); }
        .sth-set-r:last-child { border-bottom: 1px solid var(--border); }
        .sth-set-r .txt b { font-size: clamp(14.5px, 0.85vw, 16px); font-weight: 700; color: var(--text); }
        .sth-set-r .txt p { font-size: clamp(13px, 0.75vw, 14px); color: var(--text-dim); max-width: 78ch; margin-top: 4px; }
        .sth-set-r .st-segs button { height: clamp(30px, 1.9vw, 36px); font-size: clamp(12.5px, 0.72vw, 13.5px); }
        .sth-set-r > .ctl { display: flex; flex-direction: column; align-items: stretch; gap: 10px; min-width: 0; }
        .sth-set-r > .ctl:not(.is-col) { align-items: flex-end; }
        .sth-set-sub { display: flex; justify-content: flex-end; }
        .sth-set-subhead { padding-bottom: 10px; margin-top: 14px; }
        /* Stack the control under its description when the settings area
           itself is narrow (side panel open, small window), not only when the
           window is: it used to keep a 320px control column and squeeze the
           text to a word per line. */
        .sth-set-body { container-type: inline-size; }
        /* A narrow settings card (side panel open in a small window): the
           menu folds down to its icons (names on hover) so the settings
           keep the room. */
        .sth-set-wrap { container: setwrap / inline-size; }
        @container setwrap (max-width: 760px) {
          .sth-set-wrap .sth-set-rail { width: 64px; flex: 0 0 64px; padding: 20px 10px; align-items: center; }
          .sth-set-wrap .sth-set-rail .lbl { display: none; }
          .sth-set-wrap .sth-set-rail .lbl + .sth-set-navi { margin-top: 0; }
          .sth-set-wrap .sth-set-navi { width: 44px; height: 40px; padding: 0; justify-content: center; }
          .sth-set-wrap .sth-set-navi .t { display: none; }
          .sth-set-wrap .sth-set-body { padding-left: 22px; padding-right: 22px; }
        }
        .sth-set-r { grid-template-columns: minmax(220px, 1fr) clamp(260px, 34%, 560px); }
        @container (max-width: 640px) { .sth-set-r { grid-template-columns: minmax(0, 1fr); gap: 12px; } .sth-set-r > .ctl:not(.is-col) { align-items: flex-start; } .sth-set-sub { justify-content: flex-start; } }
        @container (max-width: 420px) { .sth-set-r .st-segs { grid-auto-flow: row; grid-template-columns: repeat(auto-fit, minmax(92px, 1fr)); } }
        .sth-conn { min-width: 0; box-sizing: border-box; }
        .sth-conn-head { flex-wrap: wrap; }
        .sth-danger { display: flex; align-items: center; gap: 24px; padding: 18px 20px; margin-bottom: 12px; border-radius: var(--r-panel); background: rgba(255,139,139,0.03); border: 1px solid rgba(255,139,139,0.14); }
        .sth-danger b { display: block; font-size: 14px; font-weight: 700; color: var(--text); }
        .sth-danger p { margin: 4px 0 0; font-size: 13px; line-height: 1.5; color: var(--text-dim); }
        .sth-conn { padding: 20px 22px; border-radius: var(--r-panel); background: var(--surface-raised); border: 1px solid var(--border); }
        .sth-conn-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
        /* The text gives way, not the status pill (which wrapped to two lines and spilled over the edge). */
        .sth-conn-head > div:first-child { flex: 1; min-width: 0; }
        .sth-conn h2 { font-size: 16px; font-weight: 800; color: var(--text); margin: 0; }
        .sth-conn p { font-size: 13px; color: var(--text-dim); margin: 4px 0 0; }
        .st-fields { display: flex; flex-direction: column; gap: 12px; }
        .st-field { display: flex; flex-direction: column; gap: 6px; }
        .st-field-lbl { font-size: 10.5px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: var(--text-faint); }
        .st-input { height: 40px; padding: 0 14px; border-radius: var(--r-ctl-m); background: rgba(255,255,255,0.02); border: 1px solid var(--border-control); color: var(--text); font-size: 13.5px; }
        .st-input:focus { border-color: rgba(var(--accent-rgb), 0.6); background: rgba(255,255,255,0.03); }
      `;
