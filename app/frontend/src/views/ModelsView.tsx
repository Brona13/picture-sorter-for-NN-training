import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, ModelBuild, ModelClass, ModelDatasetInput, ModelDatasets, ModelDetail, ModelFreeze, ModelOverlap, ModelSummary } from "../api";

/** One camera's line in the editor: ticked or not, which freeze, and the names and colours (empty = the server's default). */
interface Row {
  on: boolean;
  version_id: number;
  folder_name: string;
  ok_name: string;
  ng_name: string;
  ok_color: string;
  ng_color: string;
}
interface Draft {
  name: string;
  include: boolean;
  rows: Record<string, Row>;
}

const DEFAULT_OK = "#06e52b";
const DEFAULT_NG = "#f44336";
const EMPTY: Draft = { name: "", include: false, rows: {} };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The datasets the draft would save, in camera order. */
export function payload(draft: Draft, order: string[]): ModelDatasetInput[] {
  return order
    .filter((c) => draft.rows[c]?.on)
    .map((camera) => {
      const r = draft.rows[camera];
      const out: ModelDatasetInput = { camera, version_id: r.version_id };
      if (r.folder_name.trim()) out.folder_name = r.folder_name.trim();
      if (r.ok_name.trim()) out.ok_name = r.ok_name.trim();
      if (r.ng_name.trim()) out.ng_name = r.ng_name.trim();
      if (r.ok_color && r.ok_color.toLowerCase() !== DEFAULT_OK) out.ok_color = r.ok_color;
      if (r.ng_color && r.ng_color.toLowerCase() !== DEFAULT_NG) out.ng_color = r.ng_color;
      return out;
    });
}

/** A saved model as a draft. A name equal to its default stays empty, so changing the folder name keeps following it. */
export function draftOf(m: ModelDetail): Draft {
  const rows: Record<string, Row> = {};
  for (const d of m.datasets) {
    rows[d.camera] = {
      on: true,
      version_id: d.version_id,
      folder_name: d.folder_name === d.camera ? "" : d.folder_name,
      ok_name: d.ok_name === `${d.folder_name}-OK` ? "" : d.ok_name,
      ng_name: d.ng_name === `${d.folder_name}-NG` ? "" : d.ng_name,
      ok_color: d.ok_color,
      ng_color: d.ng_color,
    };
  }
  return { name: m.name, include: m.include_without_box, rows };
}

const sizesText = (f: ModelFreeze) =>
  Object.entries(f.sizes)
    .map(([s, n]) => `${s} ×${n}`)
    .join(", ");

const when = (t: number) => new Date(t * 1000).toLocaleString();

export default function ModelsView() {
  const [catalog, setCatalog] = useState<ModelDatasets | null>(null);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [current, setCurrent] = useState<ModelDetail | null>(null); // the saved model being edited; null = a new one
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [size, setSize] = useState("");
  const [preview, setPreview] = useState<{ classes: ModelClass[]; notes: string[] } | null>(null);
  const [overlap, setOverlap] = useState<ModelOverlap | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [builtNow, setBuiltNow] = useState<ModelBuild | null>(null);

  const order = useMemo(() => (catalog?.cameras ?? []).map((c) => c.camera), [catalog]);
  const freezesOf = useCallback((camera: string) => catalog?.cameras.find((c) => c.camera === camera)?.freezes ?? [], [catalog]);

  const reload = useCallback(() => {
    api.models().then((r) => setModels(r.models)).catch((e: unknown) => setError(message(e)));
    api.modelDatasets().then(setCatalog).catch((e: unknown) => setError(message(e)));
  }, []);
  useEffect(reload, [reload]);

  const open = (id: number) => {
    setError(null);
    setBuiltNow(null);
    api
      .model(id)
      .then((m) => {
        setCurrent(m);
        setDraft(draftOf(m));
        setEditing(true);
      })
      .catch((e: unknown) => setError(message(e)));
  };
  const startNew = () => {
    setError(null);
    setBuiltNow(null);
    setCurrent(null);
    setDraft(EMPTY);
    setEditing(true);
  };

  const patch = (camera: string, change: Partial<Row>) =>
    setDraft((d) => ({ ...d, rows: { ...d.rows, [camera]: { ...d.rows[camera], ...change } } }));

  /** Ticking a camera pins its newest freeze of the chosen size. */
  const tick = (camera: string, on: boolean) => {
    const listed = freezesOf(camera).filter((f) => !size || f.size === size);
    setDraft((d) => {
      const old = d.rows[camera];
      if (!on) return old ? { ...d, rows: { ...d.rows, [camera]: { ...old, on } } } : d;
      const keep = old && listed.some((f) => f.id === old.version_id); // an earlier pick of another size is not kept
      const first = listed[0];
      if (!keep && !first) return d; // nothing of the chosen size to pin
      const row: Row = old ?? { on, version_id: first.id, folder_name: "", ok_name: "", ng_name: "", ok_color: DEFAULT_OK, ng_color: DEFAULT_NG };
      return { ...d, rows: { ...d.rows, [camera]: { ...row, version_id: keep ? row.version_id : first.id, on } } };
    });
  };

  const chosen = payload(draft, order);
  const chosenKey = JSON.stringify(chosen);
  // the class list follows what the user types
  useEffect(() => {
    if (!editing || chosen.length === 0) {
      setPreview(null);
      setPreviewError(null);
      setOverlap(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      // pictures in two datasets: only a freeze that can be read is checked, so a failure here just hides the line
      if (chosen.length > 1) {
        api
          .modelOverlap(chosen)
          .then((o) => !cancelled && setOverlap(o))
          .catch(() => !cancelled && setOverlap(null));
      } else setOverlap(null);
      api
        .modelPreview(chosen)
        .then((p) => {
          if (cancelled) return;
          setPreview(p);
          setPreviewError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(message(e));
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenKey, editing]);

  const saved = current ? JSON.stringify(payload(draftOf(current), order)) : "";
  const dirty = !current || chosenKey !== saved || draft.name.trim() !== current.name || draft.include !== current.include_without_box;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const m = current
        ? await api.updateModel(current.id, { name: draft.name, datasets: chosen, include_without_box: draft.include })
        : await api.createModel(draft.name, chosen, draft.include);
      setCurrent(m);
      setDraft(draftOf(m));
      reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : message(e));
    } finally {
      setBusy(false);
    }
  };

  const build = async () => {
    if (!current) return;
    setBusy(true);
    setError(null);
    setBuiltNow(null);
    try {
      const b = await api.buildModel(current.id);
      setBuiltNow(b);
      setCurrent(await api.model(current.id));
      reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const totals = chosen.reduce(
    (t, c) => {
      const f = freezesOf(c.camera).find((x) => x.id === c.version_id);
      return { ok: t.ok + (f?.ok ?? 0), ng: t.ng + (f?.ng ?? 0) };
    },
    { ok: 0, ng: 0 },
  );
  const sizeChoices = Object.keys(catalog?.sizes ?? {});

  return (
    <section className="models-view">
      <h2>Models</h2>
      <p className="muted">
        A model combines the frozen step-2 datasets of several cameras (one freeze per camera) into one DS dataset collection. Each build writes a new zip.
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="models-layout" style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap" }}>
        <aside aria-label="Saved models" style={{ minWidth: 200 }}>
          <button type="button" onClick={startNew}>
            New model
          </button>
          {models.length === 0 && <p className="muted">No model yet.</p>}
          <ul style={{ listStyle: "none", padding: 0 }}>
            {models.map((m) => (
              <li key={m.id}>
                <button type="button" className={current?.id === m.id ? "active" : ""} onClick={() => open(m.id)}>
                  {m.name}
                </button>
                <span className="muted">
                  {" "}
                  {m.dataset_count} datasets · {m.builds} builds
                </span>
              </li>
            ))}
          </ul>
        </aside>

        {editing && (
          <div className="models-editor" style={{ flex: "1 1 640px" }}>
            <label>
              Model name{" "}
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={80} />
            </label>{" "}
            <label>
              <input type="checkbox" checked={draft.include} onChange={(e) => setDraft({ ...draft, include: e.target.checked })} /> include pictures without a rectangle
            </label>
            <p>
              <label>
                Picture size{" "}
                <select value={size} onChange={(e) => setSize(e.target.value)}>
                  <option value="">All sizes</option>
                  {sizeChoices.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              {size && catalog && catalog.mixed > 0 && <span className="muted"> {catalog.mixed} freezes with mixed sizes are hidden.</span>}
            </p>

            <table>
              <thead>
                <tr>
                  <th>Use</th>
                  <th>Freeze</th>
                  <th>OK</th>
                  <th>NG</th>
                  <th>Dataset name</th>
                  <th>OK class</th>
                  <th>NG class</th>
                </tr>
              </thead>
              <tbody>
                {(catalog?.cameras ?? []).map(({ camera }) => {
                  const row = draft.rows[camera];
                  const all = freezesOf(camera);
                  const listed = all.filter((f) => !size || f.size === size || f.id === row?.version_id);
                  const f = all.find((x) => x.id === row?.version_id);
                  const state = current?.datasets.find((d) => d.camera === camera);
                  const folder = row?.folder_name.trim() || camera;
                  return (
                    <tr key={camera}>
                      <td>
                        <label>
                          <input type="checkbox" checked={!!row?.on} disabled={!row?.on && !all.some((x) => !size || x.size === size)} onChange={(e) => tick(camera, e.target.checked)} aria-label={`Use ${camera}`} /> {camera}
                        </label>
                      </td>
                      <td>
                        {row?.on ? (
                          <>
                            <select value={row.version_id} aria-label={`Freeze of ${camera}`} onChange={(e) => patch(camera, { version_id: Number(e.target.value) })}>
                              {listed.map((x) => (
                                <option key={x.id} value={x.id}>
                                  #{x.number} {x.name}
                                </option>
                              ))}
                            </select>
                            {f?.mixed && (
                              <div role="note" className="export-badge warn">
                                Mixed sizes: {sizesText(f)}
                              </div>
                            )}
                            {state?.newer && state.version_id === row.version_id && (
                              <div role="note">
                                Newer freeze #{state.newer.number} exists.{" "}
                                <button type="button" onClick={() => patch(camera, { version_id: state.newer!.id })}>
                                  Use it
                                </button>
                              </div>
                            )}
                            {state?.gone && state.version_id === row.version_id && <div role="alert">The pinned freeze was deleted: pick another.</div>}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>{row?.on ? (f?.ok ?? "—") : ""}</td>
                      <td>{row?.on ? (f?.ng ?? "—") : ""}</td>
                      <td>
                        {row?.on && <input value={row.folder_name} placeholder={camera} aria-label={`Dataset name of ${camera}`} onChange={(e) => patch(camera, { folder_name: e.target.value })} />}
                      </td>
                      <td>
                        {row?.on && (
                          <>
                            <input value={row.ok_name} placeholder={`${folder}-OK`} aria-label={`OK class of ${camera}`} onChange={(e) => patch(camera, { ok_name: e.target.value })} />
                            <input type="color" value={row.ok_color} aria-label={`OK colour of ${camera}`} onChange={(e) => patch(camera, { ok_color: e.target.value })} />
                          </>
                        )}
                      </td>
                      <td>
                        {row?.on && (
                          <>
                            <input value={row.ng_name} placeholder={`${folder}-NG`} aria-label={`NG class of ${camera}`} onChange={(e) => patch(camera, { ng_name: e.target.value })} />
                            <input type="color" value={row.ng_color} aria-label={`NG colour of ${camera}`} onChange={(e) => patch(camera, { ng_color: e.target.value })} />
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {catalog && catalog.cameras.length === 0 && <p className="muted">No camera has a step-2 freeze with rectangles yet.</p>}

            <p>
              Total: <strong>{totals.ok}</strong> OK · <strong>{totals.ng}</strong> NG
            </p>

            <h3>Classes of the collection</h3>
            {previewError && <p role="alert">{previewError}</p>}
            {preview && (
              <>
                <ul aria-label="Classes">
                  {preview.classes.map((c) => (
                    <li key={c.id}>
                      <span aria-hidden="true" style={{ display: "inline-block", width: 12, height: 12, background: c.color, marginRight: 6 }} />
                      {c.name} <span className="muted">({c.datasets.join(", ")})</span>
                    </li>
                  ))}
                </ul>
                {preview.notes.map((n) => (
                  <p key={n} role="note">
                    {n}
                  </p>
                ))}
              </>
            )}
            {!preview && !previewError && <p className="muted">Tick at least one dataset.</p>}

            {overlap && overlap.shared > 0 && (
              <div aria-label="Shared pictures">
                <h3>Shared pictures</h3>
                <ul>
                  {overlap.pairs.map((p) => (
                    <li key={`${p.a}|${p.b}`}>
                      {p.a} and {p.b} share {p.shared} pictures
                      {p.conflict > 0 && <strong className="export-badge warn"> {p.conflict} labelled OK in one and NG in the other</strong>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p>
              <button type="button" onClick={save} disabled={busy || !dirty || chosen.length === 0 || !draft.name.trim()}>
                {current ? "Save changes" : "Create model"}
              </button>{" "}
              <button type="button" onClick={build} disabled={busy || !current || dirty}>
                Build {current ? current.next_build.collection_name : ""}
              </button>
              {current && dirty && <span className="muted"> Save your changes before building.</span>}
            </p>
            {builtNow && (
              <p role="status">
                Built {builtNow.collection_name}: {builtNow.written} pictures, written to {builtNow.zip} in the data folder.
              </p>
            )}

            {current && current.build_list.length > 0 && (
              <>
                <h3>Builds</h3>
                <table aria-label="Builds">
                  <thead>
                    <tr>
                      <th>Collection</th>
                      <th>Pictures</th>
                      <th>Built</th>
                      <th>Zip</th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.build_list.map((b) => (
                      <tr key={b.id}>
                        <td>{b.collection_name}</td>
                        <td>{b.written}</td>
                        <td>{when(b.created)}</td>
                        <td>{b.exists ? <a href={api.modelZipUrl(current.id, b.number)}>Download</a> : <span className="muted">removed from the disk</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {current.changed && <p className="muted">This model changed since its last build.</p>}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
