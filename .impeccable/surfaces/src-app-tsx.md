---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/pages/Home.tsx","src/pages/Streamers.tsx","src/pages/Settings.tsx"]
---

Scope: the desktop app shell and its pages (Home, Clips, Streamers, Settings, Viewer), also served as the website demo at /demo. Visitor mode: Operate.

Audience and job: VALORANT players checking their latest matches, watching fights from both POVs, saving and sharing clips.

## Direction contract

THESIS: A precise instrument panel for reviewing matches, not a glossy launcher. Rejects the frosted-glass, glowing, pill-shaped look of the category.

OWN-WORLD: Monochrome zinc on #09090B canvas, #111113 panels, #18181B hover, 1px zinc-800/80 hairlines. Only emerald #10B981 (win, ready) and rose #F43F5E (loss, error, recording). 6px / 4px radii, no pills. Geist Sans for words, Geist Mono semibold tabular for every number. Lucide icons at 1.75 stroke; Phosphor only for the Twitch mark.

STORY: Open the app, see recent form in one stat strip, scan matches by map, result and streamers, expand one to see its fights and both POVs, play a clip.

FIRST VIEWPORT: Flat left sidebar with the crosshair mark and wordmark. Top bar with search and a rectangular recorder status. Then a 4-cell stat strip divided by hairlines, underline filter tabs, and the match list as hairline panels.

FORM: seed: none (pinned) — "Use a disciplined 3-step dark surface scale (#09090B canvas, #111113 primary panels, #18181B interactive hover states) separated by crisp 1px hairline borders", "sharp, architectural rectangles", "reserving only two semantic colors", "Geist Sans and Geist Mono".

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
