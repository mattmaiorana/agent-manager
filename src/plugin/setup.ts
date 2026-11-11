
import { REAL_BACKENDS } from "../constants/backends.js";
import type { BackendKey } from "../constants/backends.js";
import type { SetupStatus } from "../types.js";
import { hasError, isArray } from "../util/guards.js";
import type { VaultTerminal } from "../vault-terminal/core";
import type { AgentManagerPlugin } from "./main.js";
class SetupMethods {
  setupStatus(this: AgentManagerPlugin): SetupStatus | null {
    return this._setup || null;
  }
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
  agentsFileMissing(this: AgentManagerPlugin): boolean {
    if (this.startFolderMissing()) return false;
    const path = this.agentsFilePath();
    if (this.app.vault.getAbstractFileByPath(path)) return false;
    const dismissed = isArray(this.pluginData.agentsFileDismissed) ? this.pluginData.agentsFileDismissed : [];
    return !dismissed.includes(this.startFolder());
  }
  async dismissAgentsFile(this: AgentManagerPlugin): Promise<void> {
    const list = isArray(this.pluginData.agentsFileDismissed) ? this.pluginData.agentsFileDismissed : [];
    const folder = this.startFolder();
    if (!list.includes(folder)) this.pluginData.agentsFileDismissed = [...list, folder];
    await this.savePluginData();
  }
  isInstalled(this: AgentManagerPlugin, key: BackendKey): boolean {
    const s = this.setupStatus();
    return !s || s.installed[key] !== false;
  }
}
export { SetupMethods };
