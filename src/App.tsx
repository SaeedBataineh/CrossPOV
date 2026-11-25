import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { TopBar, type Page } from "./components/Shell";
import { Notice, ToastView } from "./components/ui";
import { UpdateGate, useUpdateStatus } from "./components/UpdateGate";
import { isDesktop, loadSettings, saveSettings } from "./lib/backend";
import { DEFAULT_SETTINGS, type Settings } from "./lib/settings";
import { useMatches } from "./lib/useMatches";
import { useRecorder } from "./lib/useRecorder";
import Clips from "./pages/Clips";

// Only Clips ships in the first chunk; the other screens load when opened.
const Matches = lazy(() => import("./pages/Matches"));
const Streamers = lazy(() => import("./pages/Streamers"));
const SettingsPage = lazy(() => import("./pages/Settings"));

export default function App() {
  const [page, setPage] = useState<Page>("clips");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const recorder = useRecorder();
  const matchesState = useMatches();
  const update = useUpdateStatus();
  /** While updating, the app behind the update screen can't be clicked or tabbed into. */
  const blocked = Boolean(update && !["upToDate", "waiting"].includes(update.state));
  const status = recorder.status;

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
        page={page}
        settings={settings}
        status={status}
        onNavigate={setPage}
        onSaving={() => recorder.notify("Saving clip…", "info")}
        update={update}
      />
      <main className="main">
        {!isDesktop && (
          <p className="notice info s12" role="note">
            <b>Website demo with sample data.</b> Recording, playing clips and downloading streamer clips need the Windows app. The
            Matches page can look up a real match. <a href="/">About CrossPOV</a>
          </p>
        )}
        {loadError && <Notice tone="bad">Could not load settings, using defaults: {loadError}</Notice>}
        {status?.hotkeyError && <Notice tone="warn">{status.hotkeyError}</Notice>}
        {status?.audioWarning && <Notice tone="warn">{status.audioWarning}</Notice>}
        {status?.message && ["error", "noFfmpeg", "starting"].includes(status.state) && (
          <Notice tone={status.state === "starting" ? "info" : "bad"}>{status.message}</Notice>
        )}
        {isDesktop && !settings.riotId && page !== "settings" && (
          <Notice tone="warn">
            Add your Riot ID so CrossPOV can find streamers in your matches.{" "}
            <button type="button" className="linkish" onClick={() => setPage("settings")}>Open Settings</button>
          </Notice>
        )}
        <Suspense fallback={<p className="muted s12">Loading…</p>}>
          {page === "clips" && <Clips settings={settings} recorder={recorder} />}
          {page === "matches" && <Matches settings={settings} matchesState={matchesState} recorder={recorder} onNavigate={setPage} />}
          {page === "streamers" && <Streamers settings={settings} recorder={recorder} matchesState={matchesState} quickSave={quickSave} onNavigate={setPage} />}
          {page === "settings" && <SettingsPage settings={settings} onSaved={setSettings} />}
        </Suspense>
      </main>
      <ToastView toast={recorder.toast} />
    </div>
    <UpdateGate status={update} />
    </>
  );
}
