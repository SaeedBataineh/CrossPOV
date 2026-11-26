import { Clapperboard, House, Info, Radio, Settings as SettingsIcon, type LucideIcon } from "lucide-react";
import { isDesktop, type UpdateStatus } from "../lib/backend";
import { Logo } from "./Icons";

export type Page = "home" | "clips" | "streamers" | "settings";

const NAV: { id: Page; label: string; Icon: LucideIcon }[] = [
  { id: "home", label: "Home", Icon: House },
  { id: "clips", label: "Clips", Icon: Clapperboard },
  { id: "streamers", label: "Streamers", Icon: Radio },
];

const item =
  "group relative flex w-[68px] flex-col items-center justify-center gap-1 rounded-xl border-0 bg-transparent py-2.5 text-[11px] font-medium tracking-[-0.01em] no-underline transition-colors duration-200 ease-out outline-none focus-visible:ring-2 focus-visible:ring-white/60";
const idle = "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100";
const active = "bg-white/[0.08] text-white";

function NavItem({ page, id, label, Icon, onNavigate }: { page: Page; id: Page; label: string; Icon: LucideIcon; onNavigate: (p: Page) => void }) {
  const on = page === id;
  return (
    <button type="button" className={`${item} ${on ? active : idle}`} aria-current={on ? "page" : undefined} onClick={() => onNavigate(id)}>
      <Icon size={20} strokeWidth={on ? 2 : 1.75} aria-hidden />
      <span>{label}</span>
    </button>
  );
}

/** Floating frosted rail on the left: the pages, and Settings at the bottom. */
export function Sidebar({ page, update, onNavigate }: { page: Page; update: UpdateStatus | null; onNavigate: (p: Page) => void }) {
  return (
    <nav
      aria-label="Main"
      className="relative z-20 m-2.5 mr-0 flex min-h-0 flex-col items-center gap-1.5 overflow-y-auto rounded-[22px] border border-white/[0.08] bg-zinc-900/60 px-1.5 pt-4 pb-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_20px_40px_-20px_rgba(0,0,0,0.8)] backdrop-blur-2xl backdrop-saturate-150"
    >
      <span className="mb-4 grid size-11 place-items-center rounded-[14px] bg-gradient-to-b from-white/[0.10] to-white/[0.02] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] ring-1 ring-white/[0.06]" title="CrossPOV">
        <Logo size={26} />
      </span>
      {NAV.map((n) => (
        <NavItem key={n.id} page={page} {...n} onNavigate={onNavigate} />
      ))}
      <span className="flex-1" />
      {update?.state === "waiting" && (
        <span
          className="w-[68px] rounded-lg bg-white/[0.05] px-1.5 py-1.5 text-center text-[10.5px] leading-tight font-medium text-zinc-200 ring-1 ring-white/[0.08]"
          title={`Update v${update.version} installs as soon as VALORANT is closed`}
        >
          Update after game
        </span>
      )}
      <NavItem page={page} id="settings" label="Settings" Icon={SettingsIcon} onNavigate={onNavigate} />
      {!isDesktop && (
        <a className={`${item} ${idle}`} href="/">
          <Info size={20} strokeWidth={1.8} aria-hidden />
          <span>About</span>
        </a>
      )}
    </nav>
  );
}
