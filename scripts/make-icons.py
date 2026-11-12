#!/usr/bin/env python3
"""Generate the Seonfix Spider app icon programmatically.

Original design: dark charcoal rounded square, a geometric emerald spider
seen from above (round abdomen + head, 8 bent legs), plus a thin white web
arc in the top-right corner. Drawn at 4x and downscaled for crisp edges.
Outputs: build/logo.svg (source), build/icon.png (1024), build/icon.ico,
build/icon.iconset/*.png, src/renderer/logo.png + logo.svg.
"""
import math, os
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(__file__), "..")
SS = 4  # supersample
S = 1024

SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect x="64" y="64" width="896" height="896" rx="200" fill="#101418"/>
  <g stroke="#E8ECEF" stroke-width="10" fill="none" opacity="0.85">
    <path d="M960 444 A380 380 0 0 0 580 64"/>
    <path d="M960 324 A260 260 0 0 0 700 64"/>
    <path d="M788 64 L906 246 M960 352 L806 168"/>
  </g>
  <g stroke="#22C55E" stroke-width="46" stroke-linecap="round" fill="none">
    <path d="M392 430 L250 330 L150 360"/>
    <path d="M370 520 L210 500 L120 570"/>
    <path d="M380 610 L240 690 L180 800"/>
    <path d="M420 690 L330 810 L320 910"/>
    <path d="M632 430 L774 330 L874 360"/>
    <path d="M654 520 L814 500 L904 570"/>
    <path d="M644 610 L784 690 L844 800"/>
    <path d="M604 690 L694 810 L704 910"/>
  </g>
  <ellipse cx="512" cy="600" rx="155" ry="185" fill="#16A34A"/>
  <ellipse cx="512" cy="600" rx="105" ry="130" fill="#22C55E"/>
  <circle cx="512" cy="392" r="88" fill="#16A34A"/>
  <circle cx="484" cy="378" r="13" fill="#101418"/>
  <circle cx="540" cy="378" r="13" fill="#101418"/>
</svg>
"""

def draw(size):
    img = Image.new("RGBA", (size * SS, size * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = size * SS / 1024.0
    def X(v): return v * k
    # background rounded square
    d.rounded_rectangle([X(64), X(64), X(960), X(960)], radius=X(200), fill=(16, 20, 24, 255))
    # web: two quarter arcs centred on the top-right corner (960,64), kept small
    img2 = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d2 = ImageDraw.Draw(img2)
    cx, cy = X(960), X(64)
    for r in (X(380), X(260)):
        d2.arc([cx - r, cy - r, cx + r, cy + r], start=90, end=180, fill=(232, 236, 239, 200), width=int(X(10)))
    d2.line([X(788), X(64), X(906), X(246)], fill=(232, 236, 239, 200), width=int(X(10)))
    d2.line([X(960), X(352), X(806), X(168)], fill=(232, 236, 239, 200), width=int(X(10)))
    img = Image.alpha_composite(img, img2)
    d = ImageDraw.Draw(img)
    # legs: 4 per side, bent polylines
    legs = [
        [(392, 430), (250, 330), (150, 360)],
        [(370, 520), (210, 500), (120, 570)],
        [(380, 610), (240, 690), (180, 800)],
        [(420, 690), (330, 810), (320, 910)],
        [(632, 430), (774, 330), (874, 360)],
        [(654, 520), (814, 500), (904, 570)],
        [(644, 610), (784, 690), (844, 800)],
        [(604, 690), (694, 810), (704, 910)],
    ]
    for pts in legs:
        d.line([(X(x), X(y)) for x, y in pts], fill=(34, 197, 94, 255), width=int(X(46)), joint="curve")
        for x, y in pts[1:]:
            r = X(23)
            d.ellipse([X(x) - r, X(y) - r, X(x) + r, X(y) + r], fill=(34, 197, 94, 255))
    # body
    d.ellipse([X(512 - 155), X(600 - 185), X(512 + 155), X(600 + 185)], fill=(22, 163, 74, 255))
    d.ellipse([X(512 - 105), X(600 - 130), X(512 + 105), X(600 + 130)], fill=(34, 197, 94, 255))
    d.ellipse([X(512 - 88), X(392 - 88), X(512 + 88), X(392 + 88)], fill=(22, 163, 74, 255))
    for ex in (484, 540):
        r = X(13)
        d.ellipse([X(ex) - r, X(378) - r, X(ex) + r, X(378) + r], fill=(16, 20, 24, 255))
    return img.resize((size, size), Image.LANCZOS)

def main():
    build = os.path.join(ROOT, "build")
    iconset = os.path.join(build, "icon.iconset")
    os.makedirs(iconset, exist_ok=True)
    with open(os.path.join(build, "logo.svg"), "w") as f: f.write(SVG)
    with open(os.path.join(ROOT, "src/renderer/logo.svg"), "w") as f: f.write(SVG)
    master = draw(1024)
    master.save(os.path.join(build, "icon.png"))
    # ICO multi-size
    master.save(os.path.join(build, "icon.ico"), format="ICO",
                sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    # iconset (macOS)
    spec = [("icon_16x16.png", 16), ("icon_16x16@2x.png", 32), ("icon_32x32.png", 32),
            ("icon_32x32@2x.png", 64), ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
            ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512), ("icon_512x512.png", 512),
            ("icon_512x512@2x.png", 1024)]
    for name, sz in spec:
        master.resize((sz, sz), Image.LANCZOS).save(os.path.join(iconset, name))
    master.resize((128, 128), Image.LANCZOS).save(os.path.join(ROOT, "src/renderer/logo.png"))
    try:
        master.save(os.path.join(build, "icon.icns"), format="ICNS",
                    sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])
    except Exception as e:
        print("icns skipped:", e)
    print("icons written")

if __name__ == "__main__":
    main()
