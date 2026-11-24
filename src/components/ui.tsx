import type { ReactNode } from "react";
import type { Clip } from "../lib/sample";
import { PlayIcon } from "./Icons";

export function SampleBanner({ children }: { children: ReactNode }) {
  return (
    <p className="sample-banner" role="note">
      <strong>Preview build.</strong> {children}
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

export function ClipCard({ clip, actions = false }: { clip: Clip; actions?: boolean }) {
  const theirs = clip.kind === "theirs";
  return (
    <article className="card clip">
      <div className="thumb">
        <PlayIcon />
        <span className={theirs ? "badge theirs" : "badge mine"}>{theirs ? "Their POV" : "My POV"}</span>
        <span className="duration">{clip.length}</span>
      </div>
      <div className="clip-body">
        <span className="clip-title">{clip.title}</span>
        <span className="muted small">{clip.meta}</span>
      </div>
      {actions && (
        <div className="clip-actions">
          <button type="button" className="btn">Play</button>
          {theirs && <button type="button" className="btn primary">Side-by-side</button>}
        </div>
      )}
    </article>
  );
}
