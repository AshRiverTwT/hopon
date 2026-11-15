#!/usr/bin/env python3
"""Assemble captured scenes (capture.cjs) into the 30 s trailer.

    python3 assemble.py <captureDir> <out.mp4>

Each scene's frames are placed on its timeline by their capture timestamps,
scaled by the playback rate they were recorded at (slow-motion undone), then
resampled to 60 fps, cut to its in/out points and joined with short fades.
"""
import json, os, subprocess, sys, tempfile

FPS = 60
TOTAL = 30.0
# (scene, in, out) in output seconds; the last scene is cut to make TOTAL exact.
SCENES = [
    ("intro", 0.0, 3.2),
    ("launch", 0.05, 2.3),
    ("dial", 0.25, 4.7),
    ("rail", 0.15, 3.55),
    ("voice", 0.1, 4.5),
    ("profile", 0.1, 3.95),
    ("compare", 0.0, 5.2),
    ("outro", 0.0, 3.9),
]
FADE = 0.22


def run(*args):
    subprocess.run(args, check=True)


def scene_clip(cap, name, t_in, t_out, tmp):
    d = os.path.join(cap, name)
    meta = json.load(open(os.path.join(d, "times.json")))
    rate, start = meta["rate"], meta["start"]
    times = [(t - start) * rate for t in meta["times"]]
    frames = sorted(f for f in os.listdir(d) if f.endswith(".jpg"))
    end = (meta["end"] - start) * rate
    # concat list: each frame lasts until the next one (the last until the end).
    lst = os.path.join(tmp, f"{name}.txt")
    with open(lst, "w") as f:
        first = max(0.0, times[0])
        f.write(f"file '{os.path.join(d, frames[0])}'\nduration {max(1e-3, first + (times[1] - times[0] if len(times) > 1 else end))}\n")
        for i in range(1, len(frames)):
            nxt = times[i + 1] if i + 1 < len(times) else end
            f.write(f"file '{os.path.join(d, frames[i])}'\nduration {max(1e-3, nxt - times[i])}\n")
        f.write(f"file '{os.path.join(d, frames[-1])}'\n")
    clip = os.path.join(tmp, f"{name}.mp4")
    run("ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst,
        "-vf", f"fps={FPS},trim=start={t_in}:end={t_out},setpts=PTS-STARTPTS,scale=1920:1080:flags=lanczos,format=yuv420p",
        "-c:v", "libx264", "-preset", "medium", "-crf", "12", "-r", str(FPS), clip)
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", clip],
                               capture_output=True, text=True, check=True).stdout)
    return clip, dur


def main():
    cap, out = sys.argv[1], sys.argv[2]
    tmp = tempfile.mkdtemp(prefix="trailer-")
    clips = [scene_clip(cap, *s, tmp) for s in SCENES]
    # Make the total exact by trimming (or holding) the final scene.
    total = sum(d for _, d in clips) - FADE * (len(clips) - 1)
    last_path, last_len = clips[-1]
    want = last_len + (TOTAL - total)
    fixed = os.path.join(tmp, "last.mp4")
    run("ffmpeg", "-v", "error", "-y", "-i", last_path, "-vf", f"tpad=stop_mode=clone:stop_duration=4,trim=duration={want},setpts=PTS-STARTPTS",
        "-c:v", "libx264", "-preset", "medium", "-crf", "12", "-r", str(FPS), fixed)
    clips[-1] = (fixed, want)
    inputs, filt, prev, offset = [], [], "[0:v]", 0.0
    for i, (path, dur) in enumerate(clips):
        inputs += ["-i", path]
        if i == 0:
            offset = dur - FADE
            continue
        label = f"[x{i}]"
        filt.append(f"{prev}[{i}:v]xfade=transition=fade:duration={FADE}:offset={offset:.3f}{label}")
        prev = label
        offset += dur - FADE
    # Fade in from black at the start and out at the end.
    filt.append(f"{prev}fade=t=in:st=0:d=0.35,fade=t=out:st={TOTAL - 0.6}:d=0.6,format=yuv420p[v]")
    run("ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(filt), "-map", "[v]",
        "-t", str(TOTAL), "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-profile:v", "high",
        "-pix_fmt", "yuv420p", "-r", str(FPS), "-movflags", "+faststart", out)
    print(out)


if __name__ == "__main__":
    main()
