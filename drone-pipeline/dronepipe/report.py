"""Step 2 - PRE-FLIGHT REPORT: a plain-language check of the photos
before you spend hours processing them.

build_report() works out the numbers; format_report() turns them into
readable text. They're separate so the numbers can also go into the run
log and be tested automatically.
"""

import statistics
from collections import Counter

from dronepipe.geo import distance_m, footprint_m, utm_zone

# If two photos are more than this many seconds apart, we assume you
# landed / swapped batteries / started a new pass in between.
NEW_FLIGHT_GAP_SECONDS = 120


def classify_pitch(pitch, cfg_images):
    """Sort a photo by where the camera was pointing."""
    if pitch is None:
        return "unknown"
    if pitch <= cfg_images["nadir_max_pitch"]:
        return "nadir"
    if pitch <= cfg_images["oblique_max_pitch"]:
        return "oblique"
    return "near-horizontal"


def build_report(photos, cfg):
    """Crunch the numbers. Returns a dictionary (easy to save as JSON)."""
    r = {"image_count": len(photos), "warnings": []}
    warn = r["warnings"].append  # shortcut: warn("text") adds a warning

    if not photos:
        warn("No JPG or DNG photos were found in that folder.")
        return r

    r["jpeg_count"] = sum(1 for p in photos if not p.is_raw)
    r["dng_count"] = sum(1 for p in photos if p.is_raw)

    # --- Dates and times ---------------------------------------------------
    times = sorted(p.timestamp for p in photos if p.timestamp)
    dates = Counter(t.date().isoformat() for t in times)
    r["dates"] = dict(dates)
    # The folder date = the day most photos were taken.
    r["flight_date"] = dates.most_common(1)[0][0] if dates else None
    if len(dates) > 1:
        warn(f"Photos come from {len(dates)} different days ({', '.join(sorted(dates))}). "
             f"They'll all be filed under {r['flight_date']} unless you pass --date.")
    if not times:
        warn("No photo has a timestamp - pass --date YYYY-MM-DD to choose the folder date.")
    if times:
        r["first_photo"] = times[0].isoformat(sep=" ")
        r["last_photo"] = times[-1].isoformat(sep=" ")
        gaps = [(b - a).total_seconds() for a, b in zip(times, times[1:])]
        r["flight_segments"] = 1 + sum(1 for g in gaps if g > NEW_FLIGHT_GAP_SECONDS)

    # --- Cameras -------------------------------------------------------------
    cams = Counter(f"{p.camera_make or '?'} {p.camera_model or '?'}" for p in photos)
    r["cameras"] = dict(cams)
    if len(cams) > 1:
        warn("More than one camera model found. The Air 3S has two cameras (wide and "
             "medium tele) that report different models. WebODM can mix them, but "
             "for mapping it's usually cleaner to process one camera at a time.")

    # --- GPS -----------------------------------------------------------------
    no_gps = [p.path.name for p in photos if not p.has_gps]
    r["missing_gps"] = no_gps
    if no_gps:
        shown = ", ".join(no_gps[:5]) + (" ..." if len(no_gps) > 5 else "")
        warn(f"{len(no_gps)} photo(s) have no GPS position: {shown}. "
             "WebODM can still use them, but they won't help georeferencing.")

    gps_photos = [p for p in photos if p.has_gps]
    if gps_photos:
        lats = [p.lat for p in gps_photos]
        lons = [p.lon for p in gps_photos]
        r["centre"] = (statistics.mean(lats), statistics.mean(lons))
        r["utm_zone"] = utm_zone(r["centre"][1])
        r["site_size_m"] = (
            round(distance_m(r["centre"][0], min(lons), r["centre"][0], max(lons))),
            round(distance_m(min(lats), r["centre"][1], max(lats), r["centre"][1])),
        )
        if r["utm_zone"] != 10:
            warn(f"This site is in UTM zone {r['utm_zone']}, not zone 10. Outputs will still use "
                 "the CRS in config.toml (good for consistency), but consider a matching zone "
                 "if this is a new site outside southwest BC.")

    # --- Altitudes -----------------------------------------------------------
    rel = [p.relative_altitude_m for p in photos if p.relative_altitude_m is not None]
    gps_alt = [p.gps_altitude_m for p in photos if p.gps_altitude_m is not None]
    if rel:
        r["relative_altitude_range_m"] = (round(min(rel), 1), round(max(rel), 1))
    if gps_alt:
        r["gps_altitude_range_m"] = (round(min(gps_alt), 1), round(max(gps_alt), 1))

    # --- Where the camera was pointing --------------------------------------
    kinds = Counter(classify_pitch(p.gimbal_pitch, cfg["images"]) for p in photos)
    r["pointing"] = {k: kinds.get(k, 0) for k in ("nadir", "oblique", "near-horizontal", "unknown")}
    if kinds.get("near-horizontal"):
        warn(f"{kinds['near-horizontal']} photo(s) point nearly at the horizon. Sky in the frame "
             "confuses photogrammetry - consider leaving those out.")

    # --- Overlap estimate (nadir JPEGs only) ----------------------------------
    r["overlap"] = estimate_overlap(
        [p for p in gps_photos if not p.is_raw
         and classify_pitch(p.gimbal_pitch, cfg["images"]) == "nadir"],
        cfg, warn)

    if r["jpeg_count"] > 500:
        warn(f"{r['jpeg_count']} photos is a big job for a laptop. Try the fast-preview "
             "preset first, and expect high-quality runs to take hours and lots of memory.")
    return r


def estimate_overlap(nadir, cfg, warn):
    """Roughly estimate front and side overlap from photo spacing.

    How it works, in plain terms:
      1. Work out how much ground one photo covers (its "footprint")
         from the height and the lens.
      2. FRONT overlap: in time order, how far apart are back-to-back photos?
         If photos are 30 m apart and each covers 108 m, they share
         (108 - 30) / 108 = 72%.
      3. SIDE overlap: for each photo, find the nearest photo that was NOT
         taken just before/after it - that's usually on the next flight
         line over. Same sum, using the photo's long side.

    Assumptions (why it's "rough"):
      * The short side of the photo points along the flight direction
        (DJI's default for mapping missions).
      * Height = height above the TAKE-OFF point. In the mountains the
        ground under the drone can be far higher or lower than where you
        took off, so real overlap varies a lot across the site. Uphill
        = less overlap than estimated. Terrain-follow missions help.
    """
    result = {"estimated": False}
    if len(nadir) < 3:
        result["note"] = "Too few nadir photos with GPS to estimate overlap."
        return result

    nadir = sorted(nadir, key=lambda p: (p.timestamp is None, p.timestamp, p.path.name))
    heights = [p.relative_altitude_m for p in nadir if p.relative_altitude_m]
    sample = nadir[0]
    if not heights:
        result["note"] = "No height-above-takeoff data, so overlap can't be estimated."
        return result
    height = statistics.median(heights)
    fp = footprint_m(height, sample.focal_35mm, sample.width_px, sample.height_px)
    if not fp:
        result["note"] = "Lens info missing from EXIF, so overlap can't be estimated."
        return result
    long_side, short_side = fp

    # Step 2: back-to-back spacing (ignoring big jumps between flight lines/flights).
    steps = [distance_m(a.lat, a.lon, b.lat, b.lon) for a, b in zip(nadir, nadir[1:])]
    steps = [s for s in steps if 0.5 < s < short_side]  # drop hovers and line jumps
    # Step 3: distance to the nearest photo that isn't a time-neighbour.
    side = []
    for i, p in enumerate(nadir):
        others = [distance_m(p.lat, p.lon, q.lat, q.lon)
                  for j, q in enumerate(nadir) if abs(i - j) > 3]
        if others:
            side.append(min(others))

    result.update(estimated=True, height_m=round(height, 1),
                  footprint_m=(round(long_side), round(short_side)))
    if steps:
        spacing = statistics.median(steps)
        result["photo_spacing_m"] = round(spacing, 1)
        result["front_overlap_pct"] = round(max(0.0, 1 - spacing / short_side) * 100)
    if side:
        line_gap = statistics.median(side)
        result["line_spacing_m"] = round(line_gap, 1)
        result["side_overlap_pct"] = round(max(0.0, 1 - line_gap / long_side) * 100)

    lim = cfg["overlap"]
    front = result.get("front_overlap_pct")
    side_pct = result.get("side_overlap_pct")
    if front is not None and front < lim["min_front_overlap"]:
        warn(f"Front overlap looks low (~{front}%, want {lim['min_front_overlap']}%+). "
             "Gaps or a warped model are likely, especially over snow.")
    if side_pct is not None and side_pct < lim["min_side_overlap"]:
        warn(f"Side overlap looks low (~{side_pct}%, want {lim['min_side_overlap']}%+). "
             "Flight lines may be too far apart.")
    return result


def format_report(r, source_folder):
    """Turn the numbers into a readable summary for the terminal."""
    lines = ["", "=" * 64, "  PRE-FLIGHT REPORT", "=" * 64,
             f"  Folder:        {source_folder}",
             f"  Photos:        {r['image_count']}"
             + (f"  ({r.get('jpeg_count', 0)} JPEG, {r.get('dng_count', 0)} DNG)" if r['image_count'] else "")]
    if r["image_count"] == 0:
        lines.append("")
    if r.get("flight_date"):
        lines.append(f"  Flight date:   {r['flight_date']}")
    if r.get("first_photo"):
        lines.append(f"  Time span:     {r['first_photo'][11:]} to {r['last_photo'][11:]}"
                     f"  ({r['flight_segments']} flight segment(s))")
    for cam, n in r.get("cameras", {}).items():
        lines.append(f"  Camera:        {cam}  x{n}")
    if r.get("centre"):
        lat, lon = r["centre"]
        w, h = r["site_size_m"]
        lines.append(f"  Site centre:   {lat:.5f}, {lon:.5f}  (UTM zone {r['utm_zone']})")
        lines.append(f"  Area covered:  about {w} m east-west x {h} m north-south (photo positions)")
    if r.get("relative_altitude_range_m"):
        lo, hi = r["relative_altitude_range_m"]
        lines.append(f"  Height above take-off: {lo} to {hi} m")
    if r.get("gps_altitude_range_m"):
        lo, hi = r["gps_altitude_range_m"]
        lines.append(f"  GPS altitude:  {lo} to {hi} m")
    if "pointing" in r:
        p = r["pointing"]
        lines.append(f"  Camera angle:  {p['nadir']} nadir (straight down), {p['oblique']} oblique, "
                     f"{p['near-horizontal']} near-horizontal, {p['unknown']} unknown")
    lines.append(f"  Missing GPS:   {len(r.get('missing_gps', []))}")

    ov = r.get("overlap", {})
    if ov.get("estimated"):
        lines.append(f"  Overlap (rough, nadir photos at ~{ov['height_m']} m; each covers "
                     f"~{ov['footprint_m'][0]} x {ov['footprint_m'][1]} m):")
        if "front_overlap_pct" in ov:
            lines.append(f"     front ~{ov['front_overlap_pct']}%  (photos ~{ov['photo_spacing_m']} m apart)")
        if "side_overlap_pct" in ov:
            lines.append(f"     side  ~{ov['side_overlap_pct']}%  (lines ~{ov['line_spacing_m']} m apart)")
    elif ov.get("note"):
        lines.append(f"  Overlap:       {ov['note']}")

    if r["warnings"]:
        lines += ["", "  WARNINGS:"]
        lines += [f"   ! {w}" for w in r["warnings"]]
    else:
        lines += ["", "  No warnings. Looks good."]
    lines.append("=" * 64)
    return "\n".join(lines)
