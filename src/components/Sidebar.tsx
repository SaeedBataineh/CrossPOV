import { Clapperboard, House, Info, Radio, Settings as SettingsIcon, type LucideIcon } from "lucide-react";
import { isDesktop, type UpdateStatus } from "../lib/backend";
import { Logo } from "./Icons";

export type Page = "home" | "clips" | "streamers" | "settings";

const NAV: { id: Page; label: string; Icon: LucideIcon }[] = [
  { id: "home", label: "Home", Icon: House },
  { id: "clips", label: "Clips", Icon: Clapperboard },
  { id: "streamers", label: "Streamers", Icon: Radio },
];

/** Labels show from 1100px; narrower windows get an icon rail. */
const wide = "hidden min-[1100px]:inline";
const item =
  "relative flex h-10 w-full items-center justify-center gap-3 rounded-xl border-0 bg-transparent px-3 text-[14px] font-medium no-underline transition-[background-color,color,transform] duration-150 ease-out outline-none active:scale-[0.97] min-[1100px]:justify-start focus-visible:ring-2 focus-visible:ring-white/60";
const idle = "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100";
const active = "bg-violet-500/[0.14] text-white";

function NavItem({ page, id, label, Icon, onNavigate }: { page: Page; id: Page; label: string; Icon: LucideIcon; onNavigate: (p: Page) => void }) {
  const on = page === id;
  return (
    <button type="button" className={`${item} ${on ? active : idle}`} aria-current={on ? "page" : undefined} title={label} onClick={() => onNavigate(id)}>
      <Icon size={19} strokeWidth={on ? 2 : 1.75} aria-hidden className={`shrink-0 ${on ? "text-violet-300" : ""}`} />
      <span className={wide}>{label}</span>
    </button>
  );
}

/**
 * The sidebar, laid out like other clipping apps: the brand at the top, the
 * pages under it, and Settings in the bottom-left corner.
 */
export function Sidebar({ page, update, onNavigate }: { page: Page; update: UpdateStatus | null; onNavigate: (p: Page) => void }) {
  return (
    <nav
      aria-label="Main"
      className="relative z-20 m-2.5 mr-0 flex min-h-0 w-[68px] flex-col gap-1 overflow-y-auto rounded-[20px] border border-white/[0.07] bg-zinc-900/70 p-2.5 shadow-[0_20px_40px_-24px_rgba(0,0,0,0.8)] min-[1100px]:w-[220px]"
    >
      <span className="mb-4 flex h-11 items-center justify-center gap-2.5 px-1 min-[1100px]:justify-start min-[1100px]:px-2" title="CrossPOV">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/[0.06]">
          <Logo size={22} />
        </span>
        <span className={`text-[16px] font-semibold tracking-[-0.02em] text-white ${wide}`}>CrossPOV</span>
      </span>
      {NAV.map((n) => (
        <NavItem key={n.id} page={page} {...n} onNavigate={onNavigate} />
      ))}
      <span className="flex-1" />
      {update?.state === "waiting" && (
        <span
          className="mb-1 rounded-lg bg-white/[0.05] px-2 py-1.5 text-center text-[11px] leading-tight font-medium text-zinc-200 ring-1 ring-white/[0.08] min-[1100px]:text-left"
          title={`Update v${update.version} installs as soon as VALORANT is closed`}
        >
          Update after <span className={wide}>the </span>game
        </span>
      )}
      <NavItem page={page} id="settings" label="Settings" Icon={SettingsIcon} onNavigate={onNavigate} />
      {!isDesktop && (
        <a className={`${item} ${idle}`} href="/" title="About CrossPOV">
          <Info size={19} strokeWidth={1.75} aria-hidden className="shrink-0" />
          <span className={wide}>About</span>
        </a>
      )}
    </nav>
  );
}
