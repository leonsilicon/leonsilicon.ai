#!/bin/sh
# Installs the beeperd release unpacked next to this script into $BEEPERD_HOME (default
# $HERMES_HOME/beeperd, i.e. /opt/data/beeperd on Hermes Cloud), keeping the previous binary as
# bin/beeperd.prev. The device, its crypto store, the journal and the services' settings live beside
# bin/ and are never touched here. With --restart it restarts a running daemon on the new binary.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
home=${BEEPERD_HOME:-${HERMES_HOME:-/opt/data}/beeperd}

(cd "$here" && sha256sum --quiet -c SHA256SUMS)
"$here/beeperd" version >/dev/null

mkdir -p "$home/bin"
cp "$here/beeperd" "$home/bin/beeperd.new"
chmod 755 "$home/bin/beeperd.new"
if [ -f "$home/bin/beeperd" ]; then cp -p "$home/bin/beeperd" "$home/bin/beeperd.prev"; fi
# A rename, so a running daemon keeps its old file and new processes get the new one.
mv "$home/bin/beeperd.new" "$home/bin/beeperd"
cp "$here/BUILD.json" "$home/"

echo "installed beeperd $("$home/bin/beeperd" version) into $home/bin"
if [ "${1:-}" = "--restart" ]; then
  BEEPERD_HOME="$home" "$home/bin/beeperd" restart >/dev/null
  echo "restarted"
fi
