
import { fs } from "../externals.js";
import { stringOf } from "../util/guards.js";

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
interface ModelInfo {
  model: string;
  effort?: string;
}
function isCodexSubagentSessionMeta(record: unknown): boolean {
  return (record as AnyLine)?.type === "session_meta" && (record as AnyLine)?.payload?.source?.subagent != null;
}
function antigravityBrainDir(file: string | null | undefined): string | null {
  const m = String(file || "").match(/^(.*\/antigravity-cli\/brain\/[0-9a-f-]{16,})\/\.system_generated\/logs\/transcript\.jsonl$/i);
  return m ? m[1] : null;
}
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
function lastMessageTsOf(file: string): number {
  for (const n of [65536, 1048576]) {
    let raw = "";
    try { raw = readFileTail(file, n); } catch { return 0; }
    let ts = 0, sawMessage = false;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let o: TranscriptLine;
      try { o = JSON.parse(line) as TranscriptLine; } catch { continue; }
      if ((o.type === "user" || o.type === "assistant") && o.timestamp) {
        sawMessage = true;
        const t = Date.parse(stringOf(o.timestamp));
        if (t > ts) ts = t;
      }
    }
    if (sawMessage || raw.length < n) return ts;
  }
  return 0;
}
function readJsonlFirstRecord(file: string, maxBytes = 262144): unknown {
  try {
    const text = readFileHead(file, maxBytes);
    const newline = text.indexOf("\n");
    return JSON.parse(newline === -1 ? text : text.slice(0, newline)) as unknown;
  } catch {
    return null;
  }
}
function prettyModelName(id: string | null | undefined): string {
  if (!id) return "";
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/i);
  if (m) {
    const fam = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    return `${fam} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`;
  }
  return id;
}
function lastJsonStringValue(text: string, key: string): string | null {
  const re = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, "g");
  let m: RegExpExecArray | null, last: string | null = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  return last;
}
function modelFromTranscriptTail(tail: string, backendKey: string, loose = true): ModelInfo | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line[0] !== "{") continue;
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
