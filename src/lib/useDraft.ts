import { useEffect, useState } from "react";
import { defaultClipFolder, saveSettings } from "./backend";
import { DEFAULT_SETTINGS, type Settings } from "./settings";

/** Unsaved edits to settings, with save and reset. Shared by Settings and Audio. */
export function useDraft(settings: Settings, onSaved: (s: Settings) => void) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(settings), [settings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setStatus("");
  }

  async function save() {
    setSaving(true);
    try {
      onSaved(await saveSettings(draft));
      setStatus("Saved");
    } catch (err) {
      setStatus(`Could not save: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    setDraft({ ...DEFAULT_SETTINGS, clipFolder: await defaultClipFolder() });
    setStatus("Defaults restored. Press Save to keep them.");
  }

  return { draft, set, dirty, save, saving, status, reset, discard: () => setDraft(settings) };
}

export type Draft = ReturnType<typeof useDraft>;
