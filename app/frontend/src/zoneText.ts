/**
 * The words for a picture judged by a zone (an Evaluation behind an Offset), shared by the Classifier-style card, the
 * plain value card and the picture viewer: the offset of B (from the nominal once it is set) and its distance from the nominal.
 */
export const zoneOffsetText = (p: [number, number] | null | undefined): string =>
  p ? `dx ${p[0].toFixed(1)}, dy ${p[1].toFixed(1)} px` : "not measured";

export const zoneDistanceText = (d: number): string => `distance ${d.toFixed(1)} px`;
