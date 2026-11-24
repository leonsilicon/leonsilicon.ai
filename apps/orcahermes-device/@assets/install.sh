#!/bin/sh
# Installs the orcahermes-device release unpacked next to this script into $ORCA_DEVICE_HOME
# (default $HERMES_HOME/orca-device = /opt/data/orca-device), keeping the previous bundle and app
# as *.prev, then restarts the link. data/ (pairings), tailscale/state (tailnet login),
# device.json and default-environment are never touched.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
D=${ORCA_DEVICE_HOME:-${HERMES_HOME:-/opt/data}/orca-device}
build=$here/BUILD.json
field() { node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(process.argv[2].split(".").reduce((o,k)=>o[k],b))' "$build" "$1"; }

(cd "$here" && sha256sum --quiet -c SHA256SUMS)
mkdir -p "$D/bin" "$D/state" "$D/logs" "$D/releases"
chmod 700 "$D/state"
[ -d "$D/data" ] || install -d -m 700 "$D/data"

# Orca's pinned Node, from nodejs.org, checked against the hashes Orca pins.
NSHA=$(field node.executableSha256)
NODE=$D/runtimes/node-$NSHA/bin/node
if [ ! -x "$NODE" ]; then
  archive=$(field node.archive)
  curl -sSfL -o "$D/releases/$archive" "https://nodejs.org/dist/v$(echo "$archive" | sed -E 's/^node-v([0-9.]+)-.*/\1/')/$archive"
  echo "$(field node.archiveSha256)  $D/releases/$archive" | sha256sum -c
  mkdir -p "$D/runtimes/node-$NSHA/bin"
  tar -xzf "$D/releases/$archive" -O "${archive%.tar.gz}/bin/node" > "$NODE"
  chmod 755 "$NODE"
  rm "$D/releases/$archive"
fi
echo "$NSHA  $NODE" | sha256sum -c

# Tailscale, checked against its published sha256.
TV=$(field tailscale.version)
if [ ! -x "$D/tailscale/bin/tailscaled" ] || ! "$D/tailscale/bin/tailscale" version | head -1 | grep -qx "$TV"; then
  curl -sSfL -o "$D/releases/ts.tgz" "https://pkgs.tailscale.com/stable/tailscale_${TV}_amd64.tgz"
  echo "$(curl -sSfL "https://pkgs.tailscale.com/stable/tailscale_${TV}_amd64.tgz.sha256")  $D/releases/ts.tgz" | sha256sum -c
  mkdir -p "$D/tailscale/bin" "$D/tailscale/state" && chmod 700 "$D/tailscale/state"
  tar -xzf "$D/releases/ts.tgz" --strip-components=1 -C "$D/tailscale/bin" "tailscale_${TV}_amd64/tailscale" "tailscale_${TV}_amd64/tailscaled"
  rm "$D/releases/ts.tgz"
fi

for dir in bundle app; do
  rm -rf "$D/$dir.new" && cp -R "$here/$dir" "$D/$dir.new"
done
# orcad refuses to start unless .version is the digest its own preflight computes.
STAMP=$(ORCA_BACKGROUND_LAUNCH=1 "$NODE" "$D/bundle.new/orcad-server.js" --orcad-startup-preflight 3b241101-e2bb-4255-8caf-4136c566a962 | tail -1 | "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).artifactVersion))')
echo "$STAMP" > "$D/bundle.new/.version"
for dir in bundle app; do
  rm -rf "$D/$dir.prev"
  if [ -d "$D/$dir" ]; then mv "$D/$dir" "$D/$dir.prev"; fi
  mv "$D/$dir.new" "$D/$dir"
done
install -m 755 "$here/orca" "$D/bin/orca"
cp "$build" "$D/BUILD.json"
[ -f "$D/device.json" ] || echo "note: write $D/device.json (see device.example.json) before starting"

echo "installed Orca $(field orcaVersion) ($STAMP)"
"$D/bin/orca" --version
if [ -f "$D/device.json" ]; then
  node "$D/app/orca-device.mjs" stop >/dev/null || true
  sleep 3
  node "$D/app/orca-device.mjs" start >/dev/null && echo "link restarted"
fi
