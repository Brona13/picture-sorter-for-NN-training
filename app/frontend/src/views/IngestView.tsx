import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, IngestResult } from "../api";
import { useJob } from "../useJob";

const PHASE_LABELS: Record<string, string> = {
  scanning: "Scanning folder for images…",
  hashing: "Hashing and staging for exact duplicate detection…",
  copying: "Committing a new frame…",
  duplicate: "Duplicate found; skipping…",
  error: "An item failed; continuing…",
  persistence: "Committing the SQLite frame catalog…",
};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ACCEPT = ".jpg,.jpeg,.png,.bmp,.tif,.tiff,.webp";

interface Props {
  camera: string;
}

export default function IngestView({ camera }: Props) {
  const [frameCount, setFrameCount] = useState<number | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [folder, setFolder] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobKind, setJobKind] = useState<"ingest" | "rebuild">("ingest");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = useJob<IngestResult & { tracked?: number }>(jobId);
  const running = jobId !== null && (job === null || job.status === "queued" || job.status === "running");

  const refreshCount = useCallback(() => {
    if (!camera) return;
    api
      .status(camera)
      .then((s) => setFrameCount(s.frame_count))
      .catch((e: unknown) => setError(msg(e)));
  }, [camera]);

  useEffect(() => {
    setJobId(null);
    setNotice(null);
    setError(null);
    refreshCount();
  }, [camera, refreshCount]);

  useEffect(() => {
    if (job?.status === "done") refreshCount();
  }, [job?.status, refreshCount]);

  async function start(kind: "ingest" | "rebuild", launch: () => Promise<{ id: string }>) {
    setError(null);
    setNotice(null);
    try {
      const started = await launch();
      setJobKind(kind);
      setJobId(started.id);
    } catch (e) {
      setError(msg(e));
    }
  }

  function onUpload(e: FormEvent) {
    e.preventDefault();
    if (files.length === 0) return setNotice("No files selected.");
    start("ingest", () => api.uploadFrames(camera, files));
    setFiles([]);
    (e.target as HTMLFormElement).reset();
  }

  function onFolder(e: FormEvent) {
    e.preventDefault();
    if (!folder.trim()) return setNotice("Enter a folder path.");
    start("ingest", () => api.importFolder(camera, folder.trim()));
  }

  if (!camera) return <p>Select a camera, or create one with “New camera” on the Overview page.</p>;

  const p = job?.progress ?? {};
  const phase = String(p.phase ?? "");
  const label = PHASE_LABELS[phase] ?? (phase ? phase.replace(/_/g, " ") : "Queued…");
  const done = Number(p.done ?? 0);
  const total = Number(p.total ?? 0);

  return (
    <section>
      <h2>Ingest — {camera}</h2>
      <p>
        Add images to this camera. Duplicates are detected by file <strong>content</strong> (not
        filename), so the same picture is never ingested twice.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <p>Frames in this camera: {frameCount ?? "…"}</p>
      {frameCount === 0 && <p>No pictures yet — add some below.</p>}

      <form onSubmit={onUpload}>
        <label>
          Drop or browse images{" "}
          <input
            type="file"
            multiple
            accept={ACCEPT}
            disabled={running}
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
        </label>{" "}
        <button type="submit" disabled={running}>
          ➕ Add frames
        </button>
      </form>

      <details>
        <summary>…or import from a folder path on this computer</summary>
        <form onSubmit={onFolder}>
          <label>
            Folder path <input value={folder} onChange={(e) => setFolder(e.target.value)} />
          </label>{" "}
          <button type="submit" disabled={running}>
            Import folder
          </button>
        </form>
      </details>

      {jobId && (
        <div aria-live="polite">
          {running && (
            <p>
              <progress value={done} max={total || undefined} /> {label}
              {p.detail ? ` · ${String(p.detail)}` : ""}
              {Number(p.added) || Number(p.skipped) || Number(p.errors)
                ? ` · added ${Number(p.added)}, duplicates ${Number(p.skipped)}, errors ${Number(p.errors)}`
                : ""}
            </p>
          )}
          {job?.status === "error" && <p role="alert">{job.error}</p>}
          {job?.status === "done" && jobKind === "ingest" && job.result && (
            <div>
              <p role="status">
                Added <strong>{job.result.added}</strong> frame(s)
                {job.result.skipped.length > 0 &&
                  ` · skipped ${job.result.skipped.length} duplicate(s)`}
              </p>
              {job.result.skipped.length > 0 && (
                <details>
                  <summary>{job.result.skipped.length} skipped as duplicates</summary>
                  <ul>
                    {job.result.skipped.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </details>
              )}
              {job.result.errors.length > 0 && (
                <div role="alert">
                  Errors:
                  <ul>
                    {job.result.errors.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {job?.status === "done" && jobKind === "rebuild" && (
            <p role="status">Rebuilt catalog: {job.result?.tracked} unique image(s) tracked.</p>
          )}
        </div>
      )}

      <details>
        <summary>Maintenance</summary>
        <p>
          If you added or removed images outside this app, rebuild the SQLite frame catalog so
          content checks stay accurate.
        </p>
        <button disabled={running} onClick={() => start("rebuild", () => api.rebuildCatalog(camera))}>
          Rebuild frame catalog from disk
        </button>
      </details>
    </section>
  );
}
