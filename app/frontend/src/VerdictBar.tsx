import { VerdictSummary } from "./api";

export const SEGMENTS = [
  { key: "ok", label: "OK", color: "#2e9e5b" },
  { key: "ng", label: "NG", color: "#d64545" },
  { key: "contradiction", label: "contradictions", color: "#e08a00" },
  { key: "stale", label: "stale", color: "#8a5cd6" },
  { key: "open", label: "open", color: "#9aa0a6" },
  { key: "duplicates", label: "duplicates", color: "#c9ccd1" },
] as const;

/**
 * Where the pictures of a camera stand: a stacked bar over the pictures that are not deleted plus a legend.
 * Deleted pictures and Dedup duplicates are shown as their own numbers because they are part of the work.
 */
export default function VerdictBar({ summary }: { summary: VerdictSummary }) {
  const total = Math.max(summary.total, 1);
  const decided = summary.ok + summary.ng;
  return (
    <div data-testid="verdict-bar" style={{ fontSize: 12, margin: "6px 0" }}>
      <div
        role="progressbar"
        aria-label="Pictures with a verdict"
        aria-valuemin={0}
        aria-valuemax={summary.total}
        aria-valuenow={decided}
        style={{ display: "flex", height: 8, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}
      >
        {SEGMENTS.map((s) => {
          const n = summary[s.key];
          return n > 0 ? <div key={s.key} title={`${s.label}: ${n}`} style={{ width: `${(n / total) * 100}%`, background: s.color }} /> : null;
        })}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 12px", marginTop: 3 }}>
        <strong>
          {decided} of {summary.total} with a verdict
        </strong>
        {SEGMENTS.map((s) => (
          <span key={s.key} data-testid={`verdict-${s.key}`}>
            <span aria-hidden="true" style={{ display: "inline-block", width: 8, height: 8, background: s.color, borderRadius: 2, marginRight: 4 }} />
            {summary[s.key]} {s.label}
          </span>
        ))}
        <span data-testid="verdict-deleted">🗑️ {summary.deleted} deleted</span>
      </div>
    </div>
  );
}
