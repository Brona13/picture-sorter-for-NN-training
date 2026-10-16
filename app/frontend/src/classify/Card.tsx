import { useEffect, useRef, useState } from "react";
import { CardData, frameImageUrl } from "../api";
import { methodTag } from "../methodTags";
import { classColor, clusterColor } from "./colors";
import { markPainted, paintAction, trackPaintKey } from "./paint";

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
  /** Dedup cluster browser only: marks the card the representative of its cluster. */
  isRep?: boolean;
  onSetRep?: () => void;
  /** Clicking the picture opens the full image: in the viewer when onOpen is given, else in a new tab. */
  fullSize?: boolean;
  onOpen?: () => void;
  /** Small neutral badge under the file name, e.g. an outlier score. */
  caption?: string;
  /** Classify only: open "Find similar" with this (labeled) frame as the seed. */
  onSimilar?: () => void;
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
 * remove it), 0 clears, the key left of 1 (``Backquote``, whatever it prints) toggles golden, and
 * Delete soft-deletes the frame.
 */
export const MAX_SHORTCUT_CLASSES = 9;

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName));
}

export default function Card({ camera, feature, classes, methods, card, busy, onLabel, onGolden, onDelete, onRestore, isRep, onSetRep, fullSize, onOpen, caption, onSimilar }: Props) {
  const { frame, label, golden, deleted, bars, leanings, cluster, edge } = card;

  // Number keys act on the card under the mouse. The handler is reread from a ref so the window
  // listener only comes and goes with hovering, not with every render.
  const [hovered, setHovered] = useState(false);
  useEffect(trackPaintKey, []);
  const latest = useRef({ classes, label, golden, busy, deleted, onLabel, onGolden, onDelete });
  latest.current = { classes, label, golden, busy, deleted, onLabel, onGolden, onDelete };
  useEffect(() => {
    if (!hovered) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || isTypingTarget(e.target)) return;
      const isGoldenKey = e.code === "Backquote";
      const isDeleteKey = e.key === "Delete";
      if (!isGoldenKey && !isDeleteKey && !/^[0-9]$/.test(e.key)) return;
      const cur = latest.current;
      if (cur.busy || cur.deleted) return;
      if (!isGoldenKey && !isDeleteKey) markPainted(frame);
      if (isDeleteKey) {
        cur.onDelete();
        e.preventDefault();
        return;
      }
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
      onMouseMove={(e) => {
        const act = paintAction(e.nativeEvent, { frame, label, golden, deleted, busy }, classes, MAX_SHORTCUT_CLASSES);
        if (act !== undefined) onLabel(act);
      }}
      style={{ border: "1px solid #ccc", borderRadius: 8, padding: 6, listStyle: "none" }}
    >
      {(() => {
        const img = (
          <img
            src={thumbUrl(camera, frame, feature)}
            alt={frame}
            loading="lazy"
            style={{ width: "100%", display: "block", borderRadius: 4, opacity: deleted ? 0.5 : 1 }}
          />
        );
        return fullSize ? (
          <a
            href={frameImageUrl(camera, frame)}
            target="_blank"
            rel="noreferrer"
            title="Open the full image"
            onClick={(e) => {
              // A plain click opens the viewer; ctrl/middle click still opens a tab.
              if (onOpen && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
                e.preventDefault();
                onOpen();
              }
            }}
          >
            {img}
          </a>
        ) : (
          img
        );
      })()}

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
                const tag = methodTag(m);
                // The tag says which method it is; the colour is the class it leans to (see the bars below).
                return l ? (
                  <span key={m} data-testid={`flag-${m}`} title={`${tag} leans ${l}`} aria-label={`${tag} leans ${l}`} style={badge(classColor(l, classes))}>
                    {tag}
                  </span>
                ) : (
                  <span key={m} data-testid={`flag-${m}`} title={`${tag}: no leaning yet`} aria-label={`${tag}: no leaning yet`} style={{ ...badge("#777"), opacity: 0.45 }}>
                    {tag}
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

      <div style={{ fontSize: 12 }}>{frame.slice(0, 22)}</div>

      {edge && (
        <div style={{ margin: "2px 0 4px", fontSize: 10 }} data-testid="edge-badge">
          <span
            title="Edge-angle rule: the measured angle (counter-clockwise on screen) and which side is brighter. A separate rule-based opinion, not blended with the scores."
            style={badge(edge.verdict === "pass" ? "#1a7f37" : edge.verdict === "fail" ? "#c62828" : "#777")}
          >
            ∠ {edge.angle === null ? "no edge" : `${edge.angle.toFixed(1)}° ${edge.polarity}`}
            {edge.verdict ? ` · ${edge.verdict}` : ""}
          </span>
        </div>
      )}

      {caption && (
        <div style={{ margin: "2px 0 4px", fontSize: 10 }}>
          <span style={badge("#555")}>{caption}</span>
        </div>
      )}

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
              (i < MAX_SHORTCUT_CLASSES ? `Hover the card and press ${i + 1}. Hold the key and move the mouse over cards to paint it on unlabeled ones.` : "")
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
        {onSetRep && (
          <button
            aria-label={isRep ? "Representative of this cluster" : "Make representative"}
            aria-pressed={!!isRep}
            disabled={busy || isRep}
            title={isRep ? "This frame stays visible in Classify; the rest of the cluster is muted on Apply." : "Keep this frame as the cluster's representative."}
            onClick={onSetRep}
            style={isRep ? { background: "#111", color: "#fff" } : undefined}
          >
            {isRep ? "◉ rep" : "○ rep"}
          </button>
        )}
        {onSimilar && (
          <button
            aria-label="Find similar"
            disabled={busy || label === null}
            title={label === null ? "Label this frame first: its label is what gets applied to the matches." : "Find unlabeled frames that look like this one and label them as a batch."}
            onClick={onSimilar}
          >
            🔍≈
          </button>
        )}
        <button
          aria-label={deleted ? "Restore frame" : "Delete frame"}
          disabled={busy}
          title={
            deleted
              ? "Restore this frame — it comes back into view across every ROI on this camera."
              : "Soft-delete (camera-wide; shortcut: hover and press Delete). The file stays on disk; switch Show to Deleted to see it again."
          }
          onClick={deleted ? onRestore : onDelete}
        >
          {deleted ? "↺" : "🗑"}
        </button>
      </div>
    </li>
  );
}
