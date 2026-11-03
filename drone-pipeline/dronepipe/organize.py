"""Step 3 - ORGANIZE: COPY the photos into a tidy, predictable folder.

    <projects_root>/<site-name>/<YYYY-MM-DD>/raw/

Safety rules (your originals are precious):
  * We only ever COPY. Nothing here moves, renames, edits or deletes
    anything in the source folder.
  * We never overwrite a file in raw/ either. If a file with the same name
    is already there:
       - same size  -> assume it's the same photo copied earlier; skip it
       - different  -> keep both; the new one gets its folder name added
  * After copying, we check each copy is the same size as the original.
"""

import re
import shutil
from pathlib import Path

SITE_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def check_site_name(name):
    """Site names become folder and file names, so keep them simple:
    lower-case letters, numbers and dashes - e.g. 'metal-dome'."""
    if not SITE_NAME_PATTERN.match(name):
        raise ValueError(
            f"Site name '{name}' should use only lower-case letters, numbers and dashes "
            "(like 'metal-dome'). That keeps folder names and file names tidy.")
    return name


def date_folder(root, site, date):
    """The folder for one site on one day, e.g. ~/Drone/Projects/metal-dome/2026-11-02"""
    return Path(root) / site / date


def copy_photos(photos, raw_dir, progress=True):
    """Copy each photo into raw_dir. Returns a summary dictionary.

    Also returns 'mapping': {original path -> copied path}, so later steps
    know which file in raw/ came from where.
    """
    raw_dir = Path(raw_dir)
    raw_dir.mkdir(parents=True, exist_ok=True)
    summary = {"copied": 0, "already_there": 0, "renamed": 0, "mapping": {}}
    total = len(photos)

    for i, photo in enumerate(photos, start=1):
        src = photo.path
        dest = raw_dir / src.name

        if dest.exists():
            if dest.stat().st_size == src.stat().st_size:
                # Same name and size: almost certainly copied on a previous run.
                summary["already_there"] += 1
                summary["mapping"][str(src)] = dest
                continue
            # Same name, different file. SD cards restart numbering in each
            # DCIM sub-folder (100MEDIA, 101MEDIA...), so this can happen.
            dest = raw_dir / f"{src.parent.name}_{src.name}"
            summary["renamed"] += 1
            if dest.exists():
                raise FileExistsError(
                    f"Can't copy {src}: both {src.name} and {dest.name} already exist in "
                    f"{raw_dir} with different contents. Nothing was overwritten. "
                    "Check whether two different flights are being filed under one date.")

        # copy2 = copy the file AND keep its original timestamps.
        shutil.copy2(src, dest)
        if dest.stat().st_size != src.stat().st_size:
            raise IOError(f"Copy of {src.name} looks incomplete (size mismatch). "
                          "Is the disk full? Your original is untouched.")
        summary["copied"] += 1
        summary["mapping"][str(src)] = dest

        if progress and (i % 10 == 0 or i == total):
            print(f"\r  Copying photos: {i}/{total}", end="", flush=True)
    if progress and total:
        print()
    return summary
