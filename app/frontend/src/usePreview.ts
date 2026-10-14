import { useEffect, useState } from "react";
import { api, DetectorChoice, FilterChoice, MaskChoice } from "./api";

const PREVIEW_DEBOUNCE_MS = 250;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Debounced server-rendered crop of one frame with the proposed (unsaved) settings applied. */
export function usePreview(
  camera: string,
  feature: string,
  frame: string,
  filter: FilterChoice | null,
  mask: MaskChoice | null,
  onError: (message: string | null) => void,
  detector: DetectorChoice | null = null,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const maskKey = JSON.stringify(mask);
  const detectorKey = JSON.stringify(detector);
  useEffect(() => {
    if (!camera || !feature || !frame) return;
    let cancelled = false;
    let created: string | null = null;
    const timer = setTimeout(() => {
      api
        .visionPreview(camera, feature, frame, filter, mask, detector)
        .then((blob) => {
          if (cancelled) return;
          created = URL.createObjectURL(blob);
          setUrl(created);
          onError(null);
        })
        .catch((e: unknown) => !cancelled && onError(msg(e)));
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (created) URL.revokeObjectURL(created);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, feature, frame, filter, maskKey, detectorKey]);
  return url;
}
