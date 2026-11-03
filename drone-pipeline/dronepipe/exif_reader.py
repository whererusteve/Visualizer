"""Step 1 - INGEST: read the metadata stored inside each drone photo.

Every photo carries two hidden blocks of information:

* EXIF - a camera-industry standard. Holds GPS position, GPS altitude,
  the time the photo was taken, the camera model, and the lens's
  "35 mm equivalent" focal length.
* XMP - a newer, text-based block. DJI uses it for drone-specific data
  that EXIF has no slot for, like the GIMBAL PITCH (where the camera
  was pointing) and the height above the take-off point.

We only ever OPEN photos for reading. Nothing here can change your files.
"""

import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from PIL import Image

# File types we treat as photos. Everything else on an SD card
# (videos, .SRT subtitle logs, .LRF low-res previews) is ignored.
JPEG_EXTENSIONS = {".jpg", ".jpeg"}
RAW_EXTENSIONS = {".dng"}
IMAGE_EXTENSIONS = JPEG_EXTENSIONS | RAW_EXTENSIONS

# EXIF tags are identified by numbers. These are the ones we use.
TAG_MAKE = 0x010F
TAG_MODEL = 0x0110
TAG_EXIF_IFD = 0x8769          # pointer to the "Exif" sub-block
TAG_GPS_IFD = 0x8825           # pointer to the "GPS" sub-block
TAG_DATETIME_ORIGINAL = 0x9003
TAG_FOCAL_35MM = 0xA405
TAG_PIXEL_WIDTH = 0xA002
TAG_PIXEL_HEIGHT = 0xA003
TAG_XMP_TIFF = 700             # where TIFF-based files (like DNG) keep XMP

# Inside the GPS sub-block:
GPS_LAT_REF, GPS_LAT, GPS_LON_REF, GPS_LON, GPS_ALT_REF, GPS_ALT = 1, 2, 3, 4, 5, 6


@dataclass
class PhotoInfo:
    """Everything we learn about one photo. Missing values stay as None."""
    path: Path
    is_raw: bool = False
    camera_make: str | None = None
    camera_model: str | None = None
    timestamp: datetime | None = None
    lat: float | None = None
    lon: float | None = None
    gps_altitude_m: float | None = None       # GPS height (roughly above sea level)
    relative_altitude_m: float | None = None  # height above the TAKE-OFF point (DJI XMP)
    gimbal_pitch: float | None = None         # -90 = straight down
    focal_35mm: float | None = None           # lens focal length, 35 mm equivalent
    width_px: int | None = None
    height_px: int | None = None
    problems: list = field(default_factory=list)  # anything that went wrong reading it

    @property
    def has_gps(self):
        return self.lat is not None and self.lon is not None


def find_images(folder):
    """List every photo in a folder AND its sub-folders (DCIM/100MEDIA etc.).

    Sorted by path so results are the same every time.
    Hidden files (like macOS "._DJI_0001.JPG" leftovers) are skipped.
    """
    folder = Path(folder)
    found = [
        p for p in folder.rglob("*")
        if p.is_file()
        and p.suffix.lower() in IMAGE_EXTENSIONS
        and not p.name.startswith(".")
    ]
    return sorted(found)


def read_photo(path):
    """Read one photo's metadata and return a PhotoInfo."""
    path = Path(path)
    info = PhotoInfo(path=path, is_raw=path.suffix.lower() in RAW_EXTENSIONS)

    # --- EXIF (via Pillow) ---------------------------------------------
    try:
        # "with" makes sure the file is closed again afterwards.
        # Image.open only reads the header - it doesn't load all the pixels.
        with Image.open(path) as im:
            exif = im.getexif()
            exif_block = exif.get_ifd(TAG_EXIF_IFD)
            gps_block = exif.get_ifd(TAG_GPS_IFD)

            info.camera_make = _clean_text(exif.get(TAG_MAKE))
            info.camera_model = _clean_text(exif.get(TAG_MODEL))
            info.timestamp = _parse_exif_time(exif_block.get(TAG_DATETIME_ORIGINAL))
            info.focal_35mm = _to_float(exif_block.get(TAG_FOCAL_35MM))
            info.width_px = _to_int(exif_block.get(TAG_PIXEL_WIDTH)) or im.size[0]
            info.height_px = _to_int(exif_block.get(TAG_PIXEL_HEIGHT)) or im.size[1]

            info.lat = _gps_to_decimal(gps_block.get(GPS_LAT), gps_block.get(GPS_LAT_REF))
            info.lon = _gps_to_decimal(gps_block.get(GPS_LON), gps_block.get(GPS_LON_REF))
            info.gps_altitude_m = _gps_altitude(gps_block.get(GPS_ALT), gps_block.get(GPS_ALT_REF))

            # DNG files keep XMP in a TIFF tag; grab it while the file is open.
            tiff_xmp = None
            if hasattr(im, "tag_v2"):
                tiff_xmp = im.tag_v2.get(TAG_XMP_TIFF)
    except Exception as e:  # a corrupt file shouldn't crash the whole run
        info.problems.append(f"Could not read EXIF: {e}")
        tiff_xmp = None

    # --- XMP (DJI's extra data) ------------------------------------------
    xmp_text = _read_xmp_text(path, tiff_xmp)
    if xmp_text:
        info.gimbal_pitch = _xmp_number(xmp_text, "GimbalPitchDegree")
        info.relative_altitude_m = _xmp_number(xmp_text, "RelativeAltitude")
        # Some DJI firmware also writes GPS into XMP. Use it only as a backup.
        if info.lat is None:
            info.lat = _xmp_number(xmp_text, "GpsLatitude")
            info.lon = _xmp_number(xmp_text, "GpsLongitude") or _xmp_number(xmp_text, "GpsLongtitude")
            # (Yes, some DJI firmware really spells it "Longtitude".)
        if info.gps_altitude_m is None:
            info.gps_altitude_m = _xmp_number(xmp_text, "AbsoluteAltitude")
    else:
        info.problems.append("No DJI XMP block found (gimbal pitch unknown)")

    if not info.has_gps:
        info.problems.append("No GPS position")
    return info


def read_folder(folder, progress=True):
    """Read every photo in a folder. Prints a simple counter as it goes."""
    paths = find_images(folder)
    photos = []
    for i, p in enumerate(paths, start=1):
        photos.append(read_photo(p))
        if progress and (i % 25 == 0 or i == len(paths)):
            print(f"\r  Reading photo metadata: {i}/{len(paths)}", end="", flush=True)
    if progress and paths:
        print()
    return photos


# ----------------------------------------------------------------------
# Small helpers. EXIF stores things in awkward formats; these tidy them.
# ----------------------------------------------------------------------

def _clean_text(value):
    if value is None:
        return None
    if isinstance(value, bytes):
        value = value.decode("ascii", errors="ignore")
    return value.strip("\x00 ").strip() or None


def _to_float(value):
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _to_int(value):
    f = _to_float(value)
    return int(f) if f else None


def _parse_exif_time(text):
    """EXIF times look like '2026:11:02 10:15:30' (drone's local clock, no time zone)."""
    text = _clean_text(text)
    if not text:
        return None
    try:
        return datetime.strptime(text, "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return None


def _gps_to_decimal(dms, ref):
    """Convert GPS 'degrees, minutes, seconds' to a single decimal number.

    Example: 49° 22' 30.5" N  ->  49 + 22/60 + 30.5/3600 = 49.375139
    South and West are negative, so West Vancouver's longitude is about -123.
    """
    if not dms or len(dms) != 3:
        return None
    try:
        d, m, s = (float(x) for x in dms)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    value = d + m / 60 + s / 3600
    ref = _clean_text(ref)
    if ref in ("S", "W"):
        value = -value
    return value


def _gps_altitude(alt, ref):
    alt = _to_float(alt)
    if alt is None:
        return None
    # Ref 1 means "below sea level". Pillow may give it as a number or a byte.
    if isinstance(ref, bytes):
        ref = ref[0] if ref else 0
    return -alt if ref == 1 else alt


def _read_xmp_text(path, tiff_xmp=None):
    """Find the XMP text. In JPEGs it's near the start of the file, so we
    read just the first 1 MB rather than the whole (large) photo."""
    if tiff_xmp:
        return tiff_xmp.decode("utf-8", "ignore") if isinstance(tiff_xmp, bytes) else str(tiff_xmp)
    try:
        with open(path, "rb") as f:   # "rb" = read-only, binary
            head = f.read(1024 * 1024)
    except OSError:
        return None
    start = head.find(b"<x:xmpmeta")
    if start == -1:
        return None
    end = head.find(b"</x:xmpmeta>", start)
    chunk = head[start:end + 12] if end != -1 else head[start:]
    return chunk.decode("utf-8", errors="ignore")


def _xmp_number(xmp_text, name):
    """Pull one DJI value out of the XMP text.

    DJI writes values in one of two styles, so we try both:
        drone-dji:GimbalPitchDegree="-90.00"
        <drone-dji:GimbalPitchDegree>-90.00</drone-dji:GimbalPitchDegree>
    """
    patterns = [
        rf'drone-dji:{name}="([+-]?[\d.]+)"',
        rf"<drone-dji:{name}>([+-]?[\d.]+)</drone-dji:{name}>",
    ]
    for pattern in patterns:
        match = re.search(pattern, xmp_text)
        if match:
            return float(match.group(1))
    return None
