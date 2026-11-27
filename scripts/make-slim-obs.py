#!/usr/bin/env python3
"""Packs the slim OBS Studio that CrossPOV records with (games are captured
with OBS's own Game Capture, which works where Windows' capture APIs don't).

Takes the official OBS Studio release (checked against its SHA-256), keeps
only what CrossPOV uses, unchanged (OBS itself, Game Capture with its signed
hook, the hardware encoders, application audio capture, the replay buffer,
obs-websocket), adds Microsoft's Visual C++ runtime (OBS needs it; its
installer usually adds it) and OBS's license with a link to its source code,
and writes one zip. The same inputs always give the same zip, byte for byte,
so the app's fingerprint only changes when what's inside does.

Usage: python3 make-slim-obs.py OUT.zip [VC_RUNTIME_DIR]
  VC_RUNTIME_DIR: folder with the runtime DLLs to add (msvcp140.dll, ...).
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

# Plugins CrossPOV doesn't use (nothing else loads them). By far the biggest
# is the browser source (Chromium, ~270 MB).
DROP_PLUGINS = [
    "aja", "aja-output-ui", "decklink", "decklink-captions", "decklink-output-ui",
    "frontend-tools", "obs-browser", "obs-text", "obs-vst", "obs-webrtc",
    "text-freetype2", "vlc-video", "win-dshow",
]
# The browser source's own files, next to the plugins.
DROP_BROWSER = [
    "obs-browser-page.exe", "libcef.dll", "chrome_elf.dll", "libEGL.dll", "libGLESv2.dll",
    "icudtl.dat", "resources.pak", "chrome_100_percent.pak", "chrome_200_percent.pak",
    "v8_context_snapshot.bin", "snapshot_blob.bin", "vk_swiftshader.dll",
    "vk_swiftshader_icd.json", "vulkan-1.dll", "locales",
]
# Microsoft's Visual C++ runtime, put next to obs64.exe.
VC_RUNTIME = [
    "msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "msvcp140_atomic_wait.dll",
    "msvcp140_codecvt_ids.dll", "vcruntime140.dll", "vcruntime140_1.dll", "concrt140.dll",
]

NOTICE = f"""This folder is OBS Studio {VERSION} (https://obsproject.com), unmodified,
with only the parts CrossPOV uses. CrossPOV runs it as a separate program to
record games.

OBS Studio is free software under the GNU General Public License, version 2
or later: see COPYING. Its complete source code for this version:
{SOURCE_URL}

Also included: Microsoft's Visual C++ runtime DLLs (msvcp140*.dll,
vcruntime140*.dll, concrt140.dll), redistributed as Microsoft allows.
"""


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=300) as r:
        return r.read()


def main() -> None:
    out = Path(sys.argv[1])
    vc_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else None

    data = fetch(URL)
    got = hashlib.sha256(data).hexdigest()
    if got != SHA256:
        sys.exit(f"OBS download doesn't match: {got}")
    license_text = fetch(LICENSE_URL)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "obs"
        zipfile.ZipFile(io.BytesIO(data)).extractall(root)
        plugins, plugin_data = root / "obs-plugins" / "64bit", root / "data" / "obs-plugins"
        for name in DROP_PLUGINS:
            (plugins / f"{name}.dll").unlink(missing_ok=True)
            shutil.rmtree(plugin_data / name, ignore_errors=True)
        for name in DROP_BROWSER:
            p = plugins / name
            shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)
        for pdb in root.rglob("*.pdb"):
            pdb.unlink()
        bin64 = root / "bin" / "64bit"
        if not (bin64 / "obs64.exe").is_file() or not (root / "data" / "obs-plugins" / "win-capture" / "graphics-hook64.dll").is_file():
            sys.exit("OBS layout changed: obs64.exe or the Game Capture hook is missing")
        if vc_dir:
            for name in VC_RUNTIME:
                src = vc_dir / name
                if src.is_file():
                    shutil.copyfile(src, bin64 / name)
            if not (bin64 / "msvcp140.dll").is_file():
                sys.exit(f"Visual C++ runtime not found in {vc_dir}")
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
