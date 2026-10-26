import { Box } from "./roiGeometry";
import { MaskShape } from "./shapeGeometry";
import { breadcrumb, report } from "./clientLog";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string | null,
    message: string,
  ) {
    super(message);
  }
}

/** Fired on window after every successful request that is not a GET. */
export const DATA_CHANGED = "picturesorter:changed";
/** Fired when products were renamed (detail: old name -> new name), so a page that remembers one can follow. */
export const PRODUCTS_RENAMED = "picturesorter:products-renamed";

const newRequestId = (): string => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-6);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // The id travels to the backend (X-Request-ID) so a failure here and its server-side traceback share one id.
  const rid = newRequestId();
  const method = init?.method ?? "GET";
  const withId: RequestInit = { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), "X-Request-ID": rid } };
  if (method !== "GET") breadcrumb(`${method} ${path.split("?")[0]}`);
  let res: Response;
  try {
    res = await fetch(`/api${path}`, withId);
  } catch (e) {
    report("error", `Network error: ${method} /api${path.split("?")[0]}: ${e instanceof Error ? e.message : String(e)}`, { request_id: rid });
    throw e;
  }
  if (!res.ok) {
    let code: string | null = null;
    let detail = res.statusText || `HTTP ${res.status}`;
    try {
      const body = await res.json();
      code = body.error ?? null;
      detail = body.detail ?? detail;
    } catch {
      /* non-JSON error body */
    }
    if (res.status >= 500) report("error", `${method} /api${path.split("?")[0]} -> ${res.status}: ${detail}`, { request_id: res.headers?.get?.("X-Request-ID") ?? rid });
    throw new ApiError(res.status, code, String(detail));
  }
  // Anything that changed data (a label, a delete, a mute ...) tells the parts of the page that show
  // totals, such as the step bar, to look again.
  if ((init?.method ?? "GET") !== "GET") window.dispatchEvent(new Event(DATA_CHANGED));
  return (await res.json()) as T;
}

/** One stored log record (`GET /api/logs`). */
export interface LogRecord {
  id: number;
  ts: number;
  level: string;
  source: string;
  logger: string;
  message: string;
  request_id: string | null;
  camera: string | null;
  job_id: string | null;
  duration_ms: number | null;
  exc: string | null;
  extra: string | null;
  audit: number;
}

export interface LogQuery {
  level?: string;
  source?: string;
  camera?: string;
  request_id?: string;
  since_restart?: boolean;
  limit?: number;
}

export interface FeatureStatus {
  feature: string;
  short_name: string;
  owner_product: string | null;
  shared_products: string[] | null;
  role: string;
  classes: string[];
  labeled: Record<string, number>;
  goldens: Record<string, number>;
  unlabeled: number;
  total: number;
  version_count: number;
  active_version: number | null;
}

export interface CameraStatus {
  camera: string;
  frame_count: number;
  feature_count: number;
  products: string[];
  features: FeatureStatus[];
}

/** A value measured by the downstream training/inspection system on a dataset exported from a version. */
export interface VersionResult {
  id: number;
  version_id: number;
  name: string;
  value: number;
  note: string;
  /** The day the value refers to, YYYY-MM-DD. */
  measured: string;
  created: number;
}

export interface ResultInput {
  name: string;
  value: number;
  note: string;
  measured: string;
}

export interface VersionInfo {
  id: number;
  number: number;
  name: string;
  notes: string;
  created: number;
  counts: Record<string, number>;
  stats: Record<string, Record<string, number>> & {
    vision?: VisionSnapshot;
    rules?: {
      edge_angle?: { settings: EdgeAngleSettings; results: string; summary: EdgeSummary | null };
      measurement?: { box: string; nominal?: number | null; tolerance?: number; zone?: FlowZone; counts: { pass: number; fail: number; undetermined: number } }[];
    };
    augmentation?: { ranges: MotionRanges; coverage: number; results: string; reference: string | null; unit: string };
  };
  active: boolean;
  deleted: number | null;
  delta: string;
  results?: VersionResult[];
}

export interface VersionsResponse {
  feature: string;
  classes: string[];
  counts: Record<string, number>;
  versions: VersionInfo[];
  /** Every metric name recorded on any version of this feature. */
  result_names?: string[];
}

export interface ProjectVersionsResponse {
  /** The live verdict counts (what a freeze without the goldens-only option would take). */
  summary: VerdictSummary;
  /** What a goldens-only freeze would take now: golden pictures that have an OK / NG verdict. */
  golden_verdicts?: { ok: number; ng: number };
  versions: VersionInfo[];
  result_names?: string[];
}

export interface ExportReport {
  destination: string;
  written: number;
  missing: string[];
  hash_mismatch: string[];
}

export interface Job<R = unknown> {
  id: string;
  kind: string;
  camera: string;
  feature: string | null;
  status: "queued" | "running" | "done" | "error";
  progress: Record<string, unknown>;
  result: R | null;
  error: string | null;
}

export interface IngestResult {
  added: number;
  skipped: string[];
  errors: string[];
}

/** A picture of the camera as Ingest lists it: the file name it came in under and when it was ingested (epoch seconds). */
export interface IngestedFrame {
  frame: string;
  name: string;
  created: number;
}

/** A picture as the Ingest table sees it: its size (0 × 0 = unreadable), when it came in, and whether it was removed at Ingest. */
export interface IngestOverviewFrame {
  frame: string;
  created: number;
  width: number | null;
  height: number | null;
  removed: boolean;
}

export interface FramesResponse {
  frames: string[];
  showing_all: boolean;
  total: number;
  reference_frame: string | null;
}

export interface PipelineStage {
  id: string;
  label: string;
  /** The page that does this stage (a route path without the slash). */
  view: string;
  optional: boolean;
  status: "done" | "partial" | "todo" | "stale";
  detail: string;
}

export interface PipelineInfo {
  feature: string;
  frames: number;
  labeled: number;
  /** The first required stage that is not done, or null when the pipeline is complete. */
  next: string | null;
  stages: PipelineStage[];
}

export interface RoiInfo {
  feature: string;
  short_name: string;
  owner_product: string | null;
  role: string;
  classes: string[];
  shared_products: string[] | null;
  x: number;
  y: number;
  w: number;
  h: number;
  frames_seen: number;
  inbox_total: number;
  labeled: number;
  goldens: number;
  version_count: number;
  active_version: number | null;
  /** The rectangle follows a detector's box (see `anchor.py`); `x, y, w, h` are then the one it was drawn with. */
  anchored?: boolean;
  /** The Picture edits box this ROI is cut from: its rectangle is then relative to that box's output picture (see `roi_input.py`). */
  input?: string | null;
  /** Where this ROI stands in the pipeline (the Overview page only). */
  pipeline?: PipelineInfo;
}

export interface VerdictSummary {
  frames: number;
  /** Pictures that are not deleted. */
  total: number;
  deleted: number;
  ok: number;
  ng: number;
  open: number;
  contradiction: number;
  stale: number;
  /** Open pictures muted by Dedup. */
  duplicates: number;
}

export interface VerdictInput {
  feature: string;
  short_name: string;
  cls: string;
  source: string;
  via: string;
  updated: number;
}

export interface VerdictItem {
  frame: string;
  status: "ok" | "ng" | "open" | "contradiction" | "stale";
  bucket: string;
  verdict: "OK" | "NG" | null;
  kind: "auto" | "manual" | null;
  decision: "OK" | "NG" | null;
  inputs: VerdictInput[];
  muted_in: string[];
}

export interface VerdictList {
  status: string;
  page: number;
  per_page: number;
  n_pages: number;
  total: number;
  items: VerdictItem[];
  /** Per-page and columns of this page's grid (camera-wide; Verdict has no ROI). */
  settings?: { per_page: number; cols: number; per_page_options: number[]; cols_options: number[] };
}

/** The measurement boxes of a camera as the Overview shows them (see `chain.overview_flow`). */
export interface OverviewFlow {
  nodes: { id: string; kind: "crop" | "detector" | "calc" | "evaluation"; label: string; summary: FlowSummary }[];
  /** What the detectors found on the reference picture, centres in pixels of the whole picture. */
  boxes: { detector: string; target: string; x: number; y: number; w: number; h: number; angle: number; source: string }[];
  size: { w: number; h: number } | null;
}

export interface OverviewCamera {
  camera: string;
  frame_count: number;
  /** Reference frame (or the first frame); null when the camera has no frames. */
  picture_frame: string | null;
  tags?: string[];
  verdicts?: VerdictSummary;
  products: string[];
  classify_feature: string | null;
  /** Crop / detector / Calculate / Evaluation boxes; null when the camera has none. */
  flow?: OverviewFlow | null;
  rois: RoiInfo[];
}

export interface RoisResponse {
  rois: RoiInfo[];
  classify_feature: string | null;
  products: string[];
  inbox_total: number;
  unclassified_frames: number;
  shared_here: string[];
}

export interface RoiUpsert {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  product?: string | null;
  make_classifier?: boolean;
  product_names?: string[];
  shared_with?: string[];
}

/** What deleting a camera would remove: rows per database table, and the files and bytes of its folder. */
export interface CameraDeletePreview {
  camera: string;
  rows: Record<string, number>;
  files: number;
  bytes: number;
}

/** One box of the chain canvas: Ingest, a Classifier (one ROI with its labeling) or a measurement box (see `chain.py`). */
export interface ChainNode {
  id: string;
  kind: "ingest" | "roi" | "classify" | "crop" | "detector" | "calc" | "evaluation" | "dedup";
  /** The ROI's feature name (null for Ingest). */
  ref: string | null;
  label: string;
  x: number;
  y: number;
  role: string | null;
  /** classify (defines the products), name (`<product>::<roi>`), products (shared list), camera (whole camera). */
  scope: "classify" | "name" | "products" | "camera" | null;
  product: string | null;
  products: string[];
  classes: string[];
  frames: number;
  labeled: number;
  /** Classifier only: pictures per class, and how many are not labeled yet. */
  product_counts: Record<string, number>;
  unlabeled: number;
  /** Classifier only: "product" sorts every picture into products, "feature" labels its own classes. */
  mode?: "product" | "feature";
  /** Classifier only: pictures in the bin (deleted) on this camera. */
  deleted?: number;
  /** Classifier only: the Evaluation box its cards show (picked in its panel), or null. */
  evaluation?: string | null;
  /** Detector / Calculate / Evaluation boxes only: a light summary (see `flow.py`). */
  flow?: FlowSummary;
  /** ROI boxes only: the detector box the rectangle follows, or null/absent (see `anchor.py`). */
  anchor?: RoiAnchor | null;
  /** ROI boxes only: the Picture edits box the ROI is cut from, or null/absent (see `roi_input.py`). */
  input?: string | null;
}

export interface RoiAnchor {
  detector: string;
  target: string;
  /** box: the ROI is the found box plus `margin`; rect: it follows the rectangle drawn on `frame`. */
  mode: "box" | "rect";
  margin: number;
  frame?: string;
  follow_rotation: boolean;
  angle0?: number;
  dx?: number;
  dy?: number;
  w?: number;
  h?: number;
}

/** One edit of a Picture Edits box in the light summary: a crop (its rectangle, or `follows` a detector target) or a filter. */
export type FlowSummaryStep = { op: "crop"; rect?: [number, number, number, number] | null; follows?: boolean; enabled?: boolean } | { op: "filter"; label: string; enabled?: boolean };

export interface FlowSummary {
  /** A Picture Edits box: its steps in order. */
  steps?: FlowSummaryStep[];
  /** A Picture Edits box fed by one detector target: which, and the size of its rectangle (null until drawn). */
  follow?: { detector: string; target: string; size: [number, number] | null } | null;
  targets?: string[];
  status?: "none" | "fresh" | "stale";
  frames?: number;
  complete?: number;
  review?: number;
  op?: string;
  a?: string | null;
  b?: string | null;
  nominal?: number | null;
  tolerance?: number;
  mode?: "tolerance" | "zone";
  zone?: FlowZone | null;
  unit?: string;
  counts?: { pass: number; fail: number; undetermined: number };
  /** A Dedup box: the Classifier dot it reads (null: the camera or the box a line comes from), the pictures it sees, its mutes, the Classifiers it feeds. */
  source?: { feature: string; dot: string } | null;
  /** A detector fed by a Classifier dot: how many pictures that dot gives it. */
  in_scope?: number;
  /** A detector: the search runs on the whole picture, or on the picture a Picture edits box cut (`edited`). */
  area?: "whole" | "edited";
  muted?: number;
  deleted?: number;
  feeds?: string[];
}

export interface FlowExample {
  frame: string;
  box: [number, number, number, number];
  png: string;
  /** The rectangle is turned by this many degrees (counter-clockwise on screen); the stored crop is upright. */
  angle?: number;
}
/** One edit above a box: a fixed rectangle (fractions), a Crop that follows a detector target (pixels, relative to the found target), or a filter. */
export type FlowStep =
  | number[]
  | { follow: { detector: string; target: string; mode: string }; size: [number, number]; offset: [number, number] }
  | { filter: { name: string; params: Record<string, number> } };
/** A step of a Picture Edits box, as stored: a crop (a rectangle as fractions, or none drawn) or a filter from the catalogue. */
export type FlowEdit =
  | { id: string; op: "crop"; rect: [number, number, number, number] | null; enabled?: boolean }
  | { id: string; op: "filter"; name: string; params: Record<string, number | string>; enabled?: boolean };
/** A Crop fed by one target of a detector: the rectangle is drawn once and moves with the target on every picture. */
export interface FlowFollow {
  detector: string;
  target: string;
  mode: string;
  /** How the Crop can use the target; a mode is greyed out (`needs` names the outputs to tick on the detector) when the target does not offer them. */
  modes: { id: string; label: string; enabled: boolean; needs: string[] }[];
  /** The outputs the followed target offers now (read again every time the page is opened). */
  offered: FlowOutput[];
  /** The picture the rectangle was drawn on, its size in pixels and its offset from the found target; null until drawn. */
  frame: string | null;
  size: [number, number] | null;
  offset: [number, number] | null;
  /** Pictures where the detector found no such target: they cannot be cut. */
  missing: string[];
}
/** A Picture Edits box (kind `crop`): an ordered list of steps (crop, filter) run on every picture before the next box. */
export interface FlowCrop {
  kind: "crop";
  steps: FlowEdit[];
  /** The crop step that follows the detector target while a line feeds the box (the first crop step), else null. */
  follow_step?: string | null;
  input_box: string | null;
  /** The edits above this box (outermost first): the input picture is the frame after each in turn. */
  crops: FlowStep[];
  /** Set when the box is fed by one target of a detector. */
  follow?: FlowFollow | null;
}
/** What a detector target offers the box its line feeds: the found position, the angle of the found box, its size. */
export type FlowOutput = "position" | "angle" | "size";
export const FLOW_OUTPUTS: { id: FlowOutput; label: string }[] = [
  { id: "position", label: "Position" },
  { id: "angle", label: "Angle" },
  { id: "size", label: "Size" },
];
export interface FlowDetector {
  kind: "detector";
  input: string | null;
  /** The crops above this detector: it works on the frame cut by each in turn. */
  crops: FlowStep[];
  /** Pictures a Crop above this detector (one that follows a detector) has no rectangle on: they are not shown or searched. */
  no_crop?: string[];
  /** `inside`: in a cascade, the input detector's target whose box this target searches in (none = the same name). */
  targets: { name: string; inside?: string | null; outputs: FlowOutput[]; examples: FlowExample[] }[];
  /** A cascade: the input detector's targets (with examples) a target here can search inside. */
  parent_targets?: string[];
  rotate: boolean;
  angle_range: [number, number] | null;
  pad: number;
  status: "none" | "fresh" | "stale";
  summary: { frames: number; found: Record<string, number>; complete: number; review: number };
}
export interface FlowCalc {
  kind: "calc";
  op: string;
  operations: Record<string, string>;
  points: string[];
  a: string | null;
  b: string | null;
  clockwise: boolean;
  measured: number;
  /** The detector the two points come from, and the crops above it (the picture its boxes are in). */
  input?: string | null;
  crops?: FlowStep[];
}
/** The zone of an Evaluation behind an Offset: pixels from point A (see `zoneGeometry.ts`). */
export interface FlowZone {
  shape: "circle" | "rect";
  center: [number, number] | null;
  radius: number;
  half: [number, number];
}
export interface FlowEvaluation {
  kind: "evaluation";
  /** "zone" when the Calculate box measures an Offset (dx, dy), else "tolerance" (nominal ± tolerance). */
  mode: "tolerance" | "zone";
  zone: FlowZone;
  nominal: number | null;
  tolerance: number;
  calc: string | null;
  wrap: boolean;
  unit: string;
  counts: { pass: number; fail: number; undetermined: number };
  histogram: { low: number; high: number; bins: number[] } | null;
  features: string[];
}
export type FlowNodeDetail = FlowCrop | FlowDetector | FlowCalc | FlowEvaluation;
export interface FlowBox {
  x: number;
  y: number;
  angle: number;
  score: number;
  w: number;
  h: number;
  source: "auto" | "human";
}
export interface FlowBoxes {
  boxes: Record<string, Record<string, FlowBox>>;
  review: string[];
}
export interface FlowValues {
  values: Record<string, number | null>;
  verdicts?: Record<string, "pass" | "fail" | "undetermined">;
  counts?: { pass: number; fail: number; undetermined: number };
  histogram?: { low: number; high: number; bins: number[] } | null;
  wrap?: boolean;
  unit?: string;
  mode?: "tolerance" | "zone";
  zone?: FlowZone | null;
  /** Zone mode: (dx, dy) of B from A by frame, null where a point is missing. */
  points?: Record<string, [number, number] | null>;
  /** Zone mode: (dx, dy) of B from the zone centre (B's nominal position), null until a centre is set. */
  deviations?: Record<string, [number, number] | null>;
}
export interface FlowDeletePreview {
  node: string;
  kind: string;
  /** A Dedup box: pictures it muted that come back when it is deleted. */
  mutes?: number;
  detections: number;
  arrows: number;
}

export interface ChainEdge {
  id: string;
  source: string;
  /** `p:<product>` for a line that leaves one product dot of the product Classifier, `all` for its "all" dot. */
  source_handle: string | null;
  target: string;
  /** An arrow fixed by the ROI's name (`<product>::<roi>`); it cannot be removed. */
  locked: boolean;
}

export interface ChainViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface ChainCanvas {
  camera: string;
  nodes: ChainNode[];
  edges: ChainEdge[];
  products: string[];
  classify: string | null;
  viewport: ChainViewport | null;
}

export interface ChainLayout {
  nodes: Record<string, { x: number; y: number; label?: string }>;
  viewport: ChainViewport | null;
}

export interface ChainDeletePreview {
  feature: string;
  role: string;
  counts: { labels: number; goldens: number; detections: number; versions: number };
  /** Product-scoped ROIs that stay behind when the product-sorting ROI is deleted. */
  dependents: string[];
}

/** A number parameter (slider) or a choice (`options`: value -> label; two options show as a toggle, more as a drop-down). */
export type FilterNumberSpec = { min: number; max: number; step: number; default: number; label?: string; unit?: string; options?: undefined };
export type FilterChoiceSpec = { options: Record<string, string>; default: string; label?: string };
export type FilterParamSpec = FilterNumberSpec | FilterChoiceSpec;
export const isChoiceParam = (p: FilterParamSpec): p is FilterChoiceSpec => p.options !== undefined;
export interface FilterSpec {
  label: string;
  params: Record<string, FilterParamSpec>;
}
export interface FilterChoice {
  name: string;
  params: Record<string, number | string>;
}
export interface MaskChoice {
  enabled: boolean;
  shape: MaskShape;
}
export interface Exemplar {
  frame: string;
  box: Box;
}
export interface DetectorChoice {
  exemplars: Exemplar[];
  topk: number;
  threshold: number;
  /** "template" matches the exemplar crop itself (fast, exact size: for a fixed camera); "model" is the OWL-ViT model. */
  method: "template" | "model";
  /** The side the pictures are scaled to by the model method: 768 is its own (precise), 512 is faster with less exact boxes. */
  size: number;
}
export interface VisionSettings {
  filter: FilterChoice | null;
  mask: MaskChoice | null;
  detector: DetectorChoice | null;
}
export interface VisionSnapshot extends VisionSettings {
  signature: string;
  detections?: Record<string, Box>;
}
export interface DetectorInfo {
  available: boolean;
  model: string;
  max_exemplars: number;
  topk: [number, number];
  /** The detection methods the server offers (older servers do not say; then template and model). */
  methods?: string[];
  /** The picture sizes the detector can use (older servers do not say; then 768 and 512). */
  input_sizes?: number[];
  /** False when the model weights still have to be downloaded (undefined from older servers = ready). */
  model_cached?: boolean;
  download_mb?: number;
  download_source?: string;
  cache_dir?: string;
}
export type DetectionState = "human" | "trusted" | "review" | "none";
export interface DetectionRow {
  frame: string;
  state: DetectionState;
  status: string | null;
  boxes: (Box & { conf: number })[];
  /** Set on this screen only: the picture was deleted from the review and is kept in its place until the list is refreshed. */
  deleted?: boolean;
}
export interface DetectionList {
  threshold: number;
  frames: DetectionRow[];
  counts: Partial<Record<DetectionState, number>>;
}
export interface DetectResult {
  detected: number;
  skipped_human: number;
  unreadable: number;
  needs_review: number;
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export interface DeviceInfo {
  kind: "amd" | "nvidia" | "cpu";
  label: string;
  name: string;
  api: string;
  hint: string;
}

export const frameImageUrl = (camera: string, frame: string) =>
  `/api/cameras/${encodeURIComponent(camera)}/frames/${encodeURIComponent(frame)}/image`;

/** The picture's cutout of a feature or Dedup box at full resolution (404 where the detector found no box). */
export const frameCutoutUrl = (camera: string, frame: string, feature: string) =>
  `/api/cameras/${encodeURIComponent(camera)}/frames/${encodeURIComponent(frame)}/cutout?feature=${encodeURIComponent(feature)}`;

/**
 * The picture a Chain box works on (frame after the edits above it), or - `stage: "output"` on a Picture Edits box - the
 * one it passes on. `step` narrows that to one edit of the box (`input` enters it, `output` leaves it); `steps` is a list
 * of edits not saved yet, read in place of the box's own (the live preview). `key` (the edits) makes a changed edit load afresh.
 */
export const flowPictureUrl = (camera: string, nodeId: string, frame: string, opts: { stage?: "input" | "output"; size?: number; key?: unknown; straighten?: boolean; step?: string; steps?: FlowEdit[] } = {}) =>
  `/api/cameras/${encodeURIComponent(camera)}/flow/nodes/${encodeURIComponent(nodeId)}/picture?frame=${encodeURIComponent(frame)}` +
  (opts.stage ? `&stage=${opts.stage}` : "") +
  (opts.step ? `&step=${encodeURIComponent(opts.step)}` : "") +
  (opts.steps ? `&steps=${encodeURIComponent(JSON.stringify(opts.steps))}` : "") +
  (opts.size ? `&size=${opts.size}` : "") +
  (opts.straighten ? "&straighten=true" : "") +
  (opts.key !== undefined ? `&v=${encodeURIComponent(JSON.stringify(opts.key))}` : "");

export const frameThumbUrl = (camera: string, frame: string, size = 96) =>
  `/api/cameras/${encodeURIComponent(camera)}/frames/${encodeURIComponent(frame)}/thumb?variant=square&size=${size}`;

export const roiThumbUrl = (camera: string, frame: string, feature: string, size = 56) =>
  `/api/cameras/${encodeURIComponent(camera)}/frames/${encodeURIComponent(frame)}/thumb` +
  `?feature=${encodeURIComponent(feature)}&variant=square&size=${size}`;

export interface DeletedItem {
  frame: string;
  /** Epoch seconds when the frame was deleted. */
  deleted_at: number;
  note: string;
}

export interface DeleteResult {
  deleted: number;
  cleared_labels: number;
  cleared_goldens: number;
}

export interface DeletePreview {
  total: number;
  labeled: number;
  golden: number;
}

export interface MethodInfo {
  id: string;
  label: string;
  tag: string;
  description: string;
  installed: boolean;
  active: boolean;
  reason: string | null;
}

export interface MethodsConfig {
  methods: MethodInfo[];
  device: string;
  device_label: string;
}

export interface ClassifyState {
  feature: string;
  classes: string[];
  /** The pictures the user works with: not deleted, not muted for this ROI. */
  counts: Record<string, number>;
  /** Whether the ROI covers only some products, and how many pictures the camera has left (not deleted). */
  scope?: { restricted: boolean; camera_frames: number };
  methods: string[];
  default_rank: string;
  device: string;
  device_label: string;
  views: string[];
  orders: string[];
  has_results: boolean;
  scored: boolean;
  cold_start: boolean;
  stale: { goldens: boolean; frames: boolean };
  /** Methods switched on since the last refresh: they have no scores until the next one. */
  missing_methods?: string[];
  muted_count: number;
  shared_products: string[] | null;
  frames_seen: number;
  inbox_total: number;
  settings: { per_page: number; cols: number; per_page_options: number[]; cols_options: number[] };
}

export interface BarRow {
  cls: string;
  dist: number | null;
  rel: number;
  leader: boolean;
}

export interface CardData {
  frame: string;
  label: string | null;
  golden: string | null;
  deleted: boolean;
  leanings: Record<string, string | null>;
  bars: { rows: BarRow[]; novelty: number; margin: number | null; close_call: boolean } | null;
  cluster: { id: number; is_rep: boolean } | null;
  /** Edge-angle rule result for this frame, when the rule has been run on the current settings. */
  /** One entry per Evaluation box arrowed into this feature's Classify box (see `flow.py`). */
  measure?: { value: number | null; unit: string; nominal: number | null; tolerance: number; mode?: "tolerance" | "zone"; zone?: FlowZone | null; point?: [number, number] | null; relative?: boolean; verdict: "pass" | "fail" | "undetermined" }[] | null;
  edge?: { verdict: "pass" | "fail" | "undetermined" | null; status: "ok" | "none"; angle: number | null; polarity: "+" | "-" | null } | null;
  /** Search results only: the picture is outside this ROI's scope (another product, or none yet). */
  outside?: boolean;
  /** Search results only: the product the picture is labeled with in the product-sorting ROI. */
  product?: string | null;
  /** Search results only: the picture is muted for this ROI. */
  muted?: boolean;
}

export interface GridResponse {
  has_results: boolean;
  scored: boolean;
  rank: string;
  page: number;
  per_page: number;
  n_pages: number;
  total: number;
  items: CardData[];
  /** Present when the grid is a search result. */
  search?: { query: string; classify_feature: string | null; product_classes: string[] };
}

export interface CardUpdate {
  card: { frame: string; label: string | null; golden: string | null; deleted: boolean };
  counts: Record<string, number>;
}

export interface GridQuery {
  feature: string;
  view: string;
  rank: string;
  order: string;
  show_muted: boolean;
  auto_preview?: boolean;
  auto_classes?: string[] | null;
  auto_min_margin?: number | null;
  /** A part of a file name: the grid then lists every picture of the camera that matches. */
  search?: string;
}

export interface BulkPreview {
  selectable: number;
  selected: number;
  lo: number;
  hi: number;
  threshold: number;
}

export interface ClearPreview {
  matching: number;
  labeled: number;
  goldens: number;
}

export interface AutoPreview {
  candidates: number;
  total: number;
  per_class: { cls: string; count: number; avg_margin: number | null }[];
  lo: number;
  hi: number;
  min_margin: number;
}

export function gridParams(q: GridQuery, extra: Record<string, string | number | boolean | undefined | null> = {}) {
  const p = new URLSearchParams();
  p.set("feature", q.feature);
  p.set("view", q.view);
  p.set("rank", q.rank);
  p.set("order", q.order);
  p.set("show_muted", String(q.show_muted));
  if (q.auto_preview) {
    p.set("auto_preview", "true");
    (q.auto_classes ?? []).forEach((c) => p.append("auto_classes", c));
    if (q.auto_min_margin != null) p.set("auto_min_margin", String(q.auto_min_margin));
  }
  if (q.search) p.set("search", q.search);
  Object.entries(extra).forEach(([k, v]) => v != null && p.set(k, String(v)));
  return p.toString();
}

export interface SuggestResponse {
  available: boolean;
  backbone: string | null;
  n_min: number;
  n_max: number;
  default_n: number;
  picks: { frame: string; bars: CardData["bars"] }[];
}

export interface InsightsResponse {
  feature: string;
  classes: string[];
  methods: string[];
  goldens_in: string[];
  evaluable: number;
  reason: "needs_two_golden_classes" | "no_held_out_labels" | null;
  has_results: boolean;
  matrices: Record<
    string,
    { matrix: Record<string, Record<string, number>>; skipped: number; correct: number; total: number; accuracy: number }
  >;
}

export interface DedupParams {
  method: string;
  epsilon: number;
  min_points: number;
}

export interface DedupResult {
  params: DedupParams;
  summary: { clusters: number; covered: number; unique: number; total: number };
  would_mute: number;
  clusters: { id: number; members: string[]; representative: string }[];
  noise_frames: string[];
  classes: string[];
  /** Label/golden of the frames that have one; every other frame has neither. */
  marks: Record<string, { label: string | null; golden: string | null }>;
}

export interface DedupState {
  feature: string;
  /** The feature the picture actions go through: the Classifier the box reads, else the whole-frame feature. */
  source: string;
  reason: "no_embeddings" | "no_sklearn" | "methods_off" | null;
  backbones: string[];
  params: DedupParams;
  ranges: { epsilon: [number, number]; min_points: [number, number] };
  frames: number;
  device: string;
  device_label: string;
  muted_count: number;
  projections: string[];
  result: DedupResult | null;
  grid: { per_page: number; cols: number; per_page_options: number[]; cols_options: number[] };
}

export interface ScatterPoint {
  frame: string;
  x: number;
  y: number;
  /** Cluster of the held clustering for the same embedding; null when there is none. */
  cluster: number | null;
  representative: boolean;
  golden: string | null;
  label: string | null;
}

export interface ScatterResult {
  projection: string;
  method: string;
  from_cache: boolean;
  points: ScatterPoint[];
  classes: string[];
}

export interface OutlierResult {
  method: string;
  k: number;
  /** Every live frame, most isolated first. */
  scores: { frame: string; score: number }[];
  summary: { min: number; median: number; p95: number; max: number };
  marks: Record<string, { label: string | null; golden: string | null }>;
  classes: string[];
}

export interface EdgeExpected {
  angle: number;
  tolerance: number;
  polarity: "+" | "-";
}

export interface EdgeAngleSettings {
  p1: { x: number; y: number };
  p2: { x: number; y: number };
  half_width: number;
  points: number;
  expected: EdgeExpected | null;
}

export interface EdgeMeasurement {
  status: "ok" | "none";
  angle: number | null;
  polarity: "+" | "-" | null;
  contrast: number | null;
  rms: number | null;
  n_points: number;
  /** Normalised to the ROI crop. */
  points: { x: number; y: number }[];
  line: { x: number; y: number }[];
  /** Normalised to the straightened band. */
  patch_points: { x: number; y: number }[];
  patch_line: { x: number; y: number }[];
}

export interface EdgeSummary {
  total: number;
  pass: number;
  fail: number;
  undetermined: number;
  measured: number;
}

export interface EdgeAngleState {
  feature: string;
  settings: EdgeAngleSettings | null;
  ranges: { points: [number, number]; half_width: [number, number]; tolerance: [number, number] };
  defaults: { points: number; half_width: number; tolerance: number };
  results: "none" | "fresh" | "stale";
  summary: EdgeSummary | null;
}

export interface EdgePreview {
  measurement: EdgeMeasurement;
  verdict: "pass" | "fail" | "undetermined" | null;
  band: { x: number; y: number }[];
  patch: string | null;
  crop_size: [number, number];
}

export interface MotionRanges {
  dx: [number, number] | null;
  dy: [number, number] | null;
  rot: [number, number] | null;
}

export interface MotionSettings {
  reference: string | null;
  source: "auto" | "detector" | "template";
  rotation: boolean;
  coverage: number;
  label: string | null;
  ranges: MotionRanges;
}

export interface MotionAxis {
  n: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  /** The central ``coverage`` percent of the measured values. */
  suggested: [number, number];
  hist: { edges: number[]; counts: number[] };
}

export interface MotionAnalysis {
  crop: [number, number] | null;
  reference: string | null;
  frames: number;
  sources: { detector: number; template: number; none: number };
  coverage: number;
  dx: MotionAxis | null;
  dy: MotionAxis | null;
  rot: MotionAxis | null;
}

export interface MotionState {
  feature: string;
  classes: string[];
  settings: MotionSettings;
  saved: boolean;
  reference: string | null;
  has_detector: boolean;
  results: "none" | "fresh" | "stale";
  analysis: MotionAnalysis | null;
  coverage_range: [number, number];
}

export interface SimilarResult {
  seed: { frame: string; label: string };
  method: string;
  /** Unlabeled frames, nearest to the seed first. */
  neighbors: { frame: string; distance: number }[];
  classes: string[];
}

const post = (body?: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  visionFilters: () => request<{ filters: Record<string, FilterSpec> }>("/vision/filters"),
  visionSettings: (camera: string, feature: string) =>
    request<VisionSettings>(
      `/cameras/${encodeURIComponent(camera)}/vision/${encodeURIComponent(feature)}`,
    ),
  saveVisionSettings: (camera: string, feature: string, settings: VisionSettings) =>
    request<VisionSettings>(
      `/cameras/${encodeURIComponent(camera)}/vision/${encodeURIComponent(feature)}`,
      send("PUT", settings),
    ),
  detectorInfo: () => request<DetectorInfo>("/vision/detector"),
  detect: (camera: string, feature: string, acceptDownload = false) =>
    request<Job<DetectResult>>(
      `/cameras/${encodeURIComponent(camera)}/vision/${encodeURIComponent(feature)}/detect`,
      acceptDownload ? send("POST", { accept_download: true }) : post(),
    ),
  detections: (camera: string, feature: string, reviewOnly = false) =>
    request<DetectionList>(
      `/cameras/${encodeURIComponent(camera)}/vision/${encodeURIComponent(feature)}/detections` +
        (reviewOnly ? "?review_only=true" : ""),
    ),
  putDetection: (camera: string, feature: string, frame: string, box: Box, status: "manual" | "reviewed") =>
    request<{ ok: boolean }>(
      `/cameras/${encodeURIComponent(camera)}/vision/${encodeURIComponent(feature)}/detections/${encodeURIComponent(frame)}`,
      send("PUT", { box, status }),
    ),
  /** Undo a decision: put the frame's detections back as they were (an empty list leaves it without any). */
  restoreDetection: (camera: string, feature: string, frame: string, rows: (Box & { conf: number; status: string })[]) =>
    request<{ ok: boolean }>(
      `/cameras/${encodeURIComponent(camera)}/vision/${encodeURIComponent(feature)}/detections/${encodeURIComponent(frame)}/restore`,
      post({ rows }),
    ),
  deleteDetection: (camera: string, feature: string, frame: string) =>
    request<{ ok: boolean }>(
      `/cameras/${encodeURIComponent(camera)}/vision/${encodeURIComponent(feature)}/detections/${encodeURIComponent(frame)}`,
      { method: "DELETE" },
    ),
  visionPreview: async (
    camera: string,
    feature: string,
    frame: string,
    filter: FilterChoice | null,
    mask: MaskChoice | null = null,
    detector: DetectorChoice | null = null,
  ): Promise<Blob> => {
    const res = await fetch(
      `/api/cameras/${encodeURIComponent(camera)}/vision/${encodeURIComponent(feature)}/preview`,
      post({ frame, filter, mask, detector }),
    );
    if (!res.ok) {
      let detail = res.statusText || `HTTP ${res.status}`;
      try {
        detail = (await res.json()).detail ?? detail;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, null, String(detail));
    }
    return res.blob();
  },
  health: () => request<{ status: string }>("/health"),
  logs: (q: LogQuery = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") params.set(k, String(v));
    return request<LogRecord[]>(`/logs?${params}`);
  },
  version: () => request<{ version: string; released: string }>("/version"),
  device: () => request<DeviceInfo>("/device"),
  configMethods: () => request<MethodsConfig>("/config/methods"),
  configSetMethods: (active: string[]) => request<MethodsConfig>("/config/methods", send("PUT", { active })),
  cameras: () => request<string[]>("/cameras"),
  pipeline: (camera: string, feature: string) =>
    request<PipelineInfo>(`/cameras/${encodeURIComponent(camera)}/pipeline?feature=${encodeURIComponent(feature)}`),
  overview: () => request<{ cameras: OverviewCamera[] }>("/overview"),
  products: (camera: string) =>
    request<string[]>(`/cameras/${encodeURIComponent(camera)}/products`),
  status: (camera: string) =>
    request<CameraStatus>(`/cameras/${encodeURIComponent(camera)}/status`),
  features: (camera: string, product?: string) =>
    request<string[]>(
      `/cameras/${encodeURIComponent(camera)}/features` +
        (product ? `?product=${encodeURIComponent(product)}` : ""),
    ),
  versionFeatures: (camera: string, product?: string) =>
    request<{ feature: string; label: string }[]>(
      `/cameras/${encodeURIComponent(camera)}/versions/features` +
        (product ? `?product=${encodeURIComponent(product)}` : ""),
    ),
  versions: (camera: string, feature: string) =>
    request<VersionsResponse>(
      `/cameras/${encodeURIComponent(camera)}/versions?feature=${encodeURIComponent(feature)}`,
    ),
  freeze: (camera: string, feature: string, name: string, notes: string) =>
    request<{ id: number; number: number; counts: Record<string, number> }>(
      `/cameras/${encodeURIComponent(camera)}/versions`,
      post({ feature, name, notes }),
    ),
  revert: (camera: string, feature: string, id: number) =>
    request<{ labels: number; goldens: number }>(
      `/cameras/${encodeURIComponent(camera)}/versions/${id}/revert?feature=${encodeURIComponent(feature)}`,
      post(),
    ),
  deleteVersion: (camera: string, feature: string, id: number) =>
    request<{ deleted: number }>(
      `/cameras/${encodeURIComponent(camera)}/versions/${id}?feature=${encodeURIComponent(feature)}`,
      send("DELETE"),
    ),
  addVersionResult: (camera: string, feature: string, versionId: number, r: ResultInput) =>
    request<VersionResult>(`/cameras/${encodeURIComponent(camera)}/versions/${versionId}/results`, post({ feature, ...r })),
  updateVersionResult: (camera: string, feature: string, versionId: number, id: number, r: ResultInput) =>
    request<VersionResult>(`/cameras/${encodeURIComponent(camera)}/versions/${versionId}/results/${id}`, send("PUT", { feature, ...r })),
  deleteVersionResult: (camera: string, feature: string, versionId: number, id: number) =>
    request<{ deleted: number }>(
      `/cameras/${encodeURIComponent(camera)}/versions/${versionId}/results/${id}?feature=${encodeURIComponent(feature)}`,
      send("DELETE"),
    ),
  projectVersions: (camera: string) => request<ProjectVersionsResponse>(`/cameras/${encodeURIComponent(camera)}/project-versions`),
  freezeProject: (camera: string, name: string, notes: string, goldensOnly = true) =>
    request<{ id: number; number: number; counts: Record<string, number> }>(
      `/cameras/${encodeURIComponent(camera)}/project-versions`,
      post({ name, notes, goldens_only: goldensOnly }),
    ),
  exportProjectVersion: (camera: string, id: number) =>
    request<ExportReport>(`/cameras/${encodeURIComponent(camera)}/project-versions/${id}/export`, post()),
  job: <R = unknown>(id: string) => request<Job<R>>(`/jobs/${encodeURIComponent(id)}`),
  createCamera: (name: string, tags: string[] = []) => request<{ name: string; tags: string[] }>("/cameras", post({ name, tags })),
  cameraDeletePreview: (camera: string) =>
    request<CameraDeletePreview>(`/cameras/${encodeURIComponent(camera)}/delete-preview`),
  deleteCamera: (camera: string) =>
    request<{ removed: { rows: Record<string, number>; files: number; bytes: number } }>(
      `/cameras/${encodeURIComponent(camera)}?confirm=${encodeURIComponent(camera)}`,
      send("DELETE"),
    ),
  tags: () => request<{ tag: string; count: number }[]>("/tags"),
  setCameraTags: (camera: string, tags: string[]) =>
    request<string[]>(`/cameras/${encodeURIComponent(camera)}/tags`, send("PUT", { tags })),
  uploadFrames: (camera: string, files: File[]) => {
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    return request<Job<IngestResult>>(
      `/cameras/${encodeURIComponent(camera)}/ingest/upload`,
      { method: "POST", body: form },
    );
  },
  ingestOverview: (camera: string) =>
    request<{ frames: IngestOverviewFrame[] }>(`/cameras/${encodeURIComponent(camera)}/ingest/overview`),
  ingestRemove: (camera: string, frames: string[]) =>
    request<{ removed: number }>(`/cameras/${encodeURIComponent(camera)}/ingest/remove`, send("POST", { frames })),
  ingestKeepOnly: (camera: string, frames: string[]) =>
    request<{ removed: number }>(`/cameras/${encodeURIComponent(camera)}/ingest/keep-only`, send("POST", { frames })),
  ingestBringBack: (camera: string, frames: string[]) =>
    request<{ restored: number }>(`/cameras/${encodeURIComponent(camera)}/ingest/bring-back`, send("POST", { frames })),
  ingestedFrames: (camera: string) =>
    request<{ frames: IngestedFrame[] }>(`/cameras/${encodeURIComponent(camera)}/ingest/frames`),
  importFolder: (camera: string, path: string) =>
    request<Job<IngestResult>>(
      `/cameras/${encodeURIComponent(camera)}/ingest/folder`,
      post({ path }),
    ),
  rebuildCatalog: (camera: string) =>
    request<Job<{ tracked: number }>>(
      `/cameras/${encodeURIComponent(camera)}/ingest/rebuild`,
      post(),
    ),
  frames: (camera: string, product?: string, feature?: string) =>
    request<FramesResponse>(
      `/cameras/${encodeURIComponent(camera)}/frames` +
        (feature ? `?feature=${encodeURIComponent(feature)}` : product ? `?product=${encodeURIComponent(product)}` : ""),
    ),
  /** The pictures a Chain box works on (what its input passes on); none, with `has_input` false, while no line feeds it. */
  flowNodeFrames: (camera: string, nodeId: string) =>
    request<{ frames: string[]; has_input: boolean; reference_frame: string | null }>(
      `/cameras/${encodeURIComponent(camera)}/flow/nodes/${encodeURIComponent(nodeId)}/frames`,
    ),
  setReferenceFrame: (camera: string, frame: string) =>
    request<{ reference_frame: string }>(
      `/cameras/${encodeURIComponent(camera)}/reference-frame`,
      send("PUT", { frame }),
    ),
  rois: (camera: string, product?: string) =>
    request<RoisResponse>(
      `/cameras/${encodeURIComponent(camera)}/rois` +
        (product ? `?product=${encodeURIComponent(product)}` : ""),
    ),
  saveRoi: (camera: string, body: RoiUpsert) =>
    request<RoiInfo>(`/cameras/${encodeURIComponent(camera)}/rois`, send("PUT", body)),
  moveRoi: (camera: string, feature: string, box: { x: number; y: number; w: number; h: number }) =>
    request<RoiInfo>(
      `/cameras/${encodeURIComponent(camera)}/rois/${encodeURIComponent(feature)}/geometry`,
      send("PATCH", box),
    ),
  /** The Dedup boxes of the Chain, for the Dedup pages' box picker. */
  dedupFrames: (camera: string, feature: string) =>
    request<{ frames: string[]; muted: string[]; source: string; classes: string[]; marks: Record<string, { label: string | null; golden: string | null }> }>(
      `/cameras/${encodeURIComponent(camera)}/dedup/frames?feature=${encodeURIComponent(feature)}`,
    ),
  dedupBoxes: (camera: string) => request<{ feature: string; label: string }[]>(`/cameras/${encodeURIComponent(camera)}/dedup/boxes`),
  /** Make a Dedup box the one a Classifier reads through (null removes it). */
  setChainDedup: (camera: string, feature: string, box: string | null) =>
    request<ChainCanvas>(`/cameras/${encodeURIComponent(camera)}/chain/${encodeURIComponent(feature)}/dedup`, send("PUT", { box })),
  setChainEvaluation: (camera: string, feature: string, box: string | null) =>
    request<ChainCanvas>(`/cameras/${encodeURIComponent(camera)}/chain/${encodeURIComponent(feature)}/evaluation`, send("PUT", { box })),
  /** Draw a feature Classifier without its line from Ingest (it still reads the whole camera), or draw the line again. */
  setChainDetached: (camera: string, feature: string, detached: boolean) =>
    request<ChainCanvas>(`/cameras/${encodeURIComponent(camera)}/chain/${encodeURIComponent(feature)}/detached`, send("PUT", { detached })),
  /** Switch a Classifier between Feature (OK / NG) and Product (its classes are the product names); its labels are cleared. */
  setRoiMode: (camera: string, feature: string, mode: "product" | "feature", product_names: string[] = []) =>
    request<RoiInfo & { cleared: number }>(
      `/cameras/${encodeURIComponent(camera)}/rois/${encodeURIComponent(feature)}/mode`,
      send("PUT", { mode, product_names }),
    ),
  setRoiProducts: (camera: string, feature: string, products: string[]) =>
    request<RoiInfo>(
      `/cameras/${encodeURIComponent(camera)}/rois/${encodeURIComponent(feature)}/products`,
      send("PATCH", { products }),
    ),
  deleteRoi: (camera: string, feature: string) =>
    request<{ removed: Record<string, number> }>(
      `/cameras/${encodeURIComponent(camera)}/rois/${encodeURIComponent(feature)}`,
      send("DELETE"),
    ),
  chain: (camera: string) => request<ChainCanvas>(`/cameras/${encodeURIComponent(camera)}/chain`),
  saveChainLayout: (camera: string, layout: ChainLayout) =>
    request<ChainCanvas>(`/cameras/${encodeURIComponent(camera)}/chain/layout`, send("PUT", layout)),
  flowCreate: (camera: string, kind: "crop" | "detector" | "calc" | "evaluation" | "dedup") =>
    request<{ id: string }>(`/cameras/${encodeURIComponent(camera)}/flow/nodes`, send("POST", { kind })),
  flowNode: (camera: string, id: string) =>
    request<FlowNodeDetail>(`/cameras/${encodeURIComponent(camera)}/flow/nodes/${encodeURIComponent(id)}`),
  flowUpdate: (camera: string, id: string, body: Record<string, unknown>) =>
    request<FlowNodeDetail>(`/cameras/${encodeURIComponent(camera)}/flow/nodes/${encodeURIComponent(id)}`, send("PUT", body)),
  flowDeletePreview: (camera: string, id: string) =>
    request<FlowDeletePreview>(`/cameras/${encodeURIComponent(camera)}/flow/nodes/${encodeURIComponent(id)}/delete-preview`),
  flowDelete: (camera: string, id: string) =>
    request<{ removed: string }>(`/cameras/${encodeURIComponent(camera)}/flow/nodes/${encodeURIComponent(id)}`, send("DELETE")),
  flowConnect: (camera: string, source: string, target: string, point?: string) =>
    request<{ source: string; target: string }>(`/cameras/${encodeURIComponent(camera)}/flow/edges`, send("POST", point ? { source, target, point } : { source, target })),
  setRoiAnchor: (camera: string, feature: string, body: { detector: string; target: string; mode?: "box" | "rect"; margin?: number; frame?: string; follow_rotation?: boolean }) =>
    request<RoiAnchor>(`/cameras/${encodeURIComponent(camera)}/rois/${encodeURIComponent(feature)}/anchor`, send("PUT", body)),
  roiAnchor: (camera: string, feature: string) =>
    request<{ anchor: RoiAnchor | null; context: { frame: string; target: string; box: { x: number; y: number; w: number; h: number } | null } | null }>(
      `/cameras/${encodeURIComponent(camera)}/rois/${encodeURIComponent(feature)}/anchor`,
    ),
  roiRect: (camera: string, feature: string, frame: string) =>
    request<{ anchored: boolean; rect: { x: number; y: number; w: number; h: number } | null; box?: boolean; input?: string | null }>(
      `/cameras/${encodeURIComponent(camera)}/rois/${encodeURIComponent(feature)}/rect?frame=${encodeURIComponent(frame)}`,
    ),
  setRoiInput: (camera: string, feature: string, box: string) =>
    request<{ feature: string; input: { box: string } }>(`/cameras/${encodeURIComponent(camera)}/rois/${encodeURIComponent(feature)}/input`, send("PUT", { box })),
  clearRoiInput: (camera: string, feature: string) =>
    request<{ feature: string; input: null }>(`/cameras/${encodeURIComponent(camera)}/rois/${encodeURIComponent(feature)}/input`, { method: "DELETE" }),
  clearRoiAnchor: (camera: string, feature: string) =>
    request<{ feature: string; anchor: null }>(`/cameras/${encodeURIComponent(camera)}/rois/${encodeURIComponent(feature)}/anchor`, { method: "DELETE" }),
  flowDisconnect: (camera: string, source: string, target: string, point?: string) =>
    request<{ source: string; target: string }>(`/cameras/${encodeURIComponent(camera)}/flow/edges/remove`, send("POST", point ? { source, target, point } : { source, target })),
  flowAddTarget: (camera: string, id: string, name: string, inside?: string) =>
    request<FlowNodeDetail>(`/cameras/${encodeURIComponent(camera)}/flow/nodes/${encodeURIComponent(id)}/targets`, send("POST", inside ? { name, inside } : { name })),
  flowSetTargetOutputs: (camera: string, id: string, name: string, outputs: FlowOutput[]) =>
    request<FlowNodeDetail>(
      `/cameras/${encodeURIComponent(camera)}/flow/nodes/${encodeURIComponent(id)}/targets/${encodeURIComponent(name)}/outputs`,
      send("PUT", { outputs }),
    ),
  flowSetTargetInside: (camera: string, id: string, name: string, inside: string | null) =>
    request<FlowNodeDetail>(
      `/cameras/${encodeURIComponent(camera)}/flow/nodes/${encodeURIComponent(id)}/targets/${encodeURIComponent(name)}`,
      send("PUT", { inside }),
    ),
  flowRemoveTarget: (camera: string, id: string, name: string) =>
    request<FlowNodeDetail>(
      `/cameras/${encodeURIComponent(camera)}/flow/nodes/${encodeURIComponent(id)}/targets/${encodeURIComponent(name)}`,
      send("DELETE"),
    ),
  flowAddExample: (camera: string, id: string, target: string, frame: string, box: number[], angle = 0) =>
    request<FlowNodeDetail>(
      `/cameras/${encodeURIComponent(camera)}/flow/nodes/${encodeURIComponent(id)}/examples`,
      send("POST", angle ? { target, frame, box, angle } : { target, frame, box }),
    ),
  flowUpdateExample: (camera: string, id: string, target: string, index: number, box: number[], angle?: number) =>
    request<FlowNodeDetail>(
      `/cameras/${encodeURIComponent(camera)}/flow/nodes/${encodeURIComponent(id)}/examples/${encodeURIComponent(target)}/${index}`,
      send("PUT", angle === undefined ? { box } : { box, angle }),
    ),
  flowRemoveExample: (camera: string, id: string, target: string, index: number) =>
    request<FlowNodeDetail>(
      `/cameras/${encodeURIComponent(camera)}/flow/nodes/${encodeURIComponent(id)}/examples/${encodeURIComponent(target)}/${index}`,
      send("DELETE"),
    ),
  flowRun: (camera: string, id: string) =>
    request<Job<unknown>>(`/cameras/${encodeURIComponent(camera)}/flow/nodes/${encodeURIComponent(id)}/run`, post()),
  flowRunAll: (camera: string) => request<Job<unknown>>(`/cameras/${encodeURIComponent(camera)}/flow/run`, post()),
  flowBoxes: (camera: string, id: string, onlyReview = false) =>
    request<FlowBoxes>(
      `/cameras/${encodeURIComponent(camera)}/flow/nodes/${encodeURIComponent(id)}/boxes${onlyReview ? "?only_review=true" : ""}`,
    ),
  flowValues: (camera: string, id: string) =>
    request<FlowValues>(`/cameras/${encodeURIComponent(camera)}/flow/nodes/${encodeURIComponent(id)}/values`),
  flowSetBox: (camera: string, id: string, frame: string, target: string, x: number, y: number) =>
    request<FlowBox>(
      `/cameras/${encodeURIComponent(camera)}/flow/nodes/${encodeURIComponent(id)}/box`,
      send("PUT", { frame, target, x, y }),
    ),
  chainDeletePreview: (camera: string, feature: string) =>
    request<ChainDeletePreview>(
      `/cameras/${encodeURIComponent(camera)}/chain/delete-preview?feature=${encodeURIComponent(feature)}`,
    ),
  /** `names` is the list as it should be; `renames` maps old to new for the renamed products, whose labels and ROIs follow. */
  setProductNames: (camera: string, names: string[], renames: Record<string, string> = {}) =>
    request<{ products: string[] }>(
      `/cameras/${encodeURIComponent(camera)}/product-names`,
      send("PUT", { names, renames }),
    ),
  classifyState: (camera: string, feature: string) =>
    request<ClassifyState>(`/cameras/${encodeURIComponent(camera)}/classify/state?feature=${encodeURIComponent(feature)}`),
  classifyGrid: (camera: string, q: GridQuery, page: number) =>
    request<GridResponse>(`/cameras/${encodeURIComponent(camera)}/classify/grid?${gridParams(q, { page })}`),
  classifyRefresh: (camera: string, feature: string) =>
    request<Job<{ frames: number; scored: boolean }>>(
      `/cameras/${encodeURIComponent(camera)}/classify/refresh`,
      post({ feature }),
    ),
  /** `via` names the tool the action is made from (Scatter, Outliers, ...); it is stored with the label. */
  setLabel: (camera: string, feature: string, frame: string, cls: string | null, via?: string) =>
    request<CardUpdate>(`/cameras/${encodeURIComponent(camera)}/classify/label`, send("PUT", { feature, frame, cls, via })),
  setGolden: (camera: string, feature: string, frame: string, golden: boolean) =>
    request<CardUpdate>(`/cameras/${encodeURIComponent(camera)}/classify/golden`, send("PUT", { feature, frame, golden })),
  deleteFrame: (camera: string, feature: string, frame: string, via?: string) =>
    request<CardUpdate>(`/cameras/${encodeURIComponent(camera)}/classify/delete`, post({ feature, frame, via })),
  /** Bring a picture the duplicate step hid (a dedup mute) back into this ROI's grid. */
  unmuteFrame: (camera: string, feature: string, frame: string) =>
    request<{ frame: string; muted: boolean; muted_count: number }>(
      `/cameras/${encodeURIComponent(camera)}/classify/unmute`,
      post({ feature, frame }),
    ),
  restoreFrame: (camera: string, feature: string, frame: string) =>
    request<CardUpdate>(`/cameras/${encodeURIComponent(camera)}/classify/restore`, post({ feature, frame })),
  deleteFrames: (camera: string, feature: string, frames: string[], note = "", via?: string) =>
    request<DeleteResult>(`/cameras/${encodeURIComponent(camera)}/classify/delete-bulk`, post({ feature, frames, note, via })),
  /** Which tools have left a trace on this camera: `{ "dedup/clusters": true, ... }`. */
  toolsUsed: (camera: string) => request<Record<string, boolean>>(`/cameras/${encodeURIComponent(camera)}/tools-used`),
  labelFrames: (camera: string, feature: string, frames: string[], cls: string, via?: string) =>
    request<{ labeled: number }>(`/cameras/${encodeURIComponent(camera)}/classify/label-bulk`, post({ feature, frames, cls, via })),
  verdictSummary: (camera: string) => request<VerdictSummary>(`/cameras/${encodeURIComponent(camera)}/verdicts/summary`),
  verdicts: (camera: string, status: string, page: number) =>
    request<VerdictList>(
      `/cameras/${encodeURIComponent(camera)}/verdicts?status=${encodeURIComponent(status)}&page=${page}`,
    ),
  verdictGridSettings: (camera: string, per_page: number, cols: number) =>
    request<NonNullable<VerdictList["settings"]>>(`/cameras/${encodeURIComponent(camera)}/verdicts/grid-settings`, send("PUT", { per_page, cols })),
  verdictDecide: (camera: string, frame: string, cls: "OK" | "NG" | null) =>
    request<{ item: VerdictItem | null; summary: VerdictSummary }>(
      `/cameras/${encodeURIComponent(camera)}/verdicts/decision`,
      send("PUT", { frame, cls }),
    ),
  deletePreview: (camera: string, feature: string, frames: string[]) =>
    request<DeletePreview>(`/cameras/${encodeURIComponent(camera)}/classify/delete-preview`, post({ feature, frames })),
  restoreFrames: (camera: string, feature: string, frames: string[]) =>
    request<{ restored: number }>(`/cameras/${encodeURIComponent(camera)}/classify/restore-bulk`, post({ feature, frames })),
  deletedList: (camera: string, feature: string) =>
    request<{ items: DeletedItem[] }>(`/cameras/${encodeURIComponent(camera)}/classify/deleted?feature=${encodeURIComponent(feature)}`),
  setDeletedNote: (camera: string, feature: string, frame: string, note: string) =>
    request<{ frame: string; note: string }>(`/cameras/${encodeURIComponent(camera)}/classify/deleted-note`, send("PUT", { feature, frame, note })),
  setGridSettings: (camera: string, feature: string, per_page: number, cols: number) =>
    request<{ per_page: number; cols: number }>(
      `/cameras/${encodeURIComponent(camera)}/classify/grid-settings`,
      send("PUT", { feature, per_page, cols }),
    ),
  bulkPreview: (camera: string, q: GridQuery, mode: string, lean_cls: string | null, threshold: number | null) =>
    request<BulkPreview>(
      `/cameras/${encodeURIComponent(camera)}/classify/bulk?${gridParams(q, { mode, lean_cls, threshold })}`,
    ),
  bulkLabel: (camera: string, query: GridQuery, mode: string, lean_cls: string | null, threshold: number | null, label_as: string) =>
    request<{ labeled: number; counts: Record<string, number> }>(
      `/cameras/${encodeURIComponent(camera)}/classify/bulk`,
      post({ query, mode, lean_cls, threshold, label_as }),
    ),
  clearPreview: (camera: string, q: GridQuery) =>
    request<ClearPreview>(`/cameras/${encodeURIComponent(camera)}/classify/clear?${gridParams(q)}`),
  clearLabels: (camera: string, query: GridQuery, include_goldens: boolean) =>
    request<{ cleared: number; goldens_spared: number; counts: Record<string, number> }>(
      `/cameras/${encodeURIComponent(camera)}/classify/clear`,
      post({ query, include_goldens }),
    ),
  autoPreview: (camera: string, q: GridQuery, classes: string[], min_margin: number | null) => {
    const p = new URLSearchParams(gridParams(q, { min_margin }));
    classes.forEach((c) => p.append("classes", c));
    return request<AutoPreview>(`/cameras/${encodeURIComponent(camera)}/classify/auto?${p.toString()}`);
  },
  autoApply: (camera: string, query: GridQuery, classes: string[], min_margin: number | null) =>
    request<{ labeled: number; counts: Record<string, number> }>(
      `/cameras/${encodeURIComponent(camera)}/classify/auto`,
      post({ query, classes, min_margin }),
    ),
  suggestGoldens: (camera: string, q: GridQuery, n: number) =>
    request<SuggestResponse>(`/cameras/${encodeURIComponent(camera)}/classify/suggest?${gridParams(q, { n })}`),
  promote: (camera: string, feature: string, frame: string, cls: string) =>
    request<CardUpdate>(`/cameras/${encodeURIComponent(camera)}/classify/promote`, post({ feature, frame, cls })),
  insightsCell: (camera: string, feature: string, method: string, true_cls: string, pred_cls: string) =>
    request<{ items: CardData[]; classes: string[]; methods: string[]; cols: number }>(
      `/cameras/${encodeURIComponent(camera)}/insights/cell?feature=${encodeURIComponent(feature)}&method=${encodeURIComponent(method)}` +
        `&true_cls=${encodeURIComponent(true_cls)}&pred_cls=${encodeURIComponent(pred_cls)}`,
    ),
  insights: (camera: string, feature: string) =>
    request<InsightsResponse>(`/cameras/${encodeURIComponent(camera)}/insights?feature=${encodeURIComponent(feature)}`),
  dedupState: (camera: string, feature: string) =>
    request<DedupState>(`/cameras/${encodeURIComponent(camera)}/dedup/state?feature=${encodeURIComponent(feature)}`),
  dedupSaveSettings: (camera: string, feature: string, p: DedupParams) =>
    request<{ params: DedupParams }>(`/cameras/${encodeURIComponent(camera)}/dedup/settings`, send("PUT", { feature, ...p })),
  dedupCluster: (camera: string, feature: string, p: DedupParams) =>
    request<Job<DedupResult>>(`/cameras/${encodeURIComponent(camera)}/dedup/cluster`, post({ feature, ...p })),
  dedupGridSettings: (camera: string, feature: string, per_page: number, cols: number) =>
    request<DedupState["grid"]>(`/cameras/${encodeURIComponent(camera)}/dedup/grid-settings`, send("PUT", { feature, per_page, cols })),
  dedupApply: (camera: string, feature: string, picks: Record<number, string>) =>
    request<{ muted: number; unmuted: number; skipped_labeled: number; skipped_golden: number }>(
      `/cameras/${encodeURIComponent(camera)}/dedup/apply`,
      post({ feature, picks }),
    ),
  dedupClearMutes: (camera: string, feature: string) =>
    request<{ unmuted: number }>(
      `/cameras/${encodeURIComponent(camera)}/dedup/mutes?feature=${encodeURIComponent(feature)}`,
      send("DELETE"),
    ),
  edgeAngleState: (camera: string, feature: string) =>
    request<EdgeAngleState>(`/cameras/${encodeURIComponent(camera)}/rules/edge-angle/${encodeURIComponent(feature)}`),
  edgeAngleSave: (camera: string, feature: string, settings: EdgeAngleSettings | null) =>
    request<EdgeAngleState>(`/cameras/${encodeURIComponent(camera)}/rules/edge-angle/${encodeURIComponent(feature)}`, send("PUT", { settings })),
  edgeAnglePreview: (camera: string, feature: string, frame: string, settings: EdgeAngleSettings) =>
    request<EdgePreview>(
      `/cameras/${encodeURIComponent(camera)}/rules/edge-angle/${encodeURIComponent(feature)}/preview`,
      post({ frame, settings }),
    ),
  edgeAngleRun: (camera: string, feature: string) =>
    request<Job<EdgeSummary>>(`/cameras/${encodeURIComponent(camera)}/rules/edge-angle/${encodeURIComponent(feature)}/run`, post()),
  motionState: (camera: string, feature: string, coverage?: number, label?: string) =>
    request<MotionState>(
      `/cameras/${encodeURIComponent(camera)}/augmentation/${encodeURIComponent(feature)}` +
        (coverage !== undefined || label !== undefined
          ? `?${[coverage !== undefined ? `coverage=${coverage}` : "", label !== undefined ? `label=${encodeURIComponent(label)}` : ""].filter(Boolean).join("&")}`
          : ""),
    ),
  motionSave: (camera: string, feature: string, settings: MotionSettings | null) =>
    request<MotionState>(`/cameras/${encodeURIComponent(camera)}/augmentation/${encodeURIComponent(feature)}`, send("PUT", { settings })),
  motionRun: (camera: string, feature: string) =>
    request<Job<{ measured: number; total: number; reference: string }>>(
      `/cameras/${encodeURIComponent(camera)}/augmentation/${encodeURIComponent(feature)}/run`,
      post(),
    ),
  classifySimilar: (camera: string, feature: string, frame: string, method: string, limit: number) =>
    request<Job<SimilarResult>>(`/cameras/${encodeURIComponent(camera)}/classify/similar`, post({ feature, frame, method, limit })),
  classifyLabelFrames: (camera: string, feature: string, frames: string[], cls: string) =>
    request<{ labeled: number; skipped: string[]; counts: Record<string, number> }>(
      `/cameras/${encodeURIComponent(camera)}/classify/label-frames`,
      post({ feature, frames, cls }),
    ),
  dedupOutliers: (camera: string, feature: string, method: string, k: number) =>
    request<Job<OutlierResult>>(`/cameras/${encodeURIComponent(camera)}/dedup/outliers`, post({ feature, method, k })),
  dedupScatterCached: (camera: string, feature: string, projection: string, method: string) =>
    request<{ cached: boolean }>(
      `/cameras/${encodeURIComponent(camera)}/dedup/scatter/cached?feature=${encodeURIComponent(feature)}&projection=${encodeURIComponent(projection)}&method=${encodeURIComponent(method)}`,
    ),
  dedupScatter: (camera: string, feature: string, projection: string, method: string) =>
    request<Job<ScatterResult>>(`/cameras/${encodeURIComponent(camera)}/dedup/scatter`, post({ feature, projection, method })),
};
