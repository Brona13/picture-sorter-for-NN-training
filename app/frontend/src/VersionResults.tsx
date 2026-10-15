import { FormEvent, useEffect, useMemo, useState } from "react";
import { api, VersionInfo, VersionResult } from "./api";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in the local time zone
const fmtValue = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6))));

/**
 * Values measured by the training / inspection system on a dataset exported from a version, recorded here
 * so curation choices can be traced to their outcome. This app never computes them: the metric name is
 * free text (suggestions come from what was recorded before) and the value is a number.
 */
export default function VersionResults({
  camera,
  feature,
  versions,
  names,
  onChanged,
  onNotice,
  onError,
}: {
  camera: string;
  feature: string;
  versions: VersionInfo[];
  names: string[];
  onChanged: () => void;
  onNotice: (m: string) => void;
  onError: (m: string) => void;
}) {
  const initial = useMemo(() => (versions.find((v) => v.active) ?? versions[versions.length - 1])?.id ?? null, [versions]);
  const [versionId, setVersionId] = useState<number | null>(initial);
  const [editing, setEditing] = useState<VersionResult | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [measured, setMeasured] = useState(today());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (versionId === null || !versions.some((v) => v.id === versionId)) setVersionId(initial);
  }, [versions, initial, versionId]);

  const chosen = versions.find((v) => v.id === versionId) ?? null;
  const rows = chosen?.results ?? [];
  const shown = versions.filter((v) => (v.results ?? []).length > 0);
  const metrics = [...new Set(shown.flatMap((v) => (v.results ?? []).map((r) => r.name)))].sort((a, b) => a.localeCompare(b));

  function reset() {
    setEditing(null);
    setName("");
    setValue("");
    setNote("");
    setMeasured(today());
  }

  function edit(r: VersionResult) {
    setEditing(r);
    setVersionId(r.version_id);
    setName(r.name);
    setValue(String(r.value));
    setNote(r.note);
    setMeasured(r.measured);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (chosen === null) return;
    const number = Number(value);
    if (value.trim() === "" || !Number.isFinite(number)) return onError("The value must be a number.");
    setBusy(true);
    try {
      const input = { name, value: number, note, measured };
      if (editing) await api.updateVersionResult(camera, feature, editing.version_id, editing.id, input);
      else await api.addVersionResult(camera, feature, chosen.id, input);
      onNotice(editing ? "Result updated." : `Recorded ${name.trim()} for v${chosen.number}.`);
      reset();
      onChanged();
    } catch (err) {
      onError(msg(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: VersionResult) {
    try {
      await api.deleteVersionResult(camera, feature, r.version_id, r.id);
      onNotice("Result deleted.");
      if (editing?.id === r.id) reset();
      onChanged();
    } catch (err) {
      onError(msg(err));
    }
  }

  return (
    <section aria-label="Downstream results" data-testid="version-results">
      <h3>Downstream results</h3>
      <p style={{ fontSize: 13 }}>
        Quality values the training or inspection system reported for a dataset exported from a version (for example accuracy, or recall of NG). This tool does not
        compute them; record them here to see which version produced which result.
      </p>

      {metrics.length > 0 && (
        <table data-testid="results-matrix">
          <caption style={{ textAlign: "left", fontSize: 12 }}>Latest value per version (hover for the date and note)</caption>
          <thead>
            <tr>
              <th>metric</th>
              {shown.map((v) => (
                <th key={v.id} className={v.deleted !== null ? "deleted-version" : undefined}>
                  v{v.number}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m}>
                <td>{m}</td>
                {shown.map((v) => {
                  const all = (v.results ?? []).filter((r) => r.name === m);
                  const latest = all[0]; // newest measurement first
                  return (
                    <td key={v.id} title={latest ? `${latest.measured}${latest.note ? ` · ${latest.note}` : ""}${all.length > 1 ? ` · ${all.length} values recorded` : ""}` : undefined}>
                      {latest ? fmtValue(latest.value) : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form onSubmit={submit} style={{ marginTop: 12 }}>
        <strong>{editing ? `Edit a result of v${versions.find((v) => v.id === editing.version_id)?.number ?? ""}` : "Record a result"}</strong>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end", margin: "6px 0" }}>
          <label>
            Version{" "}
            <select aria-label="Version" value={versionId ?? ""} disabled={editing !== null} onChange={(e) => setVersionId(Number(e.target.value))}>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.number} {v.name}
                  {v.deleted !== null ? " (deleted)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Metric{" "}
            <input aria-label="Metric" list="result-names" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. accuracy" maxLength={80} required />
            <datalist id="result-names">
              {names.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </label>
          <label>
            Value{" "}
            <input aria-label="Value" type="number" step="any" value={value} onChange={(e) => setValue(e.target.value)} required style={{ width: 110 }} />
          </label>
          <label>
            Measured on{" "}
            <input aria-label="Measured on" type="date" value={measured} onChange={(e) => setMeasured(e.target.value)} required />
          </label>
          <label>
            Note{" "}
            <input aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional, e.g. training run 3" maxLength={500} style={{ width: 240 }} />
          </label>
          <button type="submit" disabled={busy || chosen === null}>
            {editing ? "Update" : "Record"}
          </button>
          {editing && (
            <button type="button" onClick={reset}>
              Cancel
            </button>
          )}
        </div>
      </form>

      {chosen && (
        <>
          <h4 style={{ marginBottom: 4 }}>
            Recorded for v{chosen.number} {chosen.name}
          </h4>
          {rows.length === 0 ? (
            <p style={{ fontSize: 13 }}>Nothing recorded for this version yet.</p>
          ) : (
            <table data-testid="results-list">
              <thead>
                <tr>
                  <th>metric</th>
                  <th>value</th>
                  <th>measured</th>
                  <th>note</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td>{fmtValue(r.value)}</td>
                    <td>{r.measured}</td>
                    <td>{r.note}</td>
                    <td>
                      <button aria-label={`Edit ${r.name} ${r.measured}`} onClick={() => edit(r)}>
                        ✏️
                      </button>{" "}
                      <button aria-label={`Delete ${r.name} ${r.measured}`} onClick={() => remove(r)}>
                        🗑
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
