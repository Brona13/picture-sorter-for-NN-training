import { useState } from "react";
import { api, CameraDeletePreview } from "./api";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** The rows worth naming in the warning; everything else is removed too and counted under "other". */
const NAMED: [string, string][] = [
  ["frames", "pictures"],
  ["rois", "ROIs"],
  ["labels", "labels"],
  ["goldens", "goldens"],
  ["versions", "versions"],
  ["detections", "detections"],
];

/**
 * Deletes a camera with everything related to it. Nothing happens until the camera's name is typed again, and the
 * warning says what would go (database rows per kind, and the pictures and exports on disk).
 */
export default function CameraDelete({ camera, onDeleted }: { camera: string; onDeleted: (camera: string) => void }) {
  const [preview, setPreview] = useState<CameraDeletePreview | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setError(null);
    setTyped("");
    try {
      setPreview(await api.cameraDeletePreview(camera));
    } catch (e) {
      setError(msg(e));
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteCamera(camera);
      setPreview(null);
      onDeleted(camera);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const named = preview ? NAMED.filter(([key]) => preview.rows[key]) : [];
  const shown = new Set(NAMED.map(([key]) => key));
  const other = preview ? Object.entries(preview.rows).filter(([key]) => !shown.has(key)).reduce((n, [, v]) => n + v, 0) : 0;

  return (
    <>
      <button type="button" className="danger" aria-label={`Delete camera ${camera}`} onClick={() => void open()}>
        🗑 Delete camera…
      </button>
      {error && !preview && <span role="alert">{error}</span>}
      {preview && (
        <div role="alertdialog" aria-label={`Delete camera ${camera}`} className="camera-delete">
          <p>
            <strong>Delete camera {camera} and everything related to it?</strong> This cannot be undone.
          </p>
          <ul>
            <li>
              {preview.files} files on disk ({formatBytes(preview.bytes)}): the pictures and all exports
            </li>
            {named.map(([key, label]) => (
              <li key={key}>
                {preview.rows[key]} {label}
              </li>
            ))}
            {other > 0 && <li>{other} more database records (settings of all pages, caches, decisions, version details)</li>}
          </ul>
          <label>
            Type <code>{camera}</code> to confirm
            <input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Camera name to confirm" autoFocus />
          </label>
          {error && <p role="alert">{error}</p>}
          <button type="button" className="danger" disabled={typed !== camera || busy} onClick={() => void remove()}>
            Delete camera permanently
          </button>
          <button type="button" disabled={busy} onClick={() => setPreview(null)}>
            Keep it
          </button>
        </div>
      )}
    </>
  );
}
