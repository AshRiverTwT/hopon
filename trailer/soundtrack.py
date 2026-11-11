"""Synthesizes the trailer soundtrack (30 s, 120 BPM) to trailer/out/soundtrack.wav.
Everything is generated here, so there are no licensing questions. Cue times
match the timeline in index.html."""
import wave
from pathlib import Path

import numpy as np

SR = 44100
DUR = 30.0
N = int(SR * DUR)
rng = np.random.default_rng(7)
L = np.zeros(N)
R = np.zeros(N)


def add(sig, t, gain=1.0, pan=0.0):
    i = int(t * SR)
    if i >= N:
        return
    sig = sig[: N - i]
    L[i : i + len(sig)] += sig * gain * (1 - max(0, pan))
    R[i : i + len(sig)] += sig * gain * (1 + min(0, pan))


def env(n, a, d):
    """Attack/exponential-decay envelope, times in seconds."""
    t = np.arange(n) / SR
    e = np.exp(-t / d)
    na = max(1, int(a * SR))
    e[:na] *= np.linspace(0, 1, na)
    return e


def lowpass(x, cutoff):
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc = (1 - a) * v + a * acc
        y[i] = acc
    return y


def kick():
    n = int(.45 * SR)
    t = np.arange(n) / SR
    f = 48 + 110 * np.exp(-t / .035)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * env(n, .001, .16) + .25 * rng.standard_normal(n) * env(n, .0005, .004)


def hat(open_=False):
    n = int((.25 if open_ else .06) * SR)
    x = rng.standard_normal(n)
    x = x - lowpass(x, 7000)
    return x * env(n, .0005, .07 if open_ else .015)


def clap():
    n = int(.3 * SR)
    x = rng.standard_normal(n)
    x = lowpass(x - lowpass(x, 900), 5000)
    e = env(n, .001, .09)
    for k in (0.0, .011, .022):
        e += np.roll(env(n, .0005, .008), int(k * SR)) * .6
    return x * e


def tone(freq, dur, a=.01, d=.3, wave_="sine", harm=()):
    n = int(dur * SR)
    t = np.arange(n) / SR
    s = np.sin(2 * np.pi * freq * t)
    for h, g in harm:
        s += g * np.sin(2 * np.pi * freq * h * t)
    if wave_ == "saw":
        s = 2 * ((t * freq) % 1) - 1
        s = lowpass(s, 1400)
    return s * env(n, a, d)


def whoosh(dur=.6, rev=False):
    n = int(dur * SR)
    x = rng.standard_normal(n)
    x = lowpass(x, 3000) - lowpass(x, 300)
    shape = np.sin(np.linspace(0, np.pi, n)) ** 2
    if rev:
        shape = np.linspace(0, 1, n) ** 3
    return x * shape


def riser(dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = rng.standard_normal(n)
    x = x - lowpass(x, 600)
    f = 200 + 1600 * (t / dur) ** 2
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * .3
    return (lowpass(x, 6000) * .6 + s) * (t / dur) ** 2.5


def impact():
    n = int(2.2 * SR)
    t = np.arange(n) / SR
    f = 38 + 80 * np.exp(-t / .06)
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, .001, .7)
    noise = lowpass(rng.standard_normal(n), 2500) * env(n, .001, .25)
    return boom + .5 * noise


def pad(freqs, dur, gain=.12):
    n = int(dur * SR)
    t = np.arange(n) / SR
    s = np.zeros(n)
    for f in freqs:
        for det in (-0.12, 0.0, 0.12):
            ff = f * 2 ** (det / 12)
            s += 2 * ((t * ff + rng.random()) % 1) - 1
    s = lowpass(s, 1100)
    fade = min(.4, dur / 3)
    e = np.minimum(1, np.minimum(t / fade, (dur - t) / fade))
    return s * e * gain / len(freqs)


def midi(m):
    return 440 * 2 ** ((m - 69) / 12)


BEAT = .5
# Chord loop (A minor feel): Am, F, C, G — 2 s each.
CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]
ROOTS = [33, 29, 36, 31]

# Intro: riser into the wordmark slam at 1.25 s.
add(riser(1.2), .05, .5)
add(impact(), 1.25, .9)
add(pad([midi(m + 12) for m in CHORDS[0]], 2.0, .10), 1.25)

# Main groove 3.2 → 25.5 s, then a short break before the end hit.
start, stop = 3.2, 25.5
t = start
i = 0
while t < stop - 1e-6:
    add(kick(), t, .95)
    add(hat(), t + BEAT / 2, .22, pan=.3)
    if i % 2 == 1:
        add(clap(), t, .35, pan=-.1)
    if i % 4 == 3:
        add(hat(True), t + BEAT * .75, .12, pan=-.3)
    i += 1
    t += BEAT
bar = 0
t = start
while t < stop - 1e-6:
    c = bar % 4
    seglen = min(2.0, stop - t)
    add(pad([midi(m) for m in CHORDS[c]], seglen, .13), t)
    for k in range(int(seglen / (BEAT / 2))):  # eighth-note bass
        add(tone(midi(ROOTS[c] + (12 if k % 4 == 3 else 0)), .24, .004, .09, harm=((2, .35), (3, .12))), t + k * BEAT / 2, .38)
    bar += 1
    t += 2.0

# Scene transitions.
for cut in (3.2, 5.8, 8.2, 12.7, 18.0):
    add(whoosh(.55), cut - .3, .35, pan=-.2)

# Counters ticking (S3) and bars growing (S4).
for k, t0 in enumerate(np.arange(8.8, 10.4, .07)):
    add(tone(1800 + 40 * k, .03, .001, .01), t0, .08, pan=(k % 2) * .4 - .2)
for t0, f in ((13.85, 66), (13.65, 57), (14.35, 69), (14.15, 57)):
    add(tone(midi(f + 12), .9, .02, .4, harm=((2, .2),)), t0, .09)

# Games: tile flips, click, chat chime.
for r in range(3):
    for c in range(5):
        t0 = 19.0 + r * .62 + c * .07 + .25
        add(tone(900 + 60 * c, .04, .001, .012), t0, .07)
for c, m in enumerate((72, 76, 79, 84)):
    add(tone(midi(m), .5, .003, .18, harm=((2, .3),)), 20.75 + c * .08, .1)
add(tone(2400, .02, .0005, .004), 21.6, .3)
add(tone(midi(84), .6, .002, .25, harm=((2, .25),)), 22.3, .18)
add(tone(midi(91), .7, .002, .3, harm=((2, .25),)), 22.42, .16)

# Break → end card.
add(riser(.7), 25.55, .5)
add(impact(), 26.3, 1.0)
add(pad([midi(m) for m in (45, 57, 60, 64, 69)], 3.7, .16), 26.3)
add(tone(midi(81), 2.5, .01, .9, harm=((2, .2),)), 27.1, .08)

mix = np.stack([L, R], axis=1)
# Gentle saturation, normalise, 0.6 s fade-out.
mix = np.tanh(mix * 1.1)
mix /= np.abs(mix).max() / .75
fade = int(.6 * SR)
mix[-fade:] *= np.linspace(1, 0, fade)[:, None]

out = Path(__file__).parent / "out" / "soundtrack.wav"
out.parent.mkdir(exist_ok=True)
with wave.open(str(out), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix * 32767).astype("<i2").tobytes())
print("wrote", out)
