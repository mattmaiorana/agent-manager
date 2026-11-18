
export const RUN_LOG_COLUMNS = ["Started", "Occurrence", "Outcome", "Took", "Result", "Session", "Backend", "Machine", "Note"] as const;
export type RunColumn = typeof RUN_LOG_COLUMNS[number];
export type RunRow = Record<RunColumn, string>;
export const RUN_FINE_OUTCOMES = ["succeeded", "nothing new", "running", "stopped", "skipped"];
export const RUN_DONE_OUTCOMES = ["succeeded", "nothing new"];

export function runPad(n: number): string { return String(n).padStart(2, "0"); }
export function runStamp(d: Date, withSeconds = false): string {
  return `${d.getFullYear()}-${runPad(d.getMonth() + 1)}-${runPad(d.getDate())} ${runPad(d.getHours())}${runPad(d.getMinutes())}${withSeconds ? runPad(d.getSeconds()) : ""}`;
}
export function runStarted(d: Date): string {
  return `${d.getFullYear()}-${runPad(d.getMonth() + 1)}-${runPad(d.getDate())} ${runPad(d.getHours())}:${runPad(d.getMinutes())}:${runPad(d.getSeconds())}`;
}
export function runParseStarted(s: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(s || "").trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
  return d;
}
export function runTook(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${runPad(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${runPad(m % 60)}m`;
}
export function runOutputPath(tpl: string, d: Date): string {
  let p = String(tpl).trim()
    .replace(/\{\{date\}\}/g, `${d.getFullYear()}-${runPad(d.getMonth() + 1)}-${runPad(d.getDate())}`)
    .replace(/\{\{time\}\}/g, `${runPad(d.getHours())}${runPad(d.getMinutes())}`);
  if (!/\.[A-Za-z0-9]{1,5}$/.test(p.split("/").pop() || "")) p += ".md";
  return p;
}
function runCell(s: string | null | undefined): string {
  return String(s ?? "").replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
}
function runSplitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\" && body[i + 1] === "|") { cur += "|"; i++; continue; }
    if (c === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}
export function emptyRunRow(): RunRow {
  const row = {} as RunRow;
  for (const c of RUN_LOG_COLUMNS) row[c] = "";
  return row;
}
export function parseRunLog(text: string | null | undefined): RunRow[] {
  const rows: RunRow[] = [];
  let cols: string[] | null = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!cols && /^\s*\|\s*Started\s*\|/.test(line)) { cols = runSplitRow(line); continue; }
    if (!/^\s*\|\s*\d{4}-\d{2}-\d{2}/.test(line)) continue;
    const cells = runSplitRow(line);
    const row = emptyRunRow();
    (cols || [...RUN_LOG_COLUMNS]).forEach((c, i) => {
      if ((RUN_LOG_COLUMNS as readonly string[]).includes(c)) row[c as RunColumn] = cells[i] || "";
    });
    rows.push(row);
  }
  return rows;
}
export function renderRunLog(rows: RunRow[]): string {
  const head = "# Run log\n\nAgent Manager keeps this file: one row per run of this task, newest first.\n\n";
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return head + [line([...RUN_LOG_COLUMNS]), line(RUN_LOG_COLUMNS.map(() => "---")), ...rows.map((r) => line(RUN_LOG_COLUMNS.map((c) => runCell(r[c]))))].join("\n") + "\n";
}
export function runLogUpsert(rows: RunRow[], row: RunRow): RunRow[] {
  const out = rows.slice();
  const i = out.findIndex((r) => r.Started === row.Started && r.Machine === row.Machine);
  if (i >= 0) out[i] = row; else out.unshift(row);
  return out;
}
export function runResultPath(cell: string | null | undefined): string {
  const m = /\[\[([^\]|#]+)/.exec(String(cell || ""));
  const p = m ? m[1].trim().replace(/\\$/, "").trim() : "";
  return p && !/\.[A-Za-z0-9]{1,5}$/.test(p.split("/").pop() || "") ? `${p}.md` : p;
}
export function runSummary(text: string | null | undefined): string {
  let found = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s*[*_]*Summary:?[*_]*:?\s*(.+?)\s*$/i.exec(line);
    if (m) found = m[1].replace(/^[*_\s]+|[*_\s]+$/g, "");
  }
  return found;
}
export function runPrepareResult(text: string | null | undefined, meta: { summary?: string; searched?: string[]; read?: string[] } = {}): string {
  let s = String(text || "");
  s = s.replace(/!\[([^\]]*)\]\(\s*<?(https?:\/\/[^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gi, (_w, alt: string, url: string) => `[Image${alt ? `: ${alt}` : ""}](${url})`);
  s = s.replace(/<img\b[^>]*\bsrc\s*=\s*["']?(https?:\/\/[^"'\s>]+)["']?[^>]*>/gi, (_w, url: string) => `[Image](${url})`);
  const remote = new Set<string>();
  for (const m of s.matchAll(/^[ \t]{0,3}\[([^\]]+)\]:[ \t]*<?https?:\/\//gim)) remote.add(m[1].trim().toLowerCase());
  if (remote.size) {
    s = s.replace(/!\[([^\][]*)\](?:\[([^\]]*)\])?(?!\()/g, (whole, alt: string, ref: string | undefined) => {
      const key = (ref && ref.trim() ? ref : alt).trim().toLowerCase();
      if (!remote.has(key)) return whole;
      return `[Image${alt ? `: ${alt}` : ""}]${ref !== undefined ? `[${ref}]` : `[${alt}]`}`;
    });
  }
  const list = (name: string, xs: string[] | undefined) => {
    const items = [...new Set((xs || []).map((x) => blankTokens(String(x)).replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 200);
    return items.length ? `${name}:\n${items.map((x) => `  - ${JSON.stringify(x)}`).join("\n")}\n` : "";
  };
  s = blankTokens(s);
  const summary = blankTokens(String(meta.summary || "")).replace(/\s+/g, " ").trim();
  const evidence = (summary ? `summary: ${JSON.stringify(summary)}\n` : "") + list("searched", meta.searched) + list("read", meta.read);
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(s);
  if (fm) {
    const drop = /^(origin|summary|searched|read|type|done|reads|from-task|main-session)\s*:/i;
    const plainKey = /^[\p{L}\p{N}_][\p{L}\p{N}_ .-]*?\s*:(\s|$)/u;
    const lines: string[] = [];
    let skipping = true;
    for (const l of fm[1].split(/\r?\n/)) {
      if (/^\S/.test(l) && !/^-(\s|$)/.test(l)) skipping = !plainKey.test(l) || drop.test(l);
      if (!skipping) lines.push(l);
    }
    s = `---\norigin: external\n${evidence}${lines.join("\n")}${lines.length ? "\n" : ""}---\n` + s.slice(fm[0].length);
  } else {
    s = `---\norigin: external\n${evidence}---\n` + s;
  }
  return s;
}
export function blankTokens(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted]")
    .replace(/\b(?:sk-ant-|sk-proj-|sk-|ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|xox[abprs]-|AKIA|ASIA|AIza|ya29\.)[A-Za-z0-9_\-.]{12,}/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]");
}
export function runOutcomeHead(outcome: string): string {
  if (outcome === "succeeded") return "Scheduled run finished";
  if (outcome === "nothing new") return "Scheduled run found nothing new";
  return `Scheduled run ${outcome}`;
}
