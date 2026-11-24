# Downloads yt-dlp for Windows (used to fetch just the needed seconds of a
# streamer's VOD) to src-tauri/binaries/yt-dlp-x86_64-pc-windows-msvc.exe.
$ErrorActionPreference = "Stop"
$dest = Join-Path $PSScriptRoot "..\src-tauri\binaries\yt-dlp-x86_64-pc-windows-msvc.exe"
if (Test-Path $dest) { Write-Host "yt-dlp already present: $dest"; exit 0 }
New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
Invoke-WebRequest -UserAgent "crosspov-build" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -OutFile $dest
& $dest --version | Out-Host
Write-Host "yt-dlp ready: $dest"
