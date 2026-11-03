"""A pretend WebODM server for testing - no Docker, no real processing.

It answers the same web addresses the pipeline uses, in the same shapes
the real WebODM does (as best I know them), and hands back tiny fake
results. That lets the tests check the whole pipeline end to end.

You can also run it by hand to watch the pipeline work:
    python tests/fake_webodm.py          (then password is "test")
and set url = "http://localhost:8765" in a copy of config.toml.
"""

import io
import json
import re
import tempfile
import threading
import uuid
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PASSWORD = "test"
TOKEN = "fake-token-123"
KNOWN_OPTIONS = ["pc-quality", "feature-quality", "dsm", "dtm", "dem-resolution",
                 "orthophoto-resolution", "auto-boundary", "min-num-features",
                 "mesh-octree-depth", "mesh-size", "fast-orthophoto"]


def make_fake_assets(folder, produce_dtm=True):
    """Create small but real GeoTIFFs plus a fake model zip, laz and pdf."""
    import numpy as np
    import rasterio
    from rasterio.transform import from_origin

    folder = Path(folder)
    # A tilted surface ~1500 m high in UTM zone 10 (what WebODM would give in SW BC).
    dem = (1500 + np.add.outer(np.arange(50), np.arange(50)) * 0.1).astype("float32")
    utm = dict(driver="GTiff", width=50, height=50, count=1, dtype="float32",
               crs="EPSG:32610", transform=from_origin(494000, 5548000, 0.5, 0.5), nodata=-9999)
    with rasterio.open(folder / "dsm.tif", "w", **utm) as f:
        f.write(dem, 1)
    if produce_dtm:
        with rasterio.open(folder / "dtm.tif", "w", **utm) as f:
            f.write(dem - 0.2, 1)
    # The orthophoto deliberately comes back in lat/lon (EPSG:4326) so the
    # tests can check that reprojection to UTM works.
    rgb = np.random.default_rng(0).integers(0, 255, (3, 40, 40), dtype="uint8")
    with rasterio.open(folder / "orthophoto.tif", "w", driver="GTiff", width=40, height=40,
                       count=3, dtype="uint8", crs="EPSG:4326",
                       transform=from_origin(-123.0, 50.08, 0.00001, 0.00001)) as f:
        f.write(rgb)

    (folder / "georeferenced_model.laz").write_bytes(b"LASF fake point cloud")
    (folder / "report.pdf").write_bytes(b"%PDF-1.4 fake report")

    # A textured model zip like WebODM's: odm_texturing/ with obj + mtl + png
    obj = ("mtllib odm_textured_model_geo.mtl\n"
           "v 494010.0 5547990.0 1501.0\nv 494020.0 5547990.0 1502.0\n"
           "v 494010.0 5548000.0 1503.0\nvt 0 0\nvt 1 0\nvt 0 1\nvn 0 0 1\n"
           "usemtl material0\nf 1/1/1 2/2/1 3/3/1\n")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("odm_texturing/odm_textured_model_geo.obj", obj)
        z.writestr("odm_texturing/odm_textured_model_geo.mtl",
                   "newmtl material0\nmap_Kd odm_textured_model_geo_material0000_map_Kd.png\n")
        z.writestr("odm_texturing/odm_textured_model_geo_material0000_map_Kd.png", b"\x89PNG fake")
    (folder / "textured_model.zip").write_bytes(buf.getvalue())


class FakeWebODM:
    """Start with FakeWebODM().start(); read .url; stop with .stop()."""

    def __init__(self, port=0, produce_dtm=True, fail=False):
        self.tmp = tempfile.TemporaryDirectory()
        self.assets_dir = Path(self.tmp.name)
        make_fake_assets(self.assets_dir, produce_dtm)
        self.available = ["all.zip", "orthophoto.tif", "dsm.tif", "georeferenced_model.laz",
                          "textured_model.zip", "report.pdf"] + (["dtm.tif"] if produce_dtm else [])
        self.fail = fail
        self.projects = []
        self.tasks = {}
        self.uploads = {}
        self.server = ThreadingHTTPServer(("127.0.0.1", port), self._handler())
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def start(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def _handler(self):
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # keep test output quiet
                pass

            def _send(self, code, body, ctype="application/json"):
                data = json.dumps(body).encode() if ctype == "application/json" else body
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _body(self):
                return self.rfile.read(int(self.headers.get("Content-Length") or 0))

            def _authed(self):
                if self.headers.get("Authorization") != f"JWT {TOKEN}":
                    self._send(403, {"detail": "not logged in"})
                    return False
                return True

            def do_POST(self):
                path, body = self.path.split("?")[0], self._body()
                if path == "/api/token-auth/":
                    ok = f"password={PASSWORD}".encode() in body
                    return self._send(200, {"token": TOKEN}) if ok else self._send(400, {"error": "bad"})
                if not self._authed():
                    return
                if path == "/api/projects/":
                    pid = len(fake.projects) + 1
                    name = re.search(rb"name=([^&]*)", body).group(1).decode()
                    fake.projects.append({"id": pid, "name": name.replace("+", " ")
                                          .replace("%3A", ":")})
                    return self._send(201, {"id": pid})
                m = re.match(r"^/api/projects/(\d+)/tasks/$", path)
                if m:
                    tid = str(uuid.uuid4())
                    fake.tasks[tid] = {"id": tid, "status": None, "running_progress": 0,
                                       "options": body.decode(errors="ignore"), "polls": 0}
                    fake.uploads[tid] = 0
                    return self._send(201, {"id": tid})
                m = re.match(r"^/api/projects/\d+/tasks/([\w-]+)/upload/$", path)
                if m:
                    fake.uploads[m.group(1)] += body.count(b'name="images"')
                    return self._send(200, {"success": True})
                m = re.match(r"^/api/projects/\d+/tasks/([\w-]+)/commit/$", path)
                if m:
                    fake.tasks[m.group(1)]["status"] = 10  # QUEUED
                    return self._send(200, fake.tasks[m.group(1)])
                self._send(404, {"detail": "not found"})

            def do_GET(self):
                path = self.path.split("?")[0]
                if not self._authed():
                    return
                if path == "/api/projects/":
                    return self._send(200, fake.projects)
                if path == "/api/processingnodes/":
                    return self._send(200, [{"id": 1, "available_options":
                                             [{"name": n} for n in KNOWN_OPTIONS]}])
                m = re.match(r"^/api/projects/\d+/tasks/([\w-]+)/$", path)
                if m:
                    t = fake.tasks[m.group(1)]
                    # Each status check moves the pretend job along.
                    t["polls"] += 1
                    if t["polls"] == 1:
                        t.update(status=20, running_progress=0.4)
                    elif t["polls"] >= 2:
                        if fake.fail:
                            t.update(status=30, last_error="Not enough overlap (fake)")
                        else:
                            t.update(status=40, running_progress=1.0, processing_time=95000,
                                     available_assets=fake.available)
                    return self._send(200, t)
                m = re.match(r"^/api/projects/\d+/tasks/([\w-]+)/output/$", path)
                if m:
                    return self._send(200, "Running opensfm stage\nRunning meshing stage")
                m = re.match(r"^/api/projects/\d+/tasks/([\w-]+)/download/(.+)$", path)
                if m:
                    f = fake.assets_dir / m.group(2)
                    if not f.exists():
                        return self._send(404, {"detail": "no such asset"})
                    return self._send(200, f.read_bytes(), "application/octet-stream")
                self._send(404, {"detail": "not found"})

        return Handler


if __name__ == "__main__":
    srv = FakeWebODM(port=8765).start()
    print(f"Fake WebODM running at {srv.url} (password: {PASSWORD}). Ctrl+C to stop.")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        srv.stop()
