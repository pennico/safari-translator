#!/bin/bash
# Builds the Safari app "Translator for Safari" on a Mac and installs it:
#   1. Apple's converter turns extension/ into an Xcode project (build/mac/, git-ignored; it references extension/,
#      it doesn't copy it),
#   2. xcodebuild signs it with this Mac's "Apple Development" identity (manual signing, no provisioning profile:
#      the app only has the sandbox entitlements the converter adds), or ad hoc with --unsigned,
#   3. the app goes to ~/Applications and is opened once, so Safari lists the extension.
# usage: tools/mac-build.sh [--no-install] [--unsigned]
#   --no-install  only build (the app stays in build/mac/DerivedData)
#   --unsigned    no certificate: ad hoc signature; Safari then needs Developer › "Allow unsigned extensions"
#   BUNDLE_ID=…   environment: another bundle id (default below); the extension gets <BUNDLE_ID>.Extension
# needs: macOS with full Xcode (not only the command line tools); for a signed build an Apple Development certificate
#        in the keychain (a free Apple ID is enough: Xcode › Settings › Accounts › Manage Certificates › +).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="Translator for Safari"
BUNDLE_ID="${BUNDLE_ID:-dk.pennico.safari-translator}"
EXT_ID="$BUNDLE_ID.Extension"
OUT="$ROOT/build/mac"
DEST="$HOME/Applications"
INSTALL=1
SIGNED=1
for a in "$@"; do
  case "$a" in
    --no-install) INSTALL=0 ;;
    --unsigned) SIGNED=0 ;;
    *) printf 'usage: %s [--no-install] [--unsigned]\n' "$0" >&2; exit 2 ;;
  esac
done

say() { printf '\n== %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
plist_id() { /usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null || true; }
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

[[ "$(uname)" == Darwin ]] || die "run this on a Mac"
DEV_DIR="$(xcode-select -p 2>/dev/null || true)"
[[ "$DEV_DIR" == *Xcode*.app/* ]] || die "needs full Xcode (xcode-select -p: '${DEV_DIR:-none}'). Install Xcode, then: sudo xcode-select -s /Applications/Xcode.app"
xcrun --find safari-web-extension-converter >/dev/null || die "safari-web-extension-converter not found in this Xcode"

say "Signing identity"
if [[ "$SIGNED" == 1 ]]; then
  IDENTITY="$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development/ { print $2; exit }')"
  [[ -n "$IDENTITY" ]] || die "no 'Apple Development' identity in the keychain (security find-identity -v -p codesigning).
  Add one with a free Apple ID: Xcode › Settings › Accounts › your Apple ID › Manage Certificates › + › Apple Development.
  Or build with --unsigned (Safari then needs Developer › Allow unsigned extensions, after every Safari start)."
  # The team id is the certificate's OU (the value in parentheses in the name is not always the team).
  TEAM="$(security find-certificate -c "$IDENTITY" -p | openssl x509 -noout -subject | sed -n 's/.*OU *= *\([A-Z0-9]\{10\}\).*/\1/p')"
  [[ -n "$TEAM" ]] || die "could not read the team id (OU) from '$IDENTITY'"
  echo "$IDENTITY · team $TEAM"
  SIGN_ARGS=(CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="$IDENTITY" DEVELOPMENT_TEAM="$TEAM" PROVISIONING_PROFILE_SPECIFIER="")
else
  echo "ad hoc (--unsigned)"
  SIGN_ARGS=(CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="-" DEVELOPMENT_TEAM="" PROVISIONING_PROFILE_SPECIFIER="")
fi

VERSION="$(plutil -extract version raw -o - "$ROOT/extension/manifest.json")"
BUILD="$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)"
echo "version $VERSION ($BUILD) · bundle id $BUNDLE_ID"

say "Converting extension/ to an Xcode project"
rm -rf "$OUT"
mkdir -p "$OUT"
xcrun safari-web-extension-converter "$ROOT/extension" \
  --project-location "$OUT" --app-name "$NAME" --bundle-identifier "$BUNDLE_ID" \
  --macos-only --swift --no-open --no-prompt --force
PROJ="$(find "$OUT" -maxdepth 3 -name '*.xcodeproj' | head -1)"
[[ -n "$PROJ" ]] || die "the converter made no Xcode project (see its output above)"
# The converter (seen with Xcode 27.2) names the app <prefix>.<app name> (e.g. com.example.Translator) but the
# extension <bundle id>.Extension, and the extension's id must start with the app's. So every id under the same
# prefix that isn't ours yet becomes ours: …Extension → $EXT_ID, the rest → $BUNDLE_ID. The app name may come
# through with its spaces kept, dropped, or turned into "-" or "_". Xcode 27 writes project.xcproj, older project.pbxproj.
PBX="$(find "$PROJ" -maxdepth 1 \( -name project.xcproj -o -name project.pbxproj \) | head -1)"
[[ -n "$PBX" ]] || die "no project file in $PROJ"
PREFIX="${BUNDLE_ID%.*}"
re() { printf '%s' "$1" | sed 's/[.[\*^$/]/\\&/g'; }
{
  for n in "$NAME" "${NAME// /}" "${NAME// /-}" "${NAME// /_}"; do echo "$PREFIX.$n"; echo "$PREFIX.$n.Extension"; done
  grep -oE "$(re "$PREFIX")\.[A-Za-z0-9._-]+" "$PBX" || true
} | sort -u | while IFS= read -r id; do
  [[ "$id" == "$BUNDLE_ID" || "$id" == "$BUNDLE_ID".* ]] && continue
  grep -q -F -e "\"$id\"" -e "= $id;" "$PBX" || continue
  if [[ "$id" == *.Extension ]]; then to="$EXT_ID"; else to="$BUNDLE_ID"; fi
  echo "bundle id: $id → $to"
  sed -i '' -e "s/\"$(re "$id")\"/\"$to\"/g" -e "s/= $(re "$id");/= $to;/g" "$PBX"
done
SCHEME="$(xcodebuild -list -project "$PROJ" | awk '/Schemes:/ { s = 1; next } s && NF { sub(/^ +/, ""); if ($0 !~ /Extension/) { print; exit } }')"
[[ -n "$SCHEME" ]] || die "no app scheme in $PROJ (xcodebuild -list -project \"$PROJ\")"
echo "project $PROJ · scheme $SCHEME"

say "Building (Release)"
xcodebuild -project "$PROJ" -scheme "$SCHEME" -configuration Release -derivedDataPath "$OUT/DerivedData" \
  "${SIGN_ARGS[@]}" MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" \
  build > "$OUT/xcodebuild.log" 2>&1 || true
grep -E "^(\*\*|error|warning: .*(sign|entitle))" "$OUT/xcodebuild.log" || true
grep -q '^\*\* BUILD SUCCEEDED \*\*' "$OUT/xcodebuild.log" || die "build failed (full log: $OUT/xcodebuild.log)"
APP="$(find "$OUT/DerivedData/Build/Products/Release" -maxdepth 1 -name '*.app' | head -1)"
[[ -n "$APP" && -d "$APP" ]] || die "build failed: no app in $OUT/DerivedData/Build/Products/Release (full log: $OUT/xcodebuild.log)"
APPEX="$(find "$APP/Contents/PlugIns" -maxdepth 1 -name '*.appex' | head -1)"
[[ -n "$APPEX" ]] || die "no extension (.appex) inside $APP"
[[ "$(plist_id "$APP")" == "$BUNDLE_ID" ]] || die "the app's bundle id is '$(plist_id "$APP")', not $BUNDLE_ID"
[[ "$(plist_id "$APPEX")" == "$EXT_ID" ]] || die "the extension's bundle id is '$(plist_id "$APPEX")', not $EXT_ID"
echo "built $(basename "$APP")"

say "Checking the signature"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv "$APP" 2>&1 | grep -E "^(Authority=|TeamIdentifier|Signature=adhoc)" || true
codesign -dv "$APPEX" 2>&1 | grep -E "^(Identifier|TeamIdentifier)" || true

if [[ "$INSTALL" == 1 ]]; then
  TARGET="$DEST/$NAME.app"
  say "Installing to $TARGET"
  mkdir -p "$DEST"
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  # Older builds with the same bundle id under another name (0.1.0 was "Translator.app"): remove them, so Safari
  # sees one extension. Settings and downloaded models stay: they belong to the bundle id, not the app's name.
  for old in "$DEST"/*.app; do
    [[ -d "$old" && "$old" != "$TARGET" && "$(plist_id "$old")" == "$BUNDLE_ID" ]] || continue
    echo "removing the older copy $old"
    "$LSREG" -u "$old" >/dev/null 2>&1 || true
    rm -rf "$old"
  done
  rm -rf "$TARGET"
  ditto "$APP" "$TARGET"
  # Only one copy may be registered, or Safari can pick the build folder's copy.
  "$LSREG" -u "$APP" >/dev/null 2>&1 || true
  rm -rf "$OUT/DerivedData/Build/Products"
  "$LSREG" -f "$TARGET" >/dev/null 2>&1 || true
  open "$TARGET"
  sleep 2
  say "Safari extensions known to the system (look for $EXT_ID)"
  pluginkit -m -v -p com.apple.Safari.web-extension 2>/dev/null | grep -i "$BUNDLE_ID" || echo "(not listed yet: open Safari once, then check Settings › Extensions)"
  UNSIGNED_NOTE=""
  [[ "$SIGNED" == 0 ]] && UNSIGNED_NOTE="
Unsigned build: first Safari › Settings › Advanced › tick \"Show features for web developers\", then Settings ›
Developer › tick \"Allow unsigned extensions\". Safari turns that off whenever it quits."
  cat <<EOF
$UNSIGNED_NOTE
Done. Now in Safari: Settings › Extensions › tick "$NAME", then "Edit Websites…" › "Allow" for "Other websites"
(or "Always Allow on Every Website" when Safari asks). If it is missing, see BUILD.md.
EOF
fi
