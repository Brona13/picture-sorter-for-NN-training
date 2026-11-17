/**
 * The small aim-target button that takes a picture's measurement as the nominal, shared by the value cards, the
 * Classify-style cards of a value grid and the picture viewer. Its accessible name stays "Use as nominal".
 */
export default function NominalButton({ onClick, disabled, title = "Use as nominal" }: { onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button type="button" className="nominal-button" aria-label="Use as nominal" title={title} disabled={disabled} onClick={onClick}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="8" cy="8" r="5" />
        <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
        <path d="M8 1v3M8 12v3M1 8h3M12 8h3" />
      </svg>
    </button>
  );
}

/**
 * The verdict as a word, only where nothing else shows it: a pass or fail card already has a green or red edge and the
 * viewer colours its drawing, so only "undetermined" (plain edge, grey drawing) is written out.
 */
export function VerdictWord({ verdict }: { verdict?: string }) {
  return verdict === "undetermined" ? <span className="flow-verdict undetermined">undetermined</span> : null;
}
