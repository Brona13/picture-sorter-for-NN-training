import { CardData, frameImageUrl } from "../api";
import { methodTag } from "../methodTags";
import { classColor, clusterColor } from "./colors";
import { cursorFor, DELETE_MODE, isClearKey, labelPainter, markPainted } from "./paint";
import { useGridCard } from "./useGridCard";

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
  /** False when a deleted card cannot be restored from this grid (the button is then disabled and says where to restore it). */
  canRestore?: boolean;
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
 * remove it), 0 or X clears, the key left of 1 (``Backquote``, whatever it prints) toggles golden, and
 * Delete soft-deletes the frame. Held while the mouse moves over cards, the same keys sweep (see `paint.ts`).
 */
export const MAX_SHORTCUT_CLASSES = 9;

export default function Card({ camera, feature, classes, methods, card, busy, onLabel, onGolden, onDelete, onRestore, canRestore = true, isRep, onSetRep, fullSize, onOpen, caption, onSimilar }: Props) {
  const { frame, label, golden, deleted, bars, leanings, cluster, edge } = card;
  // Search results only: a picture outside this ROI's scope gets a red frame and cannot be labeled here until its
  // product fits (open it to change the product); a muted one gets a dark grey dashed frame.
  const outside = !!card.outside;
  const muted = !!card.muted;
  const frameHint = outside
    ? card.product
      ? `In product ${card.product}, so outside this ROI. Open the picture to change its product.`
      : "No product yet, so outside this ROI. Open the picture to set its product."
    : muted
      ? "Muted for this ROI, so hidden from its grid. Open the picture to unmute it."
      : undefined;

  // The shared grid-card behaviour (`useGridCard`): number keys act on the card under the mouse, and holding one while moving
  // the mouse paints the cards. The page-specific part is only what a key does to a labeling card.
  const { props } = useGridCard(labelPainter, frame, {
    onKey: (e) => {
      const isGoldenKey = e.code === "Backquote";
      const isDeleteKey = e.key === "Delete";
      const clear = isClearKey(e);
      if (!isGoldenKey && !isDeleteKey && !clear && !/^[0-9]$/.test(e.key)) return false;
      if (busy || deleted || (outside && !isDeleteKey)) return false;
      if (!isGoldenKey) markPainted(frame);
      if (isDeleteKey) {
        onDelete();
        return true;
      }
      if (isGoldenKey) {
        if (label === null) return false; // a golden is always a labeled frame
        onGolden(!golden);
        return true;
      }
      if (clear) {
        if (label !== null) onLabel(null);
        return true;
      }
      const n = Number(e.key);
      if (n === 0) {
        if (label !== null) onLabel(null);
      } else {
        const cls = classes[n - 1];
        if (cls === undefined || n > MAX_SHORTCUT_CLASSES) return false;
        onLabel(label === cls ? null : cls);
      }
      return true;
    },
    // Painting: a class key labels unlabeled cards, 0 / X clear labeled non-golden ones, Delete deletes unlabeled non-golden
    // ones (a labeled picture is deleted by a single press only); a picture outside the ROI keeps its labels, so it is never swept.
    paint: (mode) => {
      if (busy || deleted || golden || outside) return false;
      if (mode === DELETE_MODE) {
        if (label !== null) return false;
        onDelete();
        return true;
      }
      const n = Number(mode);
      if (n >= 1 && (n > MAX_SHORTCUT_CLASSES || classes[n - 1] === undefined)) return false;
      if (n === 0 ? label === null : label !== null) return false;
      onLabel(n === 0 ? null : classes[n - 1]);
      return true;
    },
    cursorOf: (mode) => cursorFor(mode, classes),
  });

  return (
    <li
      data-testid={`card-${frame}`}
      {...props}
      title={frameHint}
      style={{
        border: outside ? "2px solid #c62828" : muted ? "2px dashed #555" : "1px solid #ccc",
        borderRadius: 8,
        padding: outside || muted ? 5 : 6,
        listStyle: "none",
      }}
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
            disabled={busy || outside || deleted}
            aria-pressed={label === c}
            title={
              (outside ? "Outside this ROI: set the picture's product first (open it). " : "") +
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
          disabled={busy || label === null || outside || deleted}
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
          disabled={busy || (deleted && !canRestore)}
          title={
            deleted
              ? canRestore
                ? "Restore this frame — it comes back into view across every ROI on this camera."
                : "Deleted. Restore it in Classify, under Show: Deleted."
              : "Soft-delete (camera-wide; shortcut: hover and press Delete, or hold Delete and move over unlabeled cards). The file stays on disk; Show: Deleted lists it again."
          }
          onClick={deleted ? onRestore : onDelete}
        >
          {deleted ? "↺" : "🗑"}
        </button>
      </div>
    </li>
  );
}
