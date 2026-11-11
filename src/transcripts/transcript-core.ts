import * as fs from "fs";
import * as path from "path";
import { stringOf } from "../util/guards.js";
import type { TranscriptIO, TranscriptMessage, TranscriptPart, TranscriptWrite, TranscriptWriteOptions } from "../types.js";

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
}
interface ClaudeBlock {
  type?: unknown;
  text?: string;
  name?: string;
  input?: ToolInput | null;
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
  message?: { content?: unknown } | null;
  customTitle?: unknown;
}
interface CodexLine {
  payload?: {
    id?: string;
    type?: unknown;
    role?: unknown;
    content?: unknown;
    name?: string;
    input?: unknown;
    arguments?: unknown;
  } | null;
}
interface AgyLine {
  step_index?: number | string | null;
  type?: unknown;
  content?: unknown;
  tool_calls?: ({ name?: string; args?: unknown } | null)[];
}
interface CodexBlock {
  text?: unknown;
}

function transcriptToolHint(b: ClaudeBlock): string {
  const i: ToolInput = b.input || {};
  const raw = i.description || i.command || i.file_path || i.path || i.pattern || i.query || i.url || i.prompt || "";
  const first = stringOf(raw).split("\n")[0];
  return first.length > 90 ? first.slice(0, 90) + "…" : first;
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
function parseClaudeTranscript(o: ClaudeLine, sidechain = false): TranscriptMessage | null {
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
      if (c.length && c.every((b) => b && b.type === "tool_result")) return null;
      text = c.filter((b) => b && b.type === "text").map((b) => (b as ClaudeBlock).text).join("\n\n");
    }
    text = (text || "").trim();
    return text ? { role: "user", text, uuid: o.uuid } : null;
  }
  if (o.type === "assistant") {
    const c = o.message && o.message.content;
    if (!isBlocks(c)) return null;
    const parts: TranscriptPart[] = [];
    for (const b of c) {
      if (b && b.type === "text" && b.text && b.text.trim()) parts.push({ kind: "md", text: b.text });
      else if (b && b.type === "tool_use") parts.push({ kind: "tool", name: b.name || "tool", hint: transcriptToolHint(b) });
    }
    return parts.length ? { role: "assistant", parts, uuid: o.uuid } : null;
  }
  return null;
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
      ? { role: "user", text, uuid: id }
      : { role: "assistant", parts: [{ kind: "md", text }], uuid: id };
  }
  if (p.type === "custom_tool_call" || p.type === "function_call") {
    const name = p.name || "tool";
    const first = stringOf(p.input || p.arguments || "").split("\n")[0];
    const hint = first.length > 90 ? first.slice(0, 90) + "…" : first;
    return { role: "assistant", parts: [{ kind: "tool", name, hint }], uuid: id };
  }
  return null;
}
function parseAgyTranscript(o: AgyLine): TranscriptMessage | null {
  const key = o.step_index != null ? ("agy-" + o.step_index) : null;
  if (!key) return null;
  if (o.type === "USER_INPUT") {
    let text = stringOf(o.content || "").replace(/<\/?USER_REQUEST>/g, "").trim();
    if (!text || isInjectedTranscriptContext(text)) return null;
    return { role: "user", text, uuid: key };
  }
  if (o.type === "PLANNER_RESPONSE") {
    const parts: TranscriptPart[] = [];
    const content = typeof o.content === "string" ? o.content.trim() : "";
    if (content) parts.push({ kind: "md", text: content });
    for (const tc of (o.tool_calls || [])) {
      const name = tc && tc.name ? tc.name : "tool";
      const args: unknown = tc && tc.args && typeof tc.args === "object" ? Object.values(tc.args)[0] : "";
      const first = stringOf(args || "").replace(/^"|"$/g, "").split("\n")[0];
      const hint = first.length > 90 ? first.slice(0, 90) + "…" : first;
      parts.push({ kind: "tool", name, hint });
    }
    return parts.length ? { role: "assistant", parts, uuid: key } : null;
  }
  return null;
}
function parseTranscriptRecord(line: string, backend: string, sidechain = false): TranscriptMessage | null {
  const s = line.trim();
  if (!s || s[0] !== "{") return null;
  let o: ClaudeLine & CodexLine & AgyLine;
  try { o = JSON.parse(s) as ClaudeLine & CodexLine & AgyLine; } catch { return null; }
  if (backend === "codex") return parseCodexTranscript(o);
  if (backend === "antigravity") return parseAgyTranscript(o);
  return parseClaudeTranscript(o, sidechain);
}

function transcriptMessageToMarkdown(m: TranscriptMessage): string {
  if (m.role === "boundary") return "---\n\n*· context compacted here ·*\n";
  if (m.role === "user") {
    let longest = 0;
    for (const run of m.text.match(/`+/g) || []) if (run.length > longest) longest = run.length;
    const fence = "`".repeat(Math.max(3, longest + 1));
    return "**You:**\n\n" + fence + "\n" + m.text + "\n" + fence + "\n";
  }
  const out: string[] = [];
  for (const p of m.parts) {
    if (p.kind === "md") out.push(p.text.trim());
    else out.push("_⏺ " + (p.hint ? (p.name + " · " + p.hint) : p.name) + "_");
  }
  return out.join("\n\n") + "\n";
}
function sanitizeTranscriptName(name: string | null | undefined): string {
  return String(name || "")
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\.+$/, "")
    .trim()
    .slice(0, 120) || "Untitled";
}
function transcriptHeader(title: string | null | undefined, sessionId: string | null | undefined, backend: string | null | undefined, source: string | null = null, agent: string | null = null): string {
  const t = title || "Untitled session";
  return [
    "---",
    "session: " + JSON.stringify(t),
    "session_id: " + JSON.stringify(sessionId || ""),
    "backend: " + (backend || ""),
    ...(source ? ["source: " + JSON.stringify(source)] : []),
    ...(agent ? ["agent: " + JSON.stringify(agent)] : []),
    "generated_by: agent-manager (append-only transcript; new turns append below, existing content is never rewritten)",
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
  const msgs: TranscriptMessage[] = [];
  for (const line of raw.split("\n")) {
    const m = parseTranscriptRecord(line, backend, !!opts.sidechain);
    if (m && m.uuid) msgs.push(m);
  }
  if (!msgs.length) return null;
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
    if (relPath) {
      const existing = await io.read(relPath);
      const re = /<!--\s*pl-rec:([^\s>]+)\s*-->/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(existing)) !== null) seen.add(mm[1]);
    } else {
      const shortTaken = names.some((n) => n.endsWith("(" + noteIdKey(fullId) + ").md"));
      relPath = dir + "/" + transcriptBasename(fullId, title, shortTaken) + ".md";
      if (await io.exists(relPath)) relPath = dir + "/" + transcriptBasename(fullId, title + " " + fullId.slice(-4), shortTaken) + ".md";
      await io.ensureDir(dir);
      await io.create(relPath, transcriptHeader(title, fullId, backend, opts.source || null, opts.agent || null));
    }
    let addition = "";
    let added = 0;
    for (const m of msgs) {
      if (seen.has(m.uuid)) continue;
      seen.add(m.uuid);
      added++;
      addition += "\n<!-- pl-rec:" + m.uuid + " -->\n" + transcriptMessageToMarkdown(m) + "\n";
    }
    if (addition) await io.append(relPath, addition);
    return { added, path: relPath };
  });
}

export {
  TRANSCRIPT_DIR,
  parseTranscriptRecord,
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
