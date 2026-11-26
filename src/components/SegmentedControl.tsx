import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

export interface Segment<T extends string> {
  id: T;
  label: string;
  /** A small count after the label; hidden when undefined (0 still shows). */
  n?: number;
}

/**
 * Segmented control with a glass thumb that slides to the chosen segment.
 * Tabs semantics: arrow keys move between segments.
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
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      onKeyDown={onKey}
      className="relative inline-flex h-9 items-center rounded-[10px] bg-[#111113] p-[3px] ring-1 ring-[#2b2b2f]"
    >
      {thumb && (
        <span
          aria-hidden
          className="absolute top-[3px] bottom-[3px] left-0 rounded-[7px] bg-[#3b9eff]/[0.16] ring-1 ring-[#3b9eff]/40 shadow-[0_1px_2px_rgba(0,0,0,0.35)] transition-[transform,width] duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none"
          style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }}
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
            className={`relative z-10 inline-flex h-full items-center gap-1.5 rounded-[7px] border-0 bg-transparent px-3.5 text-[13px] font-medium tracking-[-0.01em] transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${on ? "text-white" : "text-zinc-400 hover:text-zinc-200"}`}
          >
            {s.label}
            {s.n != null && !(hideZero && s.n === 0) && (
              <span className={`min-w-[18px] rounded-md px-1.5 text-center text-[11px] leading-[18px] font-semibold tabular-nums ${on ? "bg-[#3b9eff]/25 text-white" : "bg-white/[0.06] text-zinc-400"}`}>{s.n}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
