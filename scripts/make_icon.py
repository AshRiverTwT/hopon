"""HopOn app icon: warm-black tile, extra-wide black cream "H" (Archivo
wdth 125 / wght 900, the app's display face), hot-red tag top-right.

Regenerate (needs pillow + fonttools + brotli):
    python scripts/make_icon.py client/src-tauri/icons
The font is read from the app's bundled woff2."""
import sys
from PIL import Image, ImageDraw, ImageFont

INK = (22, 21, 21, 255)
CREAM = (243, 241, 226, 255)
HOT = (255, 27, 80, 255)
FONT_WOFF2 = "client/ui/src/fonts/archivo-wdth.woff2"


def _font_path() -> str:
    import os, tempfile
    from fontTools.ttLib import TTFont
    out = os.path.join(tempfile.gettempdir(), "hopon-archivo.ttf")
    if not os.path.exists(out):
        f = TTFont(FONT_WOFF2)
        f.flavor = None
        f.save(out)
    return out


FONT = _font_path()


def mark(n: int, variant: str = "tag") -> Image.Image:
    s = 4  # supersample
    N = n * s
    im = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, N - 1, N - 1], radius=int(N * 0.22), fill=INK)
    # Fit the glyph to a target width; small sizes get a bigger share.
    target = 0.70 if n >= 48 else 0.78
    f = ImageFont.truetype(FONT, 100)
    f.set_variation_by_axes([900, 125])
    l, t, r, b = d.textbbox((0, 0), "H", font=f)
    f = ImageFont.truetype(FONT, int(100 * target * N / (r - l)))
    f.set_variation_by_axes([900, 125])
    l, t, r, b = d.textbbox((0, 0), "H", font=f)
    w, h = r - l, b - t
    x = (N - w) / 2 - l
    y = (N - h) / 2 - t + N * 0.05
    d.text((x, y), "H", font=f, fill=CREAM)
    if variant in ("tag", "arc"):
        tw, th = (N * 0.24, N * 0.13) if n >= 48 else (N * 0.30, N * 0.17)
        tx, ty = N - tw - N * 0.09, N * 0.09
        d.rectangle([tx, ty, tx + tw, ty + th], fill=HOT)
    if variant == "arc":
        # a dial arc echoing the rotary channel picker
        pad = N * 0.10
        d.arc([pad - N * 0.55, pad, N - pad - N * 0.55, N - pad], start=-50, end=50, fill=CREAM, width=max(2, int(N * 0.025)))
    return im.resize((n, n), Image.LANCZOS)


if __name__ == "__main__":
    out = sys.argv[1]
    variant = sys.argv[2] if len(sys.argv) > 2 else "tag"
    if out == "preview":
        sheet = Image.new("RGBA", (1100, 560), (40, 40, 40, 255))
        for i, v in enumerate(["tag", "arc"]):
            sheet.alpha_composite(mark(256, v), (40 + i * 540, 40))
            for j, sz in enumerate([16, 24, 32, 48, 64]):
                sheet.alpha_composite(mark(sz, v), (40 + i * 540 + j * 90, 340))
        sheet.save("icon-preview.png")
    else:
        import os
        os.makedirs(out, exist_ok=True)
        mark(512, variant).save(f"{out}/icon.png")
        mark(32, variant).save(f"{out}/32x32.png")
        mark(128, variant).save(f"{out}/128x128.png")
        mark(256, variant).save(f"{out}/128x128@2x.png")
        big = mark(256, variant)
        sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
        # Render each ICO size natively (better than one downscale).
        imgs = [mark(sz, variant) for sz in sizes]
        imgs[-1].save(f"{out}/icon.ico", sizes=[(s, s) for s in sizes], append_images=imgs[:-1])
        print("wrote", out)
