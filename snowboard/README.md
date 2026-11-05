# Peak Rush

A snowboarding game on real mountains, in the spirit of the 3D stages in Sonic 3:
fast, behind-the-back, collect stars and hit jumps. It covers all of **Whistler Mountain**
(about 9 × 9.6 km): Creekside and the Village up to the Peak, Harmony, Symphony and Flute.

Three ways to ride (pick on the start screen):

- **Free ride** (default): drop in at Whistler Peak, the Roundhouse, Harmony Ridge, Symphony
  (Piccolo), Olympic, Creekside or the Village and ride anywhere. Stars and jumps are spread over
  the real open snow. A minimap shows where you are.
- **Peak to Creek**: the real run, traced from OpenStreetMap ski-run data (© OpenStreetMap
  contributors) shown on CalTopo: 5.6 km, 1,508 m vertical. `#peak-to-creek`
- **Peak to Village**: a line found along the real cleared runs (see Forest below): 6.4 km. `#whistler`

**Rider & board** (start screen): pick jacket or hoodie, pants, helmet or beanie, goggle lens, a face
mask (neck gaiter or balaclava), an avalanche airbag pack, stance, board colours and one of four boards. Each board changes the riding a little
(numbers in `BOARDS` in `js/outfit.js`):

| Board | Feel |
|---|---|
| All-mountain | the baseline |
| Park twin | quicker turns, +30% spin speed, +15% pop, 15% less edge grip |
| Powder swallowtail | about 7% less drag (faster), steadier, slower turns and spins |
| Carving board | 40% more edge grip, slow spins |

Choices are saved on your device.

**Lifts**: 12 real lifts with towers, cables and moving chairs or gondola cabins: Whistler
Village Gondola (via Olympic), Fitzsimmons, Olympic Chair, Garbanzo, Emerald 6, Creekside
Gondola, Big Red, Kadenwood Gondola, Peak Express, Harmony 6, Symphony, and Peak 2 Peak (towards
Blackcomb). Stop near a bottom station and press **L** (or tap the red button) to ride to the top
(sped up to 25 m/s; Space or the Skip button jumps ahead). On chairs you sit facing up the line
with the board hanging off your front foot; on gondolas you stand in a glass cabin. Lift tops are also drop-in spots in free ride. Lift lines come from
CalTopo screenshots of OpenStreetMap data (`tools/traces/lifts.json`); station heights match
published values within about 20 m (Roundhouse 1,845 m, Peak 2,178 m, Piccolo 2,008 m, Olympic 1,028 m).

**Gnar points**: clean landings score for airtime (from 0.6 s: 1 s = 60, 2 s = 182, 3 s = 349)
and spins (180 = 150, 360 = 400, 540 = 750, 720 = 1,200, 900 = 1,800, 1080 = 2,500). Land tricks
within 4 seconds of each other for a combo multiplier (×1.5, ×2 … up to ×4); a wipeout loses the
trick and the combo. Your best score per run is saved on your device. The numbers are in `GNAR`
at the top of the scoring section in `js/main.js`.

**Main menu**: the ☰ button (or Esc) pauses and opens the menu: resume, restart, change run or rider.


## Playing

Run a local web server from the repository root and open `/snowboard/`:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/snowboard/
```

| Keys | Touch | What it does |
|---|---|---|
| ← → or A D | ◀ ▶ | Carve; in the air, spin |
| Space | Jump | Hold to charge a bigger pop, release to jump |
| ↑ or W | Tuck | Less drag at speed; skate-push on flats |
| ↓ or S | Brake | Skid to slow down |
| R | ↺ | Restart from the top |

## Where the mountain comes from

`tools/build_course.py` builds everything from free, open data:

- **Elevation**: Mapzen "Terrarium" tiles on AWS Open Data (SRTM, Canadian CDEM and others),
  about 6 m per pixel here, smoothed slightly onto a 12.3 m game grid (`data/whistler.png`).
- **Forest**: two cloud-free Copernicus Sentinel-2 satellite images at 10 m detail: a sunny
  late-April image (trees hide the snow, so forest is dark and every run is a white line) and an
  August image (forest is green, roads/roofs/lakes aren't). Forest = dark in winter **and** green
  in summer, thinned out between 1,650 and 1,900 m (the real treeline). Saved as
  `data/whistler-forest.png`. This is what makes the real runs appear as clearings in the trees.
- **Peak to Creek line and Creekside buildings**: traced from CalTopo screenshots of OpenStreetMap
  data, aligned to the elevation data by matching contour lines (`tools/traces/`). The traced run
  sits in the satellite's clearing to within about 12 m.

- **Topo map lock**: the contour lines of the BC government 1:20,000 topo sheet 092J006 (20 m
  contours, a GeoPDF that says exactly where it sits on the ground) are read by
  `tools/topo_contours.py` into `tools/traces/whistler-contours.png`. The build then makes the
  terrain pass through every contour, filling in smoothly between them, and skips the extra
  smoothing it used before. Result: the terrain matches the map's contours to 1.5 m on average
  (worst 1%: 4.6 m; before: 3.1 m and 9.3 m), with sharper ridges and gullies. The sheet's south
  edge is at 50.112°N, so the strip north of that (the Village) keeps the plain elevation data.
  The topo sheet has no forest cover over the ski area (a private parcel), so the satellite
  images are used for the forest.

To rebuild: `python3 tools/build_course.py` (needs numpy and Pillow; the forest step also
needs `rasterio`). Add a course to `COURSES` with a start and finish (the line is computed),
a `trace` file of real lat/lon points, or `"mode": "free"` with drop-in spots.

## Performance

Only the trees within 450 m of you are 3D (rebuilt as you move); further away the forest is
painted on the ground. Only stars within 450 m are drawn, and terrain beyond 450 m is drawn
at half detail.

## Files

```
index.html          page, HUD, touch buttons
css/game.css        look of the HUD and menus
js/main.js          scene, camera, controls, game loop
js/terrain.js       height lookups and the terrain mesh
js/course.js        stars, jumps, trees, gates (LAYOUT numbers at the top)
js/buildings.js     Creekside and Kadenwood buildings from real footprints
js/trees.js         the forest near the rider, from the satellite forest map (trees 16-33 m tall, like the real coastal forest)
js/outfit.js        clothes, boards (shapes and handling) and the rider model
js/lifts.js         lifts: towers, cables, chairs and cabins, riding
js/rider.js         snowboard physics (PHYSICS numbers at the top) and the rider model
js/audio.js         synthesized sounds (no audio files)
tools/build_course.py   real elevation data → course files
tools/topo_contours.py  topo-map contours → tools/traces/whistler-contours.png
vendor/             three.js r170 (MIT licence)
```

## How the physics works (short version)

- Gravity pulls you down the slope; the snow pushes back so you stay on the surface.
- The board's edge resists sliding sideways. Steering turns the board, and the edge bends
  your path to follow it (a carve). Part of the sideways speed you lose turns into forward
  speed, so good turns keep you fast.
- Friction and air drag slow you down; drag grows with speed squared, which sets top speed.
- You only leave the snow when the ground drops away faster than gravity can pull you down
  (jump lips, rollovers), or when you ollie. Landing more than ~63° sideways, or very hard,
  is a wipeout.

## Ideas for later

- More tricks for gnar points: grabs, flips, buttering
- Lodges (Roundhouse, Rendezvous) and the Village buildings
- Run names on the HUD from traced run lines
- Village buildings (only Creekside and Kadenwood are traced so far)
