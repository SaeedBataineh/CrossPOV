# Downloads an LGPL build of FFmpeg for Windows and puts it where the
# Tauri build expects it: src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe
#
# LGPL build: includes the NVIDIA, AMD and Intel GPU encoders and Windows'
# own Media Foundation encoder, without GPL parts, so CrossPOV can ship it.
$ErrorActionPreference = "Stop"
$dest = Join-Path $PSScriptRoot "..\src-tauri\binaries\ffmpeg-x86_64-pc-windows-msvc.exe"
if (Test-Path $dest) { Write-Host "FFmpeg already present: $dest"; exit 0 }

$headers = @{ "User-Agent" = "crosspov-build" }
if ($env:GITHUB_TOKEN) { $headers["Authorization"] = "Bearer $env:GITHUB_TOKEN" }
$release = Invoke-RestMethod -Headers $headers "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest"

# Prefer the newest stable release branch (e.g. n7.1); fall back to master.
$candidates = foreach ($a in $release.assets) {
  if ($a.name -match '^ffmpeg-n(\d+)\.(\d+)-latest-win64-lgpl-\d+\.\d+\.zip$') {
    [pscustomobject]@{ Asset = $a; Version = [version]"$($Matches[1]).$($Matches[2])" }
  }
}
$asset = ($candidates | Sort-Object Version -Descending | Select-Object -First 1).Asset
if (-not $asset) { $asset = $release.assets | Where-Object { $_.name -eq 'ffmpeg-master-latest-win64-lgpl.zip' } | Select-Object -First 1 }
if (-not $asset) { throw "No suitable FFmpeg build found" }
Write-Host "Downloading $($asset.name)"

$tmp = Join-Path ([IO.Path]::GetTempPath()) "crosspov-ffmpeg"
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $tmp | Out-Null
$zip = Join-Path $tmp "ffmpeg.zip"
Invoke-WebRequest -Headers $headers $asset.browser_download_url -OutFile $zip
Expand-Archive $zip -DestinationPath $tmp
$exe = Get-ChildItem -Recurse -Path $tmp -Filter ffmpeg.exe | Select-Object -First 1
New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
Copy-Item $exe.FullName $dest
& $dest -hide_banner -filters | Select-String "ddagrab" | Out-Host
Write-Host "FFmpeg ready: $dest"
