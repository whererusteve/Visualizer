# Peak Rush

A snowboarding game on real mountains, in the spirit of the 3D stages in Sonic 3:
fast, behind-the-back, collect stars and hit jumps. The first course is
**Whistler Mountain, from Whistler Peak (2,175 m) to the Village (~690 m)**:
6.3 km of real terrain.

Scoring isn't in yet; this version is about the riding and the physics.

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

`tools/build_course.py` downloads free elevation tiles (Mapzen "Terrarium" tiles on AWS
Open Data: SRTM, Canadian CDEM and other public data, about 6 m per pixel here),
crops the course, smooths it slightly and saves:

- `data/whistler.png`: the height grid, packed into a lossless image (495 × 635 cells, 12.3 m each)
- `data/whistler.json`: size, location and a guide line down the mountain

The guide line is a shortest-path search that prefers 12–30° slopes, avoids cliffs and
won't go uphill, so it lands on terrain a real rider would choose. Stars, jumps and the
cleared run through the forest are placed along it when the game loads.

To add a mountain, add an entry to `COURSES` in the script (bounds, start, finish) and run
`python3 tools/build_course.py <id>`, then open `/snowboard/?course=<id>`.

## Files

```
index.html          page, HUD, touch buttons
css/game.css        look of the HUD and menus
js/main.js          scene, camera, controls, game loop
js/terrain.js       height lookups and the terrain mesh
js/course.js        stars, jumps, trees, gates (LAYOUT numbers at the top)
js/rider.js         snowboard physics (PHYSICS numbers at the top) and the rider model
js/audio.js         synthesized sounds (no audio files)
tools/build_course.py   real elevation data → course files
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

- Scoring: stars, airtime, spins, clean landings
- Blackcomb course (the elevation is already downloaded by the same script)
- Real run lines from OpenStreetMap's ski-piste data
- Satellite imagery draped on the terrain
