import { AnimatePresence, motion, type Transition } from "framer-motion";
import type { ReactNode } from "react";

/** Snappy ease-out used everywhere: 160–220 ms, no bounce. */
export const EASE = [0.16, 1, 0.3, 1] as const;
export const quick: Transition = { duration: 0.18, ease: EASE };
/** The sliding "you are here" block in tabs and side navigation. */
export const slide: Transition = { type: "tween", duration: 0.22, ease: EASE };

/** A page or view fading in: opacity 0 → 1, 4px up. Keyed by the caller. */
export function PageFade({ id, children }: { id: string; children: ReactNode }) {
  return (
    <motion.div
      data-view={id}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={quick}
      className="flex min-w-0 flex-col gap-5"
    >
      {children}
    </motion.div>
  );
}

/** Height-animated disclosure: grows from 0 to its content's height, and back. */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="body"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ height: { duration: 0.22, ease: EASE }, opacity: { duration: 0.16, ease: "easeOut" } }}
          className={`overflow-hidden ${className ?? ""}`}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
