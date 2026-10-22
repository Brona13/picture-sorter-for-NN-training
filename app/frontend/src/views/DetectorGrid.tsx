import { useEffect, useMemo, useState } from "react";
import { FlowBox } from "../api";
import CardGrid from "../classify/CardGrid";
import { PagerSettings } from "../classify/Pager";
import { isPageSize } from "../classify/gridSizes";
import { drawn } from "../pixelCentre";

const OPTIONS = { per_page_options: [12, 24, 48, 96], cols_options: [3, 4, 5, 6, 8] };
const STORE = "flow.detectorGrid";
export const TARGET_COLORS = ["#ff9f1c", "#2ec4ff", "#7bd389", "#e07bff", "#ffe066", "#ff6b6b", "#5ee0c4", "#b0b7c3"];

function stored(): { per_page: number; cols: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? "{}");
    if (isPageSize(raw.per_page) && OPTIONS.cols_options.includes(raw.cols)) return raw;
  } catch { /* the grid still works without the remembered size */ }
  return { per_page: 24, cols: 4 };
}

type Status = "all" | "found" | "missing" | "same";

/**
 * Pairs of targets whose boxes lie on the same spot in one picture: the centres are closer than half the shorter side
 * of the smaller box. Two different targets on the same spot (both holes found on one hole) is always a bad detection.
 */
export function sameSpot(found: Record<string, FlowBox> | undefined): [string, string][] {
  const names = Object.keys(found ?? {});
  const pairs: [string, string][] = [];
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const a = found![names[i]];
      const b = found![names[j]];
      const reach = Math.min(a.w, a.h, b.w, b.h) / 2;
      if (Math.hypot(a.x - b.x, a.y - b.y) < reach) pairs.push([names[i], names[j]]);
    }
  }
  return pairs;
}

/**
 * Every picture of the detector as a card, with the boxes it found drawn on the thumbnail, so a bad detection shows at a
 * glance. Filter by target (whose boxes are drawn and counted) and by what was found; a click on a card loads that picture
 * in the canvas above, where another example can be drawn. Shown once the detector has run.
 */
export default function DetectorGrid({ frames, boxes, targets, current, size, imageUrl, onPick }: {
  frames: string[];
  boxes: Record<string, Record<string, FlowBox>>;
  /** The targets that have examples, in the order of the detector (their colour follows it). */
  targets: string[];
  current: string | undefined;
  /** Size of the picture the boxes are in (pixels); the boxes are not drawn until it is known. */
  size: { w: number; h: number } | null;
  imageUrl: (frame: string) => string;
  onPick: (frame: string) => void;
}) {
  const [grid, setGrid] = useState(stored);
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const settings: PagerSettings = { ...grid, ...OPTIONS };
  const chosen = target && targets.includes(target) ? target : "";
  const shownTargets = chosen ? [chosen] : targets;
  const colorOf = (name: string) => TARGET_COLORS[targets.indexOf(name) % TARGET_COLORS.length];

  const info = useMemo(() => {
    const out = new Map<string, { found: string[]; missing: string[]; same: [string, string][] }>();
    for (const f of frames) {
      const here = boxes[f] ?? {};
      out.set(f, {
        found: shownTargets.filter((t) => here[t]),
        missing: shownTargets.filter((t) => !here[t]),
        same: sameSpot(here).filter(([a, b]) => !chosen || a === chosen || b === chosen),
      });
    }
    return out;
  }, [frames, boxes, shownTargets.join("\u0000"), chosen]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(
    () =>
      frames.filter((f) => {
        const i = info.get(f)!;
        if (status === "found") return i.missing.length === 0;
        if (status === "missing") return i.missing.length > 0;
        if (status === "same") return i.same.length > 0;
        return true;
      }),
    [frames, info, status],
  );
  useEffect(() => setPage(1), [rows.length, chosen, status]);

  const change = (per_page: number, cols: number) => {
    setGrid({ per_page, cols });
    setPage(1);
    try { localStorage.setItem(STORE, JSON.stringify({ per_page, cols })); } catch { /* not remembered */ }
  };
  const count = (t: string) => frames.filter((f) => boxes[f]?.[t]).length;
  const sameCount = frames.filter((f) => sameSpot(boxes[f]).length > 0).length;

  return (
    <section data-testid="detector-grid" aria-label="Detector findings">
      <div className="flow-nav">
        <strong>Findings</strong>
        <label>
          Target{" "}
          <select value={chosen} onChange={(e) => setTarget(e.target.value)}>
            <option value="">All targets</option>
            {targets.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label>
          Show{" "}
          <select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
            <option value="all">All pictures</option>
            <option value="found">{chosen ? "Found" : "All targets found"}</option>
            <option value="missing">{chosen ? "Not found" : "Some target not found"}</option>
            <option value="same">Targets on the same spot ({sameCount})</option>
          </select>
        </label>
        <span className="muted">
          {targets.map((t) => (
            <span key={t} style={{ marginRight: 10, whiteSpace: "nowrap" }}>
              <span aria-hidden style={{ display: "inline-block", width: 10, height: 10, background: colorOf(t), border: "1px solid #000", marginRight: 4 }} />
              {t} {count(t)}/{frames.length}
            </span>
          ))}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="muted">No pictures match.</p>
      ) : (
        <CardGrid
          items={rows}
          keyOf={(f) => f}
          settings={settings}
          onSettings={change}
          page={page}
          onPage={setPage}
          where="findings"
          container="div"
          renderCard={(f) => {
            const i = info.get(f)!;
            const here = boxes[f] ?? {};
            return (
              <article
                data-testid={`finding-${f}`}
                aria-current={f === current}
                style={{
                  border: `1px solid ${i.same.length ? "#e08a00" : "var(--border)"}`,
                  outline: f === current ? "2px solid var(--fg)" : undefined,
                  borderRadius: "var(--radius)",
                  background: "var(--panel)",
                  padding: 6,
                  minWidth: 0,
                  boxSizing: "border-box",
                }}
              >
                <button
                  type="button"
                  aria-label={`Load ${f} in the canvas`}
                  title="Load this picture in the canvas above"
                  onClick={(e) => { e.currentTarget.blur(); onPick(f); }}
                  style={{ display: "block", width: "100%", padding: 0, border: 0, background: "none", lineHeight: 0, cursor: "pointer", position: "relative" }}
                >
                  <img src={imageUrl(f)} alt="" loading="lazy" style={{ width: "100%", display: "block" }} />
                  {size && (
                    <svg viewBox={`0 0 ${size.w} ${size.h}`} data-testid={`finding-boxes-${f}`} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
                      {shownTargets.map((t) => {
                        const b = here[t];
                        if (!b) return null;
                        const c = drawn(b);
                        return (
                          <g key={t} transform={`translate(${c.x} ${c.y}) rotate(${-b.angle})`}>
                            <rect x={-b.w / 2} y={-b.h / 2} width={b.w} height={b.h} fill="none" stroke="rgba(0,0,0,.8)" strokeWidth={4} vectorEffect="non-scaling-stroke" />
                            <rect x={-b.w / 2} y={-b.h / 2} width={b.w} height={b.h} fill="none" stroke={colorOf(t)} strokeWidth={2} strokeDasharray={b.source === "human" ? "5 3" : undefined} vectorEffect="non-scaling-stroke" />
                          </g>
                        );
                      })}
                    </svg>
                  )}
                </button>
                <div style={{ fontSize: 12, margin: "4px 0 2px", wordBreak: "break-all" }}>{f}</div>
                <div style={{ fontSize: 12, display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {i.missing.map((t) => <span key={t} className="flow-missing" title={`${t} not found`}>✗ {t}</span>)}
                  {i.same.length > 0 && <span className="flow-missing" title={i.same.map(([a, b]) => `${a} and ${b}`).join("; ")}>same spot: {i.same.map(([a, b]) => `${a} = ${b}`).join(", ")}</span>}
                  {i.missing.length === 0 && i.same.length === 0 && <span className="muted">✓ found</span>}
                </div>
              </article>
            );
          }}
        />
      )}
    </section>
  );
}
