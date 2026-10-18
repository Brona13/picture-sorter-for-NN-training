import { MethodInfo } from "./api";
import { defaultRank } from "./RankContext";

/** The "Rank using" picker of the top bar: which scoring method orders and colours the Classify grid. Only with a choice to make. */
export default function RankSelect({ methods, value, onChange }: { methods: MethodInfo[]; value: string; onChange: (rank: string) => void }) {
  const active = methods.filter((m) => m.active && m.installed);
  if (active.length < 2) return null;
  const ids = active.map((m) => m.id);
  const shown = ids.includes(value) ? value : defaultRank(ids);
  return (
    <label>
      Rank using
      <select value={shown} onChange={(e) => onChange(e.target.value)}>
        {active.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  );
}
