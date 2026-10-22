import { useEffect, useRef } from "react";
import type { LineNote } from "./lineEffects";

/**
 * The overlay shown before a line is deleted or replaced. Enter confirms, Esc cancels. The keys are taken in the
 * capture phase so the canvas under the overlay (Delete, Backspace) never acts as well.
 */
export default function LineConfirm({
  notes,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  notes: LineNote[];
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirm = useRef(onConfirm);
  const cancel = useRef(onCancel);
  confirm.current = onConfirm;
  cancel.current = onCancel;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== "Escape" && e.key !== "Delete" && e.key !== "Backspace") return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (e.key === "Enter") confirm.current();
      else if (e.key === "Escape") cancel.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="line-confirm-backdrop" onClick={onCancel}>
      <div className="line-confirm" role="alertdialog" aria-modal="true" aria-label="Confirm line change" onClick={(e) => e.stopPropagation()}>
        {notes.map((n, i) => (
          <div key={i} className="line-confirm-note">
            <p><strong>{n.title}</strong></p>
            <ul>
              {n.lines.map((l, j) => (
                <li key={j}>{l}</li>
              ))}
            </ul>
          </div>
        ))}
        <div className="line-confirm-buttons">
          <button type="button" className="danger" onClick={onConfirm} autoFocus>
            {confirmLabel} <span className="muted">Enter</span>
          </button>
          <button type="button" onClick={onCancel}>
            Cancel <span className="muted">Esc</span>
          </button>
        </div>
      </div>
    </div>
  );
}
