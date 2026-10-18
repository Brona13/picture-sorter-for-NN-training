import { useCallback, useEffect, useState } from "react";
import { api, DedupState } from "../api";
import { ColourBy } from "./Scatter";
import { effectiveColour, ScatterMapView, useScatterMap } from "./ScatterWorkbench";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const BLOCKED: Record<NonNullable<DedupState["reason"]>, string> = {
  no_embeddings: "The map needs ResNet embeddings. Install the neural dependencies (pip install -r requirements-embedding.txt), then return here.",
  methods_off: "No ResNet method is switched on, and the map works on ResNet embeddings. Tick ResNet18 or ResNet50 on the Configuration page.",
  no_sklearn: "scikit-learn isn't installed. Run pip install -r requirements-embedding.txt and reload the app.",
};

/**
 * Classify's Scatter view: the 2D map of this ROI's pictures, to select many at once (drag a rectangle) and label or
 * delete them in one go. It is the same map and selection as the Scatter page (`ScatterWorkbench`). A map that is
 * already computed appears at once; otherwise it is computed on request.
 */
export default function ClassifyScatter({
  camera,
  feature,
  onChanged,
  onNotice,
  onError,
}: {
  camera: string;
  feature: string;
  /** A label or delete was made from the map: reload the page's counts and grid. */
  onChanged: () => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [dst, setDst] = useState<DedupState | null>(null);
  const [colourBy, setColourBy] = useState<ColourBy>("label");
  const method = dst?.params.method ?? "";
  const map = useScatterMap({ camera, feature, method, auto: !!dst && !dst.reason, onError });

  useEffect(() => {
    setDst(null);
    api
      .dedupState(camera, feature)
      .then(setDst)
      .catch((e: unknown) => onError(msg(e)));
  }, [camera, feature]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeMethod = useCallback(
    (next: string) => {
      if (!dst) return;
      const params = { ...dst.params, method: next };
      setDst({ ...dst, params });
      api.dedupSaveSettings(camera, feature, params).catch((e: unknown) => onError(msg(e)));
    },
    [camera, feature, dst, onError],
  );

  if (!dst) return <p>Loading the map…</p>;
  if (dst.reason) return <p role="status">{BLOCKED[dst.reason]}</p>;
  if (dst.frames < 2) return <p>This ROI needs at least two pictures for a map.</p>;

  const { colour, note } = effectiveColour(colourBy, map.scatter, null);
  return (
    <div data-testid="classify-scatter">
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", margin: "8px 0" }}>
        <label>
          Embedding{" "}
          <select value={method} onChange={(e) => changeMethod(e.target.value)}>
            {dst.backbones.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </label>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="visually-hidden">Projection</legend>
          {dst.projections.map((p) => (
            <label key={p} style={{ marginRight: 10 }}>
              <input type="radio" name="classify-projection" checked={map.projection === p} onChange={() => map.setProjection(p)} /> {p}
            </label>
          ))}
        </fieldset>
        <label>
          Colour by{" "}
          <select value={colourBy} onChange={(e) => setColourBy(e.target.value as ColourBy)}>
            <option value="label">Label</option>
            <option value="cluster">Cluster</option>
            <option value="none">Nothing</option>
          </select>
        </label>
        <button type="button" disabled={map.projecting} onClick={map.run}>
          {map.scatter ? "Recompute map" : "Compute map"}
        </button>
      </div>
      {map.projecting && (
        <p aria-live="polite">
          <progress /> Projecting…
        </p>
      )}
      {!map.scatter && !map.projecting && map.cached === false && (
        <p>
          This map is not computed yet. Press <strong>Compute map</strong>; it can take a while for a big set, and it is kept afterwards.
        </p>
      )}
      {note && (
        <p role="note" style={{ fontSize: 12 }}>
          {note}
        </p>
      )}
      <ScatterMapView
        camera={camera}
        feature={feature}
        map={map}
        colourBy={colour}
        grid={dst.grid}
        onGrid={(perPage, cols) =>
          api
            .dedupGridSettings(camera, feature, perPage, cols)
            .then((g) => setDst((x) => (x ? { ...x, grid: g } : x)))
            .catch((e: unknown) => onError(msg(e)))
        }
        onNotice={onNotice}
        onError={onError}
        onChanged={onChanged}
      />
    </div>
  );
}
