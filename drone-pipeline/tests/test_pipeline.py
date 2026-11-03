"""Automated checks for every step. Run them with:

    python -m unittest discover -s tests -v

Each test makes its own fake photos / fake WebODM in a temporary folder,
so nothing touches your real files. "OK" at the end means all passed.
"""

import hashlib
import io
import os
import sys
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

# Let the tests import the dronepipe package from the folder above.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from dronepipe import cli
from dronepipe.config import load_config
from dronepipe.exif_reader import PhotoInfo, read_folder, read_photo
from dronepipe.organize import check_site_name, copy_photos
from dronepipe.report import build_report, format_report
from dronepipe.sample_data import make_sample_flight
from dronepipe.sketchfab import rewrite_obj

CFG = load_config()


def fingerprint(folder):
    """A hash of every file in a folder - proves nothing was changed."""
    h = hashlib.sha256()
    for p in sorted(Path(folder).rglob("*")):
        if p.is_file():
            h.update(str(p.relative_to(folder)).encode())
            h.update(p.read_bytes())
            h.update(str(p.stat().st_mtime).encode())
    return h.hexdigest()


class TempDirTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()


class TestIngest(TempDirTest):
    def test_reads_dji_metadata_from_jpeg_and_dng(self):
        make_sample_flight(self.tmp / "card")
        photos = read_folder(self.tmp / "card", progress=False)
        self.assertEqual(len(photos), 41)
        first = next(p for p in photos if p.path.name.endswith("0001_V.JPG"))
        self.assertAlmostEqual(first.lat, 50.0793, places=3)
        self.assertLess(first.lon, -122)          # West = negative
        self.assertEqual(first.gimbal_pitch, -90.0)
        self.assertEqual(first.relative_altitude_m, 100.0)
        self.assertEqual(first.camera_model, "FC9184")
        self.assertEqual(first.timestamp, datetime(2026, 2, 14, 10, 0, 0))
        dng = next(p for p in photos if p.path.suffix == ".DNG")
        self.assertTrue(dng.is_raw)
        self.assertAlmostEqual(dng.lat, first.lat, places=5)
        self.assertEqual(dng.gimbal_pitch, -90.0)

    def test_ignores_videos_and_hidden_files(self):
        make_sample_flight(self.tmp / "card")
        (self.tmp / "card" / "DJI_0099.MP4").write_bytes(b"video")
        (self.tmp / "card" / "._DJI_0001.JPG").write_bytes(b"mac junk")
        self.assertEqual(len(read_folder(self.tmp / "card", progress=False)), 41)

    def test_broken_file_is_reported_not_fatal(self):
        bad = self.tmp / "broken.jpg"
        bad.write_bytes(b"not really a jpeg")
        info = read_photo(bad)
        self.assertFalse(info.has_gps)
        self.assertTrue(info.problems)


class TestReport(TempDirTest):
    def test_counts_and_overlap(self):
        make_sample_flight(self.tmp / "card")
        r = build_report(read_folder(self.tmp / "card", progress=False), CFG)
        self.assertEqual(r["flight_date"], "2026-02-14")
        self.assertEqual(r["pointing"]["oblique"], 6)
        self.assertEqual(r["pointing"]["near-horizontal"], 1)
        self.assertEqual(len(r["missing_gps"]), 1)
        self.assertEqual(r["utm_zone"], 10)
        self.assertEqual(r["flight_segments"], 2)
        # The sample grid was designed for ~80% front / ~70% side overlap.
        self.assertAlmostEqual(r["overlap"]["front_overlap_pct"], 80, delta=3)
        self.assertAlmostEqual(r["overlap"]["side_overlap_pct"], 70, delta=3)
        self.assertIn("PRE-FLIGHT REPORT", format_report(r, self.tmp))

    def test_sparse_flight_warns(self):
        # 10 photos in a line, 60 m apart at 100 m height: far too sparse.
        start = datetime(2026, 3, 1, 9, 0)
        photos = [PhotoInfo(path=Path(f"p{i}.jpg"), lat=50 + i * 60 / 111195, lon=-123,
                            relative_altitude_m=100, gimbal_pitch=-90, focal_35mm=24,
                            width_px=8192, height_px=6144, timestamp=start + timedelta(seconds=5 * i))
                  for i in range(10)]
        r = build_report(photos, CFG)
        self.assertTrue(any("Front overlap looks low" in w for w in r["warnings"]))

    def test_empty_folder(self):
        r = build_report([], CFG)
        self.assertEqual(r["image_count"], 0)
        self.assertTrue(r["warnings"])


class TestOrganize(TempDirTest):
    def test_copies_without_touching_originals(self):
        card = self.tmp / "card"
        make_sample_flight(card)
        before = fingerprint(card)
        photos = read_folder(card, progress=False)
        raw = self.tmp / "Projects" / "site" / "2026-02-14" / "raw"
        s = copy_photos(photos, raw, progress=False)
        self.assertEqual(s["copied"], 41)
        self.assertEqual(len(list(raw.iterdir())), 41)
        # Running again copies nothing new and overwrites nothing.
        s2 = copy_photos(photos, raw, progress=False)
        self.assertEqual((s2["copied"], s2["already_there"]), (0, 41))
        self.assertEqual(fingerprint(card), before, "original photos were changed!")

    def test_same_name_from_two_card_folders_keeps_both(self):
        for sub, content in (("100MEDIA", b"A" * 10), ("101MEDIA", b"B" * 20)):
            (self.tmp / sub).mkdir()
            (self.tmp / sub / "DJI_0001.JPG").write_bytes(content)
        photos = [PhotoInfo(path=self.tmp / s / "DJI_0001.JPG") for s in ("100MEDIA", "101MEDIA")]
        s = copy_photos(photos, self.tmp / "raw", progress=False)
        self.assertEqual(s["renamed"], 1)
        names = sorted(p.name for p in (self.tmp / "raw").iterdir())
        self.assertEqual(names, ["101MEDIA_DJI_0001.JPG", "DJI_0001.JPG"])

    def test_site_names(self):
        self.assertEqual(check_site_name("metal-dome"), "metal-dome")
        for bad in ("Metal Dome", "metal_dome", "../x", ""):
            with self.assertRaises(ValueError):
                check_site_name(bad)


class TestSketchfab(TempDirTest):
    def test_recentre_and_rotate(self):
        obj = self.tmp / "m.obj"
        obj.write_text("v 100 200 10\nv 102 204 12\nvn 0 0 1\nf 1 2 1\n")
        rewrite_obj(obj)
        lines = obj.read_text().splitlines()
        # Centre was (101, 202, 11); then Z-up -> Y-up: (x, z, -y)
        self.assertEqual(lines[0], "v -1.0000 -1.0000 2.0000")
        self.assertEqual(lines[1], "v 1.0000 1.0000 -2.0000")
        self.assertEqual(lines[2], "vn 0.000000 1.000000 -0.000000")
        self.assertEqual(lines[3], "f 1 2 1")


class TestFullRun(TempDirTest):
    """The whole pipeline against the fake WebODM server."""

    def setUp(self):
        super().setUp()
        from fake_webodm import FakeWebODM, PASSWORD
        self.server = FakeWebODM().start()
        os.environ["WEBODM_PASSWORD"] = PASSWORD
        # A test copy of config.toml pointing at the fake server, polling instantly.
        text = Path(CFG["_path"]).read_text()
        text = text.replace('url = "http://localhost:8000"', f'url = "{self.server.url}"')
        text = text.replace("poll_seconds = 10", "poll_seconds = 0")
        self.config = self.tmp / "config.toml"
        self.config.write_text(text)
        self.card = self.tmp / "card"
        make_sample_flight(self.card)
        self.root = self.tmp / "Projects"

    def tearDown(self):
        self.server.stop()
        os.environ.pop("WEBODM_PASSWORD", None)
        super().tearDown()

    def run_cli(self, *args):
        out = io.StringIO()
        with redirect_stdout(out):
            cli.main(["--config", str(self.config), *args])
        return out.getvalue()

    def test_full_run(self):
        import rasterio
        before = fingerprint(self.card)
        self.run_cli("run", str(self.card), "--site", "metal-dome", "--preset",
                     "terrain-high-quality", "--yes", "--projects-root", str(self.root))
        day = self.root / "metal-dome" / "2026-02-14"
        out = day / "outputs"
        for suffix in ("orthophoto.tif", "dsm.tif", "dtm.tif", "pointcloud.laz",
                       "textured-model.zip", "odm-quality-report.pdf"):
            self.assertTrue((out / f"metal-dome_2026-02-14_{suffix}").exists(), suffix)
        # Every GeoTIFF ends up in UTM 10N; the lat/lon orthophoto got reprojected.
        for name in ("orthophoto", "dsm", "dtm"):
            with rasterio.open(out / f"metal-dome_2026-02-14_{name}.tif") as f:
                self.assertEqual(f.crs.to_epsg(), 32610, name)
        self.assertTrue((out / "original-crs" / "metal-dome_2026-02-14_orthophoto.tif").exists())
        # Only the 39 JPEGs were uploaded (DNGs are copied but not sent by default).
        self.assertEqual(sum(self.server.uploads.values()), 39)
        self.assertEqual(len(list((day / "raw").iterdir())), 41)
        # Sketchfab zip: flat obj + mtl + png, recentred.
        with zipfile.ZipFile(day / "share" / "metal-dome_2026-02-14_sketchfab.zip") as z:
            names = sorted(z.namelist())
            self.assertEqual([n.rsplit(".", 1)[1] for n in names], ["mtl", "obj", "png"])
            obj = z.read(next(n for n in names if n.endswith(".obj"))).decode()
            self.assertNotIn("494010", obj)
        log = (day / "run_log.md").read_text()
        self.assertIn("terrain-high-quality", log)
        self.assertIn("1.6 minutes", log)  # fake processing_time 95 s
        self.assertEqual(fingerprint(self.card), before, "original photos were changed!")

    def test_missing_dtm_is_a_warning(self):
        self.server.stop()
        from fake_webodm import FakeWebODM
        self.server = FakeWebODM(produce_dtm=False).start()
        self.config.write_text(self.config.read_text().replace(
            self.config.read_text().split('url = "')[1].split('"')[0], self.server.url))
        self.run_cli("run", str(self.card), "--site", "metal-dome", "--yes",
                     "--projects-root", str(self.root))
        log = (self.root / "metal-dome" / "2026-02-14" / "run_log.md").read_text()
        self.assertIn("didn't produce dtm.tif", log)

    def test_organize_only_and_no_confirmation(self):
        self.run_cli("run", str(self.card), "--site", "test-site", "--organize-only", "--yes",
                     "--projects-root", str(self.root))
        day = self.root / "test-site" / "2026-02-14"
        self.assertEqual(len(list((day / "raw").iterdir())), 41)
        self.assertFalse((day / "outputs").exists())
        self.assertEqual(self.server.tasks, {})

    def test_declining_confirmation_copies_nothing(self):
        import builtins
        real_input = builtins.input
        builtins.input = lambda prompt="": "n"
        try:
            self.run_cli("run", str(self.card), "--site", "test-site",
                         "--projects-root", str(self.root))
        finally:
            builtins.input = real_input
        self.assertFalse((self.root / "test-site").exists())

    def test_resume(self):
        self.run_cli("run", str(self.card), "--site", "metal-dome", "--yes",
                     "--projects-root", str(self.root))
        out = self.run_cli("resume", "--site", "metal-dome", "--date", "2026-02-14",
                           "--projects-root", str(self.root))
        self.assertIn("All done", out)
        log = (self.root / "metal-dome" / "2026-02-14" / "run_log.md").read_text()
        self.assertEqual(log.count("## Run at"), 2)  # second run appended, not overwritten


class TestDiff(TempDirTest):
    def make_dsm(self, path, values, res=0.5, epsg=32610):
        import rasterio
        from rasterio.transform import from_origin
        with rasterio.open(path, "w", driver="GTiff", width=values.shape[1],
                           height=values.shape[0], count=1, dtype="float32",
                           crs=f"EPSG:{epsg}", nodata=-9999,
                           transform=from_origin(494000, 5548000, res, res)) as f:
            f.write(values.astype("float32"), 1)

    def test_change_and_offset_removal(self):
        import numpy as np
        import rasterio
        base = 1500 + np.add.outer(np.arange(100), np.arange(100)) * 0.05
        later = base + 2.0                 # whole flight sits 2 m higher (GPS offset)
        later[60:80, 60:80] += 3.0         # plus a real 3 m debris pile (10 m x 10 m)
        self.make_dsm(self.tmp / "a.tif", base)
        self.make_dsm(self.tmp / "b.tif", later)
        # Stable area = the top-left corner (x 494000-494010, y 5547990-5548000).
        args = SimpleNamespace(before=str(self.tmp / "a.tif"), after=str(self.tmp / "b.tif"),
                               site=None, surface="dsm", stable_area="494000,5547990,494010,5548000",
                               out=str(self.tmp / "out"), projects_root=str(self.tmp),
                               min_change=0.5)
        from dronepipe.diff import run_diff
        with redirect_stdout(io.StringIO()):
            tif, stats = run_diff(args, CFG)
        self.assertAlmostEqual(stats["offset_removed"], 2.0, places=3)
        self.assertAlmostEqual(stats["gain_m3_significant"], 3.0 * 100, delta=1)  # 3 m x 100 m2
        with rasterio.open(tif) as f:
            data = f.read(1)
        self.assertAlmostEqual(float(data[70, 70]), 3.0, places=3)
        self.assertAlmostEqual(float(data[10, 10]), 0.0, places=3)
        self.assertTrue(tif.with_suffix(".qml").exists())
        self.assertIn("HOW FAR TO TRUST THIS", tif.with_suffix(".txt").read_text())

    def test_different_resolutions_line_up(self):
        import numpy as np
        self.make_dsm(self.tmp / "fine.tif", np.full((100, 100), 1500.0), res=0.5)
        self.make_dsm(self.tmp / "coarse.tif", np.full((25, 25), 1501.0), res=2.0)
        args = SimpleNamespace(before=str(self.tmp / "fine.tif"), after=str(self.tmp / "coarse.tif"),
                               site=None, surface="dsm", stable_area=None, out=str(self.tmp / "o"),
                               projects_root=str(self.tmp), min_change=0.5)
        from dronepipe.diff import run_diff
        with redirect_stdout(io.StringIO()):
            _, stats = run_diff(args, CFG)
        self.assertEqual(stats["pixel_size"], 2.0)        # used the coarser grid
        self.assertAlmostEqual(stats["median_m"], 1.0, places=3)


if __name__ == "__main__":
    unittest.main()
