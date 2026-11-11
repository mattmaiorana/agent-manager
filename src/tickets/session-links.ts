
export const LINK_SEP = " · ";
export const TRANSCRIPT_SEP = " | ";
export type LinkKind = "Main" | "Previous main" | "Side session" | "Linked" | "Re-hosted" | "Continued";
export const LINK_KINDS: ReadonlySet<string> = new Set<LinkKind>(["Main", "Previous main", "Side session", "Linked", "Re-hosted", "Continued"]);
const KEPT_KINDS: ReadonlySet<string> = new Set<LinkKind>(["Side session", "Linked", "Re-hosted", "Continued"]);
export type LineKind = LinkKind | `${LinkKind} (${number})`;
const kindBase = (kind: string): string => kind.replace(/ \(\d+\)$/, "");
const isKind = (kind: string): boolean => LINK_KINDS.has(kindBase(kind));
const isKept = (kind: string | null): kind is LineKind => !!kind && KEPT_KINDS.has(kindBase(kind));

export const SESSION_LINKS = "Session Links";
export const TRANSCRIPT_LABEL = "Transcript";

const LINE_RE = /^(\s*(?:[-*+]\s+)?)\[([^\]\n]*)\]\((obsidian:\/\/agent-manager\?[^)\s]*)\)(?:\s*\|\s*\[\[([^\]\n]+)\]\])?\s*$/;
const ID_IN_URL_RE = /[?&]session=([0-9a-fA-F-]{16,})(?=[&#)\s"']|$)/;

export function linkSessionId(url: string): string | null {
  const m = String(url).match(ID_IN_URL_RE);
  return m ? m[1] : null;
}

export function sessionLinkText(name: string, cliLabel: string, kind: string | null): string {
  const clean = String(name || "").replace(/\[/g, "(").replace(/\]/g, ")").trim() || "Untitled";
  return [clean, cliLabel, kind].filter(Boolean).join(LINK_SEP);
}

export interface ParsedLink {
  id: string;
  url: string;
  name: string;
  cli: string;
  kind: string | null;
  transcript: string | null;
}

export function sessionLine(text: string, url: string, transcript: string | null): string {
  return `[${text}](${url})${transcript ? `${TRANSCRIPT_SEP}[[${transcript}]]` : ""}`;
}

export const transcriptLink = (linktext: string): string => `${linktext}|${TRANSCRIPT_LABEL}`;

export function parseSessionLink(line: string): ParsedLink | null {
  const m = String(line).replace(/\r$/, "").match(LINE_RE);
  if (!m) return null;
  const id = linkSessionId(m[3]);
  if (!id) return null;
  const transcript = m[4] ?? null;
  const parts = m[2].split(LINK_SEP);
  const n = parts.length;
  if (n >= 3 && isKind(parts[n - 1])) return { id, url: m[3], name: parts.slice(0, n - 2).join(LINK_SEP), cli: parts[n - 2], kind: parts[n - 1], transcript };
  if (n >= 2) return { id, url: m[3], name: parts.slice(0, n - 1).join(LINK_SEP), cli: parts[n - 1], kind: null, transcript };
  return { id, url: m[3], name: m[2], cli: "", kind: null, transcript };
}

function sectionRange(lines: string[], heading: string): { start: number; end: number } | null {
  const h = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (h === -1) return null;
  let end = lines.length;
  for (let i = h + 1; i < lines.length; i++) if (/^#{1,2}\s/.test(lines[i]) || lines[i].trim() === "---") { end = i; break; }
  return { start: h + 1, end };
}

export function sectionLines(content: string, heading: string): string[] {
  const lines = String(content).split(/\r?\n/);
  const r = sectionRange(lines, heading);
  return r ? lines.slice(r.start, r.end) : [];
}

export function upsertSectionLine(content: string, heading: string, line: string, same: (existing: string) => boolean): string {
  const text = String(content);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const r = sectionRange(lines, heading);
  if (!r) return `${text.replace(/\s*$/, "")}${eol}${eol}## ${heading}${eol}${line}${eol}`;
  const hits: number[] = [];
  for (let i = r.start; i < r.end; i++) if (same(lines[i])) hits.push(i);
  if (hits.length) {
    if (hits.length === 1 && lines[hits[0]] === line) return text;
    lines[hits[0]] = line;
    for (let k = hits.length - 1; k >= 1; k--) lines.splice(hits[k], 1);
    return lines.join(eol);
  }
  let at = r.end;
  while (at > r.start && lines[at - 1].trim() === "") at--;
  lines.splice(at, 0, line);
  return lines.join(eol);
}

export const isLinkFor = (id: string) => (line: string): boolean => parseSessionLink(line)?.id === id;

export function relabelSessionLinks(content: string, { mainId = null, kinds = {} }: { mainId?: string | null; kinds?: Record<string, LineKind> } = {}): string {
  const text = String(content);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const r = sectionRange(lines, SESSION_LINKS);
  if (!r) return text;
  for (let i = r.start; i < r.end; i++) {
    const link = parseSessionLink(lines[i]);
    if (!link) continue;
    const kind: string = link.id === mainId ? "Main" : kinds[link.id] || (isKept(link.kind) ? link.kind : "Previous main");
    lines[i] = sessionLine(sessionLinkText(link.name, link.cli, kind), link.url, link.transcript);
  }
  return lines.join(eol);
}

export function heldTranscript(content: string, id: string): string | null {
  for (const line of sectionLines(content, SESSION_LINKS)) {
    const link = parseSessionLink(line);
    if (link && link.id === id) return link.transcript;
  }
  return null;
}

export function keptKind(content: string, id: string): LineKind | null {
  for (const line of sectionLines(content, SESSION_LINKS)) {
    const link = parseSessionLink(line);
    if (link && link.id === id && isKept(link.kind)) return link.kind;
  }
  return null;
}

export function mainSessionIdIn(content: string): string | null {
  const fm = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const line = fm && fm[1].split(/\r?\n/).find((l) => /^main-session\s*:/.test(l));
  return line ? linkSessionId(line) : null;
}

export function listsSession(content: string, id: string): boolean {
  return sectionLines(content, SESSION_LINKS).some(isLinkFor(id));
}
