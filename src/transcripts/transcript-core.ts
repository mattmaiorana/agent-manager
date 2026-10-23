// The transcript writer: parses each CLI's transcript records and appends the ones not
// yet written to a note in the vault. Append-only: each record carries a hidden
// <!-- pl-rec:KEY --> marker, and a write only ever adds records whose key isn't in the
// note yet, so nothing the CLI later deletes or rewrites changes what is already saved.
// The vault I/O is passed in (an adapter), so this module touches no vault API itself,
// and Node can import it alone (scripts/test-transcript-core.mjs).
import * as fs from "fs";
import * as path from "path";
import { stringOf } from "../util/guards.js";
import type { TranscriptIO, TranscriptMessage, TranscriptPart, TranscriptWrite, TranscriptWriteOptions } from "../types.js";

const TRANSCRIPT_DIR = "Agent Transcripts";

// One line of a CLI's transcript, as each CLI writes it, read with JSON.parse. Every field
// is optional; one the code checks before use is unknown, and one it uses as the CLI
// writes it has that type.
// A Claude tool call's input: the fields a hint is made from.
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
// A block of a Claude message's content.
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
// A Codex message's content block: its text is checked before use.
interface CodexBlock {
  text?: unknown;
}

// ---- parsing (per backend) ----
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
// A message's content as an array: Array.isArray, typed as the blocks each CLI writes.
function isBlocks(c: unknown): c is (ClaudeBlock | null)[] {
  return Array.isArray(c);
}
function isCodexBlocks(c: unknown): c is (CodexBlock | null)[] {
  return Array.isArray(c);
}
function parseClaudeTranscript(o: ClaudeLine): TranscriptMessage | null {
  if (o.isSidechain) return null;
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
      // The filter dropped the null blocks.
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
      // The filter dropped the null blocks.
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
function parseTranscriptRecord(line: string, backend: string): TranscriptMessage | null {
  const s = line.trim();
  if (!s || s[0] !== "{") return null;
  // A line that starts with "{" parses to an object or throws, so it is one of these.
  let o: ClaudeLine & CodexLine & AgyLine;
  try { o = JSON.parse(s) as ClaudeLine & CodexLine & AgyLine; } catch { return null; }
  if (backend === "codex") return parseCodexTranscript(o);
  if (backend === "antigravity") return parseAgyTranscript(o);
  return parseClaudeTranscript(o);
}

// ---- formatting ----
function transcriptMessageToMarkdown(m: TranscriptMessage): string {
  if (m.role === "boundary") return "---\n\n*· context compacted here ·*\n";
  if (m.role === "user") {
    // The fence must be longer than any backtick run in the text, or a run of
    // that length inside the message closes the block early (a line of four
    // backticks did, against the old fixed "````" fallback).
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
// `source`: a link to the note the session was started from (a wikilink, written as
// given), or nothing.
function transcriptHeader(title: string | null | undefined, sessionId: string | null | undefined, backend: string | null | undefined, source: string | null = null): string {
  const t = title || "Untitled session";
  return [
    "---",
    "session: " + JSON.stringify(t),
    "session_id: " + JSON.stringify(sessionId || ""),
    "backend: " + (backend || ""),
    ...(source ? ["source: " + JSON.stringify(source)] : []),
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
// The id part of a note's name: the first eight characters of the session id, or with
// `long`, those and the last four. Codex ids are time-ordered, so two Codex sessions
// started within a minute or so share their first eight; the second one's note then
// takes the long form.
function noteIdKey(sessionId: string | null | undefined, long = false): string {
  const id = String(sessionId || "");
  return long ? id.slice(0, 8) + "-" + id.slice(-4) : id.slice(0, 8);
}
function transcriptBasename(sessionId: string, title: string | null | undefined, long = false): string {
  return sanitizeTranscriptName(title || "Untitled") + " (" + noteIdKey(sessionId, long) + ")";
}
// The session id a transcript note's frontmatter records, or null.
// Read from the frontmatter block only, quoted either way or not at all.
function noteSessionId(text: string | null | undefined): string | null {
  const fm = String(text || "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const m = fm[1].match(/^session_id:\s*["']?([^"'\r\n]*)["']?\s*$/m);
  return m && m[1] ? m[1] : null;
}
// Launch prompts the plugin itself sends as a session's first user message: they can't
// label or tell sessions apart.
const LAUNCH_PROMPT_RE = /^(Session start\.|\$[a-z]|\/[a-z])|This session is named "/;
// First user message a HUMAN typed, skipping the plugin's launch prompts. The fallback
// label for a session with no title record.
function firstHumanSnippet(rawText: string | null | undefined, backend: string): string {
  for (const line of String(rawText || "").split("\n")) {
    const rec = parseTranscriptRecord(line, backend);
    if (rec && rec.role === "user" && rec.text && !LAUNCH_PROMPT_RE.test(String(rec.text).trim())) {
      return rec.text.replace(/\s+/g, " ").slice(0, 64);
    }
  }
  return "";
}
// Claude's " (N)" suffix on a compaction continuation's title. Stripped ONLY when the
// file proves it is a continuation (isCompactionContinuation below): a title can end in
// " (digits)" for its own reasons ("Planning (2026)"), and a bare regex would rename
// that session so nothing could find its transcript.
const CONTINUATION_SUFFIX_RE = / \(\d+\)$/;
function stripContinuationSuffix<T>(title: T): T | string {
  return typeof title === "string" ? title.replace(CONTINUATION_SUFFIX_RE, "") : title;
}
// Is this Claude transcript (its head text) a compaction continuation? When Claude
// compacts a session's context into a NEW file, that file's FIRST user record is the
// compaction summary, flagged `isCompactSummary: true` ("This session is being
// continued from a previous conversation..."). An in-place compaction appends its summary AFTER real turns, so the first user
// record test cannot match it. Only the head is needed: the first user record sits
// within the first few KB.
function isCompactionContinuation(headText: string | null | undefined): boolean {
  for (const line of String(headText || "").split("\n")) {
    if (line.indexOf('"type":"user"') === -1) continue;
    // Any JSON value: each field read is checked, and a primitive's reads undefined.
    let o: ClaudeLine | null;
    try { o = JSON.parse(line) as ClaudeLine | null; } catch { continue; }
    if (!o || o.type !== "user") continue;
    return o.isCompactSummary === true;
  }
  return false;
}
// The session's own title record if the CLI wrote one (Claude's first custom-title,
// at the head; the first, to match the readers and survive Claude's auto-retitle).
// A continuation's title drops its " (N)" so its note files under the parent's name.
function recordedTitle(rawText: string | null | undefined): string | null {
  const text = String(rawText || "");
  for (const line of text.split("\n")) {
    if (!line.includes('"custom-title"')) continue;
    try {
      // Any JSON value: each field read is checked, and a primitive's reads undefined.
      const o = JSON.parse(line) as ClaudeLine | null;
      if (o && o.type === "custom-title" && typeof o.customTitle === "string" && o.customTitle.trim()) {
        const t = o.customTitle.trim();
        return isCompactionContinuation(text) ? stripContinuationSuffix(t) : t;
      }
    } catch { /* best effort */ }
  }
  return null;
}
// Title for a note written without one (an import). Prefer the CLI's own title record;
// else the first HUMAN message, truncated, never the launch prompt; else "session".
function deriveTitle(rawText: string | null | undefined, backend: string): string {
  const recorded = recordedTitle(rawText);
  if (recorded) return recorded;
  const human = firstHumanSnippet(rawText, backend);
  return human ? human.slice(0, 48).trim() : "session";
}

// ---- atomicity: one write per note at a time, in this process. A capture from the
// status poll and one from a tab closing can overlap; the second waits for the first.
const transcriptLocks = new Map<string, Promise<void>>();
async function withTranscriptLock<T>(relPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = transcriptLocks.get(relPath) || Promise.resolve();
  // Set by the promise's executor, which runs before the next line.
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

// The note in `dir` that belongs to session `fullId`, by the id its frontmatter records,
// or null. `names` is the folder's file names.
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

// ---- THE writer. io is an adapter: { exists, read, create, append, ensureDir, list }
// (all async, vault-relative paths). `opts.source`, a link to the note the session was
// started from, goes into a new note's frontmatter. Append-only, keyed by pl-rec:<uuid> markers: only
// ever ADDS records not already present. Returns { added, path }.
async function writeDurableTranscript(io: TranscriptIO, opts: TranscriptWriteOptions): Promise<TranscriptWrite | null> {
  const { backend, sessionTitle, sessionId, transcriptFile } = opts;
  const dir = opts.transcriptDir || TRANSCRIPT_DIR;
  if (!["claude", "codex", "antigravity"].includes(backend)) return null;
  if (!transcriptFile) return null;
  let raw: string;
  try { raw = fs.readFileSync(transcriptFile, "utf8"); } catch { return null; }
  const msgs: TranscriptMessage[] = [];
  for (const line of raw.split("\n")) {
    const m = parseTranscriptRecord(line, backend);
    if (m && m.uuid) msgs.push(m);
  }
  if (!msgs.length) return null;
  const fullId = String(sessionId || deriveSessionId(transcriptFile, backend));
  const title = sessionTitle || deriveTitle(raw, backend);
  // One note per session id, found by the id in its frontmatter, whatever its title.
  // Locked by the folder and the id's short key, not the full id: two sessions whose ids
  // share their first eight characters would otherwise both find no note and pick one
  // name for it.
  return withTranscriptLock(dir + "\n" + noteIdKey(fullId), async () => {
    let names: string[] = [];
    try { names = (await io.list(dir)) || []; } catch { /* best effort */ }
    let relPath = await findNoteFor(io, dir, names, fullId);
    const seen = new Set<string | undefined>();
    if (relPath) {
      const existing = await io.read(relPath);
      const re = /<!--\s*pl-rec:([^\s>]+)\s*-->/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(existing)) !== null) seen.add(mm[1]);
    } else {
      // A new note. Its short id is taken when another session's note already ends in it.
      const shortTaken = names.some((n) => n.endsWith("(" + noteIdKey(fullId) + ").md"));
      relPath = dir + "/" + transcriptBasename(fullId, title, shortTaken) + ".md";
      // Never over a note that's there (one of another session, named alike).
      if (await io.exists(relPath)) relPath = dir + "/" + transcriptBasename(fullId, title + " " + fullId.slice(-4), shortTaken) + ".md";
      await io.ensureDir(dir);
      await io.create(relPath, transcriptHeader(title, fullId, backend, opts.source || null));
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
