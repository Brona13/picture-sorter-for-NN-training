import { ReactNode, useId } from "react";

/**
 * An "i in a circle" icon. Hovering it (or focusing it with the keyboard) shows the explanation, so the
 * page itself stays free of descriptive text. Put it in a summary and clicking it does not fold the group.
 */
export default function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <span className="info-tip">
      <button
        type="button"
        className="info-tip-icon"
        aria-label={`Info: ${label}`}
        aria-describedby={id}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        i
      </button>
      <span role="tooltip" id={id} className="info-tip-pop">
        {children}
      </span>
    </span>
  );
}
