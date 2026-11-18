
import type { App, Menu, WorkspaceLeaf } from "obsidian";
import { StringDecoder, fs, import_obsidian, path } from "../externals.js";
import { CLI_BACKENDS, INPUT_PASTE_MIN, isBackendKey } from "../constants/backends.js";
import { OPENING_LEAD, SETUP_SESSION_NAME, plainSessionName, sessionNamePrompt } from "../constants/names.js";
import { DIALOG_RE, RC_PANEL_RE } from "./constants.js";
import { splitCommand } from "../vault-terminal/finder";
import { IdentityMethods } from "./identity.js";
import { StripMethods } from "./strip.js";
import { RemoteControlMethods } from "./remote-control.js";
import type { RcState } from "./remote-control.js";
import { SessionActionMethods } from "./session-actions.js";
import { ViewNoteMethods } from "../notes/view-note.js";
import { ViewTicketMethods } from "../notes/view-ticket.js";
import { ViewTranscriptMethods } from "../transcripts/view-transcripts.js";
import { DesignedViewMethods } from "../designed/view-designed.js";
import { FindMethods } from "../transcripts/view-find.js";
import { StreamMethods } from "../designed/view-stream.js";
import { MediaMethods } from "../designed/view-media.js";
import type { AgentCard, AgentResult } from "../designed/view-media.js";
import type { StreamState } from "../designed/view-stream.js";
import type { ShownCard } from "../designed/view-designed.js";
import { DraftTracker } from "./draft.js";
import { readFileHead } from "./transcript-files.js";
import { applyParts } from "../util/apply-parts.js";
import { stringOf } from "../util/guards.js";
import type { BackendKey, CliBackend } from "../constants/backends.js";
import type { AgentManagerPlugin } from "../plugin/main.js";
import type { LinkKind } from "../tickets/session-links.js";
import type { ContextSource, ForkFrom, HandoffMode, IndexRecord, RehostedFrom, SavedSessionState, SessionRecord } from "../types.js";
import type { CloseReason } from "../vault-terminal/close";
import type { HostLaunch, TerminalController } from "../vault-terminal/host";
import type { ExitInfo } from "../vault-terminal/session";
import type { ProgramState } from "../vault-terminal/status";
import type { TerminalView } from "../vault-terminal/view";
import { notice } from "../vault-terminal/notice";

const ATTACH_FAIL_MS = 4000;
const INPUT_SETTLE_MS = 400;

interface EchoProbe {
  head: string;
  tail: string;
}
interface ListedAgent {
  sessionId?: unknown;
  kind?: unknown;
  pid?: unknown;
}

class SessionController implements TerminalController {
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
  declare _savedDraft: string | null;
  declare _puttingBack: boolean | undefined;
  declare _dialogMark: string | null | undefined;
  declare _draftInState: string;
  declare hasOutput: boolean;
  declare lastOutputAt: number;
  declare lastWorkOutputAt: number;
  declare lastUserInputAt: number;
  declare _attempt: number;
  declare _resumeStep: "attach" | "resume" | null;
  declare _quietTools: boolean;
  declare _quietFile: string | null;
  declare _quietOn: boolean;
  declare _quietWatch: { close(): void } | null;
  declare _quietBtnEl: HTMLElement | null;
  declare _quietSending: boolean;
  declare _rc: RcState;
  declare _rcId: string;
  declare _rcEl: HTMLElement | null;
  declare _rcSending: boolean;
  declare _rcWatching: boolean;
  declare _rcSeq: number;
  declare _lineBusy: boolean;
  declare _inputCount: number;
  declare _programPid: number | null;
  declare _inert: { message: string; title: string } | null;
  declare _decided: boolean | undefined;
  declare _stripContainer: HTMLElement | undefined;
  declare _cliFound: boolean | undefined;
  declare _ranOnce: boolean | undefined;
  declare _closed: boolean | undefined;
  declare _closeQuietly: boolean | undefined;
  declare _started: boolean | undefined;
  declare _launchedAt: number | null | undefined;
  declare _programStartedAt: number | undefined;
  declare _launchToken: string | null | undefined;
  declare _opening: string | null | undefined;
  declare _openingWithdrawn: boolean | undefined;
  declare _typingOpening: boolean | undefined;
  declare _scheduledRun: { args: string[]; opening: string; notBefore: number; floorMs: number; contextFrom?: string; ready?: () => boolean } | null | undefined;
  declare _openingSent: boolean | undefined;
  declare _openingPending: boolean | undefined;
  declare _forkSending: boolean | undefined;
  declare _pendingResumeTitle: string | null | undefined;
  declare _pendingResumeId: string | null | undefined;
  declare _sessionInteractive: boolean | undefined;
  declare _notePath: string | null | undefined;
  declare _folderPath: string | null | undefined;
  declare _handoffNote: string | null | undefined;
  declare _handoffFromBackend: string | null | undefined;
  declare _handoffIntent: string | null | undefined;
  declare _handoffMode: HandoffMode | null | undefined;
  declare _daily: boolean | undefined;
  declare _setup: boolean | undefined;
  declare _agentId: string | undefined;
  declare _launchAgentId: string | undefined;
  declare _contextSource: ContextSource | undefined;
  declare _forkFrom: ForkFrom | null | undefined;
  declare _noteSupport: boolean | undefined;
  declare _noteClaim: boolean | undefined;
  declare _noteLaunchAt: number | null | undefined;
  declare _noteUrlWritten: string | null | undefined;
  declare _noteWritten: boolean | undefined;
  declare _noteGone: boolean | undefined;
  declare _noteTriedAt: number | undefined;
  declare _noteGen: number | undefined;
  declare _noteWriting: boolean | undefined;
  declare _notePriorIds: Set<string> | undefined;
  declare _ticketLinks: Record<string, LinkKind | null> | undefined;
  declare _ticketWritten: Record<string, string> | undefined;
  declare _ticketDone: boolean | undefined;
  declare _ticketWriting: boolean | undefined;
  declare _ticketTriedAt: number | undefined;
  declare _ticketGen: number | undefined;
  declare _noteReplaces: boolean | undefined;
  declare _modelFile: string | null | undefined;
  declare _durableReconciledSize: number | undefined;
  declare _durableCaughtUp: boolean | undefined;
  declare _durableMisses: number | undefined;
  declare _durableRetryAt: number | undefined;
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
  declare _wasWorking: boolean | undefined;
  declare _durableCheckedAt: number | undefined;
  declare idEl: HTMLElement | undefined;
  declare agentPillEl: HTMLElement | undefined;
  declare modelEl: HTMLElement | undefined;
  declare transcriptBtnEl: HTMLElement | undefined;
  declare transcriptHost: HTMLElement | null | undefined;
  declare _transcriptBodyEl: HTMLElement | null | undefined;
  declare _transcriptFilePath: string | null | undefined;
  declare _transcriptOpen: boolean | undefined;
  declare _transcriptTimer: number | null | undefined;
  declare _transcriptOffset: number | undefined;
  declare _transcriptDecoder: InstanceType<typeof StringDecoder> | undefined;
  declare _transcriptCarry: string | undefined;
  declare _transcriptStart: number | undefined;
  declare _transcriptEarlierEl: HTMLElement | null | undefined;
  declare _transcriptLoadingEarlier: boolean | undefined;
  declare _transcriptGen: number | undefined;
  declare _transcriptRefreshing: boolean | undefined;
  declare _modelFileMissAt: number | undefined;
  declare _findBarEl: HTMLElement | null | undefined;
  declare _findInputEl: HTMLInputElement | null | undefined;
  declare _findCountEl: HTMLElement | null | undefined;
  declare _findEarlierEl: HTMLButtonElement | null | undefined;
  declare _findRanges: Range[] | undefined;
  declare _findAt: number | undefined;
  declare _findSearched: number | undefined;
  declare _findCurrentRange: Range | undefined;
  declare _mdOwner: InstanceType<typeof import_obsidian.Component> | null | undefined;
  declare _approvalTabId: string | undefined;
  declare _peersTold: Map<string, number> | undefined;
  declare _wasAsking: boolean | undefined;
  declare _cards: Map<number, ShownCard> | undefined;
  declare _designedFooterEl: HTMLElement | null | undefined;
  declare _designedCardsEl: HTMLElement | null | undefined;
  declare _designedBannerEl: HTMLElement | null | undefined;
  declare _designedWorkingEl: HTMLElement | null | undefined;
  declare _designedSayEl: HTMLElement | null | undefined;
  declare _designedWelcomeEl: HTMLElement | null | undefined;
  declare _welcomeVersionOf: { file: string; version: string } | undefined;
  declare _designedAgentsEl: HTMLElement | null | undefined;
  declare _designedBoxEl: HTMLTextAreaElement | null | undefined;
  declare _pending: HTMLElement[] | undefined;
  declare _lastSent: string | undefined;
  declare _approvalHooked: boolean | undefined;
  declare _stopTimer: number | undefined;
  declare _designedSending: boolean | undefined;
  declare _sentInputCount: number | undefined;
  declare _designedUnhookedEl: HTMLElement | null | undefined;
  declare _designedStopEl: HTMLButtonElement | null | undefined;
  declare _designedWorking: boolean | undefined;
  declare _designedSwitchEl: HTMLElement | null | undefined;
  declare _pickOnce: { model?: string; effort?: string } | undefined;
  declare _restartForPick: boolean | undefined;
  declare _designedModelEl: HTMLElement | null | undefined;
  declare _designedDraftSaved: string | undefined;
  declare _selfAnswer: boolean | undefined;
  declare _prevState: string | null | undefined;
  declare _promptCheckedAt: number | undefined;
  declare _modelStage: { model?: string; effort?: string } | undefined;
  declare _modelPopEl: HTMLElement | null | undefined;
  declare _modelPopClose: (() => void) | undefined;
  declare _modelInfo: { model: string; effort?: string } | null | undefined;
  declare _attachments: { file: File; path?: string }[] | undefined;
  declare _designedChipsEl: HTMLElement | null | undefined;
  declare _hooksBlockedBy: string | null | undefined;
  declare _designedHookNoteEl: HTMLElement | null | undefined;
  declare _chipUrls: string[] | undefined;
  declare _sentHistory: string[] | undefined;
  declare _recallAt: number | undefined;
  declare _stopping: boolean | undefined;
  declare _stopAt: number | undefined;
  declare _turnStartedAt: number | undefined;
  declare _mentionFiles: InstanceType<typeof import_obsidian.TFile>[] | undefined;
  declare _promptCheckedNow: number | undefined;
  declare _defaultViewDone: boolean | undefined;
  declare _savedViewOpen: boolean | undefined;
  declare _streams: Map<string, StreamState> | undefined;
  declare _mediaUrls: string[] | undefined;
  declare _mediaObserver: IntersectionObserver | undefined;
  declare _mediaObserverWin: Window | undefined;
  declare _agentCards: Map<string, AgentCard> | undefined;
  declare _agentResults: Map<string, AgentResult> | undefined;
  declare _agentMetaIds: Map<string, string> | undefined;
  declare _streamTimer: number | undefined;
  declare _streamNextAt: number | undefined;
  declare _landedReplies: Set<string> | undefined;
  declare _streamsEnded: Set<string> | undefined;
  declare _streamTimerWin: Window | undefined;
  declare _mentionEl: HTMLElement | null | undefined;
  declare _mentionHits: InstanceType<typeof import_obsidian.TFile>[] | undefined;
  declare _mentionIndex: number | undefined;
  declare _mentionAt: number | undefined;
  declare _progressTimer: number | undefined;
  declare _workingSince: number | undefined;
  declare _terminalPrompt: boolean | undefined;
  constructor(view: TerminalView, plugin: AgentManagerPlugin) {
    this.view = view;
    this.plugin = plugin;
    this.gated = true;
    this.startHidden = true;
    this.backendKey = null;
    this.workingDir = null;
    this.sessionTitle = null;
    this.sessionName = null;
    this.resumeSessionId = null;
    this.launchSessionId = null;
    this.termHost = null;
    this.stripEl = null;
    this._draft = new DraftTracker();
    this.hasOutput = false;
    this.lastOutputAt = 0;
    this.lastWorkOutputAt = 0;
    this.lastUserInputAt = 0;
    this._attempt = 0;
    this._resumeStep = null;
    this._quietTools = false;
    this._quietFile = null;
    this._quietOn = false;
    this._quietWatch = null;
    this._quietBtnEl = null;
    this._quietSending = false;
    this._rc = "unknown";
    this._rcId = "";
    this._rcEl = null;
    this._rcSending = false;
    this._rcWatching = false;
    this._rcSeq = 0;
    this._inputCount = 0;
    this._programPid = null;
    this._lineBusy = false;
    this._savedDraft = null;
    this._draftInState = "";
    this._inert = null;
  }

  get leaf(): WorkspaceLeaf { return this.view.leaf; }
  get app(): App { return this.view.app; }
  get containerEl(): HTMLElement { return this.view.containerEl; }
  get running(): boolean { return this.view.running; }
  get programPid(): number { return this.view.programPid; }
  get _lastTitle(): string { return this.view.programTitle; }
  get programState(): ProgramState | null { return this.view.state; }
  get backgroundWork(): boolean { return this.view.backgroundWork; }
  writeRaw(data: string): boolean { return this.view.write(data); }
  focusTerminal(): void { this.view.focus(); }
  _terminalTailText(maxLines = 40): string {
    const lines = String(this.view.screenTail(maxLines + 300) || "").split("\n");
    let end = lines.length;
    while (end > 0 && !lines[end - 1].trim()) end--;
    return lines.slice(Math.max(0, end - maxLines), end).join("\n");
  }
  getBackendKey(): BackendKey {
    const key = this.backendKey || this.plugin.pluginData.cliBackend || "claude";
    return isBackendKey(key) ? key : "claude";
  }
  isSetupSession(this: Session): boolean {
    return !!this._setup || this.sessionTitle === SETUP_SESSION_NAME;
  }
  getBackend(): CliBackend {
    return CLI_BACKENDS[this.getBackendKey()];
  }
  get activeBackendKey(): BackendKey { return this.getBackendKey(); }

  name(): string {
    if (this._inert) return this._inert.title;
    return this.sessionTitle || this.getBackend().label;
  }
  icon(): string { return "bot"; }
  agentId(this: Session): string {
    const rec = this.plugin.recordedAgentId(this._ownSessionId());
    return rec !== undefined ? rec : (this._agentId ?? "");
  }
  conversationAgentId(this: Session): string {
    const rec = this.plugin.launchAgentOf(this._ownSessionId());
    return rec !== undefined ? rec : (this._launchAgentId ?? this._agentId ?? "");
  }
  paneMenu(this: Session, menu: Menu): void {
    if (!this._inert) {
      const folder = this.workingDir || this.plugin.getVaultPath();
      menu.addItem((i) => i.setTitle("Open terminal in this folder").setIcon("terminal-square").setSection("action").onClick(() => { void this.plugin.openPlainTerminal(folder); }));
    }
    this.ticketMenu(menu);
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
    if (this._contextSource) state.contextSource = this._contextSource;
    if (this._ticketLinks && Object.keys(this._ticketLinks).length) state.ticketLinks = this._ticketLinks;
    if (this._modelFile || this.resumeSessionId || this._started) state.started = true;
    if (this._launchToken) state.launchToken = this._launchToken;
    if (this._rehostedFrom) state.rehostedFrom = this._rehostedFrom;
    const sid = this._stripSessionId?.();
    if (sid) state.sessionId = sid;
    const boxText = this._designedBoxEl?.value ?? this._designedDraftSaved;
    if (boxText && boxText.trim() && this.plugin.pluginData.keepDrafts !== false) state.designedDraft = boxText;
    if (this.designedOn() && this._defaultViewDone) state.designedViewOpen = !!this._transcriptOpen;
    else if (this._savedViewOpen !== undefined) state.designedViewOpen = this._savedViewOpen;
    const draft = this._draftForState(true);
    if (draft) state.draft = draft;
    return state;
  }
  setState(this: Session, state: SavedSessionState): void {
    if (this._decided) return;
    this._decided = true;
    if (state.awaitLaunch) return;
    if (isBackendKey(state.backendKey)) this.backendKey = state.backendKey;
    if (typeof state.workingDir === "string") this.workingDir = state.workingDir;
    if (state.notePath) this._notePath = state.notePath;
    if (state.folderPath) this._folderPath = state.folderPath;
    if (state.noteSupport) this._noteSupport = true;
    if (state.noteClaim) this._noteClaim = true;
    if (typeof state.noteLaunchAt === "number") this._noteLaunchAt = state.noteLaunchAt;
    if (state.noteReplaces) this._noteReplaces = true;
    if (state.forkFrom && typeof state.forkFrom === "object") this._forkFrom = state.forkFrom;
    if (typeof state.launchToken === "string") this._launchToken = state.launchToken;
    if (state.daily) this._daily = true;
    if (state.setup) this._setup = true;
    if (typeof state.agent === "string") this._agentId = state.agent;
    if (typeof state.launchAgent === "string") this._launchAgentId = state.launchAgent;
    if (state.contextSource && typeof state.contextSource === "object") this._contextSource = { from: typeof state.contextSource.from === "string" ? state.contextSource.from : null, pinned: state.contextSource.pinned === true };
    if (state.ticketLinks && typeof state.ticketLinks === "object") this._ticketLinks = { ...state.ticketLinks };
    if (state.started) this._started = true;
    if (typeof state.designedViewOpen === "boolean") this._savedViewOpen = state.designedViewOpen;
    if (typeof state.designedDraft === "string" && state.designedDraft && this.plugin.pluginData.keepDrafts !== false) this._designedDraftSaved = state.designedDraft;
    if (typeof state.draft === "string" && state.draft && this.plugin.pluginData.keepDrafts !== false && this.backendKey !== "antigravity") this._savedDraft = this._draftInState = state.draft;
    if (state.rehostedFrom && typeof state.rehostedFrom === "object") this._rehostedFrom = state.rehostedFrom;
    if (typeof state.sessionTitle === "string" && state.sessionTitle) {
      this.sessionTitle = state.sessionTitle;
      this._pendingResumeTitle = state.sessionTitle;
      this._pendingResumeId = typeof state.sessionId === "string" ? state.sessionId : null;
      window.setTimeout(() => {
        void this.restoreResumeFromState().catch((e) => {
          console.error("[Agent Manager] restore failed:", e);
          this._makeInert(`Agent Manager couldn't restore “${this.sessionTitle}”: ${stringOf(e && (e as { message?: unknown }).message)}.`);
        });
      }, 0);
      return;
    }
    this._makeInert("This tab has no session to resume. Close it, and start or resume a session from the sidebar.", "No session");
  }
  mount(this: Session, { top, stage }: { top: HTMLElement; stage: HTMLElement }): void {
    this.view.contentEl.addClass("agent-manager-session");
    this.termHost = stage;
    this._stripContainer = top;
    this.closeTranscript?.();
    this.transcriptHost = null;
    this._transcriptBodyEl = null;
    this._transcriptFilePath = null;
    this._designedFooterEl = this._designedCardsEl = this._designedBannerEl = this._designedWorkingEl = this._designedSayEl = this._designedBoxEl = this._designedUnhookedEl = this._designedStopEl = this._designedChipsEl = this._designedModelEl = this._designedHookNoteEl = this._mentionEl = null;
    this._pending = [];
    this._findBarEl?.remove();
    this._findBarEl = this._findInputEl = this._findCountEl = this._findEarlierEl = null;
    this.view.registerDomEvent(stage, "contextmenu", (e) => {
      if (!(this._transcriptOpen && this.transcriptHost && this.transcriptHost.contains(e.target as Node | null))) return;
      e.preventDefault();
      e.stopPropagation();
      const sel = this.view.containerEl.win.getSelection()?.toString() || "";
      const designed = this.designedOn();
      if (designed && !sel) return;
      const menu = new import_obsidian.Menu();
      menu.addItem((i) => i.setTitle("Copy").setIcon("copy").setDisabled(!sel).onClick(() => navigator.clipboard?.writeText(sel).catch(() => {})));
      if (!designed) menu.addItem((i) => i.setTitle("Open transcript note").setIcon("file-text").onClick(() => { void this.openDurableTranscriptNote(); }));
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
  async launch(this: Session, kind: string, plain: boolean): Promise<HostLaunch | { error: string }> {
    const l = await this._launchFor(kind, plain);
    if ("error" in l || l.plain || plain) { this._approvalHooked = false; this._pickOnce = undefined; this._syncDesignedSwitch(); return l; }
    const a = await this._approvalLaunch();
    this._approvalHooked = !!a?.approvals;
    if (!this._approvalHooked) this._syncDesignedSwitch();
    const pick = this.getBackendKey() === "claude" ? this._pickOnce : undefined;
    this._pickOnce = undefined;
    const args = [...(l.args ?? []), ...(pick?.model ? ["--model", pick.model] : []), ...(pick?.effort ? ["--effort", pick.effort] : [])];
    const withPick = pick ? { ...l, args } : l;
    return a ? { ...withPick, claudeHooks: a.claudeHooks, env: { ...l.env, ...a.env } } : withPick;
  }
  async _launchFor(this: Session, kind: string, plain: boolean): Promise<HostLaunch | { error: string }> {
    if (this._inert) return { error: this._inert.message };
    this._attempt++;
    this.hasOutput = false;
    this.lastOutputAt = 0;
    this._draft.clear();
    this._setRc("unknown");
    this._programPid = null;
    const backendKey = this.getBackendKey();
    const backend = CLI_BACKENDS[backendKey];
    const cwd = this.workingDir || this.plugin.getVaultPath();
    const codexServer = backendKey === "codex" && this.plugin.pluginData.codexServer === true;
    const global = backendKey === "codex" && !codexServer ? ["--no-daemon"] : [];
    if (backendKey === "claude" && this._scheduledRun) global.push(...this._scheduledRun.args);
    const mods = backendKey === "claude" ? this.plugin.claudeModDirs() : { dirs: [], quiet: false };
    for (const dir of mods.dirs) global.push("--plugin-dir", dir);
    this._setQuietTools(mods.quiet);
    if (!mods.quiet) this._stopQuietWatch(true);
    const quietEnv = mods.quiet ? this._prepareQuietState() : null;
    const withQuiet = (l: HostLaunch): HostLaunch => (quietEnv ? { ...l, env: quietEnv } : l);
    const validId = (id: string | null | undefined): string | null => (id && /^[0-9a-fA-F-]{16,}$/.test(id) ? id : null);
    const resumeId = validId(this.resumeSessionId);
    const forkId = validId(this._forkFrom?.id);
    const context = backendKey === "antigravity" ? "" : this._contextSource?.run ? this.plugin.runSystemPrompt(this._contextSource.from) : this.plugin.pinnedContext(this._contextSource?.from);
    global.push(...this.plugin.agentLaunchArgs(backendKey, this.conversationAgentId(), !!(resumeId || forkId), resumeId || forkId, context));
    const addDirs = this.plugin.addedFolders().filter((d) => path.resolve(d) !== path.resolve(cwd));
    const guides = backendKey === "claude" && this.isSetupSession() ? this.plugin.guidesDir() : null;
    if (guides && !isInside(guides, cwd) && !addDirs.some((d) => isInside(guides, d))) addDirs.push(guides);
    if (addDirs.length && backend.addDirFlag) {
      for (const dir of addDirs) global.push(backend.addDirFlag, dir);
      if (backend.addDirWriteFlags) global.push(...splitCommand(backend.addDirWriteFlags));
    }
    if (forkId && !this.resumeSessionId) {
      if (backendKey === "claude") {
        const args = [...global, "--resume", forkId, "--fork-session"];
        if (this.launchSessionId) args.push("--session-id", this.launchSessionId);
        if (this.sessionName) args.push(backend.nameFlag as string, this.sessionName);
        return withQuiet({ args, folder: this.workingDir || "" });
      }
      if (backendKey === "codex") return { args: [...global, "fork", forkId], folder: this.workingDir || "" };
      return { args: [...global, ...splitCommand(backend.resumeByIdFlag), forkId], folder: this.workingDir || "" };
    }
    const id = resumeId;
    if (id && backend.resumeByIdFlag) {
      if (backendKey === "claude") {
        if (this._resumeStep === null) this._resumeStep = this._scheduledRun ? "resume" : (await this._liveAgentFor(id)) === false ? "resume" : "attach";
        if (this._resumeStep === "attach") { this._setQuietTools(false); this._stopQuietWatch(true); return { args: ["attach", id.split("-")[0]], folder: this.workingDir || "", plain: true }; }
        return withQuiet({ args: [...global, backend.resumeByIdFlag, id], folder: this.workingDir || "" });
      }
      return { args: [...global, ...splitCommand(backend.resumeByIdFlag), id], folder: this.workingDir || "" };
    }
    const args = [...global];
    if (this.sessionName && backend.nameFlag) args.push(backend.nameFlag, this.sessionName);
    if (this.launchSessionId && backendKey === "claude" && /^[0-9a-f-]{36}$/.test(this.launchSessionId)) args.push("--session-id", this.launchSessionId);
    return withQuiet({ args, folder: this.workingDir || "" });
  }
  async _liveAgentFor(id: string): Promise<boolean | null> {
    try {
      const agents = await this.plugin.listClaudeAgentsShared();
      return agents.some((a) => a && stringOf((a as ListedAgent).sessionId) === id && (a as ListedAgent).kind === "background" && (a as ListedAgent).pid);
    } catch {
      return null;
    }
  }
  started(this: Session, pid: number): void {
    this._applyDefaultView();
    if (this._scheduledRun) this._scheduledRun.notBefore = Math.max(this._scheduledRun.notBefore, Date.now() + this._scheduledRun.floorMs);
    this._programPid = pid;
    this._programStartedAt = Date.now();
    this._cliFound = true;
    this._ranOnce = true;
    this.plugin.scheduleStatusRefresh();
  }
  launchFailed(this: Session, message: string): void {
    this._cliFound = false;
    this._defaultViewDone = true;
    this._syncDesignedSwitch();
    this.plugin.scheduleStatusRefresh();
  }
  output(text: string): void {
    this.hasOutput = true;
    this.lastOutputAt = Date.now();
    // eslint-disable-next-line no-control-regex -- terminal escape sequences are control characters
    const activity = text.replace(/\x1b\][02];[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
    if (activity.trim()) this.lastWorkOutputAt = Date.now();
  }
  input(this: Session, data: string): void {
    // eslint-disable-next-line no-control-regex -- terminal escape sequences are control characters
    if (/^(?:\x1b\[[IO])+$/.test(data)) return;
    // eslint-disable-next-line no-control-regex -- terminal escape sequences are control characters
    if (!/^(?:\x1b\[<[\d;]+[Mm]|\x1b\[M[\s\S]{3})+$/.test(data)) this._inputCount++;
    this._rcTyped(data);
    // eslint-disable-next-line no-control-regex -- the keys are control characters
    if (this._cards?.size && /^(?:\r|\x1b)$/.test(data)) this._clearCards(true);
    if (this.programState === "waiting" && /^[0-9]$/.test(data) && this.view.inputLooksEmpty() === null) {
      this.lastUserInputAt = Date.now();
      const attempt = this._attempt;
      window.setTimeout(() => {
        if (this._attempt !== attempt) return;
        if (this.programState !== "waiting") { this._clearCards(true); return; }
        if (this.view.inputLooksEmpty() === null) return;
        this._clearCards(true);
        this.view.answeredByHost();
      }, 500);
      return;
    }
    this._draft.feed(data, this.getBackendKey());
    if (this._puttingBack && this._dialogShowing()) this._dialogMark = this._draftMark();
    this.lastUserInputAt = Date.now();
    this._draftChanged();
  }
  inputCleared(): void {
    this._draft.clear();
    this._draftChanged();
  }
  inputMoved(): void {
    this._draft.moved();
  }
  inputEdited(): void {
    this._draft.edited();
    this._draftChanged();
  }
  inputRead(text: string, atEnd: boolean): void {
    this._draft.read(text, atEnd);
    this._draftChanged();
  }
  dialogShowing(): boolean {
    return this._dialogShowing();
  }
  notifiesItself(): boolean {
    return !!this._scheduledRun;
  }
  stateChange(this: Session, state: ProgramState | null): void {
    if (state === "working") this._sessionInteractive = true;
    this._designedState(state);
    this._syncAsking();
  }
  _syncAsking(this: Session): void {
    const asking = this._askingYou();
    if (asking === !!this._wasAsking) return;
    this._wasAsking = asking;
    for (const v of this.plugin.browserViews()) { try { v.refreshWaiting(); } catch { /* empty */ } }
  }
  exit(this: Session, info: ExitInfo): boolean {
    this.plugin.scheduleStatusRefresh();
    if (this._restartForPick) {
      this._restartForPick = false;
      window.setTimeout(() => { void this._restartBySession().catch((e) => console.error("[Agent Manager] restart failed:", e)); }, 0);
      return true;
    }
    this._setRc("unknown");
    if (this._resumeStep === "attach") {
      const ran = info.ran !== undefined ? info.ran * 1000 : 0;
      this._resumeStep = "resume";
      if (!info.closed && info.code !== 0 && ran < ATTACH_FAIL_MS) {
        window.setTimeout(() => this.view.restart(), 0);
        return true;
      }
    }
    try { if (this.transcriptGrewSinceReconcile?.()) void this.updateDurableTranscript?.(); } catch { /* empty */ }
    return false;
  }
  restart(this: Session): void {
    if (this._inert) return;
    this._restartBySession().catch((e) => console.error("[Agent Manager] restart failed:", e));
  }
  async _restartBySession(this: Session): Promise<void> {
    if (!this._ranOnce && !this.resumeSessionId && this.sessionName) {
      this.view.restart();
      if (this._forkFrom) { if (this.getBackendKey() === "antigravity") void this._sendFork(); }
      else if (this._opening || this._handoffNote || ["codex", "antigravity"].includes(this.getBackendKey())) void this.sendOpening(this.sessionTitle);
      return;
    }
    const id = this._ownSessionId() || (await this._liveSessionId());
    if (!id) {
      notice({ head: "This session can't be resumed", detail: "It has no id yet (it never finished a turn). Start a new one from the sidebar." });
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
  closeReason(this: Session, own: CloseReason | null): CloseReason | null {
    if (this._closeQuietly) return own?.background ? null : own;
    const name = this.sessionTitle || this.getBackend().label;
    if (!this._inert && (this._designedBoxEl?.value.trim() || this._designedDraftSaved?.trim() || this._attachments?.length)) return { agent: true, name, draft: true };
    if (this._inert || !this.running) return own;
    if (this.hasPendingInput()) return { agent: true, name, draft: true };
    if (own) return { ...own, name };
    if (this.plugin.sessionIsWorking(this)) return { agent: true, name };
    return null;
  }
  closed(this: Session): void {
    if (this._closed) return;
    this._closed = true;
    try { if (this.transcriptGrewSinceReconcile?.()) void this.updateDurableTranscript?.(); } catch { /* empty */ }
    this.closeTranscript?.();
    this._clearMedia?.();
    this._transcriptGen = (this._transcriptGen || 0) + 1;
    this._clearStreams();
    this._mdOwner?.unload();
    this._mdOwner = null;
    this._approvalClose();
    this._closeModelPop();
    this._stopQuietWatch(true);
    this.plugin.scheduleStatusRefresh();
  }

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

  launchSession(this: Session, subject: string | null | undefined, reuseId: string | null = null): void {
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
    if (fork) { this._launchAgentId = this.plugin.launchAgentOf(fork.id); this.refreshStripAgent(); }
    const pins = backendKey !== "antigravity";
    if (fork) {
      const from = this.plugin.contextSourceOf(fork.id);
      const rec = this.plugin.recordedContextSource(fork.id);
      this._contextSource = { from, pinned: backendKey === "claude" ? !!this.plugin.pinnedContext(from, !!rec?.run) : !!rec?.pinned && pins, ...(rec?.run ? { run: true } : {}) };
    } else if (this._scheduledRun?.contextFrom) {
      const from = this._scheduledRun.contextFrom;
      this._contextSource = { from, pinned: pins && !!this.plugin.pinnedContext(from, true), run: true };
    } else {
      const from = this._setup ? null : this.plugin.sourceString({ notePath: this._notePath, folderPath: this._folderPath });
      this._contextSource = { from, pinned: pins && !!this.plugin.pinnedContext(from) };
    }
    this.launchSessionId = backendKey === "claude" ? (reuseId || this.plugin.newSessionId()) : null;
    this._launchToken = backendKey === "claude" || fork ? null : this.plugin.newSessionId().slice(0, 8);
    this._openingSent = false;
    const start = this.plugin.startDir();
    this.workingDir = fork ? (fork.cwd || null) : (path.resolve(start) === path.resolve(this.plugin.getVaultPath()) ? null : start);
    if (this.workingDir) this.plugin.rememberSessionFolder(this.workingDir).catch(() => {});
    if (fork && backendKey === "claude") this.plugin.adoptSideChat(this.launchSessionId, null, fork.id).catch(() => {});
    if (this.launchSessionId && this._agentId !== undefined) this.plugin.recordSessionAgent(this.launchSessionId, this._agentId, { launchAgentId: this._launchAgentId }).catch(() => {});
    if (this.launchSessionId) this.plugin.recordContextSource(this.launchSessionId, this._contextSource).catch(() => {});
    const continuing = !!this._handoffMode && this._handoffMode !== "side-chat";
    this._opening = this._scheduledRun ? this._scheduledRun.opening
      : fork ? null
      : this._setup ? this.plugin.setupOpening(this.agentId())
      : continuing && !this._notePath && !this._folderPath ? [this.plugin.agentOpening(this.agentId()), "Then wait for instructions."].filter(Boolean).join(" ")
      : this.plugin.buildOpening({ notePath: this._notePath || null, folderPath: this._folderPath || null, daily: !!this._daily, agentId: this.agentId() });
    if (this._setup && !this._opening) {
      this.leaf.detach();
      this.plugin.notify({ head: "Setup didn't start", detail: "The setup guide couldn't be written into the plugin's folder. Try reloading the plugin." });
      return;
    }
    this._go();
    if (!fork) void this.sendOpening(title);
    else if (backendKey === "antigravity") void this._sendFork();
  }
  async _sendFork(this: Session): Promise<void> {
    const fork = this._forkFrom;
    if (!fork || this._forkSending) return;
    this._forkSending = true;
    try {
      if (!(await this.waitForOutput(60000))) {
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
    this._closeQuietly = true;
    this.leaf?.detach();
    if (source && this._noteReplaces) void source.continueSession(this.getBackendKey(), "main", true, true);
    else if (source) void source.pointerSideChat?.(true);
    else notice({ head: "No side chat started", detail: "Antigravity couldn't fork this conversation, and its session isn't open to start one from." });
  }
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
    if (this._agentId !== undefined && this.resumeSessionId) this.plugin.recordSessionAgent(this.resumeSessionId, this._agentId, { launchAgentId: this._launchAgentId }).catch(() => {});
    if (this._contextSource && this.resumeSessionId) this.plugin.recordContextSource(this.resumeSessionId, this._contextSource).catch(() => {});
    const rec = this.plugin.recordedContextSource(this.resumeSessionId);
    if (this._scheduledRun?.contextFrom) {
      const from = this._scheduledRun.contextFrom;
      this._contextSource = { from, pinned: this.backendKey !== "antigravity" && !!this.plugin.pinnedContext(from, true), run: true };
      if (this.resumeSessionId) {
        const map = this.plugin.pluginData.sessionSources || (this.plugin.pluginData.sessionSources = {});
        map[this.resumeSessionId] = { from, pinned: this._contextSource.pinned, run: true };
        this.plugin.savePluginData().catch(() => {});
      }
    }
    else if (rec) {
      const from = this.plugin.contextSourceOf(this.resumeSessionId);
      if (from !== rec.from) { rec.from = from; this.plugin.savePluginData().catch(() => {}); }
      this._contextSource = { from, pinned: rec.pinned, ...(rec.run ? { run: true } : {}) };
    }
    else if (!this._contextSource) {
      const from = this.plugin.contextSourceOf(this.resumeSessionId);
      if (from) this._contextSource = { from, pinned: false };
    }
    if (session.backend && CLI_BACKENDS[session.backend]) this.backendKey = session.backend;
    const start = this.plugin.startDir();
    const startOrRoot = path.resolve(start) === path.resolve(this.plugin.getVaultPath()) ? null : start;
    this.workingDir = session.cwd || (this.backendKey === "antigravity" ? startOrRoot : null);
    if (this.workingDir) this.plugin.rememberSessionFolder(this.workingDir).catch(() => {});
    if (!this._notePath && !this._folderPath && this.resumeSessionId) {
      const src = this.plugin.sourceOf(this.resumeSessionId);
      if (src && "notePath" in src) { this._notePath = src.notePath; this._noteClaim = false; }
      else if (src) this._folderPath = src.folderPath;
    }
    void this._rebindTickets();
    if (this.backendKey === "antigravity" && this.resumeSessionId) this.plugin.rememberAntigravitySession(this.resumeSessionId).catch(() => {});
    this._go();
  }
  _go(this: Session): void {
    this.backendKey = this.getBackendKey();
    this.view.kind = this.backendKey;
    this.rebuildStrip();
    this.view.refreshHeader();
    this.app.workspace.requestSaveLayout();
    this.view.releaseStart();
    this.plugin.scheduleStatusRefresh();
    if (this._savedDraft) void this._putBackDraft();
  }

  async sendOpening(this: Session, title: string | null): Promise<void> {
    if (this._openingPending) return;
    this._openingPending = true;
    try {
      for (let tries = 0; tries < 3; tries++) {
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
    const same = () => this._attempt === attempt && !this._closed && !this._openingWithdrawn;
    const ready = await this.waitForOutput(8000);
    if (!same()) return "restarted";
    if (!ready || !this.running) return "gone";
    if (this._cliFound === false) return "gone";
    await this.waitForQuiet(1200, 6000);
    const wait = this._scheduledRun ? this._scheduledRun.notBefore - Date.now() : 0;
    if (wait > 0) await new Promise((r) => window.setTimeout(r, wait));
    if (!same()) return "restarted";
    const hooksRan = this._scheduledRun?.ready;
    if (hooksRan) {
      const end = Date.now() + 60000;
      while (!hooksRan() && Date.now() < end && same() && this.running) await new Promise((r) => window.setTimeout(r, 250));
      if (!same()) return "restarted";
      if (!hooksRan()) return "gone";
    }
    let clear = await this.waitPastTrustPrompt();
    if (!same()) return "restarted";
    if (!this.running) return "gone";
    if (!clear) {
      this._notifyNeedsYou("New session needs an answer first", "A trust or permissions dialog. The opening is sent once it clears.");
      clear = await this.waitPastTrustPrompt(5 * 60 * 1000);
      if (!same()) return "restarted";
      if (!this.running) return "gone";
      if (!clear) {
        this._notifyNeedsYou("Opening not sent", "Its dialog never cleared.");
        return "gone";
      }
    }
    this._sessionInteractive = true;
    const bk = this.getBackendKey();
    const marked = bk === "codex" || bk === "antigravity";
    const parts = [this._opening, marked ? sessionNamePrompt(title as string, this._launchToken) : ""].filter(Boolean);
    const handoff = this._handoffOpeningSuffix();
    if (parts.length || handoff) {
      const continuing = !!this._handoffMode && this._handoffMode !== "side-chat";
      const line = continuing ? `${OPENING_LEAD}${handoff} ${parts.join(" ")}` : `${OPENING_LEAD} ${parts.join(" ")}${handoff}`;
      let sent = false;
      for (let tries = 0; tries < 3 && !sent; tries++) {
        sent = await this.submitOpeningLine(line);
        if (!sent && !same()) return "restarted";
        if (sent || !this.running || !this._dialogShowing()) break;
        if (tries === 0) this._notifyNeedsYou("New session needs an answer first", "The opening is sent once you answer.");
        if (!(await this.waitPastTrustPrompt(5 * 60 * 1000)) || !same()) break;
        await this._clearComposeLine(this._echoProbe(line), attempt);
      }
      if (!sent) {
        if (same() && this.running) this._notifyNeedsYou("Opening not sent", "Type your first message yourself.");
        return "gone";
      }
      this._openingSent = true;
    }
    if (same()) this._clearHandoff();
    return "sent";
  }
  _clearHandoff(): void {
    this._handoffNote = null;
    this._handoffFromBackend = null;
    this._handoffIntent = null;
    this._handoffMode = null;
  }
  _handoffOpeningSuffix(): string {
    if (!this._handoffNote) return "";
    const abs = path.join(this.plugin.getVaultPath(), this._handoffNote);
    const fromLabel = (isBackendKey(this._handoffFromBackend) && CLI_BACKENDS[this._handoffFromBackend].label)
      || this._handoffFromBackend || "another backend";
    const intent = this._handoffIntent ? ` In progress: ${this._handoffIntent}.` : "";
    if (this._handoffMode === "transcript") return ` This session continues work from an earlier ${fromLabel} session, and shares no memory with it. Its full transcript is saved at "${abs}". Read it for the context before anything else.`;
    if (this._handoffMode === "last") return ` This session continues work from an earlier ${fromLabel} session, and shares no memory with it. Its transcript is saved at "${abs}": read only its last message, at the end of the note, unless you need more.`;
    if (this._handoffMode === "pointer") return ` This session continues work from an earlier ${fromLabel} session. If what you've been given doesn't say enough, its transcript is saved at "${abs}".`;
    return ` You are a side chat, started alongside work already underway in a ${fromLabel} session,`
      + ` so we share no conversation memory. The full transcript of that work to date is saved at "${abs}".`
      + ` Read that note for the context, then wait for me to say what this session is for (helping,`
      + ` reviewing, or continuing).${intent}`;
  }
  _askingYou(this: Session): boolean {
    return this.programState === "waiting" || !!this._cards?.size;
  }
  hasPendingInput(): boolean {
    if (!this._draft.pending()) return false;
    if (!this._draft._unknown && !this._draft._moved) return true;
    if (this.getBackendKey() !== "claude" || Date.now() - this.lastUserInputAt < INPUT_SETTLE_MS) return true;
    return this.view.inputLooksEmpty?.() !== true;
  }
  async submitLine(this: Session, text: string): Promise<boolean> {
    const r = await this._typeLine(text);
    if (r === "busy") this._notifyNeedsYou("Not sent", "Agent Manager is still typing into this session. Try again in a moment.");
    if (r === "typed") {
      const s = String(text);
      const what = s.length > 40 ? `${s.slice(0, 40)}…` : s;
      if (this._draft._unknown || this._draft._moved) this._notifyNeedsYou("Not sent: check the prompt", `You typed while Agent Manager was typing "${what}", so it holds both. Fix it before you send it.`);
      else this._notifyNeedsYou("Not sent", `You typed while Agent Manager was typing "${what}". Your text is back in the prompt.`);
    }
    return r === "shown";
  }
  async _typeLine(this: Session, text: string, mark = this._draftMark(), opts: { paste?: boolean; guard?: () => boolean } = {}): Promise<"shown" | "unshown" | "refused" | "typed" | "busy"> {
    if (!this.running || this._dialogShowing() || this._askingYou()) return "refused";
    if (this._lineBusy) return "busy";
    this._lineBusy = true;
    try {
      return await this._typeLineNow(text, mark, opts);
    } finally {
      this._lineBusy = false;
    }
  }
  async _typeLineNow(this: Session, text: string, typed: string, opts: { paste?: boolean; guard?: () => boolean } = {}): Promise<"shown" | "unshown" | "refused" | "typed"> {
    const attempt = this._attempt;
    const opening = this._typingOpening;
    const live = () => this.running && this._attempt === attempt && !(opening && this._openingWithdrawn);
    const probe = this._echoProbe(text);
    if (this._draftMark() !== typed) return this._typedOver(probe, attempt);
    await this._writeInput(text, opts.paste);
    let shown = !probe;
    const deadline = Date.now() + 2000;
    while (!shown && Date.now() < deadline) {
      await new Promise((r) => window.setTimeout(r, 90));
      if (!live()) return "refused";
      shown = this._promptShows(probe as EchoProbe);
    }
    if (!shown) console.warn("[Agent Manager] input not echoed by the CLI within 2s; submitting anyway");
    await new Promise((r) => window.setTimeout(r, 180));
    if (!live()) return "refused";
    if (this._dialogShowing() && !DIALOG_RE.test(String(text))) return "refused";
    if (this._askingYou() || (opts.guard && !opts.guard())) return "refused";
    if (this._draftMark() !== typed) return this._typedOver(probe, attempt);
    this.writeRaw("\r");
    return shown ? "shown" : "unshown";
  }
  async _typedOver(probe: EchoProbe | null, attempt: number): Promise<"typed"> {
    const d = this._draft;
    for (let i = 0; i < 3; i++) {
      if (d._unknown || d._moved) return "typed";
      const before = this._draftMark();
      await this._clearComposeLine(probe, attempt);
      if (!this.running || this._attempt !== attempt) return "typed";
      if (this._draftMark() !== before) continue;
      if (d.text()) await this._writeInput(d.text());
      return "typed";
    }
    d._unknown = true;
    return "typed";
  }

  _draftForState(screen = false): string {
    if (this.plugin.pluginData.keepDrafts === false || this.getBackendKey() === "antigravity") return "";
    const d = this._draft;
    let known = !d._unknown && d.text() ? d.text() : "";
    if (known && screen && Date.now() - this.lastUserInputAt >= INPUT_SETTLE_MS && this.view.inputLooksEmpty?.() === true) known = "";
    return known || this._savedDraft || "";
  }
  _draftChanged(): void {
    const now = this._draftForState();
    if (now === this._draftInState) return;
    this._draftInState = now;
    this.app.workspace.requestSaveLayout();
  }
  async _putBackDraft(this: Session): Promise<void> {
    this._puttingBack = true;
    this._dialogMark = null;
    try { await this._putBackDraftNow(); } finally { this._puttingBack = false; this._dialogMark = null; }
  }
  async _putBackDraftNow(this: Session): Promise<void> {
    // eslint-disable-next-line no-control-regex -- control characters are what it strips
    const text = (this._savedDraft || "").replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    const done = async (why?: string) => {
      if (why && this.plugin.pluginData.draftClipboard !== true) {
        this._savedDraft = null;
        this._draftChanged();
        this._notifyNeedsYou("Unsent text lost", `Couldn't put it back in the prompt (${why}). Turn on "Copy unsent text that can't be put back" in settings to keep it next time.`);
        return;
      }
      if (why) {
        let copied = false;
        try { await navigator.clipboard.writeText(text); copied = true; } catch { /* empty */ }
        if (!copied) {
          this._notifyNeedsYou("Unsent text not restored yet", `Couldn't put it back in the prompt (${why}), or copy it. Kept with the tab, and tried again after the next reload.`);
          return;
        }
      }
      this._savedDraft = null;
      this._draftChanged();
      if (why) this._notifyNeedsYou("Unsent text on the clipboard", `Couldn't put it back in the prompt (${why}).`);
    };
    if (!text.trim()) return done();
    const end = Date.now() + 5 * 60 * 1000;
    let clear = false;
    for (;;) {
      while (!(this.running && this.hasOutput) && !this._closed && Date.now() < end) await new Promise((r) => window.setTimeout(r, 250));
      if (this._closed) return;
      if (!(this.running && this.hasOutput)) return done("the session didn't start");
      const attempt = this._attempt;
      const same = () => this.running && this._attempt === attempt && !this._closed;
      await this.waitForQuiet(1200, 6000);
      clear = same() && (await this.waitPastTrustPrompt(5 * 60 * 1000));
      if (this._closed) return;
      if (!same()) { if (Date.now() < end) continue; clear = false; }
      break;
    }
    if (!clear) return done("the session was asking a question or restarted");
    if (this._dialogMark != null && this._draftMark() === this._dialogMark) this._draft.clear();
    if (this.getBackendKey() === "claude" && this._draft.pending() && Date.now() - this.lastUserInputAt >= INPUT_SETTLE_MS && this.view.inputLooksEmpty?.() === true) this._draft.clear();
    if (this._draft.pending() || this._lineBusy) return done("the prompt already had text in it");
    if (this.getBackendKey() === "claude" && this.view.inputLooksEmpty?.() === false) return done("the prompt already showed text");
    if (!this.view.bracketedPaste && text.includes("\n")) return done("it has more than one line, and this CLI can't take a paste");
    this.view.paste(text);
    this._savedDraft = null;
    this._draftChanged();
    this._notifyNeedsYou("Unsent text restored", "Back in the prompt after the reload.");
  }

  _draftMark(): string {
    const d = this._draft;
    return `${this._inputCount}:${d._unknown ? 1 : 0}${d._moved ? 1 : 0}${d.text()}`;
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
  async _writeInput(text: string, paste = false): Promise<void> {
    if (!this.running) return;
    const s = String(text);
    const bracketed = (paste || s.length > INPUT_PASTE_MIN) && this.view.bracketedPaste;
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
  _notifyNeedsYou(head: string, detail?: string, named = true): void {
    this.plugin.notify({ head, ...(named ? { name: this.sessionTitle || "New session" } : {}), ...(detail ? { detail } : {}) }, () => this.view.bringForward(), this.view.noticeKey);
  }
  async submitOpeningLine(this: Session, text: string): Promise<boolean> {
    const attempt = this._attempt;
    const same = () => this.running && this._attempt === attempt && !this._closed && !this._openingWithdrawn;
    for (let tries = 0; tries < 3; tries++) {
      if (this._draft.pending() && (this._draft.text() === "" || this._draft._unknown || this._draft._moved)) {
        this._notifyNeedsYou("Opening waiting", "The prompt has text in it. Send or clear it, and the opening goes.");
        const end = Date.now() + 5 * 60 * 1000;
        while (this._draft.pending() && same() && Date.now() < end) await new Promise((r) => window.setTimeout(r, 250));
        if (!same()) return false;
        if (this._draft.pending()) {
          this._notifyNeedsYou("Opening not sent", "The prompt never cleared.");
          return false;
        }
        if (!(await this.waitPastTrustPrompt(5 * 60 * 1000)) || !same()) {
          if (same()) this._notifyNeedsYou("Opening not sent", "Its dialog never cleared.");
          return false;
        }
      }
      const end = Date.now() + 10000;
      while (this._lineBusy && same() && Date.now() < end) await new Promise((r) => window.setTimeout(r, 100));
      if (!same()) return false;
      const mark = this._draftMark();
      const draft = this._draft.text();
      if (draft) {
        await this._clearComposeLine(this._echoProbe(draft), attempt);
        if (!same()) return false;
      }
      this._typingOpening = true;
      let r: Awaited<ReturnType<Session["_typeLine"]>>;
      try { r = await this._typeLine(text, mark); } finally { this._typingOpening = false; }
      if (r === "busy") continue;
      if (r === "typed") {
        if (!same()) return false;
        continue;
      }
      if (draft && same()) {
        await new Promise((r) => window.setTimeout(r, 120));
        if (same()) await this._writeInput(draft);
      }
      return r === "shown";
    }
    return false;
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
  _dialogShowing(): boolean {
    const screen = this.view.screenTail(this.view.screenRows || 40);
    return DIALOG_RE.test(screen) || RC_PANEL_RE.test(screen);
  }
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

  async _resolveModelFile(this: Session): Promise<string | null> {
    const backend = this.getBackendKey();
    const own = this._ownSessionId();
    if (own) {
      const rec = await this.plugin.findSessionById(own, { own: true });
      return rec && rec.backend === backend ? rec.file : null;
    }
    if (this._forkFrom && backend === "antigravity") return null;
    if (!this._launchToken && !this._forkFrom) return null;
    let recs: IndexRecord[] = [];
    try { recs = (await this.plugin.sessionIndex() as IndexRecord[]).filter((r) => r.backend === backend); } catch { return null; }
    const taken = new Set<string>();
    for (const v of this.plugin.sessionObjects()) if (v !== this && v._modelFile) taken.add(v._modelFile);
    const since = (this._launchedAt || 0) - 2000;
    const born = (f: string): number => { try { const st = fs.statSync(f); return st.birthtimeMs || st.mtimeMs; } catch { return 0; } };
    const marker = `(launch ${this._launchToken})`;
    const fresh = recs.filter((r) => !taken.has(r.file) && !(this._launchedAt && born(r.file) < since)).sort((a, b) => b.mtime - a.mtime);
    if (this._forkFrom) {
      const from = `"forked_from_id":${JSON.stringify(this._forkFrom.id)}`;
      const held = new Set<string | null>();
      for (const v of this.plugin.sessionObjects()) if (v !== this && v._ownSessionId()) held.add(v._ownSessionId());
      const found = fresh.filter((r) => {
        try { return r.sessionId !== (this._forkFrom as ForkFrom).id && !held.has(r.sessionId) && readFileHead(r.file, 8192).includes(from); } catch { return false; }
      }).sort((a, b) => born(a.file) - born(b.file))[0] || null;
      if (found) this._learnId(found.sessionId);
      return found ? found.file : null;
    }
    let found = fresh.find((r) => {
      try { return readFileHead(r.file, 262144).includes(marker); } catch { return false; }
    }) || null;
    if (!found && !this._openingSent) found = fresh[0] || null;
    if (found) this._learnId(found.sessionId);
    return found ? found.file : null;
  }
  _learnId(this: Session, id: string | null): void {
    if (!id || this._ownSessionId()) return;
    this.launchSessionId = id;
    this._launchToken = null;
    if (this._forkFrom) { const src = this._forkFrom.id; this._forkFrom = null; this.plugin.adoptSideChat(id, this.sessionTitle, src).catch(() => {}); }
    if (this.getBackendKey() === "antigravity") this.plugin.rememberAntigravitySession(id).catch(() => {});
    this.refreshStripId?.();
    this.app.workspace.requestSaveLayout();
    this.plugin.refreshBrowsers();
    void this._scanTickets?.();
  }
}
interface Session extends SessionController, ViewTranscriptMethods, FindMethods, StreamMethods, MediaMethods, DesignedViewMethods, StripMethods, RemoteControlMethods, ViewNoteMethods, ViewTicketMethods, IdentityMethods, SessionActionMethods {}
applyParts(SessionController, ViewTranscriptMethods, FindMethods, StreamMethods, MediaMethods, DesignedViewMethods, StripMethods, RemoteControlMethods, ViewNoteMethods, ViewTicketMethods, IdentityMethods, SessionActionMethods);
function isInside(p: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}
function isSession(x: unknown): x is Session {
  return x instanceof SessionController;
}
export { SessionController, isSession };
export type { Session };
