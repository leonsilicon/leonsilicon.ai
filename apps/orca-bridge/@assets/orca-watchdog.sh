#!/bin/bash
# Keeps the mini's headless Orca (LaunchAgent dev.onorca.serve) serving, so the Orca bridge's tools work.
# Run every 60 s by com.leonsilicon.orca-watchdog.
# launchd's KeepAlive and the serve's own --supervise restart a serve that exits, but not one that stays
# alive without ever becoming ready. From 2026-11-14 to 2026-11-18 the 1.4.249 serve sat in that state
# after a WindowServer restart (no socket, nothing on port 6768), so every orca CLI call on the mini
# failed with runtime_unavailable for four days while the bridge still answered.
# - Runtime not ready for 5 checks in a row: kickstart -k the serve (launchd starts it again), then kill
#   any serve process that outlives the restart. A cold start takes about 10 s and an update restart about
#   a minute, so 5 minutes leaves room for both.
# - Serve job not loaded at all: bootstrap it from its plist.
# Test hooks: ORCA_BIN, ORCA_SERVE_LABEL, ORCA_SERVE_PLIST, WATCHDOG_STATE, WATCHDOG_LOG, and
# WATCHDOG_DRY_RUN=1, which logs "would restart" instead of touching the serve.
set -u
ORCA="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
LABEL="${ORCA_SERVE_LABEL:-dev.onorca.serve}"
PLIST="${ORCA_SERVE_PLIST:-$HOME/Library/LaunchAgents/$LABEL.plist}"
STATE="${WATCHDOG_STATE:-$HOME/.local/share/orca-bridge/logs/orca-watchdog.state}"
LOG="${WATCHDOG_LOG:-$HOME/.local/share/orca-bridge/logs/orca-watchdog.log}"
DRY="${WATCHDOG_DRY_RUN:-0}"
LIMIT=5
SERVE_PATTERN="--user-data-dir=$HOME/Library/Application Support/orca --serve"
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
mkdir -p "$(dirname "$STATE")" "$(dirname "$LOG")"
failures=0
[ -f "$STATE" ] && read -r failures < "$STATE"
case "$failures" in '' | *[!0-9]*) failures=0 ;; esac

# Runs a command for at most $1 seconds, then kills its whole process group (exit 142), so a child that
# holds stdout open can't stall the check. macOS has no timeout(1).
with_timeout() {
  perl -e '$t = shift; $pid = fork // exit 127;
    if (!$pid) { setpgrp(0, 0); exec @ARGV; exit 127 }
    $SIG{ALRM} = sub { kill "KILL", -$pid; exit 142 }; alarm $t;
    waitpid($pid, 0); exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' "$@"
}

# Prints "ready" when the local runtime serves, else what `orca status` reported. The CLI gets 45 s.
runtime_state() {
  local out rc state code
  out=$(with_timeout 45 "$ORCA" status --json 2>/dev/null)
  rc=$?
  [ -n "$out" ] || { echo "orca status printed nothing (exit $rc)"; return; }
  state=$(printf '%s' "$out" | plutil -extract result.runtime.state raw -o - - 2>/dev/null)
  if [ -n "$state" ]; then echo "$state"; return; fi
  code=$(printf '%s' "$out" | plutil -extract error.code raw -o - - 2>/dev/null)
  echo "${code:-unparsable orca status output}"
}

restart_serve() {
  if [ "$DRY" = "1" ]; then log "would restart $LABEL (dry run)"; return; fi
  local before uid
  uid=$(id -u)
  before=$(pgrep -f -- "$SERVE_PATTERN")
  if launchctl print "gui/$uid/$LABEL" > /dev/null 2>&1; then
    launchctl kickstart -k "gui/$uid/$LABEL" && log "kickstarted $LABEL"
  elif [ -f "$PLIST" ]; then
    launchctl bootstrap "gui/$uid" "$PLIST" && log "bootstrapped $LABEL (it was not loaded)"
  else
    log "cannot restart: $LABEL is not loaded and $PLIST is missing"
    return
  fi
  sleep 20
  for pid in $before; do
    if kill -0 "$pid" 2> /dev/null; then
      log "serve $pid outlived the restart; killing it"
      kill -KILL "$pid" 2> /dev/null
    fi
  done
}

state=$(runtime_state)
if [ "$state" = "ready" ]; then
  [ "$failures" -gt 0 ] && log "Orca runtime ready again"
  failures=0
else
  failures=$((failures + 1))
  log "Orca runtime not ready: $state ($failures)"
  if [ "$failures" -ge "$LIMIT" ]; then
    log "Orca serve looks stuck; restarting it"
    restart_serve
    failures=0
  fi
fi

echo "$failures" > "$STATE"
# Keep the log small.
[ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 2000 ] && tail -n 1000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit 0
