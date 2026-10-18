import { createContext } from "react";

/**
 * The scoring method the Classify grid ranks by, chosen in the top bar next to the camera and the product. "" = not chosen:
 * the server's default (ResNet 50 when it is on). A page rendered on its own gets that default.
 */
export const RankContext = createContext<{ rank: string }>({ rank: "" });

/** The server's rule for the method to rank by when none is chosen: ResNet 50 if it is in use, else the first. */
export const defaultRank = (active: string[]): string => (active.includes("resnet50") ? "resnet50" : (active[0] ?? ""));
