import { FormEvent, useCallback, useEffect, useState } from "react";
import { usePublishFeature, useSharedFeature } from "../SharedFeature";
import { api, VersionInfo, VersionsResponse, VisionSnapshot } from "../api";
import ProjectVersions from "../ProjectVersions";
import VersionResults from "../VersionResults";

const fmt = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ");
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One-line summary of the vision settings frozen with a version. */
function visionSummary(v?: VisionSnapshot): string {
  if (!v) return "—";
  const parts: string[] = [];
  if (v.filter) parts.push(v.filter.name);
  if (v.mask?.enabled) parts.push(`mask ${v.mask.shape.shape}`);
  if (v.detector?.exemplars.length) parts.push(`detector ×${v.detector.exemplars.length}`);
  return parts.length ? parts.join(" · ") : "—";
}

/** One-line summary of the rule and movement ranges frozen with a version. */
function rulesSummary(stats: VersionInfo["stats"]): string {
  const parts: string[] = [];
  const edge = stats.rules?.edge_angle;
  if (edge) {
    const e = edge.settings.expected;
    parts.push(e ? `edge ${e.angle.toFixed(1)}°±${e.tolerance} ${e.polarity}` : "edge (measure only)");
  }
  for (const m of stats.rules?.measurement ?? []) {
    parts.push(m.nominal === null ? "measurement (no nominal)" : `measurement ${m.nominal}±${m.tolerance}: ${m.counts.pass} pass, ${m.counts.fail} fail`);
  }
  const aug = stats.augmentation;
  if (aug) {
    const r = aug.ranges;
    const span = (name: string, v: [number, number] | null, unit: string) => (v ? [`${name} ${v[0]}…${v[1]}${unit}`] : []);
    parts.push(...span("dx", r.dx, " px"), ...span("dy", r.dy, " px"), ...span("rot", r.rot, "°"));
  }
  return parts.length ? parts.join(" · ") : "—";
}

export default function VersionsView({ camera, product }: { camera: string; product?: string }) {
  const [features, setFeatures] = useState<{ feature: string; label: string }[]>([]);
  const [feature, setFeature] = useState("");
  const shared = useSharedFeature();
  usePublishFeature(feature, shared.publish);
  const [data, setData] = useState<VersionsResponse | null>(null);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [confirming, setConfirming] = useState<number | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!camera) return;
    setFeature("");
    api
      .versionFeatures(camera, product)
      .then((f) => {
        setFeatures(f);
        setFeature(shared.pick(f));
      })
      .catch((e: unknown) => setError(msg(e)));
  }, [camera, product]);

  const load = useCallback(() => {
    if (!camera || !feature) return;
    api
      .versions(camera, feature)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => setError(msg(e)));
  }, [camera, feature]);

  useEffect(() => {
    setData(null);
    setConfirming(null);
    setConfirmingDelete(null);
    setNotice(null);
    load();
  }, [load]);

  async function onFreeze(e: FormEvent) {
    e.preventDefault();
    try {
      const info = await api.freeze(camera, feature, name, notes);
      setNotice(
        `Froze v${info.number} — ` +
          (data?.classes ?? []).map((c) => `${c}: ${info.counts[c] ?? 0}`).join(", "),
      );
      setName("");
      setNotes("");
      load();
    } catch (err) {
      setError(msg(err));
    }
  }

  async function onRevert(v: VersionInfo) {
    try {
      const res = await api.revert(camera, feature, v.id);
      setNotice(`Reverted to v${v.number}: ${res.labels} labels, ${res.goldens} golden marks.`);
      setConfirming(null);
      load();
    } catch (err) {
      setError(msg(err));
    }
  }

  async function onDelete(v: VersionInfo) {
    try {
      await api.deleteVersion(camera, feature, v.id);
      setNotice(`Deleted v${v.number}.`);
      setConfirmingDelete(null);
      load();
    } catch (err) {
      setError(msg(err));
    }
  }

  if (!camera) return <p>Select a camera.</p>;
  const classes = data?.classes ?? [];

  return (
    <section>
      <h2>
        Versions — {camera}
        {product ? ` › ${product}` : ""}
      </h2>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <ProjectVersions camera={camera} />
      <h3>ROI versions</h3>
      <p style={{ fontSize: 13 }}>
        A ROI version freezes the labels and goldens of one ROI so you can go back to it (revert). Pictures are exported from the project versions above.
      </p>
      <label>
        Feature (ROI){" "}
        <select value={feature} onChange={(e) => setFeature(e.target.value)}>
          {features.map((f) => (
            <option key={f.feature} value={f.feature}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      {data && (
        <p>
          Current working state —{" "}
          {classes
            .map((c) => `${c}: ${data.counts[c] ?? 0} ⭐${data.counts[`golden_${c}`] ?? 0}`)
            .join(" · ")}{" "}
          · unlabeled: {data.counts.unlabeled ?? 0} of {data.counts.total ?? 0}
        </p>
      )}

      <form onSubmit={onFreeze}>
        <strong>Freeze the current state as a new version</strong>
        <div>
          <label>
            Version name{" "}
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. first-clean-batch" />
          </label>
        </div>
        <div>
          <label>
            Notes (optional){" "}
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>
        <button type="submit" disabled={!feature}>
          🔒 Freeze version
        </button>
      </form>

      {data && data.versions.length === 0 && (
        <p>No versions yet for this feature. Freeze one above once you've labeled some frames.</p>
      )}

      {data && data.versions.length > 0 && (
        <>
          <h3>
            History ({data.versions.filter((v) => v.deleted === null).length})
            {data.versions.some((v) => v.deleted !== null) &&
              ` · ${data.versions.filter((v) => v.deleted !== null).length} deleted`}
          </h3>
          <table>
            <thead>
              <tr>
                <th></th>
                <th>version</th>
                <th>name</th>
                <th>created</th>
                {classes.map((c) => (
                  <th key={c}>{c}</th>
                ))}
                {classes.map((c) => (
                  <th key={`g${c}`}>⭐{c}</th>
                ))}
                <th>unlabeled</th>
                <th>vision</th>
                <th>rules &amp; ranges</th>
                <th>change vs previous</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {[...data.versions].reverse().map((v) => (
                <tr key={v.id} className={v.deleted !== null ? "deleted-version" : undefined}>
                  <td>{v.deleted !== null ? "deleted" : v.active ? "▶ active" : ""}</td>
                  <td>v{v.number}</td>
                  <td>{v.name}</td>
                  <td>{fmt(v.created)}</td>
                  {classes.map((c) => (
                    <td key={c}>{v.counts[c] ?? 0}</td>
                  ))}
                  {classes.map((c) => (
                    <td key={`g${c}`}>{v.counts[`golden_${c}`] ?? 0}</td>
                  ))}
                  <td>{v.counts.unlabeled ?? 0}</td>
                  <td title={v.stats.vision ? JSON.stringify(v.stats.vision, null, 1) : undefined}>
                    {visionSummary(v.stats.vision)}
                  </td>
                  <td
                    title={
                      v.stats.rules || v.stats.augmentation ? JSON.stringify({ rules: v.stats.rules, augmentation: v.stats.augmentation }, null, 1) : undefined
                    }
                  >
                    {rulesSummary(v.stats)}
                  </td>
                  <td>{v.delta}</td>
                  <td>
                    {v.deleted === null && (
                      <>
                        <button disabled={v.active} onClick={() => setConfirming(v.id)}>
                          ⏪ Revert v{v.number}
                        </button>{" "}
                        <button disabled={v.active} onClick={() => setConfirmingDelete(v.id)}>
                          🗑 Delete v{v.number}
                        </button>
                      </>
                    )}
                    {v.deleted !== null && <span>deleted {fmt(v.deleted)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {data.versions
            .filter((v) => v.id === confirming)
            .map((v) => (
              <div key={v.id} role="alertdialog" aria-label="Confirm revert">
                <p>
                  Revert the working state to <strong>v{v.number}</strong>? Current labels and golden
                  marks will be replaced by that snapshot. Other saved versions remain available.
                </p>
                <button onClick={() => onRevert(v)}>✅ Yes, revert</button>{" "}
                <button onClick={() => setConfirming(null)}>Cancel</button>
              </div>
            ))}

          {data.versions
            .filter((v) => v.id === confirmingDelete)
            .map((v) => (
              <div key={v.id} role="alertdialog" aria-label="Confirm delete">
                <p>
                  Delete <strong>v{v.number}</strong> ({v.name})? The saved snapshot is removed for good, but the row
                  stays in the history greyed out, and the number is never reused. Your current labels and goldens
                  are not affected, and files already exported stay on disk.
                </p>
                <button onClick={() => onDelete(v)}>✅ Yes, delete</button>{" "}
                <button onClick={() => setConfirmingDelete(null)}>Cancel</button>
              </div>
            ))}

          <VersionResults
            camera={camera}
            feature={feature}
            versions={data.versions}
            names={data.result_names ?? []}
            onChanged={load}
            onNotice={setNotice}
            onError={setError}
          />
        </>
      )}
    </section>
  );
}
