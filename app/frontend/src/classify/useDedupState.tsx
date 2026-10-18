import { useCallback, useEffect, useState } from "react";
import { api, DedupState } from "../api";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const BLOCKED: Record<NonNullable<DedupState["reason"]>, string> = {
  no_embeddings: "This tool needs ResNet embeddings. Install the neural dependencies (pip install -r requirements-embedding.txt), then return here.",
  methods_off: "No ResNet method is switched on, and this tool works on ResNet embeddings. Tick ResNet18 or ResNet50 on the Configuration page.",
  no_sklearn: "scikit-learn isn't installed. Run pip install -r requirements-embedding.txt and reload the app.",
};

/**
 * The embedding side of a ROI that the Scatter and Outliers views of Classify share: the Dedup state (which embeddings
 * exist, which one is chosen, whether the tool is available at all) and a way to choose another embedding. The choice is
 * the Dedup setting of the ROI, the same one the Scatter and Outliers pages use.
 */
export function useDedupState(camera: string, feature: string, onError: (message: string) => void) {
  const [dst, setDst] = useState<DedupState | null>(null);

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

  /** Why the tool cannot run for this ROI, or null when it can. */
  const blocked = !dst
    ? null
    : dst.reason
      ? BLOCKED[dst.reason]
      : dst.frames < 2
        ? "This ROI needs at least two pictures."
        : null;

  return { dst, method: dst?.params.method ?? "", changeMethod, blocked };
}

/** The embedding choice, the same select in every view that works on embeddings. */
export function EmbeddingSelect({ state }: { state: ReturnType<typeof useDedupState> }) {
  const { dst, method, changeMethod } = state;
  if (!dst) return null;
  return (
    <label>
      Embedding{" "}
      <select value={method} onChange={(e) => changeMethod(e.target.value)}>
        {dst.backbones.map((b) => (
          <option key={b}>{b}</option>
        ))}
      </select>
    </label>
  );
}
