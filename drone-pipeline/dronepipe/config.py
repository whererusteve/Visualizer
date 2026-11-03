"""Loading the settings file (config.toml).

TOML is a simple settings format. Python 3.11+ can read it with the
built-in "tomllib" module, so this needs no extra install.
"""

import sys
from pathlib import Path

if sys.version_info < (3, 11):
    sys.exit("dronepipe needs Python 3.11 or newer (for the built-in TOML reader). "
             "See the README's install section.")

import tomllib

# The config.toml that ships with the project sits one folder above this file.
DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.toml"


class ConfigError(Exception):
    """Raised when the settings file is missing something we need."""


def load_config(path=None):
    """Read config.toml and return it as a Python dictionary.

    If a file called config.local.toml sits next to config.toml, we use that
    instead. That lets you keep personal settings out of git (it's listed in
    .gitignore) while config.toml stays as the documented example.
    """
    if path is None:
        local = DEFAULT_CONFIG_PATH.with_name("config.local.toml")
        path = local if local.exists() else DEFAULT_CONFIG_PATH
    path = Path(path).expanduser()
    if not path.exists():
        raise ConfigError(f"Settings file not found: {path}")

    # tomllib wants the file opened in binary mode ("rb").
    with open(path, "rb") as f:
        try:
            cfg = tomllib.load(f)
        except tomllib.TOMLDecodeError as e:
            # Typos in the settings file are common - give a clear message.
            raise ConfigError(f"There's a typo in {path}: {e}") from e

    cfg["_path"] = str(path)  # remember where it came from, for the run log
    _check(cfg)
    return cfg


def _check(cfg):
    """Make sure the sections we rely on exist, with friendly errors."""
    for section in ("paths", "webodm", "images", "overlap", "crs", "sketchfab", "presets"):
        if section not in cfg:
            raise ConfigError(f"config.toml is missing the [{section}] section.")
    for name, preset in cfg["presets"].items():
        if "options" not in preset:
            raise ConfigError(f"Preset '{name}' has no [presets.{name}.options] block.")


def get_preset(cfg, name):
    """Return one preset's settings, or explain which presets exist."""
    presets = cfg["presets"]
    if name not in presets:
        available = ", ".join(sorted(presets))
        raise ConfigError(f"No preset called '{name}'. Available presets: {available}")
    return presets[name]


def projects_root(cfg, override=None):
    """The top-level Projects folder, with ~ expanded to your home folder."""
    return Path(override or cfg["paths"]["projects_root"]).expanduser()
