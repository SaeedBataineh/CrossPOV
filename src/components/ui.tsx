import type { ReactNode } from "react";
import { thumbSrc, type ClipInfo } from "../lib/backend";
import { formatDuration, formatSize, timeAgo, type Toast } from "../lib/useRecorder";

/** A titled box. `color` is the small square before the title. */
export function Panel({
  title,
  color = "#e8e8e8",
  right,
  className = "",
  children,
}: {
  title: string;
  color?: string;
  right?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={`panel ${className}`} aria-label={title}>
      <div className="ph">
        <span className="pt"><i style={{ background: color }} />{title}</span>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Notice({ tone, children }: { tone: "warn" | "bad"; children: ReactNode }) {
  return (
    <p className={`notice s12 ${tone === "bad" ? "bad" : ""}`} role="alert">
      {children}
    </p>
  );
}

export function Stat({ label, value, purple }: { label: string; value: ReactNode; purple?: boolean }) {
  return (
    <div className={purple ? "stat purple" : "stat"}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

/** Segmented single choice, e.g. 30 | 60 | 120. */
export function Seg<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="tg" disabled={disabled} onClick={() => onChange(!checked)} />;
}

/** One settings line: label and help on the left, control on the right. */
export function Row({ label, help, children }: { label: string; help?: ReactNode; children?: ReactNode }) {
  return (
    <div className="sr">
      <span>
        <b>{label}</b>
        {help && <small>{help}</small>}
      </span>
      {children}
    </div>
  );
}

/** 0-200 % volume slider. */
export function Volume({ label, value, onChange, disabled }: { label: string; value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <label className="volume">
      <span className="sr-only">{label} volume</span>
      <input type="range" min={0} max={200} step={5} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
      <span aria-hidden="true">{value}%</span>
    </label>
  );
}

export function ToastView({ toast }: { toast: Toast | null }) {
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toast && <div key={toast.id} className={`toast ${toast.tone}`}>{toast.text}</div>}
    </div>
  );
}

// ---------- Clips ----------

const isTheirs = (c: ClipInfo) => c.kind === "theirs";

export function clipTitle(c: ClipInfo): string {
  if (isTheirs(c) && c.streamer) return `vs ${c.streamer}${c.round ? ` · R${c.round}` : ""}`;
  return c.name.replace(/^Clip_/, "").replace(/_/g, " ");
}

export function clipMoment(c: ClipInfo): string {
  return isTheirs(c) ? (c.moment ?? "Streamer clip").toLowerCase() : "hotkey clip";
}

/** "HH:MM" for today, otherwise "3 days ago". */
export function clockOrAgo(ms: number): string {
  const d = new Date(ms);
  if (d.toDateString() === new Date().toDateString()) return d.toTimeString().slice(0, 5);
  return timeAgo(ms);
}

/** Short time for narrow columns: "14:32" today, otherwise "Mon". */
export function shortWhen(ms: number): string {
  const d = new Date(ms);
  if (d.toDateString() === new Date().toDateString()) return d.toTimeString().slice(0, 5);
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

export function ClipThumb({ clip, label, big }: { clip: ClipInfo; label?: string; big?: boolean }) {
  const src = thumbSrc(clip.thumb);
  return (
    <div className={isTheirs(clip) ? "thumb theirs" : "thumb"}>
      {src ? (
        <img src={src} alt="" loading="lazy" decoding="async" />
      ) : (
        <svg width={big ? 40 : 28} height={big ? 40 : 28} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M10 8l6 4-6 4z" /></svg>
      )}
      <span className="tag" style={big ? { fontSize: 10 } : undefined}>{label ?? (isTheirs(clip) ? "THEM" : "YOU")}</span>
      {clip.durationSec != null && <span className="len">{formatDuration(clip.durationSec)}</span>}
    </div>
  );
}

export function ClipCard({ clip, selected, onSelect, onOpen }: { clip: ClipInfo; selected?: boolean; onSelect?: () => void; onOpen?: () => void }) {
  return (
    <button
      type="button"
      className={isTheirs(clip) ? "clip-card theirs" : "clip-card"}
      aria-pressed={selected}
      onClick={onSelect}
      onDoubleClick={onOpen}
      title={onOpen ? "Double-click to play" : undefined}
    >
      <ClipThumb clip={clip} />
      <span className="meta">
        <b className="ellipsis">{clipTitle(clip)}</b>
        <span className="what">{clipMoment(clip)}</span>
        <span className="where"><span className="ellipsis">{[clip.map, clockOrAgo(clip.createdMs)].filter(Boolean).join(" · ")}</span><span>{formatSize(clip.sizeBytes)}</span></span>
      </span>
    </button>
  );
}
