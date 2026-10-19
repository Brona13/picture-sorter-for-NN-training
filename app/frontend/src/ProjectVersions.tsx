import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, ExportReport, ProjectVersionsResponse } from "./api";
import CopyButton from "./CopyButton";
import VerdictBar from "./VerdictBar";
import VersionResults from "./VersionResults";

const fmt = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ");
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const PROJECT = "@project";

/**
 * Project versions: a frozen copy of the camera's verdicts (one OK / NG per picture). They are what gets
 * exported (OK and NG folders) and what downstream results are recorded against. The verdict is the decision
 * step; by default only the golden pictures are frozen ("Only goldens"). Pictures without a valid verdict at
 * freeze time (open, contradictions, stale) are never part of a version.
 */
export default function ProjectVersions({ camera }: { camera: string }) {
  const [data, setData] = useState<ProjectVersionsResponse | null>(null);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [goldensOnly, setGoldensOnly] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ExportReport | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const load = useCallback(() => {
    if (!camera) return;
    api
      .projectVersions(camera)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => setError(msg(e)));
  }, [camera]);

  useEffect(() => {
    setData(null);
    setNotice(null);
    setReport(null);
    setConfirmDelete(null);
    load();
  }, [load]);

  async function onFreeze(e: FormEvent) {
    e.preventDefault();
    try {
      const v = await api.freezeProject(camera, name, notes, goldensOnly);
      setNotice(`Froze project v${v.number} — OK ${v.counts.ok}, NG ${v.counts.ng}.`);
      setName("");
      setNotes("");
      setReport(null);
      load();
    } catch (err) {
      setError(msg(err));
    }
  }

  async function onExport(id: number) {
    try {
      setReport(await api.exportProjectVersion(camera, id));
    } catch (err) {
      setError(msg(err));
    }
  }

  async function onDelete(id: number, number: number) {
    try {
      await api.deleteVersion(camera, PROJECT, id);
      setNotice(`Deleted project v${number}.`);
      setConfirmDelete(null);
      load();
    } catch (err) {
      setError(msg(err));
    }
  }

  const s = data?.summary;
  const attention = s ? s.open + s.contradiction + s.stale : 0;
  const decided = s ? s.ok + s.ng : 0;
  const golden = (data?.golden_verdicts?.ok ?? 0) + (data?.golden_verdicts?.ng ?? 0);
  const freezable = goldensOnly ? golden : decided;
  return (
    <section aria-label="Project versions" style={{ marginBottom: 16 }}>
      <h3>Project versions (verdicts)</h3>
      <p style={{ fontSize: 13 }}>
        A project version freezes the OK / NG verdict of the pictures you export. The verdict decides the class; by default only the golden pictures are frozen
        and exported. Pictures without a verdict are always left out.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {s && <VerdictBar summary={s} />}
      {s && attention > 0 && (
        <p data-testid="freeze-warning" style={{ fontSize: 13 }}>
          ⚠️ {attention} picture(s) have no valid verdict ({s.open} open, {s.contradiction} contradictions, {s.stale} stale) and would not be part of a new version.
          Check the <strong>Verdict</strong> page.
        </p>
      )}
      <form onSubmit={onFreeze}>
        <label>
          Project version name <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. first-clean-batch" />
        </label>{" "}
        <label>
          Project notes (optional) <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>{" "}
        <label title="Freeze and export only pictures that are golden in at least one ROI. Untick to take every picture with a verdict.">
          <input type="checkbox" checked={goldensOnly} onChange={(e) => setGoldensOnly(e.target.checked)} /> Only goldens
        </label>{" "}
        <button type="submit" disabled={!s || freezable === 0}>
          🔒 Freeze verdicts
        </button>
        {s && freezable === 0 && (
          <span style={{ fontSize: 12 }}> {goldensOnly ? "No golden picture has a verdict yet." : "No picture has a verdict yet."}</span>
        )}
      </form>
      {s && goldensOnly && (
        <p data-testid="golden-info" style={{ fontSize: 13 }}>
          ⭐ {golden} golden picture(s) will be frozen (OK {data?.golden_verdicts?.ok ?? 0}, NG {data?.golden_verdicts?.ng ?? 0}).
          {decided > golden && <> {decided - golden} picture(s) with a verdict but no golden mark are left out.</>}
        </p>
      )}

      {data && data.versions.length > 0 && (
        <table aria-label="Project version history">
          <thead>
            <tr>
              <th></th>
              <th>version</th>
              <th>name</th>
              <th>created</th>
              <th>OK</th>
              <th>NG</th>
              <th>left out</th>
              <th>change vs previous</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {[...data.versions].reverse().map((v) => {
              const c = v.counts;
              const left = (c.contradiction ?? 0) + (c.stale ?? 0) + (c.open ?? 0) + (c.duplicates ?? 0) + (c.not_golden ?? 0);
              return (
                <tr key={v.id} className={v.deleted !== null ? "deleted-version" : undefined}>
                  <td>{v.deleted !== null ? "deleted" : v.active ? "▶ latest" : ""}</td>
                  <td>p{v.number}</td>
                  <td title={v.notes || undefined}>
                    {v.stats?.export?.goldens_only ? <span title="only goldens">⭐ </span> : null}
                    {v.name}
                  </td>
                  <td>{fmt(v.created)}</td>
                  <td>{c.ok ?? 0}</td>
                  <td>{c.ng ?? 0}</td>
                  <td title="open, contradictions, stale, duplicates and (only goldens) pictures without a golden mark, at freeze time">{left}</td>
                  <td>{v.delta}</td>
                  <td>
                    {v.deleted === null ? (
                      <>
                        <button onClick={() => onExport(v.id)}>📦 Export p{v.number}</button>{" "}
                        <button disabled={v.active} onClick={() => setConfirmDelete(v.id)}>
                          🗑 Delete p{v.number}
                        </button>
                      </>
                    ) : (
                      <span>deleted {fmt(v.deleted)}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {data?.versions
        .filter((v) => v.id === confirmDelete)
        .map((v) => (
          <div key={v.id} role="alertdialog" aria-label="Confirm delete project version">
            <p>
              Delete <strong>p{v.number}</strong> ({v.name})? Its snapshot is removed for good, the row stays greyed out and the number is not reused. Files already
              exported stay on disk.
            </p>
            <button onClick={() => onDelete(v.id, v.number)}>✅ Yes, delete</button> <button onClick={() => setConfirmDelete(null)}>Cancel</button>
          </div>
        ))}

      {report && (
        <div role="status">
          <p>
            Exported <strong>{report.written}</strong> pictures into OK / NG folders → <code>{report.destination}</code>{" "}
            <CopyButton text={report.destination} label="Copy path" />
          </p>
          {report.missing.length > 0 && (
            <p>
              {report.missing.length} frame(s) missing: {report.missing.slice(0, 5).join(", ")}
            </p>
          )}
          {report.hash_mismatch.length > 0 && (
            <p role="alert">
              {report.hash_mismatch.length} frame(s) changed since freeze: {report.hash_mismatch.slice(0, 5).join(", ")}
            </p>
          )}
        </div>
      )}

      {data && data.versions.length > 0 && (
        <VersionResults
          camera={camera}
          feature={PROJECT}
          versions={data.versions}
          names={data.result_names ?? []}
          onChanged={load}
          onNotice={setNotice}
          onError={setError}
        />
      )}
    </section>
  );
}
