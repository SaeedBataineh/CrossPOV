#!/bin/bash
# Keeps the scanner (reads scoreboards) and the API (answers the CrossPOV
# server) running. Installed in the crosspov user's crontab to run every two
# minutes and at boot, so either restarts by itself if it ever stops. No root needed.
cd /opt/crosspov || exit 1
set -a; . ./.env; set +a
export OMP_THREAD_LIMIT=1 CROSSPOV_DB=/opt/crosspov/readings.db YTDLP=/opt/crosspov/venv/bin/yt-dlp
mkdir -p logs

start() {
  # "[s]canner" matches the running program but not this check itself.
  if ! pgrep -u "$(id -u)" -f "[s]canner/$1.py" > /dev/null; then
    nohup ./venv/bin/python -u "scanner/$1.py" >> "logs/$1.log" 2>&1 &
    echo "$(date -u +%FT%TZ) started $1" >> logs/watchdog.log
  fi
}
start scanner
start api

# Keep logs small: the last ~1 MB of each.
for f in logs/*.log; do
  if [ "$(stat -c%s "$f")" -gt 5000000 ]; then tail -c 1000000 "$f" > "$f.tmp" && mv "$f.tmp" "$f"; fi
done
