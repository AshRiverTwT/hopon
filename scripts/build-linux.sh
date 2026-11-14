#!/usr/bin/env bash
# Build the Linux AppImage (x86_64; runs on Arch, Fedora, Ubuntu, …).
#   scripts/build-linux.sh
# Needs: Rust, node + pnpm, the WebKitGTK 4.1 / GTK 3 / ayatana-appindicator
# dev packages, and clang >= 21 (the prebuilt libwebrtc ships a hermetic
# libc++ that older clang can't compile against).
set -euo pipefail
cd "$(dirname "$0")/.."
LLVM=${LLVM:-/usr/lib/llvm-21/bin}
export CC="$LLVM/clang" CXX="$LLVM/clang++" AR="$LLVM/llvm-ar"
# Build on the oldest glibc you can: the AppImage runs on that glibc and newer
# (Arch is always newer). NO_STRIP: linuxdeploy's bundled strip chokes on new ELF sections.
export NO_STRIP=true
# AppImage tools are AppImages themselves; run them without FUSE (containers, CI).
export APPIMAGE_EXTRACT_AND_RUN=1
VER=$(python3 -c 'import json; print(json.load(open("client/src-tauri/tauri.conf.json"))["version"])')
rm -f target/release/bundle/appimage/HopOn_*.AppImage
(cd client/src-tauri && ../ui/node_modules/.bin/tauri build --bundles appimage --verbose)
OUT=target/release/bundle/appimage/HopOn_${VER}_amd64.AppImage
# Repack with max zstd + 1 MiB blocks: ~9% smaller, keeping the bundled WebKit and
# GStreamer under GitHub's 100 MB file limit. Uses the appimagetool Tauri downloaded.
TOOLS=target/appimagetool
if [ ! -x "$TOOLS/usr/bin/appimagetool" ]; then
  rm -rf "$TOOLS" && mkdir -p "$TOOLS"
  (cd "$TOOLS" && "$HOME/.cache/tauri/linuxdeploy-plugin-appimage.AppImage" --appimage-extract >/dev/null && mv squashfs-root/* squashfs-root/.[!.]* . 2>/dev/null; rmdir squashfs-root 2>/dev/null || true)
fi
rm -f "$OUT"
ARCH=x86_64 "$TOOLS/usr/bin/appimagetool" -n \
  --mksquashfs-opt -Xcompression-level --mksquashfs-opt 22 --mksquashfs-opt -b --mksquashfs-opt 1M \
  target/release/bundle/appimage/HopOn.AppDir "$OUT" >/dev/null
ls -l "$OUT"
echo "AppImage: $(du -h "$OUT" | cut -f1)"
# The downloads branch is plain git on GitHub: files over 100 MB are refused.
SIZE=$(stat -c %s "$OUT")
if [ "$SIZE" -gt $((99 * 1024 * 1024)) ]; then
  echo "AppImage is $((SIZE / 1048576)) MB: over GitHub's 100 MB file limit" >&2
  exit 1
fi
