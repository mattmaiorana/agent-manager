// The new terminal (src/vault-terminal/, PORTING.md), hosted by the plugin: one
// VaultTerminal per load, made once the data is in, with its settings under
// pluginData.terminal and its small state under pluginData.terminalState.

import type { TFile } from "obsidian";
import { VaultTerminal } from "../vault-terminal/core";
import type { TerminalSettings } from "../vault-terminal/settings";
import { DEFAULT_TERMINAL_SETTINGS } from "../vault-terminal/settings";
import { SESSION_VIEW_TYPE } from "../sessions/constants.js";
import { SessionController } from "../sessions/controller.js";
import type { AgentManagerPlugin } from "./main.js";

class TerminalHostMethods {
  // The terminal's settings, defaults filled in, in place: the settings controls change
  // this object and then save, so it must be the one pluginData holds.
  terminalSettings(this: AgentManagerPlugin): TerminalSettings {
    const d = this.pluginData;
    // The settings as saved (an object, checked here), each one used as the settings
    // controls wrote it; a missing one gets its default below.
    const t = (d.terminal && typeof d.terminal === "object" ? d.terminal : {}) as Partial<TerminalSettings> & Record<string, unknown>;
    if (d.terminal !== t || !t.agents) {
      d.terminal = { ...DEFAULT_TERMINAL_SETTINGS, ...t, agents: { ...(t.agents || {}) } };
    } else {
      for (const [k, v] of Object.entries(DEFAULT_TERMINAL_SETTINGS)) if (t[k] === undefined) t[k] = v;
    }
    // Filled in above: d.terminal is t with every default in place, or a new object.
    return d.terminal as TerminalSettings;
  }
  // Made after loadData (the terminal reads its settings as it loads, and its login
  // probe can save within a fraction of a second), before the views are registered.
  loadTerminal(this: AgentManagerPlugin): void {
    this.terminalSettings();
    this.terminal = new VaultTerminal({
      plugin: this,
      name: "Agent Manager",
      viewType: SESSION_VIEW_TYPE,
      settingsPath: "Settings → Agent Manager → Terminal",
      settings: () => this.terminalSettings(),
      save: (state) => {
        this.pluginData.terminalState = state;
        return this.savePluginData();
      },
      state: this.pluginData.terminalState,
      // Every tab of the session type is a session (sessions/controller.ts, the terminal's
      // TerminalController).
      controller: (view) => new SessionController(view, this),
      // Notes opened from a terminal go where the plugin's other note opens go: a tab
      // already showing the note, else a markdown tab in the notes group, never a new tab
      // beside the terminal.
      openNote: (file, line) => { this.openNoteFromTerminal(file, line).catch((e) => console.error("[Agent Manager] open note failed:", e)); },
      // A window's close held by a busy session and then confirmed: a reload reloads.
      windowConfirmed: (win) => this.reloadIfAsked(win),
      windowKept: () => { this._reloadAsked = 0; },
    });
    this.terminal.load();
    this.wrapReloadCommand();
  }
  // The terminal's window guard can't tell a reload from a close (both are beforeunload),
  // and after its confirm it closes the window. So Obsidian's reload command (Cmd+R, as
  // for example) marks that a reload was asked for, and a confirmed close then reloads.
  // The mark is cleared when the confirm is cancelled.
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
      ws.setActiveLeaf(already, { focus: true });
      if (eState) already.setEphemeralState(eState);
      return;
    }
    const target = md.filter((l) => !l.pinned)[0] || md[0] || ws.getLeaf(true);
    await target.openFile(file, eState ? { eState } : undefined);
    ws.setActiveLeaf(target, { focus: true });
  }
  reloadIfAsked(this: AgentManagerPlugin, win: Window): boolean {
    // A mark from a reload that went ahead unheld is gone with the page; one older than
    // ten minutes is from a reload something else stopped, and doesn't count.
    if (win !== window || !this._reloadAsked || Date.now() - this._reloadAsked > 600000) return false;
    this._reloadAsked = 0;
    win.location.reload();
    return true;
  }
  unloadTerminal(this: AgentManagerPlugin): void {
    try { this.terminal?.unload(); } catch (e) { console.error("[Agent Manager] terminal unload failed:", e); }
  }
}
export { TerminalHostMethods };
