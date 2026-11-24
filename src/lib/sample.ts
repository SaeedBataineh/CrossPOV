// Placeholder data shown until the recorder (step 2) and streamer
// detection (step 4) exist. Everything here is clearly labelled as sample
// data in the UI.

export type ClipKind = "mine" | "theirs";

export interface Clip {
  id: string;
  title: string;
  meta: string;
  length: string;
  kind: ClipKind;
}

export const SAMPLE_CLIPS: Clip[] = [
  { id: "c1", title: "Round 14 clutch", meta: "Hotkey clip · 2 min ago", length: "0:45", kind: "mine" },
  { id: "c2", title: "vs streamer_two", meta: "They killed you · Round 9", length: "0:20", kind: "theirs" },
  { id: "c3", title: "vs streamer_two", meta: "You killed them · Round 17", length: "0:20", kind: "theirs" },
  { id: "c4", title: "Round 3 ace", meta: "Hotkey clip · yesterday", length: "1:00", kind: "mine" },
  { id: "c5", title: "vs streamer_three", meta: "They killed you · Round 5", length: "0:20", kind: "theirs" },
  { id: "c6", title: "Round 22 retake", meta: "Hotkey clip · 2 days ago", length: "0:30", kind: "mine" },
];

export type PlayerStatus =
  | "clipped"
  | "grabbed"
  | "archive"
  | "waiting"
  | "checking"
  | "subonly"
  | "novod"
  | "none"
  | "private";

export const STATUS_LABEL: Record<PlayerStatus, string> = {
  clipped: "VOD checked",
  grabbed: "Grabbed after match",
  archive: "From archive",
  waiting: "Waiting for VOD",
  checking: "Checking VOD…",
  subonly: "Sub-only VOD · skipped",
  novod: "No public VOD",
  none: "Not a streamer",
  private: "Private profile · skipped",
};

export interface LobbyPlayer {
  name: string;
  team: "Your team" | "Enemy";
  channel?: string;
  status: PlayerStatus;
  clips?: number;
}

export interface Match {
  id: string;
  title: string;
  when: string;
  summary: string;
  summaryStatus: PlayerStatus;
  players: LobbyPlayer[];
}

export const SAMPLE_MATCHES: Match[] = [
  {
    id: "m1",
    title: "Match 1 · Map",
    when: "12 min ago",
    summary: "2 streamers · 5 clips",
    summaryStatus: "grabbed",
    players: [
      { name: "streamer_two", team: "Enemy", channel: "streamer_two", status: "grabbed", clips: 3 },
      { name: "streamer_one", team: "Enemy", channel: "streamer_one", status: "archive", clips: 2 },
      { name: "player_04", team: "Your team", status: "none" },
      { name: "player_05", team: "Enemy", status: "none" },
      { name: "Private player", team: "Enemy", status: "private" },
    ],
  },
  {
    id: "m2",
    title: "Match 2 · Map",
    when: "1 h ago",
    summary: "Checking VOD",
    summaryStatus: "checking",
    players: [
      { name: "streamer_three", team: "Enemy", channel: "streamer_three", status: "checking" },
      { name: "streamer_four", team: "Your team", channel: "streamer_four", status: "subonly" },
      { name: "player_07", team: "Enemy", status: "none" },
    ],
  },
  {
    id: "m3",
    title: "Match 3 · Map",
    when: "Yesterday",
    summary: "No streamers",
    summaryStatus: "none",
    players: [{ name: "player_08", team: "Enemy", status: "none" }],
  },
];
