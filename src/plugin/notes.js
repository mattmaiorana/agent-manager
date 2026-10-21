// Sessions started from a note or a folder, the plugin's side: the command, the file
// menu, and the write-back state each view keeps.

import { import_obsidian } from "../externals.js";
import { CLI_BACKENDS } from "../constants/backends.js";
import { ChoicePickerModal } from "../ui/modals.js";
var NoteMethods = class {
  // Clear a view's note write-back state, so a fresh launch or a followed re-host
  // writes its link again rather than keep the last one.
  resetNoteWriteback(view) {
    view._noteUrlWritten = null;
    view._noteWritten = false;
    view._noteGone = false;
    view._noteTriedAt = 0;
    // A write that began before this reset (a re-host mid-write) mustn't mark the new id done.
    view._noteGen = (view._noteGen || 0) + 1;
  }
  // Was another session started from this note after `at`? It holds the note's links,
  // even if this one learns its id later. Session tabs Obsidian hasn't loaded count too.
  newerLaunchFrom(notePath, at, self) {
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
  // Can a session start from this file? A note, or a folder other than the vault's root.
  canStartFrom(file) {
    if (file instanceof import_obsidian.TFile) return file.extension === "md";
    return file instanceof import_obsidian.TFolder && !file.isRoot();
  }
  // Start a session about a note or a folder, named for it. With more than one CLI
  // offered and none named, a picker asks which, the default first.
  startFromFile(file, backend = null) {
    if (!this.canStartFrom(file)) return;
    const isNote = file instanceof import_obsidian.TFile;
    const title = isNote ? file.basename : file.name;
    const go = (key) => this.startSession(title, null, { backendOverride: key, ...(isNote ? { notePath: file.path } : { folderPath: file.path }) });
    const offered = this.getBrowserBackends();
    if (backend || offered.length < 2) { go(backend || offered[0]); return; }
    const def = this.getCurrentBackend();
    const ordered = offered.includes(def) ? [def, ...offered.filter((k) => k !== def)] : offered;
    new ChoicePickerModal(this.app, ordered, {
      placeholder: `Start a session about “${title}” with…`,
      label: (k) => CLI_BACKENDS[k].label,
      onPick: go,
    }).open();
  }
  // The command and the file menu's item.
  registerNoteLaunch() {
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
};
export { NoteMethods };
