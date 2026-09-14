#!/bin/bash
# Configure and leave Claude open, or explicitly restore a managed manual session.
set -euo pipefail
umask 077
if [[ "$(uname -s)" != Darwin || $# -lt 2 ]]; then
  echo 'Usage: bash scripts/cowork-mac-config.sh configure <manifest> <private-env-file> <configLibrary>' >&2
  echo '   or: bash scripts/cowork-mac-config.sh restore <configLibrary>' >&2
  exit 2
fi
ACTION=$1
shift
if [[ "$ACTION" == configure && $# -ne 3 ]] || [[ "$ACTION" == restore && $# -ne 1 ]] || [[ "$ACTION" != configure && "$ACTION" != restore ]]; then
  echo 'Invalid configuration command arguments.' >&2
  exit 2
fi
ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$ROOT"
mkdir -p .cowork-runtime
BUILD=$(mktemp -d "$ROOT/.cowork-runtime/build-XXXXXX")
trap 'rm -rf -- "$BUILD"' EXIT
SDK=$(xcrun --show-sdk-path)
echo 'Building setup adapter...'
node node_modules/typescript/bin/tsc \
  --outDir "$BUILD/dist" --rootDir src --module NodeNext --target ES2022 \
  --esModuleInterop --skipLibCheck --strict \
  src/evals/coworkSetup/macTransaction.ts src/evals/evalManifest.ts
echo 'Building native macOS app controller...'
swiftc -sdk "$SDK" -module-cache-path "$BUILD/swift-cache" \
  scripts/cowork-macos-app.swift -o "$BUILD/cowork-macos-app"
echo "Running configuration action: $ACTION"
node scripts/cowork-mac-config.mjs "$ACTION" "$BUILD/dist" \
  "$BUILD/cowork-macos-app" "$@"
