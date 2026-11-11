
import type { MarkdownView, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import type { Session } from "../sessions/controller.js";
import { isBrowser } from "../browser/view.js";
import type { BackendKey } from "../constants/backends.js";
import { import_obsidian } from "../externals.js";
import { MAIN_SESSION_PROPERTY } from "../constants/names.js";
import { OVERVIEW_TEMPLATE, TICKET_TEMPLATE, TICKETS_BASE_NAME, ticketsBase } from "../constants/tickets.js";
import { isTicket } from "../context/launch-context.js";
import { FROM_TASK_PROPERTY, followUpName, linkTarget, wikilink, withRead } from "../scheduled/follow-up.js";
import type { ScheduledTask } from "../scheduled/task-model.js";
import { ticketFileName, withNotes } from "../tickets/new-ticket.js";
import { errorMessage, stringOf, withinVault } from "../util/guards.js";
import { isArchived } from "../util/paths.js";
import { ChoicePickerModal } from "../ui/modals.js";
import type { AgentManagerPlugin } from "./main.js";

export interface ProjectGroup { label: string | null; options: { text: string; value: string }[] }
import { notice } from "../vault-terminal/notice";

class TicketMethods {
  isTicketNote(this: AgentManagerPlugin, notePath: string | null | undefined): boolean {
    return !!notePath && isTicket(notePath, this.contextVault(), { useTickets: this.ticketsOn(), templatePath: this.ticketTemplatePath() });
  }
  noteProperty(this: AgentManagerPlugin, notePath: string, key: string): string {
    const v: unknown = this.contextVault().frontmatter(notePath)?.[key];
    return typeof v === "string" ? v.trim() : "";
  }
  mainSessionIdOf(this: AgentManagerPlugin, notePath: string): string | null {
    const m = this.noteProperty(notePath, MAIN_SESSION_PROPERTY).match(/[?&]session=([^&#\s]+)/);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch { return null; }
  }
  ticketBackend(this: AgentManagerPlugin, notePath: string | null | undefined): BackendKey | null {
    if (!notePath || !this.isTicketNote(notePath)) return null;
    const key = this.backendFromName(this.noteProperty(notePath, "cli"));
    return key && this.getBrowserBackends().includes(key) ? key : null;
  }
  ticketMainLeaf(this: AgentManagerPlugin, notePath: string): WorkspaceLeaf | null {
    const id = this.mainSessionIdOf(notePath);
    const latest = this._noteLaunches?.get(notePath);
    let named: WorkspaceLeaf | null = null;
    let claim: { leaf: WorkspaceLeaf; at: number } | null = null;
    for (const leaf of this.sessionLeaves()) {
      const v = this.sessionOf(leaf);
      if (v?._closed) continue;
      const s = v ? null : this.savedSessionState(leaf);
      const sid = v ? v._ownSessionId() : s?.sessionId || null;
      if (id && sid === id && !named) named = leaf;
      const from = v ? v._notePath : s?.notePath;
      const at = v ? (v._noteClaim ? v._noteLaunchAt : null) : (s?.noteClaim ? s.noteLaunchAt : null);
      if (from !== notePath || typeof at !== "number") continue;
      if (typeof latest === "number" && latest > at) continue;
      if (!claim || at > claim.at) claim = { leaf, at };
    }
    return claim?.leaf ?? named;
  }
  ticketsBasePath(this: AgentManagerPlugin): string {
    const f = this.startFolder();
    return f ? `${f}/${TICKETS_BASE_NAME}` : TICKETS_BASE_NAME;
  }
  async ensureFolder(this: AgentManagerPlugin, dir: string): Promise<void> {
    if (!dir || this.app.vault.getAbstractFileByPath(dir)) return;
    await this.app.vault.createFolder(dir);
  }
  async ensureTicketFiles(this: AgentManagerPlugin): Promise<void> {
    const written: string[] = [];
    const write = async (p: string, text: string) => {
      if (this.app.vault.getAbstractFileByPath(p)) return;
      try {
        await this.ensureFolder(p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
        await this.app.vault.create(p, text);
        written.push(p);
      } catch (e) {
        notice(`Agent Manager: couldn't create ${p}: ${stringOf(errorMessage(e))}`);
      }
    };
    const template = this.ticketTemplatePath();
    await write(this.ticketsBasePath(), ticketsBase(this.app.vault.getName(), template));
    await write(template, TICKET_TEMPLATE);
    if (written.length) notice(`Agent Manager: tickets are on. Created ${written.join(" and ")}.`);
  }
  sentFilesOn(this: AgentManagerPlugin): boolean {
    return this.pluginData.sentFiles !== "off";
  }
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
  ticketsNotePath(this: AgentManagerPlugin): string {
    const v = withinVault(stringOf(this.pluginData.ticketsNote ?? "").trim().replace(/^\/+/, ""));
    return v ? (0, import_obsidian.normalizePath)(v) : this.ticketsBasePath();
  }
  async openTicketsNote(this: AgentManagerPlugin): Promise<void> {
    const p = this.ticketsNotePath();
    const f = this.app.vault.getAbstractFileByPath(p);
    if (!(f instanceof import_obsidian.TFile)) { notice(`Agent Manager: there's no “${p}” in this vault. Set the tickets note in Settings → Agent Manager.`); return; }
    await this.app.workspace.getLeaf(false).openFile(f);
  }
  customButtonTarget(this: AgentManagerPlugin): { url: string } | { path: string } | null {
    const v = stringOf(this.pluginData.customButtonTarget ?? "").trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return { url: v };
    const p = withinVault(v.replace(/^\/+/, ""));
    if (p) return { path: (0, import_obsidian.normalizePath)(p) };
    return this.ticketsOn() ? { path: this.ticketsNotePath() } : null;
  }
  customButtonIcon(this: AgentManagerPlugin): string {
    const v = stringOf(this.pluginData.customButtonIcon ?? "").trim();
    if (v && import_obsidian.getIcon(v)) return v;
    return stringOf(this.pluginData.customButtonTarget ?? "").trim() ? "link" : "ticket";
  }
  async openCustomButton(this: AgentManagerPlugin): Promise<void> {
    const t = this.customButtonTarget();
    if (!t) return;
    if ("url" in t) {
      try { new URL(t.url); } catch { notice(`Agent Manager: “${t.url}” isn't a link that can be opened. Set what the custom button opens in Settings → Agent Manager.`); return; }
      window.open(t.url);
      return;
    }
    const f = this.app.vault.getAbstractFileByPath(t.path);
    if (!(f instanceof import_obsidian.TFile)) { notice(`Agent Manager: there's no “${t.path}” in this vault. Set what the custom button opens in Settings → Agent Manager.`); return; }
    await this.app.workspace.getLeaf(false).openFile(f);
  }
  freeNotePath(this: AgentManagerPlugin, dir: string, base: string): string {
    for (let n = 1; ; n++) {
      const p = (0, import_obsidian.normalizePath)(`${dir ? dir + "/" : ""}${base}${n > 1 ? ` ${n}` : ""}.md`);
      if (!this.app.vault.getAbstractFileByPath(p)) return p;
    }
  }
  async templateText(this: AgentManagerPlugin, templatePath: string, builtIn: string): Promise<string> {
    const f = templatePath && this.app.vault.getAbstractFileByPath(templatePath);
    if (f instanceof import_obsidian.TFile) {
      try { return await this.app.vault.read(f); } catch { /* empty */ }
    }
    return builtIn;
  }
  ticketsFolderFor(this: AgentManagerPlugin, folder: TFolder): string {
    const p = folder.isRoot() ? "" : folder.path;
    return folder.name === "Tickets" ? p : (p ? `${p}/Tickets` : "Tickets");
  }
  async newTicket(this: AgentManagerPlugin, folder: TFolder, opts: { name?: string; backend?: BackendKey | null; notes?: string } = {}): Promise<TFile | null> {
    const dir = this.ticketsFolderFor(folder);
    const name = ticketFileName(opts.name || "");
    try {
      await this.ensureFolder(dir);
      const text = withNotes(await this.templateText(this.ticketTemplatePath(), TICKET_TEMPLATE), this.ticketNotesHeading(), opts.notes || "");
      const file = await this.app.vault.create(this.freeNotePath(dir, name || "Untitled ticket"), text);
      const backend = opts.backend;
      if (backend) await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => { fm.cli = backend; });
      await this.app.workspace.getLeaf(false).openFile(file, name ? {} : { eState: { rename: "all" } });
      return file;
    } catch (e) {
      notice(`Agent Manager: couldn't make the ticket: ${stringOf(errorMessage(e))}`);
      return null;
    }
  }
  canBeFollowUp(this: AgentManagerPlugin, notePath: string): boolean {
    if (isArchived(notePath) || !this.isTicketNote(notePath)) return false;
    const fm = this.contextVault().frontmatter(notePath) || {};
    const origin = Object.keys(fm).find((k) => k.toLowerCase() === "origin");
    if (origin && String(fm[origin]).trim().toLowerCase() === "external") return false;
    for (const t of this.taskPaths()) {
      const dir = t.slice(0, t.lastIndexOf("/"));
      if (dir && notePath.startsWith(`${dir}/`)) return false;
    }
    return true;
  }
  fromTaskOf(this: AgentManagerPlugin, ticketPath: string): string | null {
    const target = linkTarget(this.contextVault().frontmatter(ticketPath)?.[FROM_TASK_PROPERTY]);
    if (!target) return null;
    return this.app.metadataCache.getFirstLinkpathDest(target, ticketPath)?.path ?? null;
  }
  ticketIsDone(this: AgentManagerPlugin, fm: Record<string, unknown> | null | undefined): boolean {
    const key = fm ? Object.keys(fm).find((k) => k.toLowerCase() === "done") : undefined;
    return !!key && String(fm![key]).trim().toLowerCase() === "true";
  }
  followUpTicketOf(this: AgentManagerPlugin, task: Pick<ScheduledTask, "notePath">): TFile | null {
    let best: TFile | null = null;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!this.canBeFollowUp(f.path) || this.ticketIsDone(this.app.metadataCache.getFileCache(f)?.frontmatter)) continue;
      if (this.fromTaskOf(f.path) !== task.notePath) continue;
      if (!best || f.stat.ctime < best.stat.ctime) best = f;
    }
    return best;
  }
  followUpFolderOf(this: AgentManagerPlugin, task: Pick<ScheduledTask, "notePath" | "projectFolder">): string | null {
    const at = task.projectFolder === "" ? this.app.vault.getRoot() : task.projectFolder != null ? this.app.vault.getAbstractFileByPath(task.projectFolder) : null;
    const project = at instanceof import_obsidian.TFolder ? at : this.ticketProjectOf(task.notePath);
    return project ? this.ticketsFolderFor(project) : null;
  }
  fileFollowUp(this: AgentManagerPlugin, task: Pick<ScheduledTask, "name" | "notePath" | "projectFolder">, resultRel: string): Promise<string | null> {
    const next = (this._followUpQueue || Promise.resolve(null)).then(() => this._fileFollowUp(task, resultRel), () => this._fileFollowUp(task, resultRel));
    this._followUpQueue = next;
    return next;
  }
  async _fileFollowUp(this: AgentManagerPlugin, task: Pick<ScheduledTask, "name" | "notePath" | "projectFolder">, resultRel: string): Promise<string | null> {
    const say = (m: string) => { this.notifyDesktop(`“${task.name}”'s result wasn't filed in a ticket`, m, task.notePath); return null; };
    if (!this.ticketsOn()) return say("tickets are off.");
    const label = resultRel.slice(resultRel.lastIndexOf("/") + 1).replace(/\.md$/i, "");
    const link = wikilink(resultRel, label);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        let file = attempt === 0 ? this.followUpTicketOf(task) : null;
        if (!file) {
          const dir = this.followUpFolderOf(task);
          if (dir == null) return say("it has no project to put one in. Move the task into a project's folder.");
          await this.ensureFolder(dir);
          const text = await this.templateText(this.ticketTemplatePath(), TICKET_TEMPLATE);
          file = await this.app.vault.create(this.freeNotePath(dir, followUpName(task.name)), text);
          await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => { fm[FROM_TASK_PROPERTY] = wikilink(task.notePath, task.name); });
        }
        let stillOpen = false;
        await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
          if (this.ticketIsDone(fm) || this.fromTaskOfValue(fm[FROM_TASK_PROPERTY], file.path) !== task.notePath) return;
          stillOpen = true;
          const other = Object.keys(fm).find((k) => k !== "reads" && k.toLowerCase() === "reads");
          const prior: unknown[] = !other ? [] : Array.isArray(fm[other]) ? (fm[other] as unknown[]) : fm[other] ? [fm[other]] : [];
          if (other) delete fm[other];
          const reads = withRead(fm.reads, link);
          fm.reads = [...prior.filter((x) => !reads.some((y) => linkTarget(y) === linkTarget(x))), ...reads];
        });
        if (!stillOpen) continue;
        return file.path;
      }
      return say("its ticket changed while it was being filed.");
    } catch (e) {
      return say(stringOf(errorMessage(e)));
    }
  }
  fromTaskOfValue(this: AgentManagerPlugin, raw: unknown, from: string): string | null {
    const target = linkTarget(raw);
    return target ? this.app.metadataCache.getFirstLinkpathDest(target, from)?.path ?? null : null;
  }
  ticketNotesHeading(this: AgentManagerPlugin): string {
    return stringOf(this.pluginData.ticketNotesHeading ?? "").trim();
  }
  ticketHome(this: AgentManagerPlugin): string | null {
    const home = this.switchedAgent()?.home;
    return home ? home : null;
  }
  ticketProjects(this: AgentManagerPlugin): TFolder[] {
    return this.app.vault.getAllFolders(true).filter((f) => !isArchived(f.path) && this.isTicketProject(f)).sort((a, b) => a.path.localeCompare(b.path));
  }
  creationProjectGroups(this: AgentManagerPlugin): ProjectGroup[] {
    const projects = this.ticketProjects();
    const homed = this.agentList().filter((a) => a.home);
    const switched = this.ticketHome();
    const shown = switched ? homed.filter((a) => a.home === switched) : homed;
    const inside = (f: TFolder, home: string) => f.path.startsWith(`${home}/`);
    const shortName = (rel: string) => rel.replace(/^Projects\/(?=.)/i, "");
    const groups: ProjectGroup[] = shown.map((a) => {
      const home = a.home as string;
      return {
        label: homed.length ? a.name : null,
        options: [
          { text: `No Project - ${a.name}`, value: home },
          ...projects.filter((f) => inside(f, home)).map((f) => ({ text: shortName(f.path.slice(home.length + 1)), value: f.path })),
        ],
      };
    });
    if (!switched) {
      const rest = projects.filter((f) => !homed.some((a) => f.path === a.home || inside(f, a.home as string)));
      if (rest.length) groups.push({ label: homed.length ? "Other projects" : null, options: rest.map((f) => ({ text: f.isRoot() ? this.app.vault.getName() : shortName(f.path), value: f.path })) });
    }
    return groups;
  }
  creationProjectDefault(this: AgentManagerPlugin, groups: ProjectGroup[], from = ""): string {
    const all = groups.flatMap((g) => g.options.map((o) => o.value));
    if (from && all.includes(from)) return from;
    const home = this.ticketHome();
    if (home && all.includes(home)) return home;
    return all[0] ?? "";
  }
  creationAgentName(this: AgentManagerPlugin, folderPath: string): string | null {
    if (!this.agentList().length) return null;
    return this.agentById(this.launchAgentId({ folderPath }))?.name ?? "no agent profile";
  }
  isTicketProject(this: AgentManagerPlugin, f: TFolder): boolean {
    if (f.name === "Tickets") return false;
    return f.children.some((c) => c instanceof import_obsidian.TFolder && c.name === "Tickets") || this.app.vault.getAbstractFileByPath(this.overviewPathOf(f)) instanceof import_obsidian.TFile;
  }
  ticketProjectOf(this: AgentManagerPlugin, path: string | null | undefined): TFolder | null {
    if (!path || isArchived(path)) return null;
    const at = this.app.vault.getAbstractFileByPath(path);
    let f = at instanceof import_obsidian.TFolder ? at : at?.parent ?? null;
    for (; f; f = f.parent) if (this.isTicketProject(f)) return f;
    return null;
  }
  whenIndexed(this: AgentManagerPlugin, file: TFile): Promise<boolean> {
    const cache = this.app.metadataCache;
    if (cache.getFileCache(file)?.frontmatter) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = 0;
      const done = (read: boolean) => { cache.offref(ref); this.cancelTimeout(timer); resolve(read); };
      const ref = cache.on("changed", (f) => { if (f.path === file.path) done(true); });
      this.registerEvent(ref);
      timer = this.scheduleTimeout(() => done(false), 10000);
    });
  }
  async openTicketCardFrom(this: AgentManagerPlugin, from: Session): Promise<void> {
    const draft = this.ticketCard?.draft || { name: "", project: "", backend: null, notes: "" };
    const project = this.ticketProjectOf(from._notePath || from._folderPath);
    this.ticketCard = { open: true, draft: { ...draft, project: draft.project || (project ? project.path : "") }, from };
    await this.revealBrowser();
    const view = this.findBrowserLeaf()?.view;
    if (!isBrowser(view)) return;
    view._focusCard = "ticket";
    (view._revealCard || (view._revealCard = {})).ticket = true;
    view.renderBrowser();
  }

  projectFolderOf(this: AgentManagerPlugin, file: TFile): TFolder | null {
    const parent = file.parent;
    if (!parent) return null;
    return parent.name === "Tickets" && parent.parent ? parent.parent : parent;
  }
  overviewPathOf(this: AgentManagerPlugin, folder: TFolder): string {
    return folder.isRoot() ? this.overviewName() : `${folder.path}/${this.overviewName()}`;
  }
  async newOverview(this: AgentManagerPlugin, folder: TFolder): Promise<void> {
    const p = this.overviewPathOf(folder);
    if (this.app.vault.getAbstractFileByPath(p)) return;
    const template = stringOf(this.pluginData.overviewTemplate ?? "").trim();
    const text = (await this.templateText(template ? (0, import_obsidian.normalizePath)(template) : "", OVERVIEW_TEMPLATE)).replace(/\{\{name\}\}/g, folder.isRoot() ? this.app.vault.getName() : folder.name);
    try {
      const file = await this.app.vault.create(p, text);
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (e) {
      notice(`Agent Manager: couldn't make the project overview: ${stringOf(errorMessage(e))}`);
    }
  }
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
  async fileTicket(this: AgentManagerPlugin, file: TFile, project: TFolder): Promise<void> {
    const dir = this.ticketsFolderFor(project);
    try {
      await this.ensureFolder(dir);
      const dest = this.freeNotePath(dir, file.basename);
      await this.app.fileManager.renameFile(file, dest);
      notice(`Filed in ${dir}.`);
    } catch (e) {
      notice(`Agent Manager: couldn't move the ticket: ${stringOf(errorMessage(e))}`);
    }
  }
  async openTicketSession(this: AgentManagerPlugin, file: TFile): Promise<void> {
    const leaf = this.ticketMainLeaf(file.path);
    if (leaf) {
      void this.revealAndFlash(leaf);
      return;
    }
    const id = this.mainSessionIdOf(file.path);
    await this.handleProtocolLink(id ? { action: "agent-manager", op: "resume", session: id } : { action: "agent-manager", op: "new", note: file.path });
  }
  syncTicketActions(this: AgentManagerPlugin): void {
    const kept = (this._ticketActions ??= new Map<MarkdownView, { el: HTMLElement; state: "launch" | "resume" | "run" | "stop" }>());
    const seen = new Set<object>();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof import_obsidian.MarkdownView)) continue;
      const file = view.file;
      const ticket = !!file && this.ticketsOn() && this.isTicketNote(file.path);
      const task = !!file && !ticket && this.scheduledTasksOn() && this.isTaskNote(file.path);
      const had = kept.get(view);
      if (!ticket && !task) { if (had) { had.el.remove(); kept.delete(view); } continue; }
      seen.add(view);
      if (task) {
        const state = this.liveRuns().has(file.parent?.path ?? "") ? "stop" : "run";
        if (had?.state === state && had.el.isConnected) continue;
        had?.el.remove();
        const el = view.addAction(state === "stop" ? "square" : "play", state === "stop" ? "Stop this scheduled task's run" : "Run this scheduled task now", () => { void (async () => {
          const f = view.file;
          const v = f ? await this.taskViewByPath(f.path) : null;
          if (!v) return;
          if (v.running) this.stopRun(v.task);
          else await this.runNow(v);
        })(); });
        el.addClass("agent-manager-ticket-action");
        el.createSpan({ text: state === "stop" ? "Stop" : "Run now" });
        kept.set(view, { el, state });
        continue;
      }
      const resume = !!this.mainSessionIdOf(file.path) || !!this.ticketMainLeaf(file.path);
      const state = resume ? "resume" : "launch";
      if (had?.state === state && had.el.isConnected) continue;
      had?.el.remove();
      const el = view.addAction(resume ? "history" : "play", resume ? "Resume the ticket's session" : "Launch a session from this ticket", () => {
        const f = view.file;
        if (f) void this.openTicketSession(f);
      });
      el.addClass("agent-manager-ticket-action");
      el.createSpan({ text: resume ? "Resume" : "Launch" });
      kept.set(view, { el, state });
    }
    for (const [view, had] of kept) if (!seen.has(view)) { had.el.remove(); kept.delete(view); }
  }
  registerTickets(this: AgentManagerPlugin): void {
    this.app.workspace.onLayoutReady(() => {
      const sync = () => this.syncTicketActions();
      sync();
      this.registerEvent(this.app.workspace.on("layout-change", sync));
      this.registerEvent(this.app.workspace.on("file-open", sync));
      this.registerEvent(this.app.metadataCache.on("changed", sync));
      this.registerEvent(this.app.vault.on("rename", sync));
      this.registerEvent(this.app.metadataCache.on("changed", (file: TFile, data: string) => {
        if (!this.ticketsOn() || !this.isTicketNote(file.path)) return;
        for (const v of this.sessionObjects()) v.ticketChanged(file.path, data);
      }));
    });
    this.register(() => {
      for (const had of this._ticketActions?.values() ?? []) had.el.remove();
      this._ticketActions?.clear();
    });
    this.addCommand({
      id: "open-ticket-session",
      name: "Launch or resume this ticket's session",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.ticketsOn() || !this.isTicketNote(file.path)) return false;
        if (!checking) void this.openTicketSession(file);
        return true;
      },
    });
    const fresh = new Set<string>();
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("create", (f) => {
        if (f instanceof import_obsidian.TFile && f.extension === "md") { fresh.add(f.path); this.scheduleTimeout(() => fresh.delete(f.path), 60000); }
      }));
    });
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
