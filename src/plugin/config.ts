// Names and the opening a session is sent: settings with defaults, read in one place.

import { fs, import_obsidian, os, path } from "../externals.js";
import { DEFAULT_WRAP_MESSAGE, DEFAULT_ADDED_FOLDERS, DEFAULT_DAILY_NAME, DEFAULT_NAMES, DEFAULT_OPENING, DEFAULT_OVERVIEW_NAME, DEFAULT_TICKET_TEMPLATE, plainSessionName } from "../constants/names.js";
import { composeOpening, launchContext } from "../context/launch-context.js";
import type { ContextVault, LaunchContext, LaunchFrom } from "../context/launch-context.js";
import type { NameKey, OpeningKey } from "../constants/names.js";
import { isArray, stringOf, withinVault } from "../util/guards.js";
import type { AgentManagerPlugin } from "./main.js";
class ConfigMethods {
  // A folder or property name: the setting, else its default.
  nameOf(this: AgentManagerPlugin, key: NameKey): string {
    const v = this.pluginData.names?.[key];
    return typeof v === "string" && v.trim() ? v.trim() : DEFAULT_NAMES[key];
  }
  // A folder in the vault. A setting that would reach outside it (a ".." part) falls
  // back to the default.
  folderOf(this: AgentManagerPlugin, key: NameKey): string {
    const p = (0, import_obsidian.normalizePath)(this.nameOf(key));
    if (p.split("/").includes("..")) return (0, import_obsidian.normalizePath)(DEFAULT_NAMES[key]);
    return p;
  }
  // An opening template as stored. Unset means the default; an empty string means "send nothing".
  openingPart(this: AgentManagerPlugin, key: OpeningKey): string {
    const v = this.pluginData.opening?.[key];
    return typeof v === "string" ? v : DEFAULT_OPENING[key];
  }
  // A path from a setting as an absolute path, or null. A leading ~ is the home
  // folder; a relative path is relative to the vault.
  resolveUserPath(this: AgentManagerPlugin, value: unknown): string | null {
    let s = stringOf(value ?? "").trim();
    if (!s) return null;
    if (s === "~" || s.startsWith("~/")) s = path.join(os.homedir(), s.slice(1));
    return path.resolve(this.getVaultPath(), s);
  }
  // The added-folders setting as written, or the default when it has never been set.
  addedFolderSetting(this: AgentManagerPlugin): unknown[] {
    const v = this.pluginData.addedFolders;
    return isArray(v) ? v : DEFAULT_ADDED_FOLDERS;
  }
  // The added folders as absolute paths, each one that exists on this machine, in order.
  addedFolders(this: AgentManagerPlugin): string[] {
    const out: string[] = [];
    for (const entry of this.addedFolderSetting()) {
      const dir = this.resolveUserPath(entry);
      try { if (dir && fs.statSync(dir).isDirectory() && !out.includes(dir)) out.push(dir); } catch { /* best effort */ }
    }
    return out;
  }
  // ---- The starting folder ----
  // Every session starts in one folder, the "AGENTS.md folder" setting: a vault path, ""
  // for the vault's root. A renamed folder takes the setting with it (main.ts); one
  // that's gone stops launches (startFolderMissing) rather than fall back to the root.
  startFolder(this: AgentManagerPlugin): string {
    const v = stringOf(this.pluginData.startFolder ?? "").trim().replace(/^\/+|\/+$/g, "");
    return v ? (0, import_obsidian.normalizePath)(v) : "";
  }
  startFolderMissing(this: AgentManagerPlugin): boolean {
    const f = this.startFolder();
    return !!f && !(this.app.vault.getAbstractFileByPath(f) instanceof import_obsidian.TFolder);
  }
  // The starting folder as an absolute path.
  startDir(this: AgentManagerPlugin): string {
    const f = this.startFolder();
    return f ? path.join(this.getVaultPath(), f) : path.resolve(this.getVaultPath());
  }
  // The AGENTS.md the starting folder should hold, by vault path.
  agentsFilePath(this: AgentManagerPlugin): string {
    const f = this.startFolder();
    return f ? `${f}/AGENTS.md` : "AGENTS.md";
  }
  // Is a vault path inside the starting folder (or the folder itself)?
  inStartFolder(this: AgentManagerPlugin, vaultPath: string): boolean {
    const f = this.startFolder();
    return !f || vaultPath === f || String(vaultPath).startsWith(f + "/");
  }
  // Every folder a session of this plugin has run in, other than the vault's root, so
  // the session index still finds them after the setting changes (pluginData.sessionFolders).
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
  // ---- Today's chat ----
  // Today, YYYY-MM-DD in local time.
  todayString(this: AgentManagerPlugin): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  // Today's chat's name: the switched agent's while there are agents, else the setting,
  // with {{date}} filled in.
  dailyChatName(this: AgentManagerPlugin): string {
    const agent = this.switchedAgent();
    if (agent) return this.agentDailyName(agent);
    const v = this.pluginData.dailyChatName;
    const template = typeof v === "string" && v.trim() ? v.trim() : DEFAULT_DAILY_NAME;
    // As a launch names it (plainSessionName), so the lookups find the session it started.
    return plainSessionName(template.replace(/\{\{date\}\}/g, this.todayString()));
  }
  // What the Wrap button types: the setting, else the default; "" when it's turned off.
  wrapMessage(this: AgentManagerPlugin): string {
    const v = this.pluginData.wrapMessage;
    return typeof v === "string" ? v.trim() : DEFAULT_WRAP_MESSAGE;
  }
  // ---- Overviews and tickets ----
  // Both switches are off until the user turns them on.
  overviewsOn(this: AgentManagerPlugin): boolean {
    return this.pluginData.useOverviews === true;
  }
  ticketsOn(this: AgentManagerPlugin): boolean {
    return this.pluginData.useTickets === true;
  }
  // An overview's file name: the setting, with ".md" added when it's left off.
  overviewName(this: AgentManagerPlugin): string {
    const v = stringOf(this.pluginData.overviewName ?? "").trim().replace(/[\\/]/g, "");
    if (!v) return DEFAULT_OVERVIEW_NAME;
    return v.toLowerCase().endsWith(".md") ? v : `${v}.md`;
  }
  // The ticket template's vault path: the setting, else Templates/Ticket.md.
  ticketTemplatePath(this: AgentManagerPlugin): string {
    const v = withinVault(stringOf(this.pluginData.ticketTemplate ?? "").trim().replace(/^\/+/, ""));
    return (0, import_obsidian.normalizePath)(v || DEFAULT_TICKET_TEMPLATE);
  }
  // What launchContext reads: notes and their frontmatter, from Obsidian's cache.
  contextVault(this: AgentManagerPlugin): ContextVault {
    return {
      isNote: (p) => this.app.vault.getAbstractFileByPath(p) instanceof import_obsidian.TFile,
      frontmatter: (p) => {
        const f = this.app.vault.getAbstractFileByPath(p);
        return f instanceof import_obsidian.TFile ? (this.app.metadataCache.getFileCache(f)?.frontmatter ?? null) : null;
      },
    };
  }
  // What a session started from this note or folder gets: its ticket, the overviews
  // above it, and their repo (context/launch-context.ts).
  launchContext(this: AgentManagerPlugin, from: LaunchFrom): LaunchContext {
    return launchContext(from, this.contextVault(), {
      startFolder: this.startFolder(),
      useOverviews: this.overviewsOn(),
      useTickets: this.ticketsOn(),
      overviewName: this.overviewName(),
      templatePath: this.ticketTemplatePath(),
      resolvePath: (v) => this.resolveUserPath(v),
      homes: this.agentHomes(),
    });
  }
  // The opening instruction for a launch, as one line: the context parts that apply
  // (the agent, the overviews, then the repo), then the kind's own template: the ticket
  // template for a ticket, the note or folder one for a session started from one, the
  // daily one for today's chat, else the plain one. Empty when every part is. The agent
  // is the session's own (`agentId`), settled at launch.
  buildOpening(this: AgentManagerPlugin, { notePath, folderPath, daily, agentId }: { notePath?: string | null; folderPath?: string | null; daily?: boolean; agentId?: string | null } = {}): string {
    const vault = this.getVaultPath();
    const from = notePath || folderPath;
    const ctx: LaunchContext = from ? this.launchContext({ notePath, folderPath }) : { ticket: null, overviews: [], repo: null, agent: null };
    const vars: Record<string, string> = { path: from ? path.join(vault, from) : "", vault, date: this.todayString() };
    const kind = ctx.ticket ? "ticket" : notePath ? "note" : folderPath ? "folder" : daily ? "daily" : "plain";
    return composeOpening((key) => this.openingPart(key), ctx, kind, vars, (p) => path.join(vault, p), this.agentOpeningInfo(agentId));
  }
  // The Agent part alone, filled in, for a session that's told nothing else: "" for none.
  agentOpening(this: AgentManagerPlugin, agentId: string | null | undefined): string {
    const info = this.agentOpeningInfo(agentId);
    if (!info) return "";
    const empty: LaunchContext = { ticket: null, overviews: [], repo: null, agent: null };
    return composeOpening((key) => (key === "agent" ? this.openingPart("agent") : ""), empty, "plain", {}, (p) => p, info);
  }
  // Where a session's durable transcript is filed: the transcripts folder, or with an
  // agent, its folder there. `lockDir` is the transcripts folder either way.
  transcriptTarget(this: AgentManagerPlugin, agentId: string | null = null): { transcriptDir: string; lockDir: string } {
    return { transcriptDir: this.agentTranscriptDir(agentId), lockDir: this.folderOf("transcriptsFolder") };
  }
}
export { ConfigMethods };
