/**
 * A detector reports a position as the index of the pixel at the centre of the found box (the centre of a 36-pixel box
 * that starts at pixel 52 is 69.5). Pictures are drawn with pixel i covering [i, i + 1], so the same centre is at 70
 * when drawn: half a pixel further right and down. Everything that draws or places a found position goes through here.
 */
export const PIXEL_CENTRE = 0.5;
export const drawn = <T extends { x: number; y: number }>(p: T): T => ({ ...p, x: p.x + PIXEL_CENTRE, y: p.y + PIXEL_CENTRE });
/** The stored position of a point the user clicked at in drawing coordinates. */
export const stored = (v: number): number => v - PIXEL_CENTRE;
