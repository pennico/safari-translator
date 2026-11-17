#!/usr/bin/env bash
# Once per machine: Playwright in jstest/node_modules and its Chromium. Run again any time; it only adds what's missing.
# Linux: if Chromium misses system libraries, root gets `playwright install-deps`; without root they are unpacked from
# Debian packages into jstest/.libs (git-ignored), which run.sh puts on LD_LIBRARY_PATH. macOS needs none of that.
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules/playwright ] || npm ci --silent --no-audit --no-fund
npx playwright install chromium
[ "$(uname)" = Linux ] || { echo "jstest ready"; exit 0; }
L="$PWD/.libs"
CHROME="$(ls -d "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"/chromium-*/chrome-linux*/chrome 2>/dev/null | tail -1)"
if [ ! -f "$L/fonts.conf" ] && [ -n "$CHROME" ] && ! ldd "$CHROME" | grep -q 'not found'; then
  echo "jstest ready (Chromium's libraries are installed)"; exit 0
fi
if [ ! -f "$L/fonts.conf" ] && [ "$(id -u)" = 0 ]; then
  npx playwright install-deps chromium
  echo "jstest ready"; exit 0
fi
if [ ! -f "$L/fonts.conf" ]; then
  T="$(mktemp -d)"; O="-o Dir::State=$T/state -o Dir::Cache=$T/cache -o Debug::NoLocking=1 -o Dir::State::status=/var/lib/dpkg/status"
  mkdir -p "$T/state/lists/partial" "$T/cache/archives/partial" "$L"
  apt-get $O update -qq
  apt-get $O install -d -y -qq libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libasound2 libatk1.0-0 \
    libatk-bridge2.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 \
    libxcb1 libxkbcommon0 fonts-liberation >/dev/null
  for f in "$T"/cache/archives/*.deb; do dpkg-deb -x "$f" "$L"; done
  rm -rf "$T"
  # system-ui resolves to Liberation Sans, so screenshots show a proportional font as on a real device
  cat > "$L/fonts.conf" <<XML
<?xml version="1.0"?><fontconfig><dir>$L/usr/share/fonts</dir>
<alias binding="same"><family>system-ui</family><prefer><family>Liberation Sans</family></prefer></alias>
<alias binding="same"><family>sans-serif</family><prefer><family>Liberation Sans</family></prefer></alias></fontconfig>
XML
fi
echo "jstest ready (libraries in $L)"
