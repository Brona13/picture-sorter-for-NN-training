import { useEffect, useState } from "react";
import { api, FilterChoice, FilterSpec, MaskChoice } from "../api";
import ShapeCanvas from "../ShapeCanvas";
import { addVertex, defaultShape, MaskShape, ShapeKind } from "../shapeGeometry";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const PREVIEW_DEBOUNCE_MS = 250;

const defaultsOf = (spec: FilterSpec): Record<string, number> =>
  Object.fromEntries(Object.entries(spec.params).map(([k, p]) => [k, p.default]));

/** Debounced server-rendered preview of the crop with the proposed (unsaved) settings. */
function usePreview(
  camera: string,
  feature: string,
  frame: string,
  filter: FilterChoice | null,
  mask: MaskChoice | null,
  onError: (message: string | null) => void,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const maskKey = JSON.stringify(mask);
  useEffect(() => {
    if (!camera || !feature || !frame) return;
    let cancelled = false;
    let created: string | null = null;
    const timer = setTimeout(() => {
      api
        .visionPreview(camera, feature, frame, filter, mask)
        .then((blob) => {
          if (cancelled) return;
          created = URL.createObjectURL(blob);
          setUrl(created);
          onError(null);
        })
        .catch((e: unknown) => !cancelled && onError(msg(e)));
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (created) URL.revokeObjectURL(created);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, feature, frame, filter, maskKey]);
  return url;
}

const SHAPE_LABELS: Record<ShapeKind, string> = { rect: "Rectangle", circle: "Circle", polygon: "Polygon" };

export default function DetectorView({ camera, product }: { camera: string; product?: string }) {
  const [catalogue, setCatalogue] = useState<Record<string, FilterSpec>>({});
  const [features, setFeatures] = useState<{ feature: string; label: string }[]>([]);
  const [feature, setFeature] = useState("");
  const [frames, setFrames] = useState<string[]>([]);
  const [frame, setFrame] = useState("");
  const [filter, setFilter] = useState<FilterChoice | null>(null);
  const [saved, setSaved] = useState<FilterChoice | null>(null);
  const [mask, setMask] = useState<MaskChoice | null>(null);
  const [savedMask, setSavedMask] = useState<MaskChoice | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .visionFilters()
      .then((r) => setCatalogue(r.filters))
      .catch((e: unknown) => setError(msg(e)));
  }, []);

  useEffect(() => {
    if (!camera) return;
    setFeature("");
    api
      .versionFeatures(camera, product)
      .then((f) => {
        setFeatures(f);
        setFeature(f[0]?.feature ?? "");
      })
      .catch((e: unknown) => setError(msg(e)));
    api
      .frames(camera, product)
      .then((r) => {
        setFrames(r.frames);
        setFrame(r.reference_frame ?? r.frames[0] ?? "");
      })
      .catch((e: unknown) => setError(msg(e)));
  }, [camera, product]);

  useEffect(() => {
    if (!camera || !feature) return;
    api
      .visionSettings(camera, feature)
      .then((s) => {
        setFilter(s.filter);
        setSaved(s.filter);
        setMask(s.mask);
        setSavedMask(s.mask);
        setError(null);
      })
      .catch((e: unknown) => setError(msg(e)));
  }, [camera, feature]);

  // The editing canvas shows the filtered crop; the result image also applies the enabled mask.
  const canvasUrl = usePreview(camera, feature, frame, filter, null, setError);
  const resultUrl = usePreview(camera, feature, frame, filter, mask?.enabled ? mask : null, setError);

  const choose = (name: string) =>
    setFilter(name ? { name, params: defaultsOf(catalogue[name]) } : null);

  const save = () =>
    api
      .saveVisionSettings(camera, feature, { filter, mask })
      .then((s) => {
        setSaved(s.filter);
        setFilter(s.filter);
        setSavedMask(s.mask);
        setMask(s.mask);
        setError(null);
      })
      .catch((e: unknown) => setError(msg(e)));

  const dirty =
    JSON.stringify(filter) !== JSON.stringify(saved) || JSON.stringify(mask) !== JSON.stringify(savedMask);
  const setShape = (shape: MaskShape | null) =>
    setMask(shape ? { enabled: mask?.enabled ?? false, shape } : null);
  const revert = () => {
    setFilter(saved);
    setMask(savedMask);
  };
  const spec = filter ? catalogue[filter.name] : undefined;

  if (!camera) return <p>Select a camera.</p>;

  return (
    <section>
      <h2>
        Detector — {camera}
        {product ? ` › ${product}` : ""}
      </h2>
      {error && <p role="alert">{error}</p>}
      <label>
        Feature (ROI){" "}
        <select value={feature} onChange={(e) => setFeature(e.target.value)}>
          {features.map((f) => (
            <option key={f.feature} value={f.feature}>
              {f.label}
            </option>
          ))}
        </select>
      </label>{" "}
      <label>
        Preview frame{" "}
        <select value={frame} onChange={(e) => setFrame(e.target.value)}>
          {frames.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>

      <h3>Pre-processing filter</h3>
      <p>
        Applied identically to every frame of this feature before features and embeddings are
        computed. Saved per feature.
      </p>
      <label>
        Filter{" "}
        <select value={filter?.name ?? ""} onChange={(e) => choose(e.target.value)}>
          <option value="">None</option>
          {Object.entries(catalogue).map(([name, s]) => (
            <option key={name} value={name}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      {filter &&
        spec &&
        Object.entries(spec.params).map(([key, p]) => (
          <div key={key}>
            <label>
              {key}{" "}
              <input
                type="range"
                aria-label={key}
                min={p.min}
                max={p.max}
                step={p.step}
                value={filter.params[key] ?? p.default}
                onChange={(e) =>
                  setFilter({ ...filter, params: { ...filter.params, [key]: Number(e.target.value) } })
                }
              />{" "}
              <output>{filter.params[key] ?? p.default}</output>
            </label>
          </div>
        ))}

      <h3>Object mask</h3>
      <p>
        Everything outside the shape is blanked to dark grey before features and embeddings are
        computed, so they describe the object only. Shape coordinates are relative to the ROI crop.
      </p>
      <label>
        Shape{" "}
        <select
          value={mask?.shape.shape ?? ""}
          onChange={(e) => setShape(e.target.value ? defaultShape(e.target.value as ShapeKind) : null)}
        >
          <option value="">None</option>
          {(Object.keys(SHAPE_LABELS) as ShapeKind[]).map((k) => (
            <option key={k} value={k}>
              {SHAPE_LABELS[k]}
            </option>
          ))}
        </select>
      </label>{" "}
      {mask && (
        <label>
          <input
            type="checkbox"
            checked={mask.enabled}
            onChange={(e) => setMask({ ...mask, enabled: e.target.checked })}
          />{" "}
          Apply mask to Classify, Dedup and suggestions
        </label>
      )}{" "}
      {mask?.shape.shape === "polygon" && (
        <button onClick={() => setShape(addVertex(mask.shape))}>Add point</button>
      )}
      {canvasUrl && <ShapeCanvas imageUrl={canvasUrl} shape={mask?.shape ?? null} onChange={setShape} />}

      <p>
        <button onClick={save} disabled={!dirty || !feature}>
          Save settings
        </button>{" "}
        <button onClick={revert} disabled={!dirty}>
          Revert
        </button>
        {dirty && <em> Unsaved changes — saving makes cached scores for this feature recompute.</em>}
      </p>
      {resultUrl && (
        <>
          <h3>Result</h3>
          <img src={resultUrl} alt="Filtered preview" style={{ maxWidth: 700, width: "100%" }} />
        </>
      )}
    </section>
  );
}
