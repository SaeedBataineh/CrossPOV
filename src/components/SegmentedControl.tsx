import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Icon } from "@phosphor-icons/react";

export interface Segment<T extends string> {
  id: T;
  label: string;
  /** A small count after the label; hidden when undefined (0 still shows). */
  n?: number;
  /** An icon before the label (filled when the tab is chosen). */
  Icon?: Icon;
}

/**
 * Library tabs (GG-style): icon, label and count, with an accent underline
 * that slides to the chosen tab. Tabs semantics: arrow keys move between them.
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
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);

  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const place = () => {
      const on = el.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!on) return;
      const x = on.offsetLeft;
      const w = on.offsetWidth;
      setThumb((t) => (t && t.x === x && t.w === w ? t : { x, w }));
    };
    place();
    // Counts and fonts change widths after the first paint.
    const ro = new ResizeObserver(place);
    for (const child of el.children) ro.observe(child);
    return () => ro.disconnect();
  }, [value, segments]);

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
    <div ref={list} role="tablist" aria-label={label} onKeyDown={onKey} className="relative inline-flex h-11 items-stretch gap-1">
      {thumb && (
        <span
          aria-hidden
          className="absolute bottom-0 left-0 h-[3px] rounded-t-full bg-[#3b9eff] shadow-[0_-2px_12px_rgba(59,158,255,0.55)] transition-[transform,width] duration-250 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
          style={{ width: thumb.w - 16, transform: `translateX(${thumb.x + 8}px)` }}
        />
      )}
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
            className={`group relative inline-flex items-center gap-2 rounded-lg border-0 bg-transparent px-3 text-[14px] font-semibold tracking-[-0.01em] transition-[color,background-color] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-[#3b9eff] ${on ? "text-white" : "text-[#85858e] hover:bg-white/[0.04] hover:text-[#d9d9de]"}`}
          >
            {s.Icon && <s.Icon size={17} weight={on ? "fill" : "bold"} aria-hidden className={`transition-colors duration-150 ${on ? "text-[#6ab7ff]" : ""}`} />}
            {s.label}
            {s.n != null && !(hideZero && s.n === 0) && (
              <span className={`min-w-[20px] rounded-full px-1.5 text-center text-[11px] leading-[18px] font-bold tabular-nums transition-colors duration-150 ${on ? "bg-[#3b9eff] text-white" : "bg-white/[0.07] text-[#a3a3ab]"}`}>{s.n}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
