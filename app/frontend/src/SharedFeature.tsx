import { createContext, useContext, useEffect, useRef } from "react";

/** The ROI (feature) being worked on, shared by the pages and the step bar. The default value does nothing,
 * so a page rendered on its own (in a test, say) keeps managing its own selection. */
export interface SharedFeature {
  feature: string;
  setFeature: (feature: string) => void;
}

export const FeatureContext = createContext<SharedFeature>({ feature: "", setFeature: () => undefined });

/**
 * For a page with its own ROI selector: ``pick`` chooses the shared ROI when this page offers it (else the
 * first one), and ``publish`` tells everyone else which ROI the page ended up on.
 */
export function useSharedFeature() {
  const shared = useContext(FeatureContext);
  const latest = useRef(shared);
  latest.current = shared;
  return {
    pick: (list: { feature: string }[]): string => {
      const wanted = latest.current.feature;
      return list.some((f) => f.feature === wanted) ? wanted : (list[0]?.feature ?? "");
    },
    publish: (feature: string) => {
      if (feature && feature !== latest.current.feature) latest.current.setFeature(feature);
    },
  };
}

/** Publish the page's selected ROI whenever it changes. */
export function usePublishFeature(feature: string, publish: (feature: string) => void) {
  useEffect(() => {
    if (feature) publish(feature);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feature]);
}
