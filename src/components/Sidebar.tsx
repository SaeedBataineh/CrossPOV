import type { ReactNode } from "react";
import { isDesktop } from "../lib/backend";
import { ClipsIcon, GearIcon, HomeIcon, Logo, StreamIcon } from "./Icons";

export type Page = "home" | "clips" | "streamers" | "settings";

const ITEMS: { id: Page; label: string; icon: ReactNode }[] = [
  { id: "home", label: "Home", icon: <HomeIcon /> },
  { id: "clips", label: "Clips", icon: <ClipsIcon /> },
  { id: "streamers", label: "Streamer matches", icon: <StreamIcon /> },
  { id: "settings", label: "Settings", icon: <GearIcon /> },
];

export function Sidebar({ page, onNavigate }: { page: Page; onNavigate: (p: Page) => void }) {
  return (
    <nav className="sidebar" aria-label="Main">
      <div className="brand">
        <Logo size={24} />
        <span>CrossPOV</span>
      </div>
      {ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className="nav-item"
          aria-current={page === item.id ? "page" : undefined}
          onClick={() => onNavigate(item.id)}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
      <div className="sidebar-foot">
        {!isDesktop && (
          <p style={{ margin: "0 0 8px" }}>
            Website demo · <a href="/">About CrossPOV</a>
          </p>
        )}
        v{__APP_VERSION__} · Not endorsed by Riot Games
      </div>
    </nav>
  );
}
