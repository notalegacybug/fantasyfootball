"""Home-screen icons from the logo: the circle-and-arrow mark only, on white.

    python app/scripts/make_icons.py

The wordmark is left out (unreadable at icon size; the phone prints the name under the
icon). iOS needs a square, opaque PNG -- it rounds the corners itself and fills
transparency with black -- so the mark is padded onto white.
"""
import pathlib
from PIL import Image

APP = pathlib.Path(__file__).resolve().parent.parent
SOURCE = APP / "art" / "logo-source.jpg"   # 1024x559 JPEG; a bigger square original would be sharper
MARK_BOX = (405, 105, 625, 310)            # the mark, in SOURCE pixels
OUT = {"apple-touch-icon.png": 180, "icon-192.png": 192, "icon-512.png": 512}


def mark_on_white():
    mark = Image.open(SOURCE).convert("RGB").crop(MARK_BOX)
    # The faint field lines and off-white background are all very light: make them white.
    px = mark.load()
    for y in range(mark.height):
        for x in range(mark.width):
            if min(px[x, y]) > 215:
                px[x, y] = (255, 255, 255)
    side = int(max(mark.size) * 1.18)       # ~8% margin each side
    square = Image.new("RGB", (side, side), (255, 255, 255))
    square.paste(mark, ((side - mark.width) // 2, (side - mark.height) // 2))
    return square


if __name__ == "__main__":
    square = mark_on_white()
    for name, size in OUT.items():
        square.resize((size, size), Image.LANCZOS).save(APP / "www" / name, optimize=True)
        print("wrote", name)
