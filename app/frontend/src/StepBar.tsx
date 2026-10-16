import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, DATA_CHANGED, PipelineInfo } from "./api";
import PipelineChips, { LabelProgress } from "./PipelineChips";

/** Pages that work on one ROI, so the step bar belongs on them. */
const FEATURE_PAGES = new Set(["roi", "detector", "edge-angle", "dedup", "classify", "insights", "augmentation", "versions"]);

/**
 * A slim bar above the page showing where the ROI being worked on stands in the pipeline. Click a stage to
 * go to the page that does it; the stages of the page you are on are marked. It reloads when you change page,
 * ROI or camera, and shortly after anything is labeled, deleted or otherwise changed, so the counts stay current.
 */
export default function StepBar({ camera, feature }: { camera: string; feature: string }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const page = pathname.split("/")[1] ?? "";
  const [info, setInfo] = useState<PipelineInfo | null>(null);
  const show = Boolean(camera && feature && FEATURE_PAGES.has(page));

  const [changes, setChanges] = useState(0);
  useEffect(() => {
    if (!show) return;
    // Labeling is a burst of requests; look again once it settles.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setChanges((n) => n + 1), 300);
    };
    window.addEventListener(DATA_CHANGED, onChange);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(DATA_CHANGED, onChange);
    };
  }, [show]);

  useEffect(() => {
    if (!show) return;
    let cancelled = false;
    api
      .pipeline(camera, feature)
      .then((p) => !cancelled && setInfo(p))
      .catch(() => !cancelled && setInfo(null)); // cosmetic: the page itself reports real errors
    return () => {
      cancelled = true;
    };
  }, [show, camera, feature, page, changes]);

  if (!show || !info || info.feature !== feature) return null;
  return (
    <nav aria-label="Pipeline steps" data-testid="step-bar" style={{ margin: "0 0 12px", padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--panel)" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 12 }}>{feature}</strong>
        <PipelineChips pipeline={info} current={page} size="small" onOpen={(stage) => navigate(`/${stage.view}`)} />
      </div>
      <LabelProgress pipeline={info} />
    </nav>
  );
}
