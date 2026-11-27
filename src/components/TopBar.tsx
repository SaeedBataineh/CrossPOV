import { useEffect, useRef, type ReactNode } from "react";
import { MagnifyingGlass, Record, X } from "@phosphor-icons/react";
import { isDesktop, saveClipNow, type RecorderStatus } from "../lib/backend";
import type { Settings } from "../lib/settings";
import { confirmDialog } from "./Dialog";
import { Select } from "./Select";

/** A keyboard key, Medal-style: a flat key box. */
export function Keycap({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[20px] min-w-[22px] items-center justify-center rounded-[5px] border border-[#2b2b2f] bg-[#1c1c1f] px-1.5 font-sans text-[11px] leading-none font-bold text-white">
      {children}
    </kbd>
  );
}

/** Search. Ctrl+K focuses it from anywhere; Esc clears it. */
function SearchBox({ label, query, onQuery }: { label: string; query: string; onQuery: (q: string) => void }) {
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
    <label className="group relative flex h-9 w-full max-w-[380px] min-w-0 items-center gap-2 rounded-lg border border-[#2b2b2f] bg-[#111113] px-3 text-[#85858e] transition-colors duration-150 focus-within:border-[#3b9eff] focus-within:text-[#d9d9de] hover:border-[#3a3a40]">
      <MagnifyingGlass size={16} weight="bold" aria-hidden className="shrink-0" />
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
        className="h-full min-w-0 flex-1 border-0 bg-transparent text-[13.5px] text-white outline-none placeholder:text-[#85858e] [&::-webkit-search-cancel-button]:hidden"
      />
      {query ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onQuery("")}
          className="grid size-5 place-items-center rounded border-0 bg-white/10 text-[#d9d9de] transition-colors hover:bg-white/20"
        >
          <X size={11} weight="bold" aria-hidden />
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

const LENGTHS = [15, 30, 60, 120, 300];
const lengthLabel = (s: number) => (s > 60 ? `Clip ${s / 60}m` : `Clip ${s}s`);

/**
 * The capture bar (SteelSeries GG-style), across the top of every page:
 * the page title and search on the left; on the right what the recorder is
 * doing, the hotkey with the clip length (click to change it), and Save clip.
 */
export function TopBar({
  settings,
  status,
  query,
  onQuery,
  searchLabel,
  onSaving,
  onIgnore,
  onLength,
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
  /** Change how many seconds a hotkey clip keeps. */
  onLength: (seconds: number) => void;
  title: ReactNode;
}) {
  const state = status?.state;
  const recording = state === "recording";
  const bad = state === "error" || state === "noFfmpeg";
  const game = recording ? status?.game : null;
  const line = !isDesktop ? "Website demo" : recording ? `Recording${game?.name ? ` · ${game.name}` : ""}` : bad ? "Recorder stopped" : state === "waiting" ? "Waiting for a game" : "Starting…";
  const tone = !isDesktop ? "text-[#a3a3ab]" : recording ? "text-[#ff5c5c]" : bad ? "text-[#e0b84c]" : "text-[#2fd9c4]";
  const lengths = LENGTHS.includes(settings.bufferSeconds) ? LENGTHS : [...LENGTHS, settings.bufferSeconds].sort((a, b) => a - b);

  return (
    <header className="relative z-10 flex h-[60px] shrink-0 items-center gap-4 border-b border-[#222225] px-6">
      <h1 className="m-0 shrink-0 text-[17px] font-bold tracking-[-0.01em] text-white">{title}</h1>
      {searchLabel && <SearchBox label={searchLabel} query={query} onQuery={onQuery} />}
      <span className="flex-1" />

      <span role="status" title={status?.message ?? (game?.exe || undefined)} className={`flex min-w-0 items-center gap-2 text-[11.5px] font-bold tracking-[0.06em] whitespace-nowrap uppercase ${tone}`}>
        <span className="relative grid size-2 shrink-0 place-items-center" aria-hidden>
          {recording && <span className="absolute inset-0 animate-ping rounded-full bg-current opacity-50 motion-reduce:animate-none" />}
          {recording ? <Record size={10} weight="fill" className="relative" /> : <span className="relative size-2 rounded-full bg-current" />}
        </span>
        <span className="truncate">{line}</span>
      </span>

      <Select
        label="Clip length"
        className="capture-chip"
        value={settings.bufferSeconds}
        onChange={onLength}
        options={lengths.map((s) => ({ value: s, label: lengthLabel(s), icon: <Keycap>{settings.hotkey}</Keycap> }))}
      />

      {game?.found === "fullscreen" && game.exe && (
        <button
          type="button"
          title={`CrossPOV is recording ${game.exe} because it's fullscreen. Stop recording it?`}
          onClick={() => {
            void confirmDialog({ title: `Stop recording ${game.name}?`, body: "It won't be recorded again. You can undo this in Settings › Games.", confirm: "Stop recording" }).then((ok) => ok && onIgnore(game.exe));
          }}
          className="h-8 shrink-0 rounded-lg border border-[#2b2b2f] bg-[#1c1c1f] px-3 text-[12.5px] font-semibold text-[#d9d9de] transition-colors hover:bg-[#26262a] active:scale-[0.97]"
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
          className="h-8 shrink-0 rounded-lg border-0 bg-[#3b9eff] px-3.5 text-[12.5px] font-bold text-white transition-[background-color,transform] hover:bg-[#6ab7ff] active:scale-[0.97]"
        >
          Save clip
        </button>
      )}
    </header>
  );
}
