import { useEffect, useState } from "react";
import { api, StartGoldensResponse, StartMethod } from "../api";
import { classColor } from "./colors";
import { thumbUrl } from "./Card";

const METHODS: { id: StartMethod; label: string; hint: string }[] = [
  { id: "facility", label: "Best coverage (recommended)", hint: "Each pick is the picture that makes the whole class closest to a golden. The first pick is the medoid." },
  { id: "medoid", label: "Most central", hint: "The picture closest to all the others, then the next most central." },
  { id: "density", label: "Density peaks", hint: "The peaks of the crowd, one per look, the main crowd first." },
  { id: "cluster", label: "One per cluster", hint: "Cluster the class and take the middle picture of each cluster; tiny clusters are ignored. The count is the number of clusters." },
  { id: "farthest", label: "Spread out", hint: "Always the picture farthest from the picks so far, among the pictures that are not outliers." },
  { id: "boundary", label: "Near the other class", hint: "Pictures nearest the other class. They are also the likeliest mislabels: check the label before making one golden." },
];

interface Props {
  camera: string;
  feature: string;
  classes: string[];
  revision: number;
  onPromoted: (frame: string, cls: string, counts: Record<string, number>) => void;
  onError: (m: string) => void;
}

/** A small line of the share of the class covered after 1, 2, ... goldens; the marker is the suggested count. */
function CoverageCurve({ curve, suggested, radius }: { curve: number[]; suggested: number; radius: number }) {
  if (curve.length < 1) return null;
  const w = 200;
  const h = 48;
  const x = (i: number) => (curve.length === 1 ? w / 2 : (i / (curve.length - 1)) * (w - 8) + 4);
  const y = (v: number) => h - 4 - v * (h - 8);
  const pts = curve.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  return (
    <svg role="img" aria-label="Coverage curve" data-testid="coverage-curve" width="100%" viewBox={`0 0 ${w} ${h}`}>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.5} />
      {suggested > 0 && <circle cx={x(suggested - 1)} cy={y(curve[suggested - 1])} r={3.5} fill="currentColor" />}
      <title>{`Share of the class within the closest ${Math.round(radius * 100)}% of all pairs of a golden, after 1 to ${curve.length} goldens`}</title>
    </svg>
  );
}

/**
 * Start goldens for a step-2 Classifier: the labels come from the freeze, so only the first goldens are open. One class at a time
 * (OK and NG separately, on the class's own Box rectangles), a method, and a count; the human promotes. Nothing is promoted by itself.
 */
export default function StartGoldensPanel({ camera, feature, classes, revision, onPromoted, onError }: Props) {
  const [cls, setCls] = useState(classes[0] ?? "");
  const [method, setMethod] = useState<StartMethod>("facility");
  const [count, setCount] = useState<Record<string, number>>({});
  const [data, setData] = useState<StartGoldensResponse | null>(null);
  const [touched, setTouched] = useState(false);
  const active = classes.includes(cls) ? cls : (classes[0] ?? "");
  const n = count[active] ?? 3;

  // The suggested count is the default until the person moves the slider of that class.
  useEffect(() => {
    let cancelled = false;
    setData(null);
    api
      .startGoldens(camera, feature, active, method, n)
      .then((d) => !cancelled && setData(d))
      .catch((e: unknown) => !cancelled && onError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, feature, active, method, n, revision]);

  const hint = METHODS.find((m) => m.id === method)?.hint;
  const setN = (v: number) => {
    setTouched(true);
    setCount({ ...count, [active]: v });
  };

  return (
    <div data-testid="start-goldens">
      <div role="tablist" aria-label="Class" style={{ display: "flex", gap: 4, marginBottom: 6 }}>
        {classes.map((c) => (
          <button key={c} role="tab" aria-selected={c === active} style={{ borderColor: classColor(c, classes), fontWeight: c === active ? 700 : 400 }} onClick={() => setCls(c)}>
            {c}
          </button>
        ))}
      </div>
      <label>
        Method{" "}
        <select aria-label="Method" value={method} onChange={(e) => setMethod(e.target.value as StartMethod)}>
          {METHODS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      {hint && <p className="muted">{hint}</p>}
      <label>
        {method === "cluster" ? "Clusters" : "Goldens"}{" "}
        <input type="range" aria-label="How many goldens" min={1} max={data?.n_max ?? 20} value={n} onChange={(e) => setN(Number(e.target.value))} /> {n}
      </label>
      {data && !data.backbone && <p role="status">No ResNet is switched on in Configuration — these picks are found in a ResNet embedding, so there are none.</p>}
      {data && data.backbone && !data.available && <p role="status">Fewer than three pictures of {active} — nothing to choose from.</p>}
      {data?.available && (
        <>
          <p>
            Among <strong>{data.count}</strong> {active} picture(s). Embedding: {data.backbone} only; classical scores are not mixed in.
          </p>
          <CoverageCurve curve={data.coverage} suggested={data.suggested} radius={data.radius} />
          {data.suggested > 0 && (
            <p data-testid="suggested-count">
              {data.suggested} golden(s) already cover {Math.round(data.coverage[data.suggested - 1] * 100)}% of {active}; more add little.
              {!touched && n !== data.suggested && (
                <>
                  {" "}
                  <button onClick={() => setN(Math.min(data.suggested, data.n_max))}>Use {data.suggested}</button>
                </>
              )}
            </p>
          )}
          {data.left_out > 0 && <p className="muted">{data.left_out} isolated picture(s) were left out of the spread.</p>}
          {data.risky && <p role="note">These are also the likeliest mislabels — look at each before you trust its label.</p>}
          <ul style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6, padding: 0, listStyle: "none" }}>
            {data.picks.map((p, i) => (
              <li key={p.frame} data-testid={`start-${p.frame}`} style={{ border: "1px solid #ccc", borderRadius: 8, padding: 4 }}>
                <img src={thumbUrl(camera, p.frame, feature)} alt={p.frame} style={{ width: "100%", display: "block" }} />
                <div style={{ fontSize: 11, opacity: 0.7 }}>pick {i + 1}</div>
                <code style={{ fontSize: 10 }}>{p.frame}</code>
                <button
                  onClick={() =>
                    api
                      .promote(camera, feature, p.frame, p.label)
                      .then((r) => onPromoted(p.frame, p.label, r.counts))
                      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
                  }
                >
                  ⭐ Make golden ({p.label})
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
