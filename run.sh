#!/usr/bin/env bash
# One command to start the rig.
set -euo pipefail
cd "$(dirname "$0")"

# Prefer the system interpreter when it already has everything; otherwise let
# uv assemble an ephemeral environment. Either way there is nothing to install
# by hand and no venv to manage.
if python3 -c "import websockets, numpy, segno" >/dev/null 2>&1; then
  exec python3 server.py "$@"
elif command -v uv >/dev/null 2>&1; then
  exec uv run --quiet \
      --with "websockets>=14" --with segno --with numpy \
      python server.py "$@"
else
  echo "note: segno not installed -- printing the URL without a QR code" >&2
  exec python3 server.py "$@"
fi
