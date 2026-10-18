import { useEffect, useState } from "react";

type Row = { key: number; orig: string | null; name: string };

const clean = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");

/** What is wrong with the list, or null. Blank rows are ignored. */
export function problemOf(names: string[]): string | null {
  const given = names.map(clean).filter(Boolean);
  if (given.length < 2) return "Keep at least two products.";
  const seen = new Set<string>();
  for (const n of given) {
    if (/[\\/]/.test(n)) return `Product names cannot contain slashes: ${n}`;
    if (n.includes("::")) return `"::" is reserved, please pick a name without it: ${n}`;
    if (n.startsWith("@")) return `Product names cannot start with @: ${n}`;
    if (seen.has(n.toLowerCase())) return `Two products are called ${n}.`;
    seen.add(n.toLowerCase());
  }
  return null;
}

/**
 * The products of the product-sorting ROI as a list: change a name in place to **rename** the product (its labels, goldens
 * and the ROIs that belong to it follow), add one with the button, remove one with the cross (its labels stay but it is
 * no longer offered). Saving sends the final list in order and, for every renamed product, old name -> new name, so a
 * rename is never mistaken for a removal plus an addition.
 */
export default function ProductNamesEditor({
  products,
  onSave,
}: {
  products: string[];
  onSave: (names: string[], renames: Record<string, string>) => Promise<unknown>;
}) {
  const fresh = (list: string[]): Row[] => list.map((name, i) => ({ key: i, orig: name, name }));
  const [rows, setRows] = useState<Row[]>(() => fresh(products));
  const [next, setNext] = useState(1000);
  const [busy, setBusy] = useState(false);
  // The list is what the camera has; after a save (or a change elsewhere) it starts again from there.
  useEffect(() => setRows(fresh(products)), [products.join("\u0000")]); // eslint-disable-line react-hooks/exhaustive-deps

  const names = rows.map((r) => clean(r.name)).filter(Boolean);
  const renames: Record<string, string> = {};
  for (const r of rows) {
    const n = clean(r.name);
    if (r.orig !== null && n && n !== r.orig) renames[r.orig] = n;
  }
  const problem = problemOf(rows.map((r) => r.name));
  const changed = names.join("\u0000") !== products.join("\u0000");

  return (
    <div data-testid="product-names">
      <ul style={{ listStyle: "none", padding: 0, margin: "6px 0" }}>
        {rows.map((r, i) => {
          const renamed = r.orig !== null && clean(r.name) !== r.orig && clean(r.name) !== "";
          return (
            <li key={r.key} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
              <input
                aria-label={`Product ${i + 1}`}
                value={r.name}
                onChange={(e) => setRows((cur) => cur.map((x) => (x.key === r.key ? { ...x, name: e.target.value } : x)))}
                style={{ flex: 1, minWidth: 0 }}
              />
              {renamed && (
                <small data-testid={`renamed-${r.key}`} style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>
                  was {r.orig}
                </small>
              )}
              <button
                type="button"
                aria-label={`Remove product ${i + 1}`}
                title="Remove it from the list. Its labels and ROIs are not deleted; they are just no longer offered."
                onClick={() => setRows((cur) => cur.filter((x) => x.key !== r.key))}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={() => {
          setRows((cur) => [...cur, { key: next, orig: null, name: "" }]);
          setNext((n) => n + 1);
        }}
      >
        + Add product
      </button>{" "}
      <button
        type="button"
        disabled={busy || !changed || problem !== null}
        onClick={async () => {
          setBusy(true);
          try {
            await onSave(names, renames);
          } finally {
            setBusy(false);
          }
        }}
      >
        Save products
      </button>
      {problem && changed && (
        <p role="alert" style={{ margin: "6px 0 0" }}>
          {problem}
        </p>
      )}
      <p>
        Change a name to <strong>rename</strong> the product: its labels, goldens, versions and the ROIs that belong to it stay connected.
        Adding a product makes it available in the sidebar. Removing one does <strong>not</strong> delete its labels or ROIs; they simply
        stop being offered.
      </p>
    </div>
  );
}
