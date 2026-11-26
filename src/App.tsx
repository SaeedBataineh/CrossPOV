import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import "@fontsource-variable/figtree";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { Rail, TopBar, type Page } from "./components/Shell";
import { Notice, ToastView } from "./components/ui";
import { UpdateGate, useUpdateStatus } from "./components/UpdateGate";
import { isDesktop, loadSettings, saveSettings, type ClipInfo } from "./lib/backend";
import { same } from "./lib/riotId";
import { DEFAULT_SETTINGS, REGIONS, type Settings } from "./lib/settings";
import { useMatches } from "./lib/useMatches";
import { useRecorder } from "./lib/useRecorder";
import Home from "./pages/Home";

// Home ships in the first chunk; the other screens load when opened.
const Clips = lazy(() => import("./pages/Clips"));
const Streamers = lazy(() => import("./pages/Streamers"));
const SettingsPage = lazy(() => import("./pages/Settings"));
const Viewer = lazy(() => import("./pages/Viewer"));

const PAGES: Page[] = ["home", "clips", "streamers", "settings"];

export default function App() {
  // Remembered for this session, so waking the window from the tray keeps your place.
  const [page, setPageState] = useState<Page>(() => {
    try {
      const saved = sessionStorage.getItem("page");
      return PAGES.includes(saved as Page) ? (saved as Page) : "home";
    } catch {
      return "home";
    }
  });
  /** The clip open in the viewer, over whichever page you came from. */
  const [viewing, setViewing] = useState<ClipInfo | null>(null);
  const setPage = useCallback((p: Page) => {
    setPageState(p);
    setViewing(null);
    try {
      sessionStorage.setItem("page", p);
    } catch {
      /* not remembered: fine */
    }
  }, []);
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const recorder = useRecorder();
  const matchesState = useMatches();
  const update = useUpdateStatus();
  /** While updating, the app behind the update screen can't be clicked or tabbed into. */
  const blocked = Boolean(update && !["upToDate", "waiting"].includes(update.state));
  const status = recorder.status;
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    loadSettings().then(setSettings, (err) => setLoadError(String(err)));
  }, []);

  // A new page or clip starts at the top.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [page, viewing]);

  const { reload } = matchesState;
  const riotId = useRef(settings.riotId);
  riotId.current = settings.riotId;
  const onSaved = useCallback(
    (s: Settings) => {
      // Another Riot account: the backend cleared the old one's matches.
      if (riotId.current.trim() && !same(riotId.current, s.riotId)) reload();
      setSettings(s);
    },
    [reload],
  );

  const closeViewer = useCallback(() => setViewing(null), []);
  const search = !viewing && page === "home" ? "Search maps, agents, players, streamers" : !viewing && page === "clips" ? "Search clips" : undefined;
  const title = viewing ? undefined : page === "streamers" ? "Streamers you played against" : page === "settings" ? "Settings" : undefined;

  return (
    <>
    <div className="app" inert={blocked}>
      <Rail page={page} update={update} onNavigate={setPage} />
      <div className="frame">
        <TopBar
          settings={settings}
          status={status}
          query={query}
          onQuery={setQuery}
          searchLabel={search}
          title={title}
          onSaving={() => recorder.notify("Saving clip…", "info")}
          onIgnore={(exe) => {
            const next = { ...settings, ignoredGames: [...settings.ignoredGames, exe] };
            saveSettings(next).then(onSaved, (err) => recorder.notify(`Could not save: ${String(err)}`, "bad"));
          }}
        />
        <main className="main" ref={mainRef}>
          {!isDesktop && (
            <p className="notice info" role="note">
              <b>Website demo with sample data.</b> Recording and streamer clips need the Windows app. <a href="/">About CrossPOV</a>
            </p>
          )}
          {loadError && <Notice tone="bad">Could not load settings, using defaults: {loadError}</Notice>}
          {status?.hotkeyError && <Notice tone="warn">{status.hotkeyError}</Notice>}
          {status?.audioWarning && <Notice tone="warn">{status.audioWarning}</Notice>}
          {status?.message && ["error", "noFfmpeg", "starting"].includes(status.state) && (
            <Notice tone={status.state === "starting" ? "info" : "bad"}>{status.message}</Notice>
          )}
          {matchesState.status?.regionHint && matchesState.status.regionHint !== settings.region && (
            <Notice tone="info">
              Your matches are played in {REGIONS.find((r) => r.value === matchesState.status?.regionHint)?.label ?? matchesState.status.regionHint}, but your region in Settings is{" "}
              {REGIONS.find((r) => r.value === settings.region)?.label ?? settings.region}.{" "}
              <button
                type="button"
                className="linkish"
                onClick={() => {
                  const region = matchesState.status?.regionHint;
                  if (region) saveSettings({ ...settings, region }).then(onSaved, (err) => recorder.notify(`Could not save: ${String(err)}`, "bad"));
                }}
              >
                Switch to {REGIONS.find((r) => r.value === matchesState.status?.regionHint)?.label}
              </button>
            </Notice>
          )}
          {isDesktop && !settings.riotId && page !== "settings" && (
            <Notice tone="warn">
              Add your Riot ID so CrossPOV can find streamers in your matches.{" "}
              <button type="button" className="linkish" onClick={() => setPage("settings")}>Open Settings</button>
            </Notice>
          )}
          <Suspense fallback={<p className="muted">Loading…</p>}>
            {viewing ? (
              <Viewer
                clip={viewing}
                clips={recorder.clips}
                matches={matchesState.matches}
                streamers={matchesState.streamers}
                settings={settings}
                onBack={closeViewer}
                onOpen={setViewing}
                onDeleted={() => {
                  setViewing(null);
                  recorder.refreshClips();
                }}
                onChanged={recorder.refreshClips}
                notify={recorder.notify}
              />
            ) : (
              <>
                {page === "home" && <Home settings={settings} matchesState={matchesState} recorder={recorder} query={query} onNavigate={setPage} onOpen={setViewing} />}
                {page === "clips" && <Clips settings={settings} recorder={recorder} matches={matchesState.matches} query={query} onOpen={setViewing} />}
                {page === "streamers" && <Streamers settings={settings} recorder={recorder} matchesState={matchesState} onNavigate={setPage} onOpen={setViewing} />}
                {page === "settings" && <SettingsPage settings={settings} onSaved={onSaved} />}
              </>
            )}
          </Suspense>
        </main>
      </div>
      <ToastView toast={recorder.toast} />
    </div>
    <UpdateGate status={update} />
    </>
  );
}
