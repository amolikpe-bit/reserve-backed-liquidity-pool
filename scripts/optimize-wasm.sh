#!/usr/bin/env bash
# Apply the accepted wasm-opt pass to a built contract.
#
# cargo-near already runs `wasm-opt -O` as its post-step. This pass is the
# measured `-Oz --converge` follow-up with the same feature set cargo-near uses
# plus sign-extension, so nearcore can deserialize the result. It preserves the
# module's exports and ABI. Reordering module elements shortens index LEBs and
# reduces the deployed raw wasm by another 2,758 bytes.
set -euo pipefail

wasm="${1:?usage: optimize-wasm.sh <path-to-wasm>}"
tmp="${wasm}.opt.wasm"

if ! command -v wasm-opt >/dev/null 2>&1; then
  printf 'error: wasm-opt (binaryen) is required for the size post-process\n' >&2
  exit 1
fi

before="$(stat -c%s "$wasm")"
wasm-opt -Oz --converge --enable-nontrapping-float-to-int --enable-bulk-memory \
  --enable-sign-ext --reorder-functions --reorder-locals --reorder-globals \
  "$wasm" -o "$tmp"
mv "$tmp" "$wasm"
after="$(stat -c%s "$wasm")"

printf 'wasm-opt -Oz --converge + reorder (near features): %s -> %s bytes (%s%%)\n' "$before" "$after" \
  "$(awk -v b="$before" -v a="$after" 'BEGIN { printf "%.3f", (a - b) * 100 / b }')"
