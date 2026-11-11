
export const FROM_TASK_PROPERTY = "from-task";

export function followUpName(taskName: string): string {
  return `${taskName} follow-up`;
}

export function wikilink(vaultPath: string, label: string): string {
  const target = vaultPath.replace(/\.md$/i, "");
  const shown = label.replace(/[[\]|]/g, "");
  return shown && shown !== target ? `[[${target}|${shown}]]` : `[[${target}]]`;
}

export function linkTarget(raw: unknown): string {
  let v: unknown = raw;
  while (Array.isArray(v) && v.length === 1) v = v[0];
  if (typeof v !== "string") return "";
  const s = v.trim();
  const m = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/.exec(s);
  return (m ? m[1] : s).trim();
}

export function withRead(raw: unknown, link: string): unknown[] {
  const list: unknown[] = Array.isArray(raw) ? raw.slice() : typeof raw === "string" && raw.trim() ? [raw.trim()] : [];
  const want = linkTarget(link);
  if (!list.some((x) => linkTarget(x) === want)) list.push(link);
  return list;
}
