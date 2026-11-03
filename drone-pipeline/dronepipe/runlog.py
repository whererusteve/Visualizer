"""Step 7 - LOG: a short, human-readable record of each run.

Two files live in each date folder:

  run_log.md      For you. Settings, image count, timings, warnings.
                  Each run ADDS a section, so re-runs keep their history.
                  (.md = Markdown: plain text that also displays nicely on GitHub.)
  run_state.json  For the program. Remembers the WebODM project/task IDs
                  so the 'resume' command can find the task again.
"""

import json
from datetime import datetime
from pathlib import Path


def save_state(date_dir, **values):
    """Merge values into run_state.json (creating it if needed)."""
    path = Path(date_dir) / "run_state.json"
    state = load_state(date_dir) or {}
    state.update(values)
    path.write_text(json.dumps(state, indent=2, default=str))
    return state


def load_state(date_dir):
    path = Path(date_dir) / "run_state.json"
    return json.loads(path.read_text()) if path.exists() else None


def write_run_log(date_dir, *, site, date, source, preset_name, preset, report,
                  copy_summary=None, processing_seconds=None, task_ref=None,
                  outputs=None, crs_found=None, target_epsg=None, sketchfab_zip=None,
                  warnings=(), config_path=None):
    """Append one run's summary to run_log.md."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    L = [f"## Run at {now}", "",
         f"- **Site:** {site}",
         f"- **Flight date:** {date}",
         f"- **Photos from:** `{source}`",
         f"- **Images:** {report.get('image_count', 0)} "
         f"({report.get('jpeg_count', 0)} JPEG, {report.get('dng_count', 0)} DNG)"]
    if report.get("pointing"):
        p = report["pointing"]
        L.append(f"- **Camera angles:** {p['nadir']} nadir, {p['oblique']} oblique, "
                 f"{p['near-horizontal']} near-horizontal, {p['unknown']} unknown")
    if copy_summary:
        L.append(f"- **Copied to raw/:** {copy_summary['copied']} new, "
                 f"{copy_summary['already_there']} already there, "
                 f"{copy_summary['renamed']} renamed to avoid name clashes")
    if preset_name:
        L.append(f"- **Preset:** `{preset_name}` - {preset.get('description', '')}")
        for k, v in preset.get("options", {}).items():
            L.append(f"    - `{k}` = `{v}`")
    if config_path:
        L.append(f"- **Settings file:** `{config_path}`")
    if task_ref:
        L.append(f"- **WebODM:** project {task_ref.get('project_id')}, task `{task_ref.get('task_id')}`")
    if processing_seconds is not None:
        mins = processing_seconds / 60
        L.append(f"- **Processing time (WebODM):** {mins:.1f} minutes")
    if target_epsg:
        L.append(f"- **Output CRS:** EPSG:{target_epsg}"
                 + (" (as delivered by WebODM: " + ", ".join(
                     f"{name.replace('.tif', '')} EPSG:{code}" for name, code in crs_found.items())
                    + ")" if crs_found else ""))
    if outputs:
        L.append("- **Outputs:**")
        for path in outputs:
            L.append(f"    - `{Path(path).name}`")
    if sketchfab_zip:
        L.append(f"- **Sketchfab package:** `share/{Path(sketchfab_zip).name}`")
    L.append("")
    if warnings:
        L.append("**Warnings:**")
        L += [f"- {w}" for w in warnings]
    else:
        L.append("No warnings.")
    L += ["", "---", ""]

    log = Path(date_dir) / "run_log.md"
    is_new = not log.exists()
    with open(log, "a", encoding="utf-8") as f:  # "a" = append, never overwrite
        if is_new:
            f.write(f"# Run log: {site} {date}\n\n")
        f.write("\n".join(L))
    return log
