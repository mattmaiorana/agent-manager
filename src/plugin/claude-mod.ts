// The Claude mods that ship inside the plugin (claude-mod/README.md): inline-images, the pictures
// a Claude session sends, drawn in the terminal; and quiet-tools, /quiet folding each tool's
// output into one line. Their files come bundled in main.js as text, are written into the plugin's
// own folder when they differ from what's there, and each Claude start and resume loads each one
// with --plugin-dir while its setting is on (sessions/controller.ts): pictures while "Show
// pictures Claude sends you" and "Pictures in the terminal" are on, quiet-tools while "Fold tool
// output" is. Nothing is downloaded, and nothing is written to ~/.claude.

import { fs, import_obsidian, path } from "../externals.js";
import modFiles from "claude-mod-files";
import type { AgentManagerPlugin } from "./main.js";

const PICTURES_MOD = "inline-images";
const QUIET_MOD = "quiet-tools";
// Every mod the build bundled (esbuild.config.mjs bundles each folder in claude-mod/), so the
// types Claude Code lays beside each are kept whatever is added later.
const MOD_NAMES = [...new Set(Object.keys(modFiles).map((rel) => rel.split("/")[0]))];

class ClaudeModMethods {
  // Writes the mods into <plugin folder>/claude-mod/ through Obsidian's adapter, rewriting
  // only files that changed and removing ones a newer build no longer ships. Remembers the
  // folder's full path for claudeModDirs, or null when it couldn't be written (no Claude
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
      const keep = new Set(MOD_NAMES.map((name) => import_obsidian.normalizePath(`${root}/${name}/.claude-plugin/types`)));
      const prune = async (dir: string): Promise<void> => {
        let listed;
        try { listed = await adapter.list(dir); } catch { return; }
        for (const file of listed.files) if (!wanted.has(file)) { try { await adapter.remove(file); } catch { /* best effort */ } }
        for (const folder of listed.folders) if (!keep.has(folder)) await prune(folder);
      };
      await prune(root);
      this._claudeModDir = path.join(vault, root);
      // quiet-tools' state files (claudeQuietStateDir) are per start, so none outlives a load.
      const stateDir = this.claudeQuietStateDir();
      if (stateDir) { try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ } }
    } catch (e) {
      console.error("[Agent Manager] couldn't write the Claude mod:", e);
      this._claudeModDir = null;
    }
  }
  // Where quiet-tools writes whether /quiet is on, one file per session tab (strip.ts,
  // _prepareQuietState): <plugin folder>/quiet-state/, beside claude-mod/, whose pruning
  // would remove it. Null until the mods are written.
  claudeQuietStateDir(this: AgentManagerPlugin): string | null {
    return this._claudeModDir ? path.join(path.dirname(this._claudeModDir), "quiet-state") : null;
  }
  // The mods' folders for a Claude start, each while its setting is on; none when they
  // couldn't be written. Pictures: both picture settings on. Quiet tools: on unless turned off.
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
