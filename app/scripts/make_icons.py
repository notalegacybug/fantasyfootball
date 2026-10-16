"""Home-screen icons from the logo: the circle-and-arrow mark only, on white.

    python app/scripts/make_icons.py

Writes the web icons (app/www) and the Android launcher icons (app/art/android-res, copied
over Capacitor's defaults by scripts/patch-android.mjs, since android/ is generated in CI).

The wordmark is left out (unreadable at icon size; the phone prints the name under the
icon). iOS needs a square, opaque PNG -- it rounds the corners itself and fills
transparency with black -- so the mark is padded onto white.
"""
import pathlib
from PIL import Image, ImageDraw

APP = pathlib.Path(__file__).resolve().parent.parent
SOURCE = APP / "art" / "logo-source.jpg"   # 1024x559 JPEG; a bigger square original would be sharper
MARK_BOX = (405, 105, 625, 310)            # the mark, in SOURCE pixels
OUT = {"apple-touch-icon.png": 180, "icon-192.png": 192, "icon-512.png": 512}
ANDROID_RES = APP / "art" / "android-res"
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
WHITE = (255, 255, 255)


def clean_mark():
    mark = Image.open(SOURCE).convert("RGB").crop(MARK_BOX)
    # The faint field lines and off-white background are all very light: make them white.
    px = mark.load()
    for y in range(mark.height):
        for x in range(mark.width):
            if min(px[x, y]) > 215:
                px[x, y] = WHITE
    return mark


def on_white(mark, size, fill):
    """The mark centred on a white size x size square, its longer side = fill * size."""
    m = mark.copy()
    m.thumbnail((round(size * fill), round(size * fill)), Image.LANCZOS)
    square = Image.new("RGB", (size, size), WHITE)
    square.paste(m, ((size - m.width) // 2, (size - m.height) // 2))
    return square


def android_icons(mark):
    """Legacy square + round icons (48dp) and the adaptive foreground (108dp, of which phones
    show the middle 72dp, often cropped to a circle -- so the mark stays inside ~60%)."""
    for name, k in DENSITIES.items():
        d = ANDROID_RES / f"mipmap-{name}"
        d.mkdir(parents=True, exist_ok=True)
        legacy = round(48 * k)
        on_white(mark, legacy, 0.85).save(d / "ic_launcher.png", optimize=True)
        circle = Image.new("L", (legacy, legacy), 0)
        ImageDraw.Draw(circle).ellipse((0, 0, legacy - 1, legacy - 1), fill=255)
        rnd = on_white(mark, legacy, 0.68).convert("RGBA")
        rnd.putalpha(circle)
        rnd.save(d / "ic_launcher_round.png", optimize=True)
        on_white(mark, round(108 * k), 0.6).save(d / "ic_launcher_foreground.png", optimize=True)
    values = ANDROID_RES / "values"
    values.mkdir(parents=True, exist_ok=True)
    (values / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        '    <color name="ic_launcher_background">#FFFFFF</color>\n</resources>\n', encoding="utf-8")


if __name__ == "__main__":
    mark = clean_mark()
    square = on_white(mark, 512, 1 / 1.18)     # ~8% margin each side
    for name, size in OUT.items():
        square.resize((size, size), Image.LANCZOS).save(APP / "www" / name, optimize=True)
        print("wrote", name)
    android_icons(mark)
    print("wrote", ANDROID_RES.relative_to(APP))
