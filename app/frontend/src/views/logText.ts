import type { LogRecord, TimingRow } from "../api";

/** One record as compact text, the form that is pasted into a Claude session. */
export function recordText(r: LogRecord): string {
  const when = new Date(r.ts * 1000).toISOString().replace("T", " ").slice(0, 19);
  const tags = [r.camera && `cam=${r.camera}`, r.request_id && `req=${r.request_id}`, r.job_id && `job=${r.job_id}`, r.duration_ms != null && `${r.duration_ms}ms`].filter(Boolean).join(" ");
  const lines = [`[${when}] ${r.level} ${r.source}/${r.logger}${tags ? " " + tags : ""}`, r.message];
  if (r.extra) lines.push(r.extra);
  if (r.exc) lines.push(r.exc);
  return lines.join("\n");
}

/** Records in time order (the list arrives newest first), one blank line between them, with a version header. */
export function logsText(records: LogRecord[], header = ""): string {
  const body = [...records].reverse().map(recordText).join("\n\n");
  return header ? `${header}\n\n${body}` : body;
}

/** The "where the time went" table as plain text for a chat (slowest total first, as it arrives). */
export function timingText(rows: TimingRow[], header = ""): string {
  const name = Math.max(4, ...rows.map((r) => r.name.length));
  const line = (a: string, b: string[]) => `${a.padEnd(name)}  ${b.map((x) => x.padStart(9)).join(" ")}`;
  const body = [
    line("what", ["times", "total ms", "avg ms", "95% ms", "max ms"]),
    ...rows.map((r) => line(`${r.kind === "step" ? "· " : ""}${r.name}`.padEnd(name), [r.count, r.total_ms, r.avg_ms, r.p95_ms, r.max_ms].map(String))),
  ].join("\n");
  return `${header ? header + "\n\n" : ""}Where the time went (since app restart)\n${body}`;
}
