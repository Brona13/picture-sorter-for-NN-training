import { FilterParamSpec, FilterSpec, isChoiceParam } from "../api";
import WheelRange from "../WheelRange";

/** The text a parameter's current value shows as: a number with its unit, or the label of the chosen option. */
export function paramText(p: FilterParamSpec | undefined, value: number | string | undefined): string {
  if (value === undefined && p) value = p.default;
  if (p && isChoiceParam(p)) return p.options[String(value)] ?? String(value);
  return `${value}${p?.unit ? ` ${p.unit}` : ""}`;
}

/**
 * The parameters of a catalogue filter: a slider (with the wheel) for a number, a toggle button for a choice of two
 * (flips between them), a drop-down for more. Shared by the Detector page's filter tab and the Picture edits steps.
 * `onChange(key, value)` gets a number for a slider and the option's value for a choice.
 */
export default function FilterParams({ spec, params, onChange }: {
  spec: FilterSpec;
  params: Record<string, number | string>;
  onChange: (key: string, value: number | string) => void;
}) {
  return (
    <>
      {Object.entries(spec.params).map(([key, p]) => {
        const name = p.label ?? key;
        const value = params[key] ?? p.default;
        if (isChoiceParam(p)) {
          const values = Object.keys(p.options);
          if (values.length === 2) {
            const other = values.find((v) => v !== value) ?? values[0];
            return (
              <div key={key}>
                <button
                  type="button"
                  aria-label={name}
                  title={`${name}: ${p.options[String(value)]}. Click for ${p.options[other]}.`}
                  onClick={() => onChange(key, other)}
                >
                  {p.options[String(value)] ?? String(value)}
                </button>
              </div>
            );
          }
          return (
            <div key={key}>
              <label>
                {name}{" "}
                <select aria-label={name} value={String(value)} onChange={(e) => onChange(key, e.target.value)}>
                  {values.map((v) => <option key={v} value={v}>{p.options[v]}</option>)}
                </select>
              </label>
            </div>
          );
        }
        return (
          <div key={key}>
            <label>
              {name}{" "}
              <WheelRange aria-label={name} min={p.min} max={p.max} step={p.step} value={Number(value)} onValue={(v) => onChange(key, v)} />{" "}
              <output>{paramText(p, value)}</output>
            </label>
          </div>
        );
      })}
    </>
  );
}
