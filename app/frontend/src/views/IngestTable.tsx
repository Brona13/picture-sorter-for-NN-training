import { useCallback, useEffect, useMemo, useState } from "react";
import { api, IngestOverviewFrame } from "../api";
import { allKeys, buildMatrix, cellKey, columnKeys, effects, rowKeys, toggleGroup } from "../ingestTable";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Action = "remove" | "keep" | "back";

/**
 * Pictures by size (rows) and day they came in (columns). Cells, rows, columns or the whole table are picked, then the
 * pictures are removed, kept alone (every other picture is removed) or brought back. A removed picture is hidden in every
 * module, the bin included; its file, labels and goldens stay, so bringing it back is lossless.
 */
export default function IngestTable({ camera, revision, onChanged }: { camera: string; revision: number; onChanged: () => void }) {
  const [frames, setFrames] = useState<IngestOverviewFrame[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Action | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.ingestOverview(camera).then((r) => setFrames(r.frames)).catch((e: unknown) => setError(msg(e)));
  }, [camera]);
  useEffect(() => {
    setFrames(null);
    setSelected(new Set());
    setPending(null);
    setNotice(null);
    load();
  }, [camera, revision, load]);

  const matrix = useMemo(() => buildMatrix(frames ?? []), [frames]);
  const fx = useMemo(() => effects(matrix, selected), [matrix, selected]);

  if (frames === null) return <p className="muted">Loading…</p>;
  if (frames.length === 0) return <p className="muted">No pictures yet.</p>;

  const run = async () => {
    if (!pending) return;
    const action = pending;
    setPending(null);
    try {
      if (action === "remove") {
        const r = await api.ingestRemove(camera, fx.remove);
        setNotice(`Removed ${r.removed} picture(s).`);
      } else if (action === "keep") {
        const r = await api.ingestKeepOnly(camera, fx.keepOnlyKeep);
        setNotice(`Kept ${fx.keepOnlyKeep.length} picture(s), removed ${r.removed}.`);
      } else {
        const r = await api.ingestBringBack(camera, fx.bringBack);
        setNotice(`Brought back ${r.restored} picture(s).`);
      }
      setError(null);
      setSelected(new Set());
      load();
      onChanged();
    } catch (e) {
      setError(msg(e));
    }
  };

  const text: Record<Action, string> = {
    remove: `Remove ${fx.remove.length} picture(s)? Every module stops seeing them, the bin included. Files, labels and goldens stay; Bring back undoes it.`,
    keep: `Keep only ${fx.keepOnlyKeep.length} picture(s) and remove the other ${fx.keepOnlyRemove.length}? Files, labels and goldens stay; Bring back undoes it.`,
    back: `Bring back ${fx.bringBack.length} removed picture(s)?`,
  };
  const picked = selected.size > 0;

  return (
    <div className="ingest-table" data-testid="ingest-table">
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>
                <button type="button" aria-label="Pick everything" onClick={() => setSelected((s) => toggleGroup(s, allKeys(matrix)))}>
                  All
                </button>
              </th>
              {matrix.days.map((d) => (
                <th key={d}>
                  <button type="button" aria-label={`Pick day ${d}`} onClick={() => setSelected((s) => toggleGroup(s, columnKeys(matrix, d)))}>
                    {d}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.sizes.map((size) => (
              <tr key={size}>
                <th scope="row">
                  <button type="button" aria-label={`Pick size ${size}`} onClick={() => setSelected((s) => toggleGroup(s, rowKeys(matrix, size)))}>
                    {size}
                  </button>
                </th>
                {matrix.days.map((d) => {
                  const key = cellKey(size, d);
                  const cell = matrix.cells.get(key);
                  if (!cell) return <td key={d} className="muted">·</td>;
                  const on = selected.has(key);
                  return (
                    <td key={d}>
                      <button
                        type="button"
                        aria-pressed={on}
                        aria-label={`${size} on ${d}: ${cell.active.length} in use${cell.removed.length ? `, ${cell.removed.length} removed` : ""}`}
                        className={on ? "ingest-cell picked" : "ingest-cell"}
                        onClick={() => setSelected((s) => toggleGroup(s, [key]))}
                      >
                        {cell.active.length}
                        {cell.removed.length > 0 && <span className="muted"> +{cell.removed.length} removed</span>}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flow-nav" style={{ marginTop: 8 }}>
        <span className="muted">{picked ? `${selected.size} cell(s) picked` : "Pick cells, a size row or a day column."}</span>
        <button type="button" disabled={!picked || fx.remove.length === 0} onClick={() => setPending("remove")}>
          Remove picked
        </button>
        <button type="button" disabled={!picked || fx.keepOnlyKeep.length === 0 || fx.keepOnlyRemove.length === 0} onClick={() => setPending("keep")}>
          Keep only picked
        </button>
        <button type="button" disabled={!picked || fx.bringBack.length === 0} onClick={() => setPending("back")}>
          Bring back picked
        </button>
        {picked && <button type="button" onClick={() => setSelected(new Set())}>Clear</button>}
      </div>
      {pending && (
        <div className="chain-delete" role="alertdialog" aria-label="Confirm">
          <p>{text[pending]}</p>
          <div className="line-confirm-buttons">
            <button type="button" className={pending === "back" ? undefined : "danger"} onClick={() => void run()}>
              {pending === "remove" ? "Remove" : pending === "keep" ? "Keep only these" : "Bring back"}
            </button>
            <button type="button" onClick={() => setPending(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
