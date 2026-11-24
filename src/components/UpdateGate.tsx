import { useEffect, useState } from "react";
import { onUpdateStatus, retryUpdate, updateStatus, type UpdateStatus } from "../lib/backend";
import { Logo } from "./Icons";

const mb = (n: number) => `${(n / 1024 ** 2).toFixed(1)} MB`;

/** Live update state from the backend. */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    updateStatus().then((s) => alive && setStatus(s), () => alive && setStatus({ state: "upToDate", offline: true }));
    onUpdateStatus(setStatus).then((u) => (alive ? (off = u) : u()));
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return status;
}

/**
 * Covers the whole app while it checks for, downloads or installs an update,
 * so an old version can't be used. Lets the user in once it's up to date (or
 * the check couldn't reach the internet).
 */
export function UpdateGate({ status }: { status: UpdateStatus | null }) {
  if (!status || status.state === "upToDate" || status.state === "waiting") return null;

  let title = "Checking for updates…";
  let detail = "This only takes a moment.";
  let pct: number | null = null;
  if (status.state === "downloading") {
    title = `Updating to v${status.version}`;
    pct = status.total ? Math.min(100, (status.downloaded / status.total) * 100) : null;
    detail = status.total ? `${mb(status.downloaded)} of ${mb(status.total)}` : `${mb(status.downloaded)} downloaded`;
  } else if (status.state === "installing") {
    title = `Installing v${status.version}`;
    detail = "CrossPOV restarts by itself in a few seconds.";
    pct = 100;
  } else if (status.state === "failed") {
    title = status.version ? `Couldn't install v${status.version}` : "Couldn't update CrossPOV";
    detail = status.message;
  }

  return (
    <div className="update-gate" role="alertdialog" aria-modal="true" aria-labelledby="update-title" aria-describedby="update-detail">
      <div className="update-box">
        <Logo size={40} />
        <h2 id="update-title">{title}</h2>
        <p id="update-detail" className="muted">{detail}</p>
        {status.state !== "failed" && (
          <div className="bar update-bar">
            <i className={pct == null ? "indeterminate" : undefined} style={pct == null ? undefined : { width: `${pct}%` }} />
          </div>
        )}
        {status.state === "failed" && (
          <>
            <p className="small muted">CrossPOV needs the latest version to work. Check your internet connection and try again.</p>
            <button type="button" className="b r" onClick={() => void retryUpdate()}>Try again</button>
          </>
        )}
        <span className="m tiny dim">current version v{__APP_VERSION__}</span>
      </div>
    </div>
  );
}
