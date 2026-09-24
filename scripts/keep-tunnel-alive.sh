#!/bin/bash
# Self-healing dev tunnel: restarts localhost.run whenever it dies, and
# whenever it comes back with a new random hostname, writes it to
# public/duel-ws-url.txt and pushes — so the live site's runtime WS-URL
# lookup (see src/Duel.jsx) picks it up without needing a redeploy or a
# human noticing the drop. Purely a stopgap until server/duelServer.js has
# a real always-on host.
set -u
cd "$(dirname "$0")/.."

URL_FILE="public/duel-ws-url.txt"
LOG_FILE="/tmp/keep-tunnel-alive.log"

log() { echo "[$(date '+%H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

while true; do
  log "starting tunnel..."
  ssh -R 80:localhost:8787 -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=3 nokey@localhost.run 2>&1 |
  while IFS= read -r line; do
    echo "$line" >> "$LOG_FILE"
    host=$(echo "$line" | grep -o '[a-z0-9]\{14\}\.lhr\.life' | head -1)
    if [ -n "$host" ]; then
      new_url="wss://$host"
      current_url=$(cat "$URL_FILE" 2>/dev/null | tr -d '[:space:]')
      if [ "$new_url" != "$current_url" ]; then
        log "new tunnel host: $new_url"
        echo "$new_url" > "$URL_FILE"
        git add "$URL_FILE" >> "$LOG_FILE" 2>&1
        git commit -m "Auto-update dev tunnel URL ($host)" >> "$LOG_FILE" 2>&1
        git push origin main >> "$LOG_FILE" 2>&1
        log "pushed $new_url"
      fi
    fi
  done
  log "tunnel died, restarting in 2s..."
  sleep 2
done
