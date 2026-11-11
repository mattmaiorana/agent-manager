
export interface ActionEntry { tool: string; input: string; outcome: "ok" | "refused" | "error" | "no result"; flags: string[]; agent: string | null }
export interface ActionLogInput {
  lines: string[];
  subagents?: { name: string; lines: string[] }[];
  taskFolder: string;
  outputFolder: string;
  web: { mode: "off" | "search" | "sites"; sites: string[] };
  tookMs: number;
  usualMs: number | null;
  cwd?: string;
  home?: string;
}
export interface ActionLog { entries: ActionEntry[]; flags: string[]; alerts: string[] }

const INPUT_MAX = 160;
const LONG_RUN_FLOOR_MS = 5 * 60 * 1000;
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const AGENT_CLI_WORDS = new Set(["codex", "claude", "agy", "antigravity", "gemini", "opencode", "aider", "cursor-agent", "amp", "goose"]);
const NETWORK_WORDS = new Set(["curl", "wget", "nc", "ncat", "ssh", "scp", "sftp", "rsync", "ftp", "telnet", "http", "https", "aria2c", "osascript"]);
const READ_WORDS = new Set(["get", "list", "search", "read", "fetch", "query", "find", "describe", "lookup", "view", "download", "count", "check"]);
const WRAPPERS: Record<string, string[]> = {
  env: ["-u", "-C", "-S"], command: [], sudo: ["-u", "-g", "-p", "-C", "-U", "-h"], doas: ["-u"],
  exec: ["-a"], nohup: [], time: [], nice: ["-n"], builtin: [], xargs: ["-I", "-n", "-L", "-P", "-s", "-E", "-d"], caffeinate: ["-t", "-w"],
};
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const SHELL_SEPARATOR = /&&|\|\||[;|&\n()`{}]|\$\(/;

interface FlagKind { did: string; tried: string; details: boolean; alert: boolean }
const KINDS = {
  write: { did: "It wrote outside the task's folders", tried: "It tried to write outside the task's folders", details: true, alert: false },
  shellWrite: { did: "Its shell commands may have written outside the task's folders", tried: "It tried shell commands that write outside the task's folders", details: true, alert: false },
  push: { did: "It pushed with git", tried: "It tried to push with git", details: false, alert: true },
  security: { did: "It ran the security command, which reads the Keychain", tried: "It tried to run the security command, which reads the Keychain", details: false, alert: true },
  network: { did: "It ran network commands", tried: "It tried to run network commands", details: true, alert: true },
  shellHost: { did: "Its shell commands named hosts off the site list", tried: "It tried shell commands that name hosts off the site list", details: true, alert: true },
  connector: { did: "It made connector calls that aren't reads", tried: "It tried connector calls that aren't reads", details: true, alert: true },
  connectorHost: { did: "Its connector calls named hosts off the site list", tried: "It tried connector calls that name hosts off the site list", details: true, alert: true },
  site: { did: "It fetched pages off the site list", tried: "It tried to fetch pages off the site list", details: true, alert: true },
  webOff: { did: "It used the web while web access is off", tried: "It tried to use the web while web access is off", details: false, alert: true },
  agentCli: { did: "It started another agent's CLI", tried: "It tried to start another agent's CLI", details: true, alert: false },
} satisfies Record<string, FlagKind>;
type KindKey = keyof typeof KINDS;
interface Hit { kind: KindKey; detail: string; text: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string { return typeof v === "string" ? v : ""; }

export function urlHost(url: string): string | null {
  let s = String(url ?? "").trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(s);
  if (scheme) s = s.slice(scheme[0].length);
  else if (s.startsWith("//")) s = s.slice(2);
  s = s.split(/[/?#\\]/)[0];
  const at = s.lastIndexOf("@");
  if (at >= 0) s = s.slice(at + 1);
  s = s.toLowerCase();
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    return end > 1 && /^[0-9a-f:.]+$/.test(s.slice(1, end)) ? s.slice(0, end + 1) : null;
  }
  s = s.replace(/:\d*$/, "").replace(/\.$/, "").replace(/^www\./, "");
  if (!s || !/^[a-z0-9.-]+$/.test(s) || s.startsWith(".") || s.includes("..")) return null;
  return s;
}

export function onList(host: string, sites: string[]): boolean {
  const h = urlHost(host);
  if (!h) return false;
  return sites.some((site) => {
    const s = urlHost(site);
    return !!s && (h === s || h.endsWith("." + s));
  });
}

export function shellHosts(command: string): string[] {
  const out: string[] = [];
  for (const m of String(command ?? "").matchAll(/https?:\/\/[^\s'"`<>|;()]+/gi)) {
    const h = urlHost(m[0]);
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

export function hostsOffList(urls: string[], web: ActionLogInput["web"]): string[] {
  if (web.mode === "search") return [];
  const out: string[] = [];
  for (const u of urls) {
    const h = urlHost(u);
    if (!h || out.includes(h)) continue;
    if (web.mode === "off" || !onList(h, web.sites)) out.push(h);
  }
  return out;
}

function normPath(p: string): string {
  const abs = p.startsWith("/");
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { if (parts.length && parts[parts.length - 1] !== "..") parts.pop(); else if (!abs) parts.push(".."); continue; }
    parts.push(seg);
  }
  return ((abs ? "/" : "") + parts.join("/")).toLowerCase();
}
function insideFolder(path: string, folder: string): boolean {
  if (!folder.trim() || !path.startsWith("/")) return false;
  const p = normPath(path), f = normPath(folder);
  return p === f || p.startsWith(f === "/" ? "/" : f + "/");
}

function unquote(tok: string): string { return tok.replace(/["']/g, "").replace(/^\\/, ""); }
function baseWord(tok: string): string { return (tok.split("/").pop() ?? "").toLowerCase(); }

interface ShellFacts { words: string[]; push: boolean }
function shellFacts(command: string, depth = 0): ShellFacts {
  const facts: ShellFacts = { words: [], push: false };
  for (const segment of command.split(SHELL_SEPARATOR)) {
    const toks = segment.trim().split(/\s+/).filter(Boolean).map(unquote).filter(Boolean);
    let i = 0;
    while (i < toks.length) {
      const t = toks[i];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
      const w = baseWord(t);
      const takes = WRAPPERS[w];
      if (!takes) break;
      i++;
      while (i < toks.length && toks[i].startsWith("-")) { i += takes.includes(toks[i]) ? 2 : 1; }
    }
    if (i >= toks.length) continue;
    const word = baseWord(toks[i]);
    facts.words.push(word);
    const rest = toks.slice(i + 1);
    if (word === "git") {
      let j = 0;
      while (j < rest.length && rest[j].startsWith("-")) { j += ["-C", "-c"].includes(rest[j]) ? 2 : 1; }
      if (rest[j] === "push") facts.push = true;
    }
    if (depth < 3 && (word === "eval" || SHELLS.has(word))) {
      const c = word === "eval" ? 0 : rest.findIndex((r) => /^-[a-z]*c[a-z]*$/i.test(r));
      if (c >= 0) {
        const inner = shellFacts(rest.slice(word === "eval" ? 0 : c + 1).join(" "), depth + 1);
        facts.words.push(...inner.words);
        facts.push ||= inner.push;
      }
    }
  }
  return facts;
}

interface ToolCall { id: string; name: string; input: unknown }
interface ToolResult { isError: boolean; text: string }

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (isRecord(c) && c.type === "text" ? str(c.text) : "")).filter(Boolean).join("\n");
}

function readTranscript(lines: string[]): { calls: ToolCall[]; results: Map<string, ToolResult> } {
  const calls: ToolCall[] = [];
  const seen = new Set<string>();
  const results = new Map<string, ToolResult>();
  for (const line of lines) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isRecord(row) || !isRecord(row.message)) continue;
    const content = row.message.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (row.type === "assistant" && item.type === "tool_use") {
        const id = str(item.id);
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        calls.push({ id, name: str(item.name) || "(unnamed)", input: item.input });
      } else if (row.type === "user" && item.type === "tool_result") {
        const id = str(item.tool_use_id);
        if (id) results.set(id, { isError: item.is_error === true, text: resultText(item.content) });
      }
    }
  }
  return { calls, results };
}

const REFUSED = /denied|hook error|blocked by (?:a |the )?\S*\s*hook|hook\b.*\bblocked|user doesn't want to proceed|user rejected/i;
function outcomeOf(r: ToolResult | undefined): ActionEntry["outcome"] {
  if (!r) return "no result";
  if (!r.isError) return "ok";
  return REFUSED.test(r.text) ? "refused" : "error";
}

function clip(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > INPUT_MAX ? one.slice(0, INPUT_MAX - 1) + "…" : one;
}
function summarize(name: string, input: unknown): string {
  if (!isRecord(input)) return clip(input === undefined ? "" : JSON.stringify(input) ?? "");
  const pick = (...keys: string[]): string => { for (const k of keys) { const v = str(input[k]); if (v) return v; } return ""; };
  if (name === "Bash") return clip(pick("command"));
  if (name === "WebSearch") return clip(pick("query"));
  if (name === "Glob" || name === "Grep") {
    const where = pick("path");
    return clip(where ? `${pick("pattern")} in ${where}` : pick("pattern"));
  }
  const one = pick("file_path", "notebook_path", "url", "command", "query", "description", "path", "pattern");
  return clip(one || JSON.stringify(input));
}

function mcpToolPart(name: string): string | null {
  const m = /^mcp__.+?__(.+)$/.exec(name);
  return m ? m[1] : null;
}
function looksLikeRead(tool: string): boolean {
  const words = tool.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_-]+/);
  return words.some((w) => READ_WORDS.has(w));
}

export function shellWriteTargets(command: string, cwd?: string, home?: string): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    let p = raw.replace(/^["']|["']$/g, "");
    if (!p || p === "-" || /^\/dev\/(null|stdout|stderr|tty|fd\/)/.test(p) || /^&\d?$/.test(p) || p.includes("$") || p.includes("`")) return;
    if (p.startsWith("~/") || p === "~") { if (!home) return; p = home + p.slice(1); }
    else if (!p.startsWith("/")) { if (!cwd) return; p = `${cwd.replace(/\/+$/, "")}/${p}`; }
    const parts: string[] = [];
    for (const seg of p.split("/")) { if (seg === "..") parts.pop(); else if (seg && seg !== ".") parts.push(seg); }
    const n = "/" + parts.join("/");
    if (!out.includes(n)) out.push(n);
  };
  const words = (seg: string): string[] => (seg.match(/"[^"]*"|'[^']*'|[^\s"']+/g) || []);
  const top = cwd;
  let chained = true;
  const parts = command.split(/(&&|\|\||[;|\n()])/);
  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i];
    const sep = i > 0 ? parts[i - 1] : "&&";
    if (sep !== "&&") { chained = false; cwd = top; }
    for (const m of seg.matchAll(/(?:^|[^<>&\d])>{1,2}\|?\s*("[^"]*"|'[^']*'|[^\s;&|()<>]+)/g)) add(m[1]);
    const w = words(seg.trim()).filter((t) => !/^[A-Za-z_]\w*=/.test(t));
    while (w.length && ["sudo", "env", "command", "nohup", "time", "nice", "exec"].includes(baseWord(w[0]))) w.shift();
    if (!w.length) continue;
    const cmd = baseWord(unquote(w[0]));
    if (cmd === "cd") {
      const to = w[1] ? unquote(w[1]) : "";
      const ok = chained && w.length === 2 && to && !to.includes("$") && !to.includes("`") && to !== "-";
      if (!ok) { chained = false; cwd = top; continue; }
      cwd = to.startsWith("/") ? to : to.startsWith("~/") && home ? home + to.slice(1) : cwd ? `${cwd.replace(/\/+$/, "")}/${to}` : undefined;
      continue;
    }
    const args = w.slice(1).filter((t) => !t.startsWith("-") && !t.startsWith(">"));
    if (cmd === "tee" || ["rm", "rmdir", "mkdir", "touch", "truncate", "chmod", "chown"].includes(cmd)) for (const a of cmd === "chmod" || cmd === "chown" ? args.slice(1) : args) add(a);
    else if (["cp", "mv", "ln", "install", "ditto"].includes(cmd) && args.length) add(args[args.length - 1]);
    else if (cmd === "sed" && w.some((t) => /^-i/.test(t))) for (const a of args.slice(1)) add(a);
  }
  return out;
}
function hitsFor(name: string, input: unknown, x: ActionLogInput): Hit[] {
  const hits: Hit[] = [];
  const rec = isRecord(input) ? input : {};
  if (WRITE_TOOLS.has(name)) {
    const path = str(rec.file_path) || str(rec.notebook_path);
    if (!insideFolder(path, x.taskFolder) && !insideFolder(path, x.outputFolder)) {
      hits.push({ kind: "write", detail: path || "(no path)", text: `Writes outside the task's folders: ${path || "(no path)"}` });
    }
  }
  if (name === "Bash") {
    const command = str(rec.command);
    const facts = shellFacts(command);
    if (facts.push || /(?:^|[^\w./-])git\s+push(?![\w-])/i.test(command)) hits.push({ kind: "push", detail: "", text: "Pushes with git" });
    if (facts.words.includes("security")) hits.push({ kind: "security", detail: "", text: "Runs the security command (the Keychain)" });
    const net = [...new Set(facts.words.filter((w) => NETWORK_WORDS.has(w)))];
    for (const w of net) hits.push({ kind: "network", detail: w, text: `A network command: ${w}` });
    for (const w of new Set(facts.words.filter((x) => AGENT_CLI_WORDS.has(x)))) hits.push({ kind: "agentCli", detail: w, text: `Starts another agent's CLI: ${w}` });
    for (const p of shellWriteTargets(command, x.cwd, x.home)) {
      if (!insideFolder(p, x.taskFolder) && !insideFolder(p, x.outputFolder)) hits.push({ kind: "shellWrite", detail: p, text: `A shell command writes outside the task's folders: ${p}` });
    }
    for (const h of hostsOffList(shellHosts(command).map((s) => `https://${s}`), x.web)) {
      hits.push({ kind: "shellHost", detail: h, text: `A host off the site list: ${h}` });
    }
  }
  const tool = mcpToolPart(name);
  if (tool && !looksLikeRead(tool)) hits.push({ kind: "connector", detail: tool, text: `A connector call that isn't a read: ${tool}` });
  if (tool && x.web.mode !== "search") {
    for (const h of hostsOffList(shellHosts(JSON.stringify(input ?? {})).map((s) => `https://${s}`), x.web)) {
      hits.push({ kind: "connectorHost", detail: h, text: `A connector call names a host off the site list: ${h}` });
    }
  }
  if (name === "WebFetch" || name === "WebSearch") {
    if (x.web.mode === "off") hits.push({ kind: "webOff", detail: "", text: "Web use while web access is off" });
    else if (x.web.mode === "sites" && name === "WebFetch") {
      const url = str(rec.url);
      const h = urlHost(url);
      if (!h || !onList(h, x.web.sites)) hits.push({ kind: "site", detail: h ?? clip(url), text: `A site off the list: ${h ?? clip(url)}` });
    }
  }
  return hits;
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return "under a minute";
  return m === 1 ? "1 minute" : `${m} minutes`;
}
function listDetails(details: string[]): string {
  const shown = details.slice(0, 5);
  const more = details.length - shown.length;
  return shown.join(", ") + (more > 0 ? `, and ${more} more` : "");
}

export function actionLog(x: ActionLogInput): ActionLog {
  const entries: ActionEntry[] = [];
  const kinds = new Map<KindKey, { details: string[]; did: boolean }>();
  const sources: { agent: string | null; lines: string[] }[] = [{ agent: null, lines: x.lines }, ...(x.subagents ?? []).map((s) => ({ agent: s.name, lines: s.lines }))];
  for (const src of sources) {
    const { calls, results } = readTranscript(src.lines);
    for (const call of calls) {
      const outcome = outcomeOf(results.get(call.id));
      const hits = hitsFor(call.name, call.input, x);
      for (const h of hits) {
        const k = kinds.get(h.kind) ?? { details: [], did: false };
        if (h.detail && !k.details.includes(h.detail)) k.details.push(h.detail);
        if (outcome === "ok" || outcome === "no result") k.did = true;
        kinds.set(h.kind, k);
      }
      entries.push({ tool: call.name, input: summarize(call.name, call.input), outcome, flags: [...new Set(hits.map((h) => h.text))], agent: src.agent });
    }
  }
  const flags: string[] = [];
  const alerts: string[] = [];
  for (const [key, k] of kinds) {
    const kind: FlagKind = KINDS[key];
    const head = k.did ? kind.did : kind.tried;
    const sentence = kind.details && k.details.length ? `${head}: ${listDetails(k.details)}.` : `${head}.`;
    if (!flags.includes(sentence)) flags.push(sentence);
    if (kind.alert && !alerts.includes(sentence)) alerts.push(sentence);
  }
  if (x.usualMs !== null && x.usualMs > 0 && x.tookMs > 3 * x.usualMs && x.tookMs > LONG_RUN_FLOOR_MS) {
    flags.push(`It ran far longer than usual (${minutes(x.tookMs)} against a usual ${minutes(x.usualMs)}).`);
  }
  return { entries, flags, alerts };
}

function cell(s: string): string {
  return s.replace(/\r?\n+/g, " ").replace(/[\\`*_[\]<>|$~=]/g, "\\$&").trim();
}

export function renderActionLog(log: ActionLog, meta: { task: string; started: string; session: string }): string {
  const out: string[] = [`# Actions: ${meta.task}, ${meta.started}`, "", `Session: ${meta.session || "unknown"}`, "", "## Flags", ""];
  if (log.flags.length) for (const f of log.flags) out.push(`- ${f}`);
  else out.push("No flags.");
  out.push("", "## Calls", "");
  if (!log.entries.length) out.push("No tool calls.");
  else {
    out.push("| # | Tool | Input | Outcome | Flags |", "| --- | --- | --- | --- | --- |");
    log.entries.forEach((e, i) => {
      const tool = e.agent ? `${e.agent}: ${e.tool}` : e.tool;
      out.push(`| ${i + 1} | ${cell(tool)} | ${cell(e.input)} | ${e.outcome} | ${cell(e.flags.join("; "))} |`);
    });
  }
  return out.join("\n") + "\n";
}
