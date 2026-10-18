#!/usr/bin/env python3
"""Generate synthetic test images for the Stage 0 bench.

Writes to public/samples/. Images look roughly like photos (smooth gradients,
shapes, light noise) so JPEG/HEIC sizes and decode times are realistic.
Needs Pillow, numpy and pillow-heif (HEIC encoder).

    python3 scripts/gen-samples.py
"""
import json
import os
import sys

import numpy as np
from PIL import Image

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
    HAVE_HEIF = True
except ImportError:  # HEIC samples are skipped, the bench reports them as missing
    HAVE_HEIF = False

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "samples")
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(42)


def synth(w, h):
    """Photo-like RGB image built in horizontal strips to keep memory low."""
    img = np.empty((h, w, 3), dtype=np.uint8)
    xs = np.linspace(0, 1, w, dtype=np.float32)
    centers = rng.random((24, 2)).astype(np.float32)
    radii = (0.04 + rng.random(24) * 0.18).astype(np.float32)
    colors = rng.integers(0, 255, (24, 3)).astype(np.float32)
    strip = 512
    for y0 in range(0, h, strip):
        y1 = min(h, y0 + strip)
        ys = np.linspace(y0 / h, (y1 - 1) / h, y1 - y0, dtype=np.float32)[:, None]
        r = 40 + 180 * xs[None, :] * (1 - ys) + 30 * np.sin(ys * 9)
        g = 60 + 120 * ys + 40 * np.cos(xs[None, :] * 7)
        b = 200 - 150 * xs[None, :] * ys
        acc = np.stack(np.broadcast_arrays(r, g, b), axis=-1)
        aspect = w / h
        for (cx, cy), rad, col in zip(centers, radii, colors):
            d = np.sqrt(((xs[None, :] - cx) * aspect) ** 2 + (ys - cy) ** 2)
            m = np.clip((rad - d) / (rad * 0.15), 0, 1)[..., None]
            acc = acc * (1 - m) + col * m
        acc += rng.normal(0, 2.5, acc.shape).astype(np.float32)
        img[y0:y1] = np.clip(acc, 0, 255).astype(np.uint8)
    return Image.fromarray(img, "RGB")


def orient_probe():
    """64x32 image, red left half, blue right half, EXIF Orientation=6.

    A browser that applies EXIF rotation returns 32x64 with red on top.
    """
    a = np.zeros((32, 64, 3), dtype=np.uint8)
    a[:, :32] = (255, 0, 0)
    a[:, 32:] = (0, 0, 255)
    im = Image.fromarray(a, "RGB")
    exif = Image.Exif()
    exif[0x0112] = 6
    return im, exif


manifest = {}


def save(name, im, **kw):
    path = os.path.join(OUT, name)
    im.save(path, **kw)
    manifest[name] = {"bytes": os.path.getsize(path), "width": im.width, "height": im.height}
    print(f"{name}: {im.width}x{im.height}, {os.path.getsize(path) / 1e6:.2f} MB")


# Small format probes
small = synth(640, 480)
save("probe.jpg", small, quality=90)
rgba = small.convert("RGBA")
alpha = np.array(rgba)
alpha[:, :, 3] = np.linspace(0, 255, 640, dtype=np.uint8)[None, :]
save("probe.png", Image.fromarray(alpha, "RGBA"))
save("probe.webp", small, quality=85)
if HAVE_HEIF:
    save("probe.heic", small, quality=80)
im, exif = orient_probe()
save("orient6.jpg", im, quality=95, exif=exif)

# Timing samples: 12 MP (4032x3024) and 48 MP (8064x6048), as the iPhone camera
for label, (w, h) in {"12mp": (4032, 3024), "48mp": (8064, 6048)}.items():
    big = synth(w, h)
    save(f"synth_{label}.jpg", big, quality=88)
    if HAVE_HEIF:
        save(f"synth_{label}.heic", big, quality=55)
    del big

with open(os.path.join(OUT, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=2)
if not HAVE_HEIF:
    print("pillow-heif not installed: HEIC samples skipped", file=sys.stderr)
