# dronepipe — drone photos → WebODM → QGIS & Sketchfab

A command-line tool for your Mac that takes a folder of DJI drone photos and:

1. **Ingests** them: reads GPS, altitude, gimbal pitch, time and camera from each photo
2. **Reports** on them in plain language before anything happens, and asks you to confirm
3. **Organizes** them: *copies* them into `Projects/<site>/<YYYY-MM-DD>/raw/`
4. **Processes** them in your local WebODM using a preset you choose
5. **Exports** the orthophoto, DSM, DTM, point cloud and 3D model with consistent names, all
   in the same coordinate system, so repeat flights line up in QGIS
6. **Packages** the 3D model as a Sketchfab-ready zip
7. **Logs** what it did

Plus a separate **`diff`** command that compares two flights of the same site and maps the elevation
change (snow loading, avalanche debris, erosion).

> **Your original photos are never moved, changed or deleted.** The tool only reads them and makes
> copies. There are automated tests that check this.

---

## Contents

- [1. Install (one time)](#1-install-one-time)
- [2. Try it with fake photos first](#2-try-it-with-fake-photos-first)
- [3. Use it on a real flight](#3-use-it-on-a-real-flight)
- [4. What each output file is for](#4-what-each-output-file-is-for)
- [5. Measuring change between two flights](#5-measuring-change-between-two-flights)
- [6. Presets: changing how WebODM processes](#6-presets-changing-how-webodm-processes)
- [7. If something goes wrong](#7-if-something-goes-wrong)
- [8. How the code is organized (for learning)](#8-how-the-code-is-organized-for-learning)
- [9. Things I couldn't verify](#9-things-i-couldnt-verify)

---

## 1. Install (one time)

You'll type these into the **Terminal** app (Applications → Utilities → Terminal). Lines starting
with `#` are comments explaining the next line; you don't need to type them.

### 1a. Python 3.11 or newer

```bash
# Check which Python you have:
python3 --version
```

If it says 3.11, 3.12 or 3.13, skip ahead. Otherwise install it with [Homebrew](https://brew.sh):

```bash
brew install python@3.12
```

### 1b. Get the code and set up a "virtual environment"

A *virtual environment* (venv) is a private folder of Python packages just for this project, so
it can't clash with anything else on your Mac.

```bash
# Go to wherever you keep projects, then download the code:
cd ~/Documents
git clone https://github.com/whererusteve/Visualizer.git
cd Visualizer/drone-pipeline

# Make the virtual environment (a folder called .venv) and switch it on:
python3 -m venv .venv
source .venv/bin/activate

# Install the three packages the tool needs:
pip install -r requirements.txt
```

**Every time you open a new Terminal window**, switch the environment back on before using the tool:

```bash
cd ~/Documents/Visualizer/drone-pipeline
source .venv/bin/activate
```

(You'll see `(.venv)` at the start of the prompt when it's on.)

The three packages are:

| Package | What it does here |
|---|---|
| `requests` | Talks to WebODM over its web API |
| `Pillow` | Reads EXIF data from your photos |
| `rasterio` | Reads/writes GeoTIFFs: checks coordinate systems, does the elevation-change maths. It includes GDAL, so you don't install GDAL separately. |

### 1c. Check it works

```bash
python -m unittest discover -s tests
```

You should see `OK` at the end. That ran 17 checks using fake photos and a fake WebODM.

### 1d. Tell it about your WebODM

Open `config.toml` in any text editor (TextEdit works; VS Code is nicer). Check:

- `url` — where WebODM runs. Normally `http://localhost:8000`.
- `username` — your WebODM login.
- `projects_root` — where your project folders go (default `~/Drone/Projects`).

Your **password is not stored in the file** (so it can't leak if you share or commit the file). The
tool asks for it each run. To skip the question, set it for the current Terminal window:

```bash
export WEBODM_PASSWORD='your-password'
```

> **Tip:** if you'd rather keep your settings out of git, copy `config.toml` to `config.local.toml`
> and edit that. The tool uses `config.local.toml` automatically when it exists, and git ignores it.

---

## 2. Try it with fake photos first

```bash
# Make 41 fake "drone photos" with realistic DJI metadata:
python -m dronepipe sample-data ~/Desktop/fake-card

# See the pre-flight report for them:
python -m dronepipe report ~/Desktop/fake-card

# Do the organize step only (copies into Projects, no WebODM):
python -m dronepipe run ~/Desktop/fake-card --site practice --organize-only
```

The fake photos are tiny noise images, so WebODM can't actually build a map from them; they're only
for testing the steps. Delete `~/Desktop/fake-card` and `~/Drone/Projects/practice` when you're done.

---

## 3. Use it on a real flight

### Step by step

```bash
# 1 + 2. Look before you leap: read the photos and print the report.
python -m dronepipe report /Volumes/SD_CARD/DCIM

# Everything: report → confirm → copy → WebODM → download → Sketchfab zip → log
python -m dronepipe run /Volumes/SD_CARD/DCIM --site metal-dome --preset fast-preview
```

- `--site` is your name for the place. Use lower-case letters, numbers and dashes (`metal-dome`,
  `cypress-bowl-north`). **Use exactly the same name every time you fly that site**: that's what
  groups repeat flights together.
- `--preset` picks a processing recipe from `config.toml` (see [section 6](#6-presets-changing-how-webodm-processes)).
  Start with `fast-preview` to check a flight worked, then run `terrain-high-quality` overnight.
- The flight date comes from the photos. Override it with `--date 2026-11-02`.
- `--organize-only` stops after copying (no WebODM).
- `--yes` skips the "Continue?" question.

### What the report tells you

```
  Photos:        41  (39 JPEG, 2 DNG)
  Flight date:   2026-02-14
  Time span:     09:59:00 to 10:08:01  (2 flight segment(s))
  Camera:        DJI FC9184  x39
  Site centre:   50.08000, -122.99001  (UTM zone 10)
  Height above take-off: 2.0 to 100.0 m
  Camera angle:  34 nadir (straight down), 6 oblique, 1 near-horizontal, 0 unknown
  Missing GPS:   1
  Overlap (rough, nadir photos at ~100.0 m; each covers ~144 x 108 m):
     front ~80%  (photos ~22.0 m apart)
     side  ~70%  (lines ~43.0 m apart)
```

- **Nadir / oblique** comes from the gimbal pitch DJI records: -80° to -90° is *nadir* (straight
  down), -10° to -80° is *oblique*. You can change the cut-offs in `config.toml`.
- **Flight segments** counts gaps of more than 2 minutes between photos (battery swaps, separate passes).
- **Overlap** is a *rough* estimate from photo spacing, height and lens. It uses height above the
  **take-off point**. In the mountains the ground can be much closer or further than that, so
  overlap really varies across the site; flying uphill means *less* overlap than the estimate.
  Snow needs more overlap than usual because it has so little texture.

### While it's processing

You'll see a progress bar. Processing can take hours. **Pressing Ctrl+C only stops watching** —
WebODM carries on. Later, collect the results with:

```bash
python -m dronepipe resume --site metal-dome --date 2026-11-02
```

### Where everything ends up

```
~/Drone/Projects/
└── metal-dome/
    ├── 2026-11-02/
    │   ├── raw/                     copies of your photos (JPEG + DNG)
    │   ├── outputs/                 WebODM results (see section 4)
    │   │   └── original-crs/        only appears if something had to be reprojected
    │   ├── share/
    │   │   └── metal-dome_2026-11-02_sketchfab.zip
    │   ├── run_log.md               what happened, in plain English
    │   └── run_state.json           bookkeeping for the 'resume' command
    └── changes/                     results of the 'diff' command
```

---

## 4. What each output file is for

All files are named `<site>_<date>_<type>`, so you can load several dates into QGIS without mix-ups.

| File | What it is | Use it for |
|---|---|---|
| `..._orthophoto.tif` | A map-accurate aerial photo: every pixel in its true position, no perspective tilt | Base map in QGIS; tracing avalanche paths, crowns, debris edges |
| `..._dsm.tif` | **Digital Surface Model**: elevation of the top of everything (snow, trees, rocks), one value per pixel | Slope/aspect maps, hillshades, measuring snow change (with `diff`) |
| `..._dtm.tif` | **Digital Terrain Model**: WebODM's *estimate* of bare ground, with trees and buildings removed | Terrain shape under forest. Only made if the preset has `dtm = true` |
| `..._pointcloud.laz` | Millions of 3D points (compressed LAS format) | QGIS can display it in 3D; also CloudCompare for detailed work |
| `..._textured-model.zip` | The full 3D mesh with photo texture, as WebODM gave it | Archive copy; source for the Sketchfab package |
| `..._odm-quality-report.pdf` | WebODM's own report: real measured overlap, GPS error, ground resolution | Learning what went well or badly. **Read it**, it's very good |
| `share/..._sketchfab.zip` | The 3D model, recentred and turned right way up | Upload straight to Sketchfab |

**GeoTIFF** = an ordinary TIFF image with extra tags saying exactly where on Earth each pixel is.

### In QGIS

Drag the `.tif` files into QGIS. They'll appear in the right place over a basemap. Useful next steps
for the DSM: *Raster → Analysis → Hillshade* and *Slope* (slope angle is key for avalanche terrain:
30–45° is the classic start-zone range).

### Coordinate system: EPSG:32610 (WGS 84 / UTM zone 10N)

Every GeoTIFF is delivered in the same coordinate reference system so different dates line up
exactly. Why this one:

- **UTM zone 10 covers 126°W to 120°W**, which is all of southwest BC: the North Shore, Sea to Sky,
  Whistler, Pemberton, Manning.
- **UTM is in metres**, so distances, areas and elevation differences are direct to read in QGIS.
- **WGS 84 is the datum your drone's GPS uses**, and it's what WebODM itself picks for this area. So
  usually nothing needs reprojecting; the tool just checks. If WebODM ever delivers something else,
  the tool reprojects it and keeps the original in `outputs/original-crs/`.

More detail, including when you'd switch to EPSG:3157, is in
[`docs/coordinates-and-accuracy.md`](docs/coordinates-and-accuracy.md).

### Sketchfab

Upload the zip from `share/` at sketchfab.com (Upload → choose the zip). The tool has already
recentred the model (real-world coordinates are huge numbers that make 3D viewers jittery) and turned
it Y-up (Sketchfab's convention), so it should appear the right way up. If not, fix it in Sketchfab's
3D settings with *Straighten model*. Both adjustments can be switched off in `config.toml`.

---

## 5. Measuring change between two flights

```bash
python -m dronepipe diff --site metal-dome --before 2026-01-10 --after 2026-02-14
```

This subtracts the earlier DSM from the later one. **Blue = surface got higher** (new snow, wind
loading, debris), **red = lower** (melt, scouring). It writes three files into
`Projects/metal-dome/changes/`:

- `..._dsm-change.tif`: the change map, in metres, for QGIS
- `..._dsm-change.qml`: a red-white-blue colour style (QGIS should apply it automatically; if not,
  *Layer Properties → Style → Load Style*)
- `..._dsm-change.txt`: summary numbers (area and volume raised/lowered) **and accuracy caveats**

### Important: the accuracy limit without ground control points

Without GCPs each flight is placed only by the drone's GPS, so **two flights can sit metres apart
vertically even if nothing changed**. You'll see that as an even offset over the whole map. Fix most
of it with `--stable-area`: a box around ground you *know* didn't change (bare rock, a hut roof, a
road), in map coordinates:

```bash
python -m dronepipe diff --site metal-dome --before 2026-01-10 --after 2026-02-14 \
    --stable-area 494120,5547880,494160,5547920
```

To get those numbers: in QGIS, hover over the corners of a stable patch and read the coordinates in
the bottom status bar (with the project CRS set to EPSG:32610). The four numbers are
`left,bottom,right,top`.

Other options:

- `--surface dtm`: compare bare-ground models instead of surfaces
- `--min-change 0.5`: changes smaller than this (metres) are counted separately as likely noise
- `--before`/`--after` can also be paths to any two `.tif` DSMs

Read the caveats in the `.txt` file before drawing conclusions. In short: big, physically sensible
patterns (a debris fan, a cornice) are trustworthy; small differences and anything in forest are
not, until you add GCPs or fly an RTK drone.

---

## 6. Presets: changing how WebODM processes

Presets live at the bottom of `config.toml`. List them with:

```bash
python -m dronepipe presets
```

| Preset | When to use |
|---|---|
| `fast-preview` | Right after a flight, to check it worked. Coarse but quick. |
| `terrain-high-quality` | Terrain and avalanche mapping. DSM + DTM at 5 cm. Slow; run overnight. |
| `oblique-3d-model` | Nadir + oblique passes combined into a detailed 3D model for Sketchfab. |

Each option name is exactly as it appears in WebODM's *Edit options* panel (hover there for
explanations). To make your own preset, copy a block, give it a new name, and change values. Before
starting, the tool asks WebODM which option names it knows and **warns you about typos**.

---

## 7. If something goes wrong

| Message | What to check |
|---|---|
| `Can't reach WebODM at http://localhost:8000` | Is WebODM running? Open that address in your browser. With Docker: is Docker Desktop running? |
| `WebODM refused the login` | Username in `config.toml`, and your password |
| `Processing failed: ...` | Open the task in WebODM's web page and read its log. Common causes: too little overlap, too few photos, featureless snow |
| `There's a typo in config.toml` | The message names the line. Text values need quotes: `pc-quality = "high"` |
| Photos filed under the wrong date | Use `--date YYYY-MM-DD` |

Something else? Copy the whole error message and send it to me.

---

## 8. How the code is organized (for learning)

Each step is its own small file in `dronepipe/`, with comments explaining *why* as well as *what*:

| File | Step | Good to read if you want to learn… |
|---|---|---|
| `exif_reader.py` | 1. Ingest | How photo metadata is stored (EXIF vs DJI's XMP) |
| `geo.py` | (helpers) | Distances on a globe; how lens + height give the ground footprint |
| `report.py` | 2. Report | How overlap is estimated |
| `organize.py` | 3. Organize | Safe file copying |
| `webodm.py` | 4. Process | How a REST API works |
| `export.py` | 5. Export | Coordinate systems and reprojection |
| `sketchfab.py` | 6. Package | What's inside a 3D model file (OBJ) |
| `runlog.py` | 7. Log | Writing Markdown and JSON |
| `diff.py` | Stretch goal | Raster maths with numpy |
| `cli.py` | — | How the commands are wired together |
| `sample_data.py` | — | Making test data |
| `tests/` | — | Automated tests, and a fake WebODM server |

A good first exercise: open `report.py`, find `NEW_FLIGHT_GAP_SECONDS = 120`, change it to 60, and
re-run `report` on the fake photos.

---

## 9. Things I couldn't verify

I built and tested this without access to your Mac, your WebODM or your real photos. These parts are
written from WebODM's documentation and my best knowledge, and need a real-world check:

1. **WebODM upload method.** Photos are uploaded one at a time (create task → upload → commit), the
   way WebODM's web page does it. Login, status and downloads are the well-documented core; the
   upload sequence is the part most worth watching on your first real run.
2. **Your WebODM install.** Docker and the native Mac installer should both answer at
   `localhost:8000`, but I haven't confirmed how yours is set up.
3. **DJI Air 3S metadata.** The tool reads the standard DJI XMP fields (`GimbalPitchDegree`,
   `RelativeAltitude`). I'm confident DJI uses these, but haven't seen an Air 3S file. Run `report`
   on a real card and check the numbers look right.
4. **DNG processing.** DNGs are copied to `raw/` but *not* sent to WebODM by default, both to avoid
   uploading every frame twice and because I'm not sure WebODM handles DJI DNGs well.
5. **Sketchfab upload limit.** Varies by plan; the tool warns above 100 MB (editable).
6. **Point clouds aren't reprojected** (it needs another tool, PDAL). In SW BC this shouldn't matter
   since WebODM already uses UTM 10N; the tool warns if it ever doesn't.
