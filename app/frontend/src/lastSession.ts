/** What the user was working on, kept in this browser so a refresh or a server restart picks up where they left off. */
const get = (key: string): string => {
  try {
    return localStorage.getItem(`picturesorter.${key}`) ?? "";
  } catch {
    return ""; // storage unavailable: nothing is remembered
  }
};

const set = (key: string, value: string) => {
  try {
    if (value) localStorage.setItem(`picturesorter.${key}`, value);
    else localStorage.removeItem(`picturesorter.${key}`);
  } catch {
    /* storage unavailable */
  }
};

export const lastSession = {
  camera: () => get("camera"),
  setCamera: (v: string) => set("camera", v),
  /** Product and ROI are remembered per camera. */
  product: (camera: string) => get(`product.${camera}`),
  setProduct: (camera: string, v: string) => set(`product.${camera}`, v),
  feature: (camera: string) => get(`feature.${camera}`),
  setFeature: (camera: string, v: string) => set(`feature.${camera}`, v),
  page: () => get("page"),
  setPage: (v: string) => set("page", v),
  /** The right-hand options panel is open unless the user collapsed it (shared by every page that has one). */
  hardwareStyle: () => get("hardware.style"),
  setHardwareStyle: (v: string) => set("hardware.style", v),
  panelCollapsed: () => get("panel.collapsed") === "1",
  setPanelCollapsed: (v: boolean) => set("panel.collapsed", v ? "1" : ""),
};
