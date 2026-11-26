import { siBattledotnet, siCounterstrike, siDiscord, siEpicgames, siFortnite, siGooglechrome, siKick, siLeagueoflegends, siObsstudio, siRiotgames, siRoblox, siSpotify, siSteam, siTwitch, siValorant, siYoutube, type SimpleIcon } from "simple-icons";

/*
 * Real brand logos (Simple Icons, CC0) for the programs and games CrossPOV
 * shows, so a known app gets its own mark instead of a letter tile.
 */
const BY_KEY: [RegExp, SimpleIcon][] = [
  [/valorant/, siValorant],
  [/riot ?client|riotclient/, siRiotgames],
  [/discord/, siDiscord],
  [/spotify/, siSpotify],
  [/chrome/, siGooglechrome],
  [/^cs2|counter.?strike|csgo/, siCounterstrike],
  [/league ?of ?legends|leagueclient/, siLeagueoflegends],
  [/fortnite/, siFortnite],
  [/roblox/, siRoblox],
  [/steam/, siSteam],
  [/epicgames|epic games/, siEpicgames],
  [/battle\.?net/, siBattledotnet],
  [/obs(64)?(\.exe)?$|obs studio/, siObsstudio],
  [/twitch/, siTwitch],
  [/youtube/, siYoutube],
  [/kick/, siKick],
];

/** The brand logo for a program or game name / .exe, if we know it. */
export function brandFor(name: string): SimpleIcon | null {
  const k = name.toLowerCase();
  return BY_KEY.find(([re]) => re.test(k))?.[1] ?? null;
}

/** Logos whose brand colour is too dark to see on the app's near-black background are drawn white. */
const tooDark = (hex: string) => {
  const n = parseInt(hex, 16);
  return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 < 70;
};

export function BrandLogo({ icon, size = 16 }: { icon: SimpleIcon; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={tooDark(icon.hex) ? "#f4f4f5" : `#${icon.hex}`} aria-hidden="true">
      <path d={icon.path} />
    </svg>
  );
}
