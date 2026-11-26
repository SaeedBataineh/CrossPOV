import type { ReactNode } from "react";
import { thumbSrc, type ClipInfo } from "../lib/backend";
import type { Draft } from "../lib/useDraft";
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

export function Notice({ tone, children }: { tone: "warn" | "bad" | "info"; children: ReactNode }) {
  return (
    <p className={`notice s12 ${tone === "warn" ? "" : tone}`} role={tone === "info" ? "status" : "alert"}>
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

// ---------- Gallery ----------

/** Big, plain title for a clip card: what happened, not the file name. */
export function cardTitle(c: ClipInfo): string {
  if (!isTheirs(c)) return "Your clip";
  const m = c.moment ?? "Streamer clip";
  return m.charAt(0).toUpperCase() + m.slice(1);
}

/** "Ascent · R14 · 35 min ago" */
export function cardMeta(c: ClipInfo): string {
  return [c.map, c.round != null ? `R${c.round}` : null, timeAgo(c.createdMs)].filter(Boolean).join(" · ");
}

const FolderIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
);
const TrashIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
);

const TwitchMark = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><path fill="#9146ff" d="M2.15 0 .58 4.1v16.8h5.71V24h3.22l3.04-3.1h4.6l6.25-6.2V0z" /></svg>
);

function Half({ clip }: { clip: ClipInfo }) {
  const src = thumbSrc(clip.thumb);
  return <span className={isTheirs(clip) ? "half theirs" : "half"}>{src && <img src={src} alt="" loading="lazy" decoding="async" />}</span>;
}

/**
 * A clip in a grid: click to open it. With `other` (the other side of the same
 * fight) the thumbnail is split: YOU on the left, THEM on the right.
 * Folder and delete appear on hover.
 */
export function GalleryCard({ clip, other, title, meta, onPlay, onReveal, onDelete }: {
  clip: ClipInfo;
  other?: ClipInfo;
  title?: string;
  meta?: string;
  onPlay: () => void;
  onReveal?: () => void;
  onDelete?: () => void;
}) {
  const src = thumbSrc(clip.thumb);
  const t = title ?? cardTitle(clip);
  const mine = isTheirs(clip) ? other : clip;
  const theirs = isTheirs(clip) ? clip : other;
  const both = Boolean(mine && theirs);
  return (
    <div className="gcard">
      <button type="button" className={both ? "gthumb split" : isTheirs(clip) ? "gthumb theirs" : "gthumb"} onClick={onPlay} aria-label={`Open ${t}`}>
        {both ? (
          <>
            <Half clip={mine!} />
            <Half clip={theirs!} />
          </>
        ) : src ? (
          <img src={src} alt="" loading="lazy" decoding="async" />
        ) : (
          <svg width="36" height="36" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#ffffff14" /><path d="M10 8l6 4-6 4z" fill="#ffffffb3" /></svg>
        )}
        <span className="hover-play" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z" fill="currentColor" /></svg></span>
        {mine && <span className="tag you">YOU</span>}
        {theirs && <span className="tag them"><TwitchMark />{both ? "THEM" : theirs.streamer ?? "THEM"}</span>}
        {clip.durationSec != null && <span className="len">{formatDuration(clip.durationSec)}</span>}
      </button>
      {(onReveal || onDelete) && (
        <span className="gactions">
          {onReveal && <button type="button" className="icon-btn sm" aria-label={`Show ${t} in folder`} title="Show in folder" onClick={onReveal}><FolderIcon /></button>}
          {onDelete && <button type="button" className="icon-btn sm" aria-label={`Delete ${t}`} title="Delete" onClick={onDelete}><TrashIcon /></button>}
        </span>
      )}
      <b className="gtitle">{t}</b>
      <span className="gmeta">{meta ?? cardMeta(clip)}</span>
    </div>
  );
}

/** A card-sized placeholder in a clip grid (downloading, not available...). */
export function PendingCard({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <div className="gcard">
      <div className="gthumb pending">{children}</div>
      <b className="gtitle">{title}</b>
      {meta && <span className="gmeta">{meta}</span>}
    </div>
  );
}

/** "Saved automatically", or what saving is doing right now. */
export function SaveState({ d }: { d: Draft }) {
  const bad = d.status.startsWith("Could not");
  return (
    <span className={bad ? "save-state bad" : "save-state"} role="status">
      {!bad && !d.saving && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--win)" strokeWidth="2.5" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7" /></svg>
      )}
      {d.saving || d.dirty ? "Saving…" : bad ? d.status : "Saved automatically"}
    </span>
  );
}

