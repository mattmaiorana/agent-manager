
import { import_obsidian, os } from "../externals.js";
import { MAIN_SESSION_PROPERTY } from "../constants/names.js";
import type { Session } from "../sessions/controller.js";
import type { LaunchContext, OpeningPartKey } from "../context/launch-context.js";
import { notice } from "../vault-terminal/notice";
const ID_RE = /^[0-9a-fA-F-]{16,}$/;
const LINK_ID_RE = /session=([0-9a-fA-F-]{16,})/;
class ViewNoteMethods {
  _showNoteIcon(this: Session, strip: HTMLElement | null = this.stripEl): void {
    strip?.querySelector(".agent-manager-strip-note")?.remove();
  }
  _addContextItems(this: Session, menu: InstanceType<typeof import_obsidian.Menu>): boolean {
    const name = (p: string) => p.replace(/^.*\//, "").replace(/\.md$/, "");
    const own = this._notePath && this.plugin.isTicketNote(this._notePath) ? [this._notePath] : [];
    const tickets = [...own, ...Object.keys(this._ticketLinks || {}).filter((p) => p !== this._notePath && this.plugin.isTicketNote(p))];
    let added = false;
    if (tickets.length) {
      for (const p of tickets) menu.addItem((i) => i.setTitle(tickets.length === 1 ? "Open ticket" : `Open ticket: ${name(p)}`).setIcon("ticket").onClick(() => { void this.openTicket(p); }));
      added = true;
    } else if (this._notePath || this._folderPath) {
      menu.addItem((i) => i.setTitle(this._notePath ? "Open note" : "Show folder").setIcon(this._notePath ? "file-text" : "folder").onClick(() => { void this.openSourceNote(); }));
      added = true;
    }
    const at = this.plugin.contextFromString(this._contextSource?.from);
    if (!at) return added;
    const { ctx } = this._sentContext(at);
    const add = (title: string, icon: string, p: string, folder: boolean) => menu.addItem((i) => i.setTitle(title).setIcon(icon).onClick(() => { void this._openContextItem(p, folder); }));
    for (const p of ctx.overviews) add(`Open overview: ${p.includes("/") ? name(p.slice(0, p.lastIndexOf("/"))) : "the vault's root"}`, "book-open", p, false);
    for (const r of ctx.reads) add(`Open read: ${r.folder ? `${name(r.path)}/` : name(r.path)}`, r.folder ? "folder" : "file-text", r.path, r.folder);
    return added || ctx.overviews.length + ctx.reads.length > 0;
  }
  _contextTip(this: Session): string {
    const src = this._contextSource;
    const at = this.plugin.contextFromString(src?.from);
    if (!at) {
      if (src?.from) return "Context: where this session was started from isn't in the vault anymore.";
      return "Attached: no context was sent to this session.";
    }
    const { ctx, own } = this._sentContext(at);
    const where = (at.notePath || at.folderPath) as string;
    const name = (p: string) => p.replace(/^.*\//, "").replace(/\.md$/, "");
    const lines = own ? [`From the ${ctx.ticket ? "ticket" : ctx.task ? "scheduled task" : at.folderPath ? "folder" : "note"} “${name(where)}”`] : [];
    if (ctx.overviews.length) lines.push(`Overviews: ${ctx.overviews.map((p) => (p.includes("/") ? name(p.slice(0, p.lastIndexOf("/"))) : "the vault's root")).join(", ")}`);
    if (ctx.reads.length) lines.push(`Reads: ${ctx.reads.map((r) => (r.folder ? `${name(r.path)}/` : name(r.path))).join(", ")}`);
    if (ctx.repo) lines.push(`Repo: ${ctx.repo.startsWith(os.homedir() + "/") ? "~" + ctx.repo.slice(os.homedir().length) : ctx.repo}`);
    if (!lines.length) return "No context was sent to this session: the parts of the opening that carry it are empty in settings.";
    const backend = this.getBackendKey();
    const lost = "In the first message only, so a compaction can lose these:";
    const how = backend === "antigravity" ? lost
      : backend === "claude" && this._resumeStep === "attach" ? "In the first message only, until this session is resumed:"
      : !src?.pinned ? (backend === "claude" ? "In the first message only, until Claude's next compaction:" : lost)
      : "Kept through compactions:";
    return [how, ...lines].join("\n\n");
  }
  _sentContext(this: Session, at: { notePath?: string; folderPath?: string }): { ctx: LaunchContext; own: boolean } {
    const full = this.plugin.launchContext(at);
    const on = (key: OpeningPartKey) => !!this.plugin.openingPart(key).trim();
    const own = !!this._contextSource?.run || on(full.ticket ? "ticket" : full.task ? "task" : at.folderPath ? "folder" : "note");
    return { own, ctx: { ...full, overviews: on("overviews") ? full.overviews : [], reads: own ? full.reads : [], repo: on("repo") ? full.repo : null } };
  }
  async _openContextItem(this: Session, p: string, folder: boolean): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(p);
    if (folder) {
      if (!(f instanceof import_obsidian.TFolder)) { notice("That folder isn't there anymore"); return; }
      const explorer = this.app.internalPlugins?.getEnabledPluginById?.("file-explorer");
      if (explorer?.revealInFolder) explorer.revealInFolder(f);
      else notice({ head: "That's a folder", detail: f.path });
      return;
    }
    if (!(f instanceof import_obsidian.TFile)) { notice("That note isn't there anymore"); return; }
    await this.plugin.openInNotesArea(f);
  }
  async openTicket(this: Session, path: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof import_obsidian.TFile)) { notice("That ticket isn't there anymore"); return; }
    await this.plugin.openInNotesArea(f);
  }
  async openSourceNote(this: Session): Promise<void> {
    if (this._folderPath) {
      const folder = this.app.vault.getAbstractFileByPath(this._folderPath);
      if (!(folder instanceof import_obsidian.TFolder)) { notice("Its starting folder isn't there anymore"); return; }
      const explorer = this.app.internalPlugins?.getEnabledPluginById?.("file-explorer");
      if (explorer?.revealInFolder) explorer.revealInFolder(folder);
      else notice({ head: "Started from a folder", detail: folder.path });
      return;
    }
    const f = this._notePath && this.app.vault.getAbstractFileByPath(this._notePath);
    if (!(f instanceof import_obsidian.TFile)) { notice("Its starting note isn't there anymore"); return; }
    await this.plugin.openInNotesArea(f);
  }
  async maybeWriteNoteBack(this: Session): Promise<void> {
    if (!this._notePath || this._noteSupport || this._noteWritten || this._noteGone || this._noteWriting) return;
    const id = this._ownSessionId();
    if (!id || !ID_RE.test(id)) return;
    if (this._noteReplaces && !this._modelFile) return;
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
        notice({ head: "Not linked to its note", name: this.sessionTitle || "A new session", detail: `The note at “${this._notePath}” isn't there anymore.` });
        return;
      }
      const url = this.plugin.buildResumeLink({ sessionId: id });
      let wrote = false;
      await this.app.fileManager.processFrontMatter(nf, (fm: Record<string, unknown>) => {
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
      /* empty */
    } finally {
      this._noteWriting = false;
    }
  }
}
export { ViewNoteMethods };
