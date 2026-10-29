import { useEffect, useState } from "react";
import { api, StartupState } from "./api";

/**
 * A thin bar under the top bar while the backend is still loading after a start (PyTorch, the device). It polls once a
 * second and disappears when the backend says it is ready. Anything unexpected (an older backend, no answer) shows nothing.
 */
export default function StartupBanner() {
  const [state, setState] = useState<StartupState | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () =>
      api
        .startup()
        .then((s) => {
          if (cancelled) return;
          setState(s);
          if (s.ready !== true) timer = setTimeout(poll, 1000);
        })
        .catch(() => undefined); // no answer: show nothing, do not keep asking
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  if (!state || state.ready !== false || !Array.isArray(state.steps)) return null;
  const index = state.steps.findIndex((s) => s.status === "running");
  const current = index >= 0 ? state.steps[index] : null;
  return (
    <div className="startup-banner" role="status" aria-live="polite">
      Starting up{current ? ` (${index + 1} of ${state.steps.length}): ${current.label.replace(/ \(.*\)$/, "")}…` : "…"} You can already look around; neural scoring waits for this.
    </div>
  );
}
