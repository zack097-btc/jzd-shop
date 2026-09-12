# Builds every icon the installer and the app window need, from the one
# 512-pixel logo at the top of this project. Keeping a single source and
# generating the rest means the app icon can never drift out of step with the
# website's — change icon-512.png and everything downstream follows.
#
#   python desktop/make_icons.py        (run from the repository root)

import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is needed for this: pip install pillow")

SRC = "icon-512.png"
OUT = os.path.join("desktop", "src-tauri", "icons")

# Windows wants a .ico carrying several sizes inside it, so the icon stays
# crisp in the taskbar, in Explorer's detail view and on the desktop alike.
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

PNGS = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
}


def main():
    if not os.path.exists(SRC):
        sys.exit(f"{SRC} not found — run this from the repository root")

    os.makedirs(OUT, exist_ok=True)
    master = Image.open(SRC).convert("RGBA")
    if master.size != (512, 512):
        master = master.resize((512, 512), Image.LANCZOS)

    for name, size in PNGS.items():
        img = master if size == 512 else master.resize((size, size), Image.LANCZOS)
        img.save(os.path.join(OUT, name), "PNG")
        print("wrote", name, f"{size}x{size}")

    ico = os.path.join(OUT, "icon.ico")
    master.save(ico, format="ICO", sizes=[(s, s) for s in ICO_SIZES])
    print("wrote icon.ico", ICO_SIZES)


if __name__ == "__main__":
    main()
