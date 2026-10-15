import { PipelineInfo, PipelineStage } from "./api";

const ICON: Record<PipelineStage["status"], string> = { done: "✓", partial: "◐", stale: "⚠", todo: "○" };
const WORD: Record<PipelineStage["status"], string> = { done: "done", partial: "in progress", stale: "out of date", todo: "not started" };

export const stageTitle = (s: PipelineStage): string =>
  `${s.label}: ${WORD[s.status]}${s.detail ? ` — ${s.detail}` : ""}${s.optional ? " (optional)" : ""}`;

/**
 * The pipeline stages of one ROI as a row of buttons. Done stages are green, the next required one is
 * outlined, optional ones are dashed. Clicking a stage opens the page that does it.
 */
export default function PipelineChips({
  pipeline,
  current,
  onOpen,
  size = "normal",
}: {
  pipeline: PipelineInfo;
  /** The page being shown (a route path), so its stages are marked as the current step. */
  current?: string;
  onOpen: (stage: PipelineStage) => void;
  size?: "normal" | "small";
}) {
  return (
    <ol aria-label={`Pipeline of ${pipeline.feature}`} style={{ display: "flex", flexWrap: "wrap", gap: 4, listStyle: "none", margin: 0, padding: 0 }}>
      {pipeline.stages.map((s) => {
        const isNext = pipeline.next === s.id;
        const done = s.status === "done";
        const isCurrent = current !== undefined && s.view === current;
        return (
          <li key={s.id}>
            <button
              type="button"
              data-testid={`stage-${s.id}`}
              data-status={s.status}
              aria-label={stageTitle(s)}
              aria-current={isCurrent ? "step" : undefined}
              title={stageTitle(s)}
              onClick={() => onOpen(s)}
              style={{
                fontSize: size === "small" ? 11 : 12,
                padding: size === "small" ? "0 6px" : "1px 8px",
                borderRadius: 10,
                cursor: "pointer",
                color: done ? "#fff" : "var(--fg)",
                background: done ? "#1a7f37" : s.status === "stale" ? "#fff3cd" : "var(--bg)",
                border: `${isNext || isCurrent ? 2 : 1}px ${s.optional && !done ? "dashed" : "solid"} ${isNext ? "var(--accent)" : isCurrent ? "#ff9800" : done ? "#1a7f37" : "var(--border)"}`,
                fontWeight: isNext || isCurrent ? 700 : 400,
                opacity: s.optional && s.status === "todo" ? 0.7 : 1,
              }}
            >
              <span aria-hidden="true">{ICON[s.status]}</span> {s.label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Labeled frames as a share of the ROI's frames. */
export function LabelProgress({ pipeline }: { pipeline: PipelineInfo }) {
  const share = pipeline.frames > 0 ? Math.min(1, pipeline.labeled / pipeline.frames) : 0;
  return (
    <div style={{ fontSize: 11, margin: "4px 0" }}>
      <div
        role="progressbar"
        aria-label="Labeled frames"
        aria-valuemin={0}
        aria-valuemax={pipeline.frames}
        aria-valuenow={pipeline.labeled}
        style={{ height: 6, background: "var(--border)", borderRadius: 3, overflow: "hidden" }}
      >
        <div style={{ width: `${share * 100}%`, height: "100%", background: "var(--accent)" }} />
      </div>
      {pipeline.labeled} of {pipeline.frames} frames labeled
    </div>
  );
}
