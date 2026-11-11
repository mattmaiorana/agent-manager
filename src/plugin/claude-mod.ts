
import { fs, import_obsidian, path } from "../externals.js";
import modFiles from "claude-mod-files";
import type { AgentManagerPlugin } from "./main.js";

const PICTURES_MOD = "inline-images";
const QUIET_MOD = "quiet-tools";
const MOD_NAMES = [...new Set(Object.keys(modFiles).map((rel) => rel.split("/")[0]))];

class ClaudeModMethods {
  async prepareClaudeMod(this: AgentManagerPlugin): Promise<void> {
    this._claudeModDir = null;
    try {
      const adapter = this.app.vault.adapter;
      const pluginDir = this.manifest?.dir;
      const vault = this.getVaultPath();
      if (!pluginDir || !vault) return;
      const root = import_obsidian.normalizePath(`${pluginDir}/claude-mod`);
      const wanted = new Set();
      for (const [rel, text] of Object.entries(modFiles)) {
        if (rel.split("/").some((part) => !part || part === "." || part === "..")) continue;
        const file = import_obsidian.normalizePath(`${root}/${rel}`);
        wanted.add(file);
        let current = null;
        if (await adapter.exists(file)) { try { current = await adapter.read(file); } catch { /* empty */ } }
        if (current === text) continue;
        const dir = file.slice(0, file.lastIndexOf("/"));
        if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
        await adapter.write(file, text);
      }
      const keep = new Set(MOD_NAMES.map((name) => import_obsidian.normalizePath(`${root}/${name}/.claude-plugin/types`)));
      const prune = async (dir: string): Promise<void> => {
        let listed;
        try { listed = await adapter.list(dir); } catch { return; }
        for (const file of listed.files) if (!wanted.has(file)) { try { await adapter.remove(file); } catch { /* empty */ } }
        for (const folder of listed.folders) if (!keep.has(folder)) await prune(folder);
      };
      await prune(root);
      this._claudeModDir = path.join(vault, root);
      const stateDir = this.claudeQuietStateDir();
      if (stateDir) { try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* empty */ } }
    } catch (e) {
      console.error("[Agent Manager] couldn't write the Claude mod:", e);
      this._claudeModDir = null;
    }
  }
  claudeQuietStateDir(this: AgentManagerPlugin): string | null {
    return this._claudeModDir ? path.join(path.dirname(this._claudeModDir), "quiet-state") : null;
  }
  claudeModDirs(this: AgentManagerPlugin): { dirs: string[]; quiet: boolean } {
    const root = this._claudeModDir;
    if (!root) return { dirs: [], quiet: false };
    const dirs: string[] = [];
    if (this.pluginData.claudePictures !== false && this.terminalSettings?.().showPictures !== false) dirs.push(path.join(root, PICTURES_MOD));
    const quiet = this.pluginData.claudeQuietTools !== false;
    if (quiet) dirs.push(path.join(root, QUIET_MOD));
    return { dirs, quiet };
  }
}
export { ClaudeModMethods };
