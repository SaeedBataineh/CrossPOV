import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Rail, TopBar, type Page } from "./components/Shell";
import { Notice, ToastView } from "./components/ui";
import { UpdateGate, useUpdateStatus } from "./components/UpdateGate";
import { isDesktop, loadSettings, saveSettings } from "./lib/backend";
import { DEFAULT_SETTINGS, type Settings } from "./lib/settings";
import { useMatches } from "./lib/useMatches";
import { useRecorder } from "./lib/useRecorder";
import Home from "./pages/Home";

// Only Home ships in the first chunk; the other screens load when opened.
const Clips = lazy(() => import("./pages/Clips"));
const Matches = lazy(() => import("./pages/Matches"));
const Streamers = lazy(() => import("./pages/Streamers"));
const Audio = lazy(() => import("./pages/Audio"));
const SettingsPage = lazy(() => import("./pages/Settings"));

export default function App() {
  const [page, setPage] = useState<Page>("home");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const recorder = useRecorder();
  const matchesState = useMatches();
  const update = useUpdateStatus();
  /** While updating, the app behind the update screen can't be clicked or tabbed into. */
  const blocked = Boolean(update && !["upToDate", "waiting"].includes(update.state));

  useEffect(() => {
    loadSettings().then(setSettings, (err) => setLoadError(String(err)));
  }, []);

  /** Saves a few settings at once, for quick switches outside the Settings page. */
  const quickSave = useCallback(
    async (patch: Partial<Settings>) => {
      try {
        setSettings(await saveSettings({ ...settings, ...patch }));
      } catch (err) {
        recorder.notify(`Could not save: ${String(err)}`, "bad");
      }
    },
    [settings, recorder],
  );

  return (
    <>
    <div className="app" inert={blocked}>
      <TopBar
        settings={settings}
        status={recorder.status}
        query={query}
        onQuery={setQuery}
        onNavigate={setPage}
        onSaving={() => recorder.notify("Saving clip…", "info")}
        update={update}
      />
      <div className="body">
        <Rail page={page} onNavigate={setPage} />
        <main className="main">
          {!isDesktop && (
            <p className="notice info s12" role="note">
              <b>Website demo with sample data.</b> Recording, playing clips and downloading streamer clips need the Windows app. The
              Matches page can look up a real match. <a href="/">About CrossPOV</a>
            </p>
          )}
          {loadError && <Notice tone="bad">Could not load settings, using defaults: {loadError}</Notice>}
          <Suspense fallback={<p className="muted s12">Loading…</p>}>
            {page === "home" && <Home settings={settings} recorder={recorder} matchesState={matchesState} onNavigate={setPage} />}
            {page === "clips" && <Clips settings={settings} recorder={recorder} query={query} onQuery={setQuery} />}
            {page === "matches" && <Matches settings={settings} matchesState={matchesState} onNavigate={setPage} />}
            {page === "streamers" && <Streamers settings={settings} recorder={recorder} matchesState={matchesState} quickSave={quickSave} onNavigate={setPage} />}
            {page === "audio" && <Audio settings={settings} onSaved={setSettings} />}
            {page === "settings" && <SettingsPage settings={settings} onSaved={setSettings} />}
          </Suspense>
        </main>
      </div>
      <ToastView toast={recorder.toast} />
    </div>
    <UpdateGate status={update} />
    </>
  );
}
