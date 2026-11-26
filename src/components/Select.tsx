import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";

export interface Option<T> {
  value: T;
  label: string;
  /** A logo or icon before the label. */
  icon?: ReactNode;
}

/**
 * A dropdown that looks like the rest of the app (the Windows one doesn't).
 * Keyboard: Enter/Space/↓ opens, ↑↓ move, Enter picks, Esc closes.
 */
export function Select<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled,
  className = "",
  placeholder = "Choose…",
}: {
  /** What the dropdown is for (read by screen readers). */
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useId();
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, hi]);

  function show() {
    setHi(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  }

  function pick(i: number) {
    const o = options[i];
    if (o) onChange(o.value);
    setOpen(false);
  }

  function onKey(e: KeyboardEvent) {
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown") setHi((i) => Math.min(options.length - 1, i + 1));
    else if (e.key === "ArrowUp") setHi((i) => Math.max(0, i - 1));
    else if (e.key === "Home") setHi(0);
    else if (e.key === "End") setHi(options.length - 1);
    else if (e.key === "Enter" || e.key === " ") pick(hi);
    else if (e.key === "Tab") setOpen(false);
    else return;
    e.preventDefault();
  }

  return (
    <div ref={root} className={`dd ${open ? "open" : ""} ${className}`}>
      <button
        type="button"
        className="dd-button"
        aria-label={`${label}: ${current?.label ?? placeholder}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={list}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKey}
      >
        {current?.icon}
        <span className="dd-value">{current?.label ?? placeholder}</span>
        <CaretDown size={14} weight="bold" className="dd-caret" aria-hidden />
      </button>
      {open && (
        <ul id={list} role="listbox" aria-label={label} className="dd-list">
          {options.map((o, i) => (
            <li
              key={String(o.value)}
              data-i={i}
              role="option"
              aria-selected={o.value === value}
              className={i === hi ? "hi" : undefined}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(i);
              }}
            >
              {o.icon}
              <span className="dd-value">{o.label}</span>
              {o.value === value && <Check size={14} weight="bold" className="dd-check" aria-hidden />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
