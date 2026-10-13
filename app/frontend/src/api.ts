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
};
