
import { import_obsidian } from "../externals.js";
import { CLI_BACKENDS, SIDE_SUFFIX_RE } from "../constants/backends.js";
import { MAIN_SESSION_PROPERTY } from "../constants/names.js";
import { heldTranscript, isLinkFor, keptKind, listsSession, mainSessionIdIn, relabelSessionLinks, SESSION_LINKS, sessionLine, sessionLinkText, transcriptLink, upsertSectionLine } from "../tickets/session-links.js";
import type { LineKind } from "../tickets/session-links.js";
import type { App, Menu, TFile } from "obsidian";
import type { Session } from "../sessions/controller.js";
import { notice } from "../vault-terminal/notice";
class TicketPickerModal extends import_obsidian.FuzzySuggestModal<TFile> {
  constructor(app: App, private tickets: TFile[], private onPick: (f: TFile) => void, placeholder: string) {
    super(app);
    this.setPlaceholder(placeholder);
  }
  getItems(): TFile[] { return this.tickets; }
  getItemText(f: TFile): string { return `${f.basename}  ${f.parent?.path ?? ""}`; }
  onChooseItem(f: TFile): void { this.onPick(f); }
}
const ID_RE = /^[0-9a-fA-F-]{16,}$/;
class ViewTicketMethods {
  _ticketTargets(this: Session): Array<{ path: string; kind: LineKind | null }> {
    const out: Array<{ path: string; kind: LineKind | null }> = [];
    const n = String(this.sessionTitle || "").match(SIDE_SUFFIX_RE)?.[1];
    if (this._notePath && this.plugin.isTicketNote(this._notePath)) out.push({ path: this._notePath, kind: this._noteSupport ? (n ? `Side session (${Number(n)})` : "Side session") : null });
    for (const [path, kind] of Object.entries(this._ticketLinks || {})) {
      if (path !== this._notePath && this.plugin.isTicketNote(path)) out.push({ path, kind });
    }
    return out;
  }
  async maybeWriteTicketBack(this: Session): Promise<void> {
    if (this._ticketWriting) return;
    const targets = this._ticketTargets();
    if (!targets.length) { this._ticketDone = true; return; }
    const id = this._ownSessionId();
    if (!id || !ID_RE.test(id)) return;
    this._ticketWriting = true;
    const gen = this._ticketGen || 0;
    try {
      const backend = this.getBackendKey();
      const name = String(this.sessionTitle || "").replace(SIDE_SUFFIX_RE, "");
      const url = this.plugin.buildResumeLink({ sessionId: id });
      const text = sessionLinkText(name, CLI_BACKENDS[backend]?.label || backend, null);
      const note = this.plugin.findTranscriptNoteBySessionId(id);
      let done = !!note;
      const written = this._ticketWritten || (this._ticketWritten = {});
      for (const t of targets) {
        const file = this.app.vault.getAbstractFileByPath(t.path);
        if (!(file instanceof import_obsidian.TFile)) continue;
        const tl = note ? transcriptLink(this.app.metadataCache.fileToLinktext(note, t.path, true)) : null;
        const key = [text, url, tl, this.plugin.mainSessionIdOf(t.path), t.kind].join("\n");
        if (written[t.path] === key) continue;
        try {
          await this.app.vault.process(file, (content) => {
            const kinds: Record<string, LineKind> = {};
            const own = t.kind || keptKind(content, id);
            if (own) kinds[id] = own;
            const moved = this._rehostedFrom;
            if (moved?.from && listsSession(content, moved.from)) kinds[moved.from] = moved.kind === "continued" ? "Continued" : "Re-hosted";
            const line = sessionLine(text, url, tl ?? heldTranscript(content, id));
            const c = upsertSectionLine(content, SESSION_LINKS, line, isLinkFor(id));
            return relabelSessionLinks(c, { mainId: mainSessionIdIn(c), kinds });
          });
          written[t.path] = key;
        } catch {
          done = false;
        }
      }
      if (gen === (this._ticketGen || 0)) this._ticketDone = done;
    } finally {
      this._ticketWriting = false;
    }
  }
  ticketMenu(this: Session, menu: Menu): void {
    if (!this.plugin.ticketsOn() || !this.sessionTitle || this._inert) return;
    menu.addItem((i) => i.setTitle("Attach to a ticket").setIcon("ticket").setSection("action").onClick(() => this.pickTicketToAttach(false)));
    menu.addItem((i) => i.setTitle("Attach to a ticket as its main session").setIcon("ticket").setSection("action").onClick(() => this.pickTicketToAttach(true)));
    menu.addItem((i) => i.setTitle("Make a ticket from this session").setIcon(import_obsidian.getIcon("ticket-plus") ? "ticket-plus" : "ticket").setSection("action").onClick(() => { void this.plugin.openTicketCardFrom(this); }));
  }
  pickTicketToAttach(this: Session, asMain: boolean): void {
    const id = this._ownSessionId();
    if (asMain && (!id || !ID_RE.test(id))) { notice("This session can become a ticket's main session once it has started. Try again after its first turn."); return; }
    const have = new Set(asMain ? [this._notePath || ""] : this._ticketTargets().map((t) => t.path));
    const tickets = this.app.vault.getMarkdownFiles().filter((f) => !have.has(f.path) && this.plugin.isTicketNote(f.path) && !(asMain && this.plugin.mainSessionIdOf(f.path) === id));
    if (!tickets.length) { notice("No other tickets to attach this session to."); return; }
    const placeholder = asMain ? "Make this session the main session of which ticket…" : "Attach this session to a ticket…";
    new TicketPickerModal(this.app, tickets, (f) => { void this.attachToTicket(f.path, asMain); }, placeholder).open();
  }
  async attachToTicket(this: Session, path: string, asMain = false): Promise<void> {
    if (asMain) {
      const id = this._ownSessionId();
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!id || !ID_RE.test(id) || !(file instanceof import_obsidian.TFile)) { notice("Couldn't make this session the ticket's main session."); return; }
      try {
        const url = this.plugin.buildResumeLink({ sessionId: id });
        await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => { fm[MAIN_SESSION_PROPERTY] = url; });
      } catch {
        notice("Couldn't make this session the ticket's main session.");
        return;
      }
    }
    (this._ticketLinks || (this._ticketLinks = {}))[path] = asMain ? null : "Linked";
    this.resetTicketWriteback();
    this._showNoteIcon();
    this.app.workspace.requestSaveLayout();
    await this.maybeWriteTicketBack();
    const name = path.replace(/^.*\//, "").replace(/\.md$/, "");
    notice(asMain ? `This session is now the main session of “${name}”.` : this._ownSessionId() ? `Attached to “${name}”.` : "Attached. Its link goes on the ticket once the session has an id.");
  }
  resetTicketWriteback(this: Session): void {
    this._ticketWritten = {};
    this._ticketDone = false;
    this._ticketGen = (this._ticketGen || 0) + 1;
  }
  async _rebindTickets(this: Session): Promise<void> {
    const id = this.resumeSessionId;
    if (!id || !this.plugin.ticketsOn()) return;
    const links = this._ticketLinks || (this._ticketLinks = {});
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.path === this._notePath || f.path in links || !this.plugin.isTicketNote(f.path)) continue;
      if (this.plugin.mainSessionIdOf(f.path) === id) {
        if (!this._notePath) { this._notePath = f.path; this._noteClaim = false; }
        else links[f.path] = null;
        continue;
      }
      let body = "";
      try { body = await this.app.vault.cachedRead(f); } catch { continue; }
      if (listsSession(body, id)) links[f.path] = null;
    }
    this.resetTicketWriteback();
    this._showNoteIcon?.();
    this.app.workspace.requestSaveLayout();
  }
  ticketChanged(this: Session, path: string, content: string): void {
    if (this._closed || this._inert) return;
    const own = this._ownSessionId();
    if (!own || path === this._notePath || path in (this._ticketLinks || {})) return;
    const ids = [own, ...(this._notePriorIds || [])];
    const main = mainSessionIdIn(content);
    if (!ids.some((id) => id === main || listsSession(content, id))) return;
    (this._ticketLinks || (this._ticketLinks = {}))[path] = null;
    if (this._ticketWritten) delete this._ticketWritten[path];
    this._ticketDone = false;
    this._ticketGen = (this._ticketGen || 0) + 1;
    this._showNoteIcon();
    this.app.workspace.requestSaveLayout();
  }
  async _scanTickets(this: Session): Promise<void> {
    if (!this.plugin.ticketsOn()) return;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!this.plugin.isTicketNote(f.path)) continue;
      let body = "";
      try { body = await this.app.vault.cachedRead(f); } catch { continue; }
      this.ticketChanged(f.path, body);
    }
  }
}
export { ViewTicketMethods };
