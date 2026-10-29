"""Build a snowboard course from real elevation data.

Downloads free elevation tiles (Mapzen/AWS "Terrarium" tiles, no API key),
crops the area of one course, and writes two files the game loads:

  data/<id>.bin   heights as unsigned 16-bit numbers, in decimetres
  data/<id>.json  grid size, cell size, real-world position, and a guide line
                  (the "route") from the start to the finish

The route is found with a shortest-path search that prefers rideable slopes,
avoids cliffs and refuses to go uphill much. The game places stars and jumps
along it.

Usage (needs Python 3 with numpy and Pillow):
  python3 tools/build_course.py whistler
"""

import heapq
import io
import json
import math
import os
import sys
import urllib.request

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data")
CACHE = os.path.join(HERE, ".tile-cache")
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

# One entry per mountain. Bounds are (north, west, south, east) in degrees.
COURSES = {
    "whistler": {
        "name": "Whistler Mountain — Peak to Village",
        "bounds": (50.1215, -123.0050, 50.0515, -122.9200),
        "zoom": 14,          # about 6 m per pixel at this latitude
        "downsample": 2,     # game grid is about 12 m per cell
        "start": (50.0587, -122.9555),   # just below Whistler Peak (2,182 m)
        "finish": (50.1140, -122.9520),  # Whistler Village base
    },
}


def tile_xy(lat, lon, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def get_tile(z, x, y):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{z}_{x}_{y}.png")
    if not os.path.exists(path):
        url = TILE_URL.format(z=z, x=x, y=y)
        with urllib.request.urlopen(url, timeout=60) as r:
            data = r.read()
        with open(path, "wb") as f:
            f.write(data)
    rgb = np.asarray(Image.open(path).convert("RGB")).astype(np.float64)
    # Terrarium encoding: metres = R*256 + G + B/256 - 32768
    return rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768


def load_area(bounds, z):
    north, west, south, east = bounds
    fx0, fy0 = tile_xy(north, west, z)
    fx1, fy1 = tile_xy(south, east, z)
    tx0, ty0, tx1, ty1 = int(fx0), int(fy0), int(fx1), int(fy1)
    rows = []
    for ty in range(ty0, ty1 + 1):
        rows.append(np.hstack([get_tile(z, tx, ty) for tx in range(tx0, tx1 + 1)]))
    big = np.vstack(rows)
    px0, py0 = int((fx0 - tx0) * 256), int((fy0 - ty0) * 256)
    px1, py1 = int((fx1 - tx0) * 256), int((fy1 - ty0) * 256)
    return big[py0:py1, px0:px1], (fx0, fy0)


def blur(a, passes=2):
    """Small box blur, repeated, to soften the 'staircase' in the raw data."""
    for _ in range(passes):
        p = np.pad(a, 1, mode="edge")
        a = sum(p[1 + dy:p.shape[0] - 1 + dy, 1 + dx:p.shape[1] - 1 + dx]
                for dy in (-1, 0, 1) for dx in (-1, 0, 1)) / 9
    return a


def find_route(h, cell, start, finish):
    """Cheapest downhill path on the grid (Dijkstra)."""
    H, W = h.shape
    gy, gx = np.gradient(h, cell)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    # Cost per metre: cheapest on 12-30 degree slopes, rising on cliffs
    # and on near-flat ground where a board would stop.
    pen = np.ones_like(slope)
    pen += np.clip((slope - 30) / 6, 0, None) ** 2 * 3
    pen += np.clip((6 - slope) / 6, 0, None) * 1.5
    dist = np.full(h.shape, np.inf)
    prev = -np.ones(h.shape, dtype=np.int64)
    sy, sx = start
    dist[sy, sx] = 0
    heap = [(0.0, sy, sx)]
    steps = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    while heap:
        d, y, x = heapq.heappop(heap)
        if d > dist[y, x]:
            continue
        if (y, x) == tuple(finish):
            break
        for dy, dx in steps:
            ny, nx = y + dy, x + dx
            if not (0 <= ny < H and 0 <= nx < W):
                continue
            run = cell * math.hypot(dy, dx)
            rise = h[ny, nx] - h[y, x]
            c = run * 0.5 * (pen[y, x] + pen[ny, nx])
            if rise > 0:
                c += rise * 60  # going uphill on a board is very expensive
            nd = d + c
            if nd < dist[ny, nx]:
                dist[ny, nx] = nd
                prev[ny, nx] = y * W + x
                heapq.heappush(heap, (nd, ny, nx))
    path = []
    i = finish[0] * W + finish[1]
    while i >= 0:
        path.append((i % W, i // W))
        i = prev[i // W, i % W]
    path.reverse()
    return path


def smooth_and_resample(path, cell, step=6.0, window=9):
    pts = np.array(path, dtype=np.float64) * cell
    k = window
    padded = np.vstack([np.repeat(pts[:1], k, 0), pts, np.repeat(pts[-1:], k, 0)])
    kernel = np.ones(2 * k + 1) / (2 * k + 1)
    sm = np.column_stack([np.convolve(padded[:, i], kernel, "valid") for i in range(2)])
    seg = np.hypot(*np.diff(sm, axis=0).T)
    s = np.concatenate([[0], np.cumsum(seg)])
    out = []
    for t in np.arange(0, s[-1], step):
        j = min(np.searchsorted(s, t, side="right") - 1, len(seg) - 1)
        f = (t - s[j]) / seg[j] if seg[j] > 0 else 0
        out.append(sm[j] + (sm[j + 1] - sm[j]) * f)
    out.append(sm[-1])
    return np.array(out)


def main(course_id):
    cfg = COURSES[course_id]
    z, ds = cfg["zoom"], cfg["downsample"]
    raw, (fx0, fy0) = load_area(cfg["bounds"], z)
    north = cfg["bounds"][0]
    # Web-mercator pixels are square; their real size shrinks with latitude.
    lat_mid = (cfg["bounds"][0] + cfg["bounds"][2]) / 2
    px_m = 40075016.686 * math.cos(math.radians(lat_mid)) / (2 ** z * 256)
    raw = blur(raw, 1)
    Hc, Wc = raw.shape[0] // ds, raw.shape[1] // ds
    h = raw[:Hc * ds, :Wc * ds].reshape(Hc, ds, Wc, ds).mean(axis=(1, 3))
    h = blur(h, 2)
    cell = px_m * ds

    def to_cell(lat, lon):
        x, y = tile_xy(lat, lon, z)
        return int(round((y - fy0) * 256 / ds)), int(round((x - fx0) * 256 / ds))

    sy, sx = to_cell(*cfg["start"])
    fy, fx = to_cell(*cfg["finish"])
    # Snap start to the highest nearby cell and finish to the lowest.
    r = 6
    win = h[sy - r:sy + r, sx - r:sx + r]
    iy, ix = np.unravel_index(win.argmax(), win.shape)
    sy, sx = sy - r + iy, sx - r + ix
    path = find_route(h, cell, (sy, sx), (fy, fx))
    route = smooth_and_resample(path, cell)

    os.makedirs(OUT, exist_ok=True)
    dm = np.clip(np.round(h * 10), 0, 65535).astype("<u2")
    dm.tofile(os.path.join(OUT, f"{course_id}.bin"))
    meta = {
        "id": course_id,
        "name": cfg["name"],
        "width": int(Wc),
        "height": int(Hc),
        "cellSize": round(cell, 4),
        "heightScale": 0.1,
        "minElevation": round(float(h.min()), 1),
        "maxElevation": round(float(h.max()), 1),
        "source": "Mapzen Terrarium elevation tiles (AWS Open Data). "
                  "Includes SRTM, NED, CDEM and other public datasets.",
        "bounds": {"north": north, "west": cfg["bounds"][1],
                   "south": cfg["bounds"][2], "east": cfg["bounds"][3]},
        "route": [[round(float(x), 1), round(float(y), 1)] for x, y in route],
    }
    with open(os.path.join(OUT, f"{course_id}.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    length = float(np.sum(np.hypot(*np.diff(route, axis=0).T)))
    print(f"{course_id}: {Wc}x{Hc} cells of {cell:.1f} m, "
          f"{h.min():.0f}-{h.max():.0f} m, route {length / 1000:.1f} km, "
          f"drop {h[sy, sx] - h[fy, fx]:.0f} m")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "whistler")
