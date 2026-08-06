"""Batch ingest into a camera's immutable frame store.

New images are written to ``cameras/<camera>/unsorted/``. Files whose **content**
(not filename) already exists in that camera are skipped.

SQLite maps content hashes to frame records for indexed duplicate checks. The
catalog is derived data and can be rebuilt by scanning the frame store.

This detects exact, byte-identical duplicates. Visually identical but re-encoded
images require separate perceptual near-duplicate detection.
"""
from __future__ import annotations

import hashlib
import io
import re
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO, Callable, Iterator

import config
import datamodel
import db
import perf

STREAM_CHUNK_SIZE = 1024 * 1024
PROGRESS_UPDATE_BYTES = 8 * STREAM_CHUNK_SIZE
INDEX_FLUSH_EVERY = 25

# target name -> directory resolver. Single destination: the
# camera's immutable inbox. (Reference frames are no longer a separate folder.)
_TARGETS = {
    "unsorted": datamodel.unsorted_dir,
}

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


# --- hashing / index ---------------------------------------------------------
def content_hash(data: bytes) -> str:
    """SHA-256 hex digest of the raw file bytes."""
    return hashlib.sha256(data).hexdigest()


def content_hash_file(path: str | Path) -> str:
    """SHA-256 a file incrementally without retaining its complete payload."""
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        while chunk := handle.read(STREAM_CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def rebuild_index(camera: str) -> dict[str, str]:
    """Scan the immutable inbox and replace its SQLite frame catalog."""
    by_hash: dict[str, tuple[str, str, float]] = {}
    for p in datamodel.list_unsorted(camera):
        try:
            h = content_hash_file(p)
        except OSError:
            continue
        by_hash.setdefault(h, (p.name, p.name, p.stat().st_mtime))
    db.replace_frame_index(
        camera,
        [(h, filename, original, created) for h, (filename, original, created) in by_hash.items()],
    )
    return {filename: h for h, (filename, _original, _created) in by_hash.items()}


def ensure_index(camera: str) -> None:
    """Build the catalog once for camera folders populated outside this app."""
    if db.frame_index_count(camera) == 0 and datamodel.list_unsorted(camera):
        rebuild_index(camera)


# --- filename helpers --------------------------------------------------------
def _sanitize(name: str) -> str:
    name = Path(name).name  # drop any directory part
    stem = _SAFE.sub("_", Path(name).stem).strip("_") or "image"
    suffix = Path(name).suffix.lower()
    if suffix not in config.IMAGE_EXTENSIONS:
        suffix = suffix or ".png"
    return stem + suffix


def _unique_path(directory: Path, filename: str) -> Path:
    candidate = directory / filename
    if not candidate.exists():
        return candidate
    stem, suffix = Path(filename).stem, Path(filename).suffix
    i = 1
    while (directory / f"{stem}_{i}{suffix}").exists():
        i += 1
    return directory / f"{stem}_{i}{suffix}"


# --- result ------------------------------------------------------------------
@dataclass
class IngestResult:
    added: list[str] = field(default_factory=list)    # written filenames
    skipped: list[str] = field(default_factory=list)  # original names skipped as dups
    errors: list[str] = field(default_factory=list)   # "name: reason"

    @property
    def n_added(self) -> int:
        return len(self.added)

    @property
    def n_skipped(self) -> int:
        return len(self.skipped)


@dataclass(frozen=True)
class IngestProgress:
    """Presentation-neutral progress for folder and upload ingest."""

    phase: str
    done: int = 0
    total: int = 0
    detail: str | None = None
    file_index: int = 0
    file_total: int = 0
    added: int = 0
    skipped: int = 0
    errors: int = 0


ProgressCallback = Callable[[IngestProgress], None]


def _emit_progress(
    callback: ProgressCallback | None,
    phase: str,
    *,
    done: int = 0,
    total: int = 0,
    detail: str | None = None,
    file_index: int = 0,
    file_total: int = 0,
    result: IngestResult | None = None,
) -> None:
    if callback is None:
        return
    callback(
        IngestProgress(
            phase=phase,
            done=done,
            total=total,
            detail=detail,
            file_index=file_index,
            file_total=file_total,
            added=result.n_added if result else 0,
            skipped=result.n_skipped if result else 0,
            errors=len(result.errors) if result else 0,
        )
    )


@contextmanager
def _open_source(source: bytes | bytearray | memoryview | Path | BinaryIO) -> Iterator[BinaryIO]:
    """Open one source at its beginning without taking ownership of uploads."""
    if isinstance(source, Path):
        with source.open("rb") as handle:
            yield handle
        return
    if isinstance(source, (bytes, bytearray, memoryview)):
        with io.BytesIO(source) as handle:
            yield handle
        return
    source.seek(0)
    yield source


def _source_size(source: bytes | bytearray | memoryview | Path | BinaryIO) -> int:
    if isinstance(source, Path):
        return source.stat().st_size
    if isinstance(source, (bytes, bytearray, memoryview)):
        return len(source)
    size = getattr(source, "size", None)
    if isinstance(size, int):
        return size
    position = source.tell()
    source.seek(0, 2)
    size = source.tell()
    source.seek(position)
    return size


def _stream_copy(
    source: bytes | bytearray | memoryview | Path | BinaryIO,
    destination: Path,
    *,
    on_chunk: Callable[[int], None] | None = None,
) -> tuple[str, int]:
    """Copy one source while independently verifying its second-pass hash."""
    digest = hashlib.sha256()
    copied = 0
    with _open_source(source) as input_handle, destination.open("wb") as output_handle:
        while chunk := input_handle.read(STREAM_CHUNK_SIZE):
            output_handle.write(chunk)
            digest.update(chunk)
            copied += len(chunk)
            if on_chunk is not None:
                on_chunk(copied)
    return digest.hexdigest(), copied


# --- ingest ------------------------------------------------------------------
def ingest_files(
    camera: str,
    target: str,
    files,
    *,
    progress_cb: ProgressCallback | None = None,
    total: int | None = None,
) -> IngestResult:
    """Ingest ``(name, source)`` items into a registered camera target.

    The current target is the camera's immutable ``unsorted/`` frame store.
    Byte-identical duplicates already present in the camera or repeated within the
    same batch are skipped. A source may be bytes, a ``Path``, or a seekable
    binary upload. Paths and uploads are hashed and copied in bounded chunks.

    Returns a summary of added, skipped, and errored files.
    """
    if target not in _TARGETS:
        raise ValueError(f"target must be one of {list(_TARGETS)}, got {target!r}")
    datamodel.ensure_camera_dirs(camera)
    dir_fn = _TARGETS[target]
    dest_dir = dir_fn(camera)
    ensure_index(camera)
    con = db.connect()
    result = IngestResult()
    if total is None:
        try:
            total = len(files)
        except TypeError:
            total = 0
    unsaved_additions = 0

    for file_index, (name, source) in enumerate(files, start=1):
        temp_path: Path | None = None
        moved_path: Path | None = None
        try:
            source_size = _source_size(source)
            detail = f"{file_index}/{total} · {name}" if total else name
            with tempfile.NamedTemporaryFile(
                dir=dest_dir,
                prefix=".ingest-",
                suffix=".tmp",
                delete=False,
            ) as handle:
                temp_path = Path(handle.name)
            _emit_progress(
                progress_cb,
                "hashing",
                done=0,
                total=source_size,
                detail=detail,
                file_index=file_index,
                file_total=total,
                result=result,
            )
            with perf.span("ingest.hash_and_stage"):
                h, staged_bytes = _stream_copy(
                    source,
                    temp_path,
                    on_chunk=lambda done: (
                        _emit_progress(
                            progress_cb,
                            "hashing",
                            done=done,
                            total=source_size,
                            detail=detail,
                            file_index=file_index,
                            file_total=total,
                            result=result,
                        )
                        if done >= source_size or done % PROGRESS_UPDATE_BYTES == 0
                        else None
                    ),
                )
            perf.count("ingest.files_hashed")
            perf.count("ingest.bytes_hashed", staged_bytes)
            perf.count("ingest.bytes_staged", staged_bytes)
            if not staged_bytes:
                result.errors.append(f"{name}: empty file")
                perf.count("ingest.errors")
                _emit_progress(
                    progress_cb, "error", done=file_index, total=total,
                    detail=f"{name}: empty file", file_index=file_index,
                    file_total=total, result=result,
                )
                continue
            if con.execute(
                "SELECT 1 FROM frames WHERE camera=? AND hash=?", (camera, h)
            ).fetchone():
                result.skipped.append(name)
                perf.count("ingest.duplicates")
                _emit_progress(
                    progress_cb, "duplicate", done=file_index, total=total,
                    detail=name, file_index=file_index, file_total=total,
                    result=result,
                )
                continue

            path = _unique_path(dest_dir, _sanitize(name))
            _emit_progress(
                progress_cb,
                "copying",
                done=0,
                total=1,
                detail=detail,
                file_index=file_index,
                file_total=total,
                result=result,
            )
            with perf.span("ingest.copy"):
                temp_path.replace(path)
            temp_path = None
            moved_path = path
            _emit_progress(
                progress_cb,
                "copying",
                done=1,
                total=1,
                detail=detail,
                file_index=file_index,
                file_total=total,
                result=result,
            )
            con.execute(
                "INSERT INTO frames(camera,filename,hash,orig_name,created) "
                "VALUES(?,?,?,?,?)",
                (camera, path.name, h, name, time.time()),
            )
            result.added.append(path.name)
            moved_path = None
            unsaved_additions += 1
            perf.count("ingest.files_added")
            perf.count("ingest.bytes_copied", staged_bytes)
            if unsaved_additions >= INDEX_FLUSH_EVERY:
                with perf.span("ingest.index_save"):
                    con.commit()
                unsaved_additions = 0
        except Exception as e:  # noqa: BLE001 - keep going, report per-file
            if moved_path is not None and moved_path.exists():
                try:
                    moved_path.unlink()
                except OSError:
                    pass
            result.errors.append(f"{name}: {e}")
            perf.count("ingest.errors")
            _emit_progress(
                progress_cb, "error", done=file_index, total=total,
                detail=f"{name}: {e}", file_index=file_index,
                file_total=total, result=result,
            )
        finally:
            if temp_path is not None and temp_path.exists():
                try:
                    temp_path.unlink()
                except OSError:
                    pass

    _emit_progress(
        progress_cb, "persistence", done=0, total=1,
        detail="Committing frame catalog", file_index=total, file_total=total,
        result=result,
    )
    index_saved = True
    try:
        with perf.span("ingest.index_save"):
            con.commit()
    except Exception as e:  # noqa: BLE001 - successful files remain valid
        con.rollback()
        index_saved = False
        result.errors.append(f"frame catalog: {e}")
        perf.count("ingest.errors")
        _emit_progress(
            progress_cb, "error", done=total, total=total,
            detail=f"frame catalog: {e}", file_index=total, file_total=total,
            result=result,
        )
    finally:
        con.close()
    if index_saved:
        _emit_progress(
            progress_cb, "persistence", done=1, total=1,
            detail="Frame catalog committed", file_index=total, file_total=total,
            result=result,
        )
    if result.added:
        datamodel.invalidate_frames(camera)
    return result


def ingest_folder(
    camera: str,
    target: str,
    folder: str | Path,
    *,
    progress_cb: ProgressCallback | None = None,
) -> IngestResult:
    """Ingest every recognised image file directly inside ``folder`` (non-recursive)."""
    folder = Path(folder)
    if not folder.is_dir():
        r = IngestResult()
        r.errors.append(f"{folder}: not a directory")
        _emit_progress(progress_cb, "error", detail=r.errors[0], result=r)
        return r

    paths: list[Path] = []
    _emit_progress(progress_cb, "scanning", detail=str(folder))
    with perf.span("ingest.scan"):
        try:
            entries = sorted(folder.iterdir())
        except OSError as e:
            result = IngestResult(errors=[f"{folder}: {e}"])
            _emit_progress(
                progress_cb, "error", detail=result.errors[0], result=result,
            )
            return result
        for p in entries:
            if p.is_file() and p.suffix.lower() in config.IMAGE_EXTENSIONS:
                paths.append(p)
                _emit_progress(
                    progress_cb, "scanning", done=len(paths),
                    detail=p.name,
                )

    _emit_progress(
        progress_cb, "scanning", done=len(paths), total=len(paths),
        detail=f"{len(paths)} image file(s)", file_total=len(paths),
    )
    result = ingest_files(
        camera,
        target,
        ((p.name, p) for p in paths),
        progress_cb=progress_cb,
        total=len(paths),
    )
    # A path can disappear or become unreadable between scanning and hashing;
    # ingest_files reports that item and continues with the rest.
    return result
