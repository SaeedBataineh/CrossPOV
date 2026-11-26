import { motion } from "framer-motion";
import { Clapperboard, House, Info, Radio, Settings as SettingsIcon, type LucideIcon } from "lucide-react";
import { isDesktop, type UpdateStatus } from "../lib/backend";
import { Logo } from "./Icons";
import { slide } from "./Motion";

export type Page = "home" | "clips" | "streamers" | "settings";

const NAV: { id: Page; label: string; Icon: LucideIcon }[] = [
  { id: "home", label: "Home", Icon: House },
  { id: "clips", label: "Clips", Icon: Clapperboard },
  { id: "streamers", label: "Streamers", Icon: Radio },
];

/** Labels show from 1100px; below that the rail is icons only. */
const wide = "hidden min-[1100px]:inline";
const item =
  "relative flex h-9 w-full items-center max-sm:flex-1 justify-center gap-3 rounded-md border-0 bg-transparent px-2.5 text-sm font-medium no-underline outline-none transition-colors duration-150 ease-out min-[1100px]:justify-start focus-visible:ring-2 focus-visible:ring-ink";

function NavItem({ page, id, label, Icon, onNavigate }: { page: Page; id: Page; label: string; Icon: LucideIcon; onNavigate: (p: Page) => void }) {
  const on = page === id;
  return (
    <button
      type="button"
      className={`${item} ${on ? "text-ink" : "text-quiet hover:text-body"}`}
      aria-current={on ? "page" : undefined}
      title={label}
      onClick={() => onNavigate(id)}
    >
      {on && <motion.span layoutId="nav-active" layoutDependency={page} transition={slide} aria-hidden className="absolute inset-0 rounded-md bg-hover ring-1 ring-zinc-800 ring-inset" />}
      <Icon size={18} strokeWidth={1.75} aria-hidden className="relative shrink-0" />
      <span className={`relative ${wide}`}>{label}</span>
    </button>
  );
}

/** The left rail: the mark, the pages, and Settings at the bottom. */
export function Sidebar({ page, update, onNavigate }: { page: Page; update: UpdateStatus | null; onNavigate: (p: Page) => void }) {
  return (
    <nav aria-label="Main" className="flex min-h-0 w-16 flex-col gap-1 overflow-y-auto border-r border-line bg-panel px-3 pt-4 pb-3 min-[1100px]:w-[208px] max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-30 max-sm:h-14 max-sm:w-full max-sm:flex-row max-sm:items-center max-sm:border-t max-sm:border-r-0 max-sm:px-2 max-sm:py-2.5">
      <span className="mb-5 flex h-9 items-center justify-center gap-2.5 px-1 text-ink max-sm:hidden min-[1100px]:justify-start min-[1100px]:px-2.5" title="CrossPOV">
        <Logo size={22} />
        <span className={`text-[15px] leading-none font-semibold tracking-[-0.02em] ${wide}`}>CrossPOV</span>
      </span>
      {NAV.map((n) => (
        <NavItem key={n.id} page={page} {...n} onNavigate={onNavigate} />
      ))}
      <span className="flex-1 max-sm:hidden" />
      {update?.state === "waiting" && (
        <span
          className="mb-1 rounded-md border border-line px-2 py-1.5 text-center text-[12px] leading-tight font-medium text-body min-[1100px]:text-left"
          title={`Update v${update.version} installs as soon as VALORANT is closed`}
        >
          Update after <span className={wide}>the </span>game
        </span>
      )}
      <NavItem page={page} id="settings" label="Settings" Icon={SettingsIcon} onNavigate={onNavigate} />
      {!isDesktop && (
        <a className={`${item} text-quiet hover:text-body`} href="/" title="About CrossPOV">
          <Info size={18} strokeWidth={1.75} aria-hidden className="shrink-0" />
          <span className={wide}>About</span>
        </a>
      )}
    </nav>
  );
}
