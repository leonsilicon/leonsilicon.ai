#!/usr/bin/env bash
# Copies the workspace to the host and installs production dependencies. With --start, also writes the
# tunnel config and (re)starts both LaunchAgents: the gateway and its Cloudflare Tunnel. The tunnel's
# credentials file (~/.cloudflared/<tunnel id>.json) lives only on the host, never here.
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST="${DEPLOY_HOST:-mini}"
DIR=".local/share/ai-gateway"

ssh "$HOST" "mkdir -p ~/$DIR/app ~/$DIR/logs && chmod 700 ~/$DIR"
rsync -a --delete --exclude node_modules --exclude .git --exclude .cache --exclude .vite --exclude dist --exclude .wrangler --exclude '*.db*' --exclude .env --exclude .env.local --exclude __pycache__ ./ "$HOST:$DIR/app/"
ssh "$HOST" "cd ~/$DIR/app && PATH=/opt/homebrew/bin:\$HOME/.bun/bin:\$HOME/.vite-plus/bin:\$PATH bun install --production --frozen-lockfile --ignore-scripts"
# bun can exit 0 on a stale frozen lockfile without installing, so check the result.
ssh "$HOST" "test -e ~/$DIR/app/apps/ai-gateway/node_modules/@-/com.leonsilicon.ai.services.ai-gateway" || { echo "Install failed on $HOST (stale bun.lock? run vp install and commit it)" >&2; exit 1; }
echo "Copied to $HOST:~/$DIR/app"

if [[ "${1:-}" == "--start" ]]; then
  ssh "$HOST" 'bash -s' <<REMOTE
set -euo pipefail
ASSETS=~/$DIR/app/apps/ai-gateway/@assets
TUNNEL=\$(sed -n 's/^tunnel: //p' "\$ASSETS/cloudflared.yml")
[[ -f ~/.cloudflared/\$TUNNEL.json ]] || { echo "Missing ~/.cloudflared/\$TUNNEL.json (tunnel credentials)" >&2; exit 1; }
sed -e "s|__HOME__|\$HOME|g" "\$ASSETS/cloudflared.yml" > ~/$DIR/cloudflared.yml
for LABEL in com.leonsilicon.ai-gateway com.leonsilicon.cloudflared-ai; do
  PLIST=~/Library/LaunchAgents/\$LABEL.plist
  sed -e "s|__NODE__|/opt/homebrew/bin/node|" -e "s|__CLOUDFLARED__|/opt/homebrew/bin/cloudflared|" -e "s|__HOME__|\$HOME|g" "\$ASSETS/\$LABEL.plist" > "\$PLIST"
  if launchctl print "gui/\$(id -u)/\$LABEL" >/dev/null 2>&1; then
    launchctl bootout "gui/\$(id -u)/\$LABEL" || true
    # bootout returns before the job is gone; bootstrapping too early fails with "5: Input/output error".
    for _ in \$(seq 1 30); do launchctl print "gui/\$(id -u)/\$LABEL" >/dev/null 2>&1 || break; sleep 1; done
  fi
  started=""
  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "gui/\$(id -u)" "\$PLIST"; then started=1; echo "Started \$LABEL"; break; fi
    sleep \$((attempt * 2))
  done
  [[ -n "\$started" ]] || { echo "Could not start \$LABEL; run: launchctl bootstrap gui/\$(id -u) \$PLIST" >&2; exit 1; }
done
REMOTE
fi
