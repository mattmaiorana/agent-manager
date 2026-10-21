// Default names, the opening a new session is sent, and the session-name marker.

// The folder the plugin writes in the vault, a setting (pluginData.names) read through
// plugin.nameOf(). This is its default.
var DEFAULT_NAMES = {
  transcriptsFolder: "Agent Transcripts",
};
var NAME_LABELS = {
  transcriptsFolder: ["Transcripts folder", "Where each session's transcript is saved as a note."],
};
// The properties the plugin writes. Fixed names, not settings, so a base or a formula
// written for one vault works in every vault.
// A note a session was started from gets its main session's resume link, as a bare URL
// (a Bases formula can only make a link of a URL).
var MAIN_SESSION_PROPERTY = "main-session";
// A transcript note links back to the note its session was started from.
var SOURCE_PROPERTY = "source";
// Today's chat: found and named by this, with {{date}} as YYYY-MM-DD in local time.
var DEFAULT_DAILY_NAME = "Daily Chat - {{date}}";
// Folders outside the vault that every session is given with --add-dir (a setting,
// pluginData.addedFolders). Empty by default.
var DEFAULT_ADDED_FOLDERS = [];
// The opening instruction: one template for a plain session, one for a session launched
// from a note, one for a session launched from a folder, and one for today's chat. An
// empty template sends nothing (Codex and Antigravity still get the session-name
// marker). Placeholders: {{path}} (the note's or folder's absolute path), {{vault}},
// {{date}} (today, YYYY-MM-DD).
var DEFAULT_OPENING = {
  plain: "You're an agent running in an Obsidian vault. Greet me and ask what I'd like help with. Until I say, don't read any files beyond AGENTS.md.",
  daily: "This is the Daily Chat for {{date}}: a place for quick questions that don't need a session of their own. Requests may have nothing to do with each other, so take each on its own unless told otherwise. Then wait for the first one.",
  note: "Read the note at {{path}}. It's what this session is about. Then wait for instructions.",
  folder: "Look through the folder at {{path}}. It's what this session is about. Then wait for instructions.",
};
var OPENING_LABELS = {
  plain: ["New session", "Sent first to a session started from the sidebar. Leave it empty to send nothing."],
  daily: ["Daily Chat", "Sent first to the day's chat when it starts. Leave it empty to send nothing. {{date}} is today's date."],
  note: ["Session from a note", "Sent first to a session started from a note. {{path}} is the note's full path."],
  folder: ["Session from a folder", "Sent first to a session started from a folder. {{path}} is the folder's full path."],
};
// Every opening begins with this, so a reader can tell the plugin's own first message
// from one a person typed (transcript-core's LAUNCH_PROMPT_RE).
var OPENING_LEAD = "Session start.";
// The Codex and Antigravity opening carries this as the session-name marker (they have
// no launch-name flag, so it's the only durable title in the transcript). Kept to a
// plain naming statement, no instructions: the reader brackets the title between the
// prefix's open quote and the closing quote.
var SESSION_NAME_PROMPT_PREFIX = "This session is named \"";
var SESSION_NAME_PROMPT_SUFFIX = "\"";
// The marker, with a token unique to this launch after it, so a fresh Codex or
// Antigravity session finds its own transcript even when another session with the same
// name started at the same moment (both "Untitled", say).
var sessionNamePrompt = (title, token) => `${SESSION_NAME_PROMPT_PREFIX}${title}${SESSION_NAME_PROMPT_SUFFIX}${token ? ` (launch ${token}).` : "."}`;
export { DEFAULT_ADDED_FOLDERS, DEFAULT_DAILY_NAME, DEFAULT_NAMES, MAIN_SESSION_PROPERTY, SOURCE_PROPERTY, DEFAULT_OPENING, NAME_LABELS, OPENING_LABELS, OPENING_LEAD, SESSION_NAME_PROMPT_PREFIX, SESSION_NAME_PROMPT_SUFFIX, sessionNamePrompt };
