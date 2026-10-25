/** Reports what the browser sees to the backend log (`POST /api/logs`): errors, failed calls, crashes.
 * Each report carries the last few user actions ("breadcrumbs") and the request id of the failed call. */

export type ClientLevel = "error" | "warn";

interface Report {
  level: ClientLevel;
  message: string;
  request_id?: string | null;
  camera?: string | null;
  url?: string;
  stack?: string;
  breadcrumbs?: string[];
  extra?: Record<string, unknown>;
}

const MAX_CRUMBS = 20;
const FLUSH_MS = 2000;
const WINDOW_MS = 10_000;
const MAX_PER_WINDOW = 10;
const MAX_QUEUE = 50;

const crumbs: string[] = [];
let queue: Report[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let sent: number[] = [];
let camera: string | null = null;
let last = "";

/** Tell the logger which camera the user is on; reports carry it. */
export const setLogCamera = (name: string | null): void => {
  camera = name;
};

/** Remember an action; the newest 20 travel with the next report. */
export function breadcrumb(text: string): void {
  crumbs.push(`${new Date().toISOString().slice(11, 19)} ${text}`.slice(0, 200));
  if (crumbs.length > MAX_CRUMBS) crumbs.shift();
}

export const breadcrumbs = (): string[] => [...crumbs];

async function flush(): Promise<void> {
  timer = null;
  const records = queue;
  queue = [];
  if (!records.length) return;
  try {
    await fetch("/api/logs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ records }), keepalive: true });
  } catch {
    /* the log must never raise; a backend that is down cannot be told */
  }
}

/** Queue a report. Identical consecutive reports are dropped and at most 10 leave per 10 s. */
export function report(level: ClientLevel, message: string, more: Partial<Report> = {}): void {
  const key = `${level}|${message}|${more.request_id ?? ""}`;
  if (key === last) return;
  last = key;
  const now = Date.now();
  sent = sent.filter((t) => now - t < WINDOW_MS);
  if (sent.length >= MAX_PER_WINDOW || queue.length >= MAX_QUEUE) return;
  sent.push(now);
  queue.push({ level, message: message.slice(0, 2000), camera, url: location.pathname + location.search, breadcrumbs: breadcrumbs(), ...more });
  if (!timer) timer = setTimeout(() => void flush(), FLUSH_MS);
}

/** Send at once (the page is closing or has crashed). */
export const flushNow = (): Promise<void> => {
  if (timer) clearTimeout(timer);
  return flush();
};

const describe = (target: EventTarget | null): string => {
  const el = target instanceof Element ? target.closest("button, a, [role=button], input, select, summary, [data-testid]") : null;
  if (!el) return "";
  const text = (el.getAttribute("aria-label") || el.getAttribute("title") || (el as HTMLElement).innerText || el.getAttribute("data-testid") || el.tagName).trim().replace(/\s+/g, " ");
  return `${el.tagName.toLowerCase()} "${text.slice(0, 40)}"`;
};

let installed = false;

/** Window-level handlers: uncaught errors, unhandled promise rejections, clicks and page changes as breadcrumbs. */
export function installClientLog(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (e) => report("error", e.message || "Uncaught error", { stack: e.error?.stack, extra: { source: `${e.filename}:${e.lineno}` } }));
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    report("error", `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`, { stack: reason instanceof Error ? reason.stack : undefined });
  });
  document.addEventListener("click", (e) => {
    const what = describe(e.target);
    if (what) breadcrumb(`click ${what}`);
  }, true);
  window.addEventListener("popstate", () => breadcrumb(`page ${location.pathname}`));
  window.addEventListener("pagehide", () => void flushNow());
}

/** For tests. */
export function resetClientLog(): void {
  crumbs.length = 0;
  queue = [];
  sent = [];
  last = "";
  camera = null;
  if (timer) clearTimeout(timer);
  timer = null;
}
