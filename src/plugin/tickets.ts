// Tickets and overviews, the plugin's side: what turning tickets on writes where it's
// missing, the one main session a ticket has, the Tickets button's note, and making a
// new ticket or overview (a command and the folder menu).

import type { TFile, TFolder, WorkspaceLeaf } from "obsidian";
import type { BackendKey } from "../constants/backends.js";
import { import_obsidian } from "../externals.js";
import { MAIN_SESSION_PROPERTY } from "../constants/names.js";
import { OVERVIEW_TEMPLATE, TICKET_TEMPLATE, TICKETS_BASE_NAME, ticketsBase } from "../constants/tickets.js";
import { isTicket } from "../context/launch-context.js";
import { errorMessage, stringOf, withinVault } from "../util/guards.js";
import { ChoicePickerModal } from "../ui/modals.js";
import type { AgentManagerPlugin } from "./main.js";
class TicketMethods {
  // Is the note at this vault path a ticket (tickets on, `type: ticket`, not the template)?
  isTicketNote(this: AgentManagerPlugin, notePath: string | null | undefined): boolean {
    return !!notePath && isTicket(notePath, this.contextVault(), { useTickets: this.ticketsOn(), templatePath: this.ticketTemplatePath() });
  }
  // A note's property, as a string ("" when it's missing or not text).
  noteProperty(this: AgentManagerPlugin, notePath: string, key: string): string {
    const v: unknown = this.contextVault().frontmatter(notePath)?.[key];
    return typeof v === "string" ? v.trim() : "";
  }
  // The session id in a note's main-session link, or null.
  mainSessionIdOf(this: AgentManagerPlugin, notePath: string): string | null {
    const m = this.noteProperty(notePath, MAIN_SESSION_PROPERTY).match(/[?&]session=([^&#\s]+)/);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch { return null; }
  }
  // The CLI a ticket names in its backend property, if it's one this vault offers.
  ticketBackend(this: AgentManagerPlugin, notePath: string | null | undefined): BackendKey | null {
    if (!notePath || !this.isTicketNote(notePath)) return null;
    const key = this.backendFromName(this.noteProperty(notePath, "backend"));
    return key && this.getBrowserBackends().includes(key) ? key : null;
  }
  // The tab holding a ticket's main session, open or still starting, or null: the latest
  // launch from the ticket (which holds its link, whether or not it has written it yet),
  // else the tab whose session the ticket's main-session names (a resume). Tabs Obsidian
  // hasn't loaded count too.
  ticketMainLeaf(this: AgentManagerPlugin, notePath: string): WorkspaceLeaf | null {
    const id = this.mainSessionIdOf(notePath);
    // The latest launch from this note this load, which holds its link (newerLaunchFrom).
    const latest = this._noteLaunches?.get(notePath);
    let named: WorkspaceLeaf | null = null;
    let claim: { leaf: WorkspaceLeaf; at: number } | null = null;
    for (const leaf of this.sessionLeaves()) {
      const v = this.sessionOf(leaf);
      if (v?._closed) continue;
      const s = v ? null : this.savedSessionState(leaf);
      const sid = v ? v._ownSessionId() : s?.sessionId || null;
      if (id && sid === id && !named) named = leaf;
      // A launch from the note that hasn't written its link yet (still starting, or a
      // new main waiting to run): the newest one, and only if no later launch replaced it.
      const from = v ? v._notePath : s?.notePath;
      const at = v ? (v._noteClaim ? v._noteLaunchAt : null) : (s?.noteClaim ? s.noteLaunchAt : null);
      if (from !== notePath || typeof at !== "number") continue;
      if (typeof latest === "number" && latest > at) continue;
      if (!claim || at > claim.at) claim = { leaf, at };
    }
    return claim?.leaf ?? named;
  }
  // The tickets base's vault path: in the AGENTS.md folder.
  ticketsBasePath(this: AgentManagerPlugin): string {
    const f = this.startFolder();
    return f ? `${f}/${TICKETS_BASE_NAME}` : TICKETS_BASE_NAME;
  }
  // Make a folder and its parents, as needed.
  async ensureFolder(this: AgentManagerPlugin, dir: string): Promise<void> {
    if (!dir || this.app.vault.getAbstractFileByPath(dir)) return;
    await this.app.vault.createFolder(dir);
  }
  // Turning tickets on writes the tickets base and the ticket template, each only where
  // it's missing, and says what it wrote. Never overwrites.
  async ensureTicketFiles(this: AgentManagerPlugin): Promise<void> {
    const written: string[] = [];
    const write = async (p: string, text: string) => {
      if (this.app.vault.getAbstractFileByPath(p)) return;
      try {
        await this.ensureFolder(p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
        await this.app.vault.create(p, text);
        written.push(p);
      } catch (e) {
        new import_obsidian.Notice(`Agent Manager: couldn't create ${p}: ${stringOf(errorMessage(e))}`);
      }
    };
    const template = this.ticketTemplatePath();
    await write(this.ticketsBasePath(), ticketsBase(this.app.vault.getName(), template));
    await write(template, TICKET_TEMPLATE);
    if (written.length) new import_obsidian.Notice(`Agent Manager: tickets are on. Created ${written.join(" and ")}.`, 8000);
  }
  // ---- Files sessions send ----
  // Save them at all (on unless turned off).
  sentFilesOn(this: AgentManagerPlugin): boolean {
    return this.pluginData.sentFiles !== "off";
  }
  // Where a sent file goes, as a free vault path: by Obsidian's attachment rule for the
  // note, unless the plugin's own rule is set (a folder path; "./" at its start means
  // beside the note). Its folder is made if it's missing.
  async sentFileDestination(this: AgentManagerPlugin, fileName: string, sourcePath: string): Promise<string> {
    const own = this.pluginData.sentFiles === "own" ? withinVault(stringOf(this.pluginData.sentFilesFolder ?? "").trim()) || "./Files" : "";
    let dest: string;
    if (!own) {
      dest = await this.app.fileManager.getAvailablePathForAttachment(fileName, sourcePath);
    } else {
      const noteDir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
      const rel = own.startsWith("./") ? own.slice(2) : null;
      const dir = (0, import_obsidian.normalizePath)(rel !== null ? `${noteDir ? noteDir + "/" : ""}${rel}` : own);
      const dot = fileName.lastIndexOf(".");
      const base = dot > 0 ? fileName.slice(0, dot) : fileName;
      const ext = dot > 0 ? fileName.slice(dot) : "";
      dest = "";
      for (let n = 1; !dest || this.app.vault.getAbstractFileByPath(dest); n++) dest = (0, import_obsidian.normalizePath)(`${dir}/${base}${n > 1 ? ` ${n}` : ""}${ext}`);
    }
    const parent = dest.includes("/") ? dest.slice(0, dest.lastIndexOf("/")) : "";
    await this.ensureFolder(parent);
    return dest;
  }
  // ---- The Tickets button ----
  // Its name: the setting, else "Tickets".
  ticketsButtonName(this: AgentManagerPlugin): string {
    const v = stringOf(this.pluginData.ticketsButtonName ?? "").trim();
    return v || "Tickets";
  }
  // The note the Tickets button opens: the setting, else the tickets base.
  ticketsNotePath(this: AgentManagerPlugin): string {
    const v = withinVault(stringOf(this.pluginData.ticketsNote ?? "").trim().replace(/^\/+/, ""));
    return v ? (0, import_obsidian.normalizePath)(v) : this.ticketsBasePath();
  }
  async openTicketsNote(this: AgentManagerPlugin): Promise<void> {
    const p = this.ticketsNotePath();
    const f = this.app.vault.getAbstractFileByPath(p);
    if (!(f instanceof import_obsidian.TFile)) { new import_obsidian.Notice(`Agent Manager: there's no “${p}” in this vault. Set the note the Tickets button opens in Settings → Agent Manager.`, 8000); return; }
    await this.app.workspace.getLeaf(false).openFile(f);
  }
  // ---- New ticket, new overview ----
  // A file name not yet taken in a folder: "<base>.md", else "<base> 2.md", and so on.
  freeNotePath(this: AgentManagerPlugin, dir: string, base: string): string {
    for (let n = 1; ; n++) {
      const p = (0, import_obsidian.normalizePath)(`${dir ? dir + "/" : ""}${base}${n > 1 ? ` ${n}` : ""}.md`);
      if (!this.app.vault.getAbstractFileByPath(p)) return p;
    }
  }
  // A template's text: the note at this path, else the built-in one.
  async templateText(this: AgentManagerPlugin, templatePath: string, builtIn: string): Promise<string> {
    const f = templatePath && this.app.vault.getAbstractFileByPath(templatePath);
    if (f instanceof import_obsidian.TFile) {
      try { return await this.app.vault.read(f); } catch { /* the built-in one */ }
    }
    return builtIn;
  }
  // Where a new ticket for a folder goes: its Tickets folder (or the folder itself, when
  // it's a Tickets folder).
  ticketsFolderFor(this: AgentManagerPlugin, folder: TFolder): string {
    const p = folder.isRoot() ? "" : folder.path;
    return folder.name === "Tickets" ? p : (p ? `${p}/Tickets` : "Tickets");
  }
  // Make a ticket from the template in a folder's Tickets folder, open it, and put its
  // name up for editing, as a new note's is.
  async newTicket(this: AgentManagerPlugin, folder: TFolder): Promise<TFile | null> {
    const dir = this.ticketsFolderFor(folder);
    try {
      await this.ensureFolder(dir);
      const file = await this.app.vault.create(this.freeNotePath(dir, "Untitled ticket"), await this.templateText(this.ticketTemplatePath(), TICKET_TEMPLATE));
      await this.app.workspace.getLeaf(false).openFile(file, { eState: { rename: "all" } });
      return file;
    } catch (e) {
      new import_obsidian.Notice(`Agent Manager: couldn't make the ticket: ${stringOf(errorMessage(e))}`);
      return null;
    }
  }
  // The project a note belongs to for a new ticket: its folder, or the folder above when
  // it's in a Tickets folder.
  projectFolderOf(this: AgentManagerPlugin, file: TFile): TFolder | null {
    const parent = file.parent;
    if (!parent) return null;
    return parent.name === "Tickets" && parent.parent ? parent.parent : parent;
  }
  // A folder's overview's path, by the overview file name.
  overviewPathOf(this: AgentManagerPlugin, folder: TFolder): string {
    return folder.isRoot() ? this.overviewName() : `${folder.path}/${this.overviewName()}`;
  }
  // Make a folder's overview from the overview template, and open it.
  async newOverview(this: AgentManagerPlugin, folder: TFolder): Promise<void> {
    const p = this.overviewPathOf(folder);
    if (this.app.vault.getAbstractFileByPath(p)) return;
    const template = stringOf(this.pluginData.overviewTemplate ?? "").trim();
    const text = (await this.templateText(template ? (0, import_obsidian.normalizePath)(template) : "", OVERVIEW_TEMPLATE)).replace(/\{\{name\}\}/g, folder.isRoot() ? this.app.vault.getName() : folder.name);
    try {
      const file = await this.app.vault.create(p, text);
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (e) {
      new import_obsidian.Notice(`Agent Manager: couldn't make the project overview: ${stringOf(errorMessage(e))}`);
    }
  }
  // ---- Filing a new ticket ----
  // A ticket made outside any Tickets folder (the base's New button puts one in the
  // default folder for new notes) is filed by asking once which project it's for: the
  // folders with an overview, or leave it where it is. Only notes made while Obsidian
  // runs, so existing notes are never asked about.
  async offerToFileTicket(this: AgentManagerPlugin, file: TFile): Promise<void> {
    if (!this.ticketsOn() || !this.isTicketNote(file.path) || file.parent?.name === "Tickets") return;
    const name = this.overviewName();
    const projects = this.app.vault.getAllFolders(true).filter((f) => this.app.vault.getAbstractFileByPath(this.overviewPathOf(f)) instanceof import_obsidian.TFile && f.name !== "Tickets");
    const folders = projects.length ? projects : this.app.vault.getAllFolders(true);
    const stay = { path: "", stay: true };
    const items: Array<TFolder | typeof stay> = [stay, ...folders.sort((a, b) => a.path.localeCompare(b.path))];
    new ChoicePickerModal(this.app, items, {
      placeholder: `File the ticket “${file.basename}” in which project?`,
      label: (it) => ("stay" in it ? "Leave it where it is" : it.isRoot() ? this.app.vault.getName() : it.path),
      sub: (it) => ("stay" in it ? file.parent?.path || "/" : projects.length ? `Has ${name}` : ""),
      onPick: (it) => { if (!("stay" in it)) void this.fileTicket(file, it); },
    }).open();
  }
  // Move a ticket into a project's Tickets folder, keeping links to it.
  async fileTicket(this: AgentManagerPlugin, file: TFile, project: TFolder): Promise<void> {
    const dir = this.ticketsFolderFor(project);
    try {
      await this.ensureFolder(dir);
      const dest = this.freeNotePath(dir, file.basename);
      await this.app.fileManager.renameFile(file, dest);
      new import_obsidian.Notice(`Filed in ${dir}.`);
    } catch (e) {
      new import_obsidian.Notice(`Agent Manager: couldn't move the ticket: ${stringOf(errorMessage(e))}`);
    }
  }
  // The commands and the folder menu's items, each offered only while its switch is on.
  registerTickets(this: AgentManagerPlugin): void {
    // New notes, watched until Obsidian has read their properties, for offerToFileTicket.
    const fresh = new Set<string>();
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("create", (f) => {
        if (f instanceof import_obsidian.TFile && f.extension === "md") { fresh.add(f.path); this.scheduleTimeout(() => fresh.delete(f.path), 60000); }
      }));
    });
    // Only the note the user is working in: notes that arrive another way (an agent
    // writing them, sync, a git checkout) would each open a picker, stacked. One that
    // isn't open yet stays watched, and is offered when it's opened (within the minute).
    const offer = (f: TFile) => {
      if (!fresh.has(f.path) || !this.isTicketNote(f.path)) return;
      if (this.app.workspace.getActiveFile()?.path !== f.path) return;
      fresh.delete(f.path);
      void this.offerToFileTicket(f);
    };
    this.registerEvent(this.app.metadataCache.on("changed", (f) => offer(f)));
    this.registerEvent(this.app.workspace.on("file-open", (f) => { if (f) offer(f); }));
    this.addCommand({
      id: "new-ticket",
      name: "New ticket",
      checkCallback: (checking) => {
        if (!this.ticketsOn()) return false;
        const file = this.app.workspace.getActiveFile();
        const folder = (file && this.projectFolderOf(file)) || this.app.vault.getRoot();
        if (!checking) void this.newTicket(folder);
        return true;
      },
    });
    this.addCommand({
      id: "open-tickets",
      name: "Open tickets",
      checkCallback: (checking) => {
        if (!this.ticketsOn()) return false;
        if (!checking) void this.openTicketsNote();
        return true;
      },
    });
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof import_obsidian.TFolder)) return;
      if (this.ticketsOn()) {
        menu.addItem((item) => item
          .setTitle("New ticket here")
          .setIcon("ticket")
          .setSection("action")
          .onClick(() => { void this.newTicket(file); }));
      }
      if (this.overviewsOn() && file.name !== "Tickets" && !this.app.vault.getAbstractFileByPath(this.overviewPathOf(file))) {
        menu.addItem((item) => item
          .setTitle("Add a project overview to this folder")
          .setIcon("file-plus")
          .setSection("action")
          .onClick(() => { void this.newOverview(file); }));
      }
    }));
  }
}
export { TicketMethods };
