"""Build the game's mountains and courses from real data.

A *mountain* is the ground everyone rides on:
  data/<mountain>.png         heights in decimetres, packed into a lossless PNG
                              (red = high byte, green = low byte)
  data/<mountain>-forest.png  how forested each spot is (0 = open snow, 255 = forest),
                              from Sentinel-2 satellite images (optional)

A *course* is a way of playing on a mountain:
  data/<course>.json          grid size and position, plus a line to follow (route),
                              drop-in spots (spawns) and buildings

Data sources (all free, no API key):
  - Elevation: Mapzen "Terrarium" tiles on AWS Open Data (SRTM, Canadian CDEM, ...)
  - Forest: ESA Copernicus Sentinel-2 L2A images on AWS (sentinel-cogs bucket).
    Forest = dark in a sunny winter image (trees hide the snow) AND green in
    a summer image (so roads, roofs and lakes don't count as forest).
  - Run lines and buildings traced from OpenStreetMap data (see traces/).

Usage (Python 3 with numpy and Pillow; the forest step also needs rasterio):
  python3 tools/build_course.py              # everything
  python3 tools/build_course.py freeride     # one course (rebuilds its mountain)
"""

import heapq
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
S2_URL = "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/"

# Bounds are (north, west, south, east) in degrees.
MOUNTAINS = {
    "whistler": {
        # All of Whistler Mountain: Creekside and the Village in the north-west,
        # the Peak, Harmony, Symphony and Flute in the south-east.
        "bounds": (50.1215, -123.0050, 50.0350, -122.8800),
        "zoom": 14,          # about 6 m per pixel at this latitude
        "downsample": 2,     # game grid is about 12 m per cell
        "forest": {
            "tiles": ["10/U/EA", "10/U/DA"],  # the map straddles two tiles
            "winter": "2023/4/S2A_{tile}_20230428_0_L2A",   # sunny, full snow cover
            "summer": "2023/8/S2A_{tile}_20230813_0_L2A",   # clear, snow-free
            # Real treeline: no forest above ~1,900 m, thinning from ~1,650 m.
            "treeline": (1650, 1900),
        },
    },
}

COURSES = {
    "freeride": {
        "name": "Whistler Mountain — Free Ride",
        "mountain": "whistler",
        "mode": "free",
        "buildings": "traces/creekside-buildings.json",
        "liftSpawns": True,   # also drop in at the top of every lift
        # Drop-in spots. The Peak and the two bases are exact; the others are
        # approximate (high points found in the elevation data, or on the line
        # of the Village Gondola at Olympic's ~1,020 m).
        "spawns": [
            ("Whistler Peak", 50.0592, -122.9569),
            ("Roundhouse", 50.0679, -122.9467),
            ("Harmony Ridge", 50.0562, -122.9449),        # high point of the ridge
            ("Symphony (Piccolo)", 50.0399, -122.9269),   # high point above Symphony Bowl
            ("Olympic", 50.0990, -122.9503),              # mid-station height, on the gondola line
            ("Creekside", 50.0934, -122.9878),
            ("Whistler Village", 50.1140, -122.9520),
        ],
    },
    # Peak to Creek: Whistler's longest run, traced from OpenStreetMap run data.
    "peak-to-creek": {
        "name": "Whistler — Peak to Creek",
        "mountain": "whistler",
        "trace": "traces/peak-to-creek.json",
        "routeSource": "OpenStreetMap ski-run data (© OpenStreetMap contributors), via CalTopo",
        "buildings": "traces/creekside-buildings.json",
        "labels": ("PEAK TO CREEK", "CREEKSIDE"),
    },
    # Peak to Village: the line is found on the real runs, using the forest map
    # to stay in the cleared runs instead of cutting through trees.
    "whistler": {
        "name": "Whistler — Peak to Village",
        "mountain": "whistler",
        "start": (50.0592, -122.9569),
        "finish": (50.1140, -122.9520),
        "followRuns": True,
        "routeSource": "Computed along the cleared runs seen in Sentinel-2 imagery",
        "labels": ("WHISTLER PEAK", "VILLAGE"),
    },
}


# ---------- Map maths ----------

def tile_xy(lat, lon, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def tile_to_latlon(x, y, z):
    n = 2 ** z
    lon = x / n * 360 - 180
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * y / n))))
    return lat, lon


# ---------- Elevation ----------

def get_tile(z, x, y):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{z}_{x}_{y}.png")
    if not os.path.exists(path):
        with urllib.request.urlopen(TILE_URL.format(z=z, x=x, y=y), timeout=60) as r:
            data = r.read()
        with open(path, "wb") as f:
            f.write(data)
    rgb = np.asarray(Image.open(path).convert("RGB")).astype(np.float64)
    # Terrarium encoding: metres = R*256 + G + B/256 - 32768
    return rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768


def blur(a, passes=2):
    """Small box blur, repeated, to soften the 'staircase' in the raw data."""
    for _ in range(passes):
        p = np.pad(a, 1, mode="edge")
        a = sum(p[1 + dy:p.shape[0] - 1 + dy, 1 + dx:p.shape[1] - 1 + dx]
                for dy in (-1, 0, 1) for dx in (-1, 0, 1)) / 9
    return a


class Grid:
    """The game grid: x grows east, z grows south, both in metres."""

    def __init__(self, cfg):
        self.cfg = cfg
        north, west, south, east = cfg["bounds"]
        self.z, self.ds = cfg["zoom"], cfg["downsample"]
        fx0, fy0 = tile_xy(north, west, self.z)
        fx1, fy1 = tile_xy(south, east, self.z)
        tx0, ty0, tx1, ty1 = int(fx0), int(fy0), int(fx1), int(fy1)
        big = np.vstack([np.hstack([get_tile(self.z, tx, ty) for tx in range(tx0, tx1 + 1)])
                         for ty in range(ty0, ty1 + 1)])
        px0, py0 = int((fx0 - tx0) * 256), int((fy0 - ty0) * 256)
        px1, py1 = int((fx1 - tx0) * 256), int((fy1 - ty0) * 256)
        raw = blur(big[py0:py1, px0:px1], 1)
        # The grid starts exactly on a pixel edge.
        self.fx0, self.fy0 = tx0 + px0 / 256, ty0 + py0 / 256
        lat_mid = (north + south) / 2
        px_m = 40075016.686 * math.cos(math.radians(lat_mid)) / (2 ** self.z * 256)
        ds = self.ds
        self.H, self.W = raw.shape[0] // ds, raw.shape[1] // ds
        h = raw[:self.H * ds, :self.W * ds].reshape(self.H, ds, self.W, ds).mean(axis=(1, 3))
        self.h = blur(h, 2)
        self.cell = px_m * ds

    def to_xz(self, lat, lon):
        """Latitude/longitude to game metres."""
        x, y = tile_xy(lat, lon, self.z)
        return ((x - self.fx0) * 256 / self.ds * self.cell, (y - self.fy0) * 256 / self.ds * self.cell)

    def to_latlon(self, x, z):
        """Game metres (arrays OK) to latitude/longitude."""
        tx = self.fx0 + np.asarray(x) / self.cell * self.ds / 256
        ty = self.fy0 + np.asarray(z) / self.cell * self.ds / 256
        return tile_to_latlon(tx, ty, self.z)

    def height_at(self, x, z):
        i = int(np.clip(round(x / self.cell), 0, self.W - 1))
        j = int(np.clip(round(z / self.cell), 0, self.H - 1))
        return self.h[j, i]


# ---------- Forest from Sentinel-2 ----------

def s2_window(scene, band, bounds, tiles):
    """One Sentinel-2 band over bounds, stitched from overlapping tiles. Cached.

    scene is a pattern like "2023/4/S2A_{tile}_20230428_0_L2A". Returns the
    array (bands, rows, cols) on a 10 m UTM 10N grid and its (x0, y0) corner.
    """
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"s2v2_{scene.split('/')[-1].format(tile='T')}_{band}.npz")
    if os.path.exists(path):
        d = np.load(path)
        return d["a"], tuple(d["corner"])
    import rasterio  # only needed for this step
    from rasterio.windows import Window, from_bounds
    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    if os.path.exists("/root/.ccr/ca-bundle.crt"):
        os.environ.setdefault("CURL_CA_BUNDLE", "/root/.ccr/ca-bundle.crt")
    north, west, south, east = bounds
    E, N = utm10(np.array([north, north, south, south]), np.array([west, east, west, east]))
    x0, x1 = math.floor(E.min() / 10) * 10 - 200, math.ceil(E.max() / 10) * 10 + 200
    y0, y1 = math.floor(N.min() / 10) * 10 - 200, math.ceil(N.max() / 10) * 10 + 200
    out = None
    for tile in tiles:
        code = tile.replace("/", "")
        url = f"/vsicurl/{S2_URL}{tile}/{scene.format(tile=code)}/{band}.tif"
        with rasterio.open(url) as ds:
            if out is None:
                out = np.zeros((ds.count, (y1 - y0) // 10, (x1 - x0) // 10), ds.dtypes[0])
            w = from_bounds(x0, y0, x1, y1, ds.transform).round_offsets().round_lengths()
            w = w.intersection(Window(0, 0, ds.width, ds.height))  # read only what the tile has
            a = ds.read(window=w)
            tx, ty = ds.window_transform(w).c, ds.window_transform(w).f
            c0, r0 = int(round((tx - x0) / 10)), int(round((y1 - ty) / 10))
            dst = out[:, r0:r0 + a.shape[1], c0:c0 + a.shape[2]]
            fill = (dst == 0) if a.ndim == 3 else None
            np.copyto(dst, a[:, :dst.shape[1], :dst.shape[2]], where=fill)
    np.savez_compressed(path, a=out, corner=np.array([x0, y1]))
    return out, (x0, y1)


def utm10(lat, lon):
    """WGS84 latitude/longitude to UTM zone 10 north (metres)."""
    a, f, k0 = 6378137.0, 1 / 298.257223563, 0.9996
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    phi, lam = np.radians(lat), np.radians(lon - (-123.0))
    N = a / np.sqrt(1 - e2 * np.sin(phi) ** 2)
    T, C = np.tan(phi) ** 2, ep2 * np.cos(phi) ** 2
    A = np.cos(phi) * lam
    M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi
             - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * np.sin(2 * phi)
             + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * np.sin(4 * phi)
             - (35 * e2 ** 3 / 3072) * np.sin(6 * phi))
    E = 500000 + k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120)
    Nn = k0 * (M + N * np.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24
                                      + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720))
    return E, Nn


def build_forest(mid, grid):
    fc = grid.cfg["forest"]
    win, corner = s2_window(fc["winter"], "TCI", grid.cfg["bounds"], fc["tiles"])
    red, _ = s2_window(fc["summer"], "B04", grid.cfg["bounds"], fc["tiles"])
    nir, _ = s2_window(fc["summer"], "B08", grid.cfg["bounds"], fc["tiles"])
    bright = win.astype(float).mean(0) / 255
    r, n = red[0].astype(float), nir[0].astype(float)
    ndvi = (n - r) / (n + r + 1e-6)
    score = np.clip((0.55 - bright) / 0.3, 0, 1) * np.clip((ndvi - 0.35) / 0.3, 0, 1)
    # Sample at twice the game grid's resolution (about 6 m).
    step = grid.cell / 2
    Hf, Wf = grid.H * 2, grid.W * 2
    xs = (np.arange(Wf) + 0.5) * step
    zs = (np.arange(Hf) + 0.5) * step
    X, Z = np.meshgrid(xs, zs)
    lat, lon = grid.to_latlon(X, Z)
    E, N = utm10(lat, lon)
    e0, de, n0, dn = corner[0], 10.0, corner[1], -10.0
    c = (E - e0) / de - 0.5
    rr = (N - n0) / dn - 0.5
    c0 = np.clip(np.floor(c).astype(int), 0, score.shape[1] - 2)
    r0 = np.clip(np.floor(rr).astype(int), 0, score.shape[0] - 2)
    fc_, fr = np.clip(c - c0, 0, 1), np.clip(rr - r0, 0, 1)
    f = (score[r0, c0] * (1 - fc_) + score[r0, c0 + 1] * fc_) * (1 - fr) \
        + (score[r0 + 1, c0] * (1 - fc_) + score[r0 + 1, c0 + 1] * fc_) * fr
    # Treeline: thin out above the lower limit, none above the upper.
    lo, hi = fc["treeline"]
    hfine = np.repeat(np.repeat(grid.h, 2, axis=0), 2, axis=1)[:Hf, :Wf]
    f *= np.clip((hi - hfine) / (hi - lo), 0, 1)
    img = (np.round(f * 15) * 17).astype(np.uint8)  # 16 levels compresses well
    Image.fromarray(img, "L").save(os.path.join(OUT, f"{mid}-forest.png"), optimize=True)
    print(f"{mid}: forest map {Wf}x{Hf}, {100 * (f > 0.5).mean():.0f}% forest")
    return f


# ---------- Routes ----------

def find_route(h, cell, start, finish, forest=None, target_grade=None):
    """Cheapest downhill path on the grid (Dijkstra)."""
    H, W = h.shape
    gy, gx = np.gradient(h, cell)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    # Cost per metre: cheapest on 12-30 degree slopes, rising on cliffs
    # and on near-flat ground where a board would stop.
    pen = np.ones_like(slope)
    pen += np.clip((slope - 30) / 6, 0, None) ** 2 * 3
    pen += np.clip((6 - slope) / 6, 0, None) * 1.5
    if forest is not None:
        pen += forest * 40  # stay in the cleared runs
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
            elif target_grade:
                over = max(0.0, -rise / run - target_grade) / target_grade
                c += run * over * over * 10
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


def smooth_and_resample(pts, step=6.0, window=9):
    """pts in metres -> evenly spaced, gently smoothed line."""
    pts = np.asarray(pts, dtype=np.float64)
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


# ---------- Build ----------

_mountains = {}


def build_mountain(mid):
    if mid in _mountains:
        return _mountains[mid]
    cfg = MOUNTAINS[mid]
    grid = Grid(cfg)
    os.makedirs(OUT, exist_ok=True)
    dm = np.clip(np.round(grid.h * 10), 0, 65535).astype("<u2")
    rgb = np.zeros((grid.H, grid.W, 3), np.uint8)
    rgb[..., 0] = dm >> 8
    rgb[..., 1] = dm & 255
    Image.fromarray(rgb, "RGB").save(os.path.join(OUT, f"{mid}.png"), optimize=True)
    print(f"{mid}: {grid.W}x{grid.H} cells of {grid.cell:.1f} m, "
          f"{grid.h.min():.0f}-{grid.h.max():.0f} m")
    forest = build_forest(mid, grid) if "forest" in cfg else None
    _mountains[mid] = (grid, forest)
    return grid, forest


def build_course(cid):
    cfg = COURSES[cid]
    mid = cfg["mountain"]
    grid, forest = build_mountain(mid)
    route = []
    if "trace" in cfg:
        with open(os.path.join(HERE, cfg["trace"])) as f:
            pts = [grid.to_xz(lat, lon) for lat, lon in json.load(f)["points"]]
        route = smooth_and_resample(pts, window=4)
    elif "start" in cfg:
        def cell_of(lat, lon):
            x, z = grid.to_xz(lat, lon)
            return int(round(z / grid.cell)), int(round(x / grid.cell))
        sy, sx = cell_of(*cfg["start"])
        r = 6  # start on the highest nearby point
        win = grid.h[sy - r:sy + r, sx - r:sx + r]
        iy, ix = np.unravel_index(win.argmax(), win.shape)
        sy, sx = sy - r + iy, sx - r + ix
        fcell = None
        if cfg.get("followRuns") and forest is not None:
            fcell = forest[:grid.H * 2, :grid.W * 2].reshape(grid.H, 2, grid.W, 2).mean(axis=(1, 3))
        path = find_route(grid.h, grid.cell, (sy, sx), cell_of(*cfg["finish"]), fcell, cfg.get("grade"))
        route = smooth_and_resample([(x * grid.cell, z * grid.cell) for x, z in path])

    buildings = []
    if "buildings" in cfg:
        with open(os.path.join(HERE, cfg["buildings"])) as f:
            for b in json.load(f)["buildings"]:
                buildings.append({"area": b["area"], "points": [
                    [round(v, 1) for v in grid.to_xz(lat, lon)] for lat, lon in b["points"]]})

    lifts = []
    with open(os.path.join(HERE, "traces/lifts.json")) as f:
        for lf in json.load(f)["lifts"]:
            st = []
            for p in lf["stations"]:
                x, z = grid.to_xz(p["lat"], p["lon"])
                # keep only stations on the map (Peak 2 Peak runs off it to Blackcomb)
                st.append({"name": p["name"], "x": round(x, 1), "z": round(z, 1)})
            lifts.append({"name": lf["name"], "type": lf["type"], "stations": st})

    spawns = []
    for name, lat, lon in cfg.get("spawns", []):
        x, z = grid.to_xz(lat, lon)
        spawns.append({"name": name, "x": round(x, 1), "z": round(z, 1)})

    if cfg.get("liftSpawns"):
        have = {s["name"] for s in spawns}
        for lf in lifts:
            top = lf["stations"][-1]
            inside = 0 <= top["x"] <= grid.W * grid.cell and 0 <= top["z"] <= grid.H * grid.cell
            if inside and lf["type"] != "gondola" and top["name"] not in have:
                spawns.append({"name": f"Top of {lf['name']}", "x": top["x"], "z": top["z"]})

    north, west, south, east = grid.cfg["bounds"]
    meta = {
        "id": cid,
        "name": cfg["name"],
        "mode": cfg.get("mode", "course"),
        "terrain": mid,
        "forest": f"{mid}-forest" if forest is not None else None,
        "labels": cfg.get("labels", ("START", "FINISH")),
        "width": int(grid.W),
        "height": int(grid.H),
        "cellSize": round(grid.cell, 4),
        "heightScale": 0.1,
        "minElevation": round(float(grid.h.min()), 1),
        "maxElevation": round(float(grid.h.max()), 1),
        "source": "Elevation: Mapzen Terrarium tiles (AWS Open Data: SRTM, CDEM and others). "
                  "Forest: contains modified Copernicus Sentinel-2 data (2023).",
        "bounds": {"north": north, "west": west, "south": south, "east": east},
        "routeSource": cfg.get("routeSource", ""),
        "spawns": spawns,
        "buildings": buildings,
        "lifts": lifts,
        "route": [[round(float(x), 1), round(float(z), 1)] for x, z in route],
    }
    with open(os.path.join(OUT, f"{cid}.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    if len(route):
        length = float(np.sum(np.hypot(*np.diff(route, axis=0).T)))
        drop = grid.height_at(*route[0]) - grid.height_at(*route[-1])
        print(f"{cid}: route {length / 1000:.1f} km, drop {drop:.0f} m")
    else:
        print(f"{cid}: free ride, {len(spawns)} drop-in spots, {len(buildings)} buildings")


if __name__ == "__main__":
    for cid in (sys.argv[1:] or list(COURSES)):
        build_course(cid)
