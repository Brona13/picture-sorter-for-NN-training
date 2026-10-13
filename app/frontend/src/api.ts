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
  stats: Record<string, Record<string, number>>;
  active: boolean;
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

const post = (body?: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  health: () => request<{ status: string }>("/health"),
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
};
