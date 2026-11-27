import { useEffect, useRef, useState, type ReactNode } from "react";
import { appIcon, clipVideoSrc, copyForDiscord, isDesktop, shownMs, thumbSrc, type ClipInfo } from "../lib/backend";
import { Check, Clock, FolderOpen, GameController, Info, PencilSimple, Play, Star, Trash, Warning, WarningCircle } from "@phosphor-icons/react";
import { openContextMenu, type MenuItem } from "./ContextMenu";
import { promptDialog } from "./Dialog";
import { customTitle, setTitle, useTitles } from "../lib/titles";
import { toggleFavourite, useFavourites } from "../lib/favourites";
import { BrandLogo, brandFor } from "./Brand";
import { siDiscord } from "simple-icons";
import { TwitchIcon } from "./Icons";
import { Select } from "./Select";
import { AgentIcon, hasAgentArt, mapArt } from "./ValorantArt";
import type { Draft } from "../lib/useDraft";
import { formatDuration, formatSize, timeAgo, type Toast, type ToastAction } from "../lib/useRecorder";

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
      {tone === "bad" ? <WarningCircle size={18} weight="fill" aria-hidden /> : tone === "warn" ? <Warning size={18} weight="fill" aria-hidden /> : <Info size={18} weight="fill" aria-hidden />}
      <span>{children}</span>
    </p>
  );
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
  // Long lists (frame rate, clip length…) are a dropdown, like other clipping apps; short ones stay buttons.
  if (options.length > 3) return <Select label={label} value={value} options={options} onChange={onChange} />;
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
  return (
    <span className="tg-wrap">
      <span className={checked ? "tg-state on" : "tg-state"} aria-hidden="true">{checked ? "ON" : "OFF"}</span>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} className="tg" disabled={disabled} onClick={() => onChange(!checked)} />
    </span>
  );
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

/** A program's own icon (taken from its .exe), else its brand logo, else a game controller. */
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
  // A picture that won't load falls back to the brand logo or controller icon, never a broken image.
  if (src) return <img className="src-ic app-ic" src={src} alt="" onError={() => setSrc(null)} />;
  const brand = brandFor(exe) ?? brandFor(name);
  return <span className="src-ic" aria-hidden="true">{brand ? <BrandLogo icon={brand} size={18} /> : <GameController size={18} weight="duotone" />}</span>;
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

export function ToastView({ toast, onAct, onHold }: { toast: Toast | null; onAct?: (t: Toast, a: ToastAction) => void; onHold?: (held: boolean) => void }) {
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toast && (
        <div key={toast.id} className={`toast ${toast.tone}`} onPointerEnter={() => onHold?.(true)} onPointerLeave={() => onHold?.(false)}>
          <span className="toast-text">{toast.text}</span>
          {toast.actions?.length ? (
            <span className="toast-actions">
              {toast.actions.map((a) => (
                <button key={a.label} type="button" className="toast-btn" onClick={() => { onHold?.(false); onAct?.(toast, a); }}>{a.label}</button>
              ))}
            </span>
          ) : null}
        </div>
      )}
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
        <Play size={big ? 32 : 22} weight="fill" aria-hidden />
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
        <span className="where"><span className="ellipsis">{[clip.map, clockOrAgo(shownMs(clip))].filter(Boolean).join(" · ")}</span><span>{formatSize(clip.sizeBytes)}</span></span>
      </span>
    </button>
  );
}

// ---------- Gallery ----------

/** "21:14" today, otherwise "Mon 21:14" (this week) or "24 Nov 21:14". */
function clockLabel(ms: number): string {
  const d = new Date(ms);
  const time = d.toTimeString().slice(0, 5);
  const days = (Date.now() - ms) / 86_400_000;
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString(undefined, days < 6 ? { weekday: "short" } : { day: "numeric", month: "short" })} ${time}`;
}

/**
 * Big, plain title for a clip card: the name you gave it, else what happened
 * (streamer clips) or where and when (your clips: "Ascent · 21:14").
 */
export function cardTitle(c: ClipInfo): string {
  const own = customTitle(c.path);
  if (own) return own;
  if (!isTheirs(c)) return `${c.map ?? c.game ?? "Clip"} · ${clockLabel(shownMs(c))}${c.madeMs ? " · cut" : ""}`;
  const m = c.moment ?? "Streamer clip";
  return m.charAt(0).toUpperCase() + m.slice(1);
}

/** Asks for a new name for a clip; an empty name goes back to the automatic one. */
export async function renameClip(c: ClipInfo) {
  const name = await promptDialog({ title: "Rename clip", body: "Only the name in CrossPOV changes; the file keeps its name.", confirm: "Rename", value: cardTitle(c) });
  if (name !== null) setTitle(c.path, name);
}

/**
 * "Ascent · R14 · 35 min ago". Your own clips' titles already say where
 * ("VALORANT · 21:03"), so theirs leave it out ("35 min ago") unless renamed.
 */
export function cardMeta(c: ClipInfo): string {
  const where = isTheirs(c) || customTitle(c.path) ? c.map ?? c.game : null;
  return [where, c.round != null ? `R${c.round}` : null, timeAgo(shownMs(c))].filter(Boolean).join(" · ");
}

/** A clip's picture: its own thumbnail, else its map's art. */
export function clipPicture(c: ClipInfo): string | null {
  return picture(c);
}

function picture(c: ClipInfo): string | null {
  return thumbSrc(c.thumb) ?? mapArt(c.map);
}

function Half({ clip }: { clip: ClipInfo }) {
  const src = picture(clip);
  return <span className={isTheirs(clip) ? "half theirs" : "half"}>{src && <img src={src} alt="" loading="lazy" decoding="async" />}</span>;
}

/** Copies a Discord-sized version of the whole clip to the clipboard. True when it worked. */
export async function copyClipForDiscord(c: ClipInfo, notify: (text: string, tone: "good" | "bad" | "info") => void): Promise<boolean> {
  try {
    notify("Making a Discord-sized copy…", "info");
    const bytes = await copyForDiscord(c.path, 0, c.durationSec ?? 0);
    notify(`Copied (${formatSize(bytes)}). Paste it into Discord with Ctrl+V.`, "good");
    return true;
  } catch (err) {
    notify(String(err), "bad");
    return false;
  }
}

/**
 * A clip in a grid. The picture opens it; with `other` (the other side of the
 * same fight) the picture is split: YOU on the left, THEM on the right.
 * Star it, tick it to select several, or copy it for Discord.
 */
export function GalleryCard({ clip, other, title, meta, onPlay, onReveal, onDelete, selected, onSelect, notify }: {
  clip: ClipInfo;
  other?: ClipInfo;
  title?: string;
  meta?: string;
  onPlay: () => void;
  onReveal?: () => void;
  onDelete?: () => void;
  /** Selection (Clips page): ticked or not, and how to toggle it. */
  selected?: boolean;
  onSelect?: () => void;
  /** Shows "Copy for Discord" when given. */
  notify?: (text: string, tone: "good" | "bad" | "info") => void;
}) {
  const favs = useFavourites();
  const fav = favs.has(clip.path);
  const titles = useTitles();
  /** Copy for Discord: working, then a check for a moment once it's on the clipboard. */
  const [copy, setCopy] = useState<"idle" | "busy" | "done">("idle");
  async function copyIt() {
    if (!notify || copy === "busy") return;
    setCopy("busy");
    const ok = await copyClipForDiscord(clip, notify);
    setCopy(ok ? "done" : "idle");
    if (ok) setTimeout(() => setCopy("idle"), 1600);
  }
  const src = picture(clip);
  const t = titles[clip.path] ?? title ?? cardTitle(clip);
  const mine = isTheirs(clip) ? other : clip;
  const theirs = isTheirs(clip) ? clip : other;
  const both = Boolean(mine && theirs);

  // Hover preview: after a short rest on the picture, the clip plays silently.
  const [preview, setPreview] = useState<string | null>(null);
  const wait = useRef<ReturnType<typeof setTimeout>>(undefined);
  const startPreview = () => {
    if (!isDesktop) return;
    clearTimeout(wait.current);
    wait.current = setTimeout(() => {
      clipVideoSrc(clip.path).then((s) => s && setPreview(s), () => {});
    }, 450);
  };
  const stopPreview = () => {
    clearTimeout(wait.current);
    setPreview(null);
  };
  useEffect(() => () => clearTimeout(wait.current), []);

  const menu = (x: number, y: number) => {
    const items: MenuItem[] = [
      { label: "Open", icon: <Play size={15} weight="fill" />, run: onPlay },
      ...(onReveal ? [{ label: "Show in folder", icon: <FolderOpen size={15} />, run: onReveal }] : []),
      ...(notify && isDesktop ? [{ label: "Copy for Discord", icon: <BrandLogo icon={siDiscord} size={15} />, run: () => void copyIt() }] : []),
      { label: fav ? "Remove from favourites" : "Add to favourites", icon: <Star size={15} weight={fav ? "fill" : "regular"} />, run: () => toggleFavourite(clip.path), separator: true },
      { label: "Rename", icon: <PencilSimple size={15} />, run: () => void renameClip(clip) },
      ...(onDelete ? [{ label: "Delete", icon: <Trash size={15} />, run: onDelete, danger: true, separator: true }] : []),
    ];
    openContextMenu(x, y, items);
  };

  return (
    <div
      className={selected ? "gcard selected" : "gcard"}
      onContextMenu={(e) => {
        e.preventDefault();
        menu(e.clientX, e.clientY);
      }}
    >
      <div className="gpic" onPointerEnter={startPreview} onPointerLeave={stopPreview}>
        <button type="button" className={both ? "gthumb split" : isTheirs(clip) ? "gthumb theirs" : "gthumb"} onClick={onPlay} aria-label={`Open ${t}`}>
          {both ? (
            <>
              <Half clip={mine!} />
              <Half clip={theirs!} />
            </>
          ) : src ? (
            <img src={src} alt="" loading="lazy" decoding="async" />
          ) : (
            <Play size={26} weight="fill" color="rgba(255,255,255,0.55)" aria-hidden />
          )}
          {preview && <video className="gpreview" src={preview} muted autoPlay loop playsInline aria-hidden="true" onLoadedMetadata={(e) => { const v = e.currentTarget; if (v.duration > 8) v.currentTime = v.duration * 0.3; }} />}
          {!preview && <span className="hover-play" aria-hidden="true"><Play size={20} weight="fill" /></span>}
          {mine && <span className="tag you">YOU</span>}
          {theirs && <span className={both ? "tag them split" : "tag them"}><TwitchIcon size={11} />{both ? "THEM" : theirs.streamer ?? "THEM"}</span>}
          {clip.durationSec != null && <span className="len">{formatDuration(clip.durationSec)}</span>}
        </button>
        {onSelect && (
          <button type="button" role="checkbox" aria-checked={Boolean(selected)} aria-label={`Select ${t}`} className="gsel" onClick={onSelect}>
            {selected && <Check size={13} weight="bold" aria-hidden />}
          </button>
        )}
        <button type="button" className={fav ? "gstar on" : "gstar"} aria-pressed={fav} aria-label={fav ? `Unstar ${t}` : `Star ${t}`} title={fav ? "Remove from favourites" : "Add to favourites"} onClick={() => toggleFavourite(clip.path)}>
          <Star size={15} weight={fav ? "fill" : "bold"} aria-hidden />
        </button>
      </div>
      <div className="gbody">
        <span className="gtext">
          <b className="gtitle" title={t} onDoubleClick={() => void renameClip(clip)}>{t}</b>
          <span className="gmeta"><Clock size={13} aria-hidden />{meta ?? cardMeta(clip)}</span>
        </span>
        <span className="gbtns">
          {notify && (
            <button type="button" className={`gbtn discord ${copy}`} title="Copy for Discord" aria-label={`Copy ${t} for Discord`} aria-busy={copy === "busy"} onClick={() => void copyIt()}>
              {copy === "done" ? <Check size={16} weight="bold" aria-hidden /> : <BrandLogo icon={siDiscord} size={17} />}
            </button>
          )}
          {onReveal && <button type="button" className="gbtn" aria-label={`Show ${t} in folder`} title="Show in folder" onClick={onReveal}><FolderOpen size={16} aria-hidden /></button>}
          {onDelete && <button type="button" className="gbtn danger" aria-label={`Delete ${t}`} title="Delete" onClick={onDelete}><Trash size={16} aria-hidden /></button>}
        </span>
      </div>
    </div>
  );
}

/** A card-sized placeholder in a clip grid (downloading, not available...). */
export function PendingCard({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <div className="gcard">
      <div className="gpic"><div className="gthumb pending">{children}</div></div>
      <div className="gbody">
        <span className="gtext">
          <b className="gtitle">{title}</b>
          {meta && <span className="gmeta">{meta}</span>}
        </span>
      </div>
    </div>
  );
}

/** "Saved automatically", or what saving is doing right now. */
export function SaveState({ d }: { d: Draft }) {
  const bad = d.status.startsWith("Could not");
  return (
    <span className={bad ? "save-state bad" : "save-state"} role="status">
      {!bad && !d.saving && (
        <Check size={14} weight="bold" color="var(--win)" aria-hidden />
      )}
      {d.saving || d.dirty ? "Saving…" : bad ? d.status : "Saved automatically"}
    </span>
  );
}


/**
 * A streamer's picture: their Twitch picture (loaded through crosspov.com, so
 * your PC never contacts Twitch), else the agent they played, else their initials.
 */
export function Avatar({ name, avatar, agent, size = 36 }: { name?: string; avatar?: string | null; agent?: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };
  if (!avatar || failed) {
    if (agent && hasAgentArt(agent)) {
      return (
        <span className="avatar sq art" style={style} aria-hidden="true">
          <AgentIcon agent={agent} className="size-full" />
        </span>
      );
    }
    return (
      <span className="avatar sq initials" style={{ ...style, fontSize: Math.round(size * 0.38) }} aria-hidden="true">
        {(name ?? "?").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase() || "?"}
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
