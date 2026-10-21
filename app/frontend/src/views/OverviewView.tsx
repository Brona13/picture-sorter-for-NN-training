import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, OverviewCamera, PipelineStage, RoiInfo } from "../api";
import { describeFlow } from "../chain/chainModel";
import { drawn } from "../pixelCentre";
import CameraDelete from "../CameraDelete";
import { thumbUrl } from "../classify/Card";
import PictureSizeSlider, { usePictureSize } from "../PictureSize";
import PipelineChips, { LabelProgress } from "../PipelineChips";
import TagEditor from "../TagEditor";
import VerdictBar from "../VerdictBar";

const SIZE_MIN = 150;
const SIZE_MAX = 800;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const chip = {
  display: "inline-block",
  padding: "0 7px",
  borderRadius: 9,
  fontSize: 11,
  background: "var(--hover)",
  color: "var(--fg)",
  marginRight: 4,
} as const;

function scopeOf(r: RoiInfo): string {
  if (r.role === "classify") return "defines products";
  if (r.owner_product) return r.owner_product;
  if (r.shared_products?.length) return `shared: ${r.shared_products.join(", ")}`;
  return "all products";
}

type Focus = { camera: string; feature: string } | null;

function CameraPicture({
  cam,
  active,
  size,
  onSelect,
}: {
  cam: OverviewCamera;
  active: string | null;
  size: number;
  onSelect: () => void;
}) {
  if (!cam.picture_frame) return <p style={{ color: "var(--muted)" }}>No frames yet.</p>;
  return (
    <div
      onClick={onSelect}
      style={{ position: "relative", lineHeight: 0, cursor: "pointer", border: "1px solid var(--border)", width: "fit-content", maxWidth: size }}
    >
      <img
        src={`/api/cameras/${encodeURIComponent(cam.camera)}/frames/${encodeURIComponent(cam.picture_frame)}/image`}
        alt={`${cam.camera} reference frame`}
        loading="lazy"
        style={{ maxWidth: "100%", display: "block" }}
      />
      {cam.rois.map((r) => (
        <span
          key={r.feature}
          data-testid={`box-${cam.camera}-${r.feature}`}
          style={{
            position: "absolute",
            left: `${r.x * 100}%`,
            top: `${r.y * 100}%`,
            width: `${r.w * 100}%`,
            height: `${r.h * 100}%`,
            boxSizing: "border-box",
            border: `${active === r.feature ? 3 : 1.5}px solid ${active === r.feature ? "#ff3b30" : "var(--accent)"}`,
            pointerEvents: "none",
          }}
        />
      ))}
      {cam.flow?.size && cam.flow.boxes.length > 0 && (
        <svg
          data-testid={`found-${cam.camera}`}
          viewBox={`0 0 ${cam.flow.size.w} ${cam.flow.size.h}`}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
        >
          {cam.flow.boxes.map((b, i) => {
            const c = drawn(b);
            const color = FOUND_COLORS[i % FOUND_COLORS.length];
            const halo = { vectorEffect: "non-scaling-stroke" as const };
            return (
              <g key={`${b.detector}/${b.target}`} transform={`translate(${c.x} ${c.y}) rotate(${-b.angle})`}>
                <rect x={-b.w / 2} y={-b.h / 2} width={b.w} height={b.h} fill="none" stroke="rgba(0,0,0,.75)" strokeWidth={3.5} {...halo} />
                <rect x={-b.w / 2} y={-b.h / 2} width={b.w} height={b.h} fill="none" stroke={color} strokeWidth={1.8} {...halo}>
                  <title>{`${b.target} (${b.detector})`}</title>
                </rect>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

const FOUND_COLORS = ["#ff9f1c", "#2ec4ff", "#7bd389", "#e07bff", "#ffe066"];

const KIND_NAME = { crop: "Picture edits", detector: "Detector", calc: "Calculate", evaluation: "Evaluation" } as const;

/** The camera's measurement chain (Picture edits, detectors, Calculate, Evaluation) as small cards, in the order of the chain. */
function FlowCards({ cam, onOpen }: { cam: OverviewCamera; onOpen?: (camera: string, nodeId: string) => void }) {
  const nodes = cam.flow?.nodes ?? [];
  if (nodes.length === 0) return null;
  return (
    <div data-testid={`flow-${cam.camera}`} style={{ gridColumn: "1 / -1" }}>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>Measurement chain</div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "stretch", gap: 6 }}>
        {nodes.map((n, i) => (
          <div key={n.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {i > 0 && <span aria-hidden style={{ color: "var(--muted)" }}>→</span>}
            <button
              aria-label={`${KIND_NAME[n.kind]} ${n.label} of ${cam.camera}`}
              disabled={!onOpen}
              onClick={() => onOpen?.(cam.camera, n.id)}
              style={{
                textAlign: "left",
                padding: 6,
                color: "var(--fg)",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                cursor: onOpen ? "pointer" : "default",
              }}
            >
              <span style={chip}>{KIND_NAME[n.kind]}</span>
              <strong>{n.label}</strong>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>{describeFlow(n.kind, n.summary)}</div>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Every camera with its reference frame and ROIs; clicking one makes it the active camera. Each ROI card also
 * shows where that ROI stands in the pipeline; clicking a stage opens the page that does it, on that ROI.
 */
export default function OverviewView({
  camera,
  onSelectCamera,
  onOpenStage,
  onOpenFlow,
  onCameraCreated,
  onCameraDeleted,
}: {
  camera: string;
  onSelectCamera: (camera: string) => void;
  onOpenStage?: (camera: string, roi: RoiInfo, stage: PipelineStage) => void;
  /** Open the page of a measurement box (detector, Calculate, ...) of a camera. */
  onOpenFlow?: (camera: string, nodeId: string) => void;
  /** Called after a camera was created from the wizard (select it and go and add pictures). */
  onCameraCreated?: (name: string) => void;
  onCameraDeleted?: (name: string) => void;
}) {
  const [cams, setCams] = useState<OverviewCamera[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus>(null);
  const [hover, setHover] = useState<Focus>(null);
  const [size, resize] = usePictureSize("overview.pictureSize", 400, SIZE_MIN, SIZE_MAX);

  const [allTags, setAllTags] = useState<string[]>([]);
  // Tag filter: a camera must have every included tag and none of the excluded ones.
  const [include, setInclude] = useState<string[]>([]);
  const [exclude, setExclude] = useState<string[]>([]);
  const [wizard, setWizard] = useState(false);
  const [newName, setNewName] = useState("");
  const [newTags, setNewTags] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  const loadTags = useCallback(() => {
    api
      .tags()
      .then((t) => setAllTags(t.map((x) => x.tag)))
      .catch(() => setAllTags([])); // suggestions are a convenience
  }, []);

  useEffect(() => {
    api
      .overview()
      .then((r) => setCams(r.cameras))
      .catch((e: unknown) => setError(msg(e)));
    loadTags();
  }, [loadTags]);

  const tagCounts = useMemo(() => {
    const counts = new Map<string, { tag: string; count: number }>();
    for (const c of cams ?? [])
      for (const t of c.tags ?? []) {
        const k = t.toLowerCase();
        counts.set(k, { tag: counts.get(k)?.tag ?? t, count: (counts.get(k)?.count ?? 0) + 1 });
      }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }, [cams]);

  async function saveTags(cam: string, tags: string[]) {
    setFormError(null);
    try {
      const saved = await api.setCameraTags(cam, tags);
      setCams((list) => (list ?? []).map((c) => (c.camera === cam ? { ...c, tags: saved } : c)));
      loadTags();
    } catch (e) {
      setFormError(msg(e));
    }
  }

  async function createCamera(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      const created = await api.createCamera(newName, newTags);
      setWizard(false);
      setNewName("");
      setNewTags([]);
      onCameraCreated?.(created.name);
    } catch (err) {
      setFormError(msg(err));
    }
  }

  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const tagState = (tag: string): "include" | "exclude" | "off" =>
    include.some((t) => same(t, tag)) ? "include" : exclude.some((t) => same(t, tag)) ? "exclude" : "off";
  // Each click moves a tag on: off → include → exclude → off.
  const cycleFilter = (tag: string) => {
    const st = tagState(tag);
    setInclude((f) => (st === "include" ? f.filter((t) => !same(t, tag)) : st === "off" ? [...f, tag] : f));
    setExclude((f) => (st === "include" ? [...f, tag] : st === "exclude" ? f.filter((t) => !same(t, tag)) : f));
  };
  const shown = (cams ?? []).filter((c) => {
    const has = (f: string) => (c.tags ?? []).some((t) => same(t, f));
    return include.every(has) && !exclude.some(has);
  });

  if (error) return <p role="alert">{error}</p>;
  if (!cams) return <p>Loading…</p>;

  const activeFeature = (cam: string): string | null =>
    (hover?.camera === cam ? hover.feature : null) ?? (focus?.camera === cam ? focus.feature : null);

  return (
    <section>
      <h2>Overview</h2>
      <p>Every camera with its reference frame and ROIs. Click a camera or ROI to select it in the menu.</p>
      {formError && <p role="alert">{formError}</p>}
      <p>
        <button aria-expanded={wizard} onClick={() => setWizard((w) => !w)}>
          ➕ New camera
        </button>
      </p>
      {wizard && (
        <form
          onSubmit={createCamera}
          aria-label="New camera"
          style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--panel)", padding: 12, margin: "8px 0", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}
        >
          <label>
            Camera name <input value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
          </label>
          <span style={{ flex: "1 1 280px", minWidth: 0 }}>
            Tags <TagEditor tags={newTags} suggestions={allTags} onChange={setNewTags} label="New camera tag" />
          </span>
          <span style={{ display: "flex", gap: 8 }}>
            <button type="submit" disabled={!newName.trim()}>
              Create and add pictures →
            </button>
            <button type="button" onClick={() => setWizard(false)}>
              Cancel
            </button>
          </span>
        </form>
      )}
      {tagCounts.length > 0 && (
        <p aria-label="Filter by tag" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span>Tags:</span>
          {tagCounts.map(({ tag, count }) => {
            const st = tagState(tag);
            return (
              <button
                key={tag}
                aria-pressed={st !== "off"}
                aria-label={st === "exclude" ? `not ${tag} (${count})` : `${tag} (${count})`}
                title={st === "off" ? "Click to require this tag" : st === "include" ? "Required — click to exclude it instead" : "Excluded — click to clear"}
                onClick={() => cycleFilter(tag)}
                style={
                  st === "include"
                    ? { background: "var(--info-bg)", borderColor: "var(--accent)" }
                    : st === "exclude"
                      ? { background: "var(--danger-bg, #f7c1c1)", borderColor: "var(--danger, #c33)", textDecoration: "line-through" }
                      : undefined
                }
              >
                {st === "include" ? "✓ " : st === "exclude" ? "✕ " : ""}
                {tag} ({count})
              </button>
            );
          })}
          {(include.length > 0 || exclude.length > 0) && (
            <button
              onClick={() => {
                setInclude([]);
                setExclude([]);
              }}
            >
              Clear filter
            </button>
          )}
          <small style={{ opacity: 0.7 }}>click: require ✓ → exclude ✕ → off</small>
        </p>
      )}
      <PictureSizeSlider value={size} onChange={resize} min={SIZE_MIN} max={SIZE_MAX} />
      {cams.length === 0 && <p>No cameras yet — use “New camera” above.</p>}
      {cams.length > 0 && shown.length === 0 && <p>No camera matches the tag filter.</p>}
      {shown.map((cam) => {
        const selected = cam.camera === camera;
        return (
          <section
            key={cam.camera}
            aria-label={`Camera ${cam.camera}`}
            style={{
              border: `2px solid ${selected ? "var(--accent)" : "var(--border)"}`,
              borderRadius: "var(--radius)",
              background: "var(--panel)",
              padding: 12,
              margin: "12px 0",
            }}
          >
            <header style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
              <h3 style={{ margin: 0 }}>{cam.camera}</h3>
              <span style={chip}>{cam.frame_count} frames</span>
              {cam.products.length > 0 && <span style={chip}>products: {cam.products.join(", ")}</span>}
              <TagEditor tags={cam.tags ?? []} suggestions={allTags} onChange={(t) => void saveTags(cam.camera, t)} label={`Add tag to ${cam.camera}`} />
              <span style={{ flex: 1 }} />
              <button
                aria-pressed={selected}
                aria-label={`Select camera ${cam.camera}`}
                onClick={() => onSelectCamera(cam.camera)}
              >
                {selected ? "✓ Selected" : "Select"}
              </button>
              <CameraDelete
                camera={cam.camera}
                onDeleted={(name) => {
                  setCams((list) => (list ?? []).filter((c) => c.camera !== name));
                  loadTags();
                  onCameraDeleted?.(name);
                }}
              />
            </header>
            {cam.verdicts && cam.frame_count > 0 && <VerdictBar summary={cam.verdicts} />}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 10, alignItems: "flex-start" }}>
              <CameraPicture
                cam={cam}
                active={activeFeature(cam.camera)}
                size={size}
                onSelect={() => onSelectCamera(cam.camera)}
              />
              <div
                style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10, alignContent: "start", flex: "1 1 320px", minWidth: 0 }}
              >
                {cam.rois.length === 0 && !cam.flow && <p style={{ color: "var(--muted)" }}>No ROIs yet — use the ROI editor.</p>}
                {cam.rois.map((r) => {
                  const on = focus?.camera === cam.camera && focus.feature === r.feature;
                  return (
                    <div key={r.feature} style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <button
                      aria-label={`ROI ${r.feature} of ${cam.camera}`}
                      aria-pressed={on}
                      onClick={() => {
                        setFocus({ camera: cam.camera, feature: r.feature });
                        onSelectCamera(cam.camera);
                      }}
                      onMouseEnter={() => setHover({ camera: cam.camera, feature: r.feature })}
                      onMouseLeave={() => setHover(null)}
                      style={{
                        textAlign: "left",
                        padding: 6,
                        color: "var(--fg)",
                        background: on ? "var(--info-bg)" : "var(--bg)",
                        border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                        borderRadius: "var(--radius)",
                        cursor: "pointer",
                      }}
                    >
                      {cam.picture_frame && (
                        <img
                          src={thumbUrl(cam.camera, cam.picture_frame, r.feature)}
                          alt=""
                          loading="lazy"
                          style={{ maxWidth: "100%", display: "block", marginBottom: 4 }}
                        />
                      )}
                      <strong>{r.short_name}</strong>
                      {r.role === "classify" && <span style={{ ...chip, marginLeft: 4 }}>classify</span>}
                      <div style={{ fontSize: 12, color: "var(--muted)" }}>{scopeOf(r)}</div>
                      <div style={{ fontSize: 12 }}>
                        {r.labeled} labeled · {r.goldens} golden
                        {r.active_version !== null ? ` · v${r.active_version}` : ""}
                      </div>
                    </button>
                    {r.pipeline && (
                      <div data-testid={`pipeline-${cam.camera}-${r.feature}`}>
                        <LabelProgress pipeline={r.pipeline} />
                        <PipelineChips pipeline={r.pipeline} size="small" onOpen={(stage) => onOpenStage?.(cam.camera, r, stage)} />
                      </div>
                    )}
                    </div>
                  );
                })}
                <FlowCards cam={cam} onOpen={onOpenFlow} />
              </div>
            </div>
          </section>
        );
      })}
    </section>
  );
}
