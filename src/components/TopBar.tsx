import { useEffect, useRef, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { isDesktop, saveClipNow, type RecorderStatus } from "../lib/backend";
import type { Settings } from "../lib/settings";

/** A physical-looking keycap. */
export function Keycap({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[20px] min-w-[22px] items-center justify-center rounded-[6px] border-0 bg-gradient-to-b from-zinc-700/90 to-zinc-800/90 px-1.5 font-sans text-[11px] leading-none font-semibold text-zinc-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_1px_0_rgba(0,0,0,0.6),0_2px_4px_-1px_rgba(0,0,0,0.5)] ring-1 ring-black/40">
      {children}
    </kbd>
  );
}

/** Spotlight-style search. Ctrl+K (Windows) focuses it from anywhere; Esc clears it. */
function Spotlight({ label, query, onQuery }: { label: string; query: string; onQuery: (q: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <label className="group relative flex h-10 w-full max-w-[420px] min-w-0 items-center gap-2.5 rounded-xl bg-zinc-900/60 px-3 text-zinc-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_8px_24px_-12px_rgba(0,0,0,0.7)] ring-1 ring-white/[0.08] backdrop-blur-2xl transition-all duration-200 focus-within:bg-zinc-900/80 focus-within:text-zinc-300 focus-within:ring-2 focus-within:ring-white/25 hover:ring-white/[0.14]">
      <Search size={16} strokeWidth={2.2} aria-hidden className="shrink-0" />
      <span className="sr-only">{label}</span>
      <input
        ref={input}
        type="search"
        placeholder={label}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onQuery("");
            e.currentTarget.blur();
          }
        }}
        spellCheck={false}
        className="h-full min-w-0 flex-1 border-0 bg-transparent text-[14px] tracking-[-0.01em] text-zinc-100 outline-none placeholder:text-zinc-500 [&::-webkit-search-cancel-button]:hidden"
      />
      {query ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onQuery("")}
          className="grid size-5 place-items-center rounded-full border-0 bg-white/10 text-zinc-300 transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
        >
          <X size={12} strokeWidth={2.6} aria-hidden />
        </button>
      ) : (
        <span className="flex shrink-0 items-center gap-1 transition-opacity group-focus-within:opacity-0" aria-hidden>
          <Keycap>Ctrl</Keycap>
          <Keycap>K</Keycap>
        </span>
      )}
    </label>
  );
}

type Tone = "rec" | "ready" | "bad" | "idle";

const DOT: Record<Tone, string> = {
  rec: "bg-[#FF453A] shadow-[0_0_10px_2px_rgba(255,69,58,0.55)]",
  ready: "bg-[#30D158] shadow-[0_0_10px_2px_rgba(48,209,88,0.5)]",
  bad: "bg-[#FFD60A] shadow-[0_0_8px_1px_rgba(255,214,10,0.4)]",
  idle: "bg-zinc-500",
};

/** A Dynamic Island-like capsule: what the recorder is doing, and the hotkey. */
function StatusIsland({ status, settings, children }: { status: RecorderStatus | null; settings: Settings; children?: ReactNode }) {
  const state = status?.state;
  const recording = state === "recording";
  const bad = state === "error" || state === "noFfmpeg";
  const tone: Tone = !isDesktop ? "idle" : recording ? "rec" : bad ? "bad" : state === "waiting" ? "ready" : "idle";
  const line = !isDesktop
    ? "Website demo"
    : recording ? "Recording"
    : bad ? "Recorder stopped"
    : state === "waiting" ? "Waiting for a game"
    : "Starting…";
  const game = recording ? status?.game : null;

  return (
    <div
      role="status"
      title={status?.message ?? undefined}
      className="flex h-10 max-w-full min-w-0 items-center gap-2.5 rounded-full bg-black/70 py-1 pr-1.5 pl-3.5 text-[13px] whitespace-nowrap text-zinc-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_10px_30px_-10px_rgba(0,0,0,0.9)] ring-1 ring-white/[0.08] backdrop-blur-2xl"
    >
      <span className="relative grid size-2.5 shrink-0 place-items-center" aria-hidden>
        {(tone === "ready" || tone === "rec") && (
          <span className={`absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:animate-none ${tone === "rec" ? "bg-[#FF453A]" : "bg-[#30D158]"}`} />
        )}
        <span className={`relative size-2.5 rounded-full ${DOT[tone]}`} />
      </span>
      <span className="min-w-0 truncate font-semibold tracking-[-0.01em]">
        {line}
        {game?.name ? <span className="font-medium text-zinc-300"> · {game.name}</span> : null}
      </span>
      {isDesktop && (
        <span className="hidden min-w-0 items-center gap-1.5 truncate text-zinc-400 lg:flex">
          <span aria-hidden className="text-zinc-600">·</span>
          press <Keycap>{settings.hotkey}</Keycap> to save the last <span className="tabular-nums">{settings.bufferSeconds}</span>s
        </span>
      )}
      {children}
      {!children && <span className="w-1" />}
    </div>
  );
}

/** Top bar: Spotlight search (where it applies), and the recorder island with Save clip. */
export function TopBar({
  settings,
  status,
  query,
  onQuery,
  searchLabel,
  onSaving,
  onIgnore,
  title,
}: {
  settings: Settings;
  status: RecorderStatus | null;
  query: string;
  onQuery: (q: string) => void;
  /** No search box when undefined. */
  searchLabel?: string;
  onSaving: () => void;
  /** "Not a game?": stop recording this program for good. */
  onIgnore: (exe: string) => void;
  /** Shown instead of the search box. */
  title?: ReactNode;
}) {
  const recording = status?.state === "recording";
  const game = recording ? status?.game : null;

  // Lines up with the centred 1200px page column below (main has 28px padding and a 10px scrollbar gutter).
  return (
    <header className="relative z-10 flex h-[68px] shrink-0 items-center gap-4 pr-[max(38px,calc((100%-1190px)/2))] pl-[max(28px,calc((100%-1210px)/2))]">
      {searchLabel ? (
        <Spotlight label={searchLabel} query={query} onQuery={onQuery} />
      ) : (
        <h1 className="m-0 min-w-0 truncate text-[20px] font-semibold tracking-[-0.025em] text-white">{title}</h1>
      )}
      <span className="flex-1" />
      <StatusIsland status={status} settings={settings}>
        {game?.found === "fullscreen" && game.exe && (
          <button
            type="button"
            title={`CrossPOV is recording ${game.exe} because it's fullscreen. Stop recording it?`}
            onClick={() => {
              if (window.confirm(`Stop recording ${game.name}? It won't be recorded again. You can undo this in Settings › Games.`)) onIgnore(game.exe);
            }}
            className="h-7 rounded-full border-0 bg-white/[0.08] px-3 text-[12px] font-medium text-zinc-200 transition-colors hover:bg-white/[0.14] focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
          >
            Not a game?
          </button>
        )}
        {recording && (
          <button
            type="button"
            onClick={() => {
              onSaving();
              void saveClipNow();
            }}
            className="h-7 rounded-full border-0 bg-white px-3.5 text-[12.5px] font-semibold text-zinc-950 shadow-[0_1px_0_rgba(255,255,255,0.4)_inset,0_4px_12px_-4px_rgba(255,255,255,0.35)] transition-all hover:bg-zinc-100 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
          >
            Save clip
          </button>
        )}
      </StatusIsland>
    </header>
  );
}
