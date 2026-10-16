import { useState } from "react";
import { DeviceInfo } from "./api";
import { lastSession } from "./lastSession";

/** Drawn here, not downloaded: a generic graphics card and processor, tinted with the vendor's accent colour. */
const ACCENT: Record<DeviceInfo["kind"], string> = { amd: "#e0262d", nvidia: "#76b900", cpu: "#64748b" };
const VARIANTS = ["card", "chip", "banner"] as const;
type Variant = (typeof VARIANTS)[number];

function CardArt({ color, width = 92 }: { color: string; width?: number }) {
  return (
    <svg viewBox="0 0 120 56" width={width} role="img" aria-label="Graphics card" style={{ display: "block" }}>
      <rect x="4" y="6" width="104" height="38" rx="5" fill="#2b2f36" />
      <rect x="4" y="6" width="104" height="5" rx="2.5" fill={color} />
      <circle cx="35" cy="26" r="14" fill="#161a1f" stroke="#4b5360" strokeWidth="1.5" />
      <circle cx="75" cy="26" r="14" fill="#161a1f" stroke="#4b5360" strokeWidth="1.5" />
      {[35, 75].map((cx) => (
        <g key={cx} stroke={color} strokeWidth="2.4" strokeLinecap="round">
          <line x1={cx} y1="26" x2={cx} y2="15" />
          <line x1={cx} y1="26" x2={cx + 9.5} y2="31.5" />
          <line x1={cx} y1="26" x2={cx - 9.5} y2="31.5" />
        </g>
      ))}
      <rect x="108" y="4" width="8" height="42" rx="1.5" fill="#9aa3af" />
      <rect x="14" y="44" width="62" height="6" fill="#c9a24a" />
      {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => (
        <rect key={i} x={16 + i * 5} y="44" width="2.4" height="6" fill="#8a6d1f" />
      ))}
    </svg>
  );
}

function ChipArt({ color, size = 40 }: { color: string; size?: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} role="img" aria-label="Processor" style={{ display: "block" }}>
      {[10, 18, 26, 34].map((p) => (
        <g key={p} stroke="#9aa3af" strokeWidth="2.4" strokeLinecap="round">
          <line x1={p + 2} y1="2" x2={p + 2} y2="9" />
          <line x1={p + 2} y1="39" x2={p + 2} y2="46" />
          <line x1="2" y1={p + 2} x2="9" y2={p + 2} />
          <line x1="39" y1={p + 2} x2="46" y2={p + 2} />
        </g>
      ))}
      <rect x="9" y="9" width="30" height="30" rx="4" fill="#2b2f36" />
      <rect x="15" y="15" width="18" height="18" rx="2" fill="none" stroke={color} strokeWidth="2.4" />
      <rect x="20" y="20" width="8" height="8" rx="1" fill={color} />
    </svg>
  );
}

const Art = ({ info, big }: { info: DeviceInfo; big?: boolean }) =>
  info.kind === "cpu" ? <ChipArt color={ACCENT.cpu} size={big ? 52 : 38} /> : <CardArt color={ACCENT[info.kind]} width={big ? 112 : 84} />;

/** Second line: the card's own name and the compute API, or why only the CPU is used. */
function detail(info: DeviceInfo): string {
  if (info.kind === "cpu") return info.hint || info.name || "no GPU detected";
  return [info.name, info.api].filter(Boolean).join(" · ") || info.label;
}

/**
 * Tells which device the neural parts run on. Three looks to choose from (click the badge to
 * switch; the choice is remembered): a card picture over two lines, a compact chip row, a banner.
 */
export default function HardwareBadge({ info }: { info: DeviceInfo }) {
  const [variant, setVariant] = useState<Variant>(() => {
    const saved = lastSession.hardwareStyle();
    return (VARIANTS as readonly string[]).includes(saved) ? (saved as Variant) : "card";
  });
  const next = () => {
    const v = VARIANTS[(VARIANTS.indexOf(variant) + 1) % VARIANTS.length];
    lastSession.setHardwareStyle(v);
    setVariant(v);
  };
  const color = ACCENT[info.kind];
  const text = (
    <>
      <div style={{ fontWeight: 700, fontSize: 13, color: info.kind === "cpu" ? "inherit" : color }}>{info.kind === "cpu" ? "CPU only" : info.label}</div>
      <div style={{ fontSize: 11, color: "var(--muted)", overflowWrap: "anywhere" }}>{detail(info)}</div>
    </>
  );
  return (
    <button
      type="button"
      className={`hw-badge hw-${variant}`}
      data-testid="hardware-badge"
      data-kind={info.kind}
      data-variant={variant}
      onClick={next}
      title={`${info.label}${info.name ? ` — ${info.name}` : ""}${info.hint ? ` (${info.hint})` : ""}. Click to change the look (${VARIANTS.indexOf(variant) + 1}/${VARIANTS.length}).`}
      style={{ ["--hw" as string]: color }}
    >
      {variant === "card" && (
        <>
          <Art info={info} big />
          <div>{text}</div>
        </>
      )}
      {variant === "chip" && (
        <>
          <Art info={info} />
          <div style={{ textAlign: "left", minWidth: 0 }}>{text}</div>
        </>
      )}
      {variant === "banner" && (
        <>
          <div style={{ textAlign: "left", minWidth: 0, flex: 1 }}>{text}</div>
          <Art info={info} />
        </>
      )}
    </button>
  );
}
