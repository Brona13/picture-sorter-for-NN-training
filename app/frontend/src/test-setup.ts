import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";

// Remembered camera/page/ROI must not leak from one test into the next.
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* no storage in this environment */
  }
});
