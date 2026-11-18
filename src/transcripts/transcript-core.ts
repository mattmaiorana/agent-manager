import * as fs from "fs";
import * as path from "path";
import { stringOf } from "../util/guards.js";
import { blankTokens } from "../scheduled/run-core.js";
import type { TranscriptIO, TranscriptImage, TranscriptMessage, TranscriptMeta, TranscriptPart, TranscriptWrite, TranscriptWriteOptions } from "../types.js";

const TRANSCRIPT_DIR = "Agent Transcripts";

interface ToolInput {
  description?: unknown;
  command?: unknown;
  file_path?: unknown;
  path?: unknown;
  pattern?: unknown;
  query?: unknown;
  url?: unknown;
  prompt?: unknown;
  subagent_type?: unknown;
}
interface ClaudeBlock {
  type?: unknown;
  text?: string;
  name?: string;
  input?: ToolInput | null;
  id?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
  source?: { type?: unknown; data?: unknown; media_type?: unknown } | null;
}
interface ClaudeLine {
  isSidechain?: unknown;
  type?: unknown;
  subtype?: unknown;
  uuid?: string;
  timestamp?: string;
  isCompactSummary?: unknown;
  isVisibleInTranscriptOnly?: unknown;
  isMeta?: unknown;
  message?: { content?: unknown; model?: unknown; id?: unknown; usage?: ClaudeUsage | null } | null;
  customTitle?: unknown;
  effort?: unknown;
  version?: unknown;
  cwd?: unknown;
  toolUseResult?: unknown;
  origin?: { kind?: unknown } | null;
}
interface ClaudeUsage {
  input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  output_tokens?: unknown;
}
interface CodexLine {
  timestamp?: unknown;
  payload?: {
    id?: string;
    type?: unknown;
    role?: unknown;
    content?: unknown;
    name?: string;
    input?: unknown;
    arguments?: unknown;
    model?: unknown;
    effort?: unknown;
    cwd?: unknown;
    cli_version?: unknown;
    info?: { total_token_usage?: { input_tokens?: unknown; cached_input_tokens?: unknown; output_tokens?: unknown } | null } | null;
  } | null;
}
interface AgyLine {
  step_index?: number | string | null;
  type?: unknown;
  content?: unknown;
  tool_calls?: ({ name?: string; args?: unknown } | null)[];
  created_at?: unknown;
  input_tokens?: unknown;
  cache_read_tokens?: unknown;
  output_tokens?: unknown;
}
interface CodexBlock {
  text?: unknown;
}

function toolHint(raw: unknown): string {
  const first = maskSecrets(stringOf(raw).split("\n")[0]);
  return first.length > 90 ? first.slice(0, 90) + "…" : first;
}
function transcriptToolHint(b: ClaudeBlock): string {
  const i: ToolInput = b.input || {};
  return toolHint(i.description || i.command || i.file_path || i.path || i.pattern || i.query || i.url || i.prompt || "");
}
function isInjectedTranscriptContext(text: string): boolean {
  const t = text.trimStart();
  return /^# AGENTS\.md instructions\b/.test(t)
    || /^<(environment_context|user_instructions|INSTRUCTIONS|system-reminder)\b/.test(t);
}
function isBlocks(c: unknown): c is (ClaudeBlock | null)[] {
  return Array.isArray(c);
}
function isCodexBlocks(c: unknown): c is (CodexBlock | null)[] {
  return Array.isArray(c);
}
function claudeImages(blocks: unknown): TranscriptImage[] {
  if (!isBlocks(blocks)) return [];
  const out: TranscriptImage[] = [];
  for (const b of blocks) {
    const src = b && b.type === "image" ? b.source : null;
    if (src && src.type === "base64" && typeof src.data === "string" && typeof src.media_type === "string" && /^image\//.test(src.media_type)) out.push({ data: src.data, mediaType: src.media_type });
  }
  return out;
}
const REPORT_MAX = 20000;
function parseClaudeTranscript(o: ClaudeLine, sidechain = false, results = false): TranscriptMessage | null {
  if (o.isSidechain && !sidechain) return null;
  if (o.type === "system" && o.subtype === "compact_boundary") {
    return { role: "boundary", uuid: o.uuid || ("boundary-" + (o.timestamp || "")) };
  }
  if (o.isCompactSummary || o.isVisibleInTranscriptOnly) return null;
  if (o.type === "user") {
    if (o.isMeta) return null;
    const c = o.message && o.message.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (isBlocks(c)) {
      if (c.length && c.every((b) => b && b.type === "tool_result")) {
        if (!results) return null;
        const parts: TranscriptPart[] = [];
        const tr = o.toolUseResult && typeof o.toolUseResult === "object" ? o.toolUseResult as { agentId?: unknown; isAsync?: unknown } : null;
        const agentId = typeof tr?.agentId === "string" ? tr.agentId : "";
        const async = tr?.isAsync === true;
        for (const b of c) {
          if (!b || typeof b.tool_use_id !== "string") continue;
          const images = claudeImages(b.content);
          const error = b.is_error === true;
          const report = agentId || error ? (typeof b.content === "string" ? b.content : isBlocks(b.content) ? b.content.filter((x) => x && x.type === "text").map((x) => (x as ClaudeBlock).text).join("\n\n") : "").trim().slice(0, REPORT_MAX) : "";
          if (images.length || agentId || error) parts.push({ kind: "result", toolUseId: b.tool_use_id, images, ...(agentId ? { agentId } : {}), ...(report ? { report } : {}), ...(error ? { error } : {}), ...(async ? { async } : {}) });
        }
        return parts.length ? { role: "assistant", parts, uuid: o.uuid, ...timeOf(o.timestamp) } : null;
      }
      text = c.filter((b) => b && b.type === "text").map((b) => (b as ClaudeBlock).text).join("\n\n");
    }
    text = (text || "").trim();
    if (results && /^<task-notification>/.test(text)) {
      const tag = (t: string) => new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(text)?.[1]?.trim() ?? "";
      const toolUseId = tag("tool-use-id");
      const agentId = tag("task-id");
      if (!toolUseId && !agentId) return null;
      const status = tag("status");
      const ms = Number(tag("duration_ms"));
      return { role: "assistant", parts: [{ kind: "result", toolUseId, images: [], ...(agentId ? { agentId } : {}), report: (tag("result") || (toolUseId ? "" : tag("summary"))).slice(0, REPORT_MAX), ...(status && status !== "completed" ? { error: true } : {}), ...(status === "stopped" || status === "killed" ? { stopped: true } : {}), ...(Number.isFinite(ms) && ms > 0 ? { durationMs: ms } : {}) }], uuid: o.uuid, ...timeOf(o.timestamp) };
    }
    const images = results ? claudeImages(c) : [];
    return text || images.length ? { role: "user", text, uuid: o.uuid, ...timeOf(o.timestamp), ...(images.length ? { images } : {}) } : null;
  }
  if (o.type === "assistant") {
    const c = o.message && o.message.content;
    if (!isBlocks(c)) return null;
    const parts: TranscriptPart[] = [];
    for (const b of c) {
      if (b && b.type === "text" && b.text && b.text.trim()) parts.push({ kind: "md", text: b.text });
      else if (b && b.type === "tool_use") {
        const command = SHELL_TOOLS.has(b.name || "") && b.input && typeof b.input.command === "string" ? b.input.command : "";
        const inp = b.input;
        const agent = (b.name === "Agent" || b.name === "Task") && inp ? { description: typeof inp.description === "string" ? inp.description : "", type: typeof inp.subagent_type === "string" ? inp.subagent_type : "" } : null;
        parts.push({ kind: "tool", name: b.name || "tool", hint: transcriptToolHint(b), ...(command ? { command } : {}), ...(typeof b.id === "string" ? { id: b.id } : {}), ...(agent ? { agent } : {}) });
      }
    }
    if (!parts.length) return null;
    const model = claudeModel(o);
    const effort = typeof o.effort === "string" ? o.effort : "";
    return { role: "assistant", parts, uuid: o.uuid, ...timeOf(o.timestamp), ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }
  return null;
}
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
function claudeModel(o: ClaudeLine): string {
  const m = o.message && o.message.model;
  return typeof m === "string" && m && m !== "<synthetic>" ? m : "";
}
function timeOf(t: unknown): { at?: string } {
  return typeof t === "string" && t ? { at: t } : {};
}
function parseCodexTranscript(o: CodexLine): TranscriptMessage | null {
  const p = o.payload;
  if (!p || typeof p !== "object") return null;
  const id = p.id;
  if (p.type === "message") {
    const role = p.role;
    if (role !== "user" && role !== "assistant") return null;
    const c = p.content;
    const text = isCodexBlocks(c)
      ? c.filter((b) => b && typeof b.text === "string").map((b) => (b as CodexBlock).text).join("\n\n").trim()
      : (typeof c === "string" ? c.trim() : "");
    if (!text) return null;
    if (role === "user" && isInjectedTranscriptContext(text)) return null;
    return role === "user"
      ? { role: "user", text, uuid: id, ...timeOf(o.timestamp) }
      : { role: "assistant", parts: [{ kind: "md", text }], uuid: id, ...timeOf(o.timestamp) };
  }
  if (p.type === "custom_tool_call" || p.type === "function_call") {
    const name = p.name || "tool";
    const hint = toolHint(p.input || p.arguments || "");
    const command = p.type === "custom_tool_call" && name === "exec" && typeof p.input === "string" ? p.input : "";
    return { role: "assistant", parts: [{ kind: "tool", name, hint, ...(command ? { command } : {}) }], uuid: id, ...timeOf(o.timestamp) };
  }
  return null;
}
function parseAgyTranscript(o: AgyLine): TranscriptMessage | null {
  const key = o.step_index != null ? ("agy-" + o.step_index) : null;
  if (!key) return null;
  if (o.type === "USER_INPUT") {
    let text = stringOf(o.content || "").replace(/<\/?USER_REQUEST>/g, "").trim();
    if (!text || isInjectedTranscriptContext(text)) return null;
    return { role: "user", text, uuid: key, ...timeOf(o.created_at) };
  }
  if (o.type === "PLANNER_RESPONSE") {
    const parts: TranscriptPart[] = [];
    const content = typeof o.content === "string" ? o.content.trim() : "";
    if (content) parts.push({ kind: "md", text: content });
    for (const tc of (o.tool_calls || [])) {
      const name = tc && tc.name ? tc.name : "tool";
      const args: unknown = tc && tc.args && typeof tc.args === "object" ? Object.values(tc.args)[0] : "";
      parts.push({ kind: "tool", name, hint: toolHint(stringOf(args || "").replace(/^"|"$/g, "")) });
    }
    return parts.length ? { role: "assistant", parts, uuid: key, ...timeOf(o.created_at) } : null;
  }
  return null;
}
function parseTranscriptRecord(line: string, backend: string, sidechain = false, results = false): TranscriptMessage | null {
  const s = line.trim();
  if (!s || s[0] !== "{") return null;
  let o: ClaudeLine & CodexLine & AgyLine;
  try { o = JSON.parse(s) as ClaudeLine & CodexLine & AgyLine; } catch { return null; }
  if (backend === "codex") return parseCodexTranscript(o);
  if (backend === "antigravity") return parseAgyTranscript(o);
  return parseClaudeTranscript(o, sidechain, results);
}

function mostCommon(tally: Map<string, number>): string {
  let best = "", n = 0;
  for (const [k, c] of tally) if (c > n) { best = k; n = c; }
  return best;
}
function count(n: unknown): number {
  const v = typeof n === "string" && /^\d+$/.test(n) ? Number(n) : n;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function readTranscript(raw: string, backend: string, sidechain = false): { msgs: TranscriptMessage[]; meta: TranscriptMeta } {
  const msgs: TranscriptMessage[] = [];
  const meta: TranscriptMeta = {};
  const models = new Map<string, number>(), efforts = new Map<string, number>();
  const tally = (model: string, effort: string) => {
    if (model) models.set(model, (models.get(model) || 0) + 1);
    if (effort) efforts.set(effort, (efforts.get(effort) || 0) + 1);
  };
  const replies = new Map<string, [number, number, number]>();
  let input = 0, cacheRead = 0, output = 0, counted = false;
  let codexModel = "", codexEffort = "";
  const toolTally: [string, string][] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s || s[0] !== "{") continue;
    let o: ClaudeLine & CodexLine & AgyLine;
    try { o = JSON.parse(s) as ClaudeLine & CodexLine & AgyLine; } catch { continue; }
    let m: TranscriptMessage | null;
    if (backend === "codex") {
      const p = o.payload;
      if (p && typeof p === "object") {
        if (o.type === "session_meta") {
          if (typeof p.cwd === "string" && p.cwd) meta.folder = p.cwd;
          if (typeof p.cli_version === "string" && p.cli_version) meta.cliVersion = p.cli_version;
        } else if (o.type === "turn_context") {
          codexModel = typeof p.model === "string" ? p.model : "";
          codexEffort = typeof p.effort === "string" ? p.effort : "";
        } else if (p.type === "token_count" && p.info && p.info.total_token_usage) {
          const u = p.info.total_token_usage;
          const cached = count(u.cached_input_tokens);
          input = Math.max(0, count(u.input_tokens) - cached); cacheRead = cached; output = count(u.output_tokens); counted = true;
        }
      }
      m = parseCodexTranscript(o);
      if (m && m.role === "assistant") {
        if (codexModel) m.model = codexModel;
        if (codexEffort) m.effort = codexEffort;
        if (m.parts.some((pt) => pt.kind === "md")) tally(codexModel, codexEffort);
        else toolTally.push([codexModel, codexEffort]);
      }
    } else if (backend === "antigravity") {
      if (o.input_tokens != null || o.output_tokens != null) {
        input += count(o.input_tokens); cacheRead += count(o.cache_read_tokens); output += count(o.output_tokens); counted = true;
      }
      m = parseAgyTranscript(o);
    } else {
      if (o.type === "assistant" && (sidechain || !o.isSidechain)) {
        if (typeof o.version === "string" && o.version) meta.cliVersion = o.version;
        if (!meta.folder && typeof o.cwd === "string" && o.cwd) meta.folder = o.cwd;
        const id = o.message && typeof o.message.id === "string" ? o.message.id : "";
        if (id) {
          if (!replies.has(id)) { replies.set(id, [0, 0, 0]); tally(claudeModel(o), typeof o.effort === "string" ? o.effort : ""); }
          const u = o.message && o.message.usage;
          if (u && typeof u === "object") {
            const r = replies.get(id) as [number, number, number]  ;
            r[0] = Math.max(r[0], count(u.input_tokens) + count(u.cache_creation_input_tokens));
            r[1] = Math.max(r[1], count(u.cache_read_input_tokens));
            r[2] = Math.max(r[2], count(u.output_tokens));
            counted = true;
          }
        }
      }
      m = parseClaudeTranscript(o, sidechain);
    }
    if (m && m.uuid) msgs.push(m);
  }
  for (const [i, c, o] of replies.values()) { input += i; cacheRead += c; output += o; }
  if (!models.size) for (const [mo, ef] of toolTally) tally(mo, ef);
  const times = msgs.map((m) => (m.role === "boundary" ? "" : localTime(m.at || ""))).filter(Boolean);
  if (times.length) { meta.started = times[0]; meta.ended = times[times.length - 1]; }
  const model = mostCommon(models), effort = mostCommon(efforts);
  if (model) meta.model = model;
  if (effort) meta.effort = effort;
  if (counted) { meta.inputTokens = input; meta.cacheReadTokens = cacheRead; meta.outputTokens = output; }
  return { msgs, meta };
}
function localTime(iso: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function metaProps(meta: TranscriptMeta | null | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!meta) return out;
  if (meta.started) out.started = meta.started;
  if (meta.ended) out.ended = meta.ended;
  if (meta.model) out.model = meta.model;
  if (meta.effort) out.effort = meta.effort;
  if (meta.inputTokens != null) out.input_tokens = meta.inputTokens;
  if (meta.cacheReadTokens != null) out.cache_read_tokens = meta.cacheReadTokens;
  if (meta.outputTokens != null) out.output_tokens = meta.outputTokens;
  if (meta.cliVersion) out.cli_version = meta.cliVersion;
  if (meta.folder) out.folder = meta.folder;
  return out;
}

const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:key|token|secret|pass|password|passwd|pwd)`;
const Q = String.raw`(?:\\?["'])`;
const SECRET_RES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, "[redacted]"],
  [new RegExp(String.raw`\b(${SECRET_NAME})(${Q}?\s*[=:]\s*)(${Q})(?:(?!\3).){4,}?\3`, "gi"), "$1$2$3[redacted]$3"],
  [new RegExp(String.raw`\b(${SECRET_NAME})(\s*=\s*)[^\s"'\\]{4,}`, "gi"), "$1$2[redacted]"],
  [new RegExp(String.raw`(--${SECRET_NAME})(=|\s+)(${Q}?)[^\s"'\\]{4,}\3`, "gi"), "$1$2$3[redacted]$3"],
  [/\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-[A-Za-z-]*(?:Auth|Token|Key)[A-Za-z-]*)(:\s*)[^"'\n\\]+/gi, "$1$2[redacted]"],
  [/\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{12,}/g, "$1$2[redacted]"],
  [/(\/\/[^\s:/@]+:)[^\s@/]+@/g, "$1[redacted]@"],
  [/((?:^|\s)(?:-u|--user)\s+[^\s:]+:)\S+/g, "$1[redacted]"],
  [/(\b(?:sshpass|mysql)\b[^\n]*?\s-p)\s*\S+/g, "$1 [redacted]"],
  [/\bhf_[A-Za-z0-9]{12,}/g, "[redacted]"],
  [/(hooks\.slack\.com\/services\/)\S+/g, "$1[redacted]"],
  [/(api\.telegram\.org\/bot)[^\s/]+/g, "$1[redacted]"],
];
function maskSecrets(text: string): string {
  let out = blankTokens(text);
  for (const [re, to] of SECRET_RES) out = out.replace(re, to);
  return out;
}
const COMMAND_LINES = 40, COMMAND_CHARS = 4000;
const COMMAND_CALLOUT = "agent-manager-command";
function commandCallout(title: string, command: string): string {
  const masked = maskSecrets(command.replace(/\s+$/, ""));
  let lines = masked.slice(0, COMMAND_CHARS).split("\n");
  const total = masked.split("\n").length;
  if (lines.length > COMMAND_LINES) lines = lines.slice(0, COMMAND_LINES);
  const kept = lines.join("\n").length;
  if (kept < masked.length) lines.push(lines.length < total ? `… ${total - lines.length} more lines` : `… ${masked.length - kept} more characters`);
  const body = lines.join("\n");
  let longest = 0;
  for (const run of body.match(/`+/g) || []) if (run.length > longest) longest = run.length;
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`> [!${COMMAND_CALLOUT}]- ⏺ ` + title, "> " + fence, ...lines.map((l) => "> " + l), "> " + fence].join("\n");
}
interface Decoration {
  time?: string;
  mark?: string;
  commands?: boolean;
}
function transcriptMessageToMarkdown(m: TranscriptMessage, deco: Decoration = {}): string {
  if (m.role === "boundary") return "---\n\n*· context compacted here ·*\n";
  if (m.role === "user") {
    let longest = 0;
    for (const run of m.text.match(/`+/g) || []) if (run.length > longest) longest = run.length;
    const fence = "`".repeat(Math.max(3, longest + 1));
    return "**You:**" + (deco.time ? " · " + deco.time : "") + "\n\n" + fence + "\n" + m.text + "\n" + fence + "\n";
  }
  const out: string[] = [];
  if (deco.mark) out.push("_" + deco.mark + "_");
  for (const p of m.parts) {
    if (p.kind === "md") { out.push(p.text.trim()); continue; }
    if (p.kind !== "tool") continue;
    const title = p.hint ? (p.name + " · " + p.hint) : p.name;
    out.push(deco.commands && p.command && p.command.trim() ? commandCallout(title, p.command) : "_⏺ " + title + "_");
  }
  return out.join("\n\n") + "\n";
}
function decorations(msgs: TranscriptMessage[], commands: boolean): Decoration[] {
  let lastDay = "", lastMark = "";
  return msgs.map((m) => {
    const deco: Decoration = { commands };
    if (m.role === "user") {
      const t = localTime(m.at || "");
      if (t) {
        const [day, hm] = t.split("T");
        deco.time = lastDay && lastDay !== day ? `${day} ${hm}` : hm;
        lastDay = day;
      }
    } else if (m.role === "assistant" && m.model) {
      const mark = m.effort ? `${m.model} · ${m.effort}` : m.model;
      if (mark !== lastMark) deco.mark = mark;
      lastMark = mark;
    }
    return deco;
  });
}
function sanitizeTranscriptName(name: string | null | undefined): string {
  return String(name || "")
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\.+$/, "")
    .trim()
    .slice(0, 120) || "Untitled";
}
const GENERATED_BY = "agent-manager (append-only transcript; new turns append below, and the properties are kept current)";
function transcriptHeader(title: string | null | undefined, sessionId: string | null | undefined, backend: string | null | undefined, source: string | null = null, agent: string | null = null, meta: TranscriptMeta | null = null): string {
  const t = title || "Untitled session";
  return [
    "---",
    "session: " + JSON.stringify(t),
    "session_id: " + JSON.stringify(sessionId || ""),
    "backend: " + (backend || ""),
    ...(source ? ["source: " + JSON.stringify(source)] : []),
    ...(agent ? ["agent: " + JSON.stringify(agent)] : []),
    ...Object.entries(metaProps(meta)).map(([k, v]) => k + ": " + JSON.stringify(v)),
    "generated_by: " + GENERATED_BY,
    "---",
    "",
    "# " + t,
    "",
  ].join("\n");
}
function deriveSessionId(file: string, backend: string): string {
  if (backend === "antigravity" && file.includes("/brain/")) return file.split("/brain/")[1].split("/")[0];
  const base = path.basename(file, ".jsonl");
  const m = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : base;
}
function transcriptLockKey(lockDir: string, sessionId: string): string {
  return lockDir + "\n" + noteIdKey(sessionId);
}
function noteIdKey(sessionId: string | null | undefined, long = false): string {
  const id = String(sessionId || "");
  return long ? id.slice(0, 8) + "-" + id.slice(-4) : id.slice(0, 8);
}
function transcriptBasename(sessionId: string, title: string | null | undefined, long = false): string {
  return sanitizeTranscriptName(title || "Untitled") + " (" + noteIdKey(sessionId, long) + ")";
}
function noteSessionId(text: string | null | undefined): string | null {
  const fm = String(text || "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const m = fm[1].match(/^session_id:\s*["']?([^"'\r\n]*)["']?\s*$/m);
  return m && m[1] ? m[1] : null;
}
const LAUNCH_PROMPT_RE = /^(Session start\.|\$[a-z]|\/[a-z])|This session is named "/;
function firstHumanSnippet(rawText: string | null | undefined, backend: string): string {
  for (const line of String(rawText || "").split("\n")) {
    const rec = parseTranscriptRecord(line, backend);
    if (rec && rec.role === "user" && rec.text && !LAUNCH_PROMPT_RE.test(String(rec.text).trim())) {
      return rec.text.replace(/\s+/g, " ").slice(0, 64);
    }
  }
  return "";
}
const CONTINUATION_SUFFIX_RE = / \(\d+\)$/;
function stripContinuationSuffix<T>(title: T): T | string {
  return typeof title === "string" ? title.replace(CONTINUATION_SUFFIX_RE, "") : title;
}
function isCompactionContinuation(headText: string | null | undefined): boolean {
  for (const line of String(headText || "").split("\n")) {
    if (line.indexOf('"type":"user"') === -1) continue;
    let o: ClaudeLine | null;
    try { o = JSON.parse(line) as ClaudeLine | null; } catch { continue; }
    if (!o || o.type !== "user") continue;
    return o.isCompactSummary === true;
  }
  return false;
}
function recordedTitle(rawText: string | null | undefined): string | null {
  const text = String(rawText || "");
  for (const line of text.split("\n")) {
    if (!line.includes('"custom-title"')) continue;
    try {
      const o = JSON.parse(line) as ClaudeLine | null;
      if (o && o.type === "custom-title" && typeof o.customTitle === "string" && o.customTitle.trim()) {
        const t = o.customTitle.trim();
        return isCompactionContinuation(text) ? stripContinuationSuffix(t) : t;
      }
    } catch { /* empty */ }
  }
  return null;
}
function deriveTitle(rawText: string | null | undefined, backend: string): string {
  const recorded = recordedTitle(rawText);
  if (recorded) return recorded;
  const human = firstHumanSnippet(rawText, backend);
  return human ? human.slice(0, 48).trim() : "session";
}

function frontmatterValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return out;
  for (const line of fm[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"')) { try { v = String(JSON.parse(v)); } catch { /* empty */ } }
    else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
    out[m[1]] = v;
  }
  return out;
}

const transcriptLocks = new Map<string, Promise<void>>();
async function withTranscriptLock<T>(relPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = transcriptLocks.get(relPath) || Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const chained = prev.then(() => mine);
  transcriptLocks.set(relPath, chained);
  await prev;
  try { return await fn(); }
  finally {
    release();
    if (transcriptLocks.get(relPath) === chained) transcriptLocks.delete(relPath);
  }
}

async function findNoteFor(io: TranscriptIO, dir: string, names: string[] | null | undefined, fullId: string): Promise<string | null> {
  const short = "(" + noteIdKey(fullId) + ").md", long = "(" + noteIdKey(fullId, true) + ").md";
  for (const n of names || []) {
    if (!n.endsWith(short) && !n.endsWith(long)) continue;
    let text = "";
    try { text = await io.read(dir + "/" + n); } catch { continue; }
    if (noteSessionId(text) === fullId) return dir + "/" + n;
  }
  return null;
}

async function writeDurableTranscript(io: TranscriptIO, opts: TranscriptWriteOptions): Promise<TranscriptWrite | null> {
  const { backend, sessionTitle, sessionId, transcriptFile } = opts;
  const dir = opts.transcriptDir || TRANSCRIPT_DIR;
  if (!["claude", "codex", "antigravity"].includes(backend)) return null;
  if (!transcriptFile) return null;
  let raw: string;
  try { raw = fs.readFileSync(transcriptFile, "utf8"); } catch { return null; }
  const { msgs, meta } = readTranscript(raw, backend, !!opts.sidechain);
  if (!msgs.length) return null;
  const decos = decorations(msgs, !!opts.commands);
  const fullId = String(sessionId || deriveSessionId(transcriptFile, backend));
  const title = sessionTitle || deriveTitle(raw, backend);
  return withTranscriptLock(transcriptLockKey(opts.lockDir || dir, fullId), async () => {
    let names: string[] = [];
    try { names = (await io.list(dir)) || []; } catch { /* empty */ }
    let relPath: string | null = null;
    const existing = opts.findExisting?.() || null;
    if (existing && await io.exists(existing)) {
      try { if (noteSessionId(await io.read(existing)) === fullId) relPath = existing; } catch { /* empty */ }
    }
    if (!relPath) relPath = await findNoteFor(io, dir, names, fullId);
    const seen = new Set<string | undefined>();
    const made = !relPath;
    let had: Record<string, string> = {};
    if (relPath) {
      const existing = await io.read(relPath);
      had = frontmatterValues(existing);
      const re = /<!--\s*pl-rec:([^\s>]+)\s*-->/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(existing)) !== null) seen.add(mm[1]);
    } else {
      const shortTaken = names.some((n) => n.endsWith("(" + noteIdKey(fullId) + ").md"));
      relPath = dir + "/" + transcriptBasename(fullId, title, shortTaken) + ".md";
      if (await io.exists(relPath)) relPath = dir + "/" + transcriptBasename(fullId, title + " " + fullId.slice(-4), shortTaken) + ".md";
      await io.ensureDir(dir);
      await io.create(relPath, transcriptHeader(title, fullId, backend, opts.source || null, opts.agent || null, meta));
    }
    let addition = "";
    let added = 0;
    msgs.forEach((m, i) => {
      if (seen.has(m.uuid)) return;
      seen.add(m.uuid);
      added++;
      addition += "\n<!-- pl-rec:" + m.uuid + " -->\n" + transcriptMessageToMarkdown(m, decos[i]) + "\n";
    });
    if (addition) await io.append(relPath, addition);
    if (!made && io.setProps) {
      const props: Record<string, string | number> = { ...metaProps(meta), generated_by: GENERATED_BY };
      if (had.started) delete props.started;
      if (Object.entries(props).some(([k, v]) => had[k] !== String(v))) {
        try { await io.setProps(relPath, props); } catch { /* empty */ }
      }
    }
    return { added, path: relPath };
  });
}

export {
  TRANSCRIPT_DIR,
  parseTranscriptRecord,
  readTranscript,
  metaProps,
  maskSecrets,
  GENERATED_BY,
  transcriptMessageToMarkdown,
  sanitizeTranscriptName,
  transcriptHeader,
  transcriptBasename,
  noteIdKey,
  transcriptLockKey,
  noteSessionId,
  withTranscriptLock,
  deriveSessionId,
  firstHumanSnippet,
  recordedTitle,
  isCompactionContinuation,
  stripContinuationSuffix,
  deriveTitle,
  writeDurableTranscript,
};
