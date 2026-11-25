import { useEffect, useRef, useState } from "react";
import { clipVideoSrc, isDesktop, openClip, revealClip, type ClipInfo } from "../lib/backend";
import { cardMeta, cardTitle } from "./ui";

/** Plays a clip inside the app, over the page. MKV clips (and the website demo) open outside instead. */
export function Player({ clip, onClose, notify }: { clip: ClipInfo; onClose: () => void; notify: (text: string, tone: "bad") => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    clipVideoSrc(clip.path).then(
      (url) => {
        if (!alive) return;
        if (url) {
          setSrc(url);
          return;
        }
        // Can't play here: hand it to the computer's own player.
        openClip(clip.path).catch((err) => notify(String(err), "bad"));
        onClose();
      },
      (err) => {
        notify(String(err), "bad");
        onClose();
      },
    );
    return () => {
      alive = false;
    };
  }, [clip.path, onClose, notify]);

  useEffect(() => {
    closeRef.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  if (!src) return null;
  const outside = () => void openClip(clip.path).catch((err) => notify(String(err), "bad"));
  return (
    <div className="player-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="player" role="dialog" aria-modal="true" aria-label={cardTitle(clip)}>
        <video src={src} controls autoPlay playsInline>
          <track kind="captions" />
        </video>
        <div className="player-bar">
          <span className="grow stack" style={{ gap: 2, minWidth: 0 }}>
            <b className="ellipsis">{cardTitle(clip)}{clip.streamer ? ` · ${clip.streamer}` : ""}</b>
            <span className="muted small ellipsis">{cardMeta(clip)}</span>
          </span>
          <button type="button" className="btn quiet" onClick={outside}>Open in player</button>
          {isDesktop && <button type="button" className="btn quiet" onClick={() => void revealClip(clip.path).catch((err) => notify(String(err), "bad"))}>Show in folder</button>}
          <button ref={closeRef} type="button" className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
