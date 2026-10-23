// Files a Claude session sends you (its SendUserFile tool), read from its transcript, and
// the marker that says one is saved in the vault. Pure, tested in Node
// (scripts/test-sent-files.mjs).
//
// Claude records the call in an assistant record (a tool_use named SendUserFile, its
// input's `files`) and the result in the next user record: a tool_result for that call,
// whose `toolUseResult.attachments` lists each file it delivered, with `pathValidated`.
// Only delivered files count, so a call that failed, or one still waiting, saves nothing.

export interface SentFile {
  // The tool call's id and the file's place in it: one per file, never reused.
  key: string;
  // The file's absolute path on this machine, as Claude delivered it.
  path: string;
}

interface Attachment { path?: unknown; pathValidated?: unknown }
interface Block { type?: unknown; name?: unknown; id?: unknown; tool_use_id?: unknown; is_error?: unknown }
interface Rec { message?: { content?: unknown }; toolUseResult?: { attachments?: unknown } }

// Every file a session's transcript says it delivered, in order.
export function sentFilesIn(text: string): SentFile[] {
  const calls = new Set<string>();
  const out: SentFile[] = [];
  const seen = new Set<string>();
  for (const line of String(text).split("\n")) {
    // Cheap filter first: only the call's record and its result's record matter.
    if (!line.includes("SendUserFile") && !line.includes("\"attachments\"")) continue;
    let rec: Rec;
    try { rec = JSON.parse(line) as Rec; } catch { continue; }
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Block[]) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_use" && b.name === "SendUserFile" && typeof b.id === "string") calls.add(b.id);
      if (b.type === "tool_result" && typeof b.tool_use_id === "string" && calls.has(b.tool_use_id) && b.is_error !== true) {
        const list = rec.toolUseResult?.attachments;
        if (!Array.isArray(list)) continue;
        (list as Attachment[]).forEach((a, i) => {
          const key = `${b.tool_use_id as string}:${i}`;
          if (a && typeof a.path === "string" && a.path && a.pathValidated !== false && !seen.has(key)) { seen.add(key); out.push({ key, path: a.path }); }
        });
      }
    }
  }
  return out;
}

// The hidden marker a transcript note carries once a sent file is saved and embedded.
export const sentFileMarker = (key: string): string => `<!-- pl-file:${key} -->`;
