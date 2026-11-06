/**
 * A per-viewer cache of pictures the server renders on request (a Picture edits cut-out with its filters, a detector
 * cut-out). The bytes are fetched once into a blob, so showing a preloaded picture costs nothing: the browser's own cache
 * cannot be relied on, because those pictures are sent with `no-cache` and no validator. The owner makes one cache per
 * viewer and calls `dispose` when it goes away, so a later change of the filters is never answered from here.
 */
export const DEFAULT_MAX_ENTRIES = 160;
/** How many pictures are fetched ahead at the same time: the server renders each one (crop and filters) on request. */
const PREFETCH_PARALLEL = 3;
/** Only the nearest pictures are decoded ahead; decoding a whole page at once would only hold memory. */
const DECODE_AHEAD = 4;

export interface PictureCache {
  /** The picture at `url` as an object URL, fetched at most once while it stays in the cache. */
  load: (url: string) => Promise<string>;
  /**
   * Fetch these pictures ahead, nearest first (the list is in the order they are wanted). A new list replaces the old one:
   * pictures not started yet are dropped from the queue, ones already on their way finish and stay cached. Never rejects.
   */
  prefetch: (urls: string[]) => void;
  /** Stop fetching and free every object URL (when the viewer goes away). */
  dispose: () => void;
}

export function makePictureCache(onScreen: () => string | undefined = () => undefined, maxEntries = DEFAULT_MAX_ENTRIES): PictureCache {
  const entries = new Map<string, Promise<string>>();
  const failed = new Set<string>(); // a 404 (no box on that picture) is not asked for again
  let queue: string[] = [];
  let running = 0;
  let closed = false;

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
    failed.delete(url); // an explicit ask is always tried
    const made = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.blob();
      })
      .then((b) => URL.createObjectURL(b));
    made.catch(() => {
      entries.delete(url);
      failed.add(url);
    });
    entries.set(url, made);
    while (entries.size > maxEntries) evict(entries.keys().next().value as string);
    return made;
  };
  const pump = () => {
    while (!closed && running < PREFETCH_PARALLEL && queue.length) {
      const url = queue.shift() as string;
      if (entries.has(url) || failed.has(url)) continue;
      running++;
      load(url)
        .catch(() => undefined)
        .then(() => {
          running--;
          pump();
        });
    }
  };
  const prefetch = (urls: string[]) => {
    if (closed) return;
    queue = urls.filter((u) => !failed.has(u));
    // The entries just wanted are the freshest, so the limit frees the pictures that are no longer near.
    for (const u of urls) {
      const hit = entries.get(u);
      if (hit) {
        entries.delete(u);
        entries.set(u, hit);
      }
    }
    urls.slice(0, DECODE_AHEAD).forEach((u) =>
      entries.get(u)?.then((src) => {
        const im = new Image();
        im.src = src;
        return im.decode?.();
      }).catch(() => undefined),
    );
    pump();
  };
  const dispose = () => {
    closed = true;
    queue = [];
    for (const url of [...entries.keys()]) evict(url);
  };
  return { load, prefetch, dispose };
}
