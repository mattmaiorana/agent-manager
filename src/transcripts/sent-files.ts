
export interface SentFile {
  key: string;
  path: string;
}

interface Attachment { path?: unknown; pathValidated?: unknown }
interface Block { type?: unknown; name?: unknown; id?: unknown; tool_use_id?: unknown; is_error?: unknown }
interface Rec { message?: { content?: unknown }; toolUseResult?: { attachments?: unknown } }

export function sentFilesIn(text: string): SentFile[] {
  const calls = new Set<string>();
  const out: SentFile[] = [];
  const seen = new Set<string>();
  for (const line of String(text).split("\n")) {
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

export const sentFileMarker = (key: string): string => `<!-- pl-file:${key} -->`;
