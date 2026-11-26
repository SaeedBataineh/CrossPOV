import { Broadcast, FilmStrip, GearSix, House, Info, type Icon } from "@phosphor-icons/react";
import { isDesktop, type UpdateStatus } from "../lib/backend";
import { Logo } from "./Icons";

export type Page = "home" | "clips" | "streamers" | "settings";

const NAV: { id: Page; label: string; Icon: Icon }[] = [
  { id: "home", label: "Home", Icon: House },
  { id: "clips", label: "Clips", Icon: FilmStrip },
  { id: "streamers", label: "Streamers", Icon: Broadcast },
];

const item =
  "group relative flex w-[60px] flex-col items-center gap-1 rounded-xl border-0 bg-transparent py-2 text-[10.5px] font-semibold no-underline outline-none transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.95] focus-visible:ring-2 focus-visible:ring-[#3b9eff]";
const idle = "text-[#85858e] hover:bg-white/[0.05] hover:text-white";
const active = "bg-[#3b9eff]/[0.14] text-white";

function NavItem({ page, id, label, Icon, onNavigate }: { page: Page; id: Page; label: string; Icon: Icon; onNavigate: (p: Page) => void }) {
  const on = page === id;
  return (
    <button type="button" className={`${item} ${on ? active : idle}`} aria-current={on ? "page" : undefined} onClick={() => onNavigate(id)}>
      <Icon size={22} weight={on ? "fill" : "regular"} aria-hidden className={on ? "text-[#6ab7ff]" : undefined} />
      <span>{label}</span>
    </button>
  );
}

/** Medal-style thin sidebar: the mark at the top, the pages, and Settings at the bottom. */
export function Sidebar({ page, update, onNavigate }: { page: Page; update: UpdateStatus | null; onNavigate: (p: Page) => void }) {
  return (
    <nav aria-label="Main" className="flex min-h-0 w-[76px] flex-col items-center gap-1.5 overflow-y-auto border-r border-[#222225] bg-[#0f0f11] pt-3.5 pb-3">
      <span className="mb-3 grid size-11 place-items-center" title="CrossPOV">
        <Logo size={28} />
      </span>
      {NAV.map((n) => (
        <NavItem key={n.id} page={page} {...n} onNavigate={onNavigate} />
      ))}
      <span className="flex-1" />
      {update?.state === "waiting" && (
        <span
          className="mb-1 w-[60px] rounded-lg bg-[#3b9eff]/[0.12] px-1 py-1.5 text-center text-[10px] leading-tight font-semibold text-[#6ab7ff]"
          title={`Update v${update.version} installs as soon as VALORANT is closed`}
        >
          Update after game
        </span>
      )}
      <NavItem page={page} id="settings" label="Settings" Icon={GearSix} onNavigate={onNavigate} />
      {!isDesktop && (
        <a className={`${item} ${idle}`} href="/">
          <Info size={22} aria-hidden />
          <span>About</span>
        </a>
      )}
    </nav>
  );
}
