#!/usr/bin/env bash
# Package the Windows kit and publish it, the installer and screenshots to the
# `downloads` branch (binary-only branch; never merged).
#   scripts/publish-downloads.sh [screenshot.png ...]
set -euo pipefail
cd "$(dirname "$0")/.."
R=target/x86_64-pc-windows-msvc/release
K=dist/hopon-windows-kit
VER=$(python3 -c 'import json; print(json.load(open("client/src-tauri/tauri.conf.json"))["version"])')
SETUP="$R/bundle/nsis/HopOn_${VER}_x64-setup.exe"
rm -rf "$K" && mkdir -p "$K"
# Stable name, so download links never go stale.
cp "$SETUP" "$K/HopOn-setup.exe"
cp "$R/hopon-server.exe" "$R/msg_rtt.exe" "$R/smoke.exe" \
   "$R/voice_loopback.exe" "$R/voice_grant_check.exe" scripts/measure-windows.ps1 scripts/windows-kit/* "$K/"
python3 - <<'PY'
import os, zipfile
os.chdir("dist")
with zipfile.ZipFile("hopon-windows-kit.zip", "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for f in sorted(os.listdir("hopon-windows-kit")):
        z.write(os.path.join("hopon-windows-kit", f))
PY
rev=$(git rev-parse --short HEAD)
wt=$(mktemp -d)
git fetch -q origin downloads
git worktree add -q --detach "$wt" origin/downloads
rm -f "$wt"/HopOn_*_x64-setup.exe
cp dist/hopon-windows-kit.zip "$wt/"
cp "$SETUP" "$wt/HopOn-setup.exe"
mkdir -p "$wt/screens"
shots=""
for f in "$@"; do cp "$f" "$wt/screens/"; shots="$shots![$(basename "$f" .png)](screens/$(basename "$f"))"$'\n'; done
cat > "$wt/README.md" <<EOF
# HopOn downloads

- [HopOn-setup.exe](HopOn-setup.exe): Windows installer, version $VER (latest)
- [hopon-windows-kit.zip](hopon-windows-kit.zip): local test kit (installer, server, benchmarks, scripts)

Built from branch \`main\` at $rev.

$shots
EOF
(
  cd "$wt"
  git add -A
  git commit -qm "Downloads at $rev

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CcWXzAm1Td6CAPRiwzZTSK"
  git push -q origin HEAD:downloads
)
git worktree remove --force "$wt"
echo "published downloads at $rev"
