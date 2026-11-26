import { lazy, StrictMode, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/figtree";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import App from "./App";
import { isDesktop, onWindowAwake } from "./lib/backend";

// The desktop app always shows the app. The public website shows the
// landing page at "/", the privacy policy at "/privacy", and the app itself
// (in demo mode) at "/demo".
const Landing = lazy(() => import("./site/Landing"));
const Privacy = lazy(() => import("./site/Privacy"));

/** The app, started afresh (fresh data) each time the window wakes from the tray. */
function DesktopApp() {
  const [wake, setWake] = useState(0);
  useEffect(() => {
    const off = onWindowAwake(() => setWake((n) => n + 1));
    return () => void off.then((f) => f());
  }, []);
  return <App key={wake} />;
}

function Root() {
  if (isDesktop) return <DesktopApp />;
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path.startsWith("/demo")) return <App />;
  if (path === "/privacy") return <Privacy />;
  return <Landing />;
}

// No browser right-click menu (Back, Reload, Inspect...) in the desktop app.
// Text boxes keep theirs so copy and paste still work.
if (isDesktop) {
  window.addEventListener("contextmenu", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t?.closest("input, textarea, [contenteditable='true']")) e.preventDefault();
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </StrictMode>,
);
