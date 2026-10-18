# Synthetic, license-free test "photos" for Vishar Color Study experiments.
import numpy as np, json, sys
from PIL import Image, ImageDraw, ImageFilter
rng = np.random.default_rng(42)
OUT = sys.argv[1]
W, H = 4032, 3024  # iPhone 12 MP

def save(name, arr):
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), 'RGB')
    img.save(f"{OUT}/{name}_12mp.png")
    img.resize((1024, 768), Image.LANCZOS).save(f"{OUT}/{name}_1k.png")

def noise(scale, amp, shape=(H, W)):
    small = rng.normal(0, 1, (shape[0]//scale + 2, shape[1]//scale + 2)).astype(np.float32)
    im = Image.fromarray(((small - small.min()) / (np.ptp(small)) * 255).astype(np.uint8)).resize((shape[1], shape[0]), Image.BICUBIC)
    return (np.asarray(im, np.float32) / 255 - 0.5) * 2 * amp

yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)

# 1. Still life: three lit spheres, warm key light from upper left, cool fill, cast shadows.
bg = np.dstack([np.full((H, W), c, np.float32) for c in (88, 92, 104)])
bg += (yy / H)[..., None] * np.array([20, 10, -10], np.float32)
table = yy > H * 0.62
bg[table] = np.array([150, 112, 78], np.float32) + noise(40, 8)[table][..., None]
img = bg.copy()
L = np.array([-0.55, -0.6, 0.58]); L /= np.linalg.norm(L)
for cx, cy, r, base in [(1100, 1650, 520, (200, 40, 35)), (2150, 1750, 430, (230, 190, 40)), (3050, 1600, 560, (50, 90, 190))]:
    sh = ((xx - cx - 380) / (r * 1.4)) ** 2 + ((yy - cy - r * 0.95) / (r * 0.35)) ** 2 < 1
    img[sh & table] *= 0.55
    d2 = ((xx - cx) ** 2 + (yy - cy) ** 2) / r ** 2
    m = d2 < 1
    nz = np.sqrt(np.clip(1 - d2, 0, 1))
    nx, ny = (xx - cx) / r, (yy - cy) / r
    lam = np.clip(nx * L[0] + ny * L[1] + nz * L[2], 0, 1)
    spec = np.clip(nx * -0.3 + ny * -0.35 + nz * 0.89, 0, 1) ** 40
    col = np.array(base, np.float32)
    warm = np.array([1.08, 1.0, 0.86]); cool = np.array([0.78, 0.86, 1.12])
    shade = col * (0.18 + 0.85 * lam[..., None]) * np.where(lam[..., None] > 0.25, warm, cool) + spec[..., None] * 230
    img[m] = shade[m]
img += noise(3, 6)[..., None]
save('stilllife', img)

# 2. Landscape: sky gradient, sun, layered hills with atmospheric perspective, water.
t = yy / H
sky = np.dstack([90 + 150 * t, 140 + 90 * t, 220 - 40 * t])
img = sky.copy()
sun = ((xx - 2900) ** 2 + (yy - 900) ** 2) < 180 ** 2
img[sun] = (255, 236, 190)
glow = np.exp(-(((xx - 2900) ** 2 + (yy - 900) ** 2) / (700 ** 2)))[..., None] * np.array([60, 40, 0])
img += glow
for i, (base_y, amp, col) in enumerate([(1500, 160, (140, 150, 180)), (1750, 220, (95, 115, 120)), (2000, 260, (55, 85, 50))]):
    ridge = base_y + amp * np.sin(xx[0] / (500 + 200 * i) + i) + noise(60, 60, (1, W))[0]
    mask = yy > ridge[None, :]
    img[mask] = (np.array(col, np.float32) + noise(8 + 4 * i, 12 + 6 * i)[..., None])[mask]
water = yy > 2400
img[water] = (img[(2 * 2400 - yy[water]).astype(int).clip(0, H - 1), xx[water].astype(int)] * 0.7 + np.array([10, 25, 45]))
save('landscape', img)

# 3. Tattoo flash: bold outlines, flat fills, thin hatching, small dots (tests readability at small size).
im = Image.new('RGB', (W, H), (238, 230, 214)); d = ImageDraw.Draw(im)
cx, cy = W // 2, H // 2
for k in range(8):  # petals
    a = k * np.pi / 4
    px, py = cx + 650 * np.cos(a), cy + 650 * np.sin(a)
    d.ellipse([px - 420, py - 300, px + 420, py + 300], fill=(178, 32, 48), outline=(15, 15, 15), width=26)
d.ellipse([cx - 520, cy - 520, cx + 520, cy + 520], fill=(214, 70, 60), outline=(15, 15, 15), width=30)
d.ellipse([cx - 240, cy - 240, cx + 240, cy + 240], fill=(250, 196, 60), outline=(15, 15, 15), width=22)
for x in range(cx - 1400, cx + 1400, 36):  # fine hatching in leaves: 6 px lines
    d.line([x, cy + 900, x + 220, cy + 1350], fill=(30, 90, 50), width=6)
d.polygon([(cx - 1500, cy + 1300), (cx, cy + 850), (cx + 1500, cy + 1300), (cx, cy + 1450)], outline=(15, 15, 15), width=24)
for i in range(400):  # dotwork
    x, y = rng.integers(200, W - 200), rng.integers(150, 700)
    r = rng.integers(4, 14); d.ellipse([x - r, y - r, x + r, y + r], fill=(20, 20, 20))
d.text((200, 2800), "low-contrast text", fill=(205, 195, 180))
arr = np.asarray(im, np.float32) + noise(2, 5)[..., None]
save('flash', arr)

# 4. Portrait-like: skin-tone face oval with soft gradient (banding test), hair mass, dark bg.
img = np.dstack([np.full((H, W), c, np.float32) for c in (35, 32, 40)])
d2 = ((xx - 2016) / 900) ** 2 + ((yy - 1550) / 1200) ** 2
face = d2 < 1
light = np.clip(1.1 - ((xx - 1500) ** 2 + (yy - 1100) ** 2) / (1600 ** 2), 0.15, 1)
skin = np.array([228, 170, 140], np.float32)
img[face] = (skin * light[..., None] * np.array([1, 0.97, 0.95]))[face]
hair = (((xx - 2016) / 1050) ** 2 + ((yy - 1250) / 1100) ** 2 < 1) & (yy < 900 + 0.25 * np.abs(xx - 2016))
img[hair] = (np.array([60, 38, 25]) + noise(4, 18)[..., None])[hair]
img += noise(3, 4)[..., None]
save('portrait', img)
print("ok")
