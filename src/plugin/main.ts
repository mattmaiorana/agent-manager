// The plugin: its lifecycle, sessions, links, and the sidebar.

import type { App, PluginManifest, WorkspaceLeaf } from "obsidian";
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
import { AgentManagerSettingsTab } from "../settings/tab.js";
import { BrowserView } from "../browser/view.js";
import { BROWSER_VIEW_TYPE, SESSION_VIEW_TYPE } from "../sessions/constants.js";
import { sessionLinkLabels } from "../notes/link-pills.js";
import { TranscriptMethods } from "../transcripts/plugin-transcripts.js";
import { ConfirmModal } from "../ui/modals.js";
import { applyParts } from "../util/apply-parts.js";
import { isArray, stringOf } from "../util/guards.js";
import type { PluginData, SavedSessionState, SessionRecord, SetupStatus } from "../types.js";
import type { VaultTerminal } from "../vault-terminal/core";
// The class Obsidian loads. Its full type, with every part's methods, is AgentManagerPlugin
// (below): the parts and every method here that calls one take `this` as that.
class VaultTerminalPlugin extends import_obsidian.Plugin {
  // Every field the class or a part sets on the plugin. `declare` adds no code: each is
  // set where it always was (the first two in the constructor), and unset until then.
  declare lastRibbonClick: number;
  declare pluginData: PluginData;
  declare lastActiveTerminalLeaf: WorkspaceLeaf | null;
  declare layoutReady: boolean;
  declare ribbonIcon: HTMLElement;
  declare _timeouts: Set<number> | undefined;
  declare _unloading: boolean | undefined;
  // The terminal (terminal-host.ts).
  declare terminal: VaultTerminal | undefined;
  declare _reloadAsked: number | undefined;
  // The Claude mod's folder (claude-mod.ts).
  declare _claudeModDir: string | null | undefined;
  // The guides' folder (guides.ts).
  declare _guidesDir: string | null | undefined;
  // The setup check (setup.ts).
  declare _setup: SetupStatus | undefined;
  declare _setupCheck: Promise<SetupStatus> | null | undefined;
  // claude agents --json, shared for a few seconds (shell.ts).
  declare _agentsShared: { at: number; promise: Promise<unknown[]> } | null | undefined;
  // The session index and its caches (sessions.ts).
  declare _headParseCache: Map<string, { mtime: number; value: unknown; read: number }> | undefined;
  declare _headParseRead: number | undefined;
  declare _movedTranscriptNotes: Map<string, string> | undefined;
  declare _sessionIndex: { at: number; records: Promise<SessionRecord[]> } | null | undefined;
  declare _lastActivityCache: Map<string, { mtime: number | null | undefined; at: number }> | undefined;
  declare _noteLaunches: Map<string, number | null> | undefined;
  // Tickets whose main session is being started, until its tab exists (startSession).
  declare _ticketLaunching: Set<string> | undefined;
  declare _openingToday: boolean | undefined;
  declare _openingSetup: boolean | undefined;
  declare _resuming: Set<string> | undefined;
  // The workspace (workspace.ts).
  declare _browserCreateInFlight: boolean | undefined;
  declare _seenWorking: Set<string> | undefined;
  declare _statusRefreshTimer: number | null | undefined;
  declare _lastOpenSig: string | undefined;
  declare _openRoutingAvailable: boolean | undefined;
  declare _sweepScheduled: boolean | undefined;
  declare _unmovableStrays: WeakSet<WorkspaceLeaf> | undefined;
  // Set by the sidebar's new-session card (browser/home.js, still JavaScript), and by a
  // session's restore queue and re-host check cache (sessions/identity.ts).
  declare newCardOpen: boolean | undefined;
  declare _restoreQueue: Promise<unknown> | undefined;
  declare _firstTextsCache: Map<string, string[]> | undefined;
  // Obsidian makes the plugin with (app, manifest); every argument goes on to Plugin, as before.
  constructor(...args: [app: App, manifest: PluginManifest]) {
    super(...args);
    this.lastRibbonClick = 0;
    this.pluginData = {};
  }
  override async onload(this: AgentManagerPlugin): Promise<void> {
    // Poll the pulsing "working" dots so they keep pulsing even when the sidebar isn't
    // focused, while a background session works. The method is light and gated on open
    // sessions inside; registerInterval clears it on unload.
    this.registerInterval(window.setInterval(() => {
      try { this.refreshWorkingDots(); } catch { /* best effort */ }
    }, 700));
    // The home page's Open list re-sorts live by last activity.
    this.registerInterval(window.setInterval(() => {
      for (const v of this.browserViews()) {
        if (!v.browserScope) { try { v.resortOpenRows(); } catch { /* best effort */ } }
      }
    }, 3000));
    // data.json as it is: each field is checked where it's read (types.ts, PluginData).
    this.pluginData = ((await this.loadData()) as PluginData | null) || {};
    this.applyPluginDataDefaults();
    // Before the session view is registered (loadTerminal): a plugin reload reopens session
    // tabs as soon as it is, and a Claude start reads the mod's folder (claude-mod.ts).
    await this.prepareClaudeMod();
    // The guides a session reads, such as the setup guide (guides.ts).
    await this.prepareGuides();
    // The data first, then the views: the new terminal reads its settings as it loads.
    this.loadTerminal();
    this.registerView(BROWSER_VIEW_TYPE, (leaf) => new BrowserView(leaf, this));
    this.applySidebarTitleClass();
    this.lastActiveTerminalLeaf = null;
    this.layoutReady = false;
    // Note routing: keep notes out of the terminal group. Both are inert unless the
    // dedicated-split setting is on (checked lazily per call and sweep).
    this.installOpenRouting();
    this.installTerminalGroupJanitor();
    this.app.workspace.onLayoutReady(() => {
      this.layoutReady = true;
      // Python and the CLIs, found in the background; the sidebar updates when it lands.
      void this.checkSetup();
      // A short delay lets Obsidian finish recreating views on a plugin reload.
      this.scheduleTimeout(() => {
        // Eager load (opt-in): Obsidian leaves background session tabs deferred until
        // focused, so a restored session doesn't resume until it's opened. With the
        // setting on, each still-deferred session loads, and so resumes, in the
        // background. Each session tab restores itself as it loads.
        const sessionLeaves = this.app.workspace.getLeavesOfType(SESSION_VIEW_TYPE);
        if (this.pluginData.eagerLoadOnRestart) this.eagerLoadSessions(sessionLeaves);
      }, 0);
      // One-time heads-up if pre-emptive note routing couldn't install (a future
      // Obsidian renamed the internals we wrap) while the split is actually in use.
      // The feature degrades silently otherwise; this makes it visible.
      // File-opening is unaffected; the layout-change janitor still sweeps strays.
      if (this._openRoutingAvailable === false && this.useDedicatedSplit()) {
        new import_obsidian.Notice(
          "Agent Manager: this version of Obsidian works differently inside, so notes you open may appear in the terminal's pane for a moment before moving out. Nothing else is affected. Turn off “Dedicated terminal split” in settings to stop this notice.",
          15000
        );
      }
    });

    // A renamed or moved note or folder keeps the sessions started from it bound: the
    // binding is a vault path on the view, so it follows the rename. A folder rename
    // moves every bound path under it.
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      const isFolder = file instanceof import_obsidian.TFolder;
      const moved = (p: string | null | undefined): string | null => {
        if (!p) return null;
        if (p === oldPath) return file.path;
        if (isFolder && p.startsWith(oldPath + "/")) return file.path + p.slice(oldPath.length);
        return null;
      };
      let changed = false;
      for (const leaf of this.sessionLeaves()) {
        const v = this.sessionOf(leaf);
        if (v) {
          const note = moved(v._notePath), folder = moved(v._folderPath);
          if (note) { v._notePath = note; changed = true; }
          if (folder) { v._folderPath = folder; changed = true; }
          // The tickets it's attached to.
          for (const [p, kind] of Object.entries(v._ticketLinks || {})) {
            const to = moved(p);
            if (to && v._ticketLinks) { delete v._ticketLinks[p]; v._ticketLinks[to] = kind; v.resetTicketWriteback(); changed = true; }
          }
          continue;
        }
        // A tab Obsidian hasn't loaded yet: its saved fields, so it restores bound.
        this.updateSavedSession(leaf, (fields: SavedSessionState) => {
          const note = moved(fields.notePath), folder = moved(fields.folderPath);
          if (note) fields.notePath = note;
          if (folder) fields.folderPath = folder;
          let linked = false;
          for (const [p, kind] of Object.entries(fields.ticketLinks || {})) {
            const to = moved(p);
            if (to && fields.ticketLinks) { delete fields.ticketLinks[p]; fields.ticketLinks[to] = kind; linked = true; }
          }
          return !!(note || folder || linked);
        }).catch(() => {});
      }
      if (changed) this.app.workspace.requestSaveLayout(); // the path persists in view state
      // The AGENTS.md folder follows its folder's rename.
      const start = moved(this.pluginData.startFolder ? this.startFolder() : null);
      if (start) this.pluginData.startFolder = start;
      // So do the notes the settings name: the Tickets button's, and the templates.
      let named = false;
      for (const key of ["ticketsNote", "ticketTemplate", "overviewTemplate"] as const) {
        const to = moved(stringOf(this.pluginData[key] ?? "") || null);
        if (to) { this.pluginData[key] = to; named = true; }
      }
      // And the folders the plugin writes in: transcripts, and sent files when that's a
      // vault path (a "./" one is beside each note, so it has nothing to follow).
      const transcripts = moved(this.folderOf("transcriptsFolder"));
      if (transcripts) { this.pluginData.names = { ...(this.pluginData.names || {}), transcriptsFolder: transcripts }; named = true; }
      const sentFolder = stringOf(this.pluginData.sentFilesFolder ?? "").trim();
      const sentTo = sentFolder && !sentFolder.startsWith("./") ? moved(sentFolder) : null;
      if (sentTo) { this.pluginData.sentFilesFolder = sentTo; named = true; }
      // And each agent's home folder and instructions note.
      const agents = this.allAgents();
      let agentsMoved = false;
      for (const a of agents) {
        const home = a.home ? moved(a.home) : null;
        if (home) { a.home = home; agentsMoved = true; }
        const notePath = moved(a.instructions || null);
        if (notePath) { a.instructions = notePath; agentsMoved = true; }
      }
      if (agentsMoved) this.pluginData.agents = agents;
      if (start || named || agentsMoved) this.savePluginData().catch(() => {});
    }));
    // Track the most recently focused session tab, and keep the browser's active-row
    // highlight in sync. ANY focus change can change which session is active (or move
    // focus off a session entirely), so refresh every open browser's dots + active
    // highlight in place — not only when the browser itself regains focus. In place,
    // never a re-render: a re-render here rebuilds the row out from under the click
    // that moved focus and it needs a second click to register.
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        const session = this.sessionOf(leaf);
        if (session) {
          this.lastActiveTerminalLeaf = leaf;
          // Focusing a session is a natural "is my note current?" moment. Same cheap
          // growth gate as the poll: a stat, and a full read only if new records landed.
          if (session.transcriptGrewSinceReconcile?.()) void session.updateDurableTranscript?.();
        }
        for (const v of this.browserViews()) {
          try { v.refreshStatusDots(); } catch { /* best effort */ }
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        // A tab opening/closing/detaching changes the open set — refresh the
        // browser's dots and "Open sessions" section (gated, so no-op layouts skip).
        this.scheduleStatusRefresh();
      })
    );
    const ribbonIcon = this.addRibbonIcon("bot", "Open Agent Manager", () => {
      const now = Date.now();
      if (now - this.lastRibbonClick < 1500) return; // 1.5s throttle to prevent accidental double-clicks
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
      // No default hotkey: the user assigns one in Obsidian's hotkey settings.
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
          // Through the tab's own guard: it asks first when the agent is working or there's unsent text.
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

    // Links: obsidian://agent-manager?op=resume|new&session=… opens a session from any
    // note. Obsidian overwrites params.action with the registered handler name, so the
    // operation rides `op`, not `action`. See handleProtocolLink.
    this.registerObsidianProtocolHandler("agent-manager", (params) => {
      this.handleProtocolLink(params).catch((e) =>
        console.error("[Agent Manager] protocol link failed:", e));
    });
    this.registerNoteLaunch();
    this.registerTickets();
    this.registerEditorExtension(sessionLinkLabels());
    this.addSettingTab(new AgentManagerSettingsTab(this.app, this));
  }
  async toggleFocus(this: AgentManagerPlugin): Promise<void> {
    const activeView = this.sessionOf(this.activeLeaf());
    if (activeView) {
      // Currently in Claude, go to editor — prefer most recent non-pinned leaf
      const leaves = this.app.workspace.getLeavesOfType("markdown");
      const unpinned = leaves.filter(l => !l.pinned);
      const target = unpinned.length > 0 ? unpinned[0] : leaves[0];
      if (target) {
        this.app.workspace.setActiveLeaf(target, { focus: true });
      }
    } else {
      // Currently in editor, go to Claude (prefer last-active tab)
      const claudeLeaves = this.sessionLeaves();
      if (claudeLeaves.length > 0) {
        let target = claudeLeaves[0];
        if (this.lastActiveTerminalLeaf && claudeLeaves.includes(this.lastActiveTerminalLeaf)) {
          target = this.lastActiveTerminalLeaf;
        }
        this.app.workspace.setActiveLeaf(target, { focus: true });
        this.sessionOf(target)?.focusTerminal();
      }
    }
  }
  // A fresh session id for a Claude launch (`--session-id`). Claude refuses a reused id,
  // so it is minted per launch, never persisted before the CLI has taken it.
  newSessionId(): string {
    return window.crypto.randomUUID();
  }
  // A setTimeout the plugin owns: tracked so onunload can clear it. Every plugin-level
  // timer (not view-level; views clear their own in dispose) goes through here, since
  // a bare setTimeout would run its callback against a disposed plugin instance.
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
    // Every session the terminal started ends with it.
    this.unloadTerminal();
    // Plugin-level timeouts (browser refreshes, the janitor, eager loads) must not
    // fire against this dead instance.
    for (const id of this._timeouts || []) window.clearTimeout(id);
    this._timeouts?.clear();
    document.body.classList.remove("agent-manager-show-tab-title");
  }
  // Reveal the leaf's tab title for this view type only, gated by a
  // body class so the CSS never touches any other plugin's sidebar icon.
  applySidebarTitleClass(): void {
    // Off by default; only an explicit true shows it.
    document.body.classList.toggle("agent-manager-show-tab-title", this.pluginData.showSidebarTitle === true);
  }
  getVaultPath(): string {
    const adapter = this.app.vault.adapter;
    return adapter.basePath || "";
  }
  // Plugin data is one file (data.json: settings, session renames, and pins).
  async savePluginData(): Promise<void> {
    await this.saveData(this.pluginData);
  }
  applyPluginDataDefaults(): void {
    const d = this.pluginData;
    // A stored backend this build does not run falls back to the default.
    if (d.cliBackend && !isBackendKey(d.cliBackend)) delete d.cliBackend;
    if (isArray(d.browserBackends)) d.browserBackends = d.browserBackends.filter((k) => isBackendKey(k));
  }

  // A yes-or-no question in a dialog. Resolves true only on the confirm button.
  askConfirm(title: string, body: string, confirmLabel: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(this.app, title, body, () => resolve(true), confirmLabel, "mod-cta");
      const close = modal.onClose.bind(modal);
      // The confirm button closes the dialog before it confirms, so "no" waits a tick
      // and loses to a "yes" that follows.
      modal.onClose = () => { close(); queueMicrotask(() => resolve(false)); };
      modal.open();
    });
  }
  // Resolve once the workspace is ready to open leaves. onLayoutReady fires its
  // callback immediately when layout is already up, so this is safe post-startup.
  whenLayoutReady(): Promise<void> {
    if (this.layoutReady) return Promise.resolve();
    return new Promise((resolve) => this.app.workspace.onLayoutReady(() => resolve()));
  }
}
// The plugin's type: the class, and every part's methods, which applyParts puts on the
// class's prototype below. Made from the parts themselves, so it can't drift from them;
// a name two parts both define is a type error here, as it's an error in applyParts.
interface AgentManagerPlugin extends VaultTerminalPlugin, AgentMethods, ClaudeModMethods, TerminalHostMethods, ShellMethods, TranscriptMethods, ConfigMethods, GuideMethods, NoteMethods, LinkMethods, SessionMethods, SetupMethods, TicketMethods, WorkspaceMethods {}
applyParts(VaultTerminalPlugin, AgentMethods, ClaudeModMethods, TerminalHostMethods, ShellMethods, TranscriptMethods, ConfigMethods, GuideMethods, NoteMethods, LinkMethods, SessionMethods, SetupMethods, TicketMethods, WorkspaceMethods);
export { VaultTerminalPlugin };
export type { AgentManagerPlugin };
