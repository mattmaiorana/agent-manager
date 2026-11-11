
export const RUN_LOG_COLUMNS = ["Started", "Occurrence", "Attempt", "Outcome", "Took", "Result", "Session", "Backend", "Machine", "Note"] as const;
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
export interface RunInit {
  tools?: unknown;
  mcp_servers?: unknown;
  apiKeySource?: unknown;
  permissionMode?: unknown;
  plugins?: unknown;
  memory_paths?: unknown;
}
const textOf = (v: unknown): string => (typeof v === "string" ? v : "");
export function runInitProblem(init: RunInit | null | undefined, allowedTools: string[], allowedServers: string[] = []): string {
  if (!init) return "It never reported how it started.";
  if (!Array.isArray(init.tools)) return "Its startup record has no tools list.";
  const allowed = new Set(allowedTools);
  const extra = (init.tools as unknown[]).map(textOf).filter((x) => !allowed.has(x));
  if (extra.length) return `It started with tools it wasn't given: ${extra.join(", ")}.`;
  const servers = Array.isArray(init.mcp_servers) ? (init.mcp_servers as unknown[]) : [];
  const names = servers.map((s) => (s && typeof s === "object" ? textOf((s as { name?: unknown }).name) : textOf(s)) || "unnamed");
  const extraServers = names.filter((n) => !allowedServers.includes(n));
  if (extraServers.length) return `It started with connectors or MCP servers: ${extraServers.join(", ")}.`;
  const key = textOf(init.apiKeySource);
  if (key && key !== "none") return `It started with an API key (${key}) instead of a Claude subscription login.`;
  const mode = textOf(init.permissionMode);
  if (!mode) return "Its startup record has no permission mode.";
  if (mode !== "dontAsk") return `It started in permission mode "${mode}", not dontAsk.`;
  const plugins = Array.isArray(init.plugins) ? (init.plugins as unknown[]) : [];
  const outside = plugins.filter((p) => !(p && typeof p === "object" && (p as { path?: unknown }).path === "builtin"))
    .map((p) => (p && typeof p === "object" ? textOf((p as { name?: unknown }).name) : "") || "unnamed");
  if (outside.length) return `It started with plugins that aren't Claude's own: ${outside.join(", ")}.`;
  if (init.memory_paths && typeof init.memory_paths === "object" && Object.keys(init.memory_paths).length) return "It started with Claude Code's automatic memory attached.";
  return "";
}
export function runFailureKind(resultText: string | null | undefined, stderr: string | null | undefined): "login" | "usage" | "failed" {
  const s = `${resultText || ""}\n${stderr || ""}`;
  if (/usage limit|limit reached|hit your (?:usage |session |weekly )?limit|out of (?:extra )?usage|rate.?limit/i.test(s)) return "usage";
  if (/\/login\b|log ?in again|not logged in|invalid api key|authenticat|oauth token|expired token|credentials|401 unauthorized|missing bearer/i.test(s)) return "login";
  return "failed";
}
export function runNothingNew(text: string | null | undefined): string | null {
  const m = /^\s*[*_]*Nothing to report[*_]*\s*[:.-]?\s*(.*)$/im.exec(String(text || ""));
  return m ? (m[1].trim() || "Nothing new.") : null;
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
export function runGatherCommands(section: string | null | undefined): string[] {
  const out: string[] = [];
  for (let line of String(section || "").split(/\r?\n/)) {
    line = line.trim();
    if (!line || /^(```|~~~)/.test(line) || line.startsWith("#")) continue;
    line = line.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "");
    const m = /^`([^`]+)`$/.exec(line);
    if (m) line = m[1];
    if (line) out.push(line);
  }
  return out;
}

export type RunEvent =
  | { kind: "init"; init: RunInit }
  | { kind: "result"; isError: boolean; text: string; subtype: string }
  | { kind: "tools"; uses: { id?: string; name: string; input: Record<string, unknown> }[] }
  | { kind: "results"; results: { id: string; isError: boolean; text: string }[] }
  | { kind: "denied"; id: string; tool: string; reason: string; message: string };
function resultText(v: unknown): string {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  return (v as unknown[]).map((x) => (x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string" ? (x as { text: string }).text : "")).filter(Boolean).join("\n");
}
export function parseRunEvent(line: string, opts: { results?: boolean } = {}): RunEvent | null {
  if (!line.trim()) return null;
  let ev: unknown;
  try { ev = JSON.parse(line); } catch { return null; }
  if (!ev || typeof ev !== "object") return null;
  const e = ev as Record<string, unknown>;
  if (e.type === "system" && e.subtype === "init") return { kind: "init", init: e };
  if (e.type === "result") return { kind: "result", isError: e.is_error !== false, text: textOf(e.result), subtype: textOf(e.subtype) };
  if (e.type === "assistant" && e.message && typeof e.message === "object") {
    const content = (e.message as { content?: unknown }).content;
    if (!Array.isArray(content)) return null;
    const uses: { id?: string; name: string; input: Record<string, unknown> }[] = [];
    for (const c of content as unknown[]) {
      if (!c || typeof c !== "object") continue;
      const u = c as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
      if (u.type === "tool_use" && typeof u.name === "string") uses.push({ ...(opts.results ? { id: textOf(u.id) } : {}), name: u.name, input: u.input && typeof u.input === "object" ? (u.input as Record<string, unknown>) : {} });
    }
    return uses.length ? { kind: "tools", uses } : null;
  }
  if (!opts.results) return null;
  if (e.type === "system" && e.subtype === "permission_denied") return { kind: "denied", id: textOf(e.tool_use_id), tool: textOf(e.tool_name), reason: textOf(e.decision_reason_type), message: textOf(e.message) };
  if (e.type === "user" && e.message && typeof e.message === "object") {
    const content = (e.message as { content?: unknown }).content;
    if (!Array.isArray(content)) return null;
    const results: { id: string; isError: boolean; text: string }[] = [];
    for (const c of content as unknown[]) {
      if (!c || typeof c !== "object") continue;
      const r = c as { type?: unknown; tool_use_id?: unknown; is_error?: unknown; content?: unknown };
      if (r.type === "tool_result" && typeof r.tool_use_id === "string") results.push({ id: r.tool_use_id, isError: r.is_error === true, text: resultText(r.content) });
    }
    return results.length ? { kind: "results", results } : null;
  }
  return null;
}

export type RunOutcome = "succeeded" | "nothing new" | "wrote nothing" | "refused" | "failed" | "login expired" | "usage limit" | "timed out" | "stopped" | "interrupted";
export interface RunEnd {
  killedFor: "refused" | "timed out" | "stopped" | "interrupted" | null;
  refusal: string;
  spawnError: string;
  sawInit: boolean;
  result: { isError: boolean; text: string; subtype: string } | null;
  exitCode: number | null;
  stderr: string;
  wrote: boolean;
  onlyWhenNew: boolean;
  timeLimitMin: number;
}
export function runOutcome(x: RunEnd): { outcome: RunOutcome; note: string } {
  const text = x.result?.text || "";
  if (x.killedFor === "refused") return { outcome: "refused", note: x.refusal };
  if (x.killedFor === "timed out") return { outcome: "timed out", note: `It ran past the time limit (${x.timeLimitMin} minutes).` };
  if (x.killedFor === "stopped") return { outcome: "stopped", note: "" };
  if (x.killedFor === "interrupted") return { outcome: "interrupted", note: "Obsidian closed or the plugin reloaded during the run." };
  if (x.spawnError) return { outcome: "failed", note: x.spawnError };
  if (!x.sawInit) return { outcome: "refused", note: runInitProblem(null, []) };
  if (x.result && !x.result.isError && x.exitCode === 0) {
    if (x.wrote) return { outcome: "succeeded", note: runSummary(text) };
    const quiet = x.onlyWhenNew ? runNothingNew(text) : null;
    if (quiet) return { outcome: "nothing new", note: quiet };
    return { outcome: "wrote nothing", note: runSummary(text) || "It finished without writing its result." };
  }
  const kind = runFailureKind(text, x.stderr);
  if (kind === "login") return { outcome: "login expired", note: "Claude's login expired: log in again in any Claude tab, then Run now." };
  if (kind === "usage") return { outcome: "usage limit", note: text.slice(0, 200) };
  const last = x.stderr.trim().split("\n").pop() || "";
  return { outcome: "failed", note: (text || last || (x.result ? x.result.subtype : "") || `It exited with code ${x.exitCode ?? "unknown"} and no result.`).slice(0, 200) };
}
