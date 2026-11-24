import { lazy, Suspense, useEffect, useState } from "react";
import { Sidebar, type Page } from "./components/Sidebar";
import { ToastView } from "./components/ui";
import { loadSettings } from "./lib/backend";
import { DEFAULT_SETTINGS, type Settings } from "./lib/settings";
import { useRecorder } from "./lib/useRecorder";
import Home from "./pages/Home";

// Only Home ships in the first chunk; the other screens load when opened.
const Clips = lazy(() => import("./pages/Clips"));
const Streamers = lazy(() => import("./pages/Streamers"));
const SettingsPage = lazy(() => import("./pages/Settings"));

export default function App() {
  const [page, setPage] = useState<Page>("home");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const recorder = useRecorder();

  useEffect(() => {
    loadSettings().then(setSettings, (err) => setLoadError(String(err)));
  }, []);

  return (
    <div className="app">
      <Sidebar page={page} onNavigate={setPage} />
      <main className="content">
        {loadError && (
          <p className="error-banner" role="alert">Could not load settings, using defaults: {loadError}</p>
        )}
        <Suspense fallback={<p className="muted">Loading…</p>}>
          {page === "home" && <Home settings={settings} recorder={recorder} onNavigate={setPage} />}
          {page === "clips" && <Clips recorder={recorder} />}
          {page === "streamers" && <Streamers />}
          {page === "settings" && <SettingsPage settings={settings} onSaved={setSettings} />}
        </Suspense>
      </main>
      <ToastView toast={recorder.toast} />
    </div>
  );
}
