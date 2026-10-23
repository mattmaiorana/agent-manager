// A ticket's session links and transcript links: their format, their kinds, and the two
// sections the plugin keeps in a ticket. Pure string functions, tested in Node
// (scripts/test-session-links.mjs).
//
// Under `## Session Links`, one line per session: `[<name> · <CLI> · <kind>](<resume link>)`.
// Under `## Transcripts`, one wikilink per session's transcript note. Each line is keyed on
// the session's full id (the resume link's, or the transcript note's `session_id`), never
// on a short id, since two Codex sessions can share their first eight characters.

export const LINK_SEP = " · ";
export type LinkKind = "Main" | "Previous main" | "Side session" | "Linked" | "Re-hosted" | "Continued";
// Main: the session the ticket's main-session names. Previous main: one a newer main
// replaced. Side session: started beside the main. Linked: attached to the ticket by hand.
// Re-hosted and Continued: the id a session left when Remote Control or a compaction
// moved it. Main and Previous main are worked out again on every write; the rest can't
// be, so a line keeps them.
export const LINK_KINDS: ReadonlySet<string> = new Set<LinkKind>(["Main", "Previous main", "Side session", "Linked", "Re-hosted", "Continued"]);
const KEPT_KINDS: ReadonlySet<string> = new Set<LinkKind>(["Side session", "Linked", "Re-hosted", "Continued"]);

export const SESSION_LINKS = "Session Links";
export const TRANSCRIPTS = "Transcripts";

const LINE_RE = /^(\s*(?:[-*+]\s+)?)\[([^\]\n]*)\]\((obsidian:\/\/agent-manager\?[^)\s]*)\)\s*$/;
const ID_IN_URL_RE = /[?&]session=([0-9a-fA-F-]{16,})(?=[&#)\s]|$)/;

// The session id in a resume link, or null.
export function linkSessionId(url: string): string | null {
  const m = String(url).match(ID_IN_URL_RE);
  return m ? m[1] : null;
}

// A session link's text: "<name> · <CLI> · <kind>", the kind left off when it isn't known yet.
// Square brackets in a name become parentheses, since a link's text can't hold "]" and
// the line has to read back as this session's.
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
}

// What a `## Session Links` line says, or null for a line that isn't one. Read from the
// right, so a name holding " · " survives.
export function parseSessionLink(line: string): ParsedLink | null {
  const m = String(line).replace(/\r$/, "").match(LINE_RE);
  if (!m) return null;
  const id = linkSessionId(m[3]);
  if (!id) return null;
  const parts = m[2].split(LINK_SEP);
  const n = parts.length;
  if (n >= 3 && LINK_KINDS.has(parts[n - 1])) return { id, url: m[3], name: parts.slice(0, n - 2).join(LINK_SEP), cli: parts[n - 2], kind: parts[n - 1] };
  if (n >= 2) return { id, url: m[3], name: parts.slice(0, n - 1).join(LINK_SEP), cli: parts[n - 1], kind: null };
  return { id, url: m[3], name: m[2], cli: "", kind: null };
}

// The lines of one `## <heading>` section, to the next h1 or h2, with their indexes.
function sectionRange(lines: string[], heading: string): { start: number; end: number } | null {
  const h = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (h === -1) return null;
  let end = lines.length;
  for (let i = h + 1; i < lines.length; i++) if (/^#{1,2}\s/.test(lines[i])) { end = i; break; }
  return { start: h + 1, end };
}

export function sectionLines(content: string, heading: string): string[] {
  const lines = String(content).split(/\r?\n/);
  const r = sectionRange(lines, heading);
  return r ? lines.slice(r.start, r.end) : [];
}

// Put one line in a section: in place of every line `same` says is the same entry (the
// first keeps its place, the rest go), else at the end of the section, before any blank
// lines that close it. A missing section is added at the end of the note. Keeps the
// note's line endings; returns the content unchanged when the line is already there.
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

// Is this line a session link for this session id?
export const isLinkFor = (id: string) => (line: string): boolean => parseSessionLink(line)?.id === id;

// Rewrite every session link's kind, in place: Main for `mainId`; else one given in
// `kinds`; else the one the line keeps (Side session, Linked, Re-hosted, Continued); else
// Previous main. The name and CLI each line holds stay as they are (each session writes
// its own line). Lines in a list lose their bullet.
export function relabelSessionLinks(content: string, { mainId = null, kinds = {} }: { mainId?: string | null; kinds?: Record<string, LinkKind> } = {}): string {
  const text = String(content);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const r = sectionRange(lines, SESSION_LINKS);
  if (!r) return text;
  for (let i = r.start; i < r.end; i++) {
    const link = parseSessionLink(lines[i]);
    if (!link) continue;
    const kind: string = link.id === mainId ? "Main" : kinds[link.id] || (link.kind && KEPT_KINDS.has(link.kind) ? link.kind : "Previous main");
    lines[i] = `[${sessionLinkText(link.name, link.cli, kind)}](${link.url})`;
  }
  return lines.join(eol);
}

// The kind a session's line keeps, if it has one that can't be worked out again.
export function keptKind(content: string, id: string): LinkKind | null {
  for (const line of sectionLines(content, SESSION_LINKS)) {
    const link = parseSessionLink(line);
    if (link && link.id === id && link.kind && KEPT_KINDS.has(link.kind)) return link.kind as LinkKind;
  }
  return null;
}

// The session id a note's main-session property names, read from the note's own text
// (its frontmatter), so a write labels lines by what the note says now, not a cache.
export function mainSessionIdIn(content: string): string | null {
  const fm = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const line = fm && fm[1].split(/\r?\n/).find((l) => /^main-session\s*:/.test(l));
  return line ? linkSessionId(line) : null;
}

// Is a session's id listed under `## Session Links`?
export function listsSession(content: string, id: string): boolean {
  return sectionLines(content, SESSION_LINKS).some(isLinkFor(id));
}

// The wikilink targets under `## Transcripts`, with their lines, for keying them on the
// note each one names (the plugin resolves a target to its note's session_id).
export function transcriptTarget(line: string): string | null {
  const m = String(line).match(/^\s*(?:[-*+]\s+)?\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]\s*$/);
  return m ? m[1] : null;
}
