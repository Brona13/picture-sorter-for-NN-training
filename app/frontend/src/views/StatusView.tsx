import { useEffect, useState } from "react";
import { api, CameraStatus, FeatureStatus } from "../api";

export function scopeOf(f: FeatureStatus): string {
  if (f.role === "classify") return "(defines products)";
  if (f.owner_product) return f.owner_product;
  if (f.shared_products?.length) return `🔗 ${f.shared_products.join(", ")}`;
  return "— all";
}

export function breakdown(classes: string[], counts: Record<string, number>): string {
  return classes.map((c) => `${c}: ${counts[c] ?? 0}`).join(" · ") || "—";
}

export default function StatusView({ camera }: { camera: string }) {
  const [status, setStatus] = useState<CameraStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!camera) return;
    let cancelled = false;
    setStatus(null);
    setError(null);
    api
      .status(camera)
      .then((s) => !cancelled && setStatus(s))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [camera]);

  if (!camera) return <p>Select a camera.</p>;
  if (error) return <p role="alert">{error}</p>;
  if (!status) return <p>Loading…</p>;

  return (
    <section>
      <h2>Status — {status.camera}</h2>
      <dl style={{ display: "flex", gap: 32 }}>
        <div>
          <dt>Frames</dt>
          <dd>{status.frame_count}</dd>
        </div>
        <div>
          <dt>Features (ROIs)</dt>
          <dd>{status.feature_count}</dd>
        </div>
        <div>
          <dt>Products</dt>
          <dd>{status.products.length || "—"}</dd>
        </div>
      </dl>
      <h3>Features (ROIs)</h3>
      {status.features.length === 0 ? (
        <p>
          No ROIs defined yet — use the <strong>ROI editor</strong> to add some.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>product</th>
              <th>feature</th>
              <th>role</th>
              <th>labeled</th>
              <th>⭐ goldens</th>
              <th>unlabeled</th>
              <th>of</th>
              <th>versions</th>
              <th>active</th>
            </tr>
          </thead>
          <tbody>
            {status.features.map((f) => (
              <tr key={f.feature}>
                <td>{scopeOf(f)}</td>
                <td>{f.short_name}</td>
                <td>{f.role}</td>
                <td>{breakdown(f.classes, f.labeled)}</td>
                <td>{breakdown(f.classes, f.goldens)}</td>
                <td>{f.unlabeled}</td>
                <td>{f.total}</td>
                <td>{f.version_count}</td>
                <td>{f.active_version !== null ? `v${f.active_version}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
