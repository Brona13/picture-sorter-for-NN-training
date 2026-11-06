/**
 * A small per-viewer cache of pictures the server renders on request (a Picture edits cut-out with its filters, a detector
 * cut-out). The bytes are fetched once into a blob, so showing a picture that was preloaded costs nothing: the browser's own
 * cache cannot be relied on, because those pictures are sent with `no-cache` and no validator. The owner makes one cache
 * per viewer and calls `dispose` when it goes away, so a later change of the filters is never answered from here.
 */
const MAX_ENTRIES = 12;

export interface PictureCache {
  /** The picture at `url` as an object URL, fetched at most once while it stays in the cache. */
  load: (url: string) => Promise<string>;
  /** Fetch and decode `url` ahead of time; never rejects (a picture that cannot be had is simply shown the usual way later). */
  warm: (url: string) => void;
  /** Free every object URL (when the viewer goes away). */
  dispose: () => void;
}

export function makePictureCache(onScreen: () => string | undefined = () => undefined): PictureCache {
  const entries = new Map<string, Promise<string>>();
  const evict = (url: string) => {
    const hit = entries.get(url);
    entries.delete(url);
    hit?.then((src) => src !== onScreen() && URL.revokeObjectURL(src), () => undefined);
  };
  const load = (url: string) => {
    const hit = entries.get(url);
    if (hit) {
      entries.delete(url); // most recently used goes last
      entries.set(url, hit);
      return hit;
    }
    const made = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.blob();
      })
      .then((b) => URL.createObjectURL(b));
    made.catch(() => entries.delete(url));
    entries.set(url, made);
    while (entries.size > MAX_ENTRIES) evict(entries.keys().next().value as string);
    return made;
  };
  const warm = (url: string) => {
    load(url)
      .then((src) => {
        const im = new Image();
        im.src = src;
        return im.decode?.();
      })
      .catch(() => undefined);
  };
  const dispose = () => {
    for (const url of [...entries.keys()]) evict(url);
  };
  return { load, warm, dispose };
}
