// Inline stroke icons: no icon font or library, so nothing extra to load.
type P = { size?: number };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

export const HomeIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}><rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" /></svg>
);
export const MatchesIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M4 19V5M4 19h16M8 15v-4M12 15V8M16 15v-6" /></svg>
);
export const AudioIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M4 10v4h4l5 4V6L8 10z" /><path d="M16.5 9a4 4 0 0 1 0 6" /></svg>
);
export const ClipsIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 9l5 3-5 3z" /></svg>
);
export const StreamIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}><circle cx="12" cy="12" r="3" /><path d="M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8" /></svg>
);
export const GearIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);
export const PlayIcon = ({ size = 36 }: P) => (
  <svg {...base(size)} strokeWidth={1.5}><circle cx="12" cy="12" r="10" /><path d="M10 8l6 4-6 4z" /></svg>
);
export const SearchIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
);

/**
 * CrossPOV mark: a play button inside a ring of three arcs, coloured for
 * where streamer POVs come from (Twitch purple, YouTube red, Kick green).
 * Our own design; no third-party logos.
 */
export const Logo = ({ size = 28 }: P) => (
  <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
    <path d="M15.82 3.66A10.5 10.5 0 0 1 23.87 17.59" stroke="#9146FF" strokeWidth="3" strokeLinecap="round" />
    <path d="M22.04 20.75A10.5 10.5 0 0 1 5.96 20.75" stroke="#FF3B3B" strokeWidth="3" strokeLinecap="round" />
    <path d="M4.13 17.59A10.5 10.5 0 0 1 12.18 3.66" stroke="#53FC18" strokeWidth="3" strokeLinecap="round" />
    <path d="M11.4 9.6C11.4 8.8 12.3 8.3 13 8.7L19 12.6C19.6 13 19.6 14 19 14.4L13 18.3C12.3 18.7 11.4 18.2 11.4 17.4Z" fill="#F0F0F0" />
  </svg>
);
