import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { lastSession } from "./lastSession";
import { api, ApiError, DeviceInfo, PipelineStage, RoiInfo } from "./api";
import HardwareBadge from "./HardwareBadge";
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
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  // The ROI being worked on is remembered with its camera, so it is dropped when the camera changes.
  const [selected, setSelected] = useState({ camera: "", feature: "" });
  // Until the user picks one, the ROI last used on this camera (pages check it against what they offer).
  const remembered = useMemo(() => lastSession.feature(camera), [camera]);
  const feature = selected.camera === camera ? selected.feature : remembered;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const knownPages = [...VIEWS, CONFIG_VIEW].map((v) => `/${v.path}`);
  // The page the cogwheel returns to when it is clicked again on Configuration.
  const beforeConfig = useRef("/overview");
  useEffect(() => {
    if (knownPages.includes(pathname)) lastSession.setPage(pathname);
    if (pathname !== `/${CONFIG_VIEW.path}` && knownPages.includes(pathname)) beforeConfig.current = pathname;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
  const startPage = knownPages.includes(lastSession.page()) ? lastSession.page() : "/overview";
  const chooseProduct = (cam: string, p: string) => {
    lastSession.setProduct(cam, p);
    setProduct(p);
  };
  const pendingProduct = useRef<string | null>(null);

  useEffect(() => {
    api
      .device()
      .then(setDevice)
      .catch(() => setDevice(null)); // cosmetic as well
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
        const saved = lastSession.camera();
        setCamera((c) => select || c || (list.includes(saved) ? saved : list[0]) || "");
      })
      .catch((e: unknown) => setError(describe(e)));
  }, []);

  useEffect(() => loadCameras(), [loadCameras]);

  useEffect(() => {
    if (camera) lastSession.setCamera(camera);
  }, [camera]);

  useEffect(() => {
    if (!camera) return;
    setProduct(pendingProduct.current ?? lastSession.product(camera));
    pendingProduct.current = null;
    api
      .products(camera)
      .then((list) => {
        setProducts(list);
        setProduct((p) => (list.includes(p) ? p : "")); // a remembered product may be gone
      })
      .catch((e: unknown) => setError(describe(e)));
  }, [camera]);

  // From the Overview: work on this ROI (and its product) on the page that does the clicked stage.
  const openStage = (cam: string, roi: RoiInfo, stage: PipelineStage) => {
    const owner = roi.owner_product ?? "";
    lastSession.setProduct(cam, owner);
    lastSession.setFeature(cam, roi.feature);
    if (cam === camera) setProduct(owner);
    else pendingProduct.current = owner;
    setCamera(cam);
    setSelected({ camera: cam, feature: roi.feature });
    navigate(`/${stage.view}`);
  };

  return (
    <FeatureContext.Provider value={{ feature, setFeature: (f) => { lastSession.setFeature(camera, f); setSelected({ camera, feature: f }); } }}>
    <div className="app">
      <nav aria-label="Sidebar" className="sidebar">
        <h1>Picture Sorter</h1>
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
            <select value={product} onChange={(e) => chooseProduct(camera, e.target.value)}>
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
        <div className="sidebar-foot">
          {device && <HardwareBadge info={device} />}
          <div className="sidebar-foot-row">
            {info && (
              <p className="app-version" title="Application version and release date">
                v{info.version} · {info.released}
              </p>
            )}
            <NavLink to={`/${CONFIG_VIEW.path}`} className="config-link"
              aria-label={CONFIG_VIEW.label}
              title={CONFIG_VIEW.label}
              onClick={(e) => {
                if (pathname === `/${CONFIG_VIEW.path}`) {
                  e.preventDefault();
                  navigate(beforeConfig.current);
                }
              }}
            >
              <span aria-hidden="true">{CONFIG_VIEW.icon}</span>
            </NavLink>
          </div>
        </div>
      </nav>
      <main className="main">
        {error && <p role="alert">{error}</p>}
        <StepBar camera={camera} feature={feature} />
        <Routes>
          <Route path="/" element={<Navigate to={startPage} replace />} />
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
