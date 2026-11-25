#!/usr/bin/env bash
set -euo pipefail
umask 077
root=/opt/data/muse-gadget
[[ -r "$root/state/pairing.json" ]]
[[ -r "$root/state/sdk_token" ]]
cd "$root"
exec 9>"$root/runtime.lock"
flock -n 9 || exit 0
setsid -f "$root/venv/bin/python" "$root/serve-cloud.py" </dev/null >>"$root/runtime.log" 2>&1
