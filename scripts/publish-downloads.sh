#!/usr/bin/env bash
# Package the Windows kit and publish it, the installer and screenshots to the
# `downloads` branch (binary-only branch; never merged).
#   scripts/publish-downloads.sh [screenshot.png ...]
set -euo pipefail
cd "$(dirname "$0")/.."
R=target/x86_64-pc-windows-msvc/release
K=dist/hopon-windows-kit
mkdir -p "$K"
cp "$R/bundle/nsis/HopOn_0.1.0_x64-setup.exe" "$R/hopon-server.exe" "$R/msg_rtt.exe" "$R/smoke.exe" \
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
cp dist/hopon-windows-kit.zip "$R/bundle/nsis/HopOn_0.1.0_x64-setup.exe" "$wt/"
mkdir -p "$wt/screens"
shots=""
for f in "$@"; do cp "$f" "$wt/screens/"; shots="$shots![$(basename "$f" .png)](screens/$(basename "$f"))"$'\n'; done
cat > "$wt/README.md" <<EOF
# HopOn downloads

- [HopOn_0.1.0_x64-setup.exe](HopOn_0.1.0_x64-setup.exe): Windows installer (latest)
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
