#!/bin/bash
# Puts the built app in /Applications, where you can find it.
#
#   npm run pack && npm run install-app
#
# Only worth running after a build. It replaces whatever is already installed.

set -euo pipefail

cd "$(dirname "$0")/.."

case "$(uname -m)" in
  arm64) BUILT="dist/mac-arm64/Session Board.app" ;;
  *)     BUILT="dist/mac/Session Board.app" ;;
esac

if [ ! -d "$BUILT" ]; then
  echo "No build at $BUILT — run 'npm run pack' or 'npm run dist' first." >&2
  exit 1
fi

TARGET="/Applications/Session Board.app"
LSR="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

# A running copy cannot be replaced cleanly. Both the installed app and an
# `npm start` copy hold the single-instance lock, so clear either one out.
pkill -f "Session Board.app/Contents/MacOS/Session Board" 2>/dev/null || true
sleep 1

rm -rf "$TARGET"
ditto "$BUILT" "$TARGET"

# The build is unsigned. A copy made on this machine is not quarantined, but a
# copy that has been through a disk image or a download is, and Gatekeeper
# reports that as "damaged" rather than as unsigned.
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true

# Register the installed copy and take the build output back out of the
# database, or the app shows up twice, once from dist/.
"$LSR" -f "$TARGET"
"$LSR" -u -R "$PWD/dist" 2>/dev/null || true

echo "Installed to $TARGET"
