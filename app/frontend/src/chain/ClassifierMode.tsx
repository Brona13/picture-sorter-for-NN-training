import { useState } from "react";
import { api, ChainNode } from "../api";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The mode of one Classifier box, chosen in its panel (v1.99.0): Feature (classes OK / NG) or Product (its classes are
 * the product names; a camera has one). Switching clears the labels of that Classifier, because its classes change.
 */
export default function ClassifierMode({
  camera,
  node,
  productTaken,
  onChanged,
  onError,
}: {
  camera: string;
  node: ChainNode;
  /** Another Classifier of this camera is already the Product Classifier. */
  productTaken: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const product = node.role === "classify";
  const [naming, setNaming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [names, setNames] = useState("Product 1, Product 2");
  if (!node.ref) return null;
  const ref = node.ref;
  const go = (mode: "product" | "feature", productNames: string[] = []) =>
    api
      .setRoiMode(camera, ref, mode, productNames)
      .then(() => {
        setNaming(false);
        setLeaving(false);
        onChanged();
      })
      .catch((e: unknown) => onError(msg(e)));
  const clears = node.labeled > 0 ? ` Its ${node.labeled} label${node.labeled === 1 ? "" : "s"} are cleared.` : "";
  return (
    <div className="chain-mode" role="group" aria-label="Classifier mode">
      <strong>Mode</strong>
      <div>
        <button type="button" aria-pressed={!product} disabled={!product} onClick={() => setLeaving(true)}>
          Feature
        </button>{" "}
        <button type="button" aria-pressed={product} disabled={product || productTaken} title={productTaken && !product ? "This camera has its Product Classifier already." : undefined} onClick={() => setNaming(true)}>
          Product
        </button>
      </div>
      <p className="muted">
        {product ? "Sorts pictures into products; Feature Classifiers can read one product or all of them." : "Labels one feature (OK / NG). Product mode sorts pictures into the products of the camera."}
      </p>
      {leaving && product && (
        <div>
          <p>Make {node.label} a Feature Classifier (OK / NG)?{clears}</p>
          <button type="button" className="danger" onClick={() => void go("feature")}>Switch to Feature</button>{" "}
          <button type="button" onClick={() => setLeaving(false)}>Cancel</button>
        </div>
      )}
      {naming && !product && (
        <div>
          <label>
            Product names
            <input aria-label="Product names" value={names} onChange={(e) => setNames(e.target.value)} />
          </label>
          <p className="muted">Separated by commas, at least two.{clears}</p>
          <button type="button" onClick={() => void go("product", names.split(",").map((n) => n.trim()).filter(Boolean))}>Make it the Product Classifier</button>{" "}
          <button type="button" onClick={() => setNaming(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
