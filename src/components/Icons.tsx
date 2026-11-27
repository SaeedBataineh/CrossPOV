// Brand marks. UI glyphs come from @phosphor-icons/react directly.
import { siTwitch } from "simple-icons";
type P = { size?: number };

/** Twitch's real logo (Simple Icons), in Twitch purple unless told otherwise. */
export const TwitchIcon = ({ size = 14, color = `#${siTwitch.hex}`, className }: P & { color?: string; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color} className={className} aria-hidden="true">
    <path d={siTwitch.path} />
  </svg>
);

/** The same logo as a tab icon: takes the tab's colour like the other tab icons. */
export const TwitchTabIcon = ({ size, className }: { size?: number | string; weight?: unknown; className?: string }) => (
  <TwitchIcon size={typeof size === "number" ? size : 16} color="currentColor" className={className} />
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
