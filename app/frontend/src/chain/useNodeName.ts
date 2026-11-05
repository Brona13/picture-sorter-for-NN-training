import { useEffect, useState } from "react";
import { api } from "../api";

/**
 * The name the user gave a Classifier / ROI box on the Chain (its label), for page titles. Until the Chain has answered, or when
 * the box has no node (a page opened without the Chain), `fallback` is shown: the system name.
 */
export function useNodeName(camera: string, feature: string | undefined, fallback: string): string {
  const [name, setName] = useState<{ key: string; label: string } | null>(null);
  const key = `${camera}|${feature ?? ""}`;
  useEffect(() => {
    if (!camera || !feature) return;
    let current = true;
    api.chain(camera)
      .then((c) => {
        const node = c.nodes.find((n) => n.ref === feature);
        if (current && node?.label) setName({ key, label: node.label });
      })
      .catch(() => { /* cosmetic: the system name stays */ });
    return () => { current = false; };
  }, [camera, feature]); // eslint-disable-line react-hooks/exhaustive-deps
  return name && name.key === key ? name.label : fallback;
}
