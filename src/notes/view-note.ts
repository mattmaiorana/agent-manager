// A session started from a note or a folder, the view's side: the strip's icon for it,
// and writing the session's resume link back into the note's properties.

import { import_obsidian } from "../externals.js";
import { MAIN_SESSION_PROPERTY } from "../constants/names.js";
import { INPUT_GUARD_NOTICE_MS } from "../sessions/constants.js";
import type { Session } from "../sessions/controller.js";
const ID_RE = /^[0-9a-fA-F-]{16,}$/;
const LINK_ID_RE = /session=([0-9a-fA-F-]{16,})/;
class ViewNoteMethods {
  // The strip's icon for where this session belongs: a ticket's when it was started from
  // one or attached to one, else a note's or a folder's. Redrawn when that changes (a
  // resume finding its ticket, an attach).
  _showNoteIcon(this: Session, strip: HTMLElement | null = this.stripEl): void {
    if (!strip || !strip.isConnected) return;
    const fromTicket = !!this._notePath && this.plugin.isTicketNote(this._notePath);
    const linked = Object.keys(this._ticketLinks || {}).filter((p) => this.plugin.isTicketNote(p));
    const kind = fromTicket || linked.length ? "ticket" : this._notePath ? "note" : this._folderPath ? "folder" : null;
    const old = strip.querySelector<HTMLElement>(".agent-manager-strip-note");
    if (old?.dataset.kind === kind) return;
    old?.remove();
    if (!kind) return;
    const icon = strip.createSpan({ cls: "agent-manager-strip-note", attr: { "data-kind": kind } });
    this._stripTip(icon, kind === "ticket" ? "Open this session's ticket" : kind === "note" ? "Open the note this session was started from" : "Show the folder this session was started from");
    import_obsidian.setIcon(icon, kind === "ticket" ? "ticket" : kind === "note" ? "file-text" : "folder");
    icon.addEventListener("click", (evt) => {
      // Started from a ticket: that one. Attached to several: a menu of them.
      if (fromTicket || kind !== "ticket") { void this.openSourceNote(); return; }
      if (linked.length === 1) { void this.openTicket(linked[0]); return; }
      const menu = new import_obsidian.Menu();
      for (const p of linked) menu.addItem((i) => i.setTitle(p.replace(/^.*\//, "").replace(/\.md$/, "")).setIcon("ticket").onClick(() => { void this.openTicket(p); }));
      menu.showAtMouseEvent(evt);
    });
    const after = strip.querySelector(".agent-manager-strip-title");
    if (after) strip.insertBefore(icon, after);
  }
  async openTicket(this: Session, path: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof import_obsidian.TFile)) { new import_obsidian.Notice("That ticket isn't there anymore."); return; }
    await this.app.workspace.getLeaf("tab").openFile(f);
  }
  async openSourceNote(this: Session): Promise<void> {
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
  async maybeWriteNoteBack(this: Session): Promise<void> {
    if (!this._notePath || this._noteSupport || this._noteWritten || this._noteGone || this._noteWriting) return;
    const id = this._ownSessionId();
    if (!id || !ID_RE.test(id)) return;
    // Continue Session's new main session takes the link only once it has run (its
    // transcript exists), so one stuck at a prompt, or closed, never replaces the old.
    if (this._noteReplaces && !this._modelFile) return;
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
      await this.app.fileManager.processFrontMatter(nf, (fm: Record<string, unknown>) => {
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
}
export { ViewNoteMethods };
