import { useEffect } from "react";

/** How long an information bar stays before it goes away on its own. Error bars never do: they stay until ✕ is pressed. */
export const INFO_BAR_MS = 1800;

/**
 * The one information / error bar of the app. Give it the page's message and a way to clear it: an information bar clears
 * itself after `INFO_BAR_MS`, an error bar stays until the ✕ at its right end is pressed. Renders nothing without a message.
 */
export default function MessageBar({ kind, text, onClose }: { kind: "info" | "error"; text: string | null | undefined; onClose: () => void }) {
  useEffect(() => {
    if (!text || kind !== "info") return;
    const t = window.setTimeout(onClose, INFO_BAR_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, kind]);
  if (!text) return null;
  return (
    <p
      role={kind === "error" ? "alert" : "status"}
      data-testid={kind === "error" ? "error-bar" : "info-bar"}
      style={{ display: "flex", alignItems: "flex-start", gap: 8 }}
    >
      <span style={{ flex: 1 }}>{text}</span>
      <button
        type="button"
        aria-label="Dismiss message"
        title="Dismiss"
        onClick={onClose}
        style={{ flex: "none", background: "transparent", border: "none", color: "inherit", padding: "0 4px", cursor: "pointer", fontSize: 14, lineHeight: 1 }}
      >
        ✕
      </button>
    </p>
  );
}
