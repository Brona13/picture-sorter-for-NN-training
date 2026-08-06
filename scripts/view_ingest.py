"""Ingest view — upload / folder-import images with content-based de-duplication."""
from __future__ import annotations

import re

import streamlit as st

import config
import datamodel
import ingest
import ui_common

# Single destination: every frame lands in the camera's immutable inbox. Reference
# frames are no longer a separate folder — any ingested frame can serve as the ROI
# drawing background, and scoring references are per-class golden *marks*.
_INGEST_TARGET = ("unsorted", "frames")


class _IngestProgressUI:
    """Translate domain ingest phases into one live Streamlit status."""

    _LABELS = {
        "scanning": "Scanning folder for images…",
        "hashing": "Hashing and staging for exact duplicate detection…",
        "copying": "Committing a new frame…",
        "duplicate": "Duplicate found; skipping…",
        "error": "An item failed; continuing…",
        "persistence": "Committing the SQLite frame catalog…",
    }

    def __init__(self, title: str) -> None:
        self._status = st.status(title, expanded=True)
        self._bar = self._status.progress(0.0, text=title)

    def __call__(self, update: ingest.IngestProgress) -> None:
        label = self._LABELS.get(update.phase, update.phase.replace("_", " ").capitalize())
        self._status.update(label=label, state="running", expanded=True)
        fraction = update.done / update.total if update.total else 0.0
        fraction = max(0.0, min(1.0, fraction))
        detail = f" · {update.detail}" if update.detail else ""
        counts = (
            f" · added {update.added}, duplicates {update.skipped}, errors {update.errors}"
            if update.added or update.skipped or update.errors
            else ""
        )
        self._bar.progress(fraction, text=f"{label}{detail}{counts}")

    def complete(self, result: ingest.IngestResult) -> None:
        label = (
            f"Import finished · added {result.n_added}, duplicates {result.n_skipped}, "
            f"errors {len(result.errors)}"
        )
        self._bar.progress(1.0, text=label)
        self._status.update(label=label, state="complete", expanded=False)


def _show_ingest_report() -> None:
    """Display (once) the summary stashed by the previous ingest action."""
    rep = st.session_state.pop(ui_common.INGEST_REPORT_KEY, None)
    if not rep:
        return
    msg = f"Added **{rep['added']}** to **{rep['target']}**"
    if rep["skipped"]:
        msg += f" · skipped **{len(rep['skipped'])}** duplicate(s)"
    st.success(msg)
    if rep["skipped"]:
        with st.expander(f"{len(rep['skipped'])} skipped as duplicates"):
            st.write(rep["skipped"])
    if rep["errors"]:
        st.error("Errors:\n\n" + "\n".join(f"- {e}" for e in rep["errors"]))


def _stash_and_rerun(target: str, result: ingest.IngestResult) -> None:
    st.session_state[ui_common.INGEST_REPORT_KEY] = {
        "target": target,
        "added": result.n_added,
        "skipped": result.skipped,
        "errors": result.errors,
    }
    st.rerun()


def _ingest_section(camera: str, target: str, label: str) -> None:
    upload_types = [e.lstrip(".") for e in sorted(config.IMAGE_EXTENSIONS)]
    with st.form(f"upload::{camera}::{target}", clear_on_submit=True):
        files = st.file_uploader(
            f"Drop or browse images for **{label}**",
            type=upload_types,
            accept_multiple_files=True,
            key=f"uploader::{camera}::{target}",
        )
        submitted = st.form_submit_button("➕ Add frames")
    if submitted:
        if files:
            progress = _IngestProgressUI(f"Preparing {len(files)} upload(s)…")
            result = ingest.ingest_files(
                camera,
                target,
                [(f.name, f) for f in files],
                progress_cb=progress,
                total=len(files),
            )
            progress.complete(result)
            _stash_and_rerun(target, result)
        else:
            st.warning("No files selected.")

    with st.expander("…or import from a folder path on this computer"):
        folder = st.text_input("Folder path", key=f"folder::{camera}::{target}")
        if st.button("Import folder", key=f"folderbtn::{camera}::{target}"):
            if folder.strip():
                progress = _IngestProgressUI("Scanning folder…")
                result = ingest.ingest_folder(
                    camera, target, folder.strip(), progress_cb=progress,
                )
                progress.complete(result)
                _stash_and_rerun(target, result)
            else:
                st.warning("Enter a folder path.")


def render(camera: str, product: str | None = None) -> None:
    # Ingest is product-agnostic: frames land in the camera's one inbox and are
    # assigned a product later, in Classify.
    del product
    st.header(f"Ingest — {camera}")
    st.caption(
        "Add images to this camera. Duplicates are detected by file **content** "
        "(not filename), so the same picture is never ingested twice."
    )
    _show_ingest_report()

    st.metric("Frames in this camera", len(datamodel.list_unsorted(camera)))

    target, label = _INGEST_TARGET
    _ingest_section(camera, target, label)

    with st.expander("Maintenance"):
        st.caption(
            "If you added or removed images outside this app, rebuild the SQLite "
            "frame catalog so content checks stay accurate."
        )
        if st.button("Rebuild frame catalog from disk"):
            idx = ingest.rebuild_index(camera)
            st.success(f"Rebuilt catalog: {len(idx)} unique image(s) tracked.")
        st.divider()
        new_cam = st.text_input("Create a new camera (folder name)")
        if st.button("Create camera"):
            name = re.sub(r"[^A-Za-z0-9._-]+", "-", new_cam.strip()).strip("-")
            if name:
                datamodel.ensure_camera_dirs(name)
                st.success(f"Created camera '{name}'. Pick it in the sidebar.")
                st.rerun()
            else:
                st.warning("Enter a valid camera name.")
