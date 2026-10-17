#!/bin/sh
# Lists every place the app could talk to the network or open an outside address.
# Each hit must be justified before release (same-origin app files, the service
# worker, the user-initiated share sheet, Apple Maps links the user taps).
cd "$(dirname "$0")/.." || exit 1
echo "== Network APIs and outside URLs in shipped app files =="
grep -rnE "fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|navigator\.share|https?://|importScripts|<iframe|@import|url\(" \
  index.html sw.js manifest.webmanifest css js icons/icon.svg || true
echo
echo "== Content-Security-Policy =="
grep -o 'Content-Security-Policy" content="[^"]*"' index.html
echo
echo "== Data-destroying IndexedDB calls (must be none) =="
grep -rnE "deleteObjectStore|deleteDatabase|\.clear\(" js sw.js || echo "none"
