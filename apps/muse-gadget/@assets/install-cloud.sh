#!/usr/bin/env bash
set -euo pipefail
umask 077
gadget_root=/opt/data/muse-gadget
mkdir -p -m 700 "$gadget_root" "$gadget_root/state" "$gadget_root/state/incoming"
exec > "$gadget_root/install.log" 2>&1
trap 'printf "failed (%s)\n" "$?" > "$gadget_root/install-status"' ERR
printf 'installing\n' > "$gadget_root/install-status"

ensure_source() {
  local name=$1 repository=$2 revision=$3
  local checkout="$gadget_root/$name"
  if [[ -e "$checkout" ]]; then
    [[ "$(git -C "$checkout" rev-parse HEAD)" == "$revision" ]]
    return
  fi
  local staging
  staging=$(mktemp -d "$gadget_root/.${name}.XXXXXX")
  git -C "$staging" init -q
  git -C "$staging" fetch --depth 1 "$repository" "$revision"
  git -C "$staging" checkout --quiet --detach FETCH_HEAD
  [[ "$(git -C "$staging" rev-parse HEAD)" == "$revision" ]]
  mv "$staging" "$checkout"
}

ensure_source sdk https://github.com/facebookincubator/muse-gadget-sdk.git fbfe3b0f717f7f468d0a94aa370ea0ca1a94ebfe
ensure_source muse-mcp https://github.com/niclydon/muse-mcp.git 43299b2f4270e8994eff3978a72d1345abf93e4d

if command -v uv >/dev/null 2>&1; then
  [[ -x "$gadget_root/venv/bin/python" ]] || uv venv "$gadget_root/venv"
  uv pip install --python "$gadget_root/venv/bin/python" -r "$gadget_root/muse-mcp/requirements.txt" "$gadget_root/sdk/linux" uvicorn
else
  [[ -x "$gadget_root/venv/bin/python" ]] || python3 -m venv "$gadget_root/venv"
  "$gadget_root/venv/bin/python" -m pip install -r "$gadget_root/muse-mcp/requirements.txt" "$gadget_root/sdk/linux" uvicorn
fi
"$gadget_root/venv/bin/python" -c 'import musegadget, mcp, uvicorn'
"$gadget_root/venv/bin/python" - "$gadget_root" <<'PY'
from pathlib import Path
import secrets
import sys
root = Path(sys.argv[1])
for path, default in (
    (root / "directory.json", "[]\n"),
    (root / "state" / "origin-secret", secrets.token_hex(32) + "\n"),
):
    if not path.exists():
        with path.open("x") as file:
            file.write(default)
PY
printf 'installed\n' > "$gadget_root/install-status"
