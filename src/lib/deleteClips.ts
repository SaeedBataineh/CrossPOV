import { deleteClip, recycleClip, restoreClip, type ClipInfo } from "./backend";
import type { ShowToast } from "./useRecorder";

/**
 * Deletes clips with an Undo: they disappear at once, the toast offers Undo
 * for a few seconds, then they go to the Windows Recycle Bin.
 * Returns how many were deleted.
 */
export async function deleteWithUndo(list: ClipInfo[], label: string, show: ShowToast, refresh: () => void): Promise<number> {
  const gone: string[] = [];
  let lastError = "";
  for (const c of list) {
    try {
      await deleteClip(c.path);
      gone.push(c.path);
    } catch (err) {
      lastError = String(err).replace(/^Error: /, "");
    }
  }
  refresh();
  if (!gone.length) {
    show({ text: `Couldn't delete: ${lastError}`, tone: "bad" });
    return 0;
  }
  const failed = list.length - gone.length;
  show({
    text: (gone.length === 1 ? `Deleted ${label}` : `Deleted ${gone.length} clips`) + (failed ? ` (${failed} couldn't be deleted)` : ""),
    tone: "info",
    ms: 7000,
    actions: [
      {
        label: "Undo",
        run: () =>
          void Promise.allSettled(gone.map(restoreClip)).then((r) => {
            refresh();
            if (r.some((x) => x.status === "rejected")) show({ text: "Some clips couldn't be brought back.", tone: "bad" });
          }),
      },
    ],
    onExpire: () =>
      void Promise.allSettled(gone.map(recycleClip)).then((r) => {
        if (r.some((x) => x.status === "rejected")) {
          refresh();
          show({ text: "Couldn't move a clip to the Recycle Bin, so it was kept.", tone: "bad" });
        }
      }),
  });
  return gone.length;
}
