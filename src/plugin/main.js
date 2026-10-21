// The plugin: its lifecycle, sessions, links, and the sidebar.

import { import_obsidian } from "../externals.js";
import { REAL_BACKENDS } from "../constants/backends.js";
import { ConfigMethods } from "./config.js";
import { LinkMethods } from "./links.js";
import { NoteMethods } from "./notes.js";
import { SessionMethods } from "./sessions.js";
import { SetupMethods } from "./setup.js";
import { ShellMethods } from "./shell.js";
import { WorkspaceMethods } from "./workspace.js";
import { TerminalHostMethods } from "./terminal-host.js";
import { AgentManagerSettingsTab } from "../settings/tab.js";
import { BrowserView } from "../browser/view.js";
import { BROWSER_VIEW_TYPE, SESSION_VIEW_TYPE } from "../sessions/constants.js";
import { sessionLinkLabels } from "../notes/link-pills.js";
import { TranscriptMethods } from "../transcripts/plugin-transcripts.js";
import { ConfirmModal } from "../ui/modals.js";
import { applyParts } from "../util/apply-parts.js";
var VaultTerminalPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.lastRibbonClick = 0;
    this.pluginData = {};
  }
  async onload() {
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
    this.pluginData = await this.loadData() || {};
    this.applyPluginDataDefaults();
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
      this.checkSetup();
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
      const moved = (p) => {
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
          continue;
        }
        // A tab Obsidian hasn't loaded yet: its saved fields, so it restores bound.
        this.updateSavedSession(leaf, (fields) => {
          const note = moved(fields.notePath), folder = moved(fields.folderPath);
          if (note) fields.notePath = note;
          if (folder) fields.folderPath = folder;
          return !!(note || folder);
        }).catch(() => {});
      }
      if (changed) this.app.workspace.requestSaveLayout(); // the path persists in view state
      // The AGENTS.md folder follows its folder's rename.
      const start = moved(this.pluginData.startFolder ? this.startFolder() : null);
      if (start) { this.pluginData.startFolder = start; this.savePluginData().catch(() => {}); }
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
          if (session.transcriptGrewSinceReconcile?.()) session.updateDurableTranscript?.();
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
      this.revealBrowser();
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
        const session = this.sessionOf(this.app.workspace.activeLeaf);
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
    this.registerEditorExtension(sessionLinkLabels());
    this.addSettingTab(new AgentManagerSettingsTab(this.app, this));
  }
  async toggleFocus() {
    const activeView = this.sessionOf(this.app.workspace.activeLeaf);
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
  newSessionId() {
    return window.crypto.randomUUID();
  }
  // A setTimeout the plugin owns: tracked so onunload can clear it. Every plugin-level
  // timer (not view-level; views clear their own in dispose) goes through here, since
  // a bare setTimeout would run its callback against a disposed plugin instance.
  scheduleTimeout(fn, ms) {
    if (!this._timeouts) this._timeouts = new Set();
    const id = window.setTimeout(() => {
      this._timeouts.delete(id);
      try { fn(); } catch (e) { console.error("[Agent Manager] timer callback failed:", e); }
    }, ms);
    this._timeouts.add(id);
    return id;
  }
  cancelTimeout(id) {
    if (id == null) return;
    window.clearTimeout(id);
    this._timeouts?.delete(id);
  }
  onunload() {
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
  applySidebarTitleClass() {
    // Off by default; only an explicit true shows it.
    document.body.classList.toggle("agent-manager-show-tab-title", this.pluginData.showSidebarTitle === true);
  }
  getVaultPath() {
    const adapter = this.app.vault.adapter;
    return adapter.basePath || "";
  }
  // Plugin data is one file (data.json: settings, session renames, and pins).
  async savePluginData() {
    await this.saveData(this.pluginData);
  }
  applyPluginDataDefaults() {
    const d = this.pluginData;
    // A stored backend this build does not run falls back to the default.
    if (d.cliBackend && !REAL_BACKENDS.includes(d.cliBackend)) delete d.cliBackend;
    if (Array.isArray(d.browserBackends)) d.browserBackends = d.browserBackends.filter((k) => REAL_BACKENDS.includes(k));
  }

  // A yes-or-no question in a dialog. Resolves true only on the confirm button.
  askConfirm(title, body, confirmLabel) {
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
  whenLayoutReady() {
    if (this.layoutReady) return Promise.resolve();
    return new Promise((resolve) => this.app.workspace.onLayoutReady(() => resolve()));
  }
};
applyParts(VaultTerminalPlugin, TerminalHostMethods, ShellMethods, TranscriptMethods, ConfigMethods, NoteMethods, LinkMethods, SessionMethods, SetupMethods, WorkspaceMethods);
export { VaultTerminalPlugin };
