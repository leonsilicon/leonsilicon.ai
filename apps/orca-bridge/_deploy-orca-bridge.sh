#!/usr/bin/env bash
# Copies the workspace to the host and installs production dependencies. With --start, also installs
# the LaunchAgent and (re)starts it, after writing ~/.config/orca-bridge/env on the host from .env.schema
# (#orca-bridge) with values from Infisical. The values go straight over SSH and never touch the disk here.
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST="${DEPLOY_HOST:-mini}"
APP=".local/share/orca-bridge/app"
LABEL="com.leonsilicon.orca-bridge"

ssh "$HOST" "mkdir -p ~/$APP ~/.local/share/orca-bridge/logs ~/.config/orca-bridge && chmod 700 ~/.config/orca-bridge ~/.local/share/orca-bridge"
rsync -a --delete --exclude node_modules --exclude .git --exclude .cache --exclude .vite --exclude dist --exclude .wrangler --exclude '*.db*' --exclude .env --exclude .env.local --exclude __pycache__ ./ "$HOST:$APP/"
ssh "$HOST" "cd ~/$APP && PATH=/opt/homebrew/bin:\$HOME/.bun/bin:\$HOME/.vite-plus/bin:\$PATH bun install --production --frozen-lockfile --ignore-scripts"
# bun can exit 0 on a stale frozen lockfile without installing, so check the result.
ssh "$HOST" "test -e ~/$APP/apps/orca-bridge/node_modules/@-/ai.leonsilicon.services.orca-bridge" || { echo "Install failed on $HOST (stale bun.lock? run vp install and commit it)" >&2; exit 1; }
echo "Copied to $HOST:~/$APP"

if [[ "${1:-}" == "--start" ]]; then
  # Stops here, before the env file or the service changes, if Infisical can't supply every value.
  ENV_FILE=$(vpx _env-file orca-bridge)
  printf '%s\n' "$ENV_FILE" | ssh "$HOST" "umask 077 && cat > ~/.config/orca-bridge/env.new && mv ~/.config/orca-bridge/env.new ~/.config/orca-bridge/env"
  echo "Wrote $HOST:~/.config/orca-bridge/env"
  # The bridge, then the watchdog that restarts the mini's Orca serve when it stops becoming ready.
  ssh "$HOST" 'bash -s' <<REMOTE
set -euo pipefail
start() {
  local label=\$1 plist=\$HOME/Library/LaunchAgents/\$1.plist
  sed -e "s|__NODE__|/opt/homebrew/bin/node|" -e "s|__HOME__|\$HOME|g" ~/$APP/apps/orca-bridge/@assets/\$label.plist > "\$plist"
  if launchctl print "gui/\$(id -u)/\$label" >/dev/null 2>&1; then
    launchctl bootout "gui/\$(id -u)/\$label" || true
    # bootout returns before the job is gone; bootstrapping too early fails with "5: Input/output error".
    for _ in \$(seq 1 30); do
      launchctl print "gui/\$(id -u)/\$label" >/dev/null 2>&1 || break
      sleep 1
    done
  fi
  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "gui/\$(id -u)" "\$plist"; then
      echo "Started \$label"
      return 0
    fi
    sleep \$((attempt * 2))
  done
  echo "Could not start \$label; run: launchctl bootstrap gui/\$(id -u) \$plist" >&2
  return 1
}
start $LABEL
start com.leonsilicon.orca-watchdog
REMOTE
fi
