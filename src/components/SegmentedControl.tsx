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
      className="relative inline-flex h-9 items-center rounded-full bg-zinc-900/70 p-[3px] shadow-[inset_0_1px_2px_rgba(0,0,0,0.5)] ring-1 ring-white/[0.06] backdrop-blur-xl"
    >
      {thumb && (
        <span
          aria-hidden
          className="absolute top-[3px] bottom-[3px] left-0 rounded-full bg-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_1px_3px_rgba(0,0,0,0.4)] ring-1 ring-white/[0.08] transition-[transform,width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
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
            className={`relative z-10 inline-flex h-full items-center gap-1.5 rounded-full border-0 bg-transparent px-3.5 text-[13px] font-medium tracking-[-0.01em] transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70 ${on ? "text-white" : "text-zinc-400 hover:text-zinc-200"}`}
          >
            {s.label}
            {s.n != null && !(hideZero && s.n === 0) && (
              <span className={`min-w-[18px] rounded-full px-1.5 text-center text-[11px] leading-[18px] font-semibold tabular-nums ${on ? "bg-white/15 text-white" : "bg-white/[0.06] text-zinc-400"}`}>{s.n}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
