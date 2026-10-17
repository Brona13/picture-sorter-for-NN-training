/**
 * A tool's icon, drawn in two tones: the main shapes use `--ti-a`, the accents `--ti-b`. Muted grey while the tool has
 * not been used on the camera, in the tool's own colour once it has (the CSS is in `styles.css`). Decorative: the
 * tool's name is always next to it as text.
 */
export type IconId =
  | "overview" | "status" | "ingest" | "scatter" | "clusters" | "outliers" | "roi" | "detector"
  | "edge-angle" | "classify" | "insights" | "verdict" | "augmentation" | "versions";

/** Hue of the colourful state, so every tool is recognisable by colour too. */
const HUE: Record<IconId, number> = {
  overview: 215, status: 200, ingest: 160, scatter: 265, clusters: 285, outliers: 330, roi: 30,
  detector: 355, "edge-angle": 45, classify: 145, insights: 190, verdict: 120, augmentation: 12, versions: 235,
};

const A = "var(--ti-a)";
const B = "var(--ti-b)";
const stroke = { fill: "none", stroke: A, strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function Shapes({ id }: { id: IconId }) {
  switch (id) {
    case "overview":
      return (<><path d="M3 11l9-7 9 7" {...stroke} /><path d="M6 10v9h12v-9" {...stroke} /><rect x="10" y="13" width="4" height="6" fill={B} /></>);
    case "status":
      return (<><rect x="4" y="12" width="3.5" height="7" fill={A} /><rect x="10.2" y="7" width="3.5" height="12" fill={B} /><rect x="16.5" y="4" width="3.5" height="15" fill={A} /></>);
    case "ingest":
      return (<><path d="M4 15v4h16v-4" {...stroke} /><path d="M12 4v10M8 10l4 4 4-4" {...stroke} /><circle cx="12" cy="4.5" r="1.6" fill={B} /></>);
    case "scatter":
      return (<><circle cx="6" cy="16" r="2.2" fill={A} /><circle cx="11" cy="9" r="2.2" fill={B} /><circle cx="17" cy="14" r="2.2" fill={A} /><circle cx="18" cy="6" r="1.6" fill={B} /><circle cx="8" cy="5" r="1.4" fill={A} /></>);
    case "clusters":
      return (<><circle cx="8" cy="9" r="5" fill={B} opacity="0.55" /><circle cx="16" cy="15" r="5" fill={B} opacity="0.55" /><circle cx="7" cy="8" r="1.5" fill={A} /><circle cx="10" cy="10" r="1.5" fill={A} /><circle cx="15" cy="14" r="1.5" fill={A} /><circle cx="17.5" cy="16.5" r="1.5" fill={A} /></>);
    case "outliers":
      return (<><circle cx="9" cy="13" r="1.6" fill={A} /><circle cx="12" cy="11" r="1.6" fill={A} /><circle cx="10.5" cy="15.5" r="1.6" fill={A} /><circle cx="7.5" cy="10" r="1.6" fill={A} /><circle cx="19" cy="5" r="2.3" fill={B} /><path d="M17 7l-3 3" {...stroke} strokeDasharray="1.5 2.5" /></>);
    case "roi":
      return (<><rect x="5" y="6" width="14" height="12" {...stroke} strokeDasharray="3 2.4" /><rect x="3.5" y="4.5" width="3" height="3" fill={B} /><rect x="17.5" y="16.5" width="3" height="3" fill={B} /></>);
    case "detector":
      return (<><circle cx="12" cy="12" r="7" {...stroke} /><path d="M12 2v5M12 17v5M2 12h5M17 12h5" {...stroke} /><circle cx="12" cy="12" r="2.2" fill={B} /></>);
    case "edge-angle":
      return (<><path d="M4 19h16" {...stroke} /><path d="M4 19L17 6" {...stroke} /><path d="M11 19a7 7 0 0 0-2-4.9" fill="none" stroke={B} strokeWidth="1.8" strokeLinecap="round" /></>);
    case "classify":
      return (<><path d="M4 12V5h7l9 9-7 7z" {...stroke} /><circle cx="8.3" cy="8.3" r="1.6" fill={B} /></>);
    case "insights":
      return (<><rect x="4" y="4" width="7" height="7" fill={A} /><rect x="13" y="4" width="7" height="7" fill={B} /><rect x="4" y="13" width="7" height="7" fill={B} /><rect x="13" y="13" width="7" height="7" fill={A} /></>);
    case "verdict":
      return (<><circle cx="12" cy="12" r="8.5" {...stroke} /><path d="M8 12.5l3 3 5-6" fill="none" stroke={B} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></>);
    case "augmentation":
      return (<><rect x="4" y="7" width="11" height="11" {...stroke} /><rect x="9" y="4" width="11" height="11" fill={B} opacity="0.6" transform="rotate(12 14.5 9.5)" /></>);
    case "versions":
      return (<><path d="M12 4l9 4.5-9 4.5-9-4.5z" fill={B} stroke={A} strokeWidth="1.5" strokeLinejoin="round" /><path d="M3 12.5l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5" {...stroke} /></>);
  }
}

/** `used` false = muted; true or undefined (a page that has no state to show) = colourful. */
export default function ToolIcon({ id, used }: { id: IconId; used?: boolean }) {
  const on = used !== false;
  return (
    <span className={`tool-icon ${on ? "used" : "unused"}`} style={{ ["--hue" as string]: HUE[id] }} aria-hidden="true" data-testid={`tool-icon-${id}`} data-used={on ? "true" : "false"}>
      <svg viewBox="0 0 24 24" width="18" height="18" focusable="false">
        <Shapes id={id} />
      </svg>
    </span>
  );
}
