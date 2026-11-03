"""Step 6 - SKETCHFAB PACKAGE: turn WebODM's textured model into an
upload-ready zip in the share/ folder.

WebODM's textured_model.zip holds:
  * an .obj file  - the 3D shape (a long text list of points and triangles)
  * an .mtl file  - says which texture image goes on which triangles
  * .png/.jpg     - the texture images (the photo-coloured "skin")

Sketchfab accepts exactly this trio in one zip. We tidy two things:
  1. RECENTRE: WebODM's coordinates are real-world metres (e.g. x=490000,
     y=5470000). Numbers that large make 3D viewers wobble and hard to
     navigate, so we shift the model so its centre is at 0,0,0.
  2. Z-UP -> Y-UP: maps use Z for height; Sketchfab uses Y. We rotate so
     the model isn't lying on its side when it loads.
Both can be switched off in config.toml.
"""

import tempfile
import zipfile
from pathlib import Path

MODEL_FILE_TYPES = {".obj", ".mtl", ".png", ".jpg", ".jpeg"}


def package_for_sketchfab(textured_zip, share_dir, site, date, cfg_sketchfab, warn):
    share_dir = Path(share_dir)
    share_dir.mkdir(parents=True, exist_ok=True)
    out_zip = share_dir / f"{site}_{date}_sketchfab.zip"

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        with zipfile.ZipFile(textured_zip) as z:
            _safe_extract(z, tmp)

        objs = sorted(tmp.rglob("*.obj"))
        if not objs:
            warn("No .obj model found inside the textured model zip - skipping Sketchfab package.")
            return None
        # Prefer the georeferenced model ("..._geo.obj") if there are several.
        obj = next((o for o in objs if o.stem.endswith("_geo")), objs[0])
        model_dir = obj.parent

        if cfg_sketchfab.get("recenter_model") or cfg_sketchfab.get("convert_z_up_to_y_up"):
            rewrite_obj(obj, recenter=cfg_sketchfab.get("recenter_model", True),
                        z_up_to_y_up=cfg_sketchfab.get("convert_z_up_to_y_up", True))

        # Zip the .obj, .mtl and textures from that folder (flat, no sub-folders).
        with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED) as z:
            for f in sorted(model_dir.iterdir()):
                if f.suffix.lower() in MODEL_FILE_TYPES and f.is_file():
                    z.write(f, arcname=f.name)

    size_mb = out_zip.stat().st_size / 1e6
    if size_mb > cfg_sketchfab.get("warn_size_mb", 100):
        warn(f"Sketchfab zip is {size_mb:.0f} MB - check your plan's upload limit. "
             "A lower mesh-size in the preset makes smaller models.")
    return out_zip


def rewrite_obj(obj_path, recenter=True, z_up_to_y_up=True):
    """Shift and/or rotate the model by editing the 'v' (vertex) and 'vn'
    (normal direction) lines of the .obj text file. Every other line
    (texture coordinates, faces, material names) is left exactly as is.

    This runs on a temporary extracted copy - never on WebODM's download.
    """
    # Pass 1: find the middle of the model (centre of its bounding box).
    mins = [float("inf")] * 3
    maxs = [float("-inf")] * 3
    with open(obj_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith("v "):
                xyz = [float(n) for n in line.split()[1:4]]
                mins = [min(a, b) for a, b in zip(mins, xyz)]
                maxs = [max(a, b) for a, b in zip(maxs, xyz)]
    if mins[0] == float("inf"):
        return  # no vertices; nothing to do
    centre = [(a + b) / 2 for a, b in zip(mins, maxs)] if recenter else [0, 0, 0]

    def rotate(x, y, z):
        # Z-up to Y-up: a quarter turn about the X axis. Height (z) becomes y,
        # and north (y) becomes -z (pointing "into" the screen).
        return (x, z, -y) if z_up_to_y_up else (x, y, z)

    # Pass 2: write a new file line by line (works for very large models).
    new_path = obj_path.with_suffix(".tmp")
    with open(obj_path, encoding="utf-8", errors="replace") as src, \
            open(new_path, "w", encoding="utf-8") as dst:
        for line in src:
            if line.startswith("v "):
                parts = line.split()
                x, y, z = (float(n) - c for n, c in zip(parts[1:4], centre))
                rest = " ".join(parts[4:])  # some OBJs carry vertex colours after xyz
                x, y, z = rotate(x, y, z)
                dst.write(f"v {x:.4f} {y:.4f} {z:.4f}{(' ' + rest) if rest else ''}\n")
            elif line.startswith("vn ") and z_up_to_y_up:
                x, y, z = (float(n) for n in line.split()[1:4])
                x, y, z = rotate(x, y, z)
                dst.write(f"vn {x:.6f} {y:.6f} {z:.6f}\n")
            else:
                dst.write(line)
    new_path.replace(obj_path)


def _safe_extract(zf, dest):
    """Extract a zip, refusing any entry that tries to escape the folder
    (a known trick with malicious zips - good habit even for trusted ones)."""
    dest = dest.resolve()
    for member in zf.namelist():
        target = (dest / member).resolve()
        if not target.is_relative_to(dest):
            raise ValueError(f"Unsafe path inside zip: {member}")
    zf.extractall(dest)
