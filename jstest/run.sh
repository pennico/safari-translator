#!/usr/bin/env bash
# Run a jstest script, with the unpacked Chromium libraries when setup.sh made them. usage: ./run.sh test.mjs [args]
set -euo pipefail
cd "$(dirname "$0")"
L="$PWD/.libs"
if [ -f "$L/fonts.conf" ]; then
  export LD_LIBRARY_PATH="$L/usr/lib/x86_64-linux-gnu:$L/lib/x86_64-linux-gnu" FONTCONFIG_FILE="$L/fonts.conf"
fi
exec node "$@"
