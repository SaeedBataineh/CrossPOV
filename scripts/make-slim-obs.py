#!/usr/bin/env python3
"""Packs the recorder CrossPOV records games with: OBS Studio's engine
(libobs) and the OBS plugins CrossPOV uses, unchanged, run by the CrossPOV
Recorder (recorder/, GPL), a small program with no windows.

Takes the official OBS Studio release (checked against its SHA-256), keeps
only libobs and the plugins CrossPOV uses (Game Capture with its signed hook,
Display Capture, the hardware encoders, application audio capture, the noise
filter, the replay buffer) and leaves out OBS's own app (obs64.exe, Qt,
obs-websocket and the rest). Adds the recorder, Microsoft's Visual C++
runtime (libobs needs it) and the GPL with where to get the source code, and
writes one zip. The same inputs always give the same zip, byte for byte, so
the app's fingerprint only changes when what's inside does.

Usage: python3 make-slim-obs.py OUT.zip VC_RUNTIME_DIR RECORDER_EXE
  VC_RUNTIME_DIR: folder with the runtime DLLs to add (msvcp140.dll, ...).
  RECORDER_EXE: the built crosspov-recorder.exe.
"""

import hashlib
import io
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

VERSION = "32.0.4"
URL = f"https://github.com/obsproject/obs-studio/releases/download/{VERSION}/OBS-Studio-{VERSION}-Windows-x64.zip"
SHA256 = "fd367a7f156319426f1a600720c1288ad0011da168dff41e0f94dbb18cc1dc0f"
LICENSE_URL = f"https://raw.githubusercontent.com/obsproject/obs-studio/{VERSION}/COPYING"
SOURCE_URL = f"https://github.com/obsproject/obs-studio/tree/{VERSION}"

# The plugins the recorder uses; the rest (the browser source alone is
# ~270 MB of Chromium) is left out.
KEEP_PLUGINS = ["win-capture", "win-wasapi", "obs-ffmpeg", "obs-nvenc", "obs-qsv11", "obs-x264", "obs-filters"]
# OBS's own app: the recorder replaces it (Qt is only used by the app).
DROP_BIN = [
    "obs64.exe", "obs-frontend-api.dll", "obs-scripting.dll", "lua51.dll", "datachannel.dll", "libobs-opengl.dll",
    "Qt6Core.dll", "Qt6Gui.dll", "Qt6Network.dll", "Qt6Svg.dll", "Qt6Widgets.dll", "Qt6Xml.dll",
    "platforms", "styles", "imageformats", "iconengines",
]
RECORDER_SOURCE = "https://github.com/SaeedBataineh/crosspov-recorder"
# Microsoft's Visual C++ runtime, put next to obs64.exe.
VC_RUNTIME = [
    "msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "msvcp140_atomic_wait.dll",
    "msvcp140_codecvt_ids.dll", "vcruntime140.dll", "vcruntime140_1.dll", "concrt140.dll",
]

NOTICE = f"""This folder is the CrossPOV Recorder (bin/64bit/crosspov-recorder.exe) and
the parts of OBS Studio {VERSION} (https://obsproject.com) it uses, unmodified:
its engine, libobs, and some of its plugins. CrossPOV runs the recorder as a
separate program to record games.

Both are free software under the GNU General Public License, version 2 or
later: see COPYING. Complete source code:
  CrossPOV Recorder: {RECORDER_SOURCE}
  OBS Studio {VERSION}: {SOURCE_URL}

Also included: Microsoft's Visual C++ runtime DLLs (msvcp140*.dll,
vcruntime140*.dll, concrt140.dll), redistributed as Microsoft allows.
"""


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=300) as r:
        return r.read()


def main() -> None:
    out = Path(sys.argv[1])
    vc_dir = Path(sys.argv[2])
    recorder = Path(sys.argv[3])

    data = fetch(URL)
    got = hashlib.sha256(data).hexdigest()
    if got != SHA256:
        sys.exit(f"OBS download doesn't match: {got}")
    license_text = fetch(LICENSE_URL)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "obs"
        zipfile.ZipFile(io.BytesIO(data)).extractall(root)
        plugins, plugin_data = root / "obs-plugins" / "64bit", root / "data" / "obs-plugins"
        # Only the plugins the recorder uses (everything else in the plugin
        # folders: other plugins, the browser's files, their data).
        for p in list(plugins.iterdir()):
            if p.stem not in KEEP_PLUGINS or p.suffix.lower() != ".dll":
                shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink()
        for p in list(plugin_data.iterdir()):
            if p.name not in KEEP_PLUGINS:
                shutil.rmtree(p, ignore_errors=True)
        for d in ["obs-studio", "obs-scripting"]:  # OBS's app: themes, its texts, scripting
            shutil.rmtree(root / "data" / d, ignore_errors=True)
        bin64 = root / "bin" / "64bit"
        for name in DROP_BIN:
            p = bin64 / name
            shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)
        for pdb in root.rglob("*.pdb"):
            pdb.unlink()
        missing = [p for p in [bin64 / "obs.dll", bin64 / "libobs-d3d11.dll", root / "data" / "obs-plugins" / "win-capture" / "graphics-hook64.dll"]
                   + [plugins / f"{n}.dll" for n in KEEP_PLUGINS] if not p.is_file()]
        if missing:
            sys.exit(f"OBS layout changed: missing {[str(m.relative_to(root)) for m in missing]}")
        for name in VC_RUNTIME:
            src = vc_dir / name
            if src.is_file():
                shutil.copyfile(src, bin64 / name)
        if not (bin64 / "msvcp140.dll").is_file():
            sys.exit(f"Visual C++ runtime not found in {vc_dir}")
        shutil.copyfile(recorder, bin64 / "crosspov-recorder.exe")
        (root / "COPYING").write_bytes(license_text)
        (root / "CROSSPOV-NOTICE.txt").write_text(NOTICE, newline="\r\n")

        # Same bytes every time: sorted names, a fixed date, fixed permissions.
        files = sorted(p for p in root.rglob("*") if p.is_file())
        out.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for p in files:
                info = zipfile.ZipInfo(str(PurePosixPath(p.relative_to(root).as_posix())), (1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                z.writestr(info, p.read_bytes(), compresslevel=9)
    print(f"{out}: {out.stat().st_size / 1e6:.1f} MB, sha256 {hashlib.sha256(out.read_bytes()).hexdigest()}")


if __name__ == "__main__":
    main()
