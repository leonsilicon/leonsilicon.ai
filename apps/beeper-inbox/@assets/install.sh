#!/bin/sh
# Installs the beeper-inbox release unpacked next to this script into $BEEPER_INBOX_HOME
# (default $HERMES_HOME/beeper-inbox, i.e. /opt/data/beeper-inbox on Hermes Cloud), keeping the previous
# release as app.prev and node_modules.prev, then restarts the daemon on the new code. The device, its
# crypto store and the ledger live in state/ and are never touched here.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
home=${BEEPER_INBOX_HOME:-${HERMES_HOME:-/opt/data}/beeper-inbox}

node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    console.error(`beeper-inbox needs Node 22.5 or newer (node:sqlite); this is ${process.version}`);
    process.exit(1);
  }'

(cd "$here" && sha256sum --quiet -c SHA256SUMS)

mkdir -p "$home"
for dir in app node_modules; do
  rm -rf "$home/$dir.new"
  cp -R "$here/$dir" "$home/$dir.new"
done
for dir in app node_modules; do
  rm -rf "$home/$dir.prev"
  if [ -d "$home/$dir" ]; then mv "$home/$dir" "$home/$dir.prev"; fi
  mv "$home/$dir.new" "$home/$dir"
done
cp "$here/BUILD.json" "$here/pickle.json" "$home/"

echo "installed $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).builtAt)' "$home/BUILD.json") into $home"
node "$home/app/beeper-inbox.mjs" restart
