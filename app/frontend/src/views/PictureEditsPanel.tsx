import { DragEvent, useState } from "react";
import { FLOW_OUTPUTS, FlowCrop, FlowEdit } from "../api";
import { PanelSection } from "../SidePanel";
import FilterParams, { paramText } from "./FilterParams";
import type { PictureEdits } from "./pictureEdits";

const OPS = { crop: "Crop", filter: "Filter" } as const;

/** One line for a step that is not the selected one. */
export function describeEdit(s: FlowEdit, filters: PictureEdits["filters"], follows: boolean): string {
  if (s.op === "filter") {
    const spec = filters[s.name];
    const params = Object.entries(s.params).map(([k, v]) => `${spec?.params[k]?.label ?? k} ${paramText(spec?.params[k], v)}`).join(", ");
    return `${spec?.label ?? s.name}${params ? ` · ${params}` : ""}`;
  }
  if (follows) return "follows the target";
  return s.rect ? `${Math.round(s.rect[2] * 100)} × ${Math.round(s.rect[3] * 100)} % of the picture` : "no crop drawn yet";
}

/**
 * The options of a Picture Edits box: its steps in the order they run on every picture, and the parameters of the
 * selected one. A step is added from the drop-down at the bottom; the order is changed by dragging a step by its grip
 * (or with the arrow buttons). What the selected step does shows in the big picture while the parameters change.
 */
export default function PictureEditsPanel({ edits }: { edits: PictureEdits }) {
  const { steps, selected, filters, detail } = edits;
  const [from, setFrom] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const following = detail?.follow ?? null;
  const followId = detail?.follow_step ?? null;

  const drop = (to: number) => (e: DragEvent) => {
    e.preventDefault();
    if (from !== null) edits.moveStep(from, to);
    setFrom(null);
    setOver(null);
  };

  return (
    <PanelSection title="Picture edits">
      <p className="muted">
        Each step runs on every picture, top to bottom, before the picture goes on to the next box. Nothing is written to
        disk. Drag a step by its grip to change the order; the switch skips a step without removing it.
      </p>
      {steps.length === 0 && <p className="muted">No steps yet: the picture passes on unchanged.</p>}
      <ol className="pe-steps" aria-label="Steps" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
        {steps.map((s, i) => {
          const isOpen = s.id === selected; // only the selected step is open: it is the one the big picture shows
          const follows = !!following && s.id === followId;
          const on = s.enabled !== false;
          const name = s.op === "filter" ? (filters[s.name]?.label ?? s.name) : OPS.crop;
          return (
            <li
              key={s.id}
              data-testid={`step-${s.id}`}
              aria-current={isOpen ? "step" : undefined}
              onDragOver={(e) => { if (from !== null) { e.preventDefault(); setOver(i); } }}
              onDrop={drop(i)}
              style={{
                border: `1px solid ${isOpen ? "var(--accent, #2b6cb0)" : "var(--border)"}`,
                boxShadow: over === i && from !== null && from !== i ? "0 -3px 0 var(--accent, #2b6cb0)" : undefined, // where the dragged step would land
                borderRadius: 4,
                padding: "3px 6px",
                opacity: from === i ? 0.5 : 1,
                background: isOpen ? "var(--selected-bg, rgba(43,108,176,.08))" : undefined,
              }}
            >
              {/* One line: grip, name, expand arrow, on/off. A step that is off stays in its place and is dimmed. */}
              <div className="pe-step-line" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "nowrap", cursor: "pointer" }} title={describeEdit(s, filters, follows)} onClick={() => edits.select(s.id)}>
                <span
                  role="img"
                  aria-label={`Drag step ${i + 1}`}
                  title="Drag to change the order"
                  draggable
                  onDragStart={(e) => { setFrom(i); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", s.id); }}
                  onDragEnd={() => { setFrom(null); setOver(null); }}
                  onClick={(e) => e.stopPropagation()}
                  style={{ cursor: "grab", userSelect: "none", padding: "0 4px" }}
                >
                  ⠿
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: on ? 1 : 0.45, textDecoration: on ? undefined : "line-through" }}>
                  <strong>{i + 1}</strong> {name}
                </span>
                <button
                  type="button"
                  aria-label={isOpen ? `Step ${i + 1} is open` : `Open step ${i + 1}`}
                  aria-expanded={isOpen}
                  onClick={(e) => { e.stopPropagation(); edits.select(s.id); }}
                  style={{ padding: "0 4px" }}
                >
                  {isOpen ? "▾" : "▸"}
                </button>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={`Step ${i + 1} on`}
                  title={follows ? "This step follows the target: disconnect the line from the detector to switch it off" : on ? "On: click to skip this step" : "Off: click to use this step again"}
                  checked={on}
                  disabled={follows}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => edits.setEnabled(s.id, e.target.checked)}
                />
              </div>
              {isOpen && (
                <div style={{ marginTop: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <select aria-label={`Step ${i + 1} operation`} value={s.op} onChange={(e) => edits.setOp(s.id, e.target.value as "crop" | "filter")}>
                      {(Object.keys(OPS) as (keyof typeof OPS)[]).map((op) => <option key={op} value={op} disabled={follows && op !== "crop"}>{OPS[op]}</option>)}
                    </select>
                    <span style={{ marginLeft: "auto", display: "inline-flex", gap: 2 }}>
                      <button type="button" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => edits.moveStep(i, i - 1)}>▲</button>
                      <button type="button" aria-label={`Move step ${i + 1} down`} disabled={i === steps.length - 1} onClick={() => edits.moveStep(i, i + 1)}>▼</button>
                      <button type="button" aria-label={`Remove step ${i + 1}`} disabled={follows} title={follows ? "Disconnect the line from the detector first" : undefined} onClick={() => edits.removeStep(s.id)}>✕</button>
                    </span>
                  </div>
                  {!on && <p className="muted" style={{ margin: "4px 0 0" }}>This step is off: the picture passes it unchanged. You can still change it and switch it on again.</p>}
                  <StepBody step={s} edits={edits} follows={follows} detail={detail} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <label style={{ display: "block", marginTop: 8 }}>
        <select aria-label="Add step" value="" onChange={(e) => { if (e.target.value) edits.addStep(e.target.value as "crop" | "filter"); }}>
          <option value="">Add step…</option>
          {(Object.keys(OPS) as (keyof typeof OPS)[]).map((op) => <option key={op} value={op}>{OPS[op]}</option>)}
        </select>
      </label>
      {following && <p className="muted">While a detector target feeds this box, its first Crop step is the one that follows the target.</p>}
      {detail && detail.crops.length > 0 && <p className="muted">This box reads a picture already edited by {detail.crops.length} step{detail.crops.length === 1 ? "" : "s"} above it.</p>}
    </PanelSection>
  );
}

function StepBody({ step, edits, follows, detail }: { step: FlowEdit; edits: PictureEdits; follows: boolean; detail: FlowCrop | null }) {
  if (step.op === "filter") {
    const spec = edits.filters[step.name];
    return (
      <div style={{ marginTop: 6 }}>
        <label>
          Filter{" "}
          <select aria-label="Filter" value={step.name} onChange={(e) => edits.setFilter(step.id, e.target.value)}>
            {Object.entries(edits.filters).map(([name, s]) => <option key={name} value={name}>{s.label}</option>)}
            {!spec && <option value={step.name}>{step.name}</option>}
          </select>
        </label>
        {spec && <FilterParams spec={spec} params={step.params} onChange={(key, value) => edits.setParam(step.id, key, value)} />}
        <p className="muted">The big picture shows the result as you change it. Applied to the picture as it is at this step, so the order matters.</p>
      </div>
    );
  }
  const f = detail?.follow;
  if (follows && f) {
    return (
      <div style={{ marginTop: 6 }}>
        <p className="muted">
          This step follows target <strong>{f.target}</strong> of {f.detector}. Its rectangle has one size and keeps the same place
          next to the found target on every picture. Draw it once on a picture where the target was found.
        </p>
        <p className="muted">
          {f.detector} offers from {f.target}: {FLOW_OUTPUTS.filter((o) => f.offered.includes(o.id)).map((o) => o.label.toLowerCase()).join(", ") || "nothing"}.
        </p>
        <label>
          Use of the target
          <select value={f.mode} onChange={(e) => void edits.update({ follow_mode: e.target.value })}>
            {f.modes.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.enabled} title={m.enabled ? undefined : `Tick ${m.needs.join(", ")} on ${f.detector} for ${f.target}`}>
                {m.label}{m.enabled ? "" : ` (tick ${m.needs.join(", ")} on the detector)`}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">
          {f.mode === "straighten"
            ? "The picture is turned back by the found angle around the target before the cut, so the part is always upright in the same place (corners that fall outside the picture are grey)."
            : "The picture is not turned: the rectangle only moves with the position."}
          {" "}Changing this clears the rectangle; draw it again.
        </p>
        <p>{f.size ? `${f.size[0]} × ${f.size[1]} px · offset ${f.offset?.[0]}, ${f.offset?.[1]} px from the target` : "No rectangle drawn yet: the picture passes on unchanged."}</p>
        <p className={f.missing.length ? "flow-missing" : "muted"} role="status">
          {f.missing.length ? `${f.missing.length} picture${f.missing.length === 1 ? "" : "s"} where ${f.detector} found no ${f.target}: they get no crop and cannot be used behind it.` : `${f.detector} found ${f.target} on every picture.`}
        </p>
        <button type="button" disabled={!f.size} onClick={() => void edits.update({ follow: null })}>Clear rectangle</button>
      </div>
    );
  }
  const r = step.rect;
  return (
    <div style={{ marginTop: 6 }}>
      <p className="muted">
        One rectangle cuts every picture. It is stored as fractions of the picture, so pictures of another size are cut in the
        same relative place. Draw it on the big picture.
      </p>
      <p>
        {r
          ? `From ${(r[0] * 100).toFixed(1)} %, ${(r[1] * 100).toFixed(1)} % · ${(r[2] * 100).toFixed(1)} % wide, ${(r[3] * 100).toFixed(1)} % tall`
          : "No crop drawn yet: the picture passes on unchanged."}
      </p>
      <button type="button" disabled={!r} onClick={() => edits.setRect(step.id, null)}>Clear crop</button>
    </div>
  );
}
