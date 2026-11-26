import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type RefObject } from "react";
import { Select } from "./Select";
import { CornersOut, FastForward, Pause, Play, Rewind, Scissors, SpeakerHigh, SpeakerSlash } from "@phosphor-icons/react";
import { formatDuration } from "../lib/useRecorder";

/** A start and end in seconds. */
export interface Range {
  start: number;
  end: number;
}

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

/** "1:05.3": seconds with a tenth, for trim points. */
export const fine = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

// Phosphor glyphs, filled like a media player's.
const Icon = {
  play: <Play size={18} weight="fill" aria-hidden />,
  pause: <Pause size={18} weight="fill" aria-hidden />,
  back: <Rewind size={18} weight="fill" aria-hidden />,
  fwd: <FastForward size={18} weight="fill" aria-hidden />,
  sound: <SpeakerHigh size={18} weight="fill" aria-hidden />,
  muted: <SpeakerSlash size={18} weight="fill" aria-hidden />,
  full: <CornersOut size={18} weight="bold" aria-hidden />,
  cut: <Scissors size={18} weight="bold" aria-hidden />,
};

/**
 * CrossPOV's own player controls for a <video>: a timeline with the fights
 * marked on it (and, while cutting, the part to keep), play/skip, speed,
 * volume, fullscreen, and keyboard shortcuts:
 * Space/K play, J/L ±10 s, ←/→ ±5 s, F fullscreen, M mute, I/O cut start/end.
 */
export function PlayerControls({
  video,
  box,
  fallbackDuration,
  marks,
  trim,
  onTrim,
  canTrim,
}: {
  video: RefObject<HTMLVideoElement | null>;
  /** What goes fullscreen. */
  box: RefObject<HTMLElement | null>;
  fallbackDuration: number;
  marks: number[];
  /** The part to keep while cutting; null when not cutting. */
  trim: Range | null;
  onTrim?: (r: Range | null) => void;
  canTrim?: boolean;
}) {
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(fallbackDuration);
  const [paused, setPaused] = useState(true);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<null | "seek" | "start" | "end">(null);
  const trimRef = useRef(trim);
  trimRef.current = trim;

  // Follow the video: time (smoothly while playing), length, play state, speed, sound.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    let frame = 0;
    let last = v.currentTime;
    const tick = () => {
      const t = v.currentTime;
      // While cutting, playback stops at the end of the part to keep.
      const r = trimRef.current;
      if (r && last < r.end && t >= r.end && !v.paused) v.pause();
      last = t;
      setTime(t);
      if (!v.paused) frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      setPaused(v.paused);
      setRate(v.playbackRate);
      setVolume(v.volume);
      setMuted(v.muted);
      if (Number.isFinite(v.duration) && v.duration > 0) setDur(v.duration);
      cancelAnimationFrame(frame);
      tick();
    };
    const events = ["play", "pause", "seeked", "timeupdate", "ratechange", "volumechange", "loadedmetadata", "durationchange"];
    events.forEach((e) => v.addEventListener(e, sync));
    sync();
    return () => {
      cancelAnimationFrame(frame);
      events.forEach((e) => v.removeEventListener(e, sync));
    };
  }, [video]);

  const seek = useCallback(
    (t: number) => {
      const v = video.current;
      if (v) v.currentTime = Math.max(0, Math.min(t, (Number.isFinite(v.duration) ? v.duration : dur) - 0.05));
    },
    [video, dur],
  );
  const toggle = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      const r = trimRef.current;
      // Playing from the end of the cut starts it over.
      if (r && (v.currentTime >= r.end - 0.05 || v.currentTime < r.start)) v.currentTime = r.start;
      void v.play().catch(() => {});
    } else v.pause();
  }, [video]);
  const fullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.current?.requestFullscreen?.();
  }, [box]);

  const setStart = useCallback((t: number) => {
    const r = trimRef.current;
    if (r) onTrim?.({ start: Math.max(0, Math.min(t, r.end - 0.5)), end: r.end });
  }, [onTrim]);
  const setEnd = useCallback((t: number) => {
    const r = trimRef.current;
    if (r) onTrim?.({ start: r.start, end: Math.min(dur, Math.max(t, r.start + 0.5)) });
  }, [onTrim, dur]);

  // Keyboard shortcuts, unless you're typing somewhere.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable='true']") || e.ctrlKey || e.metaKey || e.altKey) return;
      const v = video.current;
      if (!v) return;
      const k = e.key.toLowerCase();
      const act: Record<string, () => void> = {
        " ": toggle,
        k: toggle,
        j: () => seek(v.currentTime - 10),
        l: () => seek(v.currentTime + 10),
        arrowleft: () => seek(v.currentTime - 5),
        arrowright: () => seek(v.currentTime + 5),
        f: fullscreen,
        m: () => (v.muted = !v.muted),
        i: () => setStart(v.currentTime),
        o: () => setEnd(v.currentTime),
        escape: () => onTrim?.(null),
      };
      if (k === "escape" && !trimRef.current) return; // Not cutting: Escape is the viewer's (back).
      if ((k === "i" || k === "o") && !trimRef.current) return;
      const f = act[k];
      if (!f) return;
      // A focused button already handles Space itself.
      if (k === " " && el?.closest("button")) return;
      e.preventDefault();
      f();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [video, toggle, seek, fullscreen, setStart, setEnd, onTrim]);

  // Timeline: click or drag to seek; drag the cut handles.
  const at = (e: RPointerEvent) => {
    const r = track.current?.getBoundingClientRect();
    return r ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur : 0;
  };
  const down = (what: "seek" | "start" | "end") => (e: RPointerEvent) => {
    e.stopPropagation();
    drag.current = what;
    track.current?.setPointerCapture(e.pointerId);
    move(e);
  };
  const move = (e: RPointerEvent) => {
    const t = at(e);
    if (drag.current === "seek") seek(t);
    else if (drag.current === "start") {
      setStart(t);
      seek(t);
    } else if (drag.current === "end") {
      setEnd(t);
      seek(t);
    }
  };
  const up = () => (drag.current = null);
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / (dur || 1)) * 100))}%`;

  return (
    <div className="pc">
      <div
        className={trim ? "pc-track cutting" : "pc-track"}
        ref={track}
        onPointerDown={down("seek")}
        onPointerMove={(e) => drag.current && move(e)}
        onPointerUp={up}
        onPointerCancel={up}
        role="slider"
        aria-label="Position"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(time)}
        aria-valuetext={`${formatDuration(time)} of ${formatDuration(dur)}`}
        tabIndex={0}
      >
        <div className="pc-rail" />
        {trim && <div className="pc-keep" style={{ left: pct(trim.start), width: `calc(${pct(trim.end)} - ${pct(trim.start)})` }} />}
        <div className="pc-played" style={{ width: pct(time) }} />
        {marks.map((t, i) => (
          <button
            key={i}
            type="button"
            className="pc-mark"
            style={{ left: pct(t) }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => seek(t - 3)}
            title={`Fight at ${formatDuration(t)}`}
            aria-label={`Jump to the fight at ${formatDuration(t)}`}
          />
        ))}
        {trim && (
          <>
            <button type="button" className="pc-handle start" style={{ left: pct(trim.start) }} onPointerDown={down("start")} aria-label={`Cut start ${fine(trim.start)}`} title="Drag: where the cut starts (I)" />
            <button type="button" className="pc-handle end" style={{ left: pct(trim.end) }} onPointerDown={down("end")} aria-label={`Cut end ${fine(trim.end)}`} title="Drag: where the cut ends (O)" />
          </>
        )}
        <div className="pc-head" style={{ left: pct(time) }} />
      </div>

      <div className="pc-bar">
        <button type="button" className="pc-btn" onClick={toggle} aria-label={paused ? "Play" : "Pause"} title={paused ? "Play (Space)" : "Pause (Space)"}>{paused ? Icon.play : Icon.pause}</button>
        <button type="button" className="pc-btn" onClick={() => seek(time - 5)} aria-label="Back 5 seconds" title="Back 5 s (←)">{Icon.back}</button>
        <button type="button" className="pc-btn" onClick={() => seek(time + 5)} aria-label="Forward 5 seconds" title="Forward 5 s (→)">{Icon.fwd}</button>
        <span className="pc-time">{formatDuration(time)} <span>/ {formatDuration(dur)}</span></span>
        <span className="spacer" />
        <Select
          label="Speed"
          className="pc-speed"
          value={rate}
          onChange={(v) => { if (video.current) video.current.playbackRate = v; }}
          options={SPEEDS.map((s) => ({ value: s, label: `${s}×` }))}
        />
        <button type="button" className="pc-btn" onClick={() => { if (video.current) video.current.muted = !video.current.muted; }} aria-label={muted ? "Unmute" : "Mute"} title="Mute (M)">{muted || volume === 0 ? Icon.muted : Icon.sound}</button>
        <input
          className="pc-vol"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          aria-label="Volume"
          onChange={(e) => {
            const v = video.current;
            if (!v) return;
            v.volume = Number(e.target.value);
            v.muted = v.volume === 0;
          }}
        />
        {canTrim && onTrim && (
          <button
            type="button"
            className={trim ? "pc-btn on" : "pc-btn"}
            aria-pressed={Boolean(trim)}
            title="Cut this clip"
            onClick={() => {
              if (trim) return onTrim(null);
              // Start around the fight(s), else the whole clip.
              const first = marks.length ? Math.min(...marks) : 0;
              const last = marks.length ? Math.max(...marks) : dur;
              onTrim(marks.length ? { start: Math.max(0, first - 5), end: Math.min(dur, last + 5) } : { start: 0, end: dur });
            }}
          >
            {Icon.cut}
            <span>Cut</span>
          </button>
        )}
        <button type="button" className="pc-btn" onClick={fullscreen} aria-label="Fullscreen" title="Fullscreen (F)">{Icon.full}</button>
      </div>
    </div>
  );
}
