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

/** Outlier score in [0, 1] -> pale yellow (typical) through orange to dark red (most isolated). */
export function scoreColor(t: number): string {
  const x = Math.min(1, Math.max(0, t));
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * x);
  return `rgb(${lerp(250, 150)}, ${lerp(220, 20)}, ${lerp(120, 30)})`;
}
