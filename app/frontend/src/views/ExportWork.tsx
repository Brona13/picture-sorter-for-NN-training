import { useCallback, useEffect, useState } from "react";
import { api, ExportRef, ExportReport, ExportState, FlowExport, FlowNodeDetail } from "../api";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A line into an Export input in words. */
export const refText = (r: ExportRef): string =>
  "from" in r ? (r.from === "ingest" ? "Ingest" : r.from) : "feature" in r ? `${r.feature} · ${r.dot}` : `${r.box} · ${r.dot}`;

/**
 * The page of an Export box: what arrives at its OK and NG inputs, how many pictures would land in each folder, and the
 * two steps that follow — Freeze (a project version, the record of what was sent) and Export (the originals copied into
 * folders). The old Versions page stays until this one has proved itself.
 */
export default function ExportWork({ camera, nodeId, detail, setDetail, onError }: {
  camera: string;
  nodeId: string;
  detail: FlowExport;
  setDetail: (d: FlowNodeDetail) => void;
  onError: (e: string | null) => void;
}) {
  const [state, setState] = useState<ExportState | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ExportReport | null>(null);

  const load = useCallback(() => {
    api.flowExport(camera, nodeId).then(setState).catch((e) => onError(msg(e)));
  }, [camera, nodeId, onError]);
  useEffect(load, [load, detail]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    onError(null);
    try {
      await work();
    } catch (e) {
      onError(msg(e));
    }
    setBusy(false);
    load();
  };

  const update = (body: Record<string, unknown>) => run(async () => setDetail(await api.flowUpdate(camera, nodeId, body)));
  const freeze = () => run(async () => { setReport(null); await api.flowExportFreeze(camera, nodeId, name.trim()); setName(""); });
  const exportNow = () => run(async () => { if (state?.latest) setReport(await api.exportProjectVersion(camera, state.latest.id)); });

  const latest = state?.latest ?? null;
  const folders = Object.entries(state?.folders ?? {});
  return (
    <div className="export-work">
      <h3>Lines</h3>
      {(["ok", "ng"] as const).map((where) => (
        <div key={where} className="export-lines">
          <strong>{where.toUpperCase()}</strong>
          {detail.lines[where].length === 0 && <span className="muted"> nothing connected</span>}
          <ul>
            {detail.lines[where].map((ref, i) => (
              <li key={i}>
                {refText(ref)}{" "}
                <button type="button" disabled={busy} onClick={() => update({ remove_line: { input: where, ref } })} aria-label={`Remove ${where.toUpperCase()} line ${refText(ref)}`}>Remove</button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="muted">Several lines into one input are combined: a picture must come through all of them. Draw lines on the Chain.</p>
      <label>
        <input type="checkbox" checked={detail.goldens_only} disabled={busy} onChange={(e) => update({ goldens_only: e.target.checked })} /> Only goldens
      </label>

      <h3>What would be exported</h3>
      {state && state.total === 0 && <p className="muted">Nothing arrives yet: connect lines to the OK or NG input.</p>}
      {state && state.total > 0 && (
        <table>
          <thead><tr><th>Folder</th><th>Pictures</th></tr></thead>
          <tbody>{folders.map(([f, n]) => <tr key={f}><td>{f}</td><td>{n}</td></tr>)}</tbody>
        </table>
      )}
      {state && (
        <ul className="export-left-out">
          {state.both > 0 && <li>{state.both} left out: they reach both OK and NG.</li>}
          {state.goldens_only && state.not_golden > 0 && <li>{state.not_golden} left out: not golden.</li>}
          {state.uses_product && state.no_product > 0 && <li>{state.no_product} left out: no product.</li>}
        </ul>
      )}

      <h3>Freeze, then export</h3>
      <p>
        <input aria-label="Freeze name" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />{" "}
        <button type="button" disabled={busy || !state || state.total === 0} onClick={freeze}>Freeze</button>
      </p>
      {latest && (
        <div className="export-latest">
          <p>
            Frozen as version {latest.number}{latest.name ? ` “${latest.name}”` : ""}: {latest.counts.total ?? 0} pictures.
            {latest.exported ? ` Exported to ${latest.folder}.` : " Not exported yet."}
          </p>
          {latest.changed && <p role="status" className="export-changed">The Chain would now pick other pictures than this freeze holds. Freeze again to export the new selection.</p>}
          <button type="button" disabled={busy} onClick={exportNow}>Export version {latest.number}</button>
        </div>
      )}
      {report && (
        <p role="status">
          Wrote {report.written} pictures to {report.destination}.
          {report.missing.length > 0 && ` Missing: ${report.missing.length}.`}
          {report.hash_mismatch.length > 0 && ` Changed since the freeze: ${report.hash_mismatch.length}.`}
        </p>
      )}
    </div>
  );
}
