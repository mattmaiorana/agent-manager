// What this machine has: Python 3 (the terminal's helper runs on it) and which agent
// CLIs are installed; and whether the starting folder has an AGENTS.md. Found in the background once per load, the way the terminal
// itself finds them (its settings' Command and Location, then the login shell's PATH).

import type { TFile } from "obsidian";
import { import_obsidian } from "../externals.js";
import { REAL_BACKENDS } from "../constants/backends.js";
import type { BackendKey } from "../constants/backends.js";
import type { SetupStatus } from "../types.js";
import { errorMessage, hasError, isArray, stringOf } from "../util/guards.js";
import type { VaultTerminal } from "../vault-terminal/core";
import type { AgentManagerPlugin } from "./main.js";
// The AGENTS.md the setup check offers to create: short, plain, and the user's to fill in.
const STARTER_AGENTS_MD = `# AGENTS.md

How AI agents should work here. Claude Code, Codex, and Antigravity read this file at the start of every session. Keep it short, since it's read every time.

## This vault

- It's an Obsidian vault: notes are Markdown files, linked with [[wikilinks]].
- What the vault is for, and how its folders are organized: (fill this in)

## How to work here

- Read a note before changing it, and keep its properties (the frontmatter) intact.
- Ask before deleting, moving, or renaming notes.
- Anything else every session should know: (fill this in)
`;
class SetupMethods {
  // The last check's result, or null before the first one finishes:
  // { python: boolean, installed: { claude: boolean, codex: boolean, antigravity: boolean } }.
  setupStatus(this: AgentManagerPlugin): SetupStatus | null {
    return this._setup || null;
  }
  // Run the check, or join the one running. `again` forgets what was found, for the
  // sidebar's "Check again" after an install. The sidebar re-renders when it lands.
  checkSetup(this: AgentManagerPlugin, again = false): Promise<SetupStatus> {
    if (this._setupCheck && !again) return this._setupCheck;
    if (again) this.terminal?.forgetPython?.();
    const check = (async () => {
      const out: SetupStatus = { python: true, installed: {} };
      if (!this.terminal) return out;
      try { await this.terminal.pythonPath(); } catch { out.python = false; }
      for (const key of REAL_BACKENDS) {
        let found: Awaited<ReturnType<VaultTerminal["agentProgram"]>>;
        try { found = await this.terminal.agentProgram(key); } catch { found = { error: "unknown" }; }
        out.installed[key] = !hasError(found);
      }
      return out;
    })();
    this._setupCheck = check;
    check.then((out) => {
      if (this._setupCheck !== check || this._unloading) return;
      this._setup = out;
      this.refreshBrowsers();
    }).catch(() => { if (this._setupCheck === check) this._setupCheck = null; });
    return check;
  }
  // Does the starting folder lack an AGENTS.md, and the user hasn't dismissed the offer?
  agentsFileMissing(this: AgentManagerPlugin): boolean {
    if (this.startFolderMissing()) return false;
    const path = this.agentsFilePath();
    if (this.app.vault.getAbstractFileByPath(path)) return false;
    const dismissed = isArray(this.pluginData.agentsFileDismissed) ? this.pluginData.agentsFileDismissed : [];
    return !dismissed.includes(this.startFolder());
  }
  // Create the starter AGENTS.md in the starting folder; the file, or null.
  async createAgentsFile(this: AgentManagerPlugin): Promise<TFile | null> {
    const path = this.agentsFilePath();
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) return existing instanceof import_obsidian.TFile ? existing : null;
    try {
      return await this.app.vault.create(path, STARTER_AGENTS_MD);
    } catch (e) {
      new import_obsidian.Notice(`Agent Manager: couldn't create ${path}: ${stringOf(errorMessage(e))}`);
      return null;
    }
  }
  // Stop offering an AGENTS.md for this starting folder.
  async dismissAgentsFile(this: AgentManagerPlugin): Promise<void> {
    const list = isArray(this.pluginData.agentsFileDismissed) ? this.pluginData.agentsFileDismissed : [];
    const folder = this.startFolder();
    if (!list.includes(folder)) this.pluginData.agentsFileDismissed = [...list, folder];
    await this.savePluginData();
  }
  // Is this CLI installed? True until a check says otherwise.
  isInstalled(this: AgentManagerPlugin, key: BackendKey): boolean {
    const s = this.setupStatus();
    return !s || s.installed[key] !== false;
  }
}
export { SetupMethods };
