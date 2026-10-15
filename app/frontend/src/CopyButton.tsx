import { useEffect, useRef, useState } from "react";

/** Copy ``text`` with the async clipboard API, falling back to a hidden textarea. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** Button that copies ``text`` to the clipboard and confirms (or reports a failure) for a moment. */
export default function CopyButton({ text, label = "Copy to clipboard" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onClick = async () => {
    setState((await copyText(text)) ? "done" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2500);
  };

  return (
    <>
      <button type="button" onClick={onClick} title={text}>
        {state === "done" ? "✓ Copied" : label}
      </button>
      {state === "failed" && <span role="alert"> Copy failed — select the path and copy it manually.</span>}
    </>
  );
}
