import { useEffect, useState } from "react";
import { api, OverviewCamera, RoiInfo } from "../api";
import { thumbUrl } from "../classify/Card";

const SIZE_KEY = "overview.pictureSize";
const SIZE_MIN = 150;
const SIZE_MAX = 800;
const SIZE_DEFAULT = 400;

function storedSize(): number {
  try {
    const v = Number(localStorage.getItem(SIZE_KEY));
    if (v >= SIZE_MIN && v <= SIZE_MAX) return v;
  } catch {
    /* storage unavailable */
  }
  return SIZE_DEFAULT;
}

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
    </div>
  );
}

/** Every camera with its reference frame and ROIs; clicking one makes it the active camera. */
export default function OverviewView({
  camera,
  onSelectCamera,
}: {
  camera: string;
  onSelectCamera: (camera: string) => void;
}) {
  const [cams, setCams] = useState<OverviewCamera[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus>(null);
  const [hover, setHover] = useState<Focus>(null);
  const [size, setSize] = useState(storedSize);
  const resize = (v: number) => {
    setSize(v);
    try {
      localStorage.setItem(SIZE_KEY, String(v));
    } catch {
      /* storage unavailable */
    }
  };

  useEffect(() => {
    api
      .overview()
      .then((r) => setCams(r.cameras))
      .catch((e: unknown) => setError(msg(e)));
  }, []);

  if (error) return <p role="alert">{error}</p>;
  if (!cams) return <p>Loading…</p>;

  const activeFeature = (cam: string): string | null =>
    (hover?.camera === cam ? hover.feature : null) ?? (focus?.camera === cam ? focus.feature : null);

  return (
    <section>
      <h2>Overview</h2>
      <p>Every camera with its reference frame and ROIs. Click a camera or ROI to select it in the menu.</p>
      <label>
        Picture size{" "}
        <input
          type="range"
          aria-label="Picture size"
          min={SIZE_MIN}
          max={SIZE_MAX}
          step={10}
          value={size}
          onChange={(e) => resize(Number(e.target.value))}
        />{" "}
        <output>{size} px</output>
      </label>
      {cams.length === 0 && <p>No cameras yet — create one on the Ingest page.</p>}
      {cams.map((cam) => {
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
              <span style={{ flex: 1 }} />
              <button
                aria-pressed={selected}
                aria-label={`Select camera ${cam.camera}`}
                onClick={() => onSelectCamera(cam.camera)}
              >
                {selected ? "✓ Selected" : "Select"}
              </button>
            </header>
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
                {cam.rois.length === 0 && <p style={{ color: "var(--muted)" }}>No ROIs yet — use the ROI editor.</p>}
                {cam.rois.map((r) => {
                  const on = focus?.camera === cam.camera && focus.feature === r.feature;
                  return (
                    <button
                      key={r.feature}
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
                  );
                })}
              </div>
            </div>
          </section>
        );
      })}
    </section>
  );
}
