import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, IngestedFrame, IngestResult } from "../api";
import { daysOf, inPeriod, Period, timeOf } from "../ingestDays";
import IngestTable from "./IngestTable";
import ValueGrid from "./ValueGrid";
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
  /** Opened from the Chain: the way back to it. */
  onBack?: () => void;
}

export default function IngestView({ camera, onBack }: Props) {
  const [frameCount, setFrameCount] = useState<number | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [folder, setFolder] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobKind, setJobKind] = useState<"ingest" | "rebuild">("ingest");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pictures, setPictures] = useState<IngestedFrame[] | null>(null);
  const [period, setPeriod] = useState<Period>("all");
  const [newestFirst, setNewestFirst] = useState(true);
  const [tableRevision, setTableRevision] = useState(0);
  const job = useJob<IngestResult & { tracked?: number }>(jobId);
  const running = jobId !== null && (job === null || job.status === "queued" || job.status === "running");

  const refreshCount = useCallback(() => {
    if (!camera) return;
    api
      .status(camera)
      .then((s) => setFrameCount(s.frame_count))
      .catch((e: unknown) => setError(msg(e)));
    api
      .ingestedFrames(camera)
      .then((r) => setPictures(r.frames))
      .catch((e: unknown) => setError(msg(e)));
  }, [camera]);

  useEffect(() => {
    setJobId(null);
    setNotice(null);
    setError(null);
    setPictures(null);
    setPeriod("all");
    refreshCount();
  }, [camera, refreshCount]);

  useEffect(() => {
    if (job?.status === "done") {
      refreshCount();
      setTableRevision((r) => r + 1);
    }
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

  const days = useMemo(() => daysOf(pictures ?? []), [pictures]);
  const shown = useMemo(() => {
    const rows = (pictures ?? []).filter((f) => inPeriod(f, period));
    return newestFirst ? rows : [...rows].reverse();
  }, [pictures, period, newestFirst]);

  if (!camera) return <p>Select a camera, or create one with “New camera” on the Overview page.</p>;

  const p = job?.progress ?? {};
  const phase = String(p.phase ?? "");
  const label = PHASE_LABELS[phase] ?? (phase ? phase.replace(/_/g, " ") : "Queued…");
  const done = Number(p.done ?? 0);
  const total = Number(p.total ?? 0);
  const latest = pictures && pictures.length ? timeOf(Math.max(...pictures.map((f) => f.created))) : null;

  return (
    <section className="ingest-page">
      <h2>Ingest — {camera}</h2>
      {onBack && (
        <p>
          <button type="button" onClick={onBack}>← Back to chain</button>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <p className="muted">
        Everything for bringing pictures in. Duplicates are detected by file <strong>content</strong> (not filename), so the same picture is never ingested twice. Source pictures are never changed.
      </p>
      <p>
        Frames in this camera: {frameCount ?? "…"}
        {latest && <span className="muted"> · last ingested {latest}</span>}
      </p>

      <h3>1 · Add pictures</h3>
      <div className="ingest-add">
        <form onSubmit={onUpload} className="ingest-box">
          <h4>Upload files</h4>
          <label>
            Drop or browse images{" "}
            <input type="file" multiple accept={ACCEPT} disabled={running} onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
          </label>
          <button type="submit" disabled={running}>
            ➕ Add frames
          </button>
        </form>
        <form onSubmit={onFolder} className="ingest-box">
          <h4>Import a folder</h4>
          <label>
            Folder path on this computer <input value={folder} onChange={(e) => setFolder(e.target.value)} />
          </label>
          <button type="submit" disabled={running}>
            Import folder
          </button>
        </form>
      </div>

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

      <h3>2 · Sizes and days: keep or remove</h3>
      <p className="muted">
        Pictures by size (rows) and by the day they came in (columns). Pick what you want to work on and keep only that, or remove what you do not.
        A removed picture is hidden in every module; its file, labels and goldens stay and you can bring it back here.
      </p>
      <IngestTable camera={camera} revision={tableRevision} onChanged={refreshCount} />

      <h3>3 · Ingested pictures</h3>
      {pictures === null ? (
        <p className="muted">Loading…</p>
      ) : pictures.length === 0 ? (
        <p>No pictures yet — add some above.</p>
      ) : (
        <>
          <div className="flow-nav">
            <label>
              Ingested{" "}
              <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
                <option value="all">All dates ({pictures.length})</option>
                <option value="today">Today</option>
                <option value="7d">Last 7 days</option>
                {days.map((d) => (
                  <option key={d.day} value={`day:${d.day}`}>
                    {d.day} ({d.count})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Order{" "}
              <select value={newestFirst ? "new" : "old"} onChange={(e) => setNewestFirst(e.target.value === "new")}>
                <option value="new">Newest first</option>
                <option value="old">Oldest first</option>
              </select>
            </label>
            <span className="muted">{shown.length} picture{shown.length === 1 ? "" : "s"}</span>
          </div>
          <ValueGrid
            camera={camera}
            rows={shown.map((f) => ({ frame: f.frame, value: null, name: f.name, created: f.created }))}
            info={(r) => (
              <span title={r.name && r.name !== r.frame ? `came in as ${r.name}` : undefined}>
                ingested <strong>{r.created ? timeOf(r.created) : "?"}</strong>
                {r.name && r.name !== r.frame && <span className="muted"> · was {r.name}</span>}
              </span>
            )}
          />
        </>
      )}

      <details>
        <summary>Maintenance</summary>
        <p>
          If you added or removed images outside this app, rebuild the SQLite frame catalog so
          content checks stay accurate. The dates of pictures already known are kept.
        </p>
        <button disabled={running} onClick={() => start("rebuild", () => api.rebuildCatalog(camera))}>
          Rebuild frame catalog from disk
        </button>
      </details>
    </section>
  );
}
