import { useEffect, useState } from "react";
import { api, Job } from "./api";

/** Poll a background job until it finishes. Pass ``null`` for "no job". */
export function useJob<R>(jobId: string | null, intervalMs = 400): Job<R> | null {
  const [job, setJob] = useState<Job<R> | null>(null);

  useEffect(() => {
    setJob(null);
    if (!jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const j = await api.job<R>(jobId);
        if (cancelled) return;
        setJob(j);
        if (j.status === "queued" || j.status === "running") timer = setTimeout(tick, intervalMs);
      } catch (e) {
        if (cancelled) return;
        setJob({
          id: jobId,
          kind: "",
          camera: "",
          feature: null,
          status: "error",
          progress: {},
          result: null,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    };
    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobId, intervalMs]);

  return job;
}
