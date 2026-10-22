import type { FlowSummaryStep } from "../api";

/** The count of each step type of a Picture edits box, and whether every step of the type is off. A type that is not in the list is absent. */
export function stepCounts(steps: FlowSummaryStep[] | undefined): { op: "crop" | "filter"; count: number; allOff: boolean }[] {
  const out: { op: "crop" | "filter"; count: number; allOff: boolean }[] = [];
  for (const op of ["crop", "filter"] as const) {
    const of = (steps ?? []).filter((s) => s.op === op);
    if (of.length) out.push({ op, count: of.length, allOff: of.every((s) => s.enabled === false) });
  }
  return out;
}

const ICON_LABEL = { crop: "Crop", filter: "Filter" } as const;

/** Two small drawn icons (crop corners, filter sliders); a badge shows the number when a type is used more than once. */
export default function StepIcons({ steps }: { steps: FlowSummaryStep[] | undefined }) {
  const kinds = stepCounts(steps);
  if (kinds.length === 0) return <div className="chain-node-sub">no steps yet</div>;
  return (
    <div className="chain-step-icons" aria-label="Steps">
      {kinds.map(({ op, count, allOff }) => (
        <span
          key={op}
          className={`chain-step-icon${allOff ? " off" : ""}`}
          data-testid={`step-icon-${op}`}
          title={`${ICON_LABEL[op]}${count > 1 ? ` × ${count}` : ""}${allOff ? " (off)" : ""}`}
        >
          <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {op === "crop" ? (
              <>
                <path d="M6 2v14a2 2 0 0 0 2 2h14" />
                <path d="M2 6h14a2 2 0 0 1 2 2v14" />
              </>
            ) : (
              <>
                <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
                <circle cx="16" cy="7" r="2" />
                <circle cx="8" cy="17" r="2" />
              </>
            )}
          </svg>
          {count > 1 && <span className="chain-step-badge">{count}</span>}
        </span>
      ))}
    </div>
  );
}
