import { useEffect, useState, type ReactNode } from "react";
import { appIcon, isDesktop, thumbSrc, type ClipInfo } from "../lib/backend";
import { Check, CircleAlert, CirclePlay, FolderOpen, Info, Play, Trash2, TriangleAlert } from "lucide-react";
import { TwitchIcon } from "./Icons";
import { AgentIcon, hasAgentArt } from "./ValorantArt";
import type { Draft } from "../lib/useDraft";
import { formatDuration, formatSize, timeAgo, type Toast } from "../lib/useRecorder";

/** A titled box. `color` is the small square before the title. */
export function Panel({
  title,
  color = "#e8e8e8",
  right,
  className = "",
  children,
}: {
  title: string;
  color?: string;
  right?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={`panel ${className}`} aria-label={title}>
      <div className="ph">
        <span className="pt"><i style={{ background: color }} />{title}</span>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Notice({ tone, children }: { tone: "warn" | "bad" | "info"; children: ReactNode }) {
  return (
    <p className={`notice s12 ${tone === "warn" ? "" : tone}`} role={tone === "info" ? "status" : "alert"}>
      <NoticeIcon tone={tone} />
      <span>{children}</span>
    </p>
  );
}

/** The icon that leads a notice: an error, a warning, or plain information. */
export function NoticeIcon({ tone }: { tone: "warn" | "bad" | "info" }) {
  const Icon = tone === "bad" ? CircleAlert : tone === "warn" ? TriangleAlert : Info;
  return <Icon size={16} strokeWidth={1.75} aria-hidden />;
}

/** Plain text with every number in it set in Geist Mono ("R14", "37 min", "1/2", "9:00"). */
export function Nums({ children }: { children: string }) {
  return <>{children.split(/(\d+(?:[:./,]\d+)*)/).map((part, i) => (i % 2 ? <span key={i} className="nm">{part}</span> : part))}</>;
}

export function Stat({ label, value, purple }: { label: string; value: ReactNode; purple?: boolean }) {
  return (
    <div className={purple ? "stat purple" : "stat"}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

/** Segmented single choice, e.g. 30 | 60 | 120. */
export function Seg<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="tg" disabled={disabled} onClick={() => onChange(!checked)} />;
}

/** One settings line: label and help on the left, control on the right. */
export function Row({ label, help, icon, children }: { label: string; help?: ReactNode; icon?: ReactNode; children?: ReactNode }) {
  const text = (
    <span>
      <b>{label}</b>
      {help && <small>{help}</small>}
    </span>
  );
  return (
    <div className="sr">
      {icon ? <span className="row" style={{ gap: 10, minWidth: 0 }}>{icon}{text}</span> : text}
      {children}
    </div>
  );
}

/** A program's own icon (taken from its .exe), or its first letter on a plain tile until we have it. */
export function AppIcon({ exe, name }: { exe: string; name: string; color?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSrc(null);
    appIcon(exe).then((u) => live && setSrc(u));
    return () => {
      live = false;
    };
  }, [exe]);
  if (src) return <img className="src-ic app-ic" src={src} alt="" />;
  return <span className="src-ic" aria-hidden="true">{name[0]?.toUpperCase()}</span>;
}

/** 0-200 % volume slider. */
export function Volume({ label, value, onChange, disabled }: { label: string; value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <label className="volume">
      <span className="sr-only">{label} volume</span>
      <input type="range" min={0} max={200} step={5} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
      <span aria-hidden="true">{value}%</span>
    </label>
  );
}

export function ToastView({ toast }: { toast: Toast | null }) {
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toast && <div key={toast.id} className={`toast ${toast.tone}`}>{toast.text}</div>}
    </div>
  );
}

// ---------- Clips ----------

const isTheirs = (c: ClipInfo) => c.kind === "theirs";

export function clipTitle(c: ClipInfo): string {
  if (isTheirs(c) && c.streamer) return `vs ${c.streamer}${c.round ? ` · R${c.round}` : ""}`;
  return c.name.replace(/^Clip_/, "").replace(/_/g, " ");
}

export function clipMoment(c: ClipInfo): string {
  return isTheirs(c) ? (c.moment ?? "Streamer clip").toLowerCase() : "hotkey clip";
}

/** "HH:MM" for today, otherwise "3 days ago". */
export function clockOrAgo(ms: number): string {
  const d = new Date(ms);
  if (d.toDateString() === new Date().toDateString()) return d.toTimeString().slice(0, 5);
  return timeAgo(ms);
}

/** Short time for narrow columns: "14:32" today, otherwise "Mon". */
export function shortWhen(ms: number): string {
  const d = new Date(ms);
  if (d.toDateString() === new Date().toDateString()) return d.toTimeString().slice(0, 5);
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

export function ClipThumb({ clip, label, big }: { clip: ClipInfo; label?: string; big?: boolean }) {
  const src = thumbSrc(clip.thumb);
  return (
    <div className={isTheirs(clip) ? "thumb theirs" : "thumb"}>
      {src ? (
        <img src={src} alt="" loading="lazy" decoding="async" />
      ) : (
        <CirclePlay size={big ? 40 : 28} strokeWidth={1.75} aria-hidden />
      )}
      <span className="tag" style={big ? { fontSize: 10 } : undefined}>{label ?? (isTheirs(clip) ? "THEM" : "YOU")}</span>
      {clip.durationSec != null && <span className="len">{formatDuration(clip.durationSec)}</span>}
    </div>
  );
}

export function ClipCard({ clip, selected, onSelect, onOpen }: { clip: ClipInfo; selected?: boolean; onSelect?: () => void; onOpen?: () => void }) {
  return (
    <button
      type="button"
      className={isTheirs(clip) ? "clip-card theirs" : "clip-card"}
      aria-pressed={selected}
      onClick={onSelect}
      onDoubleClick={onOpen}
      title={onOpen ? "Double-click to play" : undefined}
    >
      <ClipThumb clip={clip} />
      <span className="meta">
        <b className="ellipsis">{clipTitle(clip)}</b>
        <span className="what">{clipMoment(clip)}</span>
        <span className="where"><span className="ellipsis">{[clip.map, clockOrAgo(clip.createdMs)].filter(Boolean).join(" · ")}</span><span>{formatSize(clip.sizeBytes)}</span></span>
      </span>
    </button>
  );
}

// ---------- Gallery ----------

/** Big, plain title for a clip card: what happened, not the file name. */
export function cardTitle(c: ClipInfo): string {
  if (!isTheirs(c)) return "Your clip";
  const m = c.moment ?? "Streamer clip";
  return m.charAt(0).toUpperCase() + m.slice(1);
}

/** "Ascent · R14 · 35 min ago", or "Apex Legends · 35 min ago" for other games. */
export function cardMeta(c: ClipInfo): string {
  return [c.map ?? c.game, c.round != null ? `R${c.round}` : null, timeAgo(c.createdMs)].filter(Boolean).join(" · ");
}

function Half({ clip }: { clip: ClipInfo }) {
  const src = thumbSrc(clip.thumb);
  return <span className={isTheirs(clip) ? "half theirs" : "half"}>{src && <img src={src} alt="" loading="lazy" decoding="async" />}</span>;
}

/**
 * A clip in a grid: click to open it. With `other` (the other side of the same
 * fight) the thumbnail is split: YOU on the left, THEM on the right.
 * Folder and delete appear on hover.
 */
export function GalleryCard({ clip, other, title, meta, onPlay, onReveal, onDelete }: {
  clip: ClipInfo;
  other?: ClipInfo;
  title?: string;
  meta?: string;
  onPlay: () => void;
  onReveal?: () => void;
  onDelete?: () => void;
}) {
  const src = thumbSrc(clip.thumb);
  const t = title ?? cardTitle(clip);
  const mine = isTheirs(clip) ? other : clip;
  const theirs = isTheirs(clip) ? clip : other;
  const both = Boolean(mine && theirs);
  return (
    <div className="gcard">
      <button type="button" className={both ? "gthumb split" : isTheirs(clip) ? "gthumb theirs" : "gthumb"} onClick={onPlay} aria-label={`Open ${t}`}>
        {both ? (
          <>
            <Half clip={mine!} />
            <Half clip={theirs!} />
          </>
        ) : src ? (
          <img src={src} alt="" loading="lazy" decoding="async" />
        ) : (
          <CirclePlay size={32} strokeWidth={1.75} color="#a1a1aa" aria-hidden />
        )}
        <span className="hover-play" aria-hidden="true"><Play size={20} fill="currentColor" strokeWidth={0} /></span>
        {mine && <span className="tag you">YOU</span>}
        {theirs && <span className="tag them"><TwitchIcon size={11} />{both ? "THEM" : theirs.streamer ?? "THEM"}</span>}
        {clip.durationSec != null && <span className="len">{formatDuration(clip.durationSec)}</span>}
      </button>
      {(onReveal || onDelete) && (
        <span className="gactions">
          {onReveal && <button type="button" className="icon-btn sm" aria-label={`Show ${t} in folder`} title="Show in folder" onClick={onReveal}><FolderOpen size={16} strokeWidth={1.75} aria-hidden /></button>}
          {onDelete && <button type="button" className="icon-btn sm" aria-label={`Delete ${t}`} title="Delete" onClick={onDelete}><Trash2 size={16} strokeWidth={1.75} aria-hidden /></button>}
        </span>
      )}
      <b className="gtitle"><Nums>{t}</Nums></b>
      <span className="gmeta"><Nums>{meta ?? cardMeta(clip)}</Nums></span>
    </div>
  );
}

/** A card-sized placeholder in a clip grid (downloading, not available...). */
export function PendingCard({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <div className="gcard">
      <div className="gthumb pending">{children}</div>
      <b className="gtitle"><Nums>{title}</Nums></b>
      {meta && <span className="gmeta"><Nums>{meta}</Nums></span>}
    </div>
  );
}

/** "Saved automatically", or what saving is doing right now. */
export function SaveState({ d }: { d: Draft }) {
  const bad = d.status.startsWith("Could not");
  return (
    <span className={bad ? "save-state bad" : "save-state"} role="status">
      {!bad && !d.saving && (
        <Check size={14} strokeWidth={1.75} color="var(--win)" aria-hidden />
      )}
      {d.saving || d.dirty ? "Saving…" : bad ? d.status : "Saved automatically"}
    </span>
  );
}


/**
 * A streamer's picture, square: their Twitch picture (loaded through
 * crosspov.com, so your PC never contacts Twitch), else the agent they played,
 * else the Twitch mark on a plain tile. Never initials.
 */
export function Avatar({ avatar, agent, size = 36 }: { name?: string; avatar?: string | null; agent?: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };
  if (!avatar || failed) {
    if (agent && hasAgentArt(agent)) {
      return (
        <span className="avatar sq" style={{ ...style, overflow: "hidden" }} aria-hidden="true">
          <AgentIcon agent={agent} className="size-full" />
        </span>
      );
    }
    return (
      <span className="avatar sq" style={{ ...style, color: "var(--muted)" }} aria-hidden="true">
        <TwitchIcon size={Math.round(size * 0.45)} />
      </span>
    );
  }
  const base = isDesktop ? "https://crosspov.com" : "";
  return (
    <img
      className="avatar sq"
      style={style}
      src={`${base}/api/avatar?u=${encodeURIComponent(avatar)}`}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
