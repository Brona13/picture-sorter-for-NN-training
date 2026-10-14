import { Box } from "./roiGeometry";
import { MaskShape } from "./shapeGeometry";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string | null,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
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
    throw new ApiError(res.status, code, String(detail));
  }
  return (await res.json()) as T;
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

export interface VersionInfo {
  id: number;
  number: number;
  name: string;
  notes: string;
  created: number;
  counts: Record<string, number>;
  stats: Record<string, Record<string, number>> & { vision?: VisionSnapshot };
  active: boolean;
  deleted: number | null;
  delta: string;
}

export interface VersionsResponse {
  feature: string;
  classes: string[];
  counts: Record<string, number>;
  versions: VersionInfo[];
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

export interface FramesResponse {
  frames: string[];
  showing_all: boolean;
  total: number;
  reference_frame: string | null;
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

export interface FilterParamSpec {
  min: number;
  max: number;
  step: number;
  default: number;
}
export interface FilterSpec {
  label: string;
  params: Record<string, FilterParamSpec>;
}
export interface FilterChoice {
  name: string;
  params: Record<string, number>;
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
}
export type DetectionState = "human" | "trusted" | "review" | "none";
export interface DetectionRow {
  frame: string;
  state: DetectionState;
  status: string | null;
  boxes: (Box & { conf: number })[];
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

export const frameImageUrl = (camera: string, frame: string) =>
  `/api/cameras/${encodeURIComponent(camera)}/frames/${encodeURIComponent(frame)}/image`;

export const roiThumbUrl = (camera: string, frame: string, feature: string, size = 56) =>
  `/api/cameras/${encodeURIComponent(camera)}/frames/${encodeURIComponent(frame)}/thumb` +
  `?feature=${encodeURIComponent(feature)}&variant=square&size=${size}`;

export interface ClassifyState {
  feature: string;
  classes: string[];
  counts: Record<string, number>;
  methods: string[];
  default_rank: string;
  device: string;
  views: string[];
  orders: string[];
  has_results: boolean;
  scored: boolean;
  cold_start: boolean;
  stale: { goldens: boolean; frames: boolean };
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
}

export interface DedupState {
  feature: string;
  reason: "no_embeddings" | "no_sklearn" | null;
  backbones: string[];
  params: DedupParams;
  ranges: { epsilon: [number, number]; min_points: [number, number] };
  frames: number;
  device: string;
  muted_count: number;
  projections: string[];
  result: DedupResult | null;
}

export interface ScatterPoint {
  frame: string;
  x: number;
  y: number;
  cluster: number;
  representative: boolean;
  golden: string | null;
}

export interface ScatterResult {
  projection: string;
  from_cache: boolean;
  points: ScatterPoint[];
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
  detect: (camera: string, feature: string) =>
    request<Job<DetectResult>>(
      `/cameras/${encodeURIComponent(camera)}/vision/${encodeURIComponent(feature)}/detect`,
      post(),
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
  version: () => request<{ version: string; released: string }>("/version"),
  cameras: () => request<string[]>("/cameras"),
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
  exportVersion: (camera: string, feature: string, id: number) =>
    request<ExportReport>(
      `/cameras/${encodeURIComponent(camera)}/versions/${id}/export?feature=${encodeURIComponent(feature)}`,
      post(),
    ),
  job: <R = unknown>(id: string) => request<Job<R>>(`/jobs/${encodeURIComponent(id)}`),
  createCamera: (name: string) => request<{ name: string }>("/cameras", post({ name })),
  uploadFrames: (camera: string, files: File[]) => {
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    return request<Job<IngestResult>>(
      `/cameras/${encodeURIComponent(camera)}/ingest/upload`,
      { method: "POST", body: form },
    );
  },
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
  frames: (camera: string, product?: string) =>
    request<FramesResponse>(
      `/cameras/${encodeURIComponent(camera)}/frames` +
        (product ? `?product=${encodeURIComponent(product)}` : ""),
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
  setProductNames: (camera: string, names: string[]) =>
    request<{ products: string[] }>(
      `/cameras/${encodeURIComponent(camera)}/product-names`,
      send("PUT", { names }),
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
  setLabel: (camera: string, feature: string, frame: string, cls: string | null) =>
    request<CardUpdate>(`/cameras/${encodeURIComponent(camera)}/classify/label`, send("PUT", { feature, frame, cls })),
  setGolden: (camera: string, feature: string, frame: string, golden: boolean) =>
    request<CardUpdate>(`/cameras/${encodeURIComponent(camera)}/classify/golden`, send("PUT", { feature, frame, golden })),
  deleteFrame: (camera: string, feature: string, frame: string) =>
    request<CardUpdate>(`/cameras/${encodeURIComponent(camera)}/classify/delete`, post({ feature, frame })),
  restoreFrame: (camera: string, feature: string, frame: string) =>
    request<CardUpdate>(`/cameras/${encodeURIComponent(camera)}/classify/restore`, post({ feature, frame })),
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
  insights: (camera: string, feature: string) =>
    request<InsightsResponse>(`/cameras/${encodeURIComponent(camera)}/insights?feature=${encodeURIComponent(feature)}`),
  dedupState: (camera: string, feature: string) =>
    request<DedupState>(`/cameras/${encodeURIComponent(camera)}/dedup/state?feature=${encodeURIComponent(feature)}`),
  dedupSaveSettings: (camera: string, feature: string, p: DedupParams) =>
    request<{ params: DedupParams }>(`/cameras/${encodeURIComponent(camera)}/dedup/settings`, send("PUT", { feature, ...p })),
  dedupCluster: (camera: string, feature: string, p: DedupParams) =>
    request<Job<DedupResult>>(`/cameras/${encodeURIComponent(camera)}/dedup/cluster`, post({ feature, ...p })),
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
  dedupScatter: (camera: string, feature: string, projection: string) =>
    request<Job<ScatterResult>>(`/cameras/${encodeURIComponent(camera)}/dedup/scatter`, post({ feature, projection })),
};
