
import type { TAbstractFile } from "obsidian";
import { import_obsidian } from "../externals.js";
import { CLI_BACKENDS } from "../constants/backends.js";
import type { BackendKey } from "../constants/backends.js";
import { ChoicePickerModal } from "../ui/modals.js";
import type { Session } from "../types.js";
import type { AgentManagerPlugin } from "./main.js";
class NoteMethods {
  resetNoteWriteback(this: AgentManagerPlugin, view: Session): void {
    view._noteUrlWritten = null;
    view._noteWritten = false;
    view._noteGone = false;
    view._noteTriedAt = 0;
    view._noteGen = (view._noteGen || 0) + 1;
    view.resetTicketWriteback?.();
  }
  newerLaunchFrom(this: AgentManagerPlugin, notePath: string, at: number | null | undefined, self: Session | null): boolean {
    const latest = this._noteLaunches?.get(notePath);
    if (typeof latest === "number" && latest > (at || 0)) return true;
    for (const leaf of this.sessionLeaves()) {
      const v = this.sessionOf(leaf);
      if (v === self) continue;
      const state = v ? { notePath: v._notePath, noteLaunchAt: v._noteLaunchAt } : this.savedSessionState(leaf);
      if (state?.notePath === notePath && typeof state.noteLaunchAt === "number" && state.noteLaunchAt > (at || 0)) return true;
    }
    return false;
  }
  canStartFrom(this: AgentManagerPlugin, file: TAbstractFile): boolean {
    if (file instanceof import_obsidian.TFile) return file.extension === "md";
    return file instanceof import_obsidian.TFolder && !file.isRoot();
  }
  startFromFile(this: AgentManagerPlugin, file: TAbstractFile, backend: BackendKey | null = null): void {
    if (!this.canStartFrom(file)) return;
    const isNote = file instanceof import_obsidian.TFile;
    const title = isNote ? file.basename : file.name;
    const go = (key: BackendKey) => this.startSession(title, null, { backendOverride: key, ...(isNote ? { notePath: file.path } : { folderPath: file.path }) });
    const offered = this.getBrowserBackends();
    const named = backend || (isNote ? this.ticketBackend(file.path) : null);
    if (named || offered.length < 2) { void go(named || offered[0]); return; }
    const def = this.getCurrentBackend();
    const ordered = offered.includes(def) ? [def, ...offered.filter((k) => k !== def)] : offered;
    new ChoicePickerModal(this.app, ordered, {
      placeholder: `Start a session about “${title}” with…`,
      label: (k: BackendKey) => CLI_BACKENDS[k].label,
      onPick: go,
    }).open();
  }
  registerNoteLaunch(this: AgentManagerPlugin): void {
    this.addCommand({
      id: "start-session-from-note",
      name: "Start session from this note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.canStartFrom(file)) return false;
        if (!checking) this.startFromFile(file);
        return true;
      },
    });
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!this.canStartFrom(file)) return;
      menu.addItem((item) => item
        .setTitle("Start agent session")
        .setIcon("bot")
        .setSection("action")
        .onClick(() => this.startFromFile(file)));
    }));
  }
}
export { NoteMethods };
