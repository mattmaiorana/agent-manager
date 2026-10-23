// The plugin's shared data types: its saved data, session records, the types of the
// session tab and the sidebar (re-exported from where they're made), and what the
// transcript writer is given and returns. Types only: nothing here runs.

import type { WorkspaceLeaf } from "obsidian";
import type { Browser } from "./browser/view.js";
import type { BackendKey } from "./constants/backends.js";
import type { LinkKind } from "./tickets/session-links.js";
import type { Session } from "./sessions/controller.js";
import type { TerminalSettings } from "./vault-terminal/settings";
import type { VaultTerminalState } from "./vault-terminal/host";

// ---- Saved data ----

// data.json: settings, session renames, and pins. Each field is what the plugin writes.
// The file can be older than this build or edited by hand, so a field whose reader checks
// its shape (Array.isArray, typeof) is `unknown` here and narrowed where it's read. The
// rest are used as written, as they always were.
export interface PluginData {
  // The backend the sidebar starts sessions on.
  cliBackend?: unknown;
  // The backends the sidebar offers (settings).
  browserBackends?: unknown;
  // Folder names by NameKey (constants/names.ts), each read with a typeof check.
  names?: Record<string, unknown>;
  // Opening templates by OpeningKey, each read with a typeof check.
  opening?: Record<string, unknown>;
  // Folders outside the vault given to every session, as the user wrote them.
  addedFolders?: unknown;
  // The "AGENTS.md folder" setting, a vault path; "" or unset for the root.
  startFolder?: unknown;
  // Every folder a session of this plugin has run in, as absolute paths.
  sessionFolders?: unknown;
  // Today's chat's name template.
  dailyChatName?: unknown;
  // Read the overviews above a note or folder a session starts from (off by default).
  useOverviews?: unknown;
  // Treat notes with `type: ticket` as tickets (off by default).
  useTickets?: unknown;
  // An overview's file name; unset for Overview.md.
  overviewName?: unknown;
  // The ticket template's vault path; unset for Templates/Ticket.md.
  ticketTemplate?: unknown;
  // What the strip's Wrap button types; "" hides it, unset is the default.
  wrapMessage?: unknown;
  // Files a session sends: "off", "own" (sentFilesFolder), else Obsidian's attachment rule.
  sentFiles?: unknown;
  // The plugin's own rule: a folder, "./" at its start for beside the note.
  sentFilesFolder?: unknown;
  // Show the Tickets button while tickets are on (on unless false), and its name.
  ticketsButton?: unknown;
  ticketsButtonName?: unknown;
  // The note the Tickets button opens, a vault path; unset for the tickets base.
  ticketsNote?: unknown;
  // The note a new overview is made from, a vault path; unset for the built-in one.
  overviewTemplate?: unknown;
  // Starting folders whose AGENTS.md offer was dismissed.
  agentsFileDismissed?: unknown;
  // Use agent profiles (off by default), the agents (context/agents.ts, readAgents), the
  // switch's pick, and the Default agent, by id.
  useAgents?: unknown;
  agents?: unknown;
  currentAgent?: unknown;
  defaultAgent?: unknown;
  // Each session's agent, by session id: an agent's id, or "" for none (plugin/agents.ts).
  sessionAgents?: Record<string, string>;
  // The agent each session's conversation launched as, by session id: what a resume or a
  // fork passes the CLI, which keeps it whatever Move to files the session under.
  sessionLaunchAgents?: Record<string, string>;
  // Renames, by session id.
  sessionNames?: Record<string, string>;
  // The Antigravity conversations started in this vault, by id.
  antigravitySessions?: string[];
  // Side chats, by id, to their source's id ("" when it isn't known).
  sideChats?: Record<string, string>;
  // Pins, by session id, to a sort key.
  pinnedSessions?: Record<string, number>;
  eagerLoadOnRestart?: boolean;
  dedicatedTerminalSplit?: boolean;
  showSidebarTitle?: boolean;
  codexServer?: boolean;
  // The terminal's settings (src/vault-terminal/), defaults filled in by terminalSettings().
  terminal?: unknown;
  // The terminal's own small state.
  terminalState?: VaultTerminalState;
}

// What the setup check found (plugin/setup.ts): Python 3, and which CLIs are installed.
export interface SetupStatus {
  python: boolean;
  installed: Partial<Record<BackendKey, boolean>>;
}

// ---- Session records ----

// One session as a store reader finds it (plugin/sessions.ts).
export interface StoreRecord {
  // The name it was launched with, from its head, or null.
  rawTitle: string | null;
  // The first message a person typed, for a session started outside the plugin.
  firstMessage: string;
  sessionId: string;
  mtime: number;
  // Its transcript file.
  file: string;
  backend: BackendKey;
  // Its working directory; null for the vault's root, or unknown (Antigravity).
  cwd: string | null;
}

// A session as the sidebar lists it: a store record, classified, or an open tab's own
// row before its transcript can be read (openSessionRecord).
export interface SessionRecord {
  rawTitle?: string | null;
  firstMessage?: string;
  sessionId: string | null;
  mtime: number;
  file: string | null;
  backend: BackendKey;
  cwd: string | null;
  // Listed in this vault (Antigravity's store is shared by every vault).
  listed: boolean;
  // Its name: a rename, else the launch name, else its first message or short id.
  displayName: string;
  title: string;
}

// A record read from a store (the session index, findSessionById): it has its id and its
// file, as every store record does (StoreRecord).
export type IndexRecord = SessionRecord & { sessionId: string; file: string };

// An open session tab, for the sidebar's dots and rows (plugin/workspace.ts).
export interface OpenSession {
  title: string;
  backendKey: string;
  leaf?: WorkspaceLeaf;
  view?: Session;
  sessionId: string | null;
}

// A session tab's saved fields, kept under its view state's `host` key: what the
// controller's getState writes (sessions/controller.ts), read back by its setState and
// for a tab Obsidian hasn't loaded yet. A type rather than an interface, so it is one of
// the terminal's state records (Record<string, unknown>) as it is.
export type SavedSessionState = {
  sessionTitle?: string;
  workingDir?: string;
  backendKey?: string;
  notePath?: string;
  folderPath?: string;
  noteSupport?: boolean;
  noteClaim?: boolean;
  noteLaunchAt?: number;
  noteReplaces?: boolean;
  forkFrom?: ForkFrom;
  daily?: boolean;
  started?: boolean;
  launchToken?: string;
  rehostedFrom?: RehostedFrom;
  sessionId?: string;
  // Tickets the session writes its lines to besides its source, with each one's kind.
  ticketLinks?: Record<string, LinkKind | null>;
  // The agent it's filed under, and the one its conversation launched as when that
  // differs (a fork of a moved session), by id ("" for none), until its id is recorded.
  agent?: string;
  launchAgent?: string;
  // Never saved: set by openSessionLeaf for a tab its caller launches.
  awaitLaunch?: boolean;
};

// A session that followed its conversation to a new id (sessions/identity.ts), shown on
// its strip.
export interface RehostedFrom {
  from: string;
  to: string;
  at: number;
  kind: "rehost" | "continued";
}

// A side chat's source: the session it forks.
export interface ForkFrom {
  id: string;
  backend: string;
  cwd?: string | null;
}

// What startSession is told about a launch.
export interface LaunchOptions {
  backendOverride?: string | null;
  notePath?: string | null;
  folderPath?: string | null;
  daily?: boolean;
  forkFrom?: ForkFrom | null;
  sideSession?: boolean;
  handoffNote?: string | null;
  handoffFromBackend?: string | null;
  handoffIntent?: string | null;
  // How the new session is told about the handoff note (controller.ts, _handoffOpeningSuffix):
  // a side chat that couldn't fork, read the transcript in full, read only its last
  // message, or just know where it is.
  handoffMode?: HandoffMode | null;
  // Continue Session's new main session: it takes the note's main-session over from the
  // one it continues, so a ticket's one-main check lets it start.
  newMain?: boolean;
  // The agent, by id ("" for none), when it comes from the session this one continues
  // rather than from where it starts.
  agentId?: string;
}
export type HandoffMode = "side-chat" | "transcript" | "last" | "pointer";

// ---- The session controller (sessions/controller.ts) ----

// A session: the controller and its parts.
export type { Session };

// ---- The sidebar (browser/view.ts) ----

// A loaded sidebar: the view and every part's methods.
export type { Browser };

// ---- The transcript writer (transcripts/transcript-core.ts) ----

// The vault I/O the writer is given: vault-relative paths.
export interface TranscriptIO {
  exists(rel: string): Promise<boolean>;
  read(rel: string): Promise<string>;
  create(rel: string, content: string): Promise<void>;
  append(rel: string, content: string): Promise<void>;
  ensureDir(rel: string): Promise<void>;
  list(rel: string): Promise<string[]>;
}

// What a write did: the records added, and the note's vault path.
export interface TranscriptWrite {
  added: number;
  path: string;
}

export interface TranscriptWriteOptions {
  transcriptDir: string;
  backend: string;
  sessionId: string | null;
  transcriptFile: string | null;
  sessionTitle?: string | null;
  source?: string | null;
  // The agent's name, for a new note's `agent` property.
  agent?: string | null;
  // Finds the session's note wherever it is under the transcripts folder, asked inside
  // the writer's lock (a move takes the same lock): the writer appends to it rather than
  // look in transcriptDir.
  findExisting?: () => string | null;
  // The folder the writer's lock is keyed on (the transcripts folder), so a note moved
  // between agents' folders mid-write isn't written twice.
  lockDir?: string;
}

// One transcript record, parsed (parseTranscriptRecord): a turn of either side, or the
// mark where the context was compacted. `uuid` is the record's own key in its backend:
// undefined for a Claude or Codex record that has none, which the writer skips.
export type TranscriptPart = { kind: "md"; text: string } | { kind: "tool"; name: string; hint: string };
export type TranscriptMessage =
  | { role: "boundary"; uuid: string }
  | { role: "user"; text: string; uuid: string | undefined }
  | { role: "assistant"; parts: TranscriptPart[]; uuid: string | undefined };

// The terminal's settings as they sit in pluginData once filled in.
export type { TerminalSettings };
