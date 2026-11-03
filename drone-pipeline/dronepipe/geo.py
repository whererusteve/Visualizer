"""Small geometry helpers: distances between GPS points, photo footprints.

These are approximations that are plenty good for a pre-flight sanity
check over a site a few kilometres across. They are NOT used for the
actual mapping - WebODM does the precise maths.
"""

import math

EARTH_RADIUS_M = 6_371_000


def distance_m(lat1, lon1, lat2, lon2):
    """Approximate ground distance in metres between two GPS points.

    Uses the "equirectangular" shortcut: treat a small patch of the Earth
    as flat, but shrink east-west distances by cos(latitude) because lines
    of longitude get closer together as you go north. At 49-50°N a degree
    of longitude is only ~72 km, versus ~111 km for a degree of latitude.
    """
    mean_lat = math.radians((lat1 + lat2) / 2)
    dx = math.radians(lon2 - lon1) * math.cos(mean_lat)
    dy = math.radians(lat2 - lat1)
    return EARTH_RADIUS_M * math.hypot(dx, dy)


def footprint_m(height_above_ground_m, focal_35mm, width_px, height_px):
    """How much ground one straight-down photo covers: (long side, short side) in metres.

    The "35 mm equivalent focal length" in EXIF describes the lens as if it
    were on a full-frame camera whose diagonal is 43.27 mm. Using similar
    triangles:   ground size / height = sensor size / focal length.

    For the Air 3S wide camera (24 mm equivalent, 4:3 photos) this works out
    to roughly 1.44 x height by 1.08 x height. At 100 m: ~144 m x ~108 m.
    """
    if not (height_above_ground_m and focal_35mm and width_px and height_px):
        return None
    full_frame_diagonal_mm = 43.27
    image_diagonal_px = math.hypot(width_px, height_px)
    long_px, short_px = max(width_px, height_px), min(width_px, height_px)
    # Split the 43.27 mm diagonal into the photo's own long/short sides.
    long_mm = full_frame_diagonal_mm * long_px / image_diagonal_px
    short_mm = full_frame_diagonal_mm * short_px / image_diagonal_px
    scale = height_above_ground_m / focal_35mm
    return long_mm * scale, short_mm * scale


def utm_zone(lon):
    """Which UTM zone a longitude falls in. Zones are 6° wide, starting at 180°W."""
    return int((lon + 180) // 6) + 1
