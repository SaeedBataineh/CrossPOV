import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** One line in a right-click menu. A `separator` draws a line above it. */
export interface MenuItem {
  label: string;
  icon?: ReactNode;
  run: () => void;
  danger?: boolean;
  separator?: boolean;
}

let open: ((m: { x: number; y: number; items: MenuItem[] }) => void) | null = null;

/** Opens the app's right-click menu at the pointer. <ContextMenuHost /> (in App) draws it. */
export function openContextMenu(x: number, y: number, items: MenuItem[]) {
  open?.({ x, y, items });
}

export function ContextMenuHost() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    open = (m) => {
      setPos(null);
      setMenu(m);
    };
    return () => {
      open = null;
    };
  }, []);

  // Keep it on screen: flip left/up when it would run off the edge.
  useLayoutEffect(() => {
    if (!menu || !box.current) return;
    const r = box.current.getBoundingClientRect();
    const left = menu.x + r.width > window.innerWidth - 8 ? Math.max(8, menu.x - r.width) : menu.x;
    const top = menu.y + r.height > window.innerHeight - 8 ? Math.max(8, menu.y - r.height) : menu.y;
    setPos({ left, top });
    box.current.querySelector<HTMLButtonElement>("button")?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && close();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("wheel", close, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("wheel", close);
    };
  }, [menu]);

  if (!menu) return null;
  const buttons = () => [...(box.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
  return (
    <div
      ref={box}
      className="ctx-menu"
      role="menu"
      style={pos ? { left: pos.left, top: pos.top } : { left: menu.x, top: menu.y, visibility: "hidden" }}
      onKeyDown={(e) => {
        const all = buttons();
        const i = all.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "Escape") setMenu(null);
        else if (e.key === "ArrowDown") all[(i + 1) % all.length]?.focus();
        else if (e.key === "ArrowUp") all[(i - 1 + all.length) % all.length]?.focus();
        else return;
        e.preventDefault();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          className={[it.danger ? "danger" : "", it.separator ? "sep" : ""].join(" ").trim() || undefined}
          onClick={() => {
            setMenu(null);
            it.run();
          }}
        >
          <span className="ctx-ic" aria-hidden="true">{it.icon}</span>
          {it.label}
        </button>
      ))}
    </div>
  );
}
