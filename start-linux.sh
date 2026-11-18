#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if ! command -v node >/dev/null; then echo 'Install Node.js 22+ and rerun this script.' >&2; exit 1; fi
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)' || { echo 'Node.js 22+ is required.' >&2; exit 1; }
command -v ssh >/dev/null
test -f connector.json || { echo 'Download a connector package from the signed-in workbench first.' >&2; exit 1; }
umask 077
if [ ! -d node_modules ]; then npm ci --omit=dev --no-audit --no-fund; fi
exec node agent-connect.mjs
