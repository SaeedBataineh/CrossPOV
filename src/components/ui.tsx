import type { ReactNode } from "react";
import { thumbSrc, type ClipInfo } from "../lib/backend";
import type { Clip } from "../lib/sample";
import { formatDuration, timeAgo, type Toast } from "../lib/useRecorder";
import { PlayIcon } from "./Icons";

export function SampleBanner({ children }: { children: ReactNode }) {
  return (
    <p className="sample-banner" role="note">
      <strong>Preview.</strong> {children}
    </p>
  );
}

export function Notice({ tone, children }: { tone: "warn" | "bad"; children: ReactNode }) {
  return (
    <p className={tone === "bad" ? "error-banner" : "warn-banner"} role="alert">
      {children}
    </p>
  );
}

export function Pills<T extends string | number>({
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
    <div className="pills" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className="pill"
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="toggle"
      onClick={() => onChange(!checked)}
    >
      <span className="knob" />
    </button>
  );
}

/** 0-200 % volume slider. */
export function Volume({ label, value, onChange, disabled }: { label: string; value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <label className="volume">
      <span className="sr-only">{label} volume</span>
      <input
        type="range"
        min={0}
        max={200}
        step={5}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="volume-value" aria-hidden="true">{value}%</span>
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

/** What a clip card shows; built from a real clip or sample data. */
export interface CardClip {
  key: string;
  title: string;
  meta: string;
  length: string;
  kind: "mine" | "theirs";
  thumb?: string;
  sample?: boolean;
}

export function cardFromClip(c: ClipInfo): CardClip {
  const theirs = c.kind === "theirs";
  return {
    key: c.path,
    title: theirs && c.streamer
      ? `vs ${c.streamer}${c.round ? ` · round ${c.round}` : ""}`
      : c.name.replace(/^Clip_/, "").replace(/_/g, " "),
    meta: theirs
      ? [c.moment ?? "Streamer clip", c.map, timeAgo(c.createdMs)].filter(Boolean).join(" · ")
      : `Hotkey clip · ${timeAgo(c.createdMs)}`,
    length: formatDuration(c.durationSec),
    kind: c.kind,
    thumb: thumbSrc(c.thumb),
  };
}

export function cardFromSample(c: Clip): CardClip {
  return { key: c.id, title: c.title, meta: c.meta, length: c.length, kind: c.kind, sample: true };
}

export function ClipCard({ clip, actions }: { clip: CardClip; actions?: ReactNode }) {
  const theirs = clip.kind === "theirs";
  const cls = ["card", "clip", theirs ? "theirs" : "", clip.sample ? "sample" : ""].filter(Boolean).join(" ");
  return (
    <article className={cls}>
      <div className="thumb">
        {clip.thumb ? <img src={clip.thumb} alt="" loading="lazy" decoding="async" /> : <PlayIcon />}
        {clip.thumb && (
          <span className="play" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z" /></svg>
          </span>
        )}
        <span className={theirs ? "badge theirs" : "badge mine"} title={theirs ? "Their POV" : "Your POV"}>{theirs ? "THEM" : "YOU"}</span>
        {clip.length && <span className="duration">{clip.length}</span>}
      </div>
      <div className="clip-body">
        <span className="clip-title">{clip.title}</span>
        <span className="muted small" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {theirs && <span className="pf-dot twitch" title="From Twitch" />}
          {clip.meta}
        </span>
      </div>
      {actions && <div className="clip-actions">{actions}</div>}
    </article>
  );
}
