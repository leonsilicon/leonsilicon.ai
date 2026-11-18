#!/usr/bin/env bash
# Copies the workspace to the host and installs production dependencies. With --start, also installs
# the LaunchAgent and (re)starts it, after writing ~/.config/beeper-watch/env on the host from .env.schema
# (#beeper-watch) with values from Infisical. The values go straight over SSH and never touch the disk here.
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST="${DEPLOY_HOST:-mini}"
APP=".local/share/beeper-watch/app"
LABEL="com.leonsilicon.beeper-watch"

ssh "$HOST" "mkdir -p ~/$APP ~/.local/share/beeper-watch/logs ~/.config/beeper-watch && chmod 700 ~/.config/beeper-watch ~/.local/share/beeper-watch"
rsync -a --delete --exclude node_modules --exclude .git --exclude .cache --exclude .vite --exclude dist --exclude .wrangler --exclude '*.db*' --exclude .env --exclude .env.local --exclude __pycache__ ./ "$HOST:$APP/"
ssh "$HOST" "cd ~/$APP && PATH=/opt/homebrew/bin:\$HOME/.bun/bin:\$HOME/.vite-plus/bin:\$PATH bun install --production --frozen-lockfile --ignore-scripts"
echo "Copied to $HOST:~/$APP"

if [[ "${1:-}" == "--start" ]]; then
  # Stops here, before the env file or the service changes, if Infisical can't supply every value.
  ENV_FILE=$(vpx _env-file beeper-watch)
  printf '%s\n' "$ENV_FILE" | ssh "$HOST" "umask 077 && cat > ~/.config/beeper-watch/env.new && mv ~/.config/beeper-watch/env.new ~/.config/beeper-watch/env"
  echo "Wrote $HOST:~/.config/beeper-watch/env"
  ssh "$HOST" 'bash -s' <<REMOTE
set -euo pipefail
PLIST=~/Library/LaunchAgents/$LABEL.plist
sed -e "s|__NODE__|/opt/homebrew/bin/node|" -e "s|__HOME__|\$HOME|g" ~/$APP/apps/beeper-watch/@assets/$LABEL.plist > "\$PLIST"
if launchctl print "gui/\$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/\$(id -u)/$LABEL" || true
  # bootout returns before the job is gone; bootstrapping too early fails with "5: Input/output error".
  for _ in \$(seq 1 30); do
    launchctl print "gui/\$(id -u)/$LABEL" >/dev/null 2>&1 || break
    sleep 1
  done
fi
for attempt in 1 2 3 4 5; do
  if launchctl bootstrap "gui/\$(id -u)" "\$PLIST"; then
    echo "Started $LABEL"
    exit 0
  fi
  sleep \$((attempt * 2))
done
echo "Could not start $LABEL; run: launchctl bootstrap gui/\$(id -u) \$PLIST" >&2
exit 1
REMOTE
fi
