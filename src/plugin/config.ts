// Names and the opening a session is sent: settings with defaults, read in one place.

import { fs, import_obsidian, os, path } from "../externals.js";
import { DEFAULT_ADDED_FOLDERS, DEFAULT_DAILY_NAME, DEFAULT_NAMES, DEFAULT_OPENING } from "../constants/names.js";
import type { NameKey, OpeningKey } from "../constants/names.js";
import { isArray, stringOf } from "../util/guards.js";
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
  // Today's chat's name: the setting, with {{date}} filled in.
  dailyChatName(this: AgentManagerPlugin): string {
    const v = this.pluginData.dailyChatName;
    const template = typeof v === "string" && v.trim() ? v.trim() : DEFAULT_DAILY_NAME;
    return template.replace(/\{\{date\}\}/g, this.todayString());
  }
  // The opening instruction for a launch, as one line: the note or folder template for
  // a session started from one, the daily one for today's chat, else the plain one.
  // Empty when the template is.
  buildOpening(this: AgentManagerPlugin, { notePath, folderPath, daily }: { notePath?: string | null; folderPath?: string | null; daily?: boolean } = {}): string {
    const vault = this.getVaultPath();
    const from = notePath || folderPath;
    const vars: Record<string, string> = {
      path: from ? path.join(vault, from) : "",
      vault,
      date: this.todayString(),
    };
    return this.openingPart(notePath ? "note" : folderPath ? "folder" : daily ? "daily" : "plain")
      .replace(/\s*\n\s*/g, " ")
      .trim()
      .replace(/\{\{(\w+)\}\}/g, (whole, k: string) => (k in vars ? vars[k] : whole));
  }
  // Where every session's durable transcript is filed: one folder.
  transcriptTarget(this: AgentManagerPlugin): { transcriptDir: string } {
    return { transcriptDir: this.folderOf("transcriptsFolder") };
  }
}
export { ConfigMethods };
