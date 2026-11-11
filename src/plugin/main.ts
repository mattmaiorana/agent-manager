
import type { App, MarkdownView, PluginManifest, WorkspaceLeaf } from "obsidian";
import { import_obsidian } from "../externals.js";
import { isBackendKey } from "../constants/backends.js";
import { AgentMethods } from "./agents.js";
import { ClaudeModMethods } from "./claude-mod.js";
import { ConfigMethods } from "./config.js";
import { GuideMethods } from "./guides.js";
import { LinkMethods } from "./links.js";
import { NoteMethods } from "./notes.js";
import { SessionMethods } from "./sessions.js";
import { SetupMethods } from "./setup.js";
import { ShellMethods } from "./shell.js";
import { WorkspaceMethods } from "./workspace.js";
import { TerminalHostMethods } from "./terminal-host.js";
import { TicketMethods } from "./tickets.js";
import { SchedulerMethods } from "./scheduler.js";
import type { NewTaskDraft } from "../constants/scheduled.js";
import { RunMethods } from "./runs.js";
import { SessionRunMethods } from "./session-runs.js";
import { ClockMethods } from "./clock.js";
import { SafetyMethods } from "./safety.js";
import type { LiveRun } from "./runs.js";
import { AgentManagerSettingsTab } from "../settings/tab.js";
import { BrowserView } from "../browser/view.js";
import { BROWSER_VIEW_TYPE, PLAIN_TERMINAL_VIEW_TYPE, SESSION_VIEW_TYPE } from "../sessions/constants.js";
import { sessionLinkLabels } from "../notes/link-pills.js";
import { TranscriptMethods } from "../transcripts/plugin-transcripts.js";
import { ConfirmModal } from "../ui/modals.js";
import { applyParts } from "../util/apply-parts.js";
import { isArray, stringOf } from "../util/guards.js";
import type { PluginData, SavedSessionState, SessionRecord, SetupStatus, TicketCard } from "../types.js";
import type { VaultTerminal } from "../vault-terminal/core";
import type { RunRow } from "../scheduled/run-core.js";
import type { ScheduledTask } from "../scheduled/task-model.js";
import { notice } from "../vault-terminal/notice";
class VaultTerminalPlugin extends import_obsidian.Plugin {
  declare lastRibbonClick: number;
  declare pluginData: PluginData;
  declare lastActiveTerminalLeaf: WorkspaceLeaf | null;
  declare layoutReady: boolean;
  declare ribbonIcon: HTMLElement;
  declare _timeouts: Set<number> | undefined;
  declare _unloading: boolean | undefined;
  declare terminal: VaultTerminal | undefined;
  declare _reloadAsked: number | undefined;
  declare _claudeModDir: string | null | undefined;
  declare _guidesDir: string | null | undefined;
  declare _setup: SetupStatus | undefined;
  declare _setupCheck: Promise<SetupStatus> | null | undefined;
  declare _agentsShared: { at: number; promise: Promise<unknown[]> } | null | undefined;
  declare _headParseCache: Map<string, { mtime: number; value: unknown; read: number }> | undefined;
  declare _headParseRead: number | undefined;
  declare _movedTranscriptNotes: Map<string, string> | undefined;
  declare _codexSubHeads: Map<string, { id: string; parent: string; root: string; title: string } | null> | undefined;
  declare _subagentLists: Map<string, { at: number; dirs: string[] }> | undefined;
  declare _subagentMetas: Map<string, { description?: unknown; agentType?: unknown }> | undefined;
  declare _subagentSizes: Map<string, number> | undefined;
  declare _sessionIndex: { at: number; records: Promise<SessionRecord[]> } | null | undefined;
  declare _lastActivityCache: Map<string, { mtime: number | null | undefined; at: number }> | undefined;
  declare _noteLaunches: Map<string, number | null> | undefined;
  declare _ticketLaunching: Set<string> | undefined;
  declare _ticketActions: Map<MarkdownView, { el: HTMLElement; state: "launch" | "resume" | "run" | "stop" }> | undefined;
  declare _openingToday: Set<string> | undefined;
  declare _openingSetup: boolean | undefined;
  declare _resuming: Set<string> | undefined;
  declare _browserCreateInFlight: boolean | undefined;
  declare _seenWorking: Set<string> | undefined;
  declare _statusRefreshTimer: number | null | undefined;
  declare _lastOpenSig: string | undefined;
  declare _openRoutingAvailable: boolean | undefined;
  declare _sweepScheduled: boolean | undefined;
  declare _unmovableStrays: WeakSet<WorkspaceLeaf> | undefined;
  declare newCardOpen: boolean | undefined;
  declare ticketCard: TicketCard | undefined;
  declare taskCard: { open: boolean; draft: NewTaskDraft } | undefined;
  declare _restoreQueue: Promise<unknown> | undefined;
  declare _taskPaths: Set<string> | null | undefined;
  declare _taskPathsResolved: boolean | undefined;
  declare _taskCache: Promise<{ task: ScheduledTask; runs: RunRow[] }[]> | null | undefined;
  declare _followUpQueue: Promise<string | null> | undefined;
  declare _taskRedraw: number | null | undefined;
  declare _transcriptNotes: string[] | undefined;
  declare _liveRuns: Map<string, LiveRun> | undefined;
  declare _runLogChains: Map<string, Promise<unknown>> | undefined;
  declare _gitChain: Promise<boolean> | undefined;
  declare _ownPids: Set<number> | undefined;
  declare _tickBusy: boolean | undefined;
  declare _waited: Set<string> | undefined;
  declare _safetyRun: Promise<import("../scheduled/safety-core.js").PhaseResult[]> | null | undefined;
  declare _safetyClaude: { at: number; found: { program: string; real: string; version: string; env: Record<string, string> } | { error: string } } | undefined;
  declare _safetyLastSession: string | undefined;
  declare _safetyWaited: Set<string> | undefined;
  declare _busyWaited: Set<string> | undefined;
  declare _startRefused: Map<string, string> | undefined;
  declare _safetyPids: Set<number> | undefined;
  declare _firstTextsCache: Map<string, string[]> | undefined;
  constructor(...args: [app: App, manifest: PluginManifest]) {
    super(...args);
    this.lastRibbonClick = 0;
    this.pluginData = {};
  }
  override async onload(this: AgentManagerPlugin): Promise<void> {
    this.registerInterval(window.setInterval(() => {
      try { this.refreshWorkingDots(); } catch { /* empty */ }
    }, 700));
    this.registerInterval(window.setInterval(() => { void this.schedulerTick(); }, 60000));
    this.registerDomEvent(window, "beforeunload", () => { this._unloading = true; this.killAllRuns(); });
    this.registerInterval(window.setInterval(() => {
      for (const v of this.browserViews()) {
        if (!v.browserScope) { try { v.resortOpenRows(); } catch { /* empty */ } }
      }
    }, 3000));
    this.pluginData = ((await this.loadData()) as PluginData | null) || {};
    this.applyPluginDataDefaults();
    await this.prepareClaudeMod();
    await this.prepareGuides();
    this.loadTerminal();
    this.registerView(BROWSER_VIEW_TYPE, (leaf) => new BrowserView(leaf, this));
    this.applySidebarTitleClass();
    this.lastActiveTerminalLeaf = null;
    this.layoutReady = false;
    this.installOpenRouting();
    this.installTerminalGroupJanitor();
    this.app.workspace.onLayoutReady(() => {
      this.layoutReady = true;
      void this.checkSetup();
      this.cleanupSafetyScratch();
      if (this.scheduledTasksOn()) void this.cleanupLeftoverRuns().catch((e) => console.error("[Agent Manager] leftover run cleanup failed:", e)).then(() => this.schedulerTick());
      this.scheduleTimeout(() => {
        const sessionLeaves = this.app.workspace.getLeavesOfType(SESSION_VIEW_TYPE);
        if (this.pluginData.eagerLoadOnRestart) this.eagerLoadSessions(sessionLeaves);
      }, 0);
      if (this._openRoutingAvailable === false && this.useDedicatedSplit()) {
        this.notify(
          "Agent Manager",
          "This version of Obsidian works differently inside, so notes you open may appear in the terminal's pane for a moment before moving out. Nothing else is affected. Turn off “Dedicated terminal split” in settings to stop this notice.",
          undefined,
          undefined,
          "info"
        );
      }
    });

    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof import_obsidian.TFile) || file.extension !== "md" || !oldPath.endsWith(".md")) return;
      const subs = this.app.vault.getAbstractFileByPath(oldPath.slice(0, -3));
      const to = file.path.slice(0, -3);
      if (!(subs instanceof import_obsidian.TFolder) || this.app.vault.getAbstractFileByPath(to)) return;
      const id: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.session_id;
      if (typeof id !== "string" || !id) return;
      const tc = this._tc();
      void tc.withTranscriptLock(tc.transcriptLockKey(this.folderOf("transcriptsFolder"), id), async () => {
        if (!this.app.vault.getAbstractFileByPath(to)) await this.app.fileManager.renameFile(subs, to);
      }).catch(() => { notice(`Agent Manager: couldn't move the sub-agents' transcripts in “${subs.path}” beside “${file.path}”.`); });
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      const isFolder = file instanceof import_obsidian.TFolder;
      const moved = (p: string | null | undefined): string | null => {
        if (!p) return null;
        if (p === oldPath) return file.path;
        if (isFolder && p.startsWith(oldPath + "/")) return file.path + p.slice(oldPath.length);
        return null;
      };
      const movedSource = (p: string | null | undefined): string | null => {
        if (!p) return null;
        if (!p.endsWith("/")) return moved(p);
        const to = moved(p.slice(0, -1));
        return to ? `${to}/` : null;
      };
      let changed = false;
      for (const leaf of this.sessionLeaves()) {
        const v = this.sessionOf(leaf);
        if (v) {
          const note = moved(v._notePath), folder = moved(v._folderPath);
          if (note) { v._notePath = note; changed = true; }
          if (folder) { v._folderPath = folder; changed = true; }
          const ctxFrom = movedSource(v._contextSource?.from);
          if (ctxFrom && v._contextSource) { v._contextSource = { ...v._contextSource, from: ctxFrom }; changed = true; }
          for (const [p, kind] of Object.entries(v._ticketLinks || {})) {
            const to = moved(p);
            if (to && v._ticketLinks) { delete v._ticketLinks[p]; v._ticketLinks[to] = kind; v.resetTicketWriteback(); changed = true; }
          }
          continue;
        }
        this.updateSavedSession(leaf, (fields: SavedSessionState) => {
          const note = moved(fields.notePath), folder = moved(fields.folderPath);
          if (note) fields.notePath = note;
          if (folder) fields.folderPath = folder;
          const ctxFrom = movedSource(fields.contextSource?.from);
          if (ctxFrom && fields.contextSource) fields.contextSource = { ...fields.contextSource, from: ctxFrom };
          let linked = false;
          for (const [p, kind] of Object.entries(fields.ticketLinks || {})) {
            const to = moved(p);
            if (to && fields.ticketLinks) { delete fields.ticketLinks[p]; fields.ticketLinks[to] = kind; linked = true; }
          }
          return !!(note || folder || ctxFrom || linked);
        }).catch(() => {});
      }
      let sourced = false;
      for (const rec of Object.values(this.pluginData.sessionSources || {})) {
        const to = movedSource(rec.from);
        if (to) { rec.from = to; sourced = true; }
      }
      if (changed) this.app.workspace.requestSaveLayout();
      const start = moved(this.pluginData.startFolder ? this.startFolder() : null);
      if (start) this.pluginData.startFolder = start;
      let named = false;
      for (const key of ["ticketsNote", "customButtonTarget", "ticketTemplate", "overviewTemplate", "taskTemplate", "scheduledFolder"] as const) {
        const to = moved(stringOf(this.pluginData[key] ?? "") || null);
        if (to) { this.pluginData[key] = to; named = true; }
      }
      const transcripts = moved(this.folderOf("transcriptsFolder"));
      if (transcripts) { this.pluginData.names = { ...(this.pluginData.names || {}), transcriptsFolder: transcripts }; named = true; }
      if (isArray(this.pluginData.neverRead)) {
        const list = this.pluginData.neverRead.map((e) => {
          if (typeof e !== "string" || /^[/~]/.test(e.trim())) return e;
          const to = moved((0, import_obsidian.normalizePath)(e.trim().replace(/\/+$/, "")));
          if (to) named = true;
          return to ?? e;
        });
        this.pluginData.neverRead = list;
      }
      const sentFolder = stringOf(this.pluginData.sentFilesFolder ?? "").trim();
      const sentTo = sentFolder && !sentFolder.startsWith("./") ? moved(sentFolder) : null;
      if (sentTo) { this.pluginData.sentFilesFolder = sentTo; named = true; }
      const agents = this.allAgents();
      let agentsMoved = false;
      for (const a of agents) {
        const home = a.home ? moved(a.home) : null;
        if (home) { a.home = home; agentsMoved = true; }
        const notePath = moved(a.instructions || null);
        if (notePath) { a.instructions = notePath; agentsMoved = true; }
      }
      if (agentsMoved) this.pluginData.agents = agents;
      if (start || named || agentsMoved || sourced) this.savePluginData().catch(() => {});
    }));
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        const session = this.sessionOf(leaf);
        if (leaf && (session || leaf.view?.getViewType() === PLAIN_TERMINAL_VIEW_TYPE)) this.lastActiveTerminalLeaf = leaf;
        if (session) {
          if (session.transcriptGrewSinceReconcile?.()) void session.updateDurableTranscript?.();
        }
        for (const v of this.browserViews()) {
          try { v.refreshStatusDots(); } catch { /* empty */ }
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        this.scheduleStatusRefresh();
      })
    );
    const ribbonIcon = this.addRibbonIcon("bot", "Open Agent Manager", () => {
      const now = Date.now();
      if (now - this.lastRibbonClick < 1500) return;
      this.lastRibbonClick = now;
      void this.revealBrowser();
    });
    this.ribbonIcon = ribbonIcon;
    this.addCommand({
      id: "open-sidebar",
      name: "Open the sidebar",
      callback: () => this.revealBrowser()
    });
    this.addCommand({
      id: "new-session",
      name: "New session",
      callback: () => this.startSession("", null)
    });
    this.addCommand({
      id: "set-up-vault",
      name: "Set up this vault (experimental)",
      callback: () => this.openVaultSetup()
    });
    this.addCommand({
      id: "open-session-switcher",
      name: "Switch to a session",
      callback: () => this.openSessionSwitcher()
    });
    this.addCommand({
      id: "import-session-transcript",
      name: "Import a session's transcript",
      callback: () => this.importSessionFlow()
    });
    this.addCommand({
      id: "close-session-tab",
      name: "Close session tab",
      checkCallback: (checking) => {
        const session = this.sessionOf(this.activeLeaf());
        if (session) {
          if (!checking) session.leaf.detach();
          return true;
        }
        return false;
      }
    });
    this.addCommand({
      id: "toggle-session-focus",
      name: "Toggle focus between the editor and a session",
      callback: () => this.toggleFocus()
    });

    this.registerObsidianProtocolHandler("agent-manager", (params) => {
      this.handleProtocolLink(params).catch((e) =>
        console.error("[Agent Manager] protocol link failed:", e));
    });
    this.registerNoteLaunch();
    this.registerPlainTerminal();
    this.registerTickets();
    this.watchScheduledTasks();
    this.registerEditorExtension(sessionLinkLabels());
    this.addSettingTab(new AgentManagerSettingsTab(this.app, this));
  }
  async toggleFocus(this: AgentManagerPlugin): Promise<void> {
    const active = this.activeLeaf();
    if (active && this.terminalLeaves().includes(active)) {
      const leaves = this.app.workspace.getLeavesOfType("markdown");
      const unpinned = leaves.filter(l => !l.pinned);
      const target = unpinned.length > 0 ? unpinned[0] : leaves[0];
      if (target) {
        this.app.workspace.setActiveLeaf(target, { focus: true });
      }
    } else {
      const claudeLeaves = this.terminalLeaves();
      if (claudeLeaves.length > 0) {
        let target = claudeLeaves[0];
        if (this.lastActiveTerminalLeaf && claudeLeaves.includes(this.lastActiveTerminalLeaf)) {
          target = this.lastActiveTerminalLeaf;
        }
        this.app.workspace.setActiveLeaf(target, { focus: true });
        const view = target.view as { focus?: () => void } | null;
        if (view && typeof view.focus === "function") view.focus();
      }
    }
  }
  newSessionId(): string {
    return window.crypto.randomUUID();
  }
  scheduleTimeout(fn: () => void, ms: number): number {
    if (!this._timeouts) this._timeouts = new Set();
    const id = window.setTimeout(() => {
      this._timeouts?.delete(id);
      try { fn(); } catch (e) { console.error("[Agent Manager] timer callback failed:", e); }
    }, ms);
    this._timeouts.add(id);
    return id;
  }
  cancelTimeout(id: number | null | undefined): void {
    if (id == null) return;
    window.clearTimeout(id);
    this._timeouts?.delete(id);
  }
  override onunload(this: AgentManagerPlugin): void {
    this._unloading = true;
    this.killAllRuns();
    this.unloadTerminal();
    for (const id of this._timeouts || []) window.clearTimeout(id);
    this._timeouts?.clear();
    document.body.classList.remove("agent-manager-show-tab-title");
  }
  applySidebarTitleClass(): void {
    document.body.classList.toggle("agent-manager-show-tab-title", this.pluginData.showSidebarTitle === true);
  }
  getVaultPath(): string {
    const adapter = this.app.vault.adapter;
    return adapter.basePath || "";
  }
  async savePluginData(): Promise<void> {
    await this.saveData(this.pluginData);
  }
  applyPluginDataDefaults(): void {
    const d = this.pluginData;
    if (d.cliBackend && !isBackendKey(d.cliBackend)) delete d.cliBackend;
    if (isArray(d.browserBackends)) d.browserBackends = d.browserBackends.filter((k) => isBackendKey(k));
  }

  askConfirm(title: string, body: string, confirmLabel: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(this.app, title, body, () => resolve(true), confirmLabel, "mod-cta");
      const close = modal.onClose.bind(modal);
      modal.onClose = () => { close(); queueMicrotask(() => resolve(false)); };
      modal.open();
    });
  }
  whenLayoutReady(): Promise<void> {
    if (this.layoutReady) return Promise.resolve();
    return new Promise((resolve) => this.app.workspace.onLayoutReady(() => resolve()));
  }
}
interface AgentManagerPlugin extends VaultTerminalPlugin, AgentMethods, ClaudeModMethods, TerminalHostMethods, ShellMethods, TranscriptMethods, ConfigMethods, GuideMethods, NoteMethods, LinkMethods, SessionMethods, SetupMethods, TicketMethods, SchedulerMethods, RunMethods, SessionRunMethods, ClockMethods, SafetyMethods, WorkspaceMethods {}
applyParts(VaultTerminalPlugin, AgentMethods, ClaudeModMethods, TerminalHostMethods, ShellMethods, TranscriptMethods, ConfigMethods, GuideMethods, NoteMethods, LinkMethods, SessionMethods, SetupMethods, TicketMethods, SchedulerMethods, RunMethods, SessionRunMethods, ClockMethods, SafetyMethods, WorkspaceMethods);
export { VaultTerminalPlugin };
export type { AgentManagerPlugin };
