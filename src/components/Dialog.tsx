import { useEffect, useRef, useState, type FormEvent } from "react";

/**
 * The app's own confirm and rename boxes, instead of the browser's grey
 * window.confirm / prompt. Call `confirmDialog` or `promptDialog` from
 * anywhere; <DialogHost /> (mounted once in App) draws them.
 */

interface Request {
  title: string;
  body?: string;
  confirm: string;
  /** Red confirm button, for things that can't be taken back. */
  danger?: boolean;
  /** Prompt only: the text box's starting value. */
  value?: string;
  prompt: boolean;
  resolve: (v: string | null) => void;
}

let open: ((r: Request) => void) | null = null;

function ask(r: Omit<Request, "resolve">): Promise<string | null> {
  return new Promise((resolve) => {
    if (!open) return resolve(r.prompt ? null : window.confirm(r.title) ? "" : null);
    open({ ...r, resolve });
  });
}

/** True when the person confirms. */
export async function confirmDialog(o: { title: string; body?: string; confirm: string; danger?: boolean }): Promise<boolean> {
  return (await ask({ ...o, prompt: false })) !== null;
}

/** The new text, or null when cancelled. */
export function promptDialog(o: { title: string; body?: string; confirm: string; value: string }): Promise<string | null> {
  return ask({ ...o, prompt: true });
}

export function DialogHost() {
  const [req, setReq] = useState<Request | null>(null);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const ok = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    open = (r) => {
      setText(r.value ?? "");
      setReq(r);
    };
    return () => {
      open = null;
    };
  }, []);

  useEffect(() => {
    if (!req) return;
    const back = document.activeElement as HTMLElement | null;
    if (req.prompt) input.current?.select();
    else ok.current?.focus();
    return () => back?.focus?.();
  }, [req]);

  if (!req) return null;
  const done = (v: string | null) => {
    setReq(null);
    req.resolve(v);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (req.prompt && !text.trim()) return;
    done(req.prompt ? text.trim() : "");
  };

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && done(null)}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            done(null);
          }
        }}
      >
        <h2 id="dialog-title">{req.title}</h2>
        {req.body && <p>{req.body}</p>}
        {req.prompt && (
          <input ref={input} className="dialog-input" value={text} onChange={(e) => setText(e.target.value)} maxLength={80} spellCheck={false} aria-label={req.title} />
        )}
        <div className="dialog-buttons">
          <button type="button" className="btn" onClick={() => done(null)}>Cancel</button>
          <button ref={ok} type="submit" className={req.danger ? "btn danger-fill" : "btn primary"} disabled={req.prompt && !text.trim()}>{req.confirm}</button>
        </div>
      </form>
    </div>
  );
}
