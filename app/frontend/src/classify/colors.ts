const FIXED: Record<string, string> = { OK: "#1a7f37", NG: "#c62828" };
const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#c98500", "#d55181", "#4a3aa7", "#008300", "#e34948"];

/** OK/NG keep fixed colours; other classes take a palette colour by their position. */
export function classColor(cls: string, classes: string[] = []): string {
  if (FIXED[cls]) return FIXED[cls];
  const i = classes.indexOf(cls);
  return i >= 0 ? PALETTE[i % PALETTE.length] : "#6b7280";
}

export function clusterColor(id: number): string {
  return id < 0 ? "#6b7280" : PALETTE[id % PALETTE.length];
}
