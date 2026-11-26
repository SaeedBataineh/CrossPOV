// Brand marks. UI glyphs come from @phosphor-icons/react directly.
import { TwitchLogo } from "@phosphor-icons/react";
type P = { size?: number };

/** Twitch glyph (Phosphor). */
export const TwitchIcon = ({ size = 14, color = "currentColor" }: P & { color?: string }) => <TwitchLogo size={size} color={color} weight="fill" aria-hidden="true" />;

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
