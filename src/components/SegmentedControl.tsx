import { useId, useRef, type KeyboardEvent } from "react";
import { motion } from "framer-motion";
import { slide } from "./Motion";

export interface Segment<T extends string> {
  id: T;
  label: string;
  /** A small count after the label; hidden when undefined (0 still shows). */
  n?: number;
}

/**
 * Filter tabs: plain text over a hairline, with an underline that slides to the
 * chosen tab. Tabs semantics: arrow keys, Home and End move between them.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  segments,
  onChange,
  hideZero = false,
}: {
  label: string;
  value: T;
  segments: Segment<T>[];
  onChange: (v: T) => void;
  /** Hide a count of 0 instead of showing it. */
  hideZero?: boolean;
}) {
  const list = useRef<HTMLDivElement>(null);
  const underline = useId();

  function onKey(e: KeyboardEvent) {
    const i = segments.findIndex((s) => s.id === value);
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? segments.length - 1 : null;
    if (next == null) return;
    e.preventDefault();
    const s = segments[(next + segments.length) % segments.length];
    onChange(s.id);
    list.current?.querySelector<HTMLElement>(`[data-id="${s.id}"]`)?.focus();
  }

  return (
    <div ref={list} role="tablist" aria-label={label} onKeyDown={onKey} className="relative flex h-9 max-w-full items-stretch gap-5 overflow-x-auto [scrollbar-width:none]">
      {segments.map((s) => {
        const on = s.id === value;
        return (
          <button
            key={s.id}
            data-id={s.id}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(s.id)}
            className={`relative inline-flex shrink-0 items-center gap-2 rounded-sm whitespace-nowrap border-0 bg-transparent px-0 text-sm font-medium transition-colors duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-4 focus-visible:ring-offset-canvas ${on ? "text-ink" : "text-quiet hover:text-body"}`}
          >
            {s.label}
            {s.n != null && !(hideZero && s.n === 0) && (
              <span className={`min-w-5 rounded-sm px-1 text-center font-mono text-[11px] leading-[18px] font-semibold tabular-nums ${on ? "bg-zinc-800 text-ink" : "bg-hover text-quiet"}`}>{s.n}</span>
            )}
            {on && <motion.span layoutId={underline} layoutDependency={value} transition={slide} aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 bg-ink" />}
          </button>
        );
      })}
    </div>
  );
}
