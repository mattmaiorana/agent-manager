
import type { TFile, WorkspaceLeaf } from "obsidian";
import { fs, import_obsidian, path } from "../externals.js";
import { VaultTerminal } from "../vault-terminal/core";
import type { TerminalSettings } from "../vault-terminal/settings";
import { DEFAULT_TERMINAL_SETTINGS } from "../vault-terminal/settings";
import { PLAIN_TERMINAL_VIEW_TYPE, SESSION_VIEW_TYPE } from "../sessions/constants.js";
import { SessionController } from "../sessions/controller.js";
import type { AgentManagerPlugin } from "./main.js";
import { notice } from "../vault-terminal/notice";

class TerminalHostMethods {
  terminalSettings(this: AgentManagerPlugin): TerminalSettings {
    const d = this.pluginData;
    const t = (d.terminal && typeof d.terminal === "object" ? d.terminal : {}) as Partial<TerminalSettings> & Record<string, unknown>;
    if (d.terminal !== t || !t.agents) {
      d.terminal = { ...DEFAULT_TERMINAL_SETTINGS, ...t, agents: { ...(t.agents || {}) } };
    } else {
      for (const [k, v] of Object.entries(DEFAULT_TERMINAL_SETTINGS)) if (t[k] === undefined) t[k] = v;
    }
    return d.terminal as TerminalSettings;
  }
  loadTerminal(this: AgentManagerPlugin): void {
    this.terminalSettings();
    this.terminal = new VaultTerminal({
      plugin: this,
      name: "Agent Manager",
      viewType: SESSION_VIEW_TYPE,
      plainViewType: PLAIN_TERMINAL_VIEW_TYPE,
      settingsPath: "Settings → Agent Manager → Terminal",
      settings: () => this.terminalSettings(),
      save: (state) => {
        this.pluginData.terminalState = state;
        return this.savePluginData();
      },
      state: this.pluginData.terminalState,
      controller: (view) => new SessionController(view, this),
      openNote: (file, line) => { this.openNoteFromTerminal(file, line).catch((e) => console.error("[Agent Manager] open note failed:", e)); },
      openUrl: (url) => { this.openUrlFromTerminal(url).catch((e) => console.error("[Agent Manager] open link failed:", e)); },
      openObsidianLink: (link) => {
        if (link.action !== "agent-manager") return false;
        this.handleProtocolLink({ ...link.params, action: link.action }, "terminal").catch((e) => console.error("[Agent Manager] terminal link failed:", e));
        return true;
      },
      windowConfirmed: (win) => this.reloadIfAsked(win),
      windowKept: () => { this._reloadAsked = 0; },
    });
    this.terminal.load();
    this.wrapReloadCommand();
  }
  wrapReloadCommand(this: AgentManagerPlugin): void {
    const cmd = this.app.commands?.commands?.["app:reload"];
    if (!cmd || typeof cmd.callback !== "function" || cmd.callback._agentManagerWrapped) return;
    const original = cmd.callback;
    const wrapped = (...args: unknown[]) => {
      this._reloadAsked = Date.now();
      return original.apply(cmd, args);
    };
    wrapped._agentManagerWrapped = true;
    cmd.callback = wrapped;
    this.register(() => { if (cmd.callback === wrapped) cmd.callback = original; });
  }
  async openNoteFromTerminal(this: AgentManagerPlugin, file: TFile, line?: number): Promise<void> {
    const ws = this.app.workspace;
    const eState = line ? { line: line - 1 } : undefined;
    const md = ws.getLeavesOfType("markdown");
    const already = md.find((l) => l.view?.file?.path === file.path);
    if (already) {
      await this.revealAndFlash(already);
      if (eState) already.setEphemeralState(eState);
      return;
    }
    const last = this.pluginData.notesOpenIn === "new" ? null : this.shownNotesLeaf();
    const target = last && !last.pinned ? last : this.newNotesTab();
    await target.openFile(file, eState ? { eState } : undefined);
    let shown: WorkspaceLeaf | null = target.view?.file?.path === file.path ? target : null;
    if (!shown) ws.iterateAllLeaves((l) => { if (!shown && l.view?.file?.path === file.path) shown = l; });
    ws.setActiveLeaf(shown ?? target, { focus: true });
  }
  async openUrlFromTerminal(this: AgentManagerPlugin, url: string): Promise<void> {
    const viewer = this.app.internalPlugins?.getEnabledPluginById?.("webviewer");
    if (!viewer?.options?.openExternalURLs) { window.open(url); return; }
    const ws = this.app.workspace;
    const leaf = this.newNotesTab();
    await leaf.setViewState({ type: "webviewer", active: true, state: { url, title: url, navigate: true } });
    ws.setActiveLeaf(leaf, { focus: true });
  }
  reloadIfAsked(this: AgentManagerPlugin, win: Window): boolean {
    if (win !== window || !this._reloadAsked || Date.now() - this._reloadAsked > 600000) return false;
    this._reloadAsked = 0;
    win.location.reload();
    return true;
  }
  async openPlainTerminal(this: AgentManagerPlugin, folder = ""): Promise<WorkspaceLeaf | null> {
    if (!this.terminal || !this.app.workspace.layoutReady) return null;
    const vault = this.getVaultPath();
    const cwd = !folder ? vault : path.isAbsolute(folder) ? folder : path.join(vault, (0, import_obsidian.normalizePath)(folder));
    let isDir = false;
    try { isDir = fs.statSync(cwd).isDirectory(); } catch { /* empty */ }
    if (!isDir) { notice(`Agent Manager: there's no folder at ${cwd} to open a terminal in.`); return null; }
    const leaf = this.openTerminalLeaf();
    await leaf.setViewState({ type: PLAIN_TERMINAL_VIEW_TYPE, active: true, state: { kind: "shell", cwd } });
    await this.app.workspace.revealLeaf(leaf);
    return leaf;
  }
  registerPlainTerminal(this: AgentManagerPlugin): void {
    this.addCommand({ id: "open-terminal", name: "Open terminal", callback: () => { void this.openPlainTerminal(); } });
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof import_obsidian.TFolder)) return;
      menu.addItem((item) => item
        .setTitle("Open terminal here")
        .setIcon("terminal-square")
        .setSection("action")
        .onClick(() => { void this.openPlainTerminal(file.isRoot() ? "" : file.path); }));
    }));
  }
  unloadTerminal(this: AgentManagerPlugin): void {
    try { this.terminal?.unload(); } catch (e) { console.error("[Agent Manager] terminal unload failed:", e); }
  }
}
export { TerminalHostMethods };
