"""Stretch goal - ELEVATION CHANGE between two flights ("DEM of difference").

    change = later DSM  -  earlier DSM

Positive = the surface got higher (new snow, avalanche debris, wind loading).
Negative = it got lower (melt, erosion, scouring, settlement).

Steps:
  1. Open both DSMs. They usually differ a little in coverage, pixel size
     and pixel alignment, so we resample one onto the other's grid
     (always onto the COARSER grid - you can't invent detail).
  2. Subtract, pixel by pixel, wherever BOTH have data.
  3. Optionally remove the overall height offset between the flights,
     measured on ground you know didn't change (--stable-area).
  4. Save a GeoTIFF for QGIS, a colour style that QGIS loads with it,
     and a plain-text summary including the accuracy caveats.
"""

from pathlib import Path

import numpy as np

NODATA = -9999.0
ACCURACY_NOTE = """\
HOW FAR TO TRUST THIS (no ground control points)
------------------------------------------------
* Without GCPs, each flight is positioned only by the drone's own GPS,
  which is typically good to a few metres sideways and worse vertically.
  Two flights can therefore sit a few metres apart - sometimes more -
  even if nothing on the ground changed. That shows up here as a broad,
  fairly even offset (often with a gentle tilt) across the whole map.
* --stable-area removes the even part of that offset, using ground you
  KNOW didn't change (bare rock, a building roof, a road). It cannot
  remove tilt or warping, so changes far from your stable area are less
  reliable. Choosing two or three stable patches spread around the site
  and comparing their offsets is a good way to see how much tilt there is.
* Treat small changes as noise. Even after removing the offset, changes
  smaller than a few tens of centimetres are not reliably real without
  GCPs (it depends on height, overlap, light and texture). The summary
  reports amounts both for all pixels and for pixels beyond --min-change.
* Snow is low-texture: fresh, flat-lit snow produces noisy, blotchy
  surfaces. Look for patterns that make physical sense (a debris fan, a
  cornice, a wind-loaded lee slope), not individual pixels.
* Trees and vegetation move and get matched differently each flight -
  expect noise in forest. DTMs (--surface dtm) remove trees but add their
  own guesswork about what's ground.
* To make this measurement-grade: add GCPs (or use an RTK drone), fly
  the same mission at the same height, and keep the same preset.
"""


def resolve_dsm(value, site, root, surface):
    """--before/--after can be a date (YYYY-MM-DD, needs --site) or a file path."""
    p = Path(value).expanduser()
    if p.suffix.lower() in (".tif", ".tiff"):
        if not p.exists():
            raise ValueError(f"File not found: {p}")
        return p, p.stem
    if not site:
        raise ValueError("Give --site when using dates for --before/--after.")
    path = Path(root) / site / value / "outputs" / f"{site}_{value}_{surface}.tif"
    if not path.exists():
        raise ValueError(f"No {surface.upper()} found for {site} on {value} (looked for {path}).")
    return path, value


def run_diff(args, cfg):
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.vrt import WarpedVRT
    from rasterio.windows import from_bounds

    from dronepipe.config import projects_root

    if not (args.before and args.after):
        raise ValueError("diff needs both --before and --after.")
    root = projects_root(cfg, args.projects_root)
    before_path, before_label = resolve_dsm(args.before, args.site, root, args.surface)
    after_path, after_label = resolve_dsm(args.after, args.site, root, args.surface)
    min_change = args.min_change

    with rasterio.open(before_path) as before, rasterio.open(after_path) as after:
        # Step 1: choose the coarser grid as the reference.
        ref, other = (before, after) if before.res[0] >= after.res[0] else (after, before)
        n_pixels = ref.width * ref.height
        if n_pixels > 150_000_000:
            print(f"  Note: {n_pixels / 1e6:.0f} million pixels - this may need several GB "
                  "of memory. A coarser dem-resolution makes it faster.")

        # A WarpedVRT is a "virtual" resampled copy - nothing is written to disk.
        with WarpedVRT(other, crs=ref.crs, transform=ref.transform, width=ref.width,
                       height=ref.height, resampling=Resampling.bilinear,
                       src_nodata=other.nodata, nodata=NODATA) as other_on_ref:
            ref_data = ref.read(1, masked=True).astype("float32")
            other_data = other_on_ref.read(1, masked=True).astype("float32")

        before_data, after_data = ((ref_data, other_data) if ref is before
                                   else (other_data, ref_data))
        # Step 2: subtract. Masked arrays automatically skip "no data" pixels.
        change = after_data - before_data

        # Step 3: remove the vertical offset using a known-stable area.
        offset = None
        if args.stable_area:
            minx, miny, maxx, maxy = (float(v) for v in args.stable_area.split(","))
            window = from_bounds(minx, miny, maxx, maxy, ref.transform).round_offsets().round_lengths()
            r0, c0 = max(0, int(window.row_off)), max(0, int(window.col_off))
            patch = change[r0:r0 + int(window.height), c0:c0 + int(window.width)]
            if patch.count() == 0:
                raise ValueError("The --stable-area box has no overlapping data. Check the "
                                 "coordinates are in the DSM's CRS (e.g. UTM metres).")
            offset = float(np.ma.median(patch))
            change = change - offset

        pixel_area = abs(ref.res[0] * ref.res[1])
        stats = summarise(change, pixel_area, min_change)
        stats.update(offset_removed=offset, pixel_size=ref.res[0], crs=str(ref.crs))

        # Step 4: save.
        out_dir = Path(args.out).expanduser() if args.out else (
            Path(root) / (args.site or "comparisons") / "changes")
        out_dir.mkdir(parents=True, exist_ok=True)
        base = f"{args.site + '_' if args.site else ''}{before_label}_to_{after_label}_{args.surface}-change"
        tif = out_dir / f"{base}.tif"
        profile = ref.profile.copy()
        profile.update(dtype="float32", count=1, nodata=NODATA, compress="deflate",
                       tiled=True, blockxsize=256, blockysize=256, BIGTIFF="IF_SAFER")
        profile.pop("photometric", None)
        with rasterio.open(tif, "w", **profile) as dst:
            dst.write(change.filled(NODATA).astype("float32"), 1)
            dst.set_band_description(1, f"{args.surface.upper()} change (m), after minus before")

    limit = stats.get("colour_limit_m") or 1.0
    (out_dir / f"{base}.qml").write_text(qgis_style(limit))
    summary = format_summary(stats, before_path, after_path, min_change, args.surface)
    (out_dir / f"{base}.txt").write_text(summary)
    print(summary)
    print(f"\n  Saved: {tif}\n         (+ .qml colour style and .txt summary next to it)")
    return tif, stats


def summarise(change, pixel_area, min_change):
    """Numbers that describe the change. Volumes = height change x pixel area."""
    values = change.compressed()  # just the pixels with data
    if values.size == 0:
        raise ValueError("The two DSMs don't overlap at all - are they the same site?")
    big = np.abs(values) >= min_change
    return {
        "pixels_compared": int(values.size),
        "area_compared_m2": float(values.size * pixel_area),
        "mean_m": float(values.mean()),
        "median_m": float(np.median(values)),
        "std_m": float(values.std()),
        "p05_m": float(np.percentile(values, 5)),
        "p95_m": float(np.percentile(values, 95)),
        "gain_m3_all": float(values[values > 0].sum() * pixel_area),
        "loss_m3_all": float(values[values < 0].sum() * pixel_area),
        "gain_m3_significant": float(values[big & (values > 0)].sum() * pixel_area),
        "loss_m3_significant": float(values[big & (values < 0)].sum() * pixel_area),
        "area_gain_significant_m2": float((big & (values > 0)).sum() * pixel_area),
        "area_loss_significant_m2": float((big & (values < 0)).sum() * pixel_area),
        # Colour scale: cover 98% of pixels, rounded, so outliers don't wash it out.
        "colour_limit_m": max(0.1, round(float(np.percentile(np.abs(values), 98)), 1)),
    }


def format_summary(s, before_path, after_path, min_change, surface):
    lines = [
        f"{surface.upper()} CHANGE  (after minus before; + = higher, - = lower)",
        f"  before: {before_path}",
        f"  after:  {after_path}",
        f"  grid:   {s['pixel_size']:.3f} m pixels, {s['crs']}",
        f"  compared area: {s['area_compared_m2']:,.0f} m2",
        "",
    ]
    if s["offset_removed"] is not None:
        lines.append(f"  Offset removed using stable area: {s['offset_removed']:+.2f} m")
    else:
        lines.append(f"  No offset removed. Whole-area median change is {s['median_m']:+.2f} m - if "
                     "most of the site didn't really change, that's roughly the GPS offset "
                     "between flights. Use --stable-area to remove it.")
    lines += [
        "",
        f"  Mean change:   {s['mean_m']:+.2f} m   (median {s['median_m']:+.2f} m, "
        f"spread/std {s['std_m']:.2f} m)",
        f"  90% of pixels changed between {s['p05_m']:+.2f} and {s['p95_m']:+.2f} m",
        "",
        f"  Changes bigger than {min_change} m (more likely to be real):",
        f"    raised:  {s['area_gain_significant_m2']:,.0f} m2, volume {s['gain_m3_significant']:+,.0f} m3",
        f"    lowered: {s['area_loss_significant_m2']:,.0f} m2, volume {s['loss_m3_significant']:+,.0f} m3",
        f"  All pixels (includes noise): {s['gain_m3_all']:+,.0f} m3 / {s['loss_m3_all']:+,.0f} m3",
        "",
        ACCURACY_NOTE,
    ]
    return "\n".join(lines)


def qgis_style(limit):
    """A QGIS style file: red = lowered, white = no change, blue = raised.
    QGIS loads a .qml automatically when it has the same name as the .tif.
    (Expected behaviour - if yours doesn't, use Layer Properties > Style > Load Style.)"""
    return f"""<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.28" styleCategories="AllStyleCategories">
  <pipe>
    <rasterrenderer type="singlebandpseudocolor" band="1" opacity="1" alphaBand="-1"
                    classificationMin="{-limit}" classificationMax="{limit}">
      <rastershader>
        <colorrampshader colorRampType="INTERPOLATED" classificationMode="1" clip="0">
          <item alpha="255" value="{-limit}" label="{-limit} m (lowered)" color="#b2182b"/>
          <item alpha="255" value="{-limit / 2}" label="" color="#ef8a62"/>
          <item alpha="255" value="0" label="0 (no change)" color="#f7f7f7"/>
          <item alpha="255" value="{limit / 2}" label="" color="#67a9cf"/>
          <item alpha="255" value="{limit}" label="+{limit} m (raised)" color="#2166ac"/>
        </colorrampshader>
      </rastershader>
    </rasterrenderer>
  </pipe>
</qgis>
"""
