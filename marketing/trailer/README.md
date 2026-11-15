# HopOn trailer (30 s, 1080p60, silent)

Filmed from the real app UI (the dev-only `client/ui/trailer.html`, with curated
content) and three designed scenes (`client/ui/trailer-scenes.html`: logo intro,
the HopOn vs Discord comparison, outro).

## 1. Measure (on a Windows PC with both apps installed and signed in)

```powershell
powershell -ExecutionPolicy Bypass -File measure.ps1
```

It closes both apps between runs, then writes `hopon-vs-discord.json` to the
Desktop: median launch time (until the main window shows stable, rendered
content, judged from its pixels) and memory (private working set of the whole
process tree, 20 s after launch), with the machine and method recorded.

## 2. Render

```bash
cd client/ui && pnpm dev            # serves the pages on :5173
cd marketing/trailer
NUMBERS=/path/to/hopon-vs-discord.json node capture.cjs /tmp/trailer-frames
python3 assemble.py /tmp/trailer-frames hopon-trailer.mp4
```

Without `NUMBERS` the comparison scene renders as a marked draft.

`capture.cjs` records each scene with the CDP screencast while the page's
animations run slowed down; `assemble.py` places frames by their timestamps,
undoes the slow-down, resamples to 60 fps and joins the scenes (exactly 30 s).
Needs Playwright with Chromium (`PLAYWRIGHT=/path/to/playwright` if it isn't
resolvable) and ffmpeg with libx264.
