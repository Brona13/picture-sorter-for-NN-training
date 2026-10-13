import { useCallback, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api, ApiError } from "./api";
import { VIEWS } from "./views";
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
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "sans-serif" }}>
      <nav aria-label="Sidebar" style={{ width: 220, padding: 16, borderRight: "1px solid #ddd" }}>
        <h1 style={{ fontSize: 18 }}>Picture Sorter</h1>
        <label>
          Camera
          <select value={camera} onChange={(e) => setCamera(e.target.value)}>
            {cameras.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        {products.length > 0 && (
          <label style={{ display: "block", marginTop: 8 }}>
            Product
            <select value={product} onChange={(e) => setProduct(e.target.value)}>
              <option value="">All</option>
              {products.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
        )}
        <ul style={{ listStyle: "none", padding: 0, marginTop: 16 }}>
          {VIEWS.map((v) => (
            <li key={v.path}>
              <NavLink to={`/${v.path}`}>{v.label}</NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main style={{ flex: 1, padding: 16 }}>
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
          {VIEWS.filter((v) => !["status", "versions", "ingest", "roi"].includes(v.path)).map((v) => (
            <Route key={v.path} path={`/${v.path}`} element={<h2>{v.label}</h2>} />
          ))}
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
