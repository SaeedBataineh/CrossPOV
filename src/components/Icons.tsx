// Brand marks. UI glyphs come from lucide-react; the Twitch glyph from Phosphor.
import { TwitchLogo } from "@phosphor-icons/react";

type P = { size?: number };

/** Twitch, wherever a clip or channel comes from it. Monochrome: it takes the text colour. */
export const TwitchIcon = ({ size = 14, color = "currentColor" }: P & { color?: string }) => (
  <TwitchLogo size={size} color={color} weight="fill" aria-hidden="true" />
);

/**
 * CrossPOV mark: a frame split down the middle (your side, their side), with a
 * crosshair where the two halves meet. One colour, drawn on a 24px grid.
 */
export const Logo = ({ size = 22 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
    <path d="M9.5 3.5H4.5a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h5" />
    <path d="M14.5 3.5h5a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1h-5" />
    <path d="M12 2v6.5M12 15.5V22M6.5 12h3M14.5 12h3" />
    <rect x="11" y="11" width="2" height="2" fill="currentColor" stroke="none" />
  </svg>
);
