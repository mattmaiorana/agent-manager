// Reading the CLIs' transcript files: heads, tails, timestamps, and the model a session used.

import { fs } from "../externals.js";
import { stringOf } from "../util/guards.js";

// A line of a transcript, parsed: whatever JSON it held. Every field is checked before
// it's used, and a line that parses to null throws where it's read, inside a try.
interface TranscriptLine {
  type?: unknown;
  timestamp?: unknown;
  message?: { model?: unknown } | null;
  payload?: {
    model?: unknown;
    reasoning_effort?: unknown;
    thread_settings?: { model?: unknown; reasoning_effort?: unknown } | null;
    source?: { subagent?: unknown } | null;
  } | null;
}
type AnyLine = TranscriptLine | null | undefined;
// The model a transcript records, and the reasoning effort beside it when there is one.
interface ModelInfo {
  model: string;
  effort?: string;
}
// Codex writes automatic reviewers and delegated agents as rollout JSONL files
// beside normal CLI sessions. They inherit the parent session id and can inherit
// its naming marker, but they are not independently resumable user sessions.
// Any value read from a file: each step is optional, so a missing field reads undefined.
function isCodexSubagentSessionMeta(record: unknown): boolean {
  return (record as AnyLine)?.type === "session_meta" && (record as AnyLine)?.payload?.source?.subagent != null;
}
// The `brain/<uuid>/` conversation directory an Antigravity transcript path lives
// under, or null if the path isn't of that exact shape (a uuid-named dir directly
// under `antigravity-cli/brain/`). The delete path removes this directory.
function antigravityBrainDir(file: string | null | undefined): string | null {
  const m = String(file || "").match(/^(.*\/antigravity-cli\/brain\/[0-9a-f-]{16,})\/\.system_generated\/logs\/transcript\.jsonl$/i);
  return m ? m[1] : null;
}
// The first or last `n` bytes of a file as text (the whole file when it is smaller).
// A transcript's name and id are at its head and its latest records at its tail, so
// nothing here needs to read a multi-megabyte transcript whole.
function readFileSlice(file: string, n: number, fromEnd: boolean): string {
  const size = fs.statSync(file).size;
  if (size <= n) return fs.readFileSync(file, "utf8");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, fromEnd ? size - n : 0);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
const readFileHead = (file: string, n: number): string => readFileSlice(file, n, false);
const readFileTail = (file: string, n: number): string => readFileSlice(file, n, true);
// The timestamp of a Claude transcript's last real message (user or assistant), from
// its tail. Bookkeeping records (Remote Control's bridge status, cost state) carry no
// conversation, so they don't count. 64KB first; if that window holds no complete
// message record (the last record can be a large tool result or a big paste),
// retry at 1MB rather than return 0, which reads as "older than everything".
function lastMessageTsOf(file: string): number {
  for (const n of [65536, 1048576]) {
    let raw = "";
    try { raw = readFileTail(file, n); } catch { return 0; }
    let ts = 0, sawMessage = false;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      // A line of `null` throws below, as it always has (the callers catch it).
      let o: TranscriptLine;
      try { o = JSON.parse(line) as TranscriptLine; } catch { continue; } // a cut first line
      if ((o.type === "user" || o.type === "assistant") && o.timestamp) {
        sawMessage = true;
        const t = Date.parse(stringOf(o.timestamp));
        if (t > ts) ts = t;
      }
    }
    if (sawMessage || raw.length < n) return ts; // found one, or the whole file fit
  }
  return 0;
}
// The first JSONL record of a file, or null. Codex session metadata is its first line.
function readJsonlFirstRecord(file: string, maxBytes = 262144): unknown {
  try {
    const text = readFileHead(file, maxBytes);
    const newline = text.indexOf("\n");
    return JSON.parse(newline === -1 ? text : text.slice(0, newline)) as unknown;
  } catch {
    return null;
  }
}
// Prettify a model id for the strip badge: "claude-opus-4-8" -> "Opus 4.8",
// "claude-haiku-4-5-20251001" -> "Haiku 4.5". Non-Claude ids (e.g. Codex's
// "gpt-5.6-sol") are already short, so they're shown as-is; the full id is the hover.
function prettyModelName(id: string | null | undefined): string {
  if (!id) return "";
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/i);
  if (m) {
    const fam = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    return `${fam} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`;
  }
  return id;
}
// Last value of a JSON string field ("<key>":"<value>") in a chunk of JSONL text.
// Reads the current model/effort from a transcript tail (last record wins).
function lastJsonStringValue(text: string, key: string): string | null {
  const re = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, "g");
  let m: RegExpExecArray | null, last: string | null = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  return last;
}
// Current model from a transcript tail: parse JSONL lines from the end and read
// the model from each backend's KNOWN record path —
// Claude: assistant records' message.model; Codex: payload.model or
// payload.thread_settings.model, with reasoning_effort beside it. The raw
// last-"model"-string regex above is kept only as the fallback for unknown
// backends or shifted formats: conversation CONTENT can echo "model" fields (a
// tool call's input echoed into an assistant record put a "model" value into a
// real transcript), so a structural path must win when it matches.
function modelFromTranscriptTail(tail: string, backendKey: string, loose = true): ModelInfo | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line[0] !== "{") continue; // the tail's first line is usually a cut-off partial record
    let o: TranscriptLine | null;
    try { o = JSON.parse(line) as TranscriptLine | null; } catch { continue; }
    if (backendKey === "claude") {
      if (o && o.type === "assistant" && o.message && typeof o.message.model === "string") {
        return { model: o.message.model };
      }
    } else if (backendKey === "codex") {
      const p = o && o.payload;
      const ts = p && p.thread_settings;
      const m = p && typeof p.model === "string" ? p.model
        : ts && typeof ts.model === "string" ? ts.model : null;
      if (m) {
        // Effort isn't always on the same record as the model (turn_context
        // carries model alone; effort lives in thread_settings elsewhere), so
        // fall back to the last effort string anywhere in the tail.
        const eff = p && typeof p.reasoning_effort === "string" ? p.reasoning_effort
          : ts && typeof ts.reasoning_effort === "string" ? ts.reasoning_effort
          : lastJsonStringValue(tail, "reasoning_effort");
        return eff ? { model: m, effort: eff } : { model: m };
      }
    }
  }
  if (!loose) return null;
  const model = lastJsonStringValue(tail, "model");
  if (!model) return null;
  const effort = lastJsonStringValue(tail, "reasoning_effort");
  return effort ? { model, effort } : { model };
}
export type { ModelInfo, TranscriptLine };
export { antigravityBrainDir, isCodexSubagentSessionMeta, lastMessageTsOf, modelFromTranscriptTail, prettyModelName, readFileHead, readFileTail, readJsonlFirstRecord };
