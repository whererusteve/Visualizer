"""The command line: this file reads what you typed and runs the steps.

Commands (run "python -m dronepipe <command> --help" for details):

  report       Step 1-2 only: read photos, print the pre-flight report.
  run          The whole pipeline: report -> confirm -> organize ->
               process -> export -> Sketchfab package -> log.
  resume       Pick up a task that's still processing (or finished while
               you weren't watching) and do the export/package/log steps.
  diff         Stretch goal: elevation change between two dates.
  presets      List the processing presets in config.toml.
  sample-data  Make fake drone photos for practising/testing.
"""

import argparse
import sys
from pathlib import Path

from dronepipe import config as config_mod
from dronepipe.exif_reader import read_folder
from dronepipe.organize import check_site_name, copy_photos, date_folder
from dronepipe.report import build_report, format_report
from dronepipe.runlog import load_state, save_state, write_run_log


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 0
    try:
        return args.func(args) or 0
    except (config_mod.ConfigError, ValueError, FileExistsError) as e:
        print(f"\nProblem: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nStopped.", file=sys.stderr)
        sys.exit(130)
    except Exception as e:
        # WebODM errors and anything unexpected: show the message plainly.
        if type(e).__name__ == "WebODMError":
            print(f"\nWebODM problem: {e}", file=sys.stderr)
            sys.exit(1)
        raise


def build_parser():
    p = argparse.ArgumentParser(
        prog="python -m dronepipe",
        description="Drone photogrammetry pipeline: photos -> WebODM -> QGIS/Sketchfab.")
    p.add_argument("--config", help="Use a different settings file (default: config.toml)")
    sub = p.add_subparsers(title="commands")

    r = sub.add_parser("report", help="Read photos and print the pre-flight report")
    r.add_argument("folder", help="Folder of drone photos (e.g. your SD card)")
    r.set_defaults(func=cmd_report)

    run = sub.add_parser("run", help="Run the whole pipeline")
    run.add_argument("folder", help="Folder of drone photos (e.g. your SD card)")
    run.add_argument("--site", required=True, help="Site name, e.g. metal-dome")
    run.add_argument("--preset", default="fast-preview", help="Preset from config.toml")
    run.add_argument("--date", help="Override the flight date (YYYY-MM-DD)")
    run.add_argument("--yes", action="store_true", help="Don't ask for confirmation")
    run.add_argument("--organize-only", action="store_true",
                     help="Stop after copying photos (no WebODM)")
    run.add_argument("--projects-root", help="Override projects_root from config.toml")
    run.set_defaults(func=cmd_run)

    res = sub.add_parser("resume", help="Collect results of an earlier run's WebODM task")
    res.add_argument("--site", required=True)
    res.add_argument("--date", required=True, help="Flight date folder, YYYY-MM-DD")
    res.add_argument("--projects-root")
    res.set_defaults(func=cmd_resume)

    d = sub.add_parser("diff", help="Elevation change between two dates")
    d.add_argument("--site", help="Site name (use with --before/--after dates)")
    d.add_argument("--before", help="Earlier date (YYYY-MM-DD) or a path to a DSM .tif")
    d.add_argument("--after", help="Later date (YYYY-MM-DD) or a path to a DSM .tif")
    d.add_argument("--surface", choices=["dsm", "dtm"], default="dsm",
                   help="Compare DSMs (default) or DTMs")
    d.add_argument("--stable-area", metavar="MINX,MINY,MAXX,MAXY",
                   help="A box (in map coordinates) of ground you know didn't change - "
                        "used to remove the overall height offset between flights")
    d.add_argument("--min-change", type=float, default=0.5, metavar="METRES",
                   help="Changes smaller than this are treated as likely noise (default 0.5)")
    d.add_argument("--out", help="Where to write the result (default: <site>/changes/)")
    d.add_argument("--projects-root")
    d.set_defaults(func=cmd_diff)

    pr = sub.add_parser("presets", help="List processing presets")
    pr.set_defaults(func=cmd_presets)

    s = sub.add_parser("sample-data", help="Make fake drone photos for testing")
    s.add_argument("folder", help="Where to write them")
    s.set_defaults(func=cmd_sample_data)
    return p


# ----------------------------------------------------------------------
# Commands
# ----------------------------------------------------------------------

def cmd_report(args):
    cfg = config_mod.load_config(args.config)
    folder = _existing_folder(args.folder)
    photos = read_folder(folder)
    print(format_report(build_report(photos, cfg), folder))


def cmd_presets(args):
    cfg = config_mod.load_config(args.config)
    for name, preset in cfg["presets"].items():
        print(f"\n{name}\n   {preset.get('description', '')}")
        for k, v in preset["options"].items():
            print(f"     {k} = {v}")


def cmd_sample_data(args):
    from dronepipe.sample_data import make_sample_flight
    paths = make_sample_flight(args.folder)
    print(f"Made {len(paths)} fake drone photos in {args.folder}")


def cmd_run(args):
    cfg = config_mod.load_config(args.config)
    site = check_site_name(args.site)
    preset = config_mod.get_preset(cfg, args.preset)
    folder = _existing_folder(args.folder)

    # --- Steps 1 + 2: ingest and report ---------------------------------
    photos = read_folder(folder)
    report = build_report(photos, cfg)
    print(format_report(report, folder))
    if not photos:
        return 1

    date = args.date or report.get("flight_date")
    if not date:
        raise ValueError("Couldn't work out the flight date. Add --date YYYY-MM-DD.")
    root = config_mod.projects_root(cfg, args.projects_root)
    day_dir = date_folder(root, site, date)
    outputs_dir = day_dir / "outputs"

    print(f"\n  Photos will be COPIED to: {day_dir / 'raw'}")
    if not args.organize_only:
        print(f"  Then processed in WebODM with preset '{args.preset}': "
              f"{preset.get('description', '')}")
        if outputs_dir.exists() and any(outputs_dir.iterdir()):
            print(f"  NOTE: {outputs_dir} already has files; same-named ones will be replaced.")
    if not args.yes and not _confirm("\n  Continue? [y/N] "):
        print("  OK, nothing was copied or processed.")
        return 0

    warnings = list(report["warnings"])

    # --- Step 3: organize ------------------------------------------------
    copy_summary = copy_photos(photos, day_dir / "raw")
    print(f"  Copied {copy_summary['copied']} photos "
          f"({copy_summary['already_there']} were already there).")
    save_state(day_dir, site=site, date=date, source=str(folder), report=report,
               preset_name=args.preset, preset=preset)

    if args.organize_only:
        log = write_run_log(day_dir, site=site, date=date, source=folder, preset_name=None,
                            preset={}, report=report, copy_summary=copy_summary,
                            warnings=warnings, config_path=cfg["_path"])
        print(f"\n  Done (organize only). Log: {log}")
        return 0

    # --- Step 4: process in WebODM -----------------------------------------
    from dronepipe.webodm import WebODM
    odm = WebODM(cfg["webodm"]["url"], cfg["webodm"]["username"])
    _check_preset_options(odm, preset, warnings)

    send_dng = cfg["images"].get("send_dng_to_webodm", False)
    uploads = [copy_summary["mapping"][str(p.path)] for p in photos
               if send_dng or not p.is_raw]
    project_id = odm.get_or_create_project(site, description=f"dronepipe site: {site}")
    task_id = odm.create_task(project_id, f"{site} {date} ({args.preset})",
                              preset["options"], uploads)
    save_state(day_dir, project_id=project_id, task_id=task_id, warnings=warnings,
               copy_summary={k: v for k, v in copy_summary.items() if k != "mapping"})
    print(f"  Task started (WebODM project {project_id}). Watching progress - "
          "Ctrl+C stops watching, not processing.")
    info = odm.wait_for_task(project_id, task_id, cfg["webodm"].get("poll_seconds", 10))

    # --- Steps 5-7 ---------------------------------------------------------
    finish(cfg, odm, day_dir, info)


def cmd_resume(args):
    cfg = config_mod.load_config(args.config)
    root = config_mod.projects_root(cfg, args.projects_root)
    day_dir = date_folder(root, check_site_name(args.site), args.date)
    state = load_state(day_dir)
    if not state or "task_id" not in state:
        raise ValueError(f"No WebODM task recorded in {day_dir}/run_state.json - "
                         "was 'run' started for this site and date?")
    from dronepipe.webodm import WebODM
    odm = WebODM(cfg["webodm"]["url"], cfg["webodm"]["username"])
    info = odm.wait_for_task(state["project_id"], state["task_id"],
                             cfg["webodm"].get("poll_seconds", 10))
    finish(cfg, odm, day_dir, info)


def finish(cfg, odm, day_dir, info):
    """Steps 5-7: download + CRS check, Sketchfab package, log."""
    from dronepipe.export import download_outputs, ensure_crs
    from dronepipe.sketchfab import package_for_sketchfab

    state = load_state(day_dir)
    site, date = state["site"], state["date"]
    warnings = list(state.get("warnings", []))
    warn = warnings.append
    target = cfg["crs"]["target_epsg"]

    print("\n  Downloading results:")
    saved = download_outputs(odm, state["project_id"], state["task_id"], info,
                             day_dir / "outputs", site, date, warn)
    crs_found = ensure_crs(saved, target, day_dir / "outputs", warn)

    zip_path = None
    if "textured_model.zip" in saved:
        zip_path = package_for_sketchfab(saved["textured_model.zip"], day_dir / "share",
                                         site, date, cfg["sketchfab"], warn)

    seconds = (info.get("processing_time") or 0) / 1000  # WebODM reports milliseconds
    log = write_run_log(
        day_dir, site=site, date=date, source=state.get("source"),
        preset_name=state.get("preset_name"), preset=state.get("preset", {}),
        report=state.get("report", {}), copy_summary=state.get("copy_summary"),
        processing_seconds=seconds,
        task_ref={"project_id": state["project_id"], "task_id": state["task_id"]},
        outputs=list(saved.values()), crs_found=crs_found, target_epsg=target,
        sketchfab_zip=zip_path, warnings=warnings, config_path=cfg["_path"])
    save_state(day_dir, finished=True)
    odm.session.close()

    print(f"\n  All done. Results in {day_dir / 'outputs'}")
    if zip_path:
        print(f"  Sketchfab upload: {zip_path}")
    print(f"  Log: {log}")
    for w in warnings:
        print(f"   ! {w}")


def cmd_diff(args):
    from dronepipe.diff import run_diff
    cfg = config_mod.load_config(args.config)
    run_diff(args, cfg)


# ----------------------------------------------------------------------
# Small helpers
# ----------------------------------------------------------------------

def _existing_folder(path):
    folder = Path(path).expanduser()
    if not folder.is_dir():
        raise ValueError(f"Folder not found: {folder}")
    return folder


def _confirm(question):
    try:
        return input(question).strip().lower() in ("y", "yes")
    except EOFError:  # no keyboard attached (e.g. in a script)
        return False


def _check_preset_options(odm, preset, warnings):
    """Catch typos in preset option names before hours of processing."""
    known = odm.known_option_names()
    if known is None:
        print("  (Couldn't fetch WebODM's option list, so preset names weren't checked.)")
        return
    unknown = [k for k in preset["options"] if k not in known]
    if unknown:
        msg = (f"Preset option(s) not recognised by your WebODM: {', '.join(unknown)}. "
               "They'll probably be ignored. Check spelling against WebODM's options panel.")
        print(f"  ! {msg}")
        warnings.append(msg)
