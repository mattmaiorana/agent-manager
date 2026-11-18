
import type { TAbstractFile, TFile } from "obsidian";
import { fs, import_obsidian, path } from "../externals.js";
import { DEFAULT_SCHEDULED_FOLDER, DEFAULT_TASK_TEMPLATE, SHARED_TASK_CHOICE, PROMPT_HEADING, RUN_LOG_FILE, TASK_TEMPLATE } from "../constants/scheduled.js";
import type { NewTaskDraft } from "../constants/scheduled.js";
import type { NotifyWhere } from "../vault-terminal/settings";
import { ticketFileName } from "../tickets/new-ticket.js";
import { ApprovalModal } from "../ui/approval.js";
import { draftChanges, taskDenyList, withPrompt } from "../scheduled/task-draft.js";
import { parseRunLog, runParseStarted, runResultPath, RUN_FINE_OUTCOMES } from "../scheduled/run-core.js";
import type { RunRow } from "../scheduled/run-core.js";
import { runFailuresInARow } from "../scheduled/clock-core.js";
import { schedNext } from "../scheduled/schedule-core.js";
import { isTaskFrontmatter, reachHash, reachKey, readTask, resolveReach, webListLink } from "../scheduled/task-model.js";
import type { ResolvedReach, ScheduledTask } from "../scheduled/task-model.js";
import { errorMessage, isArray, stringOf, withinVault } from "../util/guards.js";
import type { AgentManagerPlugin } from "./main.js";
import { notice } from "../vault-terminal/notice";

export interface TaskView {
  task: ScheduledTask;
  runs: RunRow[];
  state: "fix" | "approve" | "paused" | "held" | "ok";
  why: string;
  next: Date | null;
  reach: ResolvedReach;
  key: string;
  hash: string;
  approved: boolean;
  unread: number;
  running: boolean;
}

const ON_KEY = "agent-manager-scheduler-on";
const ON_SINCE_KEY = "agent-manager-scheduler-on-since";
const APPROVALS_KEY = "agent-manager-task-approvals";
const SEEN_KEY = "agent-manager-results-seen";
const TOUCHED_KEY = "agent-manager-task-touched";

class SchedulerMethods {
  scheduledTasksOn(this: AgentManagerPlugin): boolean {
    return this.pluginData.useScheduledTasks === true;
  }
  scheduledFolder(this: AgentManagerPlugin): string {
    const v = withinVault(stringOf(this.pluginData.scheduledFolder ?? "").trim().replace(/^\/+|\/+$/g, ""));
    return (0, import_obsidian.normalizePath)(v || DEFAULT_SCHEDULED_FOLDER);
  }
  taskTemplatePath(this: AgentManagerPlugin): string {
    const v = withinVault(stringOf(this.pluginData.taskTemplate ?? "").trim().replace(/^\/+/, ""));
    return (0, import_obsidian.normalizePath)(v || DEFAULT_TASK_TEMPLATE);
  }
  schedSettings(this: AgentManagerPlugin): { commitRuns: boolean; runsAtOnce: number; timeLimitMin: number; latestOutputs: number; fineTo: NotifyWhere; fineSeconds: number } {
    const raw = this.pluginData.scheduler;
    const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const n = (v: unknown, d: number) => { const x = Math.floor(Number(v)); return Number.isFinite(x) && x >= 1 ? x : d; };
    return { commitRuns: s.commitRuns !== false, runsAtOnce: n(s.runsAtOnce, 3), timeLimitMin: n(s.timeLimitMin, 30), latestOutputs: n(s.latestOutputs, 50), fineTo: s.fineTo === "desktop" || s.fineTo === "obsidian" || s.fineTo === "both" ? s.fineTo : "none", fineSeconds: [0, 5, 10, 30, 60].includes(Number(s.fineSeconds)) ? Number(s.fineSeconds) : 5 };
  }
  neverReadSetting(this: AgentManagerPlugin): string[] {
    const v = this.pluginData.neverRead;
    return isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : [];
  }
  neverReadPaths(this: AgentManagerPlugin): string[] {
    const out: string[] = [];
    const linked = (p: string) => { try { const real = fs.realpathSync(p); if (real !== p) out.push(real); } catch { /* empty */ } };
    for (const p of this.neverReadSetting().map((x) => this.resolveUserPath(x)).filter((x): x is string => !!x)) { out.push(p); linked(p); }
    return [...new Set(out)];
  }
  schedulerOn(this: AgentManagerPlugin): boolean {
    try { return this.app.loadLocalStorage(ON_KEY) === true; } catch { return false; }
  }
  setSchedulerOn(this: AgentManagerPlugin, on: boolean): void {
    try { if (on && !this.schedulerOn()) this.app.saveLocalStorage(ON_SINCE_KEY, Date.now()); } catch { /* empty */ }
    try { this.app.saveLocalStorage(ON_KEY, on); } catch { /* empty */ }
    if (on) void this.schedulerTick();
    this.refreshBrowsers();
  }
  taskApprovals(this: AgentManagerPlugin): Record<string, string> {
    let raw: unknown = null;
    try { raw = this.app.loadLocalStorage(APPROVALS_KEY); } catch { /* empty */ }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
    return out;
  }
  isTaskNote(this: AgentManagerPlugin, notePath: string): boolean {
    if (notePath === this.taskTemplatePath()) return false;
    return isTaskFrontmatter(this.contextVault().frontmatter(notePath));
  }
  taskPaths(this: AgentManagerPlugin): Set<string> {
    if (!this._taskPaths) {
      const set = new Set<string>();
      for (const f of this.app.vault.getMarkdownFiles()) if (this.isTaskNote(f.path)) set.add(f.path);
      this._taskPaths = set;
    }
    return this._taskPaths;
  }
  watchScheduledTasks(this: AgentManagerPlugin): void {
    const touched = (p: string) => this._taskPaths && [...this._taskPaths].some((t) => p === t || p.startsWith(path.posix.dirname(t) + "/"));
    const stale = () => { this._taskCache = null; };
    const changed = () => {
      stale();
      if (this._taskRedraw) return;
      this._taskRedraw = this.scheduleTimeout(() => { this._taskRedraw = null; if (this.scheduledTasksOn()) this.refreshBrowsers(); }, 300);
    };
    this.registerEvent(this.app.metadataCache.on("resolved", () => {
      if (this._taskPathsResolved) return;
      this._taskPathsResolved = true;
      this._taskPaths = null;
      changed();
      if (this.scheduledTasksOn() && this.layoutReady) void this.cleanupLeftoverRuns();
    }));
    this.registerEvent(this.app.metadataCache.on("changed", (file: TFile) => {
      const was = this._taskPaths?.has(file.path) ?? false;
      const is = this.isTaskNote(file.path);
      if (this._taskPaths) { if (is) this._taskPaths.add(file.path); else this._taskPaths.delete(file.path); }
      if (was || is || touched(file.path)) changed(); else stale();
    }));
    this.registerEvent(this.app.vault.on("create", () => stale()));
    this.registerEvent(this.app.workspace.on("file-open", (f) => {
      if (!f || !this.scheduledTasksOn()) return;
      void this.scheduledTasks().then((all) => {
        if (all.some((e) => e.runs.some((r) => runResultPath(r.Result) === f.path))) this.markResultSeen(f.path);
      });
    }));
    this.registerEvent(this.app.vault.on("delete", (file: TAbstractFile) => {
      if (!this._taskPaths) return;
      const hit = [...this._taskPaths].filter((t) => t === file.path || t.startsWith(file.path + "/"));
      for (const t of hit) this._taskPaths.delete(t);
      if (hit.length || touched(file.path)) changed(); else stale();
    }));
    this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
      this.moveSeenResults(oldPath, file.path);
      if (!this._taskPaths) return;
      let hit = false;
      for (const t of [...this._taskPaths]) {
        if (t === oldPath || t.startsWith(oldPath + "/")) {
          this._taskPaths.delete(t);
          this._taskPaths.add(file.path + t.slice(oldPath.length));
          hit = true;
        }
      }
      if (file.path.endsWith(".md") && this.isTaskNote(file.path)) { this._taskPaths.add(file.path); hit = true; }
      for (const b of this.browserViews()) {
        const scope = b.browserScope;
        if (scope && scope.page === "task" && (scope.notePath === oldPath || scope.notePath.startsWith(oldPath + "/"))) b.browserScope = { page: "task", notePath: file.path + scope.notePath.slice(oldPath.length) };
      }
      if (hit || touched(file.path)) changed(); else stale();
    }));
  }
  resetTaskIndex(this: AgentManagerPlugin): void {
    this._taskPaths = null;
    this._taskCache = null;
    this.refreshBrowsers();
  }
  async scheduledTasks(this: AgentManagerPlugin): Promise<{ task: ScheduledTask; runs: RunRow[] }[]> {
    if (!this._taskCache) {
      this._taskCache = this._readTasks().catch((e) => {
        console.error("[Agent Manager] could not read scheduled tasks:", e);
        this._taskCache = null;
        return [];
      });
    }
    return this._taskCache;
  }
  async _readTasks(this: AgentManagerPlugin): Promise<{ task: ScheduledTask; runs: RunRow[] }[]> {
    const paths = [...this.taskPaths()].sort();
    const folders = paths.map((p) => path.posix.dirname(p));
    const vault = {
      projectOf: (taskFolder: string) => this.taskProjectOf(taskFolder),
      isFolder: (p: string) => this.app.vault.getAbstractFileByPath(p) instanceof import_obsidian.TFolder,
      isFile: (p: string) => this.app.vault.getAbstractFileByPath(p) instanceof import_obsidian.TFile,
      inOtherTask: (p: string, own: string) => folders.some((f) => f !== own && f !== "." && (p === f || p.startsWith(f + "/"))),
      resolve: (link: string, from: string, asLink?: boolean) => this.contextVault().resolve?.(link, from, asLink) ?? null,
    };
    const out: { task: ScheduledTask; runs: RunRow[] }[] = [];
    for (const notePath of paths) {
      const file = this.app.vault.getAbstractFileByPath(notePath);
      if (!(file instanceof import_obsidian.TFile)) continue;
      let text = "";
      try { text = await this.app.vault.cachedRead(file); } catch { /* empty */ }
      const frontmatter = this.contextVault().frontmatter(notePath);
      const listLink = webListLink(frontmatter?.web);
      const listFile = listLink ? this.app.metadataCache.getFirstLinkpathDest(listLink, notePath) : null;
      let listText: string | null = null;
      if (listFile instanceof import_obsidian.TFile) { try { listText = await this.app.vault.cachedRead(listFile); } catch { /* empty */ } }
      const siteListNote = () => (listFile instanceof import_obsidian.TFile && listText != null ? { path: listFile.path, text: listText } : null);
      const task = readTask({ notePath, frontmatter, text }, { ...vault, siteListNote }, { now: new Date(), configDir: this.app.vault.configDir, normalize: import_obsidian.normalizePath });
      if (task.followUp === "ticket") {
        if (!this.ticketsOn()) task.problems.push("Its follow-up is a ticket, but tickets are off: turn them on in settings, or leave follow-up empty.");
        else if (this.followUpFolderOf(task) == null) task.problems.push("Its follow-up is a ticket, but it has no project to put the ticket in: move it into a project's folder (one with an overview).");
      }
      out.push({ task, runs: await this.readRunLog(task) });
    }
    const live = out.filter((e) => !e.task.archived);
    for (const e of live) {
      const same = live.filter((x) => x.task.name === e.task.name);
      if (same.length < 2) continue;
      const place = this.taskPlace(e.task);
      const clash = same.some((x) => x !== e && this.taskPlace(x.task) === place);
      e.task.label = `${e.task.name} (${clash ? path.posix.dirname(e.task.folder) : place})`;
    }
    return out;
  }
  taskPlace(this: AgentManagerPlugin, t: ScheduledTask): string {
    if (t.projectFolder) return path.posix.basename(t.projectFolder);
    if (t.projectFolder === "") return this.app.vault.getName();
    const parent = path.posix.dirname(t.folder);
    const up = path.posix.basename(parent) === DEFAULT_SCHEDULED_FOLDER ? path.posix.dirname(parent) : parent;
    return up && up !== "." ? path.posix.basename(up) : this.app.vault.getName();
  }
  taskProjectOf(this: AgentManagerPlugin, taskFolder: string): string | null {
    const above = taskFolder ? path.posix.dirname(taskFolder) : "";
    const overviews = this.launchContext({ folderPath: above === "." ? "" : above }).overviews;
    const nearest = overviews[overviews.length - 1];
    if (nearest == null) return null;
    const dir = path.posix.dirname(nearest);
    return dir === "." ? "" : dir;
  }
  async deleteTask(this: AgentManagerPlugin, t: ScheduledTask): Promise<boolean> {
    const own = !!t.folder && path.posix.basename(t.folder) === t.name;
    const target = this.app.vault.getAbstractFileByPath(own ? t.folder : t.notePath);
    if (!target) return false;
    const body = own
      ? `This deletes the folder “${t.folder}”: the task's note, its run log, its results there, and its memory.${t.output ? " Results it wrote elsewhere stay." : ""}`
      : `This deletes the note “${t.notePath}”.`;
    if (!(await this.askConfirm(`Delete “${t.label}”?`, body, "Delete"))) return false;
    try {
      await this.app.fileManager.trashFile(target);
    } catch (e) {
      console.error("[Agent Manager] task delete failed:", e);
      notice({ head: "Couldn't delete the scheduled task", detail: t.label });
      return false;
    }
    const approvals = this.taskApprovals();
    if (approvals[t.notePath]) {
      delete approvals[t.notePath];
      try { this.app.saveLocalStorage(APPROVALS_KEY, approvals); } catch { /* empty */ }
    }
    return true;
  }
  async approveTask(this: AgentManagerPlugin, v: TaskView): Promise<boolean> {
    if (v.task.problems.length) { notice({ head: `“${v.task.label}” can't be approved yet`, detail: v.task.problems[0] }); return false; }
    const ok = await new Promise<boolean>((resolve) => new ApprovalModal(this.app, v, this.app.vault.getName(), resolve, () => { this.openTaskEditor(v.task.notePath); }).open());
    if (!ok) return false;
    const approvals = this.taskApprovals();
    approvals[v.task.notePath] = v.key;
    try { this.app.saveLocalStorage(APPROVALS_KEY, approvals); } catch { /* empty */ }
    this.touchTask(v.task.notePath);
    this.refreshBrowsers();
    return true;
  }
  taskTouched(this: AgentManagerPlugin): Record<string, number> {
    let raw: unknown = null;
    try { raw = this.app.loadLocalStorage(TOUCHED_KEY); } catch { /* empty */ }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "number") out[k] = v;
    return out;
  }
  touchTask(this: AgentManagerPlugin, notePath: string): void {
    const t = this.taskTouched();
    t[notePath] = Date.now();
    try { this.app.saveLocalStorage(TOUCHED_KEY, t); } catch { /* empty */ }
  }
  async updateTask(this: AgentManagerPlugin, notePath: string, before: NewTaskDraft, after: NewTaskDraft): Promise<boolean> {
    const f = this.app.vault.getAbstractFileByPath(notePath);
    if (!(f instanceof import_obsidian.TFile)) { notice({ head: "The scheduled task's note is gone", detail: notePath }); return false; }
    const { set, drop } = draftChanges(before, after);
    try {
      if (Object.keys(set).length || drop.length) {
        await this.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(set)) { if (v == null) delete fm[k]; else fm[k] = v; }
          for (const k of drop) delete fm[k];
        });
      }
      if (after.prompt.trim() !== before.prompt.trim()) await this.app.vault.process(f, (text) => withPrompt(text, after.prompt));
    } catch (e) { notice({ head: "The scheduled task couldn't be saved", detail: stringOf(errorMessage(e)) }); return false; }
    return true;
  }
  openTaskEditor(this: AgentManagerPlugin, notePath: string): void {
    const view = this.findBrowserLeaf()?.view as { openTaskEditor?: (p: string) => void } | undefined;
    if (view?.openTaskEditor) view.openTaskEditor(notePath);
    else void this.openTaskNoteFile(notePath);
  }
  async openTaskNoteFile(this: AgentManagerPlugin, notePath: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(notePath);
    if (f instanceof import_obsidian.TFile) await this.app.workspace.getLeaf(false).openFile(f);
  }
  async setTaskPaused(this: AgentManagerPlugin, t: ScheduledTask, paused: boolean): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(t.notePath);
    if (!(f instanceof import_obsidian.TFile)) return;
    if (!paused) this.touchTask(t.notePath);
    await this.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => { fm.paused = paused; });
  }
  newTaskFolder(this: AgentManagerPlugin, project = ""): string {
    if (project === SHARED_TASK_CHOICE) return this.scheduledFolder();
    const p = project.replace(/^\/+|\/+$/g, "");
    if (p) return (0, import_obsidian.normalizePath)(`${p}/${DEFAULT_SCHEDULED_FOLDER}`);
    const home = this.ticketHome();
    return home ? (0, import_obsidian.normalizePath)(`${home}/${DEFAULT_SCHEDULED_FOLDER}`) : this.scheduledFolder();
  }
  async createTask(this: AgentManagerPlugin, opts: Pick<NewTaskDraft, "name" | "project" | "schedule" | "prompt"> & Partial<NewTaskDraft>): Promise<TFile | null> {
    const name = ticketFileName(opts.name);
    if (!name) { notice("Name the scheduled task"); return null; }
    const dir = (0, import_obsidian.normalizePath)(`${this.newTaskFolder(opts.project)}/${name}`);
    if (this.app.vault.getAbstractFileByPath(dir)) { notice({ head: "Name the scheduled task something else", detail: `There's already a “${name}” in ${path.posix.dirname(dir)}.` }); return null; }
    try {
      await this.ensureFolder(dir);
      let text = await this.templateText(this.taskTemplatePath(), TASK_TEMPLATE);
      const prompt = opts.prompt.replace(/\r\n?/g, "\n").trim();
      if (prompt) {
        const re = new RegExp(`^(##[ \\t]+${PROMPT_HEADING}[ \\t]*\\r?\\n)(?:[ \\t]*\\r?\\n)*`, "m");
        text = re.test(text) ? text.replace(re, (_w, h: string) => `${h}\n${prompt}\n\n`) : `${text.replace(/\s*$/, "")}\n\n## ${PROMPT_HEADING}\n\n${prompt}\n`;
      }
      const file = await this.app.vault.create(`${dir}/${name}.md`, text);
      await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        fm.type = "scheduled task";
        if (opts.schedule) fm.schedule = opts.schedule;
        delete fm.project;
        const listLink = /^\[\[[^\]]+\]\]$/.test((opts.sites || "").trim()) ? (opts.sites || "").trim() : "";
        const sites = (opts.sites || "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
        const webOf = (fallback: string): string | string[] => opts.web === "sites" && listLink ? listLink : opts.web === "sites" && sites.length ? sites : opts.web === "search" || opts.web === "off" ? opts.web : fallback;
        fm.mode = "full";
        fm.web = webOf(fm.web == null || fm.web === "" ? "off" : fm.web as string);
        const sw = (key: string, v: boolean | undefined, on: string, off: string, fallback: string) => {
          if (v != null) fm[key] = v ? on : off;
          else if (fm[key] == null || fm[key] === "") fm[key] = fallback;
        };
        sw("connectors", opts.connectors, "on", "none", "on");
        sw("shell", opts.shell, "true", "false", "true");
        sw("chrome", opts.chrome == null ? undefined : opts.chrome && opts.web === "search", "on", "off", "off");
        if (opts.obsidianCli?.length) fm["obsidian-cli"] = [...opts.obsidianCli];
        const deny = taskDenyList(opts.deny || "");
        if (deny.length) fm.deny = deny;
        sw("own-folder-only", opts.ownFolder, "true", "false", "false");
        if (fm.shell === "true" || fm.shell === "false") fm.shell = fm.shell === "true";
        if (fm["own-folder-only"] === "true" || fm["own-folder-only"] === "false") fm["own-folder-only"] = fm["own-folder-only"] === "true";
        if (opts.closeTab != null) fm.tab = opts.closeTab ? "close" : "keep";
        else if (fm.tab == null || fm.tab === "") fm.tab = "keep";
        for (const k of ["file-access", "tools", "writes"]) delete fm[k];
        if (opts.eachRun) fm["each-run"] = opts.eachRun;
        if (opts.followUp != null) fm["follow-up"] = opts.followUp ? "ticket" : null;
        if (opts.onlyWhenNew != null) fm["only-when-new"] = opts.onlyWhenNew;
        if (opts.model) fm.model = opts.model;
        if (opts.reads?.length) fm.reads = opts.reads.map((p) => (p.endsWith("/") ? `[[${p}]]` : `[[${p.replace(/\.md$/, "")}]]`));
      });
      return file;
    } catch (e) {
      notice({ head: "Couldn't make the scheduled task", detail: stringOf(errorMessage(e)) });
      return null;
    }
  }
  _seenResults(this: AgentManagerPlugin): { since: number; paths: string[] } {
    let raw: unknown = null;
    try { raw = this.app.loadLocalStorage(SEEN_KEY); } catch { /* empty */ }
    const r = raw && typeof raw === "object" ? (raw as { since?: unknown; paths?: unknown }) : null;
    if (r && typeof r.since === "number" && isArray(r.paths)) return { since: r.since, paths: r.paths.filter((x): x is string => typeof x === "string") };
    const fresh = { since: Date.now(), paths: [] as string[] };
    try { this.app.saveLocalStorage(SEEN_KEY, fresh); } catch { /* empty */ }
    return fresh;
  }
  resultUnread(this: AgentManagerPlugin, r: RunRow, seen = this._seenResults()): boolean {
    const p = runResultPath(r.Result);
    if (!p || r.Outcome !== "succeeded") return false;
    const at = runParseStarted(r.Started);
    return !!at && at.getTime() >= seen.since && !seen.paths.includes(p);
  }
  markResultSeen(this: AgentManagerPlugin, p: string): boolean {
    const s = this._seenResults();
    if (s.paths.includes(p)) return false;
    s.paths.push(p);
    if (s.paths.length > 3000) s.paths = s.paths.slice(-3000);
    try { this.app.saveLocalStorage(SEEN_KEY, s); } catch { /* empty */ }
    this.refreshBrowsers();
    return true;
  }
  moveSeenResults(this: AgentManagerPlugin, from: string, to: string): void {
    const s = this._seenResults();
    let moved = false;
    s.paths = s.paths.map((p) => {
      if (p !== from && !p.startsWith(from + "/")) return p;
      moved = true;
      return to + p.slice(from.length);
    });
    if (!moved) return;
    try { this.app.saveLocalStorage(SEEN_KEY, s); } catch { /* empty */ }
  }
  markResultUnseen(this: AgentManagerPlugin, p: string): void {
    const s = this._seenResults();
    if (!s.paths.includes(p)) return;
    s.paths = s.paths.filter((x) => x !== p);
    try { this.app.saveLocalStorage(SEEN_KEY, s); } catch { /* empty */ }
    this.refreshBrowsers();
  }
  markResultsSeen(this: AgentManagerPlugin, paths: string[]): void {
    const s = this._seenResults();
    const add = paths.filter((p) => !s.paths.includes(p));
    if (!add.length) return;
    s.paths.push(...add);
    if (s.paths.length > 3000) s.paths = s.paths.slice(-3000);
    try { this.app.saveLocalStorage(SEEN_KEY, s); } catch { /* empty */ }
    this.refreshBrowsers();
  }
  async readRunLog(this: AgentManagerPlugin, t: ScheduledTask): Promise<RunRow[]> {
    const p = (0, import_obsidian.normalizePath)(`${t.folder}/${RUN_LOG_FILE}`);
    try {
      if (!(await this.app.vault.adapter.exists(p))) return [];
      return parseRunLog(await this.app.vault.adapter.read(p)).map((r) => {
        const rel = runResultPath(r.Result);
        if (!rel || this.app.vault.getAbstractFileByPath(rel)) return r;
        const f = this.app.metadataCache.getFirstLinkpathDest(rel.replace(/\.md$/, ""), p);
        return f ? { ...r, Result: `[[${f.path}|${f.basename}]]` } : r;
      });
    } catch { return []; }
  }
  taskAgentId(this: AgentManagerPlugin, t: ScheduledTask): string {
    if (!this.launchContext({ folderPath: t.folder }).agent && this.inScheduledFolder(t.folder)) return "";
    return this.launchAgentId({ folderPath: t.folder });
  }
  sharedFolderHasNoAgent(this: AgentManagerPlugin): boolean {
    return !this.launchContext({ folderPath: this.scheduledFolder() }).agent;
  }
  sharedTaskChoice(this: AgentManagerPlugin): boolean {
    return this.agentList().some((a) => !!a.home) && this.sharedFolderHasNoAgent();
  }
  inScheduledFolder(this: AgentManagerPlugin, folder: string): boolean {
    const root = this.scheduledFolder();
    return folder === root || folder.startsWith(`${root}/`);
  }
  taskReach(this: AgentManagerPlugin, t: ScheduledTask): ResolvedReach {
    const agent = this.agentById(this.taskAgentId(t));
    return resolveReach(t, {
      vaultAbs: path.resolve(this.getVaultPath()),
      agent: agent ? { name: agent.name } : null,
      neverRead: this.neverReadPaths(),
      startAbs: path.resolve(this.startDir()),
    });
  }
  taskView(this: AgentManagerPlugin, task: ScheduledTask, runs: RunRow[], now = new Date()): TaskView {
    const reach = this.taskReach(task);
    const key = reachKey(reach);
    const approved = this.taskApprovals()[task.notePath] === key;
    const held = runFailuresInARow(runs) >= 3;
    const last = runs[0];
    const lastFailed = !!last && !RUN_FINE_OUTCOMES.includes(last.Outcome) && last.Outcome !== "missed";
    let state: TaskView["state"] = "ok", why = "";
    if (task.paused) { state = "paused"; why = "Paused."; }
    else if (task.problems.length) { state = "fix"; why = task.problems[0]; }
    else if (held) { state = "held"; why = "Held after three failed runs in a row."; }
    else if (!approved) { state = "approve"; why = this.taskApprovals()[task.notePath] ? "Its reach changed since it was approved on this computer." : "Not approved on this computer yet."; }
    else if (lastFailed) { state = "fix"; why = `Last run ${last.Outcome}${last.Note ? `: ${last.Note}` : "."}`; }
    const runnable = state === "ok" || (state === "fix" && !task.problems.length);
    const seen = this._seenResults();
    const unread = runs.filter((r) => this.resultUnread(r, seen)).length;
    return { task, runs, state, why, next: runnable ? schedNext(task.rules, now) : null, reach, key, hash: reachHash(key), approved, unread, running: !!this.runFor(task) };
  }
  async taskViews(this: AgentManagerPlugin): Promise<TaskView[]> {
    const now = new Date();
    const views = (await this.scheduledTasks()).filter((e) => !e.task.archived).map((e) => this.taskView(e.task, e.runs, now));
    return views.sort((a, b) => (a.next ? a.next.getTime() : Infinity) - (b.next ? b.next.getTime() : Infinity) || a.task.name.localeCompare(b.task.name));
  }
  async taskViewByPath(this: AgentManagerPlugin, notePath: string): Promise<TaskView | null> {
    const e = (await this.scheduledTasks()).find((x) => x.task.notePath === notePath);
    return e ? this.taskView(e.task, e.runs) : null;
  }
}
export { SchedulerMethods };
