// A session's lines on its tickets, the view's side: under `## Session Links`, a resume
// link labeled "<name> · <CLI> · <kind>", and under `## Transcripts`, a wikilink to its
// transcript note, kept current as it's renamed or moves to a new id. Written on the
// ticket it was started from, any ticket it was attached to (Linked), and a ticket that
// lists it, found again on a resume. The format and the dedup are in
// tickets/session-links.ts.

import { import_obsidian } from "../externals.js";
import { CLI_BACKENDS, SIDE_SUFFIX_RE } from "../constants/backends.js";
import { isLinkFor, keptKind, listsSession, mainSessionIdIn, relabelSessionLinks, SESSION_LINKS, sessionLinkText, transcriptTarget, TRANSCRIPTS, upsertSectionLine } from "../tickets/session-links.js";
import type { LinkKind } from "../tickets/session-links.js";
import type { App, Menu, TFile } from "obsidian";
import type { Session } from "../sessions/controller.js";
// A fuzzy picker over tickets: each by its name, with its folder below.
class TicketPickerModal extends import_obsidian.FuzzySuggestModal<TFile> {
  constructor(app: App, private tickets: TFile[], private onPick: (f: TFile) => void) {
    super(app);
    this.setPlaceholder("Attach this session to a ticket…");
  }
  getItems(): TFile[] { return this.tickets; }
  getItemText(f: TFile): string { return `${f.basename}  ${f.parent?.path ?? ""}`; }
  onChooseItem(f: TFile): void { this.onPick(f); }
}
const ID_RE = /^[0-9a-fA-F-]{16,}$/;
class ViewTicketMethods {
  // The tickets this session writes to, each with the kind its own line takes when it
  // has none yet (null: worked out from the ticket's main-session).
  _ticketTargets(this: Session): Array<{ path: string; kind: LinkKind | null }> {
    const out: Array<{ path: string; kind: LinkKind | null }> = [];
    if (this._notePath && this.plugin.isTicketNote(this._notePath)) out.push({ path: this._notePath, kind: this._noteSupport ? "Side session" : null });
    for (const [path, kind] of Object.entries(this._ticketLinks || {})) {
      if (path !== this._notePath && this.plugin.isTicketNote(path)) out.push({ path, kind });
    }
    return out;
  }
  // Write this session's lines on each of its tickets, once it has an id. The transcript
  // line waits for the transcript note; until both are written, the poll keeps trying.
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
      const linkLine = `[${sessionLinkText(name, CLI_BACKENDS[backend]?.label || backend, null)}](${url})`;
      const note = this.plugin.findTranscriptNoteBySessionId(id);
      let done = !!note;
      const written = this._ticketWritten || (this._ticketWritten = {});
      for (const t of targets) {
        const file = this.app.vault.getAbstractFileByPath(t.path);
        if (!(file instanceof import_obsidian.TFile)) continue;
        const wl = note ? `- [[${this.app.metadataCache.fileToLinktext(note, t.path, true)}]]` : null;
        const key = [linkLine, wl, this.plugin.mainSessionIdOf(t.path), t.kind].join("\n");
        if (written[t.path] === key) continue;
        // The transcript line for this session is the one whose note's session_id is its id.
        const sameNote = (line: string) => {
          const target = transcriptTarget(line);
          const f = target && this.app.metadataCache.getFirstLinkpathDest(target, t.path);
          const sid: unknown = f && this.app.metadataCache.getFileCache(f)?.frontmatter?.session_id;
          return typeof sid === "string" && sid === id;
        };
        try {
          await this.app.vault.process(file, (content) => {
            const kinds: Record<string, LinkKind> = {};
            const own = t.kind || keptKind(content, id);
            if (own) kinds[id] = own;
            const moved = this._rehostedFrom;
            if (moved?.from && listsSession(content, moved.from)) kinds[moved.from] = moved.kind === "continued" ? "Continued" : "Re-hosted";
            let c = upsertSectionLine(content, SESSION_LINKS, linkLine, isLinkFor(id));
            c = relabelSessionLinks(c, { mainId: mainSessionIdIn(c), kinds });
            if (wl) c = upsertSectionLine(c, TRANSCRIPTS, wl, sameNote);
            return c;
          });
          written[t.path] = key;
        } catch {
          done = false;
        }
      }
      // A reset while this ran (an attach, a rename) leaves the work pending.
      if (gen === (this._ticketGen || 0)) this._ticketDone = done;
    } finally {
      this._ticketWriting = false;
    }
  }
  // The tab's menu: attach this session to a ticket, while tickets are on.
  paneMenu(this: Session, menu: Menu): void {
    if (!this.plugin.ticketsOn() || !this.sessionTitle || this._inert) return;
    menu.addItem((i) => i.setTitle("Attach to a ticket").setIcon("ticket").setSection("action").onClick(() => this.pickTicketToAttach()));
  }
  // A picker over every ticket (fuzzy, by name and folder), but the ones this session
  // already writes to.
  pickTicketToAttach(this: Session): void {
    const have = new Set(this._ticketTargets().map((t) => t.path));
    const tickets = this.app.vault.getMarkdownFiles().filter((f) => !have.has(f.path) && this.plugin.isTicketNote(f.path));
    if (!tickets.length) { new import_obsidian.Notice("No other tickets to attach this session to."); return; }
    new TicketPickerModal(this.app, tickets, (f) => { void this.attachToTicket(f.path); }).open();
  }
  // Attach: its lines go on that ticket as Linked, kept current while it's open. Never
  // the ticket's main-session. A session can be attached to several.
  async attachToTicket(this: Session, path: string): Promise<void> {
    (this._ticketLinks || (this._ticketLinks = {}))[path] = "Linked";
    this.resetTicketWriteback();
    this._showNoteIcon();
    this.app.workspace.requestSaveLayout();
    await this.maybeWriteTicketBack();
    new import_obsidian.Notice(this._ownSessionId() ? `Attached to “${path.replace(/^.*\//, "").replace(/\.md$/, "")}”.` : "Attached. Its link goes on the ticket once the session has an id.");
  }
  // Forget what was written, so the next poll writes again (a rename, a new id).
  resetTicketWriteback(this: Session): void {
    this._ticketWritten = {};
    this._ticketDone = false;
    this._ticketGen = (this._ticketGen || 0) + 1;
  }
  // A resumed session that wasn't started from a ticket finds the tickets that know it:
  // one whose main-session names it (it's that ticket's main session again) and any that
  // list it under `## Session Links` (it keeps writing its line there). Tickets only, read
  // from Obsidian's cache.
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
}
export { ViewTicketMethods };
