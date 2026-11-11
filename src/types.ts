
import type { WorkspaceLeaf } from "obsidian";
import type { Browser } from "./browser/view.js";
import type { BackendKey } from "./constants/backends.js";
import type { LinkKind } from "./tickets/session-links.js";
import type { Session } from "./sessions/controller.js";
import type { TerminalSettings } from "./vault-terminal/settings";
import type { VaultTerminalState } from "./vault-terminal/host";

export interface PluginData {
  cliBackend?: unknown;
  browserBackends?: unknown;
  names?: Record<string, unknown>;
  opening?: Record<string, unknown>;
  addedFolders?: unknown;
  startFolder?: unknown;
  sessionFolders?: unknown;
  dailyChatName?: unknown;
  dailyChatButton?: unknown;
  newButton?: unknown;
  newButtonName?: unknown;
  notesOpenIn?: unknown;
  newTicketButton?: unknown;
  newTicketButtonName?: unknown;
  ticketNotesHeading?: unknown;
  ticketLaunchButton?: unknown;
  useOverviews?: unknown;
  useTickets?: unknown;
  overviewName?: unknown;
  ticketTemplate?: unknown;
  useScheduledTasks?: unknown;
  scheduledFolder?: unknown;
  taskTemplate?: unknown;
  scheduler?: unknown;
  neverRead?: unknown;
  wrapMessage?: unknown;
  sentFiles?: unknown;
  sentFilesFolder?: unknown;
  customButton?: unknown;
  customButtonIcon?: unknown;
  customButtonName?: unknown;
  customButtonTarget?: unknown;
  ticketsNote?: unknown;
  overviewTemplate?: unknown;
  agentsFileDismissed?: unknown;
  useAgents?: unknown;
  agents?: unknown;
  currentAgent?: unknown;
  defaultAgent?: unknown;
  sessionAgents?: Record<string, string>;
  sessionLaunchAgents?: Record<string, string>;
  sessionSources?: Record<string, ContextSource>;
  sessionNames?: Record<string, string>;
  antigravitySessions?: string[];
  sideChats?: Record<string, string>;
  pinnedSessions?: Record<string, number>;
  eagerLoadOnRestart?: boolean;
  dedicatedTerminalSplit?: boolean;
  showSidebarTitle?: boolean;
  codexServer?: boolean;
  keepDrafts?: boolean;
  draftClipboard?: boolean;
  claudePictures?: boolean;
  claudeQuietTools?: boolean;
  remoteControlDot?: boolean;
  terminal?: unknown;
  terminalState?: VaultTerminalState;
}

export interface SetupStatus {
  python: boolean;
  installed: Partial<Record<BackendKey, boolean>>;
}

export interface StoreRecord {
  rawTitle: string | null;
  firstMessage: string;
  sessionId: string;
  mtime: number;
  file: string;
  backend: BackendKey;
  cwd: string | null;
}

export interface SessionRecord {
  rawTitle?: string | null;
  firstMessage?: string;
  sessionId: string | null;
  mtime: number;
  file: string | null;
  backend: BackendKey;
  cwd: string | null;
  listed: boolean;
  displayName: string;
  title: string;
}

export type IndexRecord = SessionRecord & { sessionId: string; file: string };

export interface OpenSession {
  title: string;
  backendKey: string;
  leaf?: WorkspaceLeaf;
  view?: Session;
  sessionId: string | null;
}

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
  setup?: boolean;
  started?: boolean;
  launchToken?: string;
  rehostedFrom?: RehostedFrom;
  sessionId?: string;
  draft?: string;
  ticketLinks?: Record<string, LinkKind | null>;
  agent?: string;
  launchAgent?: string;
  contextSource?: ContextSource;
  awaitLaunch?: boolean;
};

export interface ContextSource {
  from: string | null;
  pinned: boolean;
  run?: boolean;
}

export interface RehostedFrom {
  from: string;
  to: string;
  at: number;
  kind: "rehost" | "continued";
}

export interface ForkFrom {
  id: string;
  backend: string;
  cwd?: string | null;
}

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
  handoffMode?: HandoffMode | null;
  newMain?: boolean;
  agentId?: string;
  setup?: boolean;
}
export type HandoffMode = "side-chat" | "transcript" | "last" | "pointer";

export type { Session };

export type { Browser };

export interface TicketDraft {
  name: string;
  project: string;
  backend: BackendKey | null;
  notes: string;
}
export interface TicketCard {
  open: boolean;
  draft: TicketDraft;
  from?: Session;
}

export interface TranscriptIO {
  exists(rel: string): Promise<boolean>;
  read(rel: string): Promise<string>;
  create(rel: string, content: string): Promise<void>;
  append(rel: string, content: string): Promise<void>;
  ensureDir(rel: string): Promise<void>;
  list(rel: string): Promise<string[]>;
}

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
  agent?: string | null;
  findExisting?: () => string | null;
  lockDir?: string;
  sidechain?: boolean;
}

export type TranscriptPart = { kind: "md"; text: string } | { kind: "tool"; name: string; hint: string };
export type TranscriptMessage =
  | { role: "boundary"; uuid: string }
  | { role: "user"; text: string; uuid: string | undefined }
  | { role: "assistant"; parts: TranscriptPart[]; uuid: string | undefined };

export type { TerminalSettings };
