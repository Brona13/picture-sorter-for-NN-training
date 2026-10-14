import { useCallback, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api, ApiError } from "./api";
import { VIEWS } from "./views";
import ClassifyView from "./views/ClassifyView";
import DedupView from "./views/DedupView";
import InsightsView from "./views/InsightsView";
import IngestView from "./views/IngestView";
import RoiEditorView from "./views/RoiEditorView";
import StatusView from "./views/StatusView";
import VersionsView from "./views/VersionsView";

export default function App() {
  const [cameras, setCameras] = useState<string[]>([]);
  const [camera, setCamera] = useState("");
  const [products, setProducts] = useState<string[]>([]);
  const [product, setProduct] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<{ version: string; released: string } | null>(null);

  useEffect(() => {
    api
      .version()
      .then(setInfo)
      .catch(() => setInfo(null)); // cosmetic; never block the app on it
  }, []);

  const loadCameras = useCallback((select?: string) => {
    api
      .cameras()
      .then((list) => {
        setCameras(list);
        setCamera((c) => select || c || list[0] || "");
      })
      .catch((e: unknown) => setError(describe(e)));
  }, []);

  useEffect(() => loadCameras(), [loadCameras]);

  useEffect(() => {
    if (!camera) return;
    setProduct("");
    api
      .products(camera)
      .then(setProducts)
      .catch((e: unknown) => setError(describe(e)));
  }, [camera]);

  return (
    <div className="app">
      <nav aria-label="Sidebar" className="sidebar">
        <h1>Picture Sorter</h1>
        {info && (
          <p className="app-version" title="Application version and release date">
            v{info.version} · {info.released}
          </p>
        )}
        <label>
          Camera
          <select value={camera} onChange={(e) => setCamera(e.target.value)}>
            {cameras.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        {products.length > 0 && (
          <label>
            Product
            <select value={product} onChange={(e) => setProduct(e.target.value)}>
              <option value="">All</option>
              {products.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
        )}
        <ul>
          {VIEWS.map((v) => (
            <li key={v.path}>
              <NavLink to={`/${v.path}`}>{v.label}</NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main className="main">
        {error && <p role="alert">{error}</p>}
        <Routes>
          <Route path="/" element={<Navigate to="/status" replace />} />
          <Route path="/status" element={<StatusView camera={camera} />} />
          <Route
            path="/versions"
            element={<VersionsView camera={camera} product={product || undefined} />}
          />
          <Route
            path="/ingest"
            element={<IngestView camera={camera} onCameraCreated={loadCameras} />}
          />
          <Route
            path="/roi"
            element={<RoiEditorView camera={camera} product={product || undefined} />}
          />
          <Route
            path="/classify"
            element={<ClassifyView camera={camera} product={product || undefined} />}
          />
          <Route
            path="/insights"
            element={<InsightsView camera={camera} product={product || undefined} />}
          />
          <Route path="/dedup" element={<DedupView camera={camera} product={product || undefined} />} />
          <Route path="*" element={<Navigate to="/status" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function describe(e: unknown): string {
  if (e instanceof ApiError && e.code === "database_reset_required") {
    return `Database needs a reset: ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}
