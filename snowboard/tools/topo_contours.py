"""Read the contour lines from a BC government 1:20,000 topo sheet (a GeoPDF)
and save them on the game's 6 m grid, so build_course.py can lock the terrain
to them.

The sheet used for Whistler is GeoBC TRIM map 092J006 (20 m contours). The PDF
says exactly where its map frame sits on the ground (the GPTS/LPTS tags read
below), so no hand alignment is needed.

How it works:
  1. Render the map at 300 dpi (pdftoppm) and keep the brown contour pixels.
  2. Each connected line gets one elevation: the 20 m step nearest the
     elevation data along it (lines that wander more than 70 m are skipped,
     they are two contours touching on a cliff).
  3. Save a 16-bit PNG on the game's fine grid: elevation in metres on
     contour cells, 0 elsewhere.

Usage (needs pdftoppm, numpy, Pillow, opencv-python-headless):
  python3 tools/topo_contours.py path/to/092J006.pdf
"""

import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_course import MOUNTAINS, Grid, utm10  # noqa: E402

OUT = os.path.join(HERE, "traces", "whistler-contours.png")
DPI = 300
PAGE_H = 2016  # PDF page height in points

# From the PDF's "Main Map" viewport: frame corners (PDF points) and their lat/lon.
BBOX = (36.0003, 1980.00018, 2498.42104, 36.01012)
LPTS = [(0, 1), (0, 0), (1, 0), (1, 1)]
GPTS = [(49.98833, -123.02136), (50.11184, -123.02141), (50.11163, -122.77812), (49.98812, -122.77869)]


def page_to_utm_fit():
    src = np.array([(BBOX[0] + u * (BBOX[2] - BBOX[0]), BBOX[1] + v * (BBOX[3] - BBOX[1])) for u, v in LPTS])
    E, N = utm10(np.array([g[0] for g in GPTS]), np.array([g[1] for g in GPTS]))
    A = np.column_stack([src, np.ones(4)])
    cx = np.linalg.lstsq(A, E, rcond=None)[0]
    cy = np.linalg.lstsq(A, N, rcond=None)[0]
    return cx, cy


def main(pdf):
    import cv2
    cfg = dict(MOUNTAINS["whistler"])
    cfg["downsample"] = 1
    grid = Grid(cfg)
    H, W = grid.h.shape
    cx, cy = page_to_utm_fit()
    Mi = np.linalg.inv(np.array([[cx[0], cx[1]], [cy[0], cy[1]]]))

    # Where each game cell falls on the page (PDF points)
    X, Z = np.meshgrid(np.arange(W) * grid.cell, np.arange(H) * grid.cell)
    E, N = utm10(*grid.to_latlon(X, Z))
    px = Mi[0, 0] * (E - cx[2]) + Mi[0, 1] * (N - cy[2])
    py = Mi[1, 0] * (E - cx[2]) + Mi[1, 1] * (N - cy[2])
    inside = (px > BBOX[0]) & (px < BBOX[2]) & (py > BBOX[3]) & (py < BBOX[1])
    x0, x1 = px[inside].min() - 5, px[inside].max() + 5
    y0, y1 = py[inside].min() - 5, py[inside].max() + 5
    s = DPI / 72
    ox, oy = int(x0 * s), int((PAGE_H - y1) * s)
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["pdftoppm", "-r", str(DPI), "-x", str(ox), "-y", str(oy),
                        "-W", str(int((x1 - x0) * s)), "-H", str(int((y1 - y0) * s)),
                        "-png", pdf, os.path.join(tmp, "m")], check=True)
        Image.MAX_IMAGE_PIXELS = None
        a = np.asarray(Image.open(os.path.join(tmp, "m-1.png")).convert("RGB")).astype(np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    brown = ((r - b) > 40) & ((r - g) > 8) & ((r - g) < 45) & ((g - b) > 15) & (r < 200)
    n, lab = cv2.connectedComponents(brown.astype(np.uint8), connectivity=8)

    # Each render pixel -> game cell (the mapping is affine to within ~3 m here)
    R_x = px * s - ox
    R_y = (PAGE_H - py) * s - oy
    sel = inside
    A = np.column_stack([R_x[sel], R_y[sel], np.ones(sel.sum())])
    fi = np.linalg.lstsq(A, X[sel] / grid.cell, rcond=None)[0]
    fj = np.linalg.lstsq(A, Z[sel] / grid.cell, rcond=None)[0]
    ys, xs = np.nonzero(brown)
    gx = fi[0] * xs + fi[1] * ys + fi[2]
    gz = fj[0] * xs + fj[1] * ys + fj[2]
    ok = (gx >= 0) & (gx < W - 1) & (gz >= 0) & (gz < H - 1)
    ys, xs, gx, gz = ys[ok], xs[ok], gx[ok], gz[ok]
    dem = grid.h[np.round(gz).astype(int), np.round(gx).astype(int)]
    L = lab[ys, xs]

    order = np.argsort(L, kind="stable")
    Ls, ds = L[order], dem[order]
    cuts = np.flatnonzero(np.diff(Ls)) + 1
    level = np.zeros(n)
    for a_, b_ in zip(np.r_[0, cuts], np.r_[cuts, len(Ls)]):
        if b_ - a_ < 40:
            continue  # letters and specks
        v = ds[a_:b_]
        if np.percentile(v, 95) - np.percentile(v, 5) > 70:
            continue  # two contours merged on a cliff
        level[Ls[a_]] = round(float(np.median(v)) / 20) * 20

    out = np.zeros((H, W), np.uint16)
    lv = level[L]
    keep = lv > 0
    out[np.round(gz[keep]).astype(int), np.round(gx[keep]).astype(int)] = lv[keep].astype(np.uint16)
    Image.fromarray(out).save(OUT, optimize=True)
    print(f"{int((out > 0).sum())} contour cells, levels {int(lv[keep].min())}-{int(lv[keep].max())} m -> {OUT}")


if __name__ == "__main__":
    main(sys.argv[1])
