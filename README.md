# Earth Rhythms

A web app that shows and plays the planet's rhythms from live open data: day and night, the moon,
tides, wind, air temperature, earthquakes and geomagnetic activity (aurora). Each rhythm can be
turned on or off for both the map and the sound, so you can watch and hear how they line up.

## How it works

- **Map**: wind drawn as moving particles, a night shadow with a golden-hour band, the aurora oval,
  27 tide stations around the world that swell and shrink with the water, and recent earthquakes.
- **Timeline**: one lane per rhythm at your *listening point* across 5 days (2 past, 3 forecast).
  Drag it to move through time.
- **Time-lapse**: plays the 5 days at up to 6 hours per second, so slow cycles become audible.
- **Sound**: built with the browser's Web Audio API. Nothing is pre-recorded; every voice is
  shaped by the data in real time. All pitches use D major pentatonic so the layers don't clash.

| Rhythm | Data | What you hear |
|---|---|---|
| Day & night | Computed (sun position) | Bright chord by day, low drone at night |
| Moon | Computed (moon position + phase) | High shimmer, louder when full and high |
| Tides | Open-Meteo marine API (`sea_level_height_msl`) | Ocean wash swelling at high water |
| Wind | Open-Meteo forecast API | Moving air, louder/higher with speed, panned by direction |
| Temperature | Open-Meteo forecast API | Timeline only |
| Earthquakes | USGS, M2.5+ past 7 days | A bell per quake; bigger = deeper and longer |
| Aurora / Kp | NOAA SWPC planetary Kp | Wavering tones during storms (Kp 3+) |

### Resonance

Each rhythm has peak moments at the listening point: sunrise, solar noon, sunset, moonrise,
moonset, high and low tide, the warmest and coolest part of the day, wind peaks, magnetic storms
(Kp 5+) and M6+ earthquakes. Each rhythm also owns one note of the natural harmonic series on D.

- As a rhythm nears a peak, its note fades in slightly out of tune, so it wobbles (beats).
- When two or more rhythms peak within about 30 minutes of each other, the notes slide into tune
  and ring as one pure chord.
- On the map, a coloured ring per rhythm wobbles around the listening point at the same rate as
  the sound. When rhythms line up, the rings merge into one glowing circle that sends out ripples.
- On the timeline, a Resonance lane shows the strength over time, with a dot at each peak. Faint
  lines join peaks where two rhythms line up; bright lines mark three or more.

Rhythms only count toward resonance while their 👁 toggle is on. The logic lives in
`js/resonance.js`.

All data sources are free, need no API key, and allow browser access. Responses are cached in the
browser for 5–90 minutes to stay well inside the free-use limits.

## Running it

There is no build step. It's plain HTML, CSS and JavaScript modules.

```sh
# from this folder
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` by double-clicking won't work, because browsers block JavaScript modules
loaded from `file://`. Any static web server will do.

## Publishing it

Because it's static files, GitHub Pages can host it for free: in the repository, go to
**Settings → Pages**, choose "Deploy from a branch", pick the branch and the `/ (root)` folder.

## Files

```
index.html          page layout
css/style.css       look and feel (colours are variables at the top)
js/main.js          wiring: state, controls, playback, readouts
js/data.js          one fetch function per data source
js/astro.js         sun and moon maths
js/map.js           the world map and its layers
js/timeline.js      the stacked lanes underneath
js/resonance.js     finds peak moments and how closely they line up
js/audio.js         the sound engine
data/land-110m.json coastlines (Natural Earth via world-atlas, public domain)
vendor/             topojson-client (ISC licence)
```

## Ideas for later

- Real tide-gauge readings (NOAA CO-OPS, Canada's CHS IWLS API) alongside the modelled tides
- Ocean waves and swell period (already available in the marine API)
- Solar wind speed from NOAA SWPC as a faster "space weather" rhythm
- Record or export a time-lapse as audio
