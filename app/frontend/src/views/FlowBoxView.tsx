import { densestSpot, densestValue } from "../density";
import { referenceFrame } from "../referencePicture";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, FlowPair, FlowPairState, FlowZone, FlowBox, FlowCalc, FlowCrop, FlowDetector, FlowLabeling, FlowNodeDetail, FlowValues, flowPictureUrl, frameImageUrl, frameThumbUrl, frameWholeThumbUrl } from "../api";
import PictureEditsWork from "./PictureEditsWork";
import { usePictureEdits } from "./pictureEdits";
import PictureSizeSlider, { usePictureSize } from "../PictureSize";
import SidePanel from "../SidePanel";
import { drawn, stored } from "../pixelCentre";
import { HANDLE_CURSOR } from "../roiGeometry";
import DetectorGrid from "./DetectorGrid";
import ZoomPane from "../ZoomPane";
import { FIT_VIEW, fitSize, View } from "../zoomGeometry";
import FlowBoxPanel, { EvaluationHistogram } from "./FlowBoxPanel";
import ZoneScatter from "./ZoneScatter";
import { HeatControls, useHeatChoice } from "./heatChoice";
import PositionMap, { startRadius } from "./PositionMap";
import PairMap from "./PairMap";
import BoxValues, { BoxMeasure, boxValue } from "./BoxValues";
import { ATTENTION_SORTS, AttentionSort, attentionOf, attentionText, isAttentionSort, sortByAttention } from "../attention";
import { judgeZone, Pt2, Zone } from "../zoneGeometry";
import CalcGeometry from "./CalcGeometry";
import type { EvalSpec } from "../evalGeometry";
import ExportWork from "./ExportWork";
import BoxWork from "./BoxWork";
import ValueGrid, { ViewerExtras } from "./ValueGrid";
import { VerdictWord } from "./NominalButton";
import { zoneDistanceText, zoneOffsetText } from "../zoneText";
import MessageBar from "../MessageBar";

const CHART_STORE = "flow.histogram";
const SORT_STORE = "flow.detectorSort"; // the detector page's order: needs attention first, furthest outside, weakest match, file name

/** The look of a rectangle being drawn or edited, the same as in the ROI editor. */
const ROI_RED = "#ff3030";
const ROI_FILL = "rgba(255,165,0,0.2)";
const ROI_HOVER = "rgba(255,165,0,0.1)"; // the example under the pointer, before it is selected
const COLORS = ["#e8590c", "#1c7ed6", "#2f9e44", "#ae3ec9", "#f08c00", "#0c8599", "#c2255c", "#5c940d"];
const STRIP_WINDOW = 60;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Rectangle of a drag in picture pixels, from two corners. */
export function rectOf(a: { x: number; y: number }, b: { x: number; y: number }): [number, number, number, number] {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return [Math.round(x), Math.round(y), Math.round(Math.abs(a.x - b.x)), Math.round(Math.abs(a.y - b.y))];
}

export type Rect = [number, number, number, number];
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/**
 * The rectangle after dragging one of its handles by (dx, dy) picture pixels; it never gets smaller than `min`, never
 * crosses the top or left edge of the picture and, given its size in `bounds`, never the bottom or right one (like the
 * ROI editor, whose handles stop at the frame).
 */
export function resizeRect(r: Rect, handle: Handle, dx: number, dy: number, min = 5, bounds?: { w: number; h: number }): Rect {
  let [x0, y0, x1, y1] = [r[0], r[1], r[0] + r[2], r[1] + r[3]];
  const [maxX, maxY] = [bounds?.w ?? Infinity, bounds?.h ?? Infinity];
  if (handle.includes("w")) x0 = Math.max(0, Math.min(x0 + dx, x1 - min));
  if (handle.includes("e")) x1 = Math.min(maxX, Math.max(x1 + dx, x0 + min));
  if (handle.includes("n")) y0 = Math.max(0, Math.min(y0 + dy, y1 - min));
  if (handle.includes("s")) y1 = Math.min(maxY, Math.max(y1 + dy, y0 + min));
  return [x0, y0, x1 - x0, y1 - y0];
}

/** The mouse cursor for grabbing a rectangle: its handle's resize arrows, or "move" inside it. */
export const grabCursor = (kind: "move" | Handle): string => (kind === "move" ? "move" : HANDLE_CURSOR[kind]);

const handlePoint = (r: Rect, h: Handle) => ({
  x: h.includes("w") ? r[0] : h.includes("e") ? r[0] + r[2] : r[0] + r[2] / 2,
  y: h.includes("n") ? r[1] : h.includes("s") ? r[1] + r[3] : r[1] + r[3] / 2,
});

const TITLES = { crop: "Picture edits", detector: "Detector", calc: "Calculate", evaluation: "Evaluation", export: "Export", box: "Box" } as const;

export type FlowFocus = { nodeId: string; onBack: () => void };

/**
 * The page of one measurement box, opened from the Chain like the ROI editor: the options on the right, the work on the
 * pictures in the middle. A detector: draw example crops and review the boxes it found. Calculate and Evaluation: the
 * measured value of every picture (and the nominal and tolerance against the histogram).
 */
export default function FlowBoxView({ camera, focus, onOpenClassifier }: { camera: string; focus: FlowFocus; onOpenClassifier?: (feature: string) => void }) {
  const { nodeId } = focus;
  const [detail, setDetail] = useState<FlowNodeDetail | null>(null);
  const [label, setLabel] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    setDetail(null);
    setError(null);
    api.flowNode(camera, nodeId).then(setDetail).catch((e) => setError(msg(e)));
    api.chain(camera).then((c) => setLabel(c.nodes.find((n) => n.id === nodeId)?.label ?? nodeId)).catch(() => setLabel(nodeId));
  }, [camera, nodeId]);

  const changed = useCallback(() => setVersion((v) => v + 1), []);
  const title = detail ? TITLES[detail.kind] : "Measurement box";
  // A Picture Edits box: its options panel (the steps) and its big picture share one live draft of the steps.
  const edits = usePictureEdits(camera, nodeId, detail?.kind === "crop" ? detail : null, setDetail, changed, setError);

  const panel = detail ? (
    <FlowBoxPanel camera={camera} nodeId={nodeId} detail={detail} onDetail={setDetail} onChanged={changed} edits={edits} />
  ) : (
    <p className="muted">{error ?? "Loading…"}</p>
  );

  return (
    <SidePanel panel={panel} wide>
      <section className="flow-view">
        <h2>
          {title} — {camera} › {label}
        </h2>
        <p>
          <button type="button" onClick={focus.onBack}>← Back to chain</button>
        </p>
        <MessageBar kind="error" text={error} onClose={() => setError(null)} />
        {detail?.kind === "crop" && <PictureEditsWork camera={camera} nodeId={nodeId} detail={detail} edits={edits} onError={setError} />}
        {detail?.kind === "detector" && <DetectorWork camera={camera} nodeId={nodeId} detail={detail} setDetail={setDetail} version={version} onChanged={changed} onError={setError} />}
        {detail?.kind === "box" && <BoxWork camera={camera} nodeId={nodeId} detail={detail} setDetail={setDetail} onError={setError} />}
        {detail?.kind === "export" && <ExportWork camera={camera} nodeId={nodeId} detail={detail} setDetail={setDetail} onError={setError} onOpenClassifier={onOpenClassifier} />}
        {detail && detail.kind !== "detector" && detail.kind !== "crop" && detail.kind !== "export" && detail.kind !== "box" && (
          <ValuesWork camera={camera} nodeId={nodeId} detail={detail} setDetail={setDetail} version={version} onError={setError} />
        )}
      </section>
    </SidePanel>
  );
}

/** A turn in degrees brought to -180..180 (counter-clockwise on screen). */
function turnTo(angle: number): number {
  return Math.round((((angle + 180) % 360 + 360) % 360 - 180) * 10) / 10;
}

function DetectorWork(p: {
  camera: string;
  nodeId: string;
  detail: FlowDetector;
  setDetail: (d: FlowNodeDetail) => void;
  version: number;
  onChanged: () => void;
  onError: (e: string | null) => void;
}) {
  const { camera, nodeId, detail } = p;
  const [frames, setFrames] = useState<string[]>([]);
  const [hasInput, setHasInput] = useState(true);
  const [index, setIndex] = useState(0);
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState<"draw" | "place" | "reuse">("draw");
  // "Reuse rectangle": a copy of an existing example's rectangle, put on this picture, moved and turned, then added as an example.
  const [reuseSrc, setReuseSrc] = useState("");
  const [stamp, setStamp] = useState<{ cx: number; cy: number; angle: number } | null>(null);
  const [stampDrag, setStampDrag] = useState<{ kind: "move" | "turn"; start: { x: number; y: number }; orig: { cx: number; cy: number } } | null>(null);
  // Which pictures the strip and the grid show: all, those where a target was not found, those outside a review zone.
  const [show, setShow] = useState<"all" | "missing" | "outside">("all");
  const [mapSlot, setMapSlot] = useState(""); // the target slot on the position map
  const [spot, setSpot] = useState<{ slot: string; at: Pt2; radius: number } | null>(null); // a click on the map: only the pictures near it
  const heatChoice = useHeatChoice();
  const [pairState, setPairState] = useState<FlowPairState | null>(null); // the pair map (v1.170.0)
  const [pairRange, setPairRange] = useState<[number, number] | null>(null); // the pair histogram's zoom: only those pictures
  const [boxMeasure, setBoxMeasure] = useState<BoxMeasure>("score"); // the box-values chart (v1.172.0)
  const [boxRange, setBoxRange] = useState<{ slot: string; measure: BoxMeasure; range: [number, number] } | null>(null); // its zoom: only those pictures
  // The order of the strip and the grid (v1.171.0): needs attention first unless another signal is chosen; remembered here.
  const [sort, setSort] = useState<AttentionSort>(() => {
    try { const v = localStorage.getItem(SORT_STORE) ?? ""; return isAttentionSort(v) ? v : "attention"; } catch { return "attention"; }
  });
  const chooseSort = (v: AttentionSort) => {
    setSort(v);
    try { localStorage.setItem(SORT_STORE, v); } catch { /* not remembered */ }
  };
  const [creating, setCreating] = useState(false);
  const [sel, setSel] = useState<{ name: string; index: number } | null>(null);
  const [edit, setEdit] = useState<{ kind: "move" | Handle; start: { x: number; y: number }; orig: Rect; cur: Rect } | null>(null);
  const [pending, setPending] = useState<{ frame: string; box: [number, number, number, number] } | null>(null);
  const [newName, setNewName] = useState("");
  const [boxes, setBoxes] = useState<Record<string, Record<string, FlowBox>>>({});
  const [parentBoxes, setParentBoxes] = useState<Record<string, Record<string, FlowBox>>>({});
  const [insidePick, setInsidePick] = useState("");
  const [wholePictureView, setWholePictureView] = useState(false); // cascade: the whole picture with the found box outlined, instead of the cut-out of that box
  const [review, setReview] = useState<string[]>([]);
  const [measured, setMeasured] = useState<{ src: string; w: number; h: number } | null>(null); // size of the picture at `src`, from its load
  const [drag, setDrag] = useState<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // The same zoomable picture as the ROI editor: wheel zoom, pan (middle button, Space + drag), Reset, 1:1.
  const [paneWidth, setPaneWidth] = usePictureSize("flow.detectorSize", 900, 200, 1600);
  const [zoom, setZoom] = useState<View>(FIT_VIEW);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const strip = useRef<HTMLDivElement | null>(null);

  const boxesAsked = useRef(0); // only the newest answer is shown: an older one arriving late must not put old boxes back
  const loadBoxes = useCallback(
    () => {
      const asked = ++boxesAsked.current;
      return api.flowBoxes(camera, nodeId)
        .then((b) => { if (asked === boxesAsked.current) { setBoxes(b.boxes); setReview(b.review); } })
        .catch((e) => p.onError(msg(e)));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [camera, nodeId],
  );
  useEffect(() => { api.flowNodeFrames(camera, nodeId).then((r) => { setFrames(r.frames); setHasInput(r.has_input); }).catch((e) => p.onError(msg(e))); }, [camera, nodeId, p.version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadBoxes(); }, [loadBoxes, p.version]);

  // A cascade (its input is another detector) works on the boxes that detector found: one picture per found box. A detector
  // further up (on the same picture) can be searched inside too; then it is a choice, the whole picture stays the default.
  const parentId = detail.input && detail.input !== "ingest" ? detail.input : null;
  const parentNames = detail.parent_targets ?? [];
  const sources = [
    ...(parentId ? parentNames.map((n) => ({ det: parentId, slot: n, key: n })) : []),
    ...(detail.search_sources ?? []).flatMap((s) => s.slots.map((n) => ({ det: s.detector, slot: n, key: `${s.detector}|${n}` }))),
  ];
  const selSrc = sources.find((s) => s.key === insidePick) ?? (parentId ? sources[0] : undefined);
  const srcId = selSrc?.det ?? null; // the detector whose box is on show
  useEffect(() => {
    if (!srcId) { setParentBoxes({}); return; }
    let current = true; // the answer for an earlier parent or version must not replace this one
    api.flowBoxes(camera, srcId).then((b) => { if (current) setParentBoxes(b.boxes); }).catch((e) => p.onError(msg(e)));
    return () => { current = false; };
  }, [camera, srcId, p.version]); // eslint-disable-line react-hooks/exhaustive-deps

  // With a Picture edits box above, the detector works on the edited picture (cut and filtered): pictures, thumbnails and coordinates are those of the cut-out.
  const cropped = detail.crops.length > 0;
  const pictureUrl = (f: string) => (cropped ? flowPictureUrl(camera, nodeId, f, { key: detail.crops }) : frameImageUrl(camera, f));
  const thumbUrl = (f: string) => (cropped ? flowPictureUrl(camera, nodeId, f, { size: 96, key: detail.crops }) : frameThumbUrl(camera, f));
  const names = detail.targets.map((t) => t.name);
  // A target that looks for several similar elements has one box per element: "hole 1", "hole 2" (left to right).
  const slotList = detail.targets.flatMap((t, ti) => (t.slots ?? [t.name]).map((slot) => ({ slot, ti })));
  const withExamples = detail.targets.filter((t) => t.examples.length > 0).map((t) => t.name);
  const cardUrl = (f: string) => (cropped ? flowPictureUrl(camera, nodeId, f, { size: 200, key: detail.crops }) : frameWholeThumbUrl(camera, f));
  const chosen = names.includes(target) ? target : names[0] ?? "";
  // A cascade: the input detector's target whose box is on show (this detector's targets each search inside one of them).
  const insideSel = selSrc?.slot ?? "";
  // With no target yet (or "+ New target" picked) a drag starts a new target: the rectangle first, its name next.
  const naming = mode === "draw" && (names.length === 0 || creating);
  const noCrop = useMemo(() => new Set(detail.no_crop ?? []), [detail.no_crop]);
  // A Picture edits box above that follows a detector has no rectangle where that detector found nothing: those pictures cannot be shown.
  const candidates = useMemo(
    () => (srcId ? frames.filter((f) => parentBoxes[f]?.[insideSel]) : frames).filter((f) => !noCrop.has(f)),
    [frames, srcId, parentBoxes, insideSel, noCrop],
  );
  // The position map (v1.169.0): one target slot at a time, of the targets that have examples.
  const mapSlots = slotList.filter((s) => withExamples.includes(detail.targets[s.ti].name));
  const mapOn = mapSlots.find((s) => s.slot === mapSlot) ?? mapSlots[0];
  const zones = useMemo(() => detail.review_zones ?? {}, [detail.review_zones]);
  const reviewSet = useMemo(() => new Set(review), [review]);
  const missingFrames = useMemo(() => candidates.filter((f) => reviewSet.has(f)), [candidates, reviewSet]);
  // What is wrong with each picture (attention.ts): the order of the strip and the cards, and *Outside* (any rule broken).
  const rules = useMemo(() => detail.review_values ?? {}, [detail.review_values]);
  const attention = useMemo(
    () => new Map(candidates.map((f) => [f, attentionOf(f, boxes[f], mapSlots.map((s) => s.slot), zones, pairState, rules)])),
    [candidates, boxes, mapSlots.map((s) => s.slot).join("\u0000"), zones, pairState, rules], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const outsideFrames = useMemo(() => candidates.filter((f) => (attention.get(f)?.reasons.length ?? 0) > 0), [candidates, attention]);
  const outsideTip = useMemo(() => {
    const per = new Map<string, number>();
    for (const f of outsideFrames) for (const r of attention.get(f)!.reasons) per.set(r, (per.get(r) ?? 0) + 1);
    return per.size ? `Outside: ${[...per].map(([r, n]) => `${n} by the ${r}`).join(", ")}` : "Pictures that break a rule: a target's review zone, its score threshold or angle band, or the pair's band / zone";
  }, [outsideFrames, attention]);
  const mapPoints = useMemo(() => {
    const out: Record<string, Pt2 | null> = {};
    if (mapOn) for (const f of candidates) { const b = boxes[f]?.[mapOn.slot]; out[f] = b ? [b.x, b.y] : null; }
    return out;
  }, [candidates, boxes, mapOn?.slot]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => {
    const base = show === "missing" ? missingFrames : show === "outside" ? outsideFrames : candidates;
    const inRange = (f: string) => { const v = pairState?.values[f]; return v != null && pairRange != null && v >= pairRange[0] && v <= pairRange[1]; };
    const near = spot ? base.filter((f) => { const b = boxes[f]?.[spot.slot]; return !!b && Math.hypot(b.x - spot.at[0], b.y - spot.at[1]) <= spot.radius; }) : base;
    const inBoxRange = (f: string) => { const b = boxRange && boxes[f]?.[boxRange.slot]; if (!b || !boxRange) return false; const v = boxValue(b, boxRange.measure); return v >= boxRange.range[0] && v <= boxRange.range[1]; };
    const ranged = (pairRange ? near.filter(inRange) : near).filter((f) => !boxRange || inBoxRange(f));
    return sortByAttention(ranged, attention, sort);
  }, [show, missingFrames, outsideFrames, candidates, spot, boxes, pairRange, pairState, attention, sort, boxRange]);
  const at = Math.min(index, Math.max(0, shown.length - 1));
  const frame = shown[at];
  // The size counts only for the picture it was measured on. It used to be reset to "unknown" by an effect whenever the
  // picture changed; a picture that loads at once (already cached) could report its size before that effect ran, the
  // effect then threw the size away, and the page stayed on its 4:3 placeholder (a stretched picture, no overlay)
  // until a hard refresh.
  const pictureSrc = frame ? pictureUrl(frame) : "";
  const size = useMemo(() => (measured && measured.src === pictureSrc ? { w: measured.w, h: measured.h } : null), [measured, pictureSrc]);
  useEffect(() => setIndex(0), [show, spot, pairRange, sort, boxRange]);
  // The pair map's state: again after a run (version), a change of the pair, or new boxes.
  const savedPair = JSON.stringify(detail.review_pair ?? null);
  useEffect(() => {
    let current = true;
    api.flowPair(camera, nodeId).then((r) => { if (current) setPairState(r); }).catch(() => { if (current) setPairState(null); }); // cosmetic: the page works without it
    return () => { current = false; };
  }, [camera, nodeId, p.version, savedPair, boxes]);
  useEffect(() => setPairRange(null), [detail.review_pair?.op, detail.review_pair?.a, detail.review_pair?.b]);
  useEffect(() => {
    (strip.current?.querySelector('[aria-current="true"]') as HTMLElement | null)?.scrollIntoView?.({ inline: "center", block: "nearest" });
  }, [frame]);

  const start = Math.max(0, Math.min(at - STRIP_WINDOW / 2, shown.length - STRIP_WINDOW));
  const strip60 = shown.slice(start, start + STRIP_WINDOW);
  const found = frame ? boxes[frame] ?? {} : {};
  const missing = slotList.map((s) => s.slot).filter((n) => !(n in found));
  const examplesHere = detail.targets.flatMap((t, ti) =>
    t.examples.flatMap((e, index) => (e.frame === frame ? [{ name: t.name, ti, index, box: e.box as Rect, angle: e.angle ?? 0 }] : [])),
  );
  const statusOf = (f: string) => (detail.status === "none" ? "" : review.includes(f) ? "review" : f in boxes ? "ok" : "");

  // The part of the picture on show: all of it, or (cascade) the padded box the input detector found for this target.
  const view = useMemo(() => {
    if (!size) return null;
    const b = srcId && frame ? parentBoxes[frame]?.[insideSel] : undefined;
    if (!b || wholePictureView) return { x: 0, y: 0, w: size.w, h: size.h, crop: false };
    const t = (b.angle * Math.PI) / 180;
    const hw = (Math.abs(b.w * Math.cos(t)) + Math.abs(b.h * Math.sin(t))) / 2;
    const hh = (Math.abs(b.w * Math.sin(t)) + Math.abs(b.h * Math.cos(t))) / 2;
    const x0 = Math.max(0, Math.floor(b.x - hw * (1 + 2 * detail.pad)));
    const y0 = Math.max(0, Math.floor(b.y - hh * (1 + 2 * detail.pad)));
    const x1 = Math.min(size.w, Math.ceil(b.x + hw * (1 + 2 * detail.pad)));
    const y1 = Math.min(size.h, Math.ceil(b.y + hh * (1 + 2 * detail.pad)));
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0), crop: true };
  }, [size, srcId, frame, parentBoxes, insideSel, detail.pad, wholePictureView]);
  const parentBox = srcId && frame ? parentBoxes[frame]?.[insideSel] : undefined; // the box the input detector found, outlined on the picture

  const point = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const v = view!;
    const inside = (a: number, lo: number, len: number) => Math.min(lo + len, Math.max(lo, a)); // never off the picture on show
    return { x: inside(v.x + ((e.clientX - r.left) / r.width) * v.w, v.x, v.w), y: inside(v.y + ((e.clientY - r.top) / r.height) * v.h, v.y, v.h) };
  };

  useEffect(() => { setSel(null); setEdit(null); setStamp(null); setStampDrag(null); }, [frame, mode]);
  const allExamples = detail.targets.flatMap((t) => t.examples.map((ex, index) => ({ key: `${t.name}\u0000${index}`, name: t.name, index, ex })));
  const source = allExamples.find((e) => e.key === reuseSrc) ?? allExamples.find((e) => e.name === chosen) ?? allExamples[0];
  const [sw, sh] = source ? [source.ex.box[2], source.ex.box[3]] : [0, 0];
  const turnPoint = (s: { cx: number; cy: number; angle: number }) => {
    const t = (s.angle * Math.PI) / 180;
    const d = sh / 2 + 26 / px;
    return { x: s.cx - d * Math.sin(t), y: s.cy - d * Math.cos(t) };
  };
  const insideRotated = (q: { x: number; y: number }, cx: number, cy: number, w: number, h: number, angle: number) => {
    const t = (angle * Math.PI) / 180;
    const [dx, dy] = [q.x - cx, q.y - cy];
    return Math.abs(dx * Math.cos(t) - dy * Math.sin(t)) <= w / 2 && Math.abs(dx * Math.sin(t) + dy * Math.cos(t)) <= h / 2;
  };
  const selected = sel ? examplesHere.find((e) => e.name === sel.name && e.index === sel.index) : undefined;
  useEffect(() => setZoom(FIT_VIEW), [nodeId, view?.crop ? frame : null]); // a cascade shows another window on every picture
  // Screen pixels per picture pixel: handles, labels and the grab distance keep their size at any zoom.
  const px = view ? (fitSize(view.w, view.h, Math.round(paneWidth), Math.round(paneWidth * 0.75)).w * zoom.zoom) / view.w : 1;
  const handleSize = 12 / px;
  const grab = 8 / px;
  const boxOf = (e: { name: string; index: number; box: Rect }): Rect => (edit && sel && sel.name === e.name && sel.index === e.index ? edit.cur : e.box);

  // What a press at q hits in draw mode: a handle of the selected example, else the inside of an example.
  const hitExample = (q: { x: number; y: number }) => {
    if (selected && !selected.angle) { // a turned example can be moved, not resized
      const r = selected.box;
      for (const h of HANDLES) {
        const c = handlePoint(r, h);
        if (Math.abs(q.x - c.x) <= grab && Math.abs(q.y - c.y) <= grab) return { e: selected, kind: h as "move" | Handle };
      }
    }
    for (const e of [...examplesHere].reverse()) {
      if (insideRotated(q, e.box[0] + e.box[2] / 2, e.box[1] + e.box[3] / 2, e.box[2], e.box[3], e.angle)) return { e, kind: "move" as "move" | Handle };
    }
    return null;
  };

  // The cursor says what a press would do, as in the ROI editor: resize arrows on a handle, move over a box, crosshair to draw.
  const under = mode === "draw" && !edit && !drag && hover ? hitExample(hover) : null;
  const cursor = mode === "reuse" ? (stamp ? "move" : "copy") : edit ? grabCursor(edit.kind) : under ? grabCursor(under.kind) : "crosshair";

  const commitEdit = async () => {
    if (!edit || !sel) return;
    const done = edit;
    setEdit(null);
    const [x, y, w, h] = done.cur;
    const changed = done.cur.some((v, i) => Math.round(v) !== Math.round(done.orig[i]));
    if (!changed || !size) return;
    const box = [Math.max(0, Math.round(x)), Math.max(0, Math.round(y)), Math.round(w), Math.round(h)];
    try {
      p.setDetail(await api.flowUpdateExample(camera, nodeId, sel.name, sel.index, box));
      p.onError(null);
      p.onChanged();
    } catch (e) { p.onError(msg(e)); }
  };

  // Esc throws away what is being drawn: a rectangle still being dragged, a move/resize in progress, the unsaved
  // rectangle waiting for its name, or the copy placed by Reuse.
  const busyDrawing = !!(drag || edit || stampDrag || pending || stamp);
  useEffect(() => {
    if (!busyDrawing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setDrag(null); setEdit(null); setStampDrag(null); setPending(null); setStamp(null);
      p.onError(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busyDrawing]); // eslint-disable-line react-hooks/exhaustive-deps

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const q = point(e);
    (e.currentTarget as SVGSVGElement).setPointerCapture?.(e.pointerId);
    if (mode === "reuse") {
      if (!source) return;
      if (stamp) {
        const t = turnPoint(stamp);
        if (Math.hypot(q.x - t.x, q.y - t.y) <= grab * 1.5) { setStampDrag({ kind: "turn", start: q, orig: { cx: stamp.cx, cy: stamp.cy } }); return; }
        if (insideRotated(q, stamp.cx, stamp.cy, sw, sh, stamp.angle)) { setStampDrag({ kind: "move", start: q, orig: { cx: stamp.cx, cy: stamp.cy } }); return; }
      }
      setStamp({ cx: q.x, cy: q.y, angle: stamp?.angle ?? 0 });
      setStampDrag({ kind: "move", start: q, orig: { cx: q.x, cy: q.y } });
      return;
    }
    const hit = mode === "draw" ? hitExample(q) : null;
    if (hit) {
      setSel({ name: hit.e.name, index: hit.e.index });
      setEdit({ kind: hit.kind, start: q, orig: hit.e.box, cur: hit.e.box });
      return;
    }
    setSel(null);
    setDrag({ from: q, to: q });
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (view) setHover(point(e));
    if (stampDrag && stamp) {
      const q = point(e);
      if (stampDrag.kind === "move") {
        setStamp({ ...stamp, cx: stampDrag.orig.cx + (q.x - stampDrag.start.x), cy: stampDrag.orig.cy + (q.y - stampDrag.start.y) });
      } else if (Math.hypot(q.x - stamp.cx, q.y - stamp.cy) > 1) {
        setStamp({ ...stamp, angle: turnTo(Math.round((Math.atan2(-(q.x - stamp.cx), -(q.y - stamp.cy)) * 1800) / Math.PI) / 10) });
      }
      return;
    }
    if (edit) {
      const q = point(e);
      const [dx, dy] = [q.x - edit.start.x, q.y - edit.start.y];
      const [ox, oy, ow, oh] = edit.orig;
      const cur: Rect = edit.kind === "move"
        ? [Math.min(Math.max(0, ox + dx), (size?.w ?? Infinity) - ow), Math.min(Math.max(0, oy + dy), (size?.h ?? Infinity) - oh), ow, oh]
        : resizeRect(edit.orig, edit.kind, dx, dy, 5, size ?? undefined);
      setEdit({ ...edit, cur });
    } else if (drag) {
      setDrag({ from: drag.from, to: point(e) });
    }
  };
  const onUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (stampDrag) { setStampDrag(null); return; }
    if (edit) void commitEdit();
    else void finish(point(e));
  };

  const finish = async (to: { x: number; y: number }) => {
    if (!drag || !frame) return;
    const from = drag.from;
    setDrag(null);
    if (naming) {
      const box = rectOf(from, to);
      if (box[2] < 5 || box[3] < 5) { p.onError("Drag a rectangle around what to find."); return; }
      p.onError(null);
      if (srcId) setNewName((cur) => cur || `${insideSel} detail`);
      setPending({ frame, box });
      return;
    }
    if (!chosen) return;
    try {
      if (mode === "place") {
        await api.flowSetBox(camera, nodeId, frame, chosen, Math.round(stored(to.x) * 10) / 10, Math.round(stored(to.y) * 10) / 10);
        await loadBoxes();
      } else {
        const box = rectOf(from, to);
        if (box[2] < 5 || box[3] < 5) { p.onError("Drag a rectangle around what to find."); return; }
        p.setDetail(await api.flowAddExample(camera, nodeId, chosen, frame, box));
      }
      p.onError(null);
      p.onChanged();
    } catch (e) { p.onError(msg(e)); }
  };

  const addStamped = async () => {
    if (!stamp || !source || !frame || !chosen) return;
    const box = [Math.round(stamp.cx - sw / 2), Math.round(stamp.cy - sh / 2), sw, sh];
    try {
      p.setDetail(await api.flowAddExample(camera, nodeId, chosen, frame, box, stamp.angle));
      setStamp(null);
      p.onError(null);
      p.onChanged();
    } catch (e) { p.onError(msg(e)); }
  };

  const saveNew = async () => {
    const name = newName.trim();
    if (!pending || !name) return;
    try {
      if (!names.includes(name)) await api.flowAddTarget(camera, nodeId, name, srcId ? insideSel : undefined, srcId && srcId !== parentId ? srcId : undefined);
      p.setDetail(await api.flowAddExample(camera, nodeId, name, pending.frame, pending.box));
      setTarget(name);
      setCreating(false);
      setPending(null);
      setNewName("");
      p.onError(null);
      p.onChanged();
    } catch (e) { p.onError(msg(e)); }
  };

  // The review zone of a target slot: saved on the detector box, never makes its run stale (a review aid only).
  const saveZone = async (slot: string, zone: Partial<Zone> | null) => {
    try {
      p.setDetail(await api.flowUpdate(camera, nodeId, { review_zone: { slot, zone } }));
      p.onError(null);
    } catch (e) { p.onError(msg(e)); }
  };
  const saveRule = async (slot: string, change: { score_min?: number | null; angle?: { nominal: number; tolerance: number } | null }) => {
    try {
      p.setDetail(await api.flowUpdate(camera, nodeId, { review_value: { slot, ...change } }));
      p.onError(null);
    } catch (e) { p.onError(msg(e)); }
  };
  const savePair = async (pair: (Partial<Omit<FlowPair, "zone">> & { zone?: Partial<FlowZone> }) | null) => {
    try {
      p.setDetail(await api.flowUpdate(camera, nodeId, { review_pair: pair }));
      p.onError(null);
    } catch (e) { p.onError(msg(e)); }
  };
  const zoneOnDensest = async () => {
    if (!mapOn) return;
    const pts = Object.values(mapPoints).filter((q): q is Pt2 => !!q);
    const at = densestSpot(pts, heatChoice.smoothing);
    if (!at) return;
    const center: Pt2 = [Math.round(at[0] * 10) / 10, Math.round(at[1] * 10) / 10];
    const r = startRadius(pts, center);
    await saveZone(mapOn.slot, zones[mapOn.slot] ? { center } : { shape: "circle", center, radius: r, half: [r, r] });
  };

  return (
    <div className="flow-work">
      <div className="flow-toolbar">
        <div className="flow-segment" role="group" aria-label="What a drag does">
          <button type="button" aria-pressed={mode === "draw"} onClick={() => setMode("draw")}>Draw example</button>
          <button type="button" aria-pressed={mode === "place"} onClick={() => setMode("place")}>Place box</button>
          <button type="button" aria-pressed={mode === "reuse"} disabled={allExamples.length === 0} title="Copy an existing example rectangle onto this picture, turn it, and add it as an example" onClick={() => setMode("reuse")}>Reuse rectangle</button>
        </div>
        {srcId && (
          <div className="flow-segment" role="group" aria-label="View">
            <button type="button" aria-pressed={!wholePictureView} title="Only the found box and its surroundings" onClick={() => setWholePictureView(false)}>Cut-out of the box</button>
            <button type="button" aria-pressed={wholePictureView} title="The whole picture with the found box outlined" onClick={() => setWholePictureView(true)}>Whole picture</button>
          </div>
        )}
        {sources.length > 0 && (
          <div className="flow-chips" role="group" aria-label="Search inside">
            <span className="muted">Search inside:</span>
            {!parentId && (
              <button type="button" className="flow-chip" aria-pressed={!selSrc} title="Draw on the whole picture" onClick={() => { setInsidePick(""); setPending(null); }}>
                whole picture
              </button>
            )}
            {sources.map((s) => (
              <button
                key={s.key}
                type="button"
                className="flow-chip"
                aria-pressed={s.key === selSrc?.key}
                title={`Show the “${s.slot}” box found by ${s.det}`}
                onClick={() => {
                  setInsidePick(s.key);
                  setPending(null);
                  const own = detail.targets.find((t) => t.name === chosen);
                  const ownFrom = own?.inside_from ?? null;
                  if (!own || (own.inside ?? detail.input_point ?? own.name) !== s.slot || ownFrom !== (s.det === parentId ? null : s.det)) setCreating(true); // another box: a new target belongs there
                }}
              >
                {s.det === parentId ? s.slot : `${s.det} · ${s.slot}`}
              </button>
            ))}
          </div>
        )}
        <div className="flow-chips" role="group" aria-label="Target">
          {names.map((name, i) => {
            const t = detail.targets.find((x) => x.name === name);
            return (
              <button
                key={name}
                type="button"
                className="flow-chip"
                aria-pressed={!naming && name === chosen}
                onClick={() => { setTarget(name); setReuseSrc(""); setCreating(false); setPending(null); if (sources.length > 0 && t) setInsidePick(t.inside_from && t.inside ? `${t.inside_from}|${t.inside}` : parentId ? (t.inside ?? detail.input_point ?? t.name) : ""); }}
              >
                <span className="flow-dot" style={{ background: COLORS[i % COLORS.length] }} />
                {name}
                <small>{t?.examples.length ?? 0} ex.{detail.status === "fresh" ? ` · ${(t?.slots ?? [name]).reduce((sum, s) => sum + (detail.summary.found[s] ?? 0), 0)} found` : ""}</small>
              </button>
            );
          })}
          {mode === "draw" && (
            <button type="button" className="flow-chip" aria-pressed={naming} onClick={() => { setCreating(true); setPending(null); }}>
              + New target
            </button>
          )}
        </div>
      </div>
      <p className="muted">
        {parentId && sources.length === 0
          ? "Run the detector before this one first (and give it a target): the pictures here are the boxes it finds."
          : srcId && candidates.length === 0
            ? `${srcId} has no box named “${insideSel}” on any picture yet. Run it first.`
            : srcId && naming
              ? `Each picture is the “${insideSel}” box found by ${srcId}, with its surroundings. Drag a rectangle around what to find in it (the hole, say); you name the new target next. Pick another box above to give a target to another part.`
              : srcId && mode === "draw"
                ? `Each picture is the “${insideSel}” box found by ${srcId}. Drag a rectangle to add an example to “${chosen}”, or click an example rectangle to move or resize it. “+ New target” starts another target.`
                : naming
                  ? "Drag a rectangle around what to find (one hole, say) and include the geometry that tells it from its twin. You name it next."
                  : mode === "draw"
                    ? `Drag a rectangle around the “${chosen}”. Include the geometry that tells it from its twin. Click a rectangle to move or resize it; run again afterwards.`
                    : mode === "reuse"
                      ? `Click on the picture to put a copy of the chosen rectangle there, drag it to move it, drag the round handle above it (or type the turn) to rotate it, then add it as an example of “${chosen}”.`
                      : chosen
                      ? `Click where the centre of “${chosen}” is. Your box stays when the detector runs again.`
                      : "Draw an example of a target first."}
      </p>
      {mode === "reuse" && source && (
        <form className="flow-name" aria-label="Reuse rectangle" onSubmit={(e) => { e.preventDefault(); void addStamped(); }}>
          <label>
            Rectangle{" "}
            <select
              value={source.key}
              onChange={(e) => { const next = allExamples.find((x) => x.key === e.target.value); setReuseSrc(e.target.value); if (next) setTarget(next.name); setStamp(null); }}
            >
              {allExamples.map((x) => <option key={x.key} value={x.key}>{x.name} · example {x.index + 1} ({x.ex.box[2]} × {x.ex.box[3]}){x.ex.angle ? `, turned ${x.ex.angle}°` : ""}</option>)}
            </select>
          </label>
          <img src={source.ex.png} alt={`Example ${source.index + 1} of ${source.name}`} style={{ maxHeight: 48, maxWidth: 96, border: "1px solid var(--border)" }} />
          <label>
            Turn (°){" "}
            <input
              type="number"
              step={1}
              aria-label="Turn in degrees"
              style={{ width: 70 }}
              disabled={!stamp}
              value={stamp ? stamp.angle : 0}
              onChange={(e) => { const v = Number(e.target.value); if (stamp && Number.isFinite(v)) setStamp({ ...stamp, angle: turnTo(v) }); }}
            />
          </label>
          <button type="submit" disabled={!stamp || !frame}>Add as example to {chosen}</button>
          <button type="button" disabled={!stamp} onClick={() => setStamp(null)}>Cancel</button>
        </form>
      )}
      {pending && naming && (
        <form className="flow-name" onSubmit={(e) => { e.preventDefault(); void saveNew(); }}>
          <label>
            What is this? (the name of the target)
            <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="left hole" />
          </label>
          <button type="submit" disabled={!newName.trim()}>Save target</button>
          <button type="button" onClick={() => setPending(null)}>Cancel</button>
        </form>
      )}

      {frame ? (
        <>
          <PictureSizeSlider value={paneWidth} onChange={setPaneWidth} min={200} max={1600} />
          <ZoomPane
            imageSize={view ? { w: view.w, h: view.h } : { w: 4, h: 3 }}
            width={paneWidth}
            view={zoom}
            onViewChange={setZoom}
            contentRef={contentRef}
            contentTestId="flow-canvas"
            contentCursor={cursor}
            info={[
              hover ? `pixel ${Math.floor(hover.x)}, ${Math.floor(hover.y)}` : null,
              drag && mode === "draw" ? `rectangle ${rectOf(drag.from, drag.to)[2]} × ${rectOf(drag.from, drag.to)[3]} px (Esc cancels)` : null,
            ].filter(Boolean).join("  |  ")}
          >
            <img
              src={pictureSrc}
              alt={frame}
              draggable={false}
              style={view?.crop ? { display: "none" } : { width: "100%", height: "100%", display: "block" }}
              onLoad={(e) => { if (e.currentTarget.naturalWidth && e.currentTarget.naturalHeight) setMeasured({ src: pictureSrc, w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }); }}
            />
            {size && view && (
              <svg
                ref={svg}
                viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", touchAction: "none" }}
                data-testid="flow-overlay"
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerLeave={() => setHover(null)}
              >
                {view.crop && <image href={pictureSrc} x={0} y={0} width={size.w} height={size.h} />}
                {parentBox && (
                  <g transform={`translate(${parentBox.x} ${parentBox.y}) rotate(${-parentBox.angle})`} pointerEvents="none" data-testid="parent-box">
                    <rect x={-parentBox.w / 2} y={-parentBox.h / 2} width={parentBox.w} height={parentBox.h} fill="none" stroke="rgba(0,0,0,.75)" strokeWidth={4} vectorEffect="non-scaling-stroke" />
                    <rect x={-parentBox.w / 2} y={-parentBox.h / 2} width={parentBox.w} height={parentBox.h} fill="none" stroke="#fff" strokeWidth={1.5} strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
                  </g>
                )}
                {examplesHere.map((e) => {
                  const b = boxOf(e);
                  const active = sel?.name === e.name && sel.index === e.index;
                  return (
                    <g key={`ex${e.name}${e.index}`} transform={e.angle ? `rotate(${-e.angle} ${b[0] + b[2] / 2} ${b[1] + b[3] / 2})` : undefined}>
                      {/* a dark line under the coloured one keeps it visible on a white part of the picture */}
                      <rect x={b[0]} y={b[1]} width={b[2]} height={b[3]} fill="none" stroke="rgba(0,0,0,.75)" strokeWidth={4} vectorEffect="non-scaling-stroke" pointerEvents="none" />
                      <rect x={b[0]} y={b[1]} width={b[2]} height={b[3]} fill={active ? ROI_FILL : under?.e.name === e.name && under.e.index === e.index ? ROI_HOVER : "none"} stroke={active ? ROI_RED : COLORS[e.ti % COLORS.length]} strokeWidth={2} strokeDasharray={active ? undefined : "6 3"} vectorEffect="non-scaling-stroke" data-testid="example-rect" />
                      {active && !e.angle && HANDLES.map((h) => {
                        const c = handlePoint(b, h);
                        return <rect key={h} data-testid={`handle-${h}`} x={c.x - handleSize / 2} y={c.y - handleSize / 2} width={handleSize} height={handleSize} fill={ROI_RED} stroke="#fff" strokeWidth={1} vectorEffect="non-scaling-stroke" />;
                      })}
                    </g>
                  );
                })}
                {slotList.map(({ slot: n, ti: i }) => {
                  const b = found[n] && drawn(found[n]);
                  if (!b) return null;
                  const color = COLORS[i % COLORS.length];
                  return (
                    <g key={n} transform={`translate(${b.x} ${b.y}) rotate(${-b.angle})`} pointerEvents="none">
                      <rect x={-b.w / 2} y={-b.h / 2} width={b.w} height={b.h} fill="none" stroke="rgba(0,0,0,.75)" strokeWidth={5} vectorEffect="non-scaling-stroke" />
                      <rect x={-b.w / 2} y={-b.h / 2} width={b.w} height={b.h} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                      <circle r={3 / px} fill={color} stroke="#000" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                      <text x={-b.w / 2} y={-b.h / 2 - 3 / px} fontSize={13 / px} fill={color} stroke="#000" strokeWidth={3} paintOrder="stroke" strokeLinejoin="round">{n}{b.source === "human" ? " ✎" : ""}</text>
                    </g>
                  );
                })}
                {mode === "reuse" && stamp && source && (() => {
                  const t = turnPoint(stamp);
                  return (
                    <g pointerEvents="none" data-testid="stamp">
                      <g transform={`translate(${stamp.cx} ${stamp.cy}) rotate(${-stamp.angle})`}>
                        <rect x={-sw / 2} y={-sh / 2} width={sw} height={sh} fill="none" stroke="rgba(0,0,0,.75)" strokeWidth={4} vectorEffect="non-scaling-stroke" />
                        <rect x={-sw / 2} y={-sh / 2} width={sw} height={sh} fill={ROI_FILL} stroke={ROI_RED} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                        <line x1={0} y1={-sh / 2} x2={0} y2={-sh / 2 - 26 / px} stroke={ROI_RED} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                      </g>
                      <circle data-testid="stamp-turn" cx={t.x} cy={t.y} r={6 / px} fill={ROI_RED} stroke="#fff" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                    </g>
                  );
                })()}
                {pending && pending.frame === frame && (
                  <rect x={pending.box[0]} y={pending.box[1]} width={pending.box[2]} height={pending.box[3]} fill={ROI_FILL} stroke={ROI_RED} strokeWidth={2} strokeDasharray="6 3" vectorEffect="non-scaling-stroke" pointerEvents="none" />
                )}
                {drag && mode === "draw" && (() => { const r = rectOf(drag.from, drag.to); return <rect x={r[0]} y={r[1]} width={r[2]} height={r[3]} fill={ROI_FILL} stroke={ROI_RED} strokeWidth={2} vectorEffect="non-scaling-stroke" pointerEvents="none" />; })()}
              </svg>
            )}
          </ZoomPane>
        </>
      ) : (
        <p className="muted">{spot || pairRange || boxRange ? "No pictures there." : show === "missing" ? "Every target was found on every picture." : show === "outside" ? "No picture is outside a zone." : hasInput ? "No pictures reach this box yet." : "Nothing is drawn into this box, so it has no pictures. Draw a line into it on the Chain."}</p>
      )}

      <div className="flow-nav">
        <button type="button" disabled={at <= 0} onClick={() => setIndex(at - 1)}>‹ Previous</button>
        <button type="button" disabled={at >= shown.length - 1} onClick={() => setIndex(at + 1)}>Next ›</button>
        <span className="muted">{shown.length ? `${at + 1} / ${shown.length} · ${frame}` : ""}</span>
        {missing.length > 0 && detail.status === "fresh" && frame && <span role="status" className="flow-missing">Not found here: {missing.join(", ")}</span>}
        {noCrop.size > 0 && <span role="status" className="flow-missing">{noCrop.size} picture{noCrop.size === 1 ? "" : "s"} not shown: the Picture edits box above has no rectangle there (its detector found no target).</span>}
        <label className="flow-nav-right" title="The order of the strip and the cards: not found first, then the furthest outside a zone or band, then the weakest match">
          Sort{" "}
          <select aria-label="Sort pictures" value={sort} onChange={(e) => chooseSort(e.target.value as AttentionSort)}>
            {ATTENTION_SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </label>
        <span className="flow-segment" role="group" aria-label="Show pictures">
          <button type="button" aria-pressed={show === "all"} onClick={() => setShow("all")}>All ({candidates.length})</button>
          <button type="button" aria-pressed={show === "missing"} title="Pictures where a target with examples has no box" onClick={() => setShow("missing")}>Not found ({missingFrames.length})</button>
          <button type="button" aria-pressed={show === "outside"} title={outsideTip} onClick={() => setShow("outside")}>Outside ({outsideFrames.length})</button>
        </span>
      </div>

      {spot && (
        <p role="status" className="flow-spot">
          Only the pictures where “{spot.slot}” was found near x {spot.at[0].toFixed(0)}, y {spot.at[1].toFixed(0)}: {shown.length}{" "}
          <button type="button" onClick={() => setSpot(null)}>Show all</button>
        </p>
      )}
      {boxRange && (
        <p role="status" className="flow-spot">
          Only the pictures whose “{boxRange.slot}” {boxRange.measure === "score" ? "match score" : "angle"} is {boxRange.range[0].toFixed(2)} to {boxRange.range[1].toFixed(2)}: {shown.length}{" "}
          <button type="button" onClick={() => setBoxRange(null)}>Show all</button>
        </p>
      )}
      {pairRange && (
        <p role="status" className="flow-spot">
          Only the pictures whose pair value is {pairRange[0].toFixed(1)} to {pairRange[1].toFixed(1)} {pairState?.unit}: {shown.length}{" "}
          <button type="button" onClick={() => setPairRange(null)}>Show all</button>
        </p>
      )}
      <div className="flow-strip" ref={strip} aria-label="Pictures">
        {strip60.map((f) => (
          <button key={f} type="button" aria-label={`Show ${f}`} aria-current={f === frame} title={f} className={`flow-thumb ${statusOf(f)}`} onClick={() => setIndex(shown.indexOf(f))}>
            <img src={thumbUrl(f)} alt="" loading="lazy" />
          </button>
        ))}
      </div>

      {detail.status !== "none" && mapOn && (
        <details className="flow-position" open>
          <summary>Position map: where each target was found</summary>
          <div className="flow-nav">
            {mapSlots.length > 1 && (
              <span className="flow-segment" role="group" aria-label="Target on the map">
                {mapSlots.map((s) => (
                  <button key={s.slot} type="button" aria-pressed={s.slot === mapOn.slot} onClick={() => { setMapSlot(s.slot); setSpot(null); }}>
                    <span className="flow-dot" style={{ background: COLORS[s.ti % COLORS.length] }} /> {s.slot}
                  </button>
                ))}
              </span>
            )}
            <HeatControls choice={heatChoice} />
            <button type="button" title="Put the review zone on the densest spot of this target (the red top of the heat map), sized to hold most of the pictures" onClick={() => void zoneOnDensest()}>
              Put the zone on the densest spot
            </button>
            {zones[mapOn.slot] && (
              <>
                <span className="flow-segment" role="group" aria-label="Zone shape">
                  <button type="button" aria-pressed={zones[mapOn.slot].shape === "circle"} onClick={() => void saveZone(mapOn.slot, { shape: "circle" })}>Circle</button>
                  <button type="button" aria-pressed={zones[mapOn.slot].shape === "rect"} onClick={() => void saveZone(mapOn.slot, { shape: "rect" })}>Rectangle</button>
                </span>
                <button type="button" onClick={() => void saveZone(mapOn.slot, null)}>Remove zone</button>
              </>
            )}
          </div>
          <PositionMap
            points={mapPoints}
            extent={!srcId && size ? size : null}
            zone={zones[mapOn.slot] ?? null}
            onZone={(z) => void saveZone(mapOn.slot, z)}
            onSpot={(at, radius) => setSpot({ slot: mapOn.slot, at, radius })}
            heat={heatChoice.heatOn ? { smoothing: heatChoice.smoothing } : null}
            missing={Object.values(mapPoints).filter((q) => !q).length}
            label={mapOn.slot}
          />
        </details>
      )}

      {detail.status !== "none" && mapOn && (
        <details className="flow-position" open>
          <summary>Box values of “{mapOn.slot}”: match score{detail.rotate ? " and angle" : ""}</summary>
          <div className="flow-nav">
            <span className="flow-segment" role="group" aria-label="Box value">
              <button type="button" aria-pressed={boxMeasure === "score" || !detail.rotate} onClick={() => { setBoxMeasure("score"); setBoxRange(null); }}>Match score</button>
              {detail.rotate && <button type="button" aria-pressed={boxMeasure === "angle"} onClick={() => { setBoxMeasure("angle"); setBoxRange(null); }}>Angle</button>}
            </span>
            <span className="muted">The target is the one chosen on the position map.</span>
          </div>
          <BoxValues
            slot={mapOn.slot}
            measure={detail.rotate ? boxMeasure : "score"}
            values={candidates.map((f) => boxes[f]?.[mapOn.slot]).filter((b): b is FlowBox => !!b).map((b) => boxValue(b, detail.rotate ? boxMeasure : "score"))}
            rule={rules[mapOn.slot]}
            save={(change) => void saveRule(mapOn.slot, change)}
            range={boxRange && boxRange.slot === mapOn.slot && boxRange.measure === (detail.rotate ? boxMeasure : "score") ? boxRange.range : null}
            onRange={(r) => setBoxRange(r ? { slot: mapOn.slot, measure: detail.rotate ? boxMeasure : "score", range: r } : null)}
          />
        </details>
      )}

      {detail.status !== "none" && mapSlots.length >= 2 && (
        <details className="flow-position" open>
          <summary>Pair map: two targets against each other</summary>
          <PairMap slots={mapSlots.map((s) => s.slot)} state={pairState} save={(pair) => void savePair(pair)} heatChoice={heatChoice} range={pairRange} onRange={setPairRange} />
        </details>
      )}

      {detail.status !== "none" && withExamples.length > 0 && (
        <DetectorGrid
          frames={shown}
          boxes={boxes}
          targets={withExamples}
          current={frame}
          size={size}
          imageUrl={cardUrl}
          reason={(f) => attentionText(attention.get(f))}
          onPick={(f) => {
            setIndex(Math.max(0, shown.indexOf(f)));
            contentRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
          }}
        />
      )}
    </div>
  );
}

function ValuesWork(p: {
  camera: string;
  nodeId: string;
  detail: Exclude<FlowNodeDetail, FlowDetector | FlowCrop>;
  setDetail: (d: FlowNodeDetail) => void;
  version: number;
  onError: (e: string | null) => void;
}) {
  const { camera, nodeId, detail } = p;
  const [data, setData] = useState<FlowValues | null>(null);
  const [show, setShow] = useState<"all" | "pass" | "fail" | "undetermined">("all");
  const tolerance = detail.kind === "evaluation" ? detail : null;
  const zoneMode = tolerance?.mode === "zone";
  const stamp = JSON.stringify(detail);

  useEffect(() => {
    api.flowValues(camera, nodeId).then(setData).catch((e) => p.onError(msg(e)));
  }, [camera, nodeId, stamp, p.version]); // eslint-disable-line react-hooks/exhaustive-deps

  // Labeling on the cards: the Classifiers that show this Evaluation (one is chosen when there are several).
  const [labelFeature, setLabelFeature] = useState<string | undefined>(undefined);
  const [labeling, setLabeling] = useState<FlowLabeling | null>(null);
  useEffect(() => {
    if (detail.kind !== "evaluation") { setLabeling(null); return; }
    api.flowLabeling(camera, nodeId, labelFeature).then(setLabeling).catch(() => setLabeling(null)); // cosmetic
  }, [camera, nodeId, labelFeature, p.version, detail.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const [range, setRange] = useState<[number, number] | null>(null);
  const [showChart, setShowChart] = useState(() => {
    try { return localStorage.getItem(CHART_STORE) !== "off"; } catch { return true; }
  });
  useEffect(() => setRange(null), [nodeId]);
  const heatChoice = useHeatChoice();
  const { heatOn, smoothing } = heatChoice;
  const chooseChart = (on: boolean) => {
    setShowChart(on);
    try { localStorage.setItem(CHART_STORE, on ? "on" : "off"); } catch { /* not remembered */ }
  };
  // The geometry behind each number: the calc box's two points and the boxes its detector found.
  const [calc, setCalc] = useState<FlowCalc | null>(null);
  const [foundBoxes, setFoundBoxes] = useState<Record<string, Record<string, FlowBox>>>({});
  const calcId = detail.kind === "calc" ? nodeId : detail.kind === "evaluation" ? detail.calc : null;
  useEffect(() => {
    if (!calcId) { setCalc(null); return; }
    api.flowNode(camera, calcId).then((d) => setCalc(d.kind === "calc" ? d : null)).catch(() => setCalc(null)); // cosmetic
  }, [camera, calcId, stamp, p.version]); // eslint-disable-line react-hooks/exhaustive-deps
  // One detector gives both points, or two detectors that work on the same picture (their boxes are drawn together).
  const src = calc?.point_sources;
  const detectorId = calc?.input ?? (calc?.same_picture && src ? src.a[0] : null);
  const detectorB = calc && !calc.input && calc.same_picture && src && src.b[0] !== src.a[0] ? src.b[0] : null;
  // Two detectors behind different crops: their boxes are in different pictures, so the server moves both onto the whole picture.
  const wholePicture = !!calc && !!src && !detectorId;
  useEffect(() => {
    if (!wholePicture || !calcId) return;
    let current = true;
    api.flowCalcBoxes(camera, calcId).then((r) => { if (current) setFoundBoxes(r.boxes); }).catch(() => { if (current) setFoundBoxes({}); });
    return () => { current = false; };
  }, [camera, calcId, wholePicture, stamp, p.version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!detectorId) { if (!wholePicture) setFoundBoxes({}); return; }
    let current = true;
    const second = detectorB ? api.flowBoxes(camera, detectorB) : Promise.resolve(null);
    Promise.all([api.flowBoxes(camera, detectorId), second]).then(([first, other]) => {
      if (!current) return;
      if (!other || !src || !calc) { setFoundBoxes(first.boxes); return; }
      // two detectors: each point keeps its own target's box, keyed by the point's name so the drawing finds it
      const merged: Record<string, Record<string, FlowBox>> = {};
      for (const [frame, boxes] of Object.entries(first.boxes)) {
        const a = boxes[src.a[1]];
        const b = other.boxes[frame]?.[src.b[1]];
        merged[frame] = { ...(a && calc.a ? { [calc.a]: a } : {}), ...(b && calc.b ? { [calc.b]: b } : {}) };
      }
      setFoundBoxes(merged);
    }).catch(() => { if (current) setFoundBoxes({}); });
    return () => { current = false; };
  }, [camera, detectorId, detectorB, p.version]); // eslint-disable-line react-hooks/exhaustive-deps
  // On an Evaluation page the viewer also draws the pass region of the rule (zone, angle wedge, distance ring, dx / dy band).
  const evalSpec = useMemo<EvalSpec | null>(
    () => (tolerance && calc ? { mode: tolerance.mode, op: calc.op, zone: tolerance.zone, nominal: tolerance.nominal, tolerance: tolerance.tolerance, clockwise: calc.clockwise, unit: tolerance.unit } : null),
    [tolerance, calc],
  );
  // The reference picture: the one nearest the nominal (zone centre), shown in the viewer while Space is held.
  const reference = useMemo(() => {
    if (!tolerance || !data) return null;
    const all = Object.entries(data.values).map(([frame, value]) => ({ frame, value, verdict: data.verdicts?.[frame], point: data.points?.[frame] ?? null, deviation: data.deviations?.[frame] ?? null }));
    const frame = referenceFrame(all, { mode: tolerance.mode ?? "tolerance", nominal: tolerance.nominal ?? null, centre: tolerance.zone?.center ?? null, wrap: !!tolerance.wrap });
    return all.find((r) => r.frame === frame) ?? null;
  }, [tolerance, data]);
  const viewer = useMemo<ViewerExtras | undefined>(() => {
    // Only the reference picture (hold Space) when no boxes can be drawn: it needs just the nominal, not the detectors.
    if (!calc || !calc.a || !calc.b || (!detectorId && !wholePicture)) return reference ? { reference } : undefined;
    const names: [string, string] = [calc.a, calc.b];
    const cropped = !!detectorId && (calc.crops ?? []).length > 0;
    return {
      reference,
      // boxes are in the picture the detector works on: the cut-out, when a Crop box is above it (on the whole picture for two detectors behind different crops)
      imageUrl: cropped ? (frame) => flowPictureUrl(camera, detectorId!, frame, { key: calc.crops }) : undefined,
      // point A of the Calculate box on this picture: what the viewer's "Fix reference point" keeps in place
      fixPoint: (row) => {
        const a = foundBoxes[row.frame]?.[names[0]];
        return a ? { x: drawn(a).x, y: drawn(a).y } : null;
      },
      overlay: (row, size) => (
        <CalcGeometry size={size} op={calc.op} names={names} clockwise={calc.clockwise} boxes={foundBoxes[row.frame]} value={row.value} unit={calc.op === "angle" ? "°" : "px"} evaluation={evalSpec ? { spec: evalSpec, verdict: row.verdict } : undefined} />
      ),
      note: (row) => {
        const found = foundBoxes[row.frame] ?? {};
        const missing = names.filter((n) => !found[n]);
        if (missing.length) return `not found here: ${missing.join(", ")}`;
        // an Evaluation by a zone draws A, B and the zone over the picture: the operation and point names would only repeat it
        return evalSpec?.mode === "zone" ? null : `${calc.operations[calc.op] ?? calc.op}: ${names[0]} → ${names[1]}`;
      },
    };
  }, [calc, detectorId, wholePicture, foundBoxes, camera, evalSpec, reference]);

  const counts = data?.counts ?? tolerance?.counts;
  // The cards show the whole picture (the cut-out when a Picture edits box is above the detector), not the camera's centre-cropped square.
  const cardThumb = useMemo(
    () => (calc && detectorId && (calc.crops ?? []).length > 0 ? (f: string) => flowPictureUrl(camera, detectorId, f, { size: 200, key: calc.crops }) : (f: string) => frameWholeThumbUrl(camera, f)),
    [calc, detectorId, camera],
  );
  const numbers = useMemo(() => Object.values(data?.values ?? {}).filter((v): v is number => v !== null), [data]);

  const rows = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.values)
      .map(([frame, value]) => ({ frame, value, verdict: data.verdicts?.[frame], point: data.points?.[frame] ?? null, deviation: data.deviations?.[frame] ?? null }))
      .filter((r) => show === "all" || r.verdict === show)
      .filter((r) => !range || (r.value !== null && r.value >= range[0] && r.value <= range[1]))
      .sort((a, b) => (a.value ?? Infinity) - (b.value ?? Infinity) || a.frame.localeCompare(b.frame));
  }, [data, show, range]);

  const useAsNominal = async (value: number) => {
    try {
      p.setDetail(await api.flowUpdate(camera, nodeId, { nominal: Number(value.toFixed(2)) }));
      p.onError(null);
    } catch (e) { p.onError(msg(e)); }
  };

  // The densest spot of the pictures shown (Show filter and range apply), taken as the nominal: the peak of the heat map.
  const useDensest = () => {
    if (zoneMode) {
      const spot = densestSpot(rows.map((r) => r.point).filter((q): q is [number, number] => !!q), smoothing);
      if (spot) void setZone({ center: [Math.round(spot[0] * 10) / 10, Math.round(spot[1] * 10) / 10] });
    } else {
      const v = densestValue(rows.map((r) => r.value).filter((x): x is number => x !== null), !!tolerance?.wrap);
      if (v !== null) void useAsNominal(v);
    }
  };

  const setZone = async (zone: Partial<Zone>) => {
    try {
      p.setDetail(await api.flowUpdate(camera, nodeId, { zone }));
      p.onError(null);
    } catch (e) { p.onError(msg(e)); }
  };

  const setBand = async (b: { nominal: number; tolerance: number }) => {
    try {
      p.setDetail(await api.flowUpdate(camera, nodeId, b));
      p.onError(null);
    } catch (e) { p.onError(msg(e)); }
  };

  if (detail.kind === "calc" && detail.points.length < 2) {
    return <p className="flow-empty">Connect a detector with two named targets to this box on the Chain; its values then appear here.</p>;
  }
  if (tolerance && !tolerance.calc) {
    return <p className="flow-empty">Connect a Calculate box to this box on the Chain; its values then appear here.</p>;
  }
  const unit = data?.unit ?? "";
  return (
    <div className="flow-work">
      {tolerance && zoneMode && showChart && (
        <ZoneScatter
          points={data?.points ?? {}}
          zone={tolerance.zone}
          onZone={(z) => void setZone(z)}
          onCentre={(at) => void setZone({ center: at })}
          visible={new Set(rows.map((r) => r.frame))}
          heat={heatOn ? { points: rows.map((r) => r.point).filter((q): q is [number, number] => !!q), smoothing } : null}
        />
      )}
      {tolerance && !zoneMode && showChart && (
        <EvaluationHistogram
          detail={tolerance}
          values={numbers}
          range={range}
          onRange={setRange}
          onPick={(v) => void useAsNominal(v)}
          onBand={(b) => void setBand(b)}
        />
      )}
      <div className="flow-nav">
        {tolerance && (
          <label>
            <input type="checkbox" checked={showChart} onChange={(e) => chooseChart(e.target.checked)} /> {zoneMode ? "Chart" : "Histogram"}
          </label>
        )}
        {tolerance && zoneMode && showChart && (
          <>
            <HeatControls choice={heatChoice} />
          </>
        )}
        {tolerance && (
          <button type="button" title="Take the densest spot of the pictures shown below (the red top of the heat map) as the nominal" onClick={useDensest}>
            Use densest spot as nominal
          </button>
        )}
        {tolerance && (
          <span className="flow-segment" role="group" aria-label="Show">
            {(["all", "pass", "fail", "undetermined"] as const)
              .filter((k) => k !== "undetermined" || (counts?.undetermined ?? 0) > 0 || show === k)
              .map((k) => (
                <button key={k} type="button" aria-pressed={show === k} onClick={() => setShow(k)}>
                  {k === "all" ? "All" : k === "pass" ? "Pass" : k === "fail" ? "Fail" : "Undetermined"}
                  {counts ? ` (${k === "all" ? counts.pass + counts.fail + counts.undetermined : counts[k]})` : ""}
                </button>
              ))}
          </span>
        )}
        {range && (
          <button type="button" className="flow-range" title="Show all values again (right-click on the chart does the same)" onClick={() => setRange(null)}>
            range {range[0]}–{range[1]} {unit} ✕
          </button>
        )}
        {labeling && labeling.features.length > 1 && (
          <label title="The Classifier the label buttons and number keys on the cards go to">
            Label for{" "}
            <select value={labeling.feature ?? ""} onChange={(e) => setLabelFeature(e.target.value)}>
              {labeling.features.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
        )}
        <span className="muted">{rows.length} picture{rows.length === 1 ? "" : "s"}, sorted by value</span>
      </div>
      <ValueGrid
        labeling={labeling?.feature ? { feature: labeling.feature, classes: labeling.classes, marks: labeling.marks, onError: p.onError } : undefined}
        camera={camera}
        rows={rows}
        unit={unit}
        viewer={viewer}
        thumb={cardThumb}
        onNominal={tolerance && !zoneMode ? (v) => void useAsNominal(v) : undefined}
        onCentre={zoneMode ? (r) => { if (r.point) void setZone({ center: [Math.round(r.point[0] * 10) / 10, Math.round(r.point[1] * 10) / 10] }); } : undefined}
        info={zoneMode ? (r, where) => {
          // the card gives the distance a line of its own; the viewer keeps everything on one line
          const distance = r.deviation && r.value !== null ? zoneDistanceText(r.value) : null;
          return (
            <>
              <strong>{zoneOffsetText(r.deviation ?? r.point)}</strong>
              {distance && where === "viewer" && <strong> · {distance}</strong>} <VerdictWord verdict={r.verdict} />
              {distance && where === "card" && <div data-testid="card-distance">{distance}</div>}
            </>
          );
        } : undefined}
      />
    </div>
  );
}
