// The Claude mod that ships inside the plugin (claude-mod/README.md): the pictures a Claude
// session sends, drawn in the terminal. Its files come bundled in main.js as text, are written
// into the plugin's own folder when they differ from what's there, and each Claude start and
// resume loads them with --plugin-dir while "Show pictures" is on (sessions/controller.ts).
// Nothing is downloaded, and nothing is written to ~/.claude.

import { import_obsidian, path } from "../externals.js";
import modFiles from "claude-mod-files";
import type { AgentManagerPlugin } from "./main.js";

const MOD_NAME = "inline-images";

class ClaudeModMethods {
  // Writes the mod into <plugin folder>/claude-mod/ through Obsidian's adapter, rewriting
  // only files that changed and removing ones a newer build no longer ships. Remembers the
  // folder's full path for claudeModDir, or null when it couldn't be written (no Claude
  // session then gets the flag).
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
        // Only plain relative paths inside the mod: the map is the build's own, but checked anyway.
        if (rel.split("/").some((part) => !part || part === "." || part === "..")) continue;
        const file = import_obsidian.normalizePath(`${root}/${rel}`);
        wanted.add(file);
        let current = null;
        if (await adapter.exists(file)) { try { current = await adapter.read(file); } catch { /* rewritten below */ } }
        if (current === text) continue;
        const dir = file.slice(0, file.lastIndexOf("/"));
        if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
        await adapter.write(file, text);
      }
      // The API types Claude Code writes beside a mod it loads with --plugin-dir
      // (.claude-plugin/types/, "Written by Claude Code <version>") stay; anything else the
      // build doesn't ship goes.
      const keep = import_obsidian.normalizePath(`${root}/${MOD_NAME}/.claude-plugin/types`);
      const prune = async (dir: string): Promise<void> => {
        let listed;
        try { listed = await adapter.list(dir); } catch { return; }
        for (const file of listed.files) if (!wanted.has(file)) { try { await adapter.remove(file); } catch { /* best effort */ } }
        for (const folder of listed.folders) if (folder !== keep) await prune(folder);
      };
      await prune(root);
      this._claudeModDir = path.join(vault, root, MOD_NAME);
    } catch (e) {
      console.error("[Agent Manager] couldn't write the Claude mod:", e);
      this._claudeModDir = null;
    }
  }
  // The mod's folder for a Claude start, or null: written, and pictures are on.
  claudeModDir(this: AgentManagerPlugin): string | null {
    if (!this._claudeModDir) return null;
    return this.terminalSettings?.().showPictures === false ? null : this._claudeModDir;
  }
}
export { ClaudeModMethods };
