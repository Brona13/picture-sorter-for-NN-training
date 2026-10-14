import { useEffect, useRef, useState } from "react";
import { CardData } from "../api";
import { classColor, clusterColor } from "./colors";

interface Props {
  camera: string;
  feature: string;
  classes: string[];
  methods: string[];
  card: CardData;
  busy: boolean;
  onLabel: (cls: string | null) => void;
  onGolden: (on: boolean) => void;
  onDelete: () => void;
  onRestore: () => void;
}

export function thumbUrl(camera: string, frame: string, feature: string) {
  return (
    `/api/cameras/${encodeURIComponent(camera)}/frames/${encodeURIComponent(frame)}/thumb` +
    `?feature=${encodeURIComponent(feature)}`
  );
}

const badge = (bg: string): React.CSSProperties => ({
  background: bg,
  color: "#fff",
  padding: "1px 5px",
  borderRadius: 3,
  fontSize: 11,
});

/**
 * Keyboard shortcuts act on the hovered card: 1-9 pick the class in that position (again to
 * remove it), 0 clears, and the key left of 1 (``Backquote``, whatever it prints) toggles golden.
 */
export const MAX_SHORTCUT_CLASSES = 9;

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName));
}

export default function Card({ camera, feature, classes, methods, card, busy, onLabel, onGolden, onDelete, onRestore }: Props) {
  const { frame, label, golden, deleted, bars, leanings, cluster } = card;
  const tag = golden ? `⭐${golden}` : label ?? "—";

  // Number keys act on the card under the mouse. The handler is reread from a ref so the window
  // listener only comes and goes with hovering, not with every render.
  const [hovered, setHovered] = useState(false);
  const latest = useRef({ classes, label, golden, busy, deleted, onLabel, onGolden });
  latest.current = { classes, label, golden, busy, deleted, onLabel, onGolden };
  useEffect(() => {
    if (!hovered) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || isTypingTarget(e.target)) return;
      const isGoldenKey = e.code === "Backquote";
      if (!isGoldenKey && !/^[0-9]$/.test(e.key)) return;
      const cur = latest.current;
      if (cur.busy || cur.deleted) return;
      if (isGoldenKey) {
        if (cur.label === null) return; // a golden is always a labeled frame
        cur.onGolden(!cur.golden);
        e.preventDefault();
        return;
      }
      const n = Number(e.key);
      if (n === 0) {
        if (cur.label !== null) cur.onLabel(null);
      } else {
        const cls = cur.classes[n - 1];
        if (cls === undefined || n > MAX_SHORTCUT_CLASSES) return;
        cur.onLabel(cur.label === cls ? null : cls);
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hovered]);

  return (
    <li
      data-testid={`card-${frame}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ border: "1px solid #ccc", borderRadius: 8, padding: 6, listStyle: "none" }}
    >
      <img
        src={thumbUrl(camera, frame, feature)}
        alt={frame}
        loading="lazy"
        style={{ width: "100%", display: "block", borderRadius: 4, opacity: deleted ? 0.5 : 1 }}
      />

      {golden ? (
        <div style={{ margin: "2px 0 6px", fontSize: 11 }}>
          <span style={badge(classColor(golden, classes))}>⭐ {golden}</span>
          <span style={{ opacity: 0.6 }}> reference — not scored</span>
        </div>
      ) : (
        Object.keys(leanings).length > 0 && (
          <div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, margin: "2px 0" }}>
              {methods.map((m) => {
                const l = leanings[m];
                return l ? (
                  <span key={m} title={m} style={badge(classColor(l, classes))}>
                    {l}
                  </span>
                ) : (
                  <span key={m} title={m} style={{ opacity: 0.45 }}>
                    –
                  </span>
                );
              })}
            </div>
            {bars && (
              <div>
                {bars.rows.map((r) => (
                  <div key={r.cls} style={{ display: "flex", alignItems: "center", gap: 6, margin: "2px 0" }}>
                    <span
                      title={r.cls}
                      style={{
                        width: 40,
                        flex: "none",
                        fontSize: 10,
                        opacity: r.dist === null ? 0.35 : r.leader ? 1 : 0.45,
                        fontWeight: r.leader ? 600 : 400,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.cls}
                    </span>
                    <span style={{ flex: 1, height: 7, borderRadius: 4, background: "rgba(128,128,128,.22)", overflow: "hidden" }}>
                      <span
                        data-testid={`bar-${r.cls}`}
                        style={{
                          display: "block",
                          height: "100%",
                          width: `${r.dist === null ? 0 : Math.max(r.rel * 100, 2)}%`,
                          background: classColor(r.cls, classes),
                          opacity: r.leader ? 1 : 0.45,
                        }}
                      />
                    </span>
                  </div>
                ))}
                <div style={{ fontSize: 10, opacity: 0.6, marginTop: 3 }}>
                  {bars.close_call ? "⚠ close call · " : ""}nov {bars.novelty.toFixed(3)}
                  {bars.margin !== null ? ` · margin ${bars.margin.toFixed(3)}` : ""}
                </div>
              </div>
            )}
          </div>
        )
      )}

      <div style={{ fontSize: 12 }}>
        {frame.slice(0, 22)}
        <br />
        <strong>{tag}</strong>
      </div>

      {cluster && (
        <div style={{ margin: "2px 0 4px", fontSize: 10 }}>
          <span style={badge(clusterColor(cluster.id))}>
            {cluster.id < 0 ? "unique" : `cluster ${cluster.id}${cluster.is_rep ? " · rep" : ""}`}
          </span>
        </div>
      )}

      <div className="card-actions">
        {classes.map((c, i) => (
          <button
            key={c}
            disabled={busy}
            aria-pressed={label === c}
            title={
              (label === c ? "Click to remove the label. " : "") +
              (i < MAX_SHORTCUT_CLASSES ? `Hover the card and press ${i + 1}.` : "")
            }
            onClick={() => onLabel(label === c ? null : c)}
            style={label === c ? { background: classColor(c, classes), color: "#fff" } : undefined}
          >
            {i < MAX_SHORTCUT_CLASSES && (
              <kbd aria-hidden="true" style={{ opacity: 0.6, marginRight: 4, fontSize: 10 }}>
                {i + 1}
              </kbd>
            )}
            {c}
          </button>
        ))}
        <button
          aria-label={golden ? "Remove golden" : "Make golden"}
          disabled={busy || label === null}
          title={
            label === null
              ? "Label the frame first, then star it to make it a golden reference for that class. Shortcut: the key left of 1."
              : golden
                ? `Currently a ⭐${golden} reference — click to remove.`
                : `Mark as a golden reference for ${label}.`
          }
          onClick={() => onGolden(!golden)}
        >
          {golden ? "⭐" : "☆"}
        </button>
        <button
          aria-label={deleted ? "Restore frame" : "Delete frame"}
          disabled={busy}
          title={
            deleted
              ? "Restore this frame — it comes back into view across every ROI on this camera."
              : "Soft-delete (camera-wide). The file stays on disk; switch Show to Deleted to see it again."
          }
          onClick={deleted ? onRestore : onDelete}
        >
          {deleted ? "↺" : "🗑"}
        </button>
      </div>
    </li>
  );
}
