/** How a version number is written everywhere: V01, V02 ... V99, V100 (v1.161.0). Mirrors `backend/vlabel.py`. Nothing for no number. */
export const versionLabel = (n: number | null | undefined): string => (n === null || n === undefined ? "" : `V${String(n).padStart(2, "0")}`);

/** True when `name` is only the default name of version `n`: the old `v1` / `v001` kind or the new `V01`. */
export const isDefaultVersionName = (name: string, n: number): boolean => {
  const m = /^v0*(\d+)$/i.exec(name.trim());
  return m !== null && Number(m[1]) === n;
};
