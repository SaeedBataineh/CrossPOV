import { useEffect, useRef, useState } from "react";
import { defaultClipFolder, saveSettings } from "./backend";
import { DEFAULT_SETTINGS, type Settings } from "./settings";

/** How long after the last change settings are saved. */
const SAVE_AFTER_MS = 500;

/** Edits to settings, saved automatically a moment after each change. Shared by Settings and Audio. */
export function useDraft(settings: Settings, onSaved: (s: Settings) => void) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const latest = useRef(draft);
  latest.current = draft;

  useEffect(() => setDraft(settings), [settings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setStatus("Saving…");
    try {
      onSaved(await saveSettings(latest.current));
      setStatus("Saved");
    } catch (err) {
      setStatus(`Could not save: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  // Save shortly after the last change, so a burst of clicks is one save.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => void save(), SAVE_AFTER_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  async function reset() {
    setDraft({ ...DEFAULT_SETTINGS, riotId: latest.current.riotId, region: latest.current.region, clipFolder: await defaultClipFolder() });
  }

  return { draft, set, dirty, save, saving, status, reset };
}

export type Draft = ReturnType<typeof useDraft>;
