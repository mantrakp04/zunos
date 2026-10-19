#!/usr/bin/env bash
# Builds the downloadable zunos.dmg: Release build, the Python engine and a uv binary embedded in
# Resources/engine, code signing, optional notarization.
#
# Required env (baked into the JS bundle):
#   EXPO_PUBLIC_HEXCLAVE_PROJECT_ID, EXPO_PUBLIC_HEXCLAVE_PUBLISHABLE_CLIENT_KEY
#   EXPO_PUBLIC_ZUNOS_API_URL        training backend (apps/api) URL
#   EXPO_PUBLIC_ZUNOS_OTP_CALLBACK   an https URL on a Hexclave trusted domain
# Optional:
#   APPLE_SIGNING_IDENTITY           "Developer ID Application: …" (ad-hoc signature without it)
#   APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD   notarize and staple when all three are set
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$APP_DIR/../.." && pwd)"
OUT="$APP_DIR/dist"
BUILD="$APP_DIR/macos/build"
APP="$BUILD/Build/Products/Release/zunos.app"

for v in EXPO_PUBLIC_HEXCLAVE_PROJECT_ID EXPO_PUBLIC_HEXCLAVE_PUBLISHABLE_CLIENT_KEY EXPO_PUBLIC_ZUNOS_API_URL EXPO_PUBLIC_ZUNOS_OTP_CALLBACK; do
  [ -n "${!v:-}" ] || { echo "missing $v" >&2; exit 1; }
done
unset EXPO_PUBLIC_ZUNOS_REPO # packaged builds run the embedded engine, never the repo

echo "==> Release build"
(cd "$APP_DIR/macos" && pod install >/dev/null && xcodebuild -workspace zunos.xcworkspace -scheme zunos-macOS \
  -configuration Release -derivedDataPath build -destination 'platform=macOS' build | tail -3)

echo "==> Embedding the engine"
ENGINE="$APP/Contents/Resources/engine"
rm -rf "$ENGINE" && mkdir -p "$ENGINE/bin" "$ENGINE/python"
cp "$(command -v uv)" "$ENGINE/bin/uv"
rsync -a --exclude .venv --exclude __pycache__ --exclude '*.pyc' \
  "$REPO/python/pyproject.toml" "$REPO/python/uv.lock" "$REPO/python/.python-version" \
  "$REPO/python/core" "$REPO/python/engine" "$ENGINE/python/"

echo "==> Signing"
IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
ENTITLEMENTS="$APP_DIR/macos/zunos-macOS/zunos.entitlements"
codesign --force --options runtime --timestamp=none --sign "$IDENTITY" "$ENGINE/bin/uv"
codesign --force --deep --options runtime --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict "$APP"

echo "==> DMG"
mkdir -p "$OUT"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/" && ln -s /Applications "$STAGE/Applications"
DMG="$OUT/zunos.dmg"
rm -f "$DMG"
hdiutil create -volname zunos -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
[ "$IDENTITY" = "-" ] || codesign --sign "$IDENTITY" "$DMG"

if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ]; then
  echo "==> Notarizing"
  xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait
  xcrun stapler staple "$DMG"
else
  echo "(not notarized: set APPLE_ID, APPLE_TEAM_ID and APPLE_APP_PASSWORD to notarize)"
fi
echo "==> $DMG"
