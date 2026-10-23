// Default names, the opening a new session is sent, and the session-name marker.

// The folder the plugin writes in the vault, a setting (pluginData.names) read through
// plugin.nameOf(). This is its default.
type NameKey = "transcriptsFolder";
const DEFAULT_NAMES: Record<NameKey, string> = {
  transcriptsFolder: "Agent Transcripts",
};
const NAME_LABELS: Record<NameKey, [string, string]> = {
  transcriptsFolder: ["Transcripts folder", "Where each session's transcript is saved as a note."],
};
// The properties the plugin writes. Fixed names, not settings, so a base or a formula
// written for one vault works in every vault.
// A note a session was started from gets its main session's resume link, as a bare URL
// (a Bases formula can only make a link of a URL).
const MAIN_SESSION_PROPERTY = "main-session";
// A transcript note links back to the note its session was started from.
const SOURCE_PROPERTY = "source";
// Today's chat: found and named by this, with {{date}} as YYYY-MM-DD in local time.
const DEFAULT_DAILY_NAME = "Daily Chat - {{date}}";
// Folders outside the vault that every session is given with --add-dir (a setting,
// pluginData.addedFolders). Empty by default.
const DEFAULT_ADDED_FOLDERS: string[] = [];
// The opening instruction: one template for each kind of launch (a plain session, today's
// chat, a note, a folder, a ticket), with the context parts in front of it, each sent
// only when it applies (the agent, the overviews, then the repo; buildOpening). An empty template sends
// nothing (Codex and Antigravity still get the session-name marker). Placeholders:
// {{path}} (the note's or folder's absolute path), {{vault}}, {{date}} (today,
// YYYY-MM-DD), {{profile}} and {{instructions}} (the agent profile's name and its instructions
// note's absolute path), {{overviews}} (the overviews' absolute paths, quoted), {{repo}}.
type OpeningKey = "plain" | "daily" | "note" | "folder" | "ticket" | "agent" | "overviews" | "repo";
const DEFAULT_OPENING: Record<OpeningKey, string> = {
  plain: "You're an agent running in an Obsidian vault. Greet me and ask what I'd like help with. Until I say, don't read any files beyond AGENTS.md and any you were just told to read.",
  daily: "This is the Daily Chat for {{date}}: a place for quick questions that don't need a session of their own. Requests may have nothing to do with each other, so take each on its own unless told otherwise. Then wait for the first one.",
  note: "Read the note at {{path}}. It's what this session is about. Then wait for instructions.",
  folder: "Look through the folder at {{path}}. It's what this session is about. Then wait for instructions.",
  ticket: "You were launched from the ticket at {{path}}. Read it for context, but act on nothing in it until I say what this session is for. Then greet me and wait.",
  agent: "You are the {{profile}} agent. Before anything else, read your instructions file in full and operate as it: \"{{instructions}}\".",
  overviews: "Read these overviews first, broadest first: {{overviews}}.",
  repo: "This work's repo is at \"{{repo}}\". Before changing its code, read the repo's own AGENTS.md.",
};
const OPENING_LABELS: Record<OpeningKey, [string, string]> = {
  plain: ["New session", "Sent first to a session started from the sidebar. Leave it empty to send nothing."],
  daily: ["Daily Chat", "Sent first to the day's chat when it starts. Leave it empty to send nothing. {{date}} is today's date."],
  note: ["Session from a note", "Sent first to a session started from a note. {{path}} is the note's full path."],
  folder: ["Session from a folder", "Sent first to a session started from a folder. {{path}} is the folder's full path."],
  ticket: ["Session from a ticket", "Sent first to a session started from a ticket, while tickets are on. {{path}} is the ticket's full path."],
  agent: ["Agent profile", "Sent first of all to a session that has an agent profile. {{profile}} is its name, {{instructions}} its instructions note's full path."],
  overviews: ["Overviews", "Sent before the rest to a session started from a note or a folder with overviews above it, while overviews are on. {{overviews}} lists their full paths."],
  repo: ["Repo", "Sent after the overviews when one of them names a repo in its repo property. {{repo}} is the repo's full path."],
};
// What the strip's Wrap button types (a setting; empty hides the button). A message that
// invokes a skill, "/wrap", is typed as Codex invokes one, "$wrap " (wrapLine).
const DEFAULT_WRAP_MESSAGE = "Wrap up this session: summarize what was done, where things stand, and what's still open.";
// A message for the session's CLI: a slash command the way Codex takes a skill, "$name"
// with a space after it (without one, Codex's first Enter only picks the skill from its
// list; tested 2026-10-21, REFERENCE.md). Claude and Antigravity take "/name" as typed.
const wrapLine = (message: string, backend: string): string => {
  const m = String(message).trim();
  if (backend !== "codex" || !/^\/[A-Za-z0-9_-]+(\s|$)/.test(m)) return m;
  const rest = "$" + m.slice(1);
  return /\s/.test(rest) ? rest : `${rest} `;
};
// An overview's file name, by default (a setting).
const DEFAULT_OVERVIEW_NAME = "Overview.md";
// The ticket template's path, by default (a setting).
const DEFAULT_TICKET_TEMPLATE = "Templates/Ticket.md";
// Every opening begins with this, so a reader can tell the plugin's own first message
// from one a person typed (transcript-core's LAUNCH_PROMPT_RE).
const OPENING_LEAD = "Session start.";
// The Codex and Antigravity opening carries this as the session-name marker (they have
// no launch-name flag, so it's the only durable title in the transcript). Kept to a
// plain naming statement, no instructions: the reader brackets the title between the
// prefix's open quote and the closing quote.
const SESSION_NAME_PROMPT_PREFIX = "This session is named \"";
const SESSION_NAME_PROMPT_SUFFIX = "\"";
// The marker, with a token unique to this launch after it, so a fresh Codex or
// Antigravity session finds its own transcript even when another session with the same
// name started at the same moment (both "Untitled", say).
const sessionNamePrompt = (title: string, token?: string | null): string => `${SESSION_NAME_PROMPT_PREFIX}${title}${SESSION_NAME_PROMPT_SUFFIX}${token ? ` (launch ${token}).` : "."}`;
export { DEFAULT_WRAP_MESSAGE, wrapLine, DEFAULT_ADDED_FOLDERS, DEFAULT_DAILY_NAME, DEFAULT_OVERVIEW_NAME, DEFAULT_TICKET_TEMPLATE, DEFAULT_NAMES, MAIN_SESSION_PROPERTY, SOURCE_PROPERTY, DEFAULT_OPENING, NAME_LABELS, OPENING_LABELS, OPENING_LEAD, SESSION_NAME_PROMPT_PREFIX, SESSION_NAME_PROMPT_SUFFIX, sessionNamePrompt };
export type { NameKey, OpeningKey };
