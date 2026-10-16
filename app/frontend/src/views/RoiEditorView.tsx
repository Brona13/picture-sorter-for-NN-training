import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, frameImageUrl, FramesResponse, RoiInfo, RoisResponse, roiThumbUrl } from "../api";
import PictureSizeSlider, { usePictureSize } from "../PictureSize";
import RoiCanvas from "../RoiCanvas";
import { FIT_VIEW, View } from "../zoomGeometry";
import { Box, round4, roundBox, sameBox } from "../roiGeometry";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const NUM_FIELDS: (keyof Box)[] = ["x", "y", "w", "h"];

export default function RoiEditorView({ camera, product }: { camera: string; product?: string }) {
  const [size, setSize] = usePictureSize("roi.pictureSize", 900, 200, 1600);
  const [frames, setFrames] = useState<FramesResponse | null>(null);
  const [view, setView] = useState<View>(FIT_VIEW);
  const [data, setData] = useState<RoisResponse | null>(null);
  const [frame, setFrame] = useState("");
  const [mode, setMode] = useState<"draw" | "edit">("draw");
  const [editFeature, setEditFeature] = useState("");
  const [box, setBox] = useState<Box | null>(null);
  const [name, setName] = useState("");
  const [makeClassifier, setMakeClassifier] = useState(false);
  const [productCsv, setProductCsv] = useState("");
  const [sharedWith, setSharedWith] = useState<string[]>([]);
  const [productsText, setProductsText] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setView(FIT_VIEW), [camera, product]);

  const reload = useCallback(async () => {
    if (!camera) return;
    try {
      const [f, r] = await Promise.all([api.frames(camera, product), api.rois(camera, product)]);
      setFrames(f);
      setData(r);
      setFrame((cur) =>
        f.frames.includes(cur) ? cur : f.reference_frame && f.frames.includes(f.reference_frame) ? f.reference_frame : f.frames[0] ?? "",
      );
      setError(null);
    } catch (e) {
      setError(msg(e));
    }
  }, [camera, product]);

  useEffect(() => {
    setFrame("");
    setBox(null);
    setMode("draw");
    setNotice(null);
    reload();
  }, [reload]);

  const rois = data?.rois ?? [];
  const target: RoiInfo | undefined = rois.find((r) => r.feature === editFeature) ?? rois[0];
  const editing = mode === "edit" && target !== undefined;

  // Entering edit mode (or switching target) seeds the box from the saved geometry.
  useEffect(() => {
    if (editing && target) setBox({ x: target.x, y: target.y, w: target.w, h: target.h });
    if (!editing) setBox(null);
  }, [editing, target?.feature, target?.x, target?.y, target?.w, target?.h]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (data?.classify_feature) {
      const c = data.rois.find((r) => r.feature === data.classify_feature);
      setProductsText((c?.classes ?? data.products).join(", "));
    }
  }, [data]);

  const others = useMemo(
    () =>
      rois
        .filter((r) => !(editing && r.feature === target?.feature))
        .map((r) => ({ name: r.short_name, box: { x: r.x, y: r.y, w: r.w, h: r.h } })),
    [rois, editing, target?.feature],
  );

  async function run(action: () => Promise<string | void>) {
    setError(null);
    try {
      const done = await action();
      if (done) setNotice(done);
      await reload();
    } catch (e) {
      setError(msg(e));
    }
  }

  function setField(k: keyof Box, v: string) {
    const n = Number(v);
    if (Number.isNaN(n)) return;
    setBox((b) => ({ ...(b ?? { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }), [k]: n }));
  }

  function onAdd(e: FormEvent) {
    e.preventDefault();
    if (!box) return setError("Draw a rectangle first.");
    const b = roundBox(box);
    run(async () => {
      const saved = await api.saveRoi(camera, {
        name,
        ...b,
        product: product ?? null,
        make_classifier: makeClassifier,
        product_names: productCsv.split(","),
        shared_with: sharedWith,
      });
      setName("");
      setBox(null);
      setMakeClassifier(false);
      setProductCsv("");
      setSharedWith([]);
      return `Saved ROI '${saved.short_name}'${product ? ` under product '${product}'` : ""}`;
    });
  }

  const moved = editing && target && box ? !sameBox(box, target) : false;

  if (!camera) return <p>Select a camera.</p>;
  if (frames && frames.frames.length === 0)
    return (
      <p>
        No frames for this camera yet — add some in <strong>Ingest</strong> first. Any ingested frame works as the
        drawing background (same camera, same framing).
      </p>
    );

  const classifyFeat = data?.classify_feature ?? null;
  const allProducts = data?.products ?? [];

  return (
    <section>
      <h2>
        ROI editor — {camera}
        {product ? ` › ${product}` : ""}
      </h2>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      {product ? (
        <p>
          Drawing ROIs for product <strong>{product}</strong> — they apply only to its frames.
          {data && data.shared_here.length > 0 && (
            <> 🔗 Shared ROIs also covering it: <strong>{data.shared_here.join(", ")}</strong> (edit those at camera level).</>
          )}
        </p>
      ) : (
        classifyFeat && (
          <p>
            Camera level. The product-sorting ROI is <strong>{classifyFeat}</strong>; pick a product in the sidebar to draw
            that product's own inspection ROIs.
          </p>
        )
      )}

      <div>
        <label>
          Frame to draw on{" "}
          <select value={frame} onChange={(e) => setFrame(e.target.value)}>
            {(frames?.frames ?? []).map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>{" "}
        <button type="button" disabled={!frame} onClick={() => run(async () => { await api.setReferenceFrame(camera, frame); return `Pinned ${frame} as reference.`; })}>
          📌 Pin as reference
        </button>
        {product && frames && (
          <p>
            {frames.showing_all
              ? `No frames are classified as ${product} yet, so all ${frames.total} frames are offered. Classify some in Classify to narrow this list.`
              : `Showing the ${frames.frames.length} frames classified as ${product} — draw this ROI on a picture of the product it belongs to.`}
          </p>
        )}
        {frames?.reference_frame && (
          <p>
            📌 Reference frame: <code>{frames.reference_frame}</code>
            {!frames.frames.includes(frames.reference_frame) && " ⚠️ no longer present — pick another and pin it"}
          </p>
        )}
      </div>

      {rois.length > 0 && (
        <fieldset>
          <legend>Mode</legend>
          <label>
            <input type="radio" name="mode" checked={mode === "draw"} onChange={() => setMode("draw")} /> ➕ Draw a new ROI
          </label>{" "}
          <label>
            <input type="radio" name="mode" checked={mode === "edit"} onChange={() => setMode("edit")} /> ✥ Move &amp; resize an existing ROI
          </label>
          {mode === "edit" && (
            <label>
              {" "}
              ROI to adjust{" "}
              <select value={target?.feature ?? ""} onChange={(e) => setEditFeature(e.target.value)}>
                {rois.map((r) => (
                  <option key={r.feature} value={r.feature}>
                    {r.short_name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
      )}

      {frame && (
        <>
          <PictureSizeSlider value={size} onChange={setSize} min={200} max={1600} />
          <RoiCanvas
            imageUrl={frameImageUrl(camera, frame)}
            mode={editing ? "edit" : "draw"}
            box={box}
            onChange={setBox}
            others={others}
            width={size}
            view={view}
            onViewChange={setView}
          />
        </>
      )}
      <p>
        {editing
          ? "Drag the box to move it, or pull a corner/edge handle to resize. Other ROIs stay drawn in green for reference. Wheel: zoom at the cursor. Pan: middle button or Space + drag (or drag the background)."
          : "Existing ROIs are drawn in green. Drag on the image to draw a new rectangle, name it, and add it. Wheel: zoom at the cursor. Pan: middle button or Space + drag."}
      </p>

      <div>
        {NUM_FIELDS.map((k) => (
          <label key={k} style={{ marginRight: 8 }}>
            {k}{" "}
            <input
              type="number"
              step={0.002}
              min={0}
              max={1}
              aria-label={k}
              style={{ width: 90 }}
              value={box ? round4(box[k]) : ""}
              onChange={(e) => setField(k, e.target.value)}
            />
          </label>
        ))}
      </div>

      {editing && target && (
        <div>
          {moved && (target.labeled > 0 || target.goldens > 0) && (
            <p role="alert">
              <strong>{target.short_name}</strong> already has {target.labeled} labels and {target.goldens} golden marks. Moving
              the rectangle keeps them, but they were decided on the <em>previous</em> crop — re-run <strong>Refresh scores</strong> and
              review them afterwards.
            </p>
          )}
          <button
            disabled={!moved}
            onClick={() =>
              box &&
              run(async () => {
                const b = roundBox(box);
                await api.moveRoi(camera, target.feature, b);
                return `Moved '${target.short_name}' → x=${b.x}, y=${b.y}, w=${b.w}, h=${b.h}`;
              })
            }
          >
            💾 Save position
          </button>{" "}
          <span>
            Saved: x={target.x}, y={target.y}, w={target.w}, h={target.h} · {moved ? "unsaved changes" : "unchanged"}
          </span>
        </div>
      )}

      {!editing && (
        <form onSubmit={onAdd}>
          <label>
            Feature name for this ROI{" "}
            <input value={name} placeholder="e.g. suspension-rod" onChange={(e) => setName(e.target.value)} />
          </label>
          {!product && classifyFeat === null && (
            <>
              <div>
                <label>
                  <input type="checkbox" checked={makeClassifier} onChange={(e) => setMakeClassifier(e.target.checked)} /> Make this the{" "}
                  <strong>product-sorting</strong> ROI (stage 1)
                </label>
              </div>
              <label>
                Product names (comma-separated){" "}
                <input value={productCsv} placeholder="type-A, type-B, type-C" onChange={(e) => setProductCsv(e.target.value)} />
              </label>
            </>
          )}
          {!product && classifyFeat !== null && allProducts.length > 0 && (
            <fieldset>
              <legend>Applies to products (leave empty = all products)</legend>
              {allProducts.map((p) => (
                <label key={p} style={{ marginRight: 8 }}>
                  <input
                    type="checkbox"
                    checked={sharedWith.includes(p)}
                    onChange={(e) => setSharedWith((cur) => (e.target.checked ? [...cur, p] : cur.filter((x) => x !== p)))}
                  />{" "}
                  {p}
                </label>
              ))}
            </fieldset>
          )}
          <button type="submit">➕ Add / update ROI</button>
        </form>
      )}

      {!product && classifyFeat && (
        <details>
          <summary>Products — classes of '{classifyFeat}'</summary>
          <label>
            Product names (comma-separated){" "}
            <input value={productsText} onChange={(e) => setProductsText(e.target.value)} />
          </label>{" "}
          <button
            onClick={() =>
              run(async () => {
                const r = await api.setProductNames(camera, productsText.split(","));
                return `Products: ${r.products.join(", ")}`;
              })
            }
          >
            Save products
          </button>
          <p>
            Adding a product makes it available in the sidebar. Removing one does <strong>not</strong> delete its labels or ROIs —
            they simply stop being offered.
          </p>
        </details>
      )}

      {rois.length > 0 && (
        <div>
          <h3>Defined ROIs</h3>
          <p>
            Product changes save as you make them. Deleting a ROI also removes its labels, goldens and versions — that can't be
            undone.
          </p>
          {data && data.unclassified_frames > 0 && (
            <p>
              <strong>
                {data.unclassified_frames} of {data.inbox_total} frames have no product yet.
              </strong>{" "}
              A ROI limited to products only covers frames that have been sorted, which is why its count is lower than the camera's
              total. Sort them in Classify and they'll appear here too.
            </p>
          )}
          <ul style={{ listStyle: "none", padding: 0 }}>
            {rois.map((r) => (
              <RoiCard
                key={r.feature}
                camera={camera}
                frame={frame}
                roi={r}
                scopeIsCamera={!product}
                allProducts={allProducts}
                confirming={confirmDelete === r.feature}
                onAskDelete={() => setConfirmDelete(r.feature)}
                onCancelDelete={() => setConfirmDelete(null)}
                onDelete={() =>
                  run(async () => {
                    const res = await api.deleteRoi(camera, r.feature);
                    setConfirmDelete(null);
                    const x = res.removed;
                    return `Deleted '${r.feature}': removed ${x.labels ?? 0} labels / ${x.goldens ?? 0} golden marks / ${x.versions ?? 0} versions / ${x.settings ?? 0} settings.`;
                  })
                }
                onProducts={(list) =>
                  run(async () => {
                    await api.setRoiProducts(camera, r.feature, list);
                    return `'${r.short_name}' → ${list.length ? list.join(", ") : "all products"} · re-run Refresh scores in Classify`;
                  })
                }
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function chip(r: RoiInfo): string {
  if (r.role === "classify") return "🗂 product sorter";
  if (r.shared_products) return `🔗 shared · ${r.shared_products.join(", ")}`;
  if (r.owner_product) return `${r.owner_product} only`;
  return "all frames";
}

interface CardProps {
  camera: string;
  frame: string;
  roi: RoiInfo;
  scopeIsCamera: boolean;
  allProducts: string[];
  confirming: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
  onProducts: (list: string[]) => void;
}

function RoiCard({ camera, frame, roi, scopeIsCamera, allProducts, confirming, onAskDelete, onCancelDelete, onDelete, onProducts }: CardProps) {
  const frames = roi.frames_seen === roi.inbox_total ? `${roi.frames_seen} frames` : `${roi.frames_seen} of ${roi.inbox_total} frames`;
  const current = roi.shared_products ?? [];
  return (
    <li style={{ border: "1px solid #ccc", borderRadius: 8, padding: 8, marginBottom: 8 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        {frame && (
          <img
            src={roiThumbUrl(camera, frame, roi.feature)}
            alt=""
            width={56}
            height={56}
            style={{ borderRadius: 8, objectFit: "cover", flex: "none" }}
          />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong>{roi.short_name}</strong> <small>{chip(roi)}</small>
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            {frames} · {roi.goldens} golden{roi.goldens === 1 ? "" : "s"} · {roi.labeled} labeled ·{" "}
            {roi.active_version !== null ? `v${roi.active_version} active` : "no version yet"}
          </div>
        </div>
        {confirming && (
          // To the right of the row's text, so asking does not push the rows below it down.
          <div
            role="alertdialog"
            aria-label={`Confirm delete ${roi.short_name}`}
            style={{ flex: "0 1 460px", display: "flex", gap: 10, alignItems: "center", border: "1px solid #c33", borderRadius: 6, padding: "4px 8px", fontSize: 13 }}
          >
            <span style={{ flex: 1 }}>
              Delete <strong>{roi.short_name}</strong> and permanently remove its {roi.labeled} labels, {roi.goldens} golden marks and {roi.version_count} versions?
            </span>
            <button onClick={onDelete}>✅ Yes, delete</button>
            <button onClick={onCancelDelete}>Cancel</button>
          </div>
        )}
        <button aria-label={`Delete ${roi.short_name}`} onClick={onAskDelete} disabled={confirming}>
          🗑
        </button>
      </div>
      {scopeIsCamera && allProducts.length > 0 && roi.role !== "classify" && (
        <fieldset>
          <legend>Applies to products (none checked = every product)</legend>
          {allProducts.map((p) => (
            <label key={p} style={{ marginRight: 8 }}>
              <input
                type="checkbox"
                checked={current.includes(p)}
                onChange={(e) => onProducts(e.target.checked ? [...current, p] : current.filter((x) => x !== p))}
              />{" "}
              {p}
            </label>
          ))}
        </fieldset>
      )}
    </li>
  );
}
