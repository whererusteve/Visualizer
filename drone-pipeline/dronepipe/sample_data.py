"""Make fake drone photos with realistic DJI-style metadata.

Why? So you (and the automated tests) can try every step without your
real photos. The pictures are tiny noise images - WebODM can't build a
map from them - but their EXIF/XMP looks like an Air 3S flight:

  * a 4-line x 8-photo nadir grid at 100 m (about 80% front / 70% side overlap)
  * 6 oblique photos at -45° around the site
  * 1 photo with no GPS (to trigger that warning)
  * 2 "DNG" files (really small TIFFs - enough to test the file handling)

Location: an invented spot near Whistler, BC (UTM zone 10).
"""

import math
import struct
import random
from datetime import datetime, timedelta
from pathlib import Path

from PIL import Image

CENTRE_LAT, CENTRE_LON = 50.0800, -122.9900
START = datetime(2026, 2, 14, 10, 0, 0)
# The real Air 3S wide camera makes 8192 x 6144 photos; we only CLAIM that
# size in the EXIF (so the overlap maths is realistic) and save small images.
CLAIMED_SIZE = (8192, 6144)
SAVED_SIZE = (160, 120)
METRES_PER_DEG_LAT = 111_195


def offset(lat, lon, east_m, north_m):
    """Move a GPS point by some metres east and north."""
    return (lat + north_m / METRES_PER_DEG_LAT,
            lon + east_m / (METRES_PER_DEG_LAT * math.cos(math.radians(lat))))


def make_sample_flight(folder, seed=1):
    folder = Path(folder)
    # Mimic an SD card layout.
    card = folder / "DCIM" / "DJI_001"
    card.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)  # fixed seed = same "random" images each time
    paths = []
    n = 0
    t = START

    # Nadir grid: 4 lines, 8 photos each, 22 m apart along a line, 43 m between lines.
    for line in range(4):
        for k in range(8):
            along = k if line % 2 == 0 else 7 - k  # "lawnmower" back-and-forth
            lat, lon = offset(CENTRE_LAT, CENTRE_LON, line * 43 - 65, along * 22 - 77)
            n += 1
            paths.append(_write_photo(card / f"DJI_{START:%Y%m%d}{n:04d}_V.JPG", rng,
                                      lat, lon, rel_alt=100.0, pitch=-90.0, time=t))
            t += timedelta(seconds=3)

    # Battery swap: a gap, then an oblique orbit.
    t += timedelta(minutes=6)
    for k in range(6):
        angle = math.radians(k * 60)
        lat, lon = offset(CENTRE_LAT, CENTRE_LON, 120 * math.cos(angle), 120 * math.sin(angle))
        n += 1
        paths.append(_write_photo(card / f"DJI_{START:%Y%m%d}{n:04d}_V.JPG", rng,
                                  lat, lon, rel_alt=80.0, pitch=-45.0, time=t))
        t += timedelta(seconds=5)

    # One photo with no GPS (e.g. taken before satellites locked on).
    n += 1
    paths.append(_write_photo(card / f"DJI_{START:%Y%m%d}{n:04d}_V.JPG", rng,
                              None, None, rel_alt=2.0, pitch=0.0, time=START - timedelta(minutes=1)))

    # Two "DNG" raw files that pair with the first two JPEGs.
    for i in (1, 2):
        lat, lon = offset(CENTRE_LAT, CENTRE_LON, -65, (i - 1) * 22 - 77)
        paths.append(_write_photo(card / f"DJI_{START:%Y%m%d}{i:04d}_V.DNG", rng,
                                  lat, lon, rel_alt=100.0, pitch=-90.0,
                                  time=START + timedelta(seconds=3 * (i - 1)), raw=True))
    return paths


def _write_photo(path, rng, lat, lon, rel_alt, pitch, time, raw=False):
    im = Image.effect_noise(SAVED_SIZE, rng.randint(20, 80)).convert("RGB")
    exif = Image.Exif()
    exif[0x010F] = "DJI"
    exif[0x0110] = "FC9184"  # placeholder model code - not verified as the Air 3S's real one
    exif_ifd = exif.get_ifd(0x8769)
    exif_ifd[0x9003] = time.strftime("%Y:%m:%d %H:%M:%S")
    exif_ifd[0xA405] = 24
    exif_ifd[0xA002], exif_ifd[0xA003] = CLAIMED_SIZE
    takeoff_alt = 1450.0  # pretend take-off point elevation (m)
    if lat is not None:
        gps = exif.get_ifd(0x8825)
        gps[1], gps[2] = ("N" if lat >= 0 else "S"), _dms(lat)
        gps[3], gps[4] = ("E" if lon >= 0 else "W"), _dms(lon)
        gps[5], gps[6] = 0, takeoff_alt + rel_alt
    xmp = (
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF '
        'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        '<rdf:Description xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/" '
        f'drone-dji:GimbalPitchDegree="{pitch:+.2f}" '
        f'drone-dji:RelativeAltitude="{rel_alt:+.2f}" '
        f'drone-dji:AbsoluteAltitude="{takeoff_alt + rel_alt:+.2f}"/>'
        '</rdf:RDF></x:xmpmeta>').encode()
    if raw:
        # DNG files are built on the TIFF format. Pillow can't write the GPS
        # section into a TIFF, so we assemble a tiny one by hand instead.
        path.write_bytes(_tiny_dng_like_tiff(exif, xmp))
    else:
        im.save(path, format="JPEG", exif=exif, xmp=xmp, quality=80)
    return path


def _dms(value):
    """Decimal degrees -> (degrees, minutes, seconds), as EXIF stores GPS."""
    value = abs(value)
    d = int(value)
    m = int((value - d) * 60)
    s = round(((value - d) * 60 - m) * 60, 4)
    return (float(d), float(m), s)


def _tiny_dng_like_tiff(exif, xmp):
    """Build the bytes of a minimal 8x8 grey TIFF that carries Make/Model,
    an EXIF block, a GPS block and XMP - laid out the way a DNG does.

    You don't need to understand this to use the pipeline! It exists only
    so the tests can check that DNG metadata is read correctly.

    TIFF layout: an 8-byte header, then "IFDs" (directories). Each IFD is a
    list of 12-byte entries: tag number, data type, count, and either the
    value itself (if it fits in 4 bytes) or where in the file to find it.
    """
    ASCII, SHORT, LONG, RATIONAL, UNDEFINED, BYTE = 2, 3, 4, 5, 7, 1
    exif_ifd, gps_ifd = exif.get_ifd(0x8769), exif.get_ifd(0x8825)
    pixels = bytes(range(64))

    def entry(tag, value):
        if isinstance(value, str):
            return (tag, ASCII, value.encode() + b"\0")
        if isinstance(value, bytes):
            return (tag, UNDEFINED if tag == 700 else BYTE, value)
        if isinstance(value, tuple):  # GPS degrees/minutes/seconds
            return (tag, RATIONAL, [(round(v * 10000), 10000) for v in value])
        if isinstance(value, float):
            return (tag, RATIONAL, [(round(value * 100), 100)])
        return (tag, SHORT if value < 65536 else LONG, [value])

    def size_of(e):
        tag, typ, vals = e
        return len(vals) if typ in (ASCII, UNDEFINED, BYTE) else len(vals) * {SHORT: 2, LONG: 4, RATIONAL: 8}[typ]

    def build_ifd(entries, start):
        """Return the bytes of one IFD placed at file offset 'start'."""
        entries = sorted(entries)
        data_at = start + 2 + 12 * len(entries) + 4
        head, data = struct.pack("<H", len(entries)), b""
        for tag, typ, vals in entries:
            if typ in (ASCII, UNDEFINED, BYTE):
                raw = bytes(vals)
            elif typ == RATIONAL:
                raw = b"".join(struct.pack("<II", a, b) for a, b in vals)
            else:
                raw = b"".join(struct.pack("<H" if typ == SHORT else "<I", v) for v in vals)
            count = len(vals)
            if len(raw) <= 4:
                head += struct.pack("<HHI", tag, typ, count) + raw.ljust(4, b"\0")
            else:
                head += struct.pack("<HHI", tag, typ, count) + struct.pack("<I", data_at + len(data))
                data += raw + (b"\0" if len(raw) % 2 else b"")
        return head + struct.pack("<I", 0) + data

    sub_exif = [entry(t, v) for t, v in exif_ifd.items()]
    sub_gps = [entry(t, v) for t, v in gps_ifd.items()]
    main = [entry(0x010F, exif[0x010F]), entry(0x0110, exif[0x0110]),
            (256, SHORT, [8]), (257, SHORT, [8]), (258, SHORT, [8]), (259, SHORT, [1]),
            (262, SHORT, [1]), (273, LONG, [0]), (277, SHORT, [1]), (278, SHORT, [8]),
            (279, LONG, [64]), (700, UNDEFINED, xmp),
            (0x8769, LONG, [0])] + ([(0x8825, LONG, [0])] if sub_gps else [])

    # Work out where everything goes, then fill in the pointers.
    ifd0_len = 2 + 12 * len(main) + 4 + sum(size_of(e) + size_of(e) % 2 for e in main if size_of(e) > 4)
    exif_at = 8 + ifd0_len
    exif_len = len(build_ifd(sub_exif, exif_at))
    gps_at = exif_at + exif_len
    gps_len = len(build_ifd(sub_gps, gps_at)) if sub_gps else 0
    pixels_at = gps_at + gps_len
    fixed = {273: [pixels_at], 0x8769: [exif_at], 0x8825: [gps_at]}
    main = [(t, ty, fixed.get(t, v)) for t, ty, v in main]

    out = b"II*\0" + struct.pack("<I", 8) + build_ifd(main, 8) + build_ifd(sub_exif, exif_at)
    if sub_gps:
        out += build_ifd(sub_gps, gps_at)
    assert len(out) == pixels_at
    return out + pixels
