#!/usr/bin/env bash
# Size report for the Windows build. Target: installer < 30 MB.
set -euo pipefail
cd "$(dirname "$0")/.."
R=target/x86_64-pc-windows-msvc/release
mb() { awk -v b="$(stat -c %s "$1")" 'BEGIN { printf "%.2f MB", b / 1048576 }'; }
row() { [ -f "$2" ] && printf "%-34s %s\n" "$1" "$(mb "$2")" || printf "%-34s (not built)\n" "$1"; }
echo "== HopOn Windows size report =="
row "installer (NSIS, lzma)" "$(ls $R/bundle/nsis/*-setup.exe 2>/dev/null | head -1)"
row "hopon.exe (uncompressed)" "$R/hopon.exe"
row "voice_loopback.exe" "$R/voice_loopback.exe"
row "msg_rtt.exe" "$R/msg_rtt.exe"
js=$(cat client/ui/dist/assets/*.js 2>/dev/null | wc -c); css=$(cat client/ui/dist/assets/*.css 2>/dev/null | wc -c)
printf "%-34s %d KB js + %d KB css\n" "UI bundle" $((js / 1024)) $((css / 1024))
inst=$(ls $R/bundle/nsis/*-setup.exe 2>/dev/null | head -1 || true)
if [ -n "$inst" ]; then
  b=$(stat -c %s "$inst")
  [ "$b" -lt $((30 * 1048576)) ] && echo "installer: within 30 MB target" || echo "installer: OVER 30 MB target"
fi
