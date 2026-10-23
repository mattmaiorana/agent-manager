// A session in a terminal tab: Agent Manager's hold on one view of the new terminal
// (src/vault-terminal/, host.ts, TerminalController). The view runs the program; this
// decides what it runs (a launch or a resume, by id), what the tab is called, the strip
// above it and the transcript overlay beside it, what's typed into it (the opening), and
// whether closing asks. Its parts (strip, identity, transcripts, the note it came from,
// rename) are applied to it. Its full type, with every part's methods, is Session (below).

import type { App, WorkspaceLeaf } from "obsidian";
import { StringDecoder, fs, import_obsidian, path } from "../externals.js";
import { CLI_BACKENDS, INPUT_PASTE_MIN, isBackendKey } from "../constants/backends.js";
import { OPENING_LEAD, SETUP_SESSION_NAME, plainSessionName, sessionNamePrompt } from "../constants/names.js";
import { DIALOG_RE, INPUT_GUARD_NOTICE_MS } from "./constants.js";
import { splitCommand } from "../vault-terminal/finder";
import { IdentityMethods } from "./identity.js";
import { StripMethods } from "./strip.js";
import { SessionActionMethods } from "./session-actions.js";
import { ViewNoteMethods } from "../notes/view-note.js";
import { ViewTicketMethods } from "../notes/view-ticket.js";
import { ViewTranscriptMethods } from "../transcripts/view-transcripts.js";
import { DraftTracker } from "./draft.js";
import { readFileHead } from "./transcript-files.js";
import { applyParts } from "../util/apply-parts.js";
import { stringOf } from "../util/guards.js";
import type { BackendKey, CliBackend } from "../constants/backends.js";
import type { AgentManagerPlugin } from "../plugin/main.js";
import type { LinkKind } from "../tickets/session-links.js";
import type { ForkFrom, HandoffMode, IndexRecord, RehostedFrom, SavedSessionState, SessionRecord } from "../types.js";
import type { CloseReason } from "../vault-terminal/close";
import type { HostLaunch, TerminalController } from "../vault-terminal/host";
import type { ExitInfo } from "../vault-terminal/session";
import type { ProgramState } from "../vault-terminal/status";
import type { TerminalView } from "../vault-terminal/view";

// A Claude attach that ends this fast with an error didn't find a live agent to attach to.
const ATTACH_FAIL_MS = 4000;

// CLI_BACKENDS read by any name: a name it doesn't have reads undefined.
// A line's start and end, squeezed of spaces, to find it on screen once it's typed.
interface EchoProbe {
  head: string;
  tail: string;
}
// What `claude agents --json` lists, each field checked before it's used.
interface ListedAgent {
  sessionId?: unknown;
  kind?: unknown;
  pid?: unknown;
}

// The terminal asks a session these (host.ts, TerminalController). Its full type, with
// every part's methods, is Session (below): the parts and every method here that calls
// one take `this` as that.
class SessionController implements TerminalController {
  // Every field the class, a part, or the plugin sets on a session. `declare` adds no
  // code: each is set where it always was (the first group in the constructor), and
  // unset until then.
  declare view: TerminalView;
  declare plugin: AgentManagerPlugin;
  declare gated: boolean;
  declare startHidden: boolean;
  declare backendKey: BackendKey | null;
  declare workingDir: string | null;
  declare sessionTitle: string | null;
  declare sessionName: string | null;
  declare resumeSessionId: string | null;
  declare launchSessionId: string | null;
  declare termHost: HTMLElement | null;
  declare stripEl: HTMLElement | null;
  declare _draft: DraftTracker;
  declare hasOutput: boolean;
  declare lastOutputAt: number;
  declare lastWorkOutputAt: number;
  declare lastUserInputAt: number;
  declare _attempt: number;
  declare _resumeStep: "attach" | "resume" | null;
  declare _inert: { message: string; title: string } | null;
  // Launching, typing the opening, and closing (this file).
  declare _decided: boolean | undefined;
  declare _stripContainer: HTMLElement | undefined;
  declare _cliFound: boolean | undefined;
  declare _ranOnce: boolean | undefined;
  declare _closed: boolean | undefined;
  declare _closeQuietly: boolean | undefined;
  declare _started: boolean | undefined;
  declare _launchedAt: number | null | undefined;
  declare _launchToken: string | null | undefined;
  declare _opening: string | null | undefined;
  declare _openingSent: boolean | undefined;
  declare _openingPending: boolean | undefined;
  declare _forkSending: boolean | undefined;
  declare _pendingResumeTitle: string | null | undefined;
  declare _pendingResumeId: string | null | undefined;
  declare _sessionInteractive: boolean | undefined;
  // A launch's options (plugin/sessions.ts, startSession), and what a restore reads back.
  declare _notePath: string | null | undefined;
  declare _folderPath: string | null | undefined;
  declare _handoffNote: string | null | undefined;
  declare _handoffFromBackend: string | null | undefined;
  declare _handoffIntent: string | null | undefined;
  declare _handoffMode: HandoffMode | null | undefined;
  declare _daily: boolean | undefined;
  // Set up this vault's session: its opening points at the setup guide (plugin/guides.ts).
  declare _setup: boolean | undefined;
  // The agent it was launched as, by id ("" for none), until its id's record holds it
  // (plugin/agents.ts); undefined for a resume, which reads the record.
  declare _agentId: string | undefined;
  // A fork's: the agent its source's conversation launched as, which the fork keeps.
  declare _launchAgentId: string | undefined;
  declare _forkFrom: ForkFrom | null | undefined;
  declare _noteSupport: boolean | undefined;
  declare _noteClaim: boolean | undefined;
  declare _noteLaunchAt: number | null | undefined;
  // The note write-back (notes/view-note.ts, plugin/notes.ts).
  declare _noteUrlWritten: string | null | undefined;
  declare _noteWritten: boolean | undefined;
  declare _noteGone: boolean | undefined;
  declare _noteTriedAt: number | undefined;
  declare _noteGen: number | undefined;
  declare _noteWriting: boolean | undefined;
  declare _notePriorIds: Set<string> | undefined;
  // The ticket write-back (notes/view-ticket.ts): tickets this session writes to besides
  // the one it was started from, each with the kind its line takes (null: its own, or
  // none yet), what was last written to each, and whether every line is in.
  declare _ticketLinks: Record<string, LinkKind | null> | undefined;
  declare _ticketWritten: Record<string, string> | undefined;
  declare _ticketDone: boolean | undefined;
  declare _ticketWriting: boolean | undefined;
  declare _ticketTriedAt: number | undefined;
  declare _ticketGen: number | undefined;
  // Continue Session's new main session: it takes main-session only once it has run.
  declare _noteReplaces: boolean | undefined;
  // Which transcript this is (identity.ts).
  declare _modelFile: string | null | undefined;
  declare _durableReconciledSize: number | undefined;
  declare _durableCaughtUp: boolean | undefined;
  declare _durableMisses: number | undefined;
  declare _durableRetryAt: number | undefined;
  // Sent files (transcripts/view-transcripts.ts, saveSentFiles): a pass running, and one still to copy.
  declare _sentFilesSaving: boolean | undefined;
  declare _sentFilesPending: boolean | undefined;
  declare _sentFilesScanned: number | null | undefined;
  declare _forkScanDirMtime: number | undefined;
  declare _modelRefreshedAt: number | undefined;
  declare _rehostedFrom: RehostedFrom | null | undefined;
  declare _claimedResumeId: string | null | undefined;
  declare _firstTextsOwn: null | undefined;
  declare _restoring: boolean | undefined;
  declare _restoreReason: "gone" | "claimed" | null | undefined;
  // The working poll's state (plugin/workspace.ts, refreshWorkingDots).
  declare _wasWorking: boolean | undefined;
  declare _durableCheckedAt: number | undefined;
  // The strip (strip.ts).
  declare idEl: HTMLElement | undefined;
  declare modelEl: HTMLElement | undefined;
  declare transcriptBtnEl: HTMLElement | undefined;
  // The transcript overlay (transcripts/view-transcripts.ts).
  declare transcriptHost: HTMLElement | null | undefined;
  declare _transcriptBodyEl: HTMLElement | null | undefined;
  declare _transcriptFilePath: string | null | undefined;
  declare _transcriptOpen: boolean | undefined;
  declare _transcriptTimer: number | null | undefined;
  declare _transcriptOffset: number | undefined;
  declare _transcriptDecoder: InstanceType<typeof StringDecoder> | undefined;
  declare _transcriptCarry: string | undefined;
  declare _transcriptSkipPartial: boolean | undefined;
  constructor(view: TerminalView, plugin: AgentManagerPlugin) {
    this.view = view;
    this.plugin = plugin;
    // Every view of the session type is a session tab: it waits for its launch, its
    // resume, or its restore before the program starts.
    this.gated = true;
    // Sessions start even in a tab that isn't showing ("Force load all sessions").
    this.startHidden = true;
    this.backendKey = null;
    this.workingDir = null;
    this.sessionTitle = null;
    this.sessionName = null;
    this.resumeSessionId = null;
    this.launchSessionId = null;
    this.termHost = null;
    this.stripEl = null;
    // What the user has typed into the prompt and not sent (draft.ts).
    this._draft = new DraftTracker();
    this.hasOutput = false;
    this.lastOutputAt = 0;
    this.lastWorkOutputAt = 0;
    this.lastUserInputAt = 0;
    // Each start of the program is one attempt; what's waiting to be typed belongs to one.
    this._attempt = 0;
    // A Claude resume tries attach first, then -r (launch, exit).
    this._resumeStep = null;
    // A tab whose restore failed: kept open, saying why, and never matched or restarted.
    this._inert = null;
  }

  // ---- What the parts and the plugin read ----

  get leaf(): WorkspaceLeaf { return this.view.leaf; }
  get app(): App { return this.view.app; }
  get containerEl(): HTMLElement { return this.view.containerEl; }
  get running(): boolean { return this.view.running; }
  get programPid(): number { return this.view.programPid; }
  get _lastTitle(): string { return this.view.programTitle; }
  get programState(): ProgramState | null { return this.view.state; }
  writeRaw(data: string): boolean { return this.view.write(data); }
  focusTerminal(): void { this.view.focus(); }
  // The last lines with text, up to maxLines. Blank rows at the bottom are skipped: a
  // CLI on the normal screen (Antigravity) draws at the top of a tall screen, and its
  // prompt was out of reach of a read of the bottom rows.
  _terminalTailText(maxLines = 40): string {
    const lines = String(this.view.screenTail(maxLines + 300) || "").split("\n");
    let end = lines.length;
    while (end > 0 && !lines[end - 1].trim()) end--;
    return lines.slice(Math.max(0, end - maxLines), end).join("\n");
  }
  getBackendKey(): BackendKey {
    // The saved default is a backend's name, or gone (applyPluginDataDefaults).
    const key = this.backendKey || this.plugin.pluginData.cliBackend || "claude";
    // One of the backends by name, not a name every object inherits ("constructor").
    return isBackendKey(key) ? key : "claude";
  }
  // Set up this vault's session: started by the setup button, or resumed by its name.
  isSetupSession(this: Session): boolean {
    return !!this._setup || this.sessionTitle === SETUP_SESSION_NAME;
  }
  getBackend(): CliBackend {
    return CLI_BACKENDS[this.getBackendKey()];
  }
  get activeBackendKey(): BackendKey { return this.getBackendKey(); }

  // ---- The terminal's questions (host.ts, TerminalController) ----

  name(): string {
    if (this._inert) return this._inert.title;
    return this.sessionTitle || this.getBackend().label;
  }
  icon(): string { return "bot"; }
  // The session's agent, by id ("" for none): its id's record once there is one (Move
  // to changes it), else what it was launched as.
  agentId(this: Session): string {
    const rec = this.plugin.recordedAgentId(this._ownSessionId());
    return rec !== undefined ? rec : (this._agentId ?? "");
  }
  // The agent its conversation launched as, which the CLI keeps: its id's record, else
  // what this tab launched as.
  conversationAgentId(this: Session): string {
    const rec = this.plugin.launchAgentOf(this._ownSessionId());
    return rec !== undefined ? rec : (this._launchAgentId ?? this._agentId ?? "");
  }
  exitHint(): string {
    if (this._inert) return "This tab can't be restarted. Close it when you're done with it.";
    return "Press Enter to resume this session.";
  }
  getState(this: Session): SavedSessionState {
    const state: SavedSessionState = {};
    if (this._inert) return state;
    if (this.sessionTitle) state.sessionTitle = this.sessionTitle;
    if (this.workingDir) state.workingDir = this.workingDir;
    if (this.backendKey) state.backendKey = this.backendKey;
    if (this._notePath) state.notePath = this._notePath;
    if (this._folderPath) state.folderPath = this._folderPath;
    if (this._noteSupport) state.noteSupport = true;
    if (this._noteClaim) state.noteClaim = true;
    if (this._noteLaunchAt) state.noteLaunchAt = this._noteLaunchAt;
    if (this._noteReplaces) state.noteReplaces = true;
    if (this._forkFrom) state.forkFrom = this._forkFrom;
    if (this._daily) state.daily = true;
    if (this._setup) state.setup = true;
    if (this._agentId !== undefined) state.agent = this._agentId;
    if (this._launchAgentId !== undefined) state.launchAgent = this._launchAgentId;
    if (this._ticketLinks && Object.keys(this._ticketLinks).length) state.ticketLinks = this._ticketLinks;
    // Took a turn: its transcript was found, or it was a resume. A restore that finds no
    // transcript for a tab that never did starts it afresh rather than failing.
    if (this._modelFile || this.resumeSessionId || this._started) state.started = true;
    if (this._launchToken) state.launchToken = this._launchToken;
    if (this._rehostedFrom) state.rehostedFrom = this._rehostedFrom;
    const sid = this._stripSessionId?.();
    if (sid) state.sessionId = sid;
    return state;
  }
  // Called once as the tab opens (and again by Obsidian on later setViewState calls,
  // which change nothing once the session is decided).
  // What getState saved (the terminal hands over an object, or {} for anything else).
  setState(this: Session, state: SavedSessionState): void {
    if (this._decided) return;
    this._decided = true;
    // Opened for a launch or a resume (openSessionLeaf): the caller decides.
    if (state.awaitLaunch) return;
    if (isBackendKey(state.backendKey)) this.backendKey = state.backendKey;
    if (typeof state.workingDir === "string") this.workingDir = state.workingDir;
    if (state.notePath) this._notePath = state.notePath;
    if (state.folderPath) this._folderPath = state.folderPath;
    if (state.noteSupport) this._noteSupport = true;
    if (state.noteClaim) this._noteClaim = true;
    if (typeof state.noteLaunchAt === "number") this._noteLaunchAt = state.noteLaunchAt;
    if (state.noteReplaces) this._noteReplaces = true;
    // A side chat saved before it learned its id: restore can't tell its fork from
    // another, so it fails rather than guess (_pickRestoreRecord).
    if (state.forkFrom && typeof state.forkFrom === "object") this._forkFrom = state.forkFrom;
    if (typeof state.launchToken === "string") this._launchToken = state.launchToken;
    if (state.daily) this._daily = true;
    if (state.setup) this._setup = true;
    if (typeof state.agent === "string") this._agentId = state.agent;
    if (typeof state.launchAgent === "string") this._launchAgentId = state.launchAgent;
    if (state.ticketLinks && typeof state.ticketLinks === "object") this._ticketLinks = { ...state.ticketLinks };
    if (state.started) this._started = true;
    if (state.rehostedFrom && typeof state.rehostedFrom === "object") this._rehostedFrom = state.rehostedFrom;
    if (typeof state.sessionTitle === "string" && state.sessionTitle) {
      this.sessionTitle = state.sessionTitle;
      this._pendingResumeTitle = state.sessionTitle;
      this._pendingResumeId = typeof state.sessionId === "string" ? state.sessionId : null;
      // After the view has drawn: the restore reads other tabs' claims.
      window.setTimeout(() => {
        void this.restoreResumeFromState().catch((e) => {
          console.error("[Agent Manager] restore failed:", e);
          this._makeInert(`Agent Manager couldn't restore “${this.sessionTitle}”: ${stringOf(e && (e as { message?: unknown }).message)}.`);
        });
      }, 0);
      return;
    }
    // Saved with no session (a tab whose restore failed before, or one that never launched).
    this._makeInert("This tab has no session to resume. Close it, and start or resume a session from the sidebar.", "No session");
  }
  // The view's elements: the strip above the terminal, the overlay beside it.
  mount(this: Session, { top, stage }: { top: HTMLElement; stage: HTMLElement }): void {
    this.view.contentEl.addClass("agent-manager-session");
    this.termHost = stage;
    this._stripContainer = top;
    this.closeTranscript?.();
    this.transcriptHost = null;
    this._transcriptBodyEl = null;
    this._transcriptFilePath = null;
    // The overlay's own menu: its text, and the transcript note.
    this.view.registerDomEvent(stage, "contextmenu", (e) => {
      if (!(this._transcriptOpen && this.transcriptHost && this.transcriptHost.contains(e.target as Node | null))) return;
      e.preventDefault();
      e.stopPropagation();
      const sel = this.view.containerEl.win.getSelection()?.toString() || "";
      const menu = new import_obsidian.Menu();
      menu.addItem((i) => i.setTitle("Copy").setIcon("copy").setDisabled(!sel).onClick(() => navigator.clipboard?.writeText(sel).catch(() => {})));
      menu.addItem((i) => i.setTitle("Open transcript note").setIcon("file-text").onClick(() => { void this.openDurableTranscriptNote(); }));
      menu.showAtMouseEvent(e);
    });
    this.rebuildStrip();
  }
  rebuildStrip(this: Session): void {
    const top = this._stripContainer;
    if (!top) return;
    top.empty();
    if (this._inert || !this.sessionTitle) return;
    this.buildStatusStrip(top);
  }
  // Each start of an agent asks what to add to its command (host.ts, HostLaunch).
  async launch(this: Session, kind: string, plain: boolean): Promise<HostLaunch | { error: string }> {
    if (this._inert) return { error: this._inert.message };
    this._attempt++;
    this.hasOutput = false;
    this.lastOutputAt = 0;
    this._draft.clear();
    const backendKey = this.getBackendKey();
    const backend = CLI_BACKENDS[backendKey];
    const cwd = this.workingDir || this.plugin.getVaultPath();
    // The flags every start takes: Codex's --no-daemon when its sessions stay off its
    // background server, and the added folders. A session that starts in a folder below
    // the vault's root is never given the root: someone keeping agents to a corner of the
    // vault means it. Flags of your own go in the agent's Command (the terminal's
    // settings). Every Codex start, new or resumed, goes the same way: a conversation the
    // server has open can't be opened without it ("This conversation is open in another app").
    const codexServer = backendKey === "codex" && this.plugin.pluginData.codexServer === true;
    const global = backendKey === "codex" && !codexServer ? ["--no-daemon"] : [];
    // The bundled Claude mod (claude-mod.ts), for every Claude start and resume while pictures
    // are on. A `claude attach` takes no launch flags, so a re-hosted session reconnected that
    // way goes without it.
    const modDir = backendKey === "claude" ? this.plugin.claudeModDir?.() : null;
    if (modDir) global.push("--plugin-dir", modDir);
    // The agent its conversation launched as, on every start the CLI takes it on
    // (context/agents.ts, agentArgs): a resume or a fork keeps it, whatever the session
    // is filed under since, so the CLI's header and the conversation agree.
    // Ids read from a transcript go into argv and paths, so they're checked first: one that
    // began with "--" would be read as a flag.
    const validId = (id: string | null | undefined): string | null => (id && /^[0-9a-fA-F-]{16,}$/.test(id) ? id : null);
    const resumeId = validId(this.resumeSessionId);
    const forkId = validId(this._forkFrom?.id);
    global.push(...this.plugin.agentLaunchArgs(backendKey, this.conversationAgentId(), !!(resumeId || forkId), resumeId || forkId));
    const addDirs = this.plugin.addedFolders().filter((d) => path.resolve(d) !== path.resolve(cwd));
    // The setup session reads its guide from the plugin's folder, which sits outside a
    // session started below the vault's root: Claude asks before reading outside its
    // folders, so it's given that one (Codex and Antigravity read it without asking).
    const guides = backendKey === "claude" && this.isSetupSession() ? this.plugin.guidesDir() : null;
    if (guides && !isInside(guides, cwd) && !addDirs.some((d) => isInside(guides, d))) addDirs.push(guides);
    if (addDirs.length && backend.addDirFlag) {
      for (const dir of addDirs) global.push(backend.addDirFlag, dir);
      if (backend.addDirWriteFlags) global.push(...splitCommand(backend.addDirWriteFlags));
    }
    // A side chat: a copy of another session's conversation, made by the CLI's own fork.
    if (forkId && !this.resumeSessionId) {
      // Claude: resume the source as a new session, with the id the plugin minted.
      if (backendKey === "claude") {
        const args = [...global, "--resume", forkId, "--fork-session"];
        if (this.launchSessionId) args.push("--session-id", this.launchSessionId);
        // Claude has a name flag (constants/backends.ts).
        if (this.sessionName) args.push(backend.nameFlag as string, this.sessionName);
        return { args, folder: this.workingDir || "" };
      }
      // Codex: its fork subcommand, by id. The fork's id is learned from its new rollout.
      if (backendKey === "codex") return { args: [...global, "fork", forkId], folder: this.workingDir || "" };
      // Antigravity has no launch flag for it: open the source conversation, then /fork
      // inside it (_sendFork). The tab is on the source until the fork answers.
      return { args: [...global, ...splitCommand(backend.resumeByIdFlag), forkId], folder: this.workingDir || "" };
    }
    const id = resumeId;
    if (id && backend.resumeByIdFlag) {
      if (backendKey === "claude") {
        // A Claude session Remote Control re-hosted runs as a background agent, which
        // `claude -r` refuses: reconnect with `claude attach` when one is listed (the
        // bare command: launch flags don't apply to a supervisor's process), and resume
        // with -r otherwise, or when the attach fails at once (exit).
        // No answer from `claude agents` (slow, or many tabs restoring at once): attach
        // first anyway; a fast attach failure goes on to -r.
        if (this._resumeStep === null) this._resumeStep = (await this._liveAgentFor(id)) === false ? "resume" : "attach";
        if (this._resumeStep === "attach") return { args: ["attach", id.split("-")[0]], folder: this.workingDir || "", plain: true };
        return { args: [...global, backend.resumeByIdFlag, id], folder: this.workingDir || "" };
      }
      return { args: [...global, ...splitCommand(backend.resumeByIdFlag), id], folder: this.workingDir || "" };
    }
    const args = [...global];
    if (this.sessionName && backend.nameFlag) args.push(backend.nameFlag, this.sessionName);
    // The id Agent Manager minted (Claude only), so the transcript is known from the start.
    if (this.launchSessionId && backendKey === "claude" && /^[0-9a-f-]{36}$/.test(this.launchSessionId)) args.push("--session-id", this.launchSessionId);
    return { args, folder: this.workingDir || "" };
  }
  // Is this Claude session running as a background agent right now? From `claude agents
  // --json`, one call shared by the tabs restoring together; null when it didn't answer.
  async _liveAgentFor(id: string): Promise<boolean | null> {
    try {
      const agents = await this.plugin.listClaudeAgentsShared();
      // Each entry as the CLI wrote it: `a &&` stops at null, and a missing field reads undefined.
      return agents.some((a) => a && stringOf((a as ListedAgent).sessionId) === id && (a as ListedAgent).kind === "background" && (a as ListedAgent).pid);
    } catch {
      return null;
    }
  }
  started(pid: number): void {
    this._cliFound = true;
    this._ranOnce = true;
    this.plugin.scheduleStatusRefresh();
  }
  launchFailed(message: string): void {
    this._cliFound = false;
    this.plugin.scheduleStatusRefresh();
  }
  output(text: string): void {
    this.hasOutput = true;
    this.lastOutputAt = Date.now();
    // Real output, not a title re-assert, is what the working dot's activity layer counts.
    // eslint-disable-next-line no-control-regex -- terminal escape sequences are control characters
    const activity = text.replace(/\x1b\][02];[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
    if (activity.trim()) this.lastWorkOutputAt = Date.now();
  }
  input(data: string): void {
    // Focus reports aren't typing.
    // eslint-disable-next-line no-control-regex -- terminal escape sequences are control characters
    if (/^(?:\x1b\[[IO])+$/.test(data)) return;
    this._draft.feed(data, this.getBackendKey());
    this.lastUserInputAt = Date.now();
  }
  inputCleared(): void {
    this._draft.clear();
  }
  dialogShowing(): boolean {
    return this._dialogShowing();
  }
  stateChange(state: ProgramState | null): void {
    // Seen working: a real session, past any trust dialog.
    if (state === "working") this._sessionInteractive = true;
  }
  exit(this: Session, info: ExitInfo): boolean {
    this.plugin.scheduleStatusRefresh();
    // A Claude attach that failed at once: no live agent after all, so resume with -r.
    if (this._resumeStep === "attach") {
      const ran = info.ran !== undefined ? info.ran * 1000 : 0;
      this._resumeStep = "resume";
      if (!info.closed && info.code !== 0 && ran < ATTACH_FAIL_MS) {
        window.setTimeout(() => this.view.restart(), 0);
        return true;
      }
    }
    // Anything the session wrote since the last capture lands in its note.
    try { if (this.transcriptGrewSinceReconcile?.()) void this.updateDurableTranscript?.(); } catch { /* best effort */ }
    return false;
  }
  // Enter after the program ended: the same session again, by its id.
  restart(this: Session): void {
    if (this._inert) return;
    this._restartBySession().catch((e) => console.error("[Agent Manager] restart failed:", e));
  }
  async _restartBySession(this: Session): Promise<void> {
    // A new session whose CLI never ran (no Python, the CLI not found): the same launch
    // again, its minted id unused and its opening still to send.
    if (!this._ranOnce && !this.resumeSessionId && this.sessionName) {
      this.view.restart();
      if (this._forkFrom) { if (this.getBackendKey() === "antigravity") void this._sendFork(); }
      else if (this._opening || this._handoffNote || ["codex", "antigravity"].includes(this.getBackendKey())) void this.sendOpening(this.sessionTitle);
      return;
    }
    const id = this._ownSessionId() || (await this._liveSessionId());
    if (!id) {
      new import_obsidian.Notice("This session has no id yet (it never finished a turn), so it can't be resumed. Start a new one from the sidebar.", 8000);
      return;
    }
    this.resumeSessionId = id;
    this.launchSessionId = null;
    this.sessionName = null;
    this._resumeStep = null;
    this._opening = null;
    this._forkFrom = null;
    this.view.restart();
  }
  // One decision for the tab's close and the window's: unsent text, or the agent working
  // (Claude's own report, or Agent Manager's detector for Codex and Antigravity).
  closeReason(this: Session, own: CloseReason | null): CloseReason | null {
    if (this._inert || !this.running || this._closeQuietly) return own;
    const name = this.sessionTitle || this.getBackend().label;
    if (this.hasPendingInput()) return { agent: true, name, draft: true };
    if (own) return { ...own, name };
    if (this.plugin.sessionIsWorking(this)) return { agent: true, name };
    return null;
  }
  closed(this: Session): void {
    if (this._closed) return;
    this._closed = true;
    // Capture what's new before the session goes.
    try { if (this.transcriptGrewSinceReconcile?.()) void this.updateDurableTranscript?.(); } catch { /* best effort */ }
    this.closeTranscript?.();
    this.plugin.scheduleStatusRefresh();
  }

  // ---- A failed restore ----

  // The tab stays open and says why; its session keys are cleared, so nothing finds it
  // as that session (a resume link, the sidebar's open dot), and Enter does nothing:
  // a duplicate restarting would put two writers on one transcript.
  _makeInert(this: Session, message: string, title?: string): void {
    const was = this.sessionTitle;
    this._inert = { message, title: title || `Not restored: ${was || "a session"}` };
    this.sessionTitle = null;
    this.resumeSessionId = null;
    this.launchSessionId = null;
    this._claimedResumeId = null;
    this._notePath = null;
    this._folderPath = null;
    this._ticketLinks = {};
    this._rehostedFrom = null;
    this.rebuildStrip();
    this.view.print(message);
    this.view.refreshHeader();
    this.app.workspace.requestSaveLayout();
    this.plugin.scheduleStatusRefresh();
  }
  restoreFailed(this: Session, message: string): void {
    this._makeInert(message);
  }

  // ---- Launch and resume ----

  // A new session, in the starting folder (the "AGENTS.md folder" setting), or a side
  // chat, in the folder of the session it copies (`_forkFrom`, set by startSession).
  // `reuseId`: a Claude session restored before its first turn keeps its id (and so its pin).
  launchSession(this: Session, subject: string | null | undefined, reuseId: string | null = null): void {
    // Every new session's name passes here, so this is where it's made one plain line.
    const title = plainSessionName(String(subject || "")) || "Untitled";
    this._decided = true;
    this.sessionTitle = title;
    this.sessionName = title;
    this.resumeSessionId = null;
    this._resumeStep = null;
    this._resetSessionIdentity();
    this._launchedAt = Date.now();
    const backendKey = this.getBackendKey();
    this.backendKey = backendKey;
    const fork = this._forkFrom;
    // A fork keeps the agent its source's conversation launched as.
    if (fork) this._launchAgentId = this.plugin.launchAgentOf(fork.id);
    this.launchSessionId = backendKey === "claude" ? (reuseId || this.plugin.newSessionId()) : null;
    // Codex and Antigravity learn their id only once they write a transcript, which is
    // found by a token unique to this launch in the opening (_resolveModelFile). A side
    // chat sends no opening: a Codex fork is its newest rollout, an Antigravity fork the
    // conversation its /fork made.
    this._launchToken = backendKey === "claude" || fork ? null : this.plugin.newSessionId().slice(0, 8);
    this._openingSent = false;
    const start = this.plugin.startDir();
    this.workingDir = fork ? (fork.cwd || null) : (path.resolve(start) === path.resolve(this.plugin.getVaultPath()) ? null : start);
    if (this.workingDir) this.plugin.rememberSessionFolder(this.workingDir).catch(() => {});
    // A Claude side chat's id is minted here, so it's recorded as one at once.
    if (fork && backendKey === "claude") this.plugin.adoptSideChat(this.launchSessionId, null, fork.id).catch(() => {});
    // So is a Claude session's agent; Codex's and Antigravity's once their id is known
    // (updateDurableTranscript).
    if (this.launchSessionId && this._agentId !== undefined) this.plugin.recordSessionAgent(this.launchSessionId, this._agentId, { launchAgentId: this._launchAgentId }).catch(() => {});
    // A session continuing another with nothing to start from is told only to read what
    // it's handed and wait; the plain opening would tell it to read nothing.
    const continuing = !!this._handoffMode && this._handoffMode !== "side-chat";
    this._opening = fork ? null
      : this._setup ? this.plugin.setupOpening(this.agentId())
      : continuing && !this._notePath && !this._folderPath ? [this.plugin.agentOpening(this.agentId()), "Then wait for instructions."].filter(Boolean).join(" ")
      : this.plugin.buildOpening({ notePath: this._notePath || null, folderPath: this._folderPath || null, daily: !!this._daily, agentId: this.agentId() });
    // A setup session never starts without its guide, a restored tab included: it would
    // run with neither its instructions nor the propose-only line.
    if (this._setup && !this._opening) {
      new import_obsidian.Notice("Agent Manager: the setup guide couldn't be written into the plugin's folder, so setup didn't start. Try reloading the plugin.", 10000);
      this.leaf.detach();
      return;
    }
    this._go();
    if (!fork) void this.sendOpening(title);
    else if (backendKey === "antigravity") void this._sendFork();
  }
  // An Antigravity side chat: once the source conversation is up in this tab, type /fork
  // and take the conversation it makes as this tab's own. Antigravity answers "Forked
  // conversation." and leaves the source untouched; the fork's folder appears in its
  // store at once, its transcript only with the first turn. If no fork shows up, this tab
  // is closed (two tabs on one conversation would both write it) and the side chat falls
  // back to a new session that reads the source's transcript note.
  async _sendFork(this: Session): Promise<void> {
    const fork = this._forkFrom;
    if (!fork || this._forkSending) return;
    this._forkSending = true;
    try {
      // The start it's for is the one running once output arrives (asked as the launch
      // is released, the program hasn't started yet).
      if (!(await this.waitForOutput(60000))) {
        // Never left on the source conversation: that tab would write into it.
        if (!this._closed) this._forkFailed(fork, "Antigravity didn't start");
        return;
      }
      const attempt = this._attempt;
      const same = () => this._attempt === attempt && !this._closed && this.running;
      await this.waitForQuiet(1200, 8000);
      if (!(await this.waitPastTrustPrompt()) || !same()) { this._forkFailed(fork, "it asked a question first"); return; }
      const before = new Set(this.plugin.antigravityConversationIds());
      const sentAt = Date.now();
      const sent = await this.submitOpeningLine("/fork");
      if (!same()) return;
      if (!sent) { this._forkFailed(fork, "/fork couldn't be typed"); return; }
      // The proof is Antigravity's own answer to this /fork, on screen below it: "Forked
      // conversation." and then "/resume <the source's id>" to go back (text alone could
      // be a quote, so both lines, in that order, after the /fork), and one new
      // conversation folder made since it was sent.
      const answered = () => {
        const tail = this._terminalTailText(30);
        const at = tail.lastIndexOf("/fork");
        if (at === -1) return false;
        const after = tail.slice(at);
        const done = after.search(/^\s*\S*\s*Forked conversation\./m);
        return done !== -1 && after.indexOf(`/resume ${fork.id}`, done) !== -1;
      };
      let forkId: string | null = null;
      for (let i = 0; i < 100 && same() && !forkId; i++) {
        await new Promise((r) => window.setTimeout(r, 200));
        if (!answered()) continue;
        forkId = this.plugin.newAntigravityConversation(before, sentAt, fork.id);
      }
      if (!same()) return;
      if (!forkId) { this._forkFailed(fork, "no forked conversation appeared"); return; }
      this._forkFrom = null;
      this.resumeSessionId = forkId;
      this._claimedResumeId = forkId;
      await this.plugin.adoptSideChat(forkId, this.sessionTitle, fork.id);
      this.refreshStripId?.();
      this.app.workspace.requestSaveLayout();
      this.plugin.refreshBrowsers();
    } finally {
      this._forkSending = false;
    }
  }
  _forkFailed(this: Session, fork: ForkFrom, why: string): void {
    console.warn(`[Agent Manager] Antigravity /fork failed (${why}); falling back to a side chat that reads the transcript.`);
    this._forkFrom = null;
    const source = this.plugin.sessionObjects().find((v) => v !== this && v._ownSessionId() === fork.id);
    // Close this tab first: it holds the source conversation open.
    this._closeQuietly = true;
    this.leaf?.detach();
    // A new main session continues as one, reading the transcript; a side chat as before.
    if (source && this._noteReplaces) void source.continueSession(this.getBackendKey(), "main", true, true);
    else if (source) void source.pointerSideChat?.(true);
    else new import_obsidian.Notice("Agent Manager: Antigravity couldn't fork this conversation, and its session isn't open to start a side chat from.", INPUT_GUARD_NOTICE_MS);
  }
  // Resume a session from its record. A resume sends nothing.
  resumeSession(this: Session, session: SessionRecord): void {
    this._decided = true;
    this.sessionTitle = session.title || "Untitled";
    this.sessionName = null;
    this.resumeSessionId = session.sessionId || null;
    this.launchSessionId = null;
    this._launchToken = null;
    this._launchedAt = null;
    this._resumeStep = null;
    this._resetSessionIdentity();
    this._opening = null;
    // Its agent is the one recorded for it (agentId); a resume never works it out again.
    // A tab restored before its id was recorded carries what it launched as, and records it.
    if (this._agentId !== undefined && this.resumeSessionId) this.plugin.recordSessionAgent(this.resumeSessionId, this._agentId, { launchAgentId: this._launchAgentId }).catch(() => {});
    if (session.backend && CLI_BACKENDS[session.backend]) this.backendKey = session.backend;
    // Antigravity records no working folder, so its sessions resume in the starting folder.
    const start = this.plugin.startDir();
    const startOrRoot = path.resolve(start) === path.resolve(this.plugin.getVaultPath()) ? null : start;
    this.workingDir = session.cwd || (this.backendKey === "antigravity" ? startOrRoot : null);
    if (this.workingDir) this.plugin.rememberSessionFolder(this.workingDir).catch(() => {});
    // A session started from a note or a folder keeps it when resumed: its transcript
    // note says which (`source`), so its strip icon and its side chats' links come back.
    // A resume never claims the note's main-session; it rewrites it only while it names
    // this session.
    if (!this._notePath && !this._folderPath && this.resumeSessionId) {
      const src = this.plugin.sourceOf(this.resumeSessionId);
      if (src && "notePath" in src) { this._notePath = src.notePath; this._noteClaim = false; }
      else if (src) this._folderPath = src.folderPath;
    }
    // The tickets that know this session, its own included when its source isn't one.
    void this._rebindTickets();
    if (this.backendKey === "antigravity" && this.resumeSessionId) this.plugin.rememberAntigravitySession(this.resumeSessionId).catch(() => {});
    this._go();
  }
  // The session's decided: its strip, its tab, and the program starts.
  _go(this: Session): void {
    this.backendKey = this.getBackendKey();
    this.view.kind = this.backendKey;
    this.rebuildStrip();
    this.view.refreshHeader();
    this.app.workspace.requestSaveLayout();
    this.view.releaseStart();
    this.plugin.scheduleStatusRefresh();
  }

  // ---- Typing into the session ----

  // The opening instruction for a new session, once the CLI is up, past any trust
  // dialog, and never on top of a draft. Bound to the start it was meant for: if the
  // program is started again (a retry without the terminal's additions) before it's
  // sent, it waits for that start instead, at most twice.
  async sendOpening(this: Session, title: string | null): Promise<void> {
    // One at a time: a quick manual restart of a start that never ran asks again, and
    // two loops would both send it.
    if (this._openingPending) return;
    this._openingPending = true;
    try {
      for (let tries = 0; tries < 3; tries++) {
        // The start it's for is the one running once output arrives: asked as a launch
        // is released, the program hasn't started yet.
        await this.waitForOutput(8000);
        const attempt = this._attempt;
        const outcome = await this._sendOpeningOnce(title, attempt);
        if (outcome !== "restarted") return;
        await this._waitForAttempt(attempt, 15000);
      }
    } finally {
      this._openingPending = false;
    }
  }
  async _waitForAttempt(old: number, maxMs: number): Promise<void> {
    const end = Date.now() + maxMs;
    while (Date.now() < end && this._attempt === old && !this._closed) await new Promise((r) => window.setTimeout(r, 100));
  }
  async _sendOpeningOnce(this: Session, title: string | null, attempt: number): Promise<"restarted" | "gone" | "sent"> {
    const same = () => this._attempt === attempt && !this._closed;
    const ready = await this.waitForOutput(8000);
    if (!same()) return "restarted";
    if (!ready || !this.running) return "gone";
    if (this._cliFound === false) return "gone";
    await this.waitForQuiet(1200, 6000);
    let clear = await this.waitPastTrustPrompt();
    if (!same()) return "restarted";
    if (!this.running) return "gone";
    if (!clear) {
      new import_obsidian.Notice("Agent Manager: the new session is asking a question first (a trust or permissions dialog). Answer it, and the opening instruction is sent once it clears.", INPUT_GUARD_NOTICE_MS);
      clear = await this.waitPastTrustPrompt(5 * 60 * 1000);
      if (!same()) return "restarted";
      if (!this.running) return "gone";
      if (!clear) {
        new import_obsidian.Notice("Agent Manager: the session's dialog never cleared, so the opening instruction was not sent.", INPUT_GUARD_NOTICE_MS);
        return "gone";
      }
    }
    this._sessionInteractive = true;
    const bk = this.getBackendKey();
    const marked = bk === "codex" || bk === "antigravity";
    // The launch's title (launchSession), or on a restart of a launch that never ran, the
    // tab's: set either way.
    const parts = [this._opening, marked ? sessionNamePrompt(title as string, this._launchToken) : ""].filter(Boolean);
    const handoff = this._handoffOpeningSuffix();
    if (parts.length || handoff) {
      // A continuing session hears where it comes from first; a side chat's note follows.
      const continuing = !!this._handoffMode && this._handoffMode !== "side-chat";
      const line = continuing ? `${OPENING_LEAD}${handoff} ${parts.join(" ")}` : `${OPENING_LEAD} ${parts.join(" ")}${handoff}`;
      let sent = false;
      // A dialog that shows as the opening goes in holds it back: once the dialog is
      // answered, whatever of the opening reached the prompt is cleared and it's sent again.
      for (let tries = 0; tries < 3 && !sent; tries++) {
        sent = await this.submitOpeningLine(line);
        // Restarted while it waited: the next start gets it, the side chat's note included.
        if (!sent && !same()) return "restarted";
        if (sent || !this.running || !this._dialogShowing()) break;
        if (tries === 0) new import_obsidian.Notice("Agent Manager: the session is asking a question. Answer it, and the opening instruction is sent once it clears.", INPUT_GUARD_NOTICE_MS);
        if (!(await this.waitPastTrustPrompt(5 * 60 * 1000)) || !same()) break;
        await this._clearComposeLine(this._echoProbe(line), attempt);
      }
      if (!sent) {
        if (same() && this.running) new import_obsidian.Notice("Agent Manager: the opening instruction couldn't be sent. Type your first message yourself.", INPUT_GUARD_NOTICE_MS);
        return "gone";
      }
      this._openingSent = true;
    }
    if (same()) this._clearHandoff();
    return "sent";
  }
  // Once the opening that carried it is sent.
  _clearHandoff(): void {
    this._handoffNote = null;
    this._handoffFromBackend = null;
    this._handoffIntent = null;
    this._handoffMode = null;
  }
  _handoffOpeningSuffix(): string {
    if (!this._handoffNote) return "";
    const abs = path.join(this.plugin.getVaultPath(), this._handoffNote);
    // A null name reads CLI_BACKENDS["null"], as it always has: undefined. A name it has
    // has a backend, so the second read is a CliBackend.
    const fromLabel = (isBackendKey(this._handoffFromBackend) && CLI_BACKENDS[this._handoffFromBackend].label)
      || this._handoffFromBackend || "another backend";
    const intent = this._handoffIntent ? ` In progress: ${this._handoffIntent}.` : "";
    // Continue Session: the earlier session's transcript, to read in full, only its end,
    // or only if what this session was given doesn't say enough.
    if (this._handoffMode === "transcript") return ` This session continues work from an earlier ${fromLabel} session, and shares no memory with it. Its full transcript is saved at "${abs}". Read it for the context before anything else.`;
    if (this._handoffMode === "last") return ` This session continues work from an earlier ${fromLabel} session, and shares no memory with it. Its transcript is saved at "${abs}": read only its last message, at the end of the note, unless you need more.`;
    if (this._handoffMode === "pointer") return ` This session continues work from an earlier ${fromLabel} session. If what you've been given doesn't say enough, its transcript is saved at "${abs}".`;
    return ` You are a side chat, started alongside work already underway in a ${fromLabel} session,`
      + ` so we share no conversation memory. The full transcript of that work to date is saved at "${abs}".`
      + ` Read that note for the context, then wait for me to say what this session is for (helping,`
      + ` reviewing, or continuing).${intent}`;
  }
  // Does the prompt hold text the user typed and hasn't sent (draft.ts)?
  hasPendingInput(): boolean {
    return this._draft.pending();
  }
  // Type a line and submit it: the text, then once it shows in the prompt, a separate
  // Enter (sent together, a long line and its CR read as a pasted newline).
  // Nothing is typed, and no Enter sent, while a dialog shows.
  async submitLine(text: string): Promise<boolean> {
    if (!this.running || this._dialogShowing()) return false;
    const attempt = this._attempt;
    const probe = this._echoProbe(text);
    await this._writeInput(text);
    let shown = !probe;
    const deadline = Date.now() + 2000;
    while (!shown && Date.now() < deadline) {
      await new Promise((r) => window.setTimeout(r, 90));
      if (!this.running || this._attempt !== attempt) return false;
      // shown starts true when there's no probe, so the loop runs only with one.
      shown = this._promptShows(probe as EchoProbe);
    }
    if (!shown) console.warn("[Agent Manager] input not echoed by the CLI within 2s; submitting anyway");
    await new Promise((r) => window.setTimeout(r, 180));
    if (!this.running || this._attempt !== attempt) return false;
    // A dialog that appeared while the line went in, unless the line's own text is what
    // matched (a session named "Update available").
    if (this._dialogShowing() && !DIALOG_RE.test(String(text))) return false;
    this.writeRaw("\r");
    return shown;
  }
  async _clearComposeLine(probe: EchoProbe | null, attempt = this._attempt): Promise<void> {
    for (let i = 0; i < 12; i++) {
      if (!this.running || this._attempt !== attempt) return;
      this.writeRaw("\x15");
      await new Promise((r) => window.setTimeout(r, 70));
      if (!probe) return;
      const tail = this._terminalTailText(16).replace(/\s+/g, "");
      if (tail.indexOf(probe.head) === -1 && tail.indexOf(probe.tail) === -1 && !/\[Pastedtext/.test(tail)) return;
    }
  }
  // A long line goes in as one bracketed paste, which the CLI buffers whole however its
  // reads fall (a plain write of a long opening lost all but its last read).
  async _writeInput(text: string): Promise<void> {
    if (!this.running) return;
    const s = String(text);
    const bracketed = s.length > INPUT_PASTE_MIN && this.view.bracketedPaste;
    this.writeRaw(bracketed ? `\x1b[200~${s}\x1b[201~` : s);
  }
  _echoProbe(text: string | null): EchoProbe | null {
    const s = String(text || "").replace(/\s+/g, "");
    if (s.length < 6) return null;
    return { head: s.slice(0, Math.min(14, s.length)), tail: s.slice(-14) };
  }
  _promptShows(probe: EchoProbe): boolean {
    const tail = this._terminalTailText(16).replace(/\s+/g, "");
    if (/\[Pastedtext/.test(tail)) return true;
    return tail.indexOf(probe.head) !== -1 && tail.indexOf(probe.tail) !== -1;
  }
  // The opening, with any draft typed while the session started kept: cleared, the
  // opening sent alone, then the draft typed back, unsent.
  // Bound to the start it began in: a restart partway stops it, so nothing (the draft
  // put back, above all) lands in the next process. A draft it can't put back (a line
  // recalled from history, an edit mid-line) waits for the user to send or clear it.
  async submitOpeningLine(text: string): Promise<boolean> {
    const attempt = this._attempt;
    const same = () => this.running && this._attempt === attempt && !this._closed;
    if (this._draft.pending() && (this._draft.text() === "" || this._draft._unknown || this._draft._moved)) {
      new import_obsidian.Notice("Agent Manager: the new session's prompt has text in it, so the opening instruction waits until you send or clear it.", INPUT_GUARD_NOTICE_MS);
      const end = Date.now() + 5 * 60 * 1000;
      while (this._draft.pending() && same() && Date.now() < end) await new Promise((r) => window.setTimeout(r, 250));
      if (!same()) return false;
      if (this._draft.pending()) {
        new import_obsidian.Notice("Agent Manager: the prompt never cleared, so the opening instruction was not sent.", INPUT_GUARD_NOTICE_MS);
        return false;
      }
      // What cleared it may have opened a dialog (Enter on a recalled /model opens its
      // picker), and the opening's Enter would answer it.
      if (!(await this.waitPastTrustPrompt(5 * 60 * 1000)) || !same()) {
        if (same()) new import_obsidian.Notice("Agent Manager: the session's dialog never cleared, so the opening instruction was not sent.", INPUT_GUARD_NOTICE_MS);
        return false;
      }
    }
    const draft = this._draft.text();
    if (draft) {
      await this._clearComposeLine(this._echoProbe(draft), attempt);
      if (!same()) return false;
    }
    const sent = await this.submitLine(text);
    if (draft && same()) {
      await new Promise((r) => window.setTimeout(r, 120));
      if (same()) await this._writeInput(draft);
    }
    return sent;
  }
  async waitForOutput(maxMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (this.running && this.hasOutput) return true;
      if (this._closed) return false;
      await new Promise((r) => window.setTimeout(r, 50));
    }
    return !!(this.running && this.hasOutput);
  }
  async waitForQuiet(quietMs: number, maxMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (Date.now() - (this.lastOutputAt || 0) >= quietMs) return;
      await new Promise((r) => window.setTimeout(r, 100));
    }
  }
  // A dialog the CLI opens before its prompt (a folder trust question, Claude's warning
  // for skipped permissions, any "Enter to confirm" menu): nothing is typed into it,
  // since an Enter there answers it: an opening's Enter once answered "No, exit" to
  // Claude's skipped-permissions warning, and picked "Update now" on Codex's "Update
  // available" menu, so Codex updated itself.
  // The visible screen only: a dialog that has scrolled away, or a reply that quoted one
  // and scrolled off, isn't showing. Unanchored, since a trust question's answer lines
  // ("Yes, I trust this folder") carry the words mid-line.
  _dialogShowing(): boolean {
    return DIALOG_RE.test(this.view.screenTail(this.view.screenRows || 40));
  }
  // Clear once no dialog shows and the screen has gone quiet with none showing: a second
  // dialog can follow the first (Codex's update menu after a trust question).
  async waitPastTrustPrompt(maxMs = 20000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (!this.running) return false;
      if (!this._dialogShowing()) {
        await this.waitForQuiet(600, 3000);
        if (!this._dialogShowing()) return true;
      }
      await new Promise((r) => window.setTimeout(r, 250));
    }
    return false;
  }

  // ---- The transcript file ----

  // This session's transcript file: by id when known. A fresh Codex or Antigravity
  // launch has no id until the CLI writes its file, so it is found by the launch token
  // its opening carried: among the files of this backend created since the launch and
  // not another tab's, the one whose head holds the token.
  async _resolveModelFile(this: Session): Promise<string | null> {
    const backend = this.getBackendKey();
    const own = this._ownSessionId();
    if (own) {
      // Its own id is never filtered out, whatever vault list it's on.
      const rec = await this.plugin.findSessionById(own, { own: true });
      return rec && rec.backend === backend ? rec.file : null;
    }
    // An Antigravity side chat learns its id from its /fork (_sendFork), never from here.
    if (this._forkFrom && backend === "antigravity") return null;
    if (!this._launchToken && !this._forkFrom) return null;
    let recs: IndexRecord[] = [];
    // The index lists store records (plugin/sessions.ts), each with its id and its file.
    try { recs = (await this.plugin.sessionIndex() as IndexRecord[]).filter((r) => r.backend === backend); } catch { return null; }
    const taken = new Set<string>();
    for (const v of this.plugin.sessionObjects()) if (v !== this && v._modelFile) taken.add(v._modelFile);
    const since = (this._launchedAt || 0) - 2000;
    const born = (f: string): number => { try { const st = fs.statSync(f); return st.birthtimeMs || st.mtimeMs; } catch { return 0; } };
    const marker = `(launch ${this._launchToken})`;
    const fresh = recs.filter((r) => !taken.has(r.file) && !(this._launchedAt && born(r.file) < since)).sort((a, b) => b.mtime - a.mtime);
    // A Codex side chat: the rollout made since its launch whose first line says it was
    // forked from the source ("forked_from_id"). It carries no name marker of its own.
    // Two side chats of one session started together: neither takes an id another tab
    // holds, and the earlier fork goes to the earlier launch.
    if (this._forkFrom) {
      const from = `"forked_from_id":${JSON.stringify(this._forkFrom.id)}`;
      const held = new Set<string | null>();
      for (const v of this.plugin.sessionObjects()) if (v !== this && v._ownSessionId()) held.add(v._ownSessionId());
      const found = fresh.filter((r) => {
        // Inside the branch on _forkFrom, which nothing changes while the list is filtered.
        try { return r.sessionId !== (this._forkFrom as ForkFrom).id && !held.has(r.sessionId) && readFileHead(r.file, 8192).includes(from); } catch { return false; }
      }).sort((a, b) => born(a.file) - born(b.file))[0] || null;
      if (found) this._learnId(found.sessionId);
      return found ? found.file : null;
    }
    let found = fresh.find((r) => {
      try { return readFileHead(r.file, 262144).includes(marker); } catch { return false; }
    }) || null;
    // The opening never went out (a dialog held it, or the user typed first), so there's
    // no token to find: the newest of this backend's files made since the launch.
    if (!found && !this._openingSent) found = fresh[0] || null;
    if (found) this._learnId(found.sessionId);
    return found ? found.file : null;
  }
  // A fresh Codex or Antigravity launch has found its transcript: from now on it is that
  // id everywhere (restore, links, rows), and an Antigravity one is this vault's.
  _learnId(this: Session, id: string | null): void {
    if (!id || this._ownSessionId()) return;
    this.launchSessionId = id;
    this._launchToken = null;
    // A Codex side chat's rollout has no name marker; its name is kept as a rename.
    if (this._forkFrom) { const src = this._forkFrom.id; this._forkFrom = null; this.plugin.adoptSideChat(id, this.sessionTitle, src).catch(() => {}); }
    if (this.getBackendKey() === "antigravity") this.plugin.rememberAntigravitySession(id).catch(() => {});
    this.refreshStripId?.();
    this.app.workspace.requestSaveLayout();
    this.plugin.refreshBrowsers();
  }
}
// A session's type: the class, and every part's methods, which applyParts puts on the
// class's prototype below. Made from the parts themselves, so it can't drift from them.
interface Session extends SessionController, ViewTranscriptMethods, StripMethods, ViewNoteMethods, ViewTicketMethods, IdentityMethods, SessionActionMethods {}
applyParts(SessionController, ViewTranscriptMethods, StripMethods, ViewNoteMethods, ViewTicketMethods, IdentityMethods, SessionActionMethods);
// Is this a session? instanceof finds the class; applyParts above gave every instance the
// parts, which is what Session adds.
// Is `p` the folder `dir` or inside it?
function isInside(p: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}
function isSession(x: unknown): x is Session {
  return x instanceof SessionController;
}
export { SessionController, isSession };
export type { Session };
