import { useEffect, useRef, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { isDesktop, saveClipNow, type RecorderStatus } from "../lib/backend";
import type { Settings } from "../lib/settings";

/** A keyboard key. */
export function Keycap({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-[22px] items-center justify-center rounded-sm border border-zinc-700 bg-hover shadow-[inset_0_-1px_0_#3f3f46] px-1.5 font-mono text-[11px] leading-none font-semibold text-ink">
      {children}
    </kbd>
  );
}

/** Search. Ctrl+K focuses it from anywhere; Esc clears it. */
function SearchField({ label, query, onQuery }: { label: string; query: string; onQuery: (q: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  // Phones get a short placeholder; the full one would be cut off.
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 639px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
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
    <label className="group relative flex h-9 w-full max-w-[400px] min-w-0 items-center gap-2.5 rounded-md border border-zinc-800 bg-panel px-3 text-quiet transition-colors duration-150 ease-out hover:border-zinc-700 focus-within:border-zinc-400 focus-within:text-body">
      <Search size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
      <span className="sr-only">{label}</span>
      <input
        ref={input}
        type="search"
        placeholder={narrow ? "Search" : label}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onQuery("");
            e.currentTarget.blur();
          }
        }}
        spellCheck={false}
        className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-body outline-none placeholder:text-quiet [&::-webkit-search-cancel-button]:hidden"
      />
      {query ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onQuery("")}
          className="grid size-6 place-items-center rounded-sm border-0 bg-transparent text-quiet transition-colors hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink focus-visible:outline-none"
        >
          <X size={14} strokeWidth={1.75} aria-hidden />
        </button>
      ) : (
        <span className="flex shrink-0 items-center gap-1 transition-opacity duration-150 group-focus-within:opacity-0 max-sm:hidden" aria-hidden>
          <Keycap>Ctrl</Keycap>
          <Keycap>K</Keycap>
        </span>
      )}
    </label>
  );
}

type Tone = "rec" | "ready" | "bad" | "idle";
const DOT: Record<Tone, string> = { rec: "bg-loss", ready: "bg-win", bad: "bg-loss", idle: "bg-zinc-500" };

/** What the recorder is doing, the hotkey, and the actions that go with it. */
function RecorderStatusBar({ status, settings, children, actions }: { status: RecorderStatus | null; settings: Settings; children?: ReactNode; actions: boolean }) {
  const state = status?.state;
  const recording = state === "recording";
  const bad = state === "error" || state === "noFfmpeg";
  const tone: Tone = !isDesktop ? "idle" : recording ? "rec" : bad ? "bad" : state === "waiting" ? "ready" : "idle";
  const line = !isDesktop ? "Website demo" : recording ? "Recording" : bad ? "Recorder stopped" : state === "waiting" ? "Waiting for a game" : "Starting…";
  const game = recording ? status?.game : null;

  return (
    <div
      role="status"
      title={status?.message ?? (game?.name ? `Recording ${game.name}` : undefined)}
      className={`flex h-9 max-w-full min-w-0 shrink-0 items-center gap-2.5 rounded-md border border-zinc-800 bg-panel pl-3 text-sm whitespace-nowrap ${actions ? "pr-1" : "pr-3"}`}
    >
      <span className="relative grid size-2 shrink-0 place-items-center" aria-hidden>
        {(tone === "ready" || tone === "rec") && <span className={`absolute inset-0 animate-ping rounded-[2px] opacity-50 motion-reduce:animate-none ${DOT[tone]}`} />}
        <span className={`relative size-2 rounded-[2px] ${DOT[tone]}`} />
      </span>
      <span className="flex min-w-0 font-medium text-ink">
        <span className="shrink-0">{line}</span>
        {game?.name && <span className="hidden min-w-0 truncate font-normal text-quiet min-[1200px]:inline">&nbsp;· {game.name}</span>}
      </span>
      {isDesktop && (
        <span className="hidden items-center gap-1.5 border-l border-zinc-800 pl-2.5 text-[13px] text-quiet min-[1200px]:flex">
          <Keycap>{settings.hotkey}</Keycap>
          saves the last <span className="font-mono font-semibold text-body tabular-nums">{settings.bufferSeconds}s</span>
        </span>
      )}
      {children}
    </div>
  );
}

const ghost =
  "h-7 shrink-0 rounded-sm border border-zinc-700 bg-transparent px-2.5 text-[13px] font-medium text-body transition-colors duration-150 ease-out hover:border-zinc-600 hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink focus-visible:outline-none";
const solid =
  "h-7 shrink-0 rounded-sm border border-ink bg-ink px-2.5 text-[13px] font-semibold text-canvas transition-colors duration-150 ease-out hover:bg-zinc-200 focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-panel focus-visible:outline-none";

/** Top bar: search (where it applies) or the page title, and the recorder status with Save clip. */
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

  return (
    <header className="relative z-10 flex h-16 shrink-0 items-center gap-3 pr-[42px] pl-8 max-sm:px-4">
      {searchLabel ? (
        <SearchField label={searchLabel} query={query} onQuery={onQuery} />
      ) : (
        <h1 className="m-0 min-w-0 truncate text-[20px] font-semibold tracking-[-0.02em] text-ink">{title}</h1>
      )}
      <span className="flex-1" />
      <RecorderStatusBar status={status} settings={settings} actions={recording}>
        {game?.found === "fullscreen" && game.exe && (
          <button
            type="button"
            className={ghost}
            title={`CrossPOV is recording ${game.exe} because it's fullscreen. Stop recording it?`}
            onClick={() => {
              if (window.confirm(`Stop recording ${game.name}? It won't be recorded again. You can undo this in Settings › Games.`)) onIgnore(game.exe);
            }}
          >
            Not a game?
          </button>
        )}
        {recording && (
          <button
            type="button"
            className={solid}
            onClick={() => {
              onSaving();
              void saveClipNow();
            }}
          >
            Save clip
          </button>
        )}
      </RecorderStatusBar>
    </header>
  );
}
