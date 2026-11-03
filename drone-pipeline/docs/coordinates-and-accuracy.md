# Coordinates and accuracy: a plain-language guide

## What's a coordinate reference system (CRS)?

A CRS is the agreement about what numbers like `494120, 5547880` mean. It has two parts:

- **A datum**: the model of Earth's shape, and where it's pinned. GPS uses **WGS 84**. Canada's
  official survey datum is **NAD83(CSRS)**. They're almost identical; in BC they currently differ by
  roughly 1–2 m and slowly drift apart as the continent moves.
- **A projection**: how the curved Earth is flattened onto a map grid. **UTM** splits the world into
  60 north–south strips ("zones"), each 6° of longitude wide, and gives positions in metres within a
  zone: *eastings* (metres east) and *northings* (metres north of the equator).

Every CRS has an **EPSG code**, a catalogue number. The ones relevant to you:

| EPSG | Name | Notes |
|---|---|---|
| 4326 | WGS 84 lat/lon | Degrees. Fine for locating things, awkward for measuring |
| **32610** | **WGS 84 / UTM zone 10N** | **This pipeline's default.** Metres. Covers 126°W–120°W |
| 3157 | NAD83(CSRS) / UTM zone 10N | Canada's official version of the same grid |
| 32611 | WGS 84 / UTM zone 11N | For sites east of 120°W (e.g. Rogers Pass, Revelstoke) |

## Why EPSG:32610 for southwest BC

1. **It covers your area.** Vancouver (~123.1°W), Whistler (~122.95°W), Pemberton (~122.8°W) and
   Manning Park (~120.8°W) are all inside zone 10.
2. **It's in metres.** Slope, area, volume and elevation change are direct to compute.
3. **It matches your data.** Your drone's GPS is WGS 84, and WebODM picks the UTM zone from the photo
   locations, which is zone 10 here. So usually no reprojection happens at all; reprojection would
   only add slight blurring.
4. **Consistency is the real goal.** For change detection, using *the same* CRS every time matters far
   more than which one. The pipeline enforces it.

### When to switch to EPSG:3157

If you start using ground control points surveyed in NAD83(CSRS), or overlaying precise BC government
data (e.g. LiDAR from LidarBC), switch `target_epsg` to `3157` *for that site*, and reprocess older
flights of that site too so they all match. Without GCPs, the 1–2 m datum difference is smaller than
your GPS error, so it's not worth worrying about yet.

## Vertical accuracy: the bigger issue

Horizontal CRS is the easy part. **Heights are where drone mapping without GCPs struggles**:

- The drone's GPS height can be off by several metres, and differently on different days.
- WebODM takes heights from the photos as recorded. A whole flight can come out shifted up or down,
  and sometimes slightly tilted.
- So two DSMs of unchanged ground can differ by metres. That's why `diff` has `--stable-area`: it
  measures the offset on ground you know didn't change and removes it.

### Rough expectations (without GCPs)

These depend heavily on height, overlap, light and texture, so treat them as orders of magnitude, not
promises:

- **Shape within one flight** (relative accuracy): usually good, often around a few times the ground
  pixel size. Slopes, cornice shapes and debris outlines are trustworthy.
- **Absolute position**: metres, horizontally and vertically.
- **Change between flights after `--stable-area`**: big changes (a metre or more over a clear area)
  are usually real; differences of a few tens of centimetres need caution.

### Ways to improve it later

1. **Ground control points (GCPs)**: marked targets with surveyed coordinates, given to WebODM as a
   `gcp_list.txt`. The single biggest improvement.
2. **Permanent check points**: even unsurveyed, painted marks on bedrock that appear in every flight
   let you measure how well two flights agree.
3. **Consistent missions**: same WaypointMap mission, same height, same time of day, same preset.
4. **RTK/PPK**: a drone with RTK positioning (the Air 3S doesn't have it) gets centimetre-level
   camera positions.
