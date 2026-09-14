#!/bin/bash
# Run from a normal macOS GUI login session. No prompt or evaluation is submitted.
set -euo pipefail
umask 077
if [[ $# -ne 2 || "$(uname -s)" != Darwin ]]; then
  echo 'Usage: bash scripts/run-cowork-mac-smoke.sh <private-env-file> <Claude-3p-configLibrary>' >&2
  exit 2
fi
CREDENTIALS=$1
PROFILE=$2
ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$ROOT"
mkdir -p .cowork-runtime
BUILD=$(mktemp -d "$ROOT/.cowork-runtime/build-XXXXXX")
trap 'rm -rf -- "$BUILD"' EXIT
SDK=$(xcrun --show-sdk-path)
node node_modules/typescript/bin/tsc \
  --outDir "$BUILD/dist" --rootDir src --module NodeNext --target ES2022 \
  --esModuleInterop --skipLibCheck --strict src/evals/coworkSetup/macTransaction.ts
swiftc -sdk "$SDK" -module-cache-path "$BUILD/swift-cache" \
  scripts/cowork-macos-app.swift -o "$BUILD/cowork-macos-app"
node scripts/cowork-mac-smoke.mjs "$PROFILE" "$CREDENTIALS" \
  "$BUILD/dist/evals/coworkSetup/macTransaction.js" "$BUILD/cowork-macos-app"
