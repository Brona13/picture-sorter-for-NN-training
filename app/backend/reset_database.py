"""Reset incompatible metadata/caches while preserving source images.

This clean-break utility removes only:

- ``data/picture_sorter.db`` and its SQLite sidecars
- retired ``features/`` cutout trees under each camera
- retired ``logs/manifest.jsonl`` and ``logs/ingest_index.json`` files

It never removes ``unsorted/`` source images or exports. ROI definitions
now live in the SQLite ``rois`` table, so a reset also clears them —
re-draw them in the ROI editor before re-labeling.
"""
from __future__ import annotations

import argparse
import shutil
from pathlib import Path

import config
import db


def reset(*, remove_legacy_files: bool = True) -> list[Path]:
    removed = db.reset_database()
    if not remove_legacy_files or not config.CAMERAS_ROOT.exists():
        return removed
    for camera_dir in config.CAMERAS_ROOT.iterdir():
        if not camera_dir.is_dir():
            continue
        features = camera_dir / "features"
        if features.exists():
            shutil.rmtree(features)
            removed.append(features)
        logs = camera_dir / "logs"
        for filename in ("manifest.jsonl", "ingest_index.json"):
            path = logs / filename
            if path.exists():
                path.unlink()
                removed.append(path)
        if logs.exists() and not any(logs.iterdir()):
            logs.rmdir()
            removed.append(logs)
    return removed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Confirm deletion of metadata, caches, and retired artifacts.",
    )
    parser.add_argument(
        "--keep-legacy-files",
        action="store_true",
        help="Reset SQLite only; do not remove retired camera artifacts.",
    )
    args = parser.parse_args()
    if not args.yes:
        parser.error("refusing destructive reset without --yes")
    removed = reset(remove_legacy_files=not args.keep_legacy_files)
    if removed:
        print("Removed:")
        for path in removed:
            print(f"- {path}")
    else:
        print("Nothing needed removal.")
    print("Preserved all unsorted source images and exports (ROI definitions were in the database and are gone).")


if __name__ == "__main__":
    main()
