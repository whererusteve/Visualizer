"""Step 5 - EXPORT: download the results and make sure they line up.

Each result gets a predictable, date-stamped name, e.g.

    metal-dome_2026-11-02_orthophoto.tif

so files from different dates never get mixed up once they're loaded
together in QGIS.

Then every GeoTIFF is checked for its coordinate reference system (CRS).
If WebODM produced anything other than the CRS chosen in config.toml,
we reproject it. In southwest BC WebODM normally already picks UTM
zone 10, so most of the time this is just a check.
"""

import shutil
from pathlib import Path

# WebODM's name for each result  ->  (our file-name ending, what it is)
ASSETS = {
    "orthophoto.tif": ("orthophoto.tif", "Orthophoto: a map-accurate aerial photo"),
    "dsm.tif": ("dsm.tif", "DSM: elevation of the top surface (snow, trees, rocks)"),
    "dtm.tif": ("dtm.tif", "DTM: estimated bare-ground elevation (trees removed)"),
    "georeferenced_model.laz": ("pointcloud.laz", "Point cloud: millions of 3D points"),
    "textured_model.zip": ("textured-model.zip", "Textured 3D model (OBJ + texture images)"),
    "report.pdf": ("odm-quality-report.pdf", "WebODM's own quality report (accuracy, overlap)"),
}
GEOTIFFS = ("orthophoto.tif", "dsm.tif", "dtm.tif")


def output_name(site, date, asset):
    """e.g. ('metal-dome', '2026-11-02', 'dsm.tif') -> 'metal-dome_2026-11-02_dsm.tif'"""
    return f"{site}_{date}_{ASSETS[asset][0]}"


def download_outputs(odm, project_id, task_id, task_info, outputs_dir, site, date, warn):
    """Download every result that exists. Returns {asset: saved path}."""
    outputs_dir = Path(outputs_dir)
    outputs_dir.mkdir(parents=True, exist_ok=True)
    available = task_info.get("available_assets")
    saved = {}
    for asset in ASSETS:
        if available is not None and asset not in available:
            hint = " (turn on 'dtm = true' in the preset to get one)" if asset == "dtm.tif" else ""
            warn(f"WebODM didn't produce {asset}{hint}.")
            continue
        dest = outputs_dir / output_name(site, date, asset)
        saved[asset] = odm.download(project_id, task_id, asset, dest)
    return saved


def ensure_crs(saved, target_epsg, outputs_dir, warn):
    """Check each GeoTIFF's coordinate system; reproject if it doesn't match.

    Originals that needed reprojecting are kept in outputs/original-crs/
    so nothing is thrown away.
    Returns {asset: EPSG code found before any change}.
    """
    import rasterio  # imported here so the other steps work even before rasterio is installed

    found = {}
    for asset in GEOTIFFS:
        path = saved.get(asset)
        if not path:
            continue
        with rasterio.open(path) as src:
            epsg = src.crs.to_epsg() if src.crs else None
        found[asset] = epsg
        if epsg == target_epsg:
            continue
        if epsg is None:
            warn(f"{path.name} has no coordinate system at all - it can't be placed on a map.")
            continue

        keep_dir = Path(outputs_dir) / "original-crs"
        keep_dir.mkdir(exist_ok=True)
        original = keep_dir / path.name
        shutil.move(path, original)   # moving OUR downloaded file, never your photos
        reproject_geotiff(original, path, target_epsg)
        warn(f"{path.name} was in EPSG:{epsg}; reprojected to EPSG:{target_epsg}. "
             f"Original kept in {keep_dir.name}/.")

    # The point cloud shares the DSM's coordinate system (both come from the
    # same WebODM georeferencing step), so the DSM tells us if it's different.
    if "georeferenced_model.laz" in saved and found.get("dsm.tif") not in (None, target_epsg):
        warn("The point cloud is still in WebODM's original coordinate system "
             "(reprojecting point clouds needs an extra tool, PDAL). QGIS will still "
             "place it correctly, it just won't share the exact CRS of the rasters.")
    return found


def reproject_geotiff(src_path, dest_path, target_epsg):
    """Warp a GeoTIFF into a new coordinate system.

    'Bilinear' resampling blends the 4 nearest pixels - smooth and suitable
    for both elevation models and photos.
    """
    import rasterio
    from rasterio.warp import Resampling, calculate_default_transform, reproject

    dst_crs = f"EPSG:{target_epsg}"
    with rasterio.open(src_path) as src:
        transform, width, height = calculate_default_transform(
            src.crs, dst_crs, src.width, src.height, *src.bounds)
        profile = src.profile.copy()
        profile.update(crs=dst_crs, transform=transform, width=width, height=height,
                       compress="deflate", tiled=True, blockxsize=256, blockysize=256,
                       BIGTIFF="IF_SAFER")
        with rasterio.open(dest_path, "w", **profile) as dst:
            for band in range(1, src.count + 1):
                reproject(
                    source=rasterio.band(src, band),
                    destination=rasterio.band(dst, band),
                    src_transform=src.transform, src_crs=src.crs,
                    dst_transform=transform, dst_crs=dst_crs,
                    src_nodata=src.nodata, dst_nodata=src.nodata,
                    resampling=Resampling.bilinear)
