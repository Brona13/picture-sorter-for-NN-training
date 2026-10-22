import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { lastSession } from "./lastSession";
import { api, ApiError, DATA_CHANGED, DeviceInfo, MethodInfo, PipelineStage, PRODUCTS_RENAMED, RoiInfo } from "./api";
import HardwareBadge from "./HardwareBadge";
import ProductSelect from "./ProductSelect";
import { RankContext } from "./RankContext";
import RankSelect from "./RankSelect";
import { FeatureContext } from "./SharedFeature";
import StatusBar from "./StatusBar";
import ToolIcon from "./ToolIcon";
import StepBar from "./StepBar";
import { CONFIG_VIEW, SECTIONS, VIEWS, sectionOf } from "./views";
import ChainView from "./views/ChainView";
import FlowBoxView from "./views/FlowBoxView";
import ClassifyView from "./views/ClassifyView";
import ConfigurationView from "./views/ConfigurationView";
import DetectorView from "./views/DetectorView";
import AugmentationView from "./views/AugmentationView";
import EdgeAngleView from "./views/EdgeAngleView";
import DedupView, { DedupTool } from "./views/DedupView";
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
  // The product list follows changes (a product added, removed or renamed in the ROI editor), and a product or ROI that was
  // renamed keeps being the selected one: its labels and ROIs went along, so the page should too.
  useEffect(() => {
    if (!camera) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      api
        .products(camera)
        .then((list) => {
          if (cancelled) return;
          setProducts(list);
          setProduct((p) => (list.includes(p) ? p : ""));
        })
        .catch(() => undefined);
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 400);
    };
    const onRenamed = (e: Event) => {
      const renames = ((e as CustomEvent<Record<string, string>>).detail ?? {}) as Record<string, string>;
      const renameFeature = (f: string) => {
        const [owner, ...rest] = f.split("::");
        return rest.length > 0 && renames[owner] ? `${renames[owner]}::${rest.join("::")}` : f;
      };
      const p = lastSession.product(camera);
      if (renames[p]) {
        lastSession.setProduct(camera, renames[p]);
        setProduct(renames[p]);
      }
      const f = lastSession.feature(camera);
      if (f) lastSession.setFeature(camera, renameFeature(f));
      setSelected((s) => (s.camera === camera ? { ...s, feature: renameFeature(s.feature) } : s));
    };
    window.addEventListener(DATA_CHANGED, onChange);
    window.addEventListener(PRODUCTS_RENAMED, onRenamed);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener(DATA_CHANGED, onChange);
      window.removeEventListener(PRODUCTS_RENAMED, onRenamed);
    };
  }, [camera]);

  // The scoring method the Classify grid ranks by; the methods in use come from the Configuration page and follow its changes.
  const [rank, setRank] = useState(lastSession.rank);
  const [methods, setMethods] = useState<MethodInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      api
        .configMethods()
        .then((c) => !cancelled && setMethods(c.methods))
        .catch(() => undefined); // cosmetic: the picker simply stays hidden
    load();
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 400);
    };
    window.addEventListener(DATA_CHANGED, onChange);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener(DATA_CHANGED, onChange);
    };
  }, []);

  const [info, setInfo] = useState<{ version: string; released: string } | null>(null);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  // The ROI being worked on is remembered with its camera, so it is dropped when the camera changes.
  const [selected, setSelected] = useState({ camera: "", feature: "" });
  // Until the user picks one, the ROI last used on this camera (pages check it against what they offer).
  const remembered = useMemo(() => lastSession.feature(camera), [camera]);
  const feature = selected.camera === camera ? selected.feature : remembered;
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  // "/roi?focus=<ROI>" and "/classify?focus=<ROI>" are the pages locked to one ROI (opened from the Chain canvas); the plain
  // paths from the menu keep their ROI selector.
  const focusFeature = new URLSearchParams(search).get("focus") ?? "";
  const knownPages = [...VIEWS, CONFIG_VIEW].map((v) => `/${v.path}`);
  // The page the cogwheel returns to when it is clicked again on Configuration.
  const beforeConfig = useRef("/overview");
  // The page last open in each section, so a section's top-bar button returns to it.
  const lastInSection = useRef<Record<string, string>>({});
  useEffect(() => {
    if (knownPages.includes(pathname)) lastSession.setPage(pathname);
    const sec = sectionOf(pathname);
    if (sec && knownPages.includes(pathname)) lastInSection.current[sec.id] = pathname;
    if (pathname !== `/${CONFIG_VIEW.path}` && knownPages.includes(pathname)) beforeConfig.current = pathname;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
  const section = sectionOf(pathname);
  // Which tools have left a trace on this camera; their icons are muted until they have. Reloaded when data changes.
  const [toolsUsed, setToolsUsed] = useState<Record<string, boolean> | null>(null);
  useEffect(() => {
    if (!camera) return;
    setToolsUsed(null);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      api
        .toolsUsed(camera)
        .then((u) => !cancelled && setToolsUsed(u))
        .catch(() => undefined); // cosmetic: the icons simply stay as they were
    load();
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 500); // labeling is a burst of requests; look again once it settles
    };
    window.addEventListener(DATA_CHANGED, onChange);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener(DATA_CHANGED, onChange);
    };
  }, [camera]);
  // The right-hand options panel sticks just under the top bar, whose height changes when its tool bar wraps.
  const topbarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = topbarRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const set = () => el.parentElement?.style.setProperty("--top-h", `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
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

  // From the Chain canvas: work on this ROI on the ROI editor or Classify page. The page lists the ROIs of the chosen
  // product scope only, so the scope is set to the ROI's own (the camera level for the product-sorting ROI).
  const openRoi = (feature: string, view: "roi" | "classify") => {
    const owner = feature.includes("::") ? feature.split("::")[0] : "";
    lastSession.setProduct(camera, owner);
    lastSession.setFeature(camera, feature);
    setProduct(owner);
    setSelected({ camera, feature });
    // Both pages open locked to this ROI.
    navigate(`/${view}?focus=${encodeURIComponent(feature)}`);
  };

  return (
    <FeatureContext.Provider value={{ feature, setFeature: (f) => { lastSession.setFeature(camera, f); setSelected({ camera, feature: f }); } }}>
    <RankContext.Provider value={{ rank }}>
    <div className="app">
      <header className="topbar" ref={topbarRef}>
        <nav aria-label="Sections" className="topbar-row">
          <h1>Picture Sorter</h1>
          <ul className="sections">
            {SECTIONS.map((sec) => {
              const current = section?.id === sec.id;
              const target = lastInSection.current[sec.id] ?? `/${sec.pages[0].path}`;
              return (
                <li key={sec.id}>
                  <Link to={target} className={current ? "active" : ""} aria-current={current ? "page" : undefined}>
                    {sec.label}
                  </Link>
                </li>
              );
            })}
          </ul>
          <label>
            Camera
            <select value={camera} onChange={(e) => setCamera(e.target.value)}>
              {cameras.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <ProductSelect products={products} value={product} onChange={(p) => chooseProduct(camera, p)} />
          {pathname === "/classify" && (
            <RankSelect
              methods={methods}
              value={rank}
              onChange={(r) => {
                lastSession.setRank(r);
                setRank(r);
              }}
            />
          )}
          <div className="topbar-foot">
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
        </nav>
        {section && section.pages.length > 1 && (
          <nav aria-label={`${section.label} tools`} className="toolbar">
            {section.pages.map((v, i) => (
              <Fragment key={v.path}>
                {v.group && section.pages[i - 1]?.group !== v.group && <span className="toolbar-group">{v.group}</span>}
                <NavLink
                  to={`/${v.path}`}
                  title={v.tracked ? `${v.label} — ${toolsUsed?.[v.path] ? "used on this camera" : "not used on this camera yet"}` : v.label}
                >
                  <ToolIcon id={v.icon} used={v.tracked ? toolsUsed?.[v.path] === true : undefined} />
                  {v.label}
                </NavLink>
              </Fragment>
            ))}
          </nav>
        )}
      </header>
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
                onOpenFlow={(cam, id) => {
                  setCamera(cam);
                  navigate(`/flow?focus=${encodeURIComponent(id)}`);
                }}
                onCameraDeleted={(name) => {
                  if (name === camera) setCamera("");
                  loadCameras();
                }}
                onCameraCreated={(name) => {
                  loadCameras(name);
                  navigate("/ingest");
                }}
              />
            }
          />
          <Route path="/chain" element={<ChainView camera={camera} onOpenRoi={openRoi} />} />
          <Route
            path="/flow"
            element={
              focusFeature ? (
                <FlowBoxView camera={camera} focus={{ nodeId: focusFeature, onBack: () => navigate("/chain") }} />
              ) : (
                <p className="muted">Open a Picture edits, detector, Calculate or Evaluation box from the Chain.</p>
              )
            }
          />
          <Route path="/status" element={<StatusView camera={camera} />} />
          <Route
            path="/versions"
            element={<VersionsView camera={camera} product={product || undefined} />}
          />
          <Route
            path="/ingest"
            element={<IngestView camera={camera} onBack={focusFeature ? () => navigate("/chain") : undefined} />}
          />
          <Route
            path="/roi"
            element={<RoiEditorView camera={camera} product={product || undefined} focus={focusFeature ? { feature: focusFeature, onBack: () => navigate("/chain") } : undefined} />}
          />
          <Route path="/verdict" element={<VerdictView camera={camera} />} />
          <Route
            path="/classify"
            element={<ClassifyView camera={camera} product={product || undefined} focus={focusFeature ? { feature: focusFeature, onBack: () => navigate("/chain") } : undefined} />}
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
          <Route path="/dedup" element={<Navigate to="/dedup/scatter" replace />} />
          {/* one route for the three tools, so the page (and the results it holds) survives switching between them */}
          <Route path="/dedup/:tool" element={<DedupRoute camera={camera} />} />
          <Route path="/config" element={<ConfigurationView />} />
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>
      </main>
      <StatusBar camera={camera} product={product} feature={feature} info={info} device={device} />
    </div>
    </RankContext.Provider>
    </FeatureContext.Provider>
  );
}

const DEDUP_TOOLS = new Set<string>(["grid", "scatter", "clusters", "outliers"]);

function DedupRoute({ camera }: { camera: string }) {
  const { tool = "" } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  if (!DEDUP_TOOLS.has(tool)) return <Navigate to="/dedup/scatter" replace />;
  const box = search.get("box") ?? undefined;
  return (
    <DedupView
      camera={camera}
      box={box}
      tool={tool as DedupTool}
      onBack={() => navigate("/chain")}
      onTool={(t, b) => navigate(`/dedup/${t}?box=${encodeURIComponent(b)}`)}
    />
  );
}

function describe(e: unknown): string {
  if (e instanceof ApiError && e.code === "database_reset_required") {
    return `Database needs a reset: ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}
