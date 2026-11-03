import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, DsExportFields, DsExportReport, ExportLatest, ExportReport, ExportState, FlowExport, FlowNodeDetail } from "../api";
import CopyButton from "../CopyButton";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The time of a freeze: epoch seconds as "2026-10-30 09:41", or whatever text the server sent. */
export const when = (created: number | string): string =>
  typeof created === "number" ? new Date(created * 1000).toISOString().slice(0, 16).replace("T", " ") : created;

/**
 * The page of an Export box, in two cards: what the Chain would send now (one table: a row per folder, the pictures
 * left out and why, the total), then the two steps that follow — Freeze (a project version, the record of what was
 * sent) and Export (the originals copied into folders) — with a table of every freeze of this box. The lines into the
 * OK and NG inputs are not repeated here: they are drawn on the Chain. The old Versions page stays until this one has
 * proved itself.
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
  const [ds, setDs] = useState<DsExportFields>({
    dataset_name: camera, folder_name: camera, ok_name: "OK", ng_name: "NG", ok_color: "#06e52b", ng_color: "#f44336", include_without_box: false, zip_name: "",
  });
  const [dsVersion, setDsVersion] = useState<number | null>(null);
  const [dsReport, setDsReport] = useState<DsExportReport | null>(null);
  const setField = (key: keyof DsExportFields, value: string | boolean) => setDs((d) => ({ ...d, [key]: value }));

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
  const freeze = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => { setReport(null); await api.flowExportFreeze(camera, nodeId, name.trim()); setName(""); });
  };
  const exportNow = (id: number) => run(async () => setReport(await api.exportProjectVersion(camera, id)));

  const makeDs = (id: number) => run(async () => { setDsReport(null); setDsReport(await api.exportProjectVersionDs(camera, id, ds)); });

  const folders = Object.entries(state?.folders ?? {});
  const leftOut: [string, number][] = state
    ? [
        ["Left out: they reach both OK and NG", state.both],
        ["Left out: not golden", state.goldens_only ? state.not_golden : 0],
        ["Left out: no product", state.uses_product ? state.no_product : 0],
      ]
    : [];
  const shownLeftOut = leftOut.filter(([, n]) => n > 0);
  const frozen: ExportLatest[] = state?.versions ?? (state?.latest ? [state.latest] : []);
  const withRectangles = frozen.filter((v) => (v.counts.with_box ?? 0) > 0);
  const dsChosen = withRectangles.find((v) => v.id === dsVersion) ?? withRectangles[0];

  return (
    <div className="export-work">
      <section className="export-card" aria-label="What would be exported">
        <div className="export-card-head">
          <h3>1 · What would be exported</h3>
          {(detail.step ?? 1) === 2 ? (
            <label>
              <input type="checkbox" checked={detail.goldens_only} disabled={busy} onChange={(e) => update({ goldens_only: e.target.checked })} /> Only goldens
            </label>
          ) : (
            <span className="muted" title="Freeze closes step 1: it takes every OK and NG picture. Goldens are chosen in step 2.">Freeze: every OK and NG picture</span>
          )}
        </div>
        {state && state.total === 0 && <p className="muted">Nothing arrives yet: connect lines to the OK or NG input on the Chain.</p>}
        {(detail.step ?? 1) === 2 && state && (
          <div data-testid="export-box">
            {state.box ? (
              <>
                <p>
                  Rectangles from <strong>{state.box}</strong>: {state.with_box ?? 0} of {state.total} pictures have one
                  {state.no_box ? `; ${state.no_box} will be exported without numbers` : ""}. They are frozen with the version and written to <code>boxes.csv</code> next to the folders.
                </p>
                <label>
                  Layout of the numbers{" "}
                  <select aria-label="Layout of the numbers" value={state.box_format ?? detail.box_format ?? "corners"} disabled={busy} onChange={(e) => update({ box_format: e.target.value })}>
                    <option value="corners">x1, y1, x2, y2 (two corners)</option>
                    <option value="size">x, y, width, height (corner and size)</option>
                  </select>
                </label>
              </>
            ) : (
              <p className="muted">No Box on these lines: the pictures go out without numbers. Feed the inputs from a Classifier that reads a Box to get a <code>boxes.csv</code>.</p>
            )}
          </div>
        )}
        {state && (folders.length > 0 || shownLeftOut.length > 0) && (
          <div className="export-scroll">
            <table>
              <thead><tr><th>Folder</th><th className="num">Pictures</th></tr></thead>
              <tbody>
                {folders.map(([f, n]) => <tr key={f}><td>{f}</td><td className="num">{n}</td></tr>)}
                {shownLeftOut.map(([label, n]) => <tr key={label} className="export-leftout"><td>{label}</td><td className="num">{n}</td></tr>)}
                {state.total > 0 && <tr className="export-total"><td>Total to export</td><td className="num">{state.total}</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="export-card" aria-label="Freeze and export">
        <div className="export-card-head">
          <h3>2 · Freeze, then export</h3>
        </div>
        <form className="export-freeze" onSubmit={freeze}>
          <input aria-label="Freeze name" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit" disabled={busy || !state || state.total === 0}>Freeze</button>
        </form>
        {state && frozen.length === 0 && <p className="muted">Nothing frozen yet. A freeze records which pictures the Chain picks now; the export copies exactly those.</p>}
        {frozen.length > 0 && (
          <div className="export-scroll">
            <table className="export-versions" aria-label="Frozen versions">
              <thead>
                <tr><th>Version</th><th>Name</th><th>Created</th><th className="num">OK</th><th className="num">NG</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {frozen.map((v, i) => (
                  <tr key={v.id}>
                    <td>v{v.number}</td>
                    <td>{v.name || <span className="muted">—</span>}</td>
                    <td>{when(v.created)}</td>
                    <td className="num">{v.counts.ok ?? 0}</td>
                    <td className="num">{v.counts.ng ?? 0}</td>
                    <td>
                      {v.exported ? <span className="export-badge done">Exported</span> : <span className="export-badge">Not exported</span>}
                      {i === 0 && v.changed && (
                        <span className="export-badge warn" title="The Chain would now pick other pictures than this freeze holds. Freeze again to export the new selection.">Chain changed</span>
                      )}
                      <span className="export-folder">{v.folder}</span>
                    </td>
                    <td>
                      <button type="button" disabled={busy} aria-label={`Export version ${v.number}`} onClick={() => exportNow(v.id)}>
                        {v.exported ? "Export again" : "Export"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {report && (
          <div role="status">
            <p>
              Wrote {report.written} pictures to <code>{report.destination}</code> <CopyButton text={report.destination} label="Copy path" />
            </p>
            {report.boxes !== undefined && (
              <p>
                Listed {report.boxes} rectangle{report.boxes === 1 ? "" : "s"} in <code>boxes.csv</code>
                {report.no_box ? `; ${report.no_box} picture${report.no_box === 1 ? " has" : "s have"} none` : ""}.
              </p>
            )}
            {report.missing.length > 0 && <p>Missing: {report.missing.length}.</p>}
            {report.hash_mismatch.length > 0 && <p>Changed since the freeze: {report.hash_mismatch.length}.</p>}
          </div>
        )}
      </section>

      {(detail.step ?? 1) === 2 && state?.box && (
        <section className="export-card" aria-label="DS import file">
          <div className="export-card-head">
            <h3>3 · File for the downstream system</h3>
          </div>
          {withRectangles.length === 0 ? (
            <p className="muted">Freeze first: the file is made from a freeze that holds rectangles.</p>
          ) : (
            <form className="export-ds" onSubmit={(e) => { e.preventDefault(); if (dsChosen) void makeDs(dsChosen.id); }}>
              <label>Freeze{" "}
                <select aria-label="Freeze for the DS file" value={dsChosen?.id} onChange={(e) => setDsVersion(Number(e.target.value))}>
                  {withRectangles.map((v) => <option key={v.id} value={v.id}>v{v.number}{v.name ? ` · ${v.name}` : ""}</option>)}
                </select>
              </label>
              <label>Dataset name <input aria-label="Dataset name" value={ds.dataset_name} onChange={(e) => setField("dataset_name", e.target.value)} /></label>
              <label>Picture folder name <input aria-label="Picture folder name" value={ds.folder_name} onChange={(e) => setField("folder_name", e.target.value)} /></label>
              <label>OK class <input aria-label="OK class name" value={ds.ok_name} onChange={(e) => setField("ok_name", e.target.value)} />{" "}
                <input type="color" aria-label="OK colour" value={ds.ok_color} onChange={(e) => setField("ok_color", e.target.value)} /></label>
              <label>NG class <input aria-label="NG class name" value={ds.ng_name} onChange={(e) => setField("ng_name", e.target.value)} />{" "}
                <input type="color" aria-label="NG colour" value={ds.ng_color} onChange={(e) => setField("ng_color", e.target.value)} /></label>
              <label><input type="checkbox" checked={ds.include_without_box} onChange={(e) => setField("include_without_box", e.target.checked)} /> Include pictures without a rectangle</label>
              <label>Zip file name <input aria-label="Zip file name" placeholder="dataset name + version" value={ds.zip_name} onChange={(e) => setField("zip_name", e.target.value)} /></label>
              <button type="submit" disabled={busy || !dsChosen}>Make DS zip</button>
            </form>
          )}
          {dsReport && (
            <div role="status" aria-label="DS zip result">
              <p>
                Wrote {dsReport.written} picture{dsReport.written === 1 ? "" : "s"} to <code>{dsReport.destination}</code> <CopyButton text={dsReport.destination} label="Copy path" />
              </p>
              {dsReport.left_out > 0 && <p>{dsReport.left_out} left out: no rectangle.</p>}
              {dsReport.no_box > 0 && <p>{dsReport.no_box} written with an empty box list.</p>}
              {dsReport.missing.length > 0 && <p>Missing: {dsReport.missing.length}.</p>}
              {dsReport.hash_mismatch.length > 0 && <p>Changed since the freeze: {dsReport.hash_mismatch.length}.</p>}
              {dsReport.name_clash.length > 0 && <p>Left out, same name as another picture: {dsReport.name_clash.length}.</p>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
