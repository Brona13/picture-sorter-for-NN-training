import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api, ApiError, PipelineStage, RoiInfo } from "./api";
import { FeatureContext } from "./SharedFeature";
import StepBar from "./StepBar";
import { CONFIG_VIEW, VIEWS } from "./views";
import ClassifyView from "./views/ClassifyView";
import ConfigurationView from "./views/ConfigurationView";
import DetectorView from "./views/DetectorView";
import AugmentationView from "./views/AugmentationView";
import EdgeAngleView from "./views/EdgeAngleView";
import DedupView from "./views/DedupView";
import InsightsView from "./views/InsightsView";
import IngestView from "./views/IngestView";
import RoiEditorView from "./views/RoiEditorView";
import OverviewView from "./views/OverviewView";
import StatusView from "./views/StatusView";
import VerdictView from "./views/VerdictView";
import VersionsView from "./views/VersionsView";

export default function App() {
  const [cameras, setCameras] = useState<string[]>([]);
  const [camera, setCamera] = useState("");
  const [products, setProducts] = useState<string[]>([]);
  const [product, setProduct] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<{ version: string; released: string } | null>(null);
  // The ROI being worked on is remembered with its camera, so it is dropped when the camera changes.
  const [selected, setSelected] = useState({ camera: "", feature: "" });
  const feature = selected.camera === camera ? selected.feature : "";
  const navigate = useNavigate();
  const pendingProduct = useRef<string | null>(null);

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
    setProduct(pendingProduct.current ?? "");
    pendingProduct.current = null;
    api
      .products(camera)
      .then(setProducts)
      .catch((e: unknown) => setError(describe(e)));
  }, [camera]);

  // From the Overview: work on this ROI (and its product) on the page that does the clicked stage.
  const openStage = (cam: string, roi: RoiInfo, stage: PipelineStage) => {
    const owner = roi.owner_product ?? "";
    if (cam === camera) setProduct(owner);
    else pendingProduct.current = owner;
    setCamera(cam);
    setSelected({ camera: cam, feature: roi.feature });
    navigate(`/${stage.view}`);
  };

  return (
    <FeatureContext.Provider value={{ feature, setFeature: (f) => setSelected({ camera, feature: f }) }}>
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
              <NavLink to={`/${v.path}`}>
                <span className="nav-icon" aria-hidden="true">
                  {v.icon}
                </span>
                {v.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <ul className="sidebar-bottom">
          <li>
            <NavLink to={`/${CONFIG_VIEW.path}`}>
              <span className="nav-icon" aria-hidden="true">
                {CONFIG_VIEW.icon}
              </span>
              {CONFIG_VIEW.label}
            </NavLink>
          </li>
        </ul>
      </nav>
      <main className="main">
        {error && <p role="alert">{error}</p>}
        <StepBar camera={camera} feature={feature} />
        <Routes>
          <Route path="/" element={<Navigate to="/overview" replace />} />
          <Route
            path="/overview"
            element={
              <OverviewView
                camera={camera}
                onSelectCamera={setCamera}
                onOpenStage={openStage}
                onCameraCreated={(name) => {
                  loadCameras(name);
                  navigate("/ingest");
                }}
              />
            }
          />
          <Route path="/status" element={<StatusView camera={camera} />} />
          <Route
            path="/versions"
            element={<VersionsView camera={camera} product={product || undefined} />}
          />
          <Route
            path="/ingest"
            element={<IngestView camera={camera} />}
          />
          <Route
            path="/roi"
            element={<RoiEditorView camera={camera} product={product || undefined} />}
          />
          <Route path="/verdict" element={<VerdictView camera={camera} />} />
          <Route
            path="/classify"
            element={<ClassifyView camera={camera} product={product || undefined} />}
          />
          <Route
            path="/insights"
            element={<InsightsView camera={camera} product={product || undefined} />}
          />
          <Route path="/augmentation" element={<AugmentationView camera={camera} product={product || undefined} />} />
          <Route path="/edge-angle" element={<EdgeAngleView camera={camera} product={product || undefined} />} />
          <Route
            path="/detector"
            element={<DetectorView camera={camera} product={product || undefined} />}
          />
          <Route path="/dedup" element={<DedupView camera={camera} product={product || undefined} />} />
          <Route path="/config" element={<ConfigurationView />} />
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>
      </main>
    </div>
    </FeatureContext.Provider>
  );
}

function describe(e: unknown): string {
  if (e instanceof ApiError && e.code === "database_reset_required") {
    return `Database needs a reset: ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}
