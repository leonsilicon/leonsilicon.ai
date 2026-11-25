#!/usr/bin/env bash
set -euo pipefail
umask 077
gadget_root=/opt/data/muse-gadget
state="$gadget_root/state"
incoming="$state/incoming"
exec > "$gadget_root/activate.log" 2>&1
trap 'printf "failed (%s)\n" "$?" > "$gadget_root/activate-status"' ERR
printf 'installing\n' > "$gadget_root/activate-status"
MUSEGADGET_STATE_DIR="$incoming" "$gadget_root/venv/bin/python" - <<'PY'
from musegadget import config, identity, server_hosts
record = config.load_json(config.PAIRING_FILE)
if config.pairing_problem(record) or not config.sdk_token():
    raise SystemExit("The incoming Gadget pairing is incomplete")
result = identity.load_or_create()
if result.node_id != "homelink-42967a" or result.legacy_node_id != result.node_id:
    raise SystemExit("The pairing is for a different Gadget")
if not server_hosts.api_allowed(record.get("api_url_v2")) or not server_hosts.noise_allowed(record.get("noise_host")):
    raise SystemExit("Unknown Muse endpoints")
PY
[[ ! -e "$state/pairing.json" ]]
for file in identity.json sdk_token pairing.json; do
  chmod 600 "$incoming/$file"
  mv "$incoming/$file" "$state/$file"
done
rmdir "$incoming"

bash "$gadget_root/ensure-cloud.sh"
for elapsed in {1..45}; do
  if curl -fsS --max-time 3 http://127.0.0.1:7899/health >/dev/null 2>&1     && grep -q 'registered with the Muse' "$gadget_root/runtime.log"; then
    hook_root=/opt/data/hooks
    mkdir -p -m 700 "$hook_root"
    hook="$hook_root/muse-gadget"
    if [[ ! -e "$hook" ]]; then
      staging=$(mktemp -d "$hook_root/.muse-gadget.XXXXXX")
      cat > "$staging/HOOK.yaml" <<'YAML'
name: muse-gadget
description: Start the paired Muse Gadget and private MCP endpoint when Hermes starts.
events:
  - gateway:startup
YAML
      cat > "$staging/handler.py" <<'PYTHON'
import asyncio
from pathlib import Path


async def handle(event_type, context):
    root = Path("/opt/data/muse-gadget")
    if not (root / "state" / "pairing.json").is_file():
        return
    process = await asyncio.create_subprocess_exec("bash", str(root / "ensure-cloud.sh"))
    if await process.wait():
        raise RuntimeError("Muse Gadget startup failed")
PYTHON
      mv "$staging" "$hook"
    fi
    printf 'installed\n' > "$gadget_root/activate-status"
    exit 0
  fi
  sleep 1
done
printf 'failed (1)\n' > "$gadget_root/activate-status"
exit 1
