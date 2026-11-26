---
name: CrossPOV
description: A precise instrument panel for reviewing VALORANT matches from both sides of every fight.
colors:
  canvas: "#09090b"
  panel: "#111113"
  hover: "#18181b"
  avatar: "#1e1e22"
  line: "rgb(39 39 42 / 0.8)"
  line-strong: "#27272a"
  edge: "#3f3f46"
  edge-hover: "#52525b"
  ink: "#fafafa"
  body: "#f4f4f5"
  quiet: "#a1a1aa"
  win: "#10b981"
  loss: "#f43f5e"
  loss-text: "#fb7185"
typography:
  display:
    fontFamily: "Geist Mono Variable, ui-monospace, Cascadia Mono, monospace"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.02em"
    fontFeature: "tnum"
  headline:
    fontFamily: "Geist Variable, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Geist Variable, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Geist Variable, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "-0.006em"
  body-small:
    fontFamily: "Geist Variable, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Geist Variable, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.06em"
  number:
    fontFamily: "Geist Mono Variable, ui-monospace, Cascadia Mono, monospace"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1
    fontFeature: "tnum"
rounded:
  xs: "2px"
  sm: "4px"
  md: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
  3xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "#e4e4e7"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.body}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "36px"
  button-ghost-hover:
    backgroundColor: "{colors.hover}"
  button-compact:
    backgroundColor: "transparent"
    textColor: "{colors.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  search-field:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.quiet}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  recorder-status:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.quiet}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "36px"
  nav-item-active:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink}"
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.body}"
    rounded: "{rounded.md}"
  stat-cell:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.display}"
    padding: "16px 20px"
  result-tag-win:
    backgroundColor: "rgb(16 185 129 / 0.1)"
    textColor: "{colors.win}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "32px"
  result-tag-loss:
    backgroundColor: "rgb(244 63 94 / 0.1)"
    textColor: "{colors.loss}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "32px"
  segmented-option:
    backgroundColor: "transparent"
    textColor: "{colors.quiet}"
    rounded: "{rounded.sm}"
    padding: "5px 10px"
  segmented-option-selected:
    backgroundColor: "{colors.line-strong}"
    textColor: "{colors.ink}"
  clip-tag-you:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.sm}"
    padding: "3px 6px"
  keycap:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 5px"
    height: "20px"
---

# Design System: CrossPOV

## Overview

**Creative North Star: "The Instrument Panel"**

CrossPOV is read like a flight instrument, not browsed like a launcher. Three near-black zinc surfaces stack with 1px hairlines between them; there is no glass, no glow and no blur. The eye goes to numbers (win rate, K/D/A, round scores, clip lengths) because they are the only things set in a second typeface, Geist Mono at semibold with tabular figures, and to two colours, because emerald and rose are the only hues on screen and each means exactly one thing.

Density is deliberate and calm: one stat strip, one row of filter tabs, then match panels that open in place. Panels are flat rectangles with 6px corners; inside a panel, content sits on hairline-separated rows rather than in nested boxes. Motion is short and purposeful (160 to 220ms, a fast ease-out with no bounce): a "you are here" block slides between nav items and tabs, a match grows open to show its fights, a page fades in 4px from below. Everything honours the viewer's reduced-motion setting.

This world replaced an earlier frosted-glass, glowing, pill-shaped look. The rejection is part of the system: translucency, coloured glows and capsule shapes do not come back.

**Key Characteristics:**
- Three-step dark surface scale (canvas, panel, hover) separated by 1px hairlines.
- Two semantic colours only: emerald for win and ready, rose for loss, error and recording.
- Rectangles everywhere: 6px for containers and controls, 4px for small tags and inner options, 2px for status dots. No pills, no circles.
- Geist Sans for words, Geist Mono semibold tabular for every number, including numbers inside sentences.
- Lucide icons at 1.75 stroke; Phosphor only for the Twitch logo; a custom split-frame crosshair as the brand mark.
- Motion is functional and brief (160 to 220ms), with shared-layout indicators and a height accordion.

## Colors

A monochrome zinc instrument with two signal lamps.

### Primary
- **Bone White** (ink): the "primary" colour is the brightest neutral. It fills primary buttons (with canvas text), the YOU clip tag, the active filter-tab underline, the focus ring, the playhead and progress fill, and titles.

### Secondary
- **Signal Emerald** (win): a win, a won round, "ready" (recorder waiting for a game), a saved clip, a switch that is on, the keep range and fight markers on the timeline. As a tint it is 10 to 18% fill with a 35 to 40% border.

### Tertiary
- **Signal Rose** (loss): a loss, a lost round, an error, and recording. Its lighter partner **Rose Text** (loss-text) is used where rose must read as text on dark panels (error lines, the danger button label). As a tint it is 6 to 16% fill with a 40 to 45% border.

### Neutral
- **Canvas** (canvas): the window background, and the inside of inputs and segmented controls.
- **Panel** (panel): sidebar, top-bar controls, every flat panel, stat cells.
- **Hover** (hover): hover fill, the active nav block, keycaps, empty thumbnails.
- **Avatar Tile** (avatar): the square behind avatars, agent portraits and app icons.
- **Hairline** (line): the 1px border around panels and between rows and stat cells.
- **Strong Hairline** (line-strong): segmented-control frame, notices, the selected segment fill, track of progress bars and switches.
- **Control Edge** (edge) and **Control Edge Hover** (edge-hover): the 1px border of buttons, inputs and tags, and its hover step.
- **Body** (body): running text. **Quiet** (quiet): secondary text, labels, inactive nav and tabs, icons at rest.

### Named Rules
**The Two Lamps Rule.** Emerald and rose are the only hues. Emerald is a win or ready; rose is a loss, an error or recording. Nothing is coloured for decoration, and no third hue (amber, purple, blue) is introduced for warnings, links or brands.

**The Neutral Warning Rule.** A warning is neutral text in a hairline box, identified by a leading Lucide triangle icon, never by colour. Only errors turn rose.

**The Glyph Not Purple Rule.** Twitch is marked by its logo glyph in the current text colour, never by Twitch purple.

## Typography

**Display Font:** Geist Mono Variable (with ui-monospace, Cascadia Mono)
**Body Font:** Geist Variable (with Segoe UI Variable Text, Segoe UI, system-ui)
**Label/Mono Font:** Geist Mono Variable for all numerals

**Character:** One family in two cuts. The sans carries words at tight negative tracking; the mono carries every figure at semibold with tabular numerals so columns of scores and times line up like a readout.

### Hierarchy
- **Display** (Mono 600, 26px, line-height 1): the big number in each stat-strip cell.
- **Headline** (600, 20px): the page title in the top bar on pages without search. Section titles step down to 18px.
- **Title** (600, 16px, tight): the map name on a match panel, settings panel titles (15px).
- **Body** (400, 14px, 1.45): running text, nav labels, buttons, inputs.
- **Body Small** (400, 13px): meta lines under titles, help text in settings rows, stat-cell captions, compact buttons.
- **Label** (500, 11 to 12px, 0.04 to 0.08em, uppercase): data labels only: column headers in tables, the caption under an inline stat (K/D/A, KD, CLIPS), the result word in a result tag, YOU/THEM clip tags.
- **Number** (Mono 600, 15px, tabular): scores, K/D/A, counts, durations, keycaps (11px), clip lengths (11.5px).

### Named Rules
**The Readout Rule.** Every number is Geist Mono semibold with tabular figures, even mid-sentence. Text that mixes words and digits ("R14 · they killed you", "37 min", "9:00 into the match") passes through the digit-run wrapper so only the digits switch face, at 0.94em.

**The Label Is Data Rule.** Uppercase tracked text names a value or column it sits on. It never floats above a heading as a decorative kicker.

## Layout

The shell is a two-column grid: a flat sidebar on the left and a scrolling main column. The sidebar is 208px with icon and label from 1100px wide; below 1100px it collapses to a 64px icon-only rail; below 640px it moves to a fixed 56px bottom bar. The desktop window never goes narrower than 900px, so the icon rail is the smallest desktop state.

The top bar is 64px tall: search (up to 400px, Ctrl+K) or the page title on the left, the rectangular recorder status on the right. The hotkey and buffer length inside the status appear from 1200px.

The main column has 32px side padding (16px below 640px) and a 20px vertical gap between page sections. The Home stat strip is four cells in one bordered panel, divided by 1px gaps over the hairline colour, so the dividers stay correct when it reflows to 2 by 2 below 1280px. Filter tabs sit on a hairline with controls aligned to its baseline. Match panels use container queries: the inline stats block appears from 60rem of panel width, the streamer badge from 52rem, and the meta line wraps below 34rem. Clip tiles flow in a grid with a 24px row gap and 16px column gap. Settings is a 208px section list beside the content with a 40px gap.

Spacing steps are 4, 8, 12, 16, 20, 24 and 32px. Controls are 36px tall, compact controls 32px, inline actions 28px.

## Elevation & Depth

The system is flat. Depth comes from the three-step surface scale and hairlines, not shadows: canvas recedes, panels sit on it with a 1px hairline, and hover lifts a surface by one tonal step. Inside a panel, rows are separated by hairlines rather than raised into cards.

Shadows exist only for things that genuinely float over the page: the video player, the update dialog and toasts. Their backdrop is a near-opaque canvas scrim (92%), never a blur.

### Shadow Vocabulary
- **Overlay** (`box-shadow: 0 24px 60px -24px rgba(0, 0, 0, 0.8)`): the player and update dialog.
- **Toast** (`box-shadow: 0 16px 40px -16px rgba(0, 0, 0, 0.8)`): transient toasts, with a hairline tinted emerald or rose for the outcome.
- **Keycap lip** (`box-shadow: inset 0 -1px 0 #3f3f46`): the bottom edge of a keyboard key.

### Named Rules
**The Flat Panel Rule.** One panel, one hairline, no shadow, no backdrop-filter. Nothing floats unless it is an overlay.

**The No Nesting Rule.** A panel never holds another bordered card. Details inside a match sit on the panel itself as hairline-separated rows.

## Shapes

Sharp, architectural rectangles. Containers, buttons, inputs, nav items, thumbnails, avatars and agent portraits use a 6px corner. Small things inside them use 4px: result tags, clip tags, keycaps, segmented options, round blocks, count badges, inline action buttons. Status dots, timeline marks and legend swatches are 2px squares; the switch is a 5px rectangle with a 3px square thumb. Progress bars are 4px tall with 2px ends.

Borders are always 1px. A dashed 1px hairline marks a placeholder (a clip still downloading, an empty list).

**The No Pill Rule.** Nothing is fully rounded: no capsule buttons, no circular avatars, no round status dots. The largest corner in the system is 6px.

## Components

### Buttons
Rectangular and quiet; one solid button per area at most.
- **Shape:** gently squared corners (6px; 4px for the 28px inline actions in the recorder status).
- **Primary:** bone-white fill with canvas text, semibold. Used for the one decisive action (Save clip, Look up, Save).
- **Ghost:** transparent with a 1px control-edge border and body text; the default for everything else (Details, Not a game?).
- **Hover / Focus:** ghost steps to the hover surface and lighter edge; primary steps to a dimmer white (#e4e4e7). Transitions are 160ms ease-out on colour only. Focus is a 2px bone-white ring offset 2px.
- **Disabled:** 45% opacity.
- **Danger:** ghost with rose-text label; never a rose fill.

### Chips and Tags
- **Result tag:** a 32px rectangle tinted by the result (emerald for Win, rose for Loss, hover surface for Draw), uppercase result word plus the score in mono.
- **Clip tags:** YOU is solid bone white; THEM is a near-opaque canvas tag with a control-edge inset and the Twitch glyph. Clip length sits bottom-right in mono.
- **Count badge:** a 4px rectangle beside a tab label, mono 11px.

### Cards / Containers
- **Corner Style:** 6px.
- **Background:** panel.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** 1px hairline; on a match panel it brightens to control-edge on hover.
- **Internal Padding:** 12 to 16px for match headers, 16 by 20px for stat cells, 14 by 18px for settings rows.

### Inputs / Fields
- **Style:** 36px tall, canvas fill, 1px control-edge border, 6px corners; placeholder in quiet.
- **Focus:** border turns bone white; no glow.
- **Error:** border turns rose.
- **Search:** sits on the panel surface with a leading search icon and a Ctrl / K keycap pair that fades on focus.

### Navigation
- **Sidebar:** brand mark and wordmark at the top, page items below, Settings pinned to the bottom. Items are 36px with an 18px Lucide icon; inactive items are quiet, the active item is bone white on a hover-surface block with an inset hairline. That block slides between items as a shared-layout element (220ms).
- **Filter tabs:** plain text over a hairline with a 2px bone-white underline that slides to the chosen tab. Arrow keys, Home and End move between tabs.
- **Settings sections:** a vertical list whose active block slides the same way.
- **Segmented control:** for short numeric choices (30 | 60 | 120); a canvas frame with a strong-hairline border and 4px options, the selected one filled with strong hairline.

### Recorder Status
A rectangle in the top bar, never a pill. A 2px-cornered square dot carries the state: rose while recording, emerald while waiting for a game (both with a soft ping that stops under reduced motion), grey while starting or in the demo, rose when stopped by an error. The label says the state in words; the hotkey keycap and buffer length follow after a hairline; Save clip appears inside it while recording.

### Stat Strip
Four cells (Win rate, K/D ratio, Saved clips, Streamer matches) in one bordered panel with 1px hairline gaps. Each cell: a quiet 13px label, a 26px mono number, and a quiet caption whose digits are in mono. Win rate carries the last ten results as 6 by 12px emerald or rose bars.

### Match Panel
A flat panel per match: the map art (100 by 56px, 6px corners) with the agent portrait overlapping its corner, map and agent, a meta line, the result tag, inline stats between hairlines, the streamer badge, and a Details toggle whose chevron rotates. Clip tiles sit below a hairline. Details open with a height accordion (220ms height, 160ms opacity) and contain streamer rows, the round strip, and both teams as hairline tables.

### Round Strip
Each round is a 4px rectangle: emerald tint for won, rose tint for lost, hover surface for unknown, with the round number and your kills in mono. A round where you fought a streamer gets a 1.5px bone-white inset outline.

### Clip Tile
A 6px thumbnail with an inset hairline that brightens on hover (no lift). When both sides of a fight exist the thumbnail splits down the middle with a 1px divider: YOU on the left, THEM on the right. A pending clip is a dashed placeholder with its status in words.

### Avatars
Square tiles with 6px corners. The fallback chain is fixed: the streamer's Twitch picture (proxied), else the agent portrait they played, else the Twitch glyph on a plain tile. Avatars never show initials.

### Notices
A hairline box with a leading 16px Lucide icon in quiet: info, or a warning triangle. Errors use a rose-tinted fill (6%), a rose border and a rose icon; the text stays body colour. Links inside are underlined in bone white with a dim underline that brightens on hover.

### Brand Mark
A monochrome 24px-grid mark: a frame split down the middle (your side, their side) with a crosshair and a 2px square at the join, drawn at 1.75 stroke in the current text colour beside the CrossPOV wordmark (15px, 600, -0.02em).

## Do's and Don'ts

### Do:
- **Do** build every surface from canvas, panel and hover with 1px hairlines between them.
- **Do** set every number in Geist Mono semibold with tabular figures, wrapping digit runs inside sentences.
- **Do** use emerald only for win or ready, and rose only for loss, error or recording.
- **Do** mark a warning with a leading Lucide icon on a neutral hairline box.
- **Do** draw Lucide icons at 1.75 stroke (16px inline, 18px in navigation); use Phosphor only for the Twitch logo.
- **Do** keep corners at 6px for containers and controls, 4px for small inner pieces, 2px for dots.
- **Do** animate with the fast ease-out (160 to 220ms) and keep reduced motion respected.
- **Do** place details inside a panel as hairline-separated rows.

### Don't:
- **Don't** use pills, capsules or circles anywhere: buttons, tags, avatars and status dots are rectangles.
- **Don't** bring back frosted glass, backdrop blur, glows or coloured shadows.
- **Don't** add a third hue for warnings, links, Twitch or decoration.
- **Don't** nest a bordered card inside a panel.
- **Don't** show initials as an avatar; follow the picture, agent, glyph chain.
- **Don't** set numbers in the sans face, or use proportional figures in a column.
- **Don't** put an uppercase tracked kicker above a heading; uppercase labels name data only.
- **Don't** add shadows to anything that is not an overlay (player, dialog, toast).
