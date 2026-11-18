#!/bin/bash
# Keeps Beeper Desktop (and the Tailscale app that carries the Funnel) running on the Mac mini, so Hermes
# Cloud's `beeper` and `grok` MCP servers stay reachable. Run every 60s by com.leonsilicon.beeper-watchdog.
# - Beeper not running for 2 checks in a row: launch it (one check of grace covers its own update restarts).
# - Beeper running but its API silent for 3 checks in a row: assume it is hung, restart it.
# - API answering but chats unusable for 5 checks in a row: restart it. On 2026-11-13 a failed update left
#   Beeper with an empty chat list and every chat call failing (500 "Failed to execute tool"), while
#   /v1/spec, accounts and search still answered, so the old check never noticed for hours.
# - A restart quits Beeper, then sends TERM, then KILL: a stuck update dialog blocked both quit and TERM.
# - Tailscale app not running: launch it.
# Test hooks: BEEPER_API, BEEPER_TOKEN_FILE, WATCHDOG_STATE, WATCHDOG_LOG, and WATCHDOG_DRY_RUN=1, which
# logs "would restart" instead of touching Beeper.
set -u
API="${BEEPER_API:-http://127.0.0.1:23373}"
TOKEN_FILE="${BEEPER_TOKEN_FILE:-$HOME/.local/share/grok-relay-hermes/beeper.json}"
STATE="${WATCHDOG_STATE:-$HOME/.local/share/grok-relay-hermes/logs/watchdog.state}"
LOG="${WATCHDOG_LOG:-$HOME/.local/share/grok-relay-hermes/logs/watchdog.log}"
DRY="${WATCHDOG_DRY_RUN:-0}"
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
missing=0; silent=0; broken=0
[ -f "$STATE" ] && read -r missing silent broken < "$STATE"
missing=${missing:-0}; silent=${silent:-0}; broken=${broken:-0}

# Lists one chat and opens it. Prints nothing on success, else what failed.
chats_problem() {
  local token list id code
  token=$(plutil -extract token raw -o - "$TOKEN_FILE" 2>/dev/null) || { echo "no token in $TOKEN_FILE"; return; }
  list=$(curl -fsS -m 15 -H "Authorization: Bearer $token" "$API/v1/chats?limit=1" 2>/dev/null) || { echo "chat list failed"; return; }
  id=$(printf '%s' "$list" | plutil -extract items.0.id raw -o - - 2>/dev/null) || { echo "chat list empty"; return; }
  code=$(curl -s -m 15 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" \
    "$API/v1/chats/$(printf '%s' "$id" | sed -e 's/%/%25/g' -e 's/!/%21/g' -e 's/:/%3A/g' -e 's/@/%40/g' -e 's/=/%3D/g' -e 's/+/%2B/g' -e 's|/|%2F|g' -e 's/#/%23/g')")
  [ "$code" = "200" ] || echo "opening a chat answered $code"
}

restart_beeper() {
  if [ "$DRY" = "1" ]; then log "would restart Beeper (dry run)"; return; fi
  osascript -e 'tell application "Beeper Desktop" to quit' >/dev/null 2>&1 &
  local quitter=$!
  for _ in $(seq 1 15); do pgrep -xq "Beeper Desktop" || break; sleep 1; done
  kill "$quitter" 2>/dev/null
  if pgrep -xq "Beeper Desktop"; then
    pkill -TERM -x "Beeper Desktop" 2>/dev/null
    for _ in $(seq 1 20); do pgrep -xq "Beeper Desktop" || break; sleep 1; done
  fi
  if pgrep -xq "Beeper Desktop"; then
    log "Beeper ignored quit and TERM; killing it"
    pkill -KILL -x "Beeper Desktop" 2>/dev/null
    sleep 3
  fi
  open -g -a "Beeper Desktop" && log "Beeper relaunched"
}

if pgrep -xq "Beeper Desktop"; then
  missing=0
  if curl -fsS -m 10 -o /dev/null "$API/v1/spec"; then
    silent=0
    problem=$(chats_problem)
    if [ -z "$problem" ]; then
      [ "$broken" -gt 0 ] && log "Beeper chats work again"
      broken=0
    else
      broken=$((broken + 1))
      log "Beeper API answers but chats are unusable: $problem ($broken)"
      if [ "$broken" -ge 5 ]; then
        log "Beeper looks broken; restarting it"
        restart_beeper
        broken=0
      fi
    fi
  else
    silent=$((silent + 1)); broken=0
    log "Beeper API not answering ($silent)"
    if [ "$silent" -ge 3 ]; then
      log "Beeper looks hung; restarting it"
      restart_beeper
      silent=0
    fi
  fi
else
  missing=$((missing + 1)); silent=0; broken=0
  log "Beeper not running ($missing)"
  if [ "$missing" -ge 2 ]; then
    if [ "$DRY" = "1" ]; then log "would launch Beeper (dry run)"; else open -g -a "Beeper Desktop" && log "Beeper launched"; fi
    missing=0
  fi
fi

if [ "$DRY" != "1" ] && ! pgrep -xq "Tailscale"; then
  open -g -a "Tailscale" && log "Tailscale app launched"
fi

echo "$missing $silent $broken" > "$STATE"
# Keep the log small.
[ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 2000 ] && tail -n 1000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit 0
