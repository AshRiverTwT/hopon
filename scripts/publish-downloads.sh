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
branch=$(git rev-parse --abbrev-ref HEAD)
wt=$(mktemp -d)
git fetch -q origin downloads
git worktree add -q --detach "$wt" origin/downloads
rm -f "$wt"/HopOn_*_x64-setup.exe
cp dist/hopon-windows-kit.zip "$wt/"
cp "$SETUP" "$wt/HopOn-setup.exe"
# What in-app updates read: version, installer URL, SHA-256, release notes.
python3 - "$VER" "$SETUP" "$wt/latest.json" <<'PY'
import hashlib, json, re, sys
ver, setup, out = sys.argv[1:4]
sha = hashlib.sha256(open(setup, "rb").read()).hexdigest()
notes = ""
try:
    text = open("RELEASE_NOTES.md", encoding="utf-8").read()
    m = re.search(r"^## HopOn " + re.escape(ver) + r"\n(.*?)(?=^## |\Z)", text, re.S | re.M)
    notes = (m.group(1).strip() if m else "")[:2000]
except OSError:
    pass
json.dump({"version": ver, "url": "https://github.com/AshRiverTwT/hopon/raw/downloads/HopOn-setup.exe", "sha256": sha, "notes": notes}, open(out, "w"), indent=2)
PY
mkdir -p "$wt/screens"
shots=""
for f in "$@"; do cp "$f" "$wt/screens/"; shots="$shots![$(basename "$f" .png)](screens/$(basename "$f"))"$'\n'; done
cat > "$wt/README.md" <<EOF
# HopOn downloads

- [HopOn-setup.exe](HopOn-setup.exe): Windows installer, version $VER (latest)
- [hopon-windows-kit.zip](hopon-windows-kit.zip): local test kit (installer, server, benchmarks, scripts)

Built from branch \`$branch\` at $rev.

$shots
EOF
(
  cd "$wt"
  git add -A
  git commit -qm "Downloads at $rev

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CcWXz7DJtjs9RpBCxmHEbN"
  git push -q origin HEAD:downloads
)
git worktree remove --force "$wt"
echo "published downloads at $rev"
