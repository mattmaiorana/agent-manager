// A session started from a note or a folder, the view's side: the strip's icon for it,
// and writing the session's resume link back into the note's properties.

import { import_obsidian } from "../externals.js";
import { MAIN_SESSION_PROPERTY } from "../constants/names.js";
import { INPUT_GUARD_NOTICE_MS } from "../sessions/constants.js";
var ID_RE = /^[0-9a-fA-F-]{16,}$/;
var LINK_ID_RE = /session=([0-9a-fA-F-]{16,})/;
var ViewNoteMethods = class {
  // Add the strip's icon once, if this session was started from a note or a folder.
  _showNoteIcon(strip = this.stripEl) {
    if (!strip || !strip.isConnected || !(this._notePath || this._folderPath)) return;
    if (strip.querySelector(".agent-manager-strip-note")) return;
    const icon = strip.createSpan({ cls: "agent-manager-strip-note" });
    this._stripTip(icon, this._notePath ? "Open the note this session was started from" : "Show the folder this session was started from");
    import_obsidian.setIcon(icon, this._notePath ? "file-text" : "folder");
    icon.addEventListener("click", () => this.openSourceNote());
    const after = strip.querySelector(".agent-manager-strip-title");
    if (after) strip.insertBefore(icon, after);
  }
  async openSourceNote() {
    if (this._folderPath) {
      const folder = this.app.vault.getAbstractFileByPath(this._folderPath);
      if (!(folder instanceof import_obsidian.TFolder)) { new import_obsidian.Notice("The folder this session was started from isn't there anymore."); return; }
      // The file explorer's reveal is internal; without it, say where the folder is.
      const explorer = this.app.internalPlugins?.getEnabledPluginById?.("file-explorer");
      if (explorer?.revealInFolder) explorer.revealInFolder(folder);
      else new import_obsidian.Notice(`This session was started from the folder “${folder.path}”.`);
      return;
    }
    const f = this._notePath && this.app.vault.getAbstractFileByPath(this._notePath);
    if (!(f instanceof import_obsidian.TFile)) { new import_obsidian.Notice("The note this session was started from isn't there anymore."); return; }
    await this.app.workspace.getLeaf("tab").openFile(f);
  }
  // Write the session's resume link into the note it was started from (main-session), as
  // soon as the session has an id: at launch for Claude, since the plugin mints it, and
  // once its transcript appears for Codex and Antigravity. The latest session started
  // from the note holds it; a side chat never writes it. Called by the status poll every
  // few seconds until it's written, and on each completed turn.
  async maybeWriteNoteBack() {
    if (!this._notePath || this._noteSupport || this._noteWritten || this._noteGone || this._noteWriting) return;
    const id = this._ownSessionId();
    if (!id || !ID_RE.test(id)) return;
    // A later launch from the same note holds the link, even if this one is first to
    // learn its id (a Codex launch waiting at a dialog while a newer Claude launch runs).
    if (this._noteClaim && this.plugin.newerLaunchFrom(this._notePath, this._noteLaunchAt, this)) {
      this._noteClaim = false;
      this._noteWritten = true;
      this.app.workspace.requestSaveLayout();
      return;
    }
    const gen = this._noteGen;
    this._noteWriting = true;
    try {
      const nf = this.app.vault.getAbstractFileByPath(this._notePath);
      if (!(nf instanceof import_obsidian.TFile)) {
        this._noteGone = true;
        new import_obsidian.Notice(`Agent Manager: the note at “${this._notePath}” isn't there anymore, so this session won't be linked to it.`, INPUT_GUARD_NOTICE_MS);
        return;
      }
      const url = this.plugin.buildResumeLink({ sessionId: id });
      let wrote = false;
      await this.app.fileManager.processFrontMatter(nf, (fm) => {
        // A launch from the note claims the property once, whatever it holds; after
        // that, this session writes it only while it still names this session (a newer
        // launch from the same note has taken it otherwise).
        const cur = typeof fm[MAIN_SESSION_PROPERTY] === "string" ? fm[MAIN_SESSION_PROPERTY] : "";
        const curId = (cur.match(LINK_ID_RE) || [])[1];
        const own = !!curId && (curId === id || curId === this._rehostedFrom?.from || !!this._notePriorIds?.has(curId));
        if (gen !== this._noteGen) return;
        if (!this._noteClaim && !own) { this._noteWritten = true; return; }
        fm[MAIN_SESSION_PROPERTY] = url;
        wrote = true;
      });
      if (!wrote || gen !== this._noteGen) return;
      this._noteUrlWritten = url;
      if (this._noteClaim) { this._noteClaim = false; this.app.workspace.requestSaveLayout(); }
      this._noteWritten = true;
    } catch {
      /* the next poll retries */
    } finally {
      this._noteWriting = false;
    }
  }
};
export { ViewNoteMethods };
