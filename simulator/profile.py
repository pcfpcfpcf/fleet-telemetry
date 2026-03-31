from __future__ import annotations

import json
from pathlib import Path
from typing import Any


DEFAULT_PROFILE = {
    "name": "fmc003-default",
    "io": {
        "239": {"source": "ignition", "size": 1},
        "240": {"source": "movement", "size": 1},
        "24": {"source": "speed_kmh", "size": 2},
        "66": {"source": "battery_mv", "size": 2},
        "21": {"source": "gsm_signal", "size": 1},
        "16": {"source": "odometer_m", "size": 4},
        "13": {"source": "fuel_pct", "size": 2, "scale": 10},
        "12": {"source": "rpm", "size": 2},
    },
    "events": {
        "ignition_change": 239,
        "movement_change": 240,
        "speed_bucket_change": 24,
        "default": 0,
        "speed_bucket_size": 5,
    },
}


def _validate_profile(profile: dict[str, Any]) -> None:
    if "io" not in profile or not isinstance(profile["io"], dict):
        raise ValueError("Profile must contain an 'io' object")

    for io_id, conf in profile["io"].items():
        int(io_id)
        if not isinstance(conf, dict):
            raise ValueError(f"io.{io_id} must be an object")
        if "source" not in conf:
            raise ValueError(f"io.{io_id}.source is required")
        if "size" not in conf:
            raise ValueError(f"io.{io_id}.size is required")
        size = int(conf["size"])
        if size not in (1, 2, 4, 8):
            raise ValueError(f"io.{io_id}.size must be one of 1,2,4,8")

    if "events" in profile and not isinstance(profile["events"], dict):
        raise ValueError("events must be an object")


def merge_profile(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = {
        "name": override.get("name", base.get("name", "profile")),
        "io": dict(base.get("io", {})),
        "events": dict(base.get("events", {})),
    }

    if "io" in override:
        for io_id, conf in override["io"].items():
            merged["io"][str(io_id)] = conf

    if "events" in override:
        merged["events"].update(override["events"])

    _validate_profile(merged)
    return merged


def load_profile(profile_path: str | None) -> dict[str, Any]:
    if not profile_path:
        return DEFAULT_PROFILE

    data = json.loads(Path(profile_path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Profile JSON must be an object")

    return merge_profile(DEFAULT_PROFILE, data)
