"""מייצר את אייקוני ה-PWA (PNG) בלי תלויות חיצוניות. רץ אוטומטית ב-docker build; מקומית: python3 app/make_icons.py"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "icons")
BG = (15, 118, 110)
FG = (255, 255, 255)
ACC = (255, 196, 120)


def png(path, w, h, px):
    raw = b"".join(b"\x00" + bytes(px[y * w * 4:(y + 1) * w * 4]) for y in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(data)


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def icon(size, maskable):
    s = size
    # קו מגמה יורד + נקודת יעד. במסכה (maskable) — הציור מוקטן לאזור הבטוח.
    k = 0.62 if maskable else 0.8
    off = (1 - k) / 2
    pts = [(0.12, 0.30), (0.38, 0.48), (0.55, 0.40), (0.86, 0.72)]
    pts = [((off + x * k) * s, (off + y * k) * s) for x, y in pts]
    goal = pts[-1]
    lw = s * 0.055 * k / 0.8
    rad = s * 0.22  # פינות מעוגלות (רק לאייקון הרגיל)
    px = bytearray(s * s * 4)
    for y in range(s):
        for x in range(s):
            cx, cy = x + 0.5, y + 0.5
            alpha = 1.0
            if not maskable:
                qx = max(rad - cx, 0, cx - (s - rad))
                qy = max(rad - cy, 0, cy - (s - rad))
                alpha = max(0.0, min(1.0, rad - math.hypot(qx, qy) + 0.5))
            col = BG
            d = min(seg_dist(cx, cy, *pts[i], *pts[i + 1]) for i in range(len(pts) - 1))
            a = max(0.0, min(1.0, lw / 2 - d + 0.5))
            dg = math.hypot(cx - goal[0], cy - goal[1])
            g = max(0.0, min(1.0, lw * 1.3 - dg + 0.5))
            col = tuple(round(c * (1 - a) + f * a) for c, f in zip(col, FG))
            col = tuple(round(c * (1 - g) + f * g) for c, f in zip(col, ACC))
            i = (y * s + x) * 4
            px[i:i + 4] = bytes((*col, round(alpha * 255)))
    return px


os.makedirs(OUT, exist_ok=True)
for name, size, mask in [("icon-192.png", 192, False), ("icon-512.png", 512, False),
                         ("icon-maskable-512.png", 512, True)]:
    png(os.path.join(OUT, name), size, size, icon(size, mask))
    print("wrote", name)
