#!/usr/bin/env bash
# Cross-build the Windows client, installer and benchmarks from Linux.
# Needs: rustup target x86_64-pc-windows-msvc, cargo-xwin, clang >= 19
# (MSVC STL requirement), lld, nsis (makensis), node + pnpm.
set -euo pipefail
cd "$(dirname "$0")/.."
LLVM_BIN=${LLVM_BIN:-/usr/lib/llvm-19/bin}
[ -x "$LLVM_BIN/clang" ] && export PATH="$LLVM_BIN:$PATH"
# cargo-xwin calls clang-cl; make sure it resolves to clang >= 19.
[ -e "$LLVM_BIN/clang-cl" ] || ln -s clang "$LLVM_BIN/clang-cl" 2>/dev/null || true
(cd client/ui && pnpm install --frozen-lockfile)
(cd client/src-tauri && ../ui/node_modules/.bin/tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc)
cargo xwin build --release --target x86_64-pc-windows-msvc -p hopon-bench --features voice
# The local test kit's server must match the app's protocol version.
cargo xwin build --release --target x86_64-pc-windows-msvc -p hopon-server
scripts/size-report.sh
