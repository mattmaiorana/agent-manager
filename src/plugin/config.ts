
import { fs, import_obsidian, os, path } from "../externals.js";
import { DEFAULT_WRAP_MESSAGE, DEFAULT_ADDED_FOLDERS, DEFAULT_DAILY_NAME, DEFAULT_NAMES, DEFAULT_NEW_BUTTON_NAME, DEFAULT_NEW_TICKET_BUTTON_NAME, DEFAULT_OPENING, DEFAULT_OVERVIEW_NAME, DEFAULT_TICKET_TEMPLATE, plainSessionName } from "../constants/names.js";
import { composeOpening, contextPrompt, emptyContext, launchContext } from "../context/launch-context.js";
import type { ContextVault, LaunchContext, LaunchFrom } from "../context/launch-context.js";
import { RUN_LOG_FILE, SESSION_RUN_RULES, TASK_PROPS } from "../constants/scheduled.js";
import type { NameKey, OpeningKey } from "../constants/names.js";
import { isArray, stringOf, withinVault } from "../util/guards.js";
import type { AgentManagerPlugin } from "./main.js";
import type { ContextSource } from "../types.js";
import { notice } from "../vault-terminal/notice";
class ConfigMethods {
  nameOf(this: AgentManagerPlugin, key: NameKey): string {
    const v = this.pluginData.names?.[key];
    return typeof v === "string" && v.trim() ? v.trim() : DEFAULT_NAMES[key];
  }
  folderOf(this: AgentManagerPlugin, key: NameKey): string {
    const p = (0, import_obsidian.normalizePath)(this.nameOf(key));
    if (p.split("/").includes("..")) return (0, import_obsidian.normalizePath)(DEFAULT_NAMES[key]);
    return p;
  }
  openingPart(this: AgentManagerPlugin, key: OpeningKey): string {
    const v = this.pluginData.opening?.[key];
    return typeof v === "string" ? v : DEFAULT_OPENING[key];
  }
  resolveUserPath(this: AgentManagerPlugin, value: unknown): string | null {
    let s = stringOf(value ?? "").trim();
    if (!s) return null;
    if (s === "~" || s.startsWith("~/")) s = path.join(os.homedir(), s.slice(1));
    return path.resolve(this.getVaultPath(), s);
  }
  addedFolderSetting(this: AgentManagerPlugin): unknown[] {
    const v = this.pluginData.addedFolders;
    return isArray(v) ? v : DEFAULT_ADDED_FOLDERS;
  }
  addedFolders(this: AgentManagerPlugin): string[] {
    const out: string[] = [];
    for (const entry of this.addedFolderSetting()) {
      const dir = this.resolveUserPath(entry);
      try { if (dir && fs.statSync(dir).isDirectory() && !out.includes(dir)) out.push(dir); } catch { /* empty */ }
    }
    return out;
  }
  startFolder(this: AgentManagerPlugin): string {
    const v = stringOf(this.pluginData.startFolder ?? "").trim().replace(/^\/+|\/+$/g, "");
    return v ? (0, import_obsidian.normalizePath)(v) : "";
  }
  startFolderMissing(this: AgentManagerPlugin): boolean {
    const f = this.startFolder();
    return !!f && !(this.app.vault.getAbstractFileByPath(f) instanceof import_obsidian.TFolder);
  }
  startDir(this: AgentManagerPlugin): string {
    const f = this.startFolder();
    return f ? path.join(this.getVaultPath(), f) : path.resolve(this.getVaultPath());
  }
  agentsFilePath(this: AgentManagerPlugin): string {
    const f = this.startFolder();
    return f ? `${f}/AGENTS.md` : "AGENTS.md";
  }
  inStartFolder(this: AgentManagerPlugin, vaultPath: string): boolean {
    const f = this.startFolder();
    return !f || vaultPath === f || String(vaultPath).startsWith(f + "/");
  }
  async rememberSessionFolder(this: AgentManagerPlugin, dir: string | null | undefined): Promise<void> {
    if (!dir) return;
    const abs = path.resolve(dir);
    if (abs === path.resolve(this.getVaultPath())) return;
    const list = isArray(this.pluginData.sessionFolders) ? this.pluginData.sessionFolders : [];
    if (list.includes(abs)) return;
    this.pluginData.sessionFolders = [...list, abs];
    this.invalidateSessionIndex();
    await this.savePluginData();
  }
  todayString(this: AgentManagerPlugin): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  newButtonName(this: AgentManagerPlugin): string {
    const v = stringOf(this.pluginData.newButtonName ?? "").trim();
    return v || DEFAULT_NEW_BUTTON_NAME;
  }
  newTicketButtonName(this: AgentManagerPlugin): string {
    const v = stringOf(this.pluginData.newTicketButtonName ?? "").trim();
    return v || DEFAULT_NEW_TICKET_BUTTON_NAME;
  }
  dailyChatName(this: AgentManagerPlugin, agentId?: string | null): string {
    const agent = agentId === undefined ? this.switchedAgent() : this.agentById(agentId);
    if (agent) return this.agentDailyName(agent);
    const v = this.pluginData.dailyChatName;
    const template = typeof v === "string" && v.trim() ? v.trim() : DEFAULT_DAILY_NAME;
    return plainSessionName(template.replace(/\{\{date\}\}/g, this.todayString()));
  }
  wrapMessage(this: AgentManagerPlugin): string {
    const v = this.pluginData.wrapMessage;
    return typeof v === "string" ? v.trim() : DEFAULT_WRAP_MESSAGE;
  }
  overviewsOn(this: AgentManagerPlugin): boolean {
    return this.pluginData.useOverviews === true;
  }
  ticketsOn(this: AgentManagerPlugin): boolean {
    return this.pluginData.useTickets === true;
  }
  overviewName(this: AgentManagerPlugin): string {
    const v = stringOf(this.pluginData.overviewName ?? "").trim().replace(/[\\/]/g, "");
    if (!v) return DEFAULT_OVERVIEW_NAME;
    return v.toLowerCase().endsWith(".md") ? v : `${v}.md`;
  }
  ticketTemplatePath(this: AgentManagerPlugin): string {
    const v = withinVault(stringOf(this.pluginData.ticketTemplate ?? "").trim().replace(/^\/+/, ""));
    return (0, import_obsidian.normalizePath)(v || DEFAULT_TICKET_TEMPLATE);
  }
  contextVault(this: AgentManagerPlugin): ContextVault {
    return {
      isNote: (p) => this.app.vault.getAbstractFileByPath(p) instanceof import_obsidian.TFile,
      frontmatter: (p) => {
        const f = this.app.vault.getAbstractFileByPath(p);
        return f instanceof import_obsidian.TFile ? (this.app.metadataCache.getFileCache(f)?.frontmatter ?? null) : null;
      },
      resolve: (link, from, asLink) => {
        const f = this.app.vault.getAbstractFileByPath((0, import_obsidian.normalizePath)(link));
        const exact = f instanceof import_obsidian.TFile ? { path: f.path, folder: false } : f instanceof import_obsidian.TFolder && !f.isRoot() ? { path: f.path, folder: true } : null;
        const note = (exact && !asLink) ? null : this.app.metadataCache.getFirstLinkpathDest(link, from);
        if (asLink && note) return { path: note.path, folder: false };
        return exact ?? (note ? { path: note.path, folder: false } : null);
      },
    };
  }
  launchContext(this: AgentManagerPlugin, from: LaunchFrom): LaunchContext {
    return launchContext(from, this.contextVault(), {
      startFolder: this.startFolder(),
      useOverviews: this.overviewsOn(),
      useTickets: this.ticketsOn(),
      overviewName: this.overviewName(),
      templatePath: this.ticketTemplatePath(),
      resolvePath: (v) => this.resolveUserPath(v),
      homes: this.agentHomes(),
      isTask: (p) => this.scheduledTasksOn() && this.isTaskNote(p),
    });
  }
  buildOpening(this: AgentManagerPlugin, { notePath, folderPath, daily, agentId }: { notePath?: string | null; folderPath?: string | null; daily?: boolean; agentId?: string | null } = {}): string {
    const vault = this.getVaultPath();
    const from = notePath || folderPath;
    const ctx: LaunchContext = from ? this.launchContext({ notePath, folderPath }) : emptyContext();
    if (ctx.missingReads.length) notice(`Agent Manager: this ${ctx.task ? "scheduled task" : "ticket"}'s reads name ${ctx.missingReads.length === 1 ? "something" : "things"} that isn't in the vault, so the session isn't told ${ctx.missingReads.length === 1 ? "it" : "them"}: ${ctx.missingReads.join(", ")}.`);
    const vars: Record<string, string> = { path: from ? path.join(vault, from) : "", vault, date: this.todayString() };
    const task = ctx.ticket ? this.followUpTaskOf(ctx.ticket) : null;
    if (task) vars.task = path.join(vault, task);
    if (ctx.task) vars.runlog = path.join(vault, path.posix.dirname(ctx.task), RUN_LOG_FILE);
    const kind = task ? "followUp" : ctx.ticket ? "ticket" : ctx.task ? "task" : notePath ? "note" : folderPath ? "folder" : daily ? "daily" : "plain";
    return composeOpening((key) => this.openingPart(key), ctx, kind, vars, (p) => path.join(vault, p), this.agentOpeningInfo(agentId));
  }
  followUpTaskOf(this: AgentManagerPlugin, ticketPath: string): string | null {
    if (!this.canBeFollowUp(ticketPath)) return null;
    const task = this.fromTaskOf(ticketPath);
    if (!task || !this.isTaskNote(task)) return null;
    const fm = this.contextVault().frontmatter(task) || {};
    const followUp: unknown = fm[TASK_PROPS.followUp];
    return typeof followUp === "string" && followUp.trim().toLowerCase() === "ticket" ? task : null;
  }
  agentOpening(this: AgentManagerPlugin, agentId: string | null | undefined): string {
    const info = this.agentOpeningInfo(agentId);
    if (!info) return "";
    return composeOpening((key) => (key === "agent" ? this.openingPart("agent") : ""), emptyContext(), "plain", {}, (p) => p, info);
  }
  sourceString(this: AgentManagerPlugin, src: { notePath?: string | null; folderPath?: string | null } | null | undefined): string | null {
    if (src?.notePath) return src.notePath;
    if (src?.folderPath) return `${src.folderPath}/`;
    return null;
  }
  pinnedContext(this: AgentManagerPlugin, from: string | null | undefined, run = false): string {
    const at = this.contextFromString(from);
    if (!at) return "";
    const vault = this.getVaultPath();
    const ctx = this.launchContext(at);
    const kind = ctx.ticket ? "ticket" : ctx.task ? "task" : at.folderPath ? "folder" : "note";
    const followUp = !!ctx.ticket && !!this.followUpTaskOf(ctx.ticket);
    return contextPrompt(ctx, { kind, path: (at.notePath || at.folderPath) as string }, (key) => !!this.openingPart(followUp && key === "ticket" ? "followUp" : key).trim(), (p) => path.join(vault, p), run && !!ctx.task);
  }
  runSystemPrompt(this: AgentManagerPlugin, from: string | null | undefined): string {
    return [this.pinnedContext(from, true), SESSION_RUN_RULES].filter(Boolean).join(" ");
  }
  contextFromString(this: AgentManagerPlugin, from: string | null | undefined): { notePath?: string; folderPath?: string } | null {
    if (!from) return null;
    if (from.endsWith("/")) {
      const f = this.app.vault.getAbstractFileByPath(from.slice(0, -1));
      return f instanceof import_obsidian.TFolder && !f.isRoot() ? { folderPath: f.path } : null;
    }
    return this.app.vault.getAbstractFileByPath(from) instanceof import_obsidian.TFile ? { notePath: from } : null;
  }
  recordedContextSource(this: AgentManagerPlugin, sessionId: string | null | undefined): ContextSource | undefined {
    if (!sessionId) return undefined;
    const map = this.pluginData.sessionSources;
    return map && Object.prototype.hasOwnProperty.call(map, sessionId) ? map[sessionId] : undefined;
  }
  contextSourceOf(this: AgentManagerPlugin, sessionId: string | null | undefined): string | null {
    const rec = this.recordedContextSource(sessionId);
    if (rec && (rec.from === null || this.contextFromString(rec.from))) return rec.from;
    return this.sourceString(this.sourceOf(sessionId)) ?? rec?.from ?? null;
  }
  async recordContextSource(this: AgentManagerPlugin, sessionId: string | null | undefined, src: ContextSource | null | undefined): Promise<void> {
    if (!sessionId || !src || this.recordedContextSource(sessionId)) return;
    this.pluginData.sessionSources = { ...(this.pluginData.sessionSources || {}), [sessionId]: { from: src.from, pinned: src.pinned, ...(src.run ? { run: true } : {}) } };
    await this.savePluginData();
  }
  transcriptTarget(this: AgentManagerPlugin, agentId: string | null = null): { transcriptDir: string; lockDir: string } {
    return { transcriptDir: this.agentTranscriptDir(agentId), lockDir: this.folderOf("transcriptsFolder") };
  }
}
export { ConfigMethods };
