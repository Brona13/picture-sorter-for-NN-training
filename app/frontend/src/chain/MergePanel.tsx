import { api, ChainNode } from "../api";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The settings of a Merge box in the Chain panel: what it collects (set by its first line, shown read-only) and how it
 * combines its lines. Any = a picture passes if any line passes it (lanes of different products); all = only if every
 * line does (the holes of one lane must all be OK).
 */
export default function MergePanel({ camera, node, onChanged, onError }: { camera: string; node: ChainNode; onChanged: () => void; onError: (message: string) => void }) {
  const mode = node.flow?.merge_mode ?? "any";
  const meaning = node.flow?.meaning ?? null;
  const set = (value: "any" | "all") =>
    api
      .flowUpdate(camera, node.id, { mode: value })
      .then(() => onChanged())
      .catch((e: unknown) => onError(msg(e)));
  return (
    <div className="chain-merge-panel">
      <p className="muted" data-testid="merge-meaning">
        {meaning ? `Collects ${meaning}. Lines of another meaning are refused.` : "Collects nothing yet: the first line you drop on it decides whether it collects OK, NG or another class."}
      </p>
      <label className="chain-evaluation">
        A picture passes when
        <select aria-label="Merge mode" value={mode} onChange={(e) => void set(e.target.value as "any" | "all")}>
          <option value="any">any line passes it (union)</option>
          <option value="all">every line passes it (intersection)</option>
        </select>
      </label>
      <p className="muted">
        {node.flow?.inputs ?? 0} line(s) · {node.flow?.frames ?? 0} picture(s)
      </p>
    </div>
  );
}
