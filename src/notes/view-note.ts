
import { import_obsidian, os } from "../externals.js";
import { MAIN_SESSION_PROPERTY } from "../constants/names.js";
import type { Session } from "../sessions/controller.js";
import type { LaunchContext, OpeningPartKey } from "../context/launch-context.js";
import { notice } from "../vault-terminal/notice";
const ID_RE = /^[0-9a-fA-F-]{16,}$/;
const LINK_ID_RE = /session=([0-9a-fA-F-]{16,})/;
class ViewNoteMethods {
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
    const action = kind === "ticket" ? "Click to open this session's ticket" : kind === "note" ? "Click to open the note this session was started from" : "Click to show the folder this session was started from";
    const tip = () => {
      const has = !!this.plugin.contextFromString(this._contextSource?.from);
      this._stripTip(icon, [this._contextTip(), has ? `${action}; right-click to open any of these.` : `${action}.`].filter(Boolean).join("\n\n"), ["agent-manager-context-tip"]);
    };
    tip();
    icon.addEventListener("mouseenter", tip);
    import_obsidian.setIcon(icon, kind === "ticket" ? "ticket" : kind === "note" ? "file-text" : "folder");
    icon.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this._contextMenu(evt);
    });
    icon.addEventListener("click", (evt) => {
      const own = this._notePath && this.plugin.isTicketNote(this._notePath) ? [this._notePath] : [];
      const tickets = [...own, ...Object.keys(this._ticketLinks || {}).filter((p) => p !== this._notePath && this.plugin.isTicketNote(p))];
      if (kind !== "ticket" || !tickets.length || (own.length && tickets.length === 1)) { void this.openSourceNote(); return; }
      if (tickets.length === 1) { void this.openTicket(tickets[0]); return; }
      const menu = new import_obsidian.Menu();
      for (const p of tickets) menu.addItem((i) => i.setTitle(p.replace(/^.*\//, "").replace(/\.md$/, "")).setIcon("ticket").onClick(() => { void this.openTicket(p); }));
      menu.showAtMouseEvent(evt);
    });
    const after = strip.querySelector(".agent-manager-strip-title");
    if (after) strip.insertBefore(icon, after);
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
  _contextMenu(this: Session, evt: MouseEvent): void {
    const at = this.plugin.contextFromString(this._contextSource?.from);
    if (!at) {
      notice(this._contextSource?.from ? "Where this session was started from isn't in the vault anymore." : "This session has no context to open: it wasn't started from a note or a folder.");
      return;
    }
    const { ctx } = this._sentContext(at);
    const menu = new import_obsidian.Menu();
    const name = (p: string) => p.replace(/^.*\//, "").replace(/\.md$/, "");
    const add = (title: string, icon: string, p: string, folder: boolean) => menu.addItem((i) => i.setTitle(title).setIcon(icon).onClick(() => { void this._openContextItem(p, folder); }));
    const where = (at.notePath || at.folderPath) as string;
    add(name(where), ctx.ticket ? "ticket" : at.folderPath ? "folder" : "file-text", where, !!at.folderPath);
    if (ctx.overviews.length || ctx.reads.length) menu.addSeparator();
    for (const p of ctx.overviews) add(`Overview: ${p.includes("/") ? name(p.slice(0, p.lastIndexOf("/"))) : "the vault's root"}`, "book-open", p, false);
    for (const r of ctx.reads) add(r.folder ? `${name(r.path)}/` : name(r.path), r.folder ? "folder" : "file-text", r.path, r.folder);
    menu.showAtMouseEvent(evt);
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
      if (!(f instanceof import_obsidian.TFolder)) { notice("That folder isn't there anymore."); return; }
      const explorer = this.app.internalPlugins?.getEnabledPluginById?.("file-explorer");
      if (explorer?.revealInFolder) explorer.revealInFolder(f);
      else notice(`That's the folder “${f.path}”.`);
      return;
    }
    if (!(f instanceof import_obsidian.TFile)) { notice("That note isn't there anymore."); return; }
    await this.plugin.openInNotesArea(f);
  }
  async openTicket(this: Session, path: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof import_obsidian.TFile)) { notice("That ticket isn't there anymore."); return; }
    await this.plugin.openInNotesArea(f);
  }
  async openSourceNote(this: Session): Promise<void> {
    if (this._folderPath) {
      const folder = this.app.vault.getAbstractFileByPath(this._folderPath);
      if (!(folder instanceof import_obsidian.TFolder)) { notice("The folder this session was started from isn't there anymore."); return; }
      const explorer = this.app.internalPlugins?.getEnabledPluginById?.("file-explorer");
      if (explorer?.revealInFolder) explorer.revealInFolder(folder);
      else notice(`This session was started from the folder “${folder.path}”.`);
      return;
    }
    const f = this._notePath && this.app.vault.getAbstractFileByPath(this._notePath);
    if (!(f instanceof import_obsidian.TFile)) { notice("The note this session was started from isn't there anymore."); return; }
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
        notice(`Agent Manager: the note at “${this._notePath}” isn't there anymore, so this session won't be linked to it.`);
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
