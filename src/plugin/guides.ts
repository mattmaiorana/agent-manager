// The guides that ship inside the plugin (guides/ in the repo): instructions a session the
// plugin starts reads from a file, rather than typed into the terminal as its opening. Their
// text comes bundled in main.js, is written into the plugin's own folder when it differs from
// what's there, and the opening points at the file. Today that's "Set up this vault", whose
// guide is vault-setup.md. The starter skills (skills/ in the repo) are written beside them,
// for that guide to offer to copy into the user's own skills folder; once copied they're the
// user's, and the plugin never reads or changes the copies.

import type { WorkspaceLeaf } from "obsidian";
import { import_obsidian, path } from "../externals.js";
import guideFiles from "guide-files";
import skillFiles from "skill-files";
import { SETUP_SESSION_NAME } from "../constants/names.js";
import { SetupChoiceModal } from "../ui/modals.js";
import type { SessionRecord } from "../types.js";
import type { AgentManagerPlugin } from "./main.js";

// What started the setup: the sidebar, or nothing (settings, the command palette).
type LaunchSource = Parameters<AgentManagerPlugin["startResume"]>[1];

const SETUP_GUIDE = "vault-setup.md";

class GuideMethods {
  // Writes the guides into <plugin folder>/guides/ and the starter skills into
  // <plugin folder>/skills/. Remembers the guides folder's full path, or null when either
  // couldn't be written (setup then can't start, since the guide offers the skills).
  async prepareGuides(this: AgentManagerPlugin): Promise<void> {
    this._guidesDir = null;
    try {
      const pluginDir = this.manifest?.dir;
      const vault = this.getVaultPath();
      if (!pluginDir || !vault) return;
      const guides = import_obsidian.normalizePath(`${pluginDir}/guides`);
      await this.writeBundle(guides, guideFiles);
      await this.writeBundle(import_obsidian.normalizePath(`${pluginDir}/skills`), skillFiles);
      this._guidesDir = path.join(vault, guides);
    } catch (e) {
      console.error("[Agent Manager] couldn't write the guides:", e);
      this._guidesDir = null;
    }
  }
  // Writes `files` (relative path to text) under `root` through Obsidian's adapter,
  // rewriting only files that changed and removing ones a newer build no longer ships.
  async writeBundle(this: AgentManagerPlugin, root: string, files: Record<string, string>): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(root))) await adapter.mkdir(root);
    const wanted = new Set<string>();
    for (const [rel, text] of Object.entries(files)) {
      // Only plain relative paths inside the folder: the map is the build's own, but checked anyway.
      if (rel.split("/").some((part) => !part || part === "." || part === "..")) continue;
      const file = import_obsidian.normalizePath(`${root}/${rel}`);
      wanted.add(file);
      let current: string | null = null;
      if (await adapter.exists(file)) { try { current = await adapter.read(file); } catch { /* rewritten below */ } }
      if (current === text) continue;
      const dir = file.slice(0, file.lastIndexOf("/"));
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
      await adapter.write(file, text);
    }
    const prune = async (dir: string): Promise<void> => {
      let listed;
      try { listed = await adapter.list(dir); } catch { return; }
      for (const file of listed.files) if (!wanted.has(file)) { try { await adapter.remove(file); } catch { /* best effort */ } }
      for (const folder of listed.folders) await prune(folder);
    };
    await prune(root);
  }
  // The guides folder's full path, or null when it couldn't be written.
  guidesDir(this: AgentManagerPlugin): string | null {
    return this._guidesDir || null;
  }
  // The setup session's opening: the agent part, if any, then where the guide is. The
  // change-nothing-yet line is in the opening itself, so a guide that can't be read still
  // changes nothing. Null when the guide wasn't written.
  setupOpening(this: AgentManagerPlugin, agentId: string | null | undefined): string | null {
    const dir = this.guidesDir();
    if (!dir) return null;
    const guide = path.join(dir, SETUP_GUIDE);
    const line = `Read the setup guide at "${guide}" in full, and follow it. Change nothing in this vault without my yes until you've asked how I'd like you to work and I've answered.`;
    return [this.agentOpening(agentId), line].filter(Boolean).join(" ");
  }
  // Go to the setup session: its tab if open; else, when one ran before, ask whether to
  // resume it or start a fresh one; else start one on the default CLI.
  async openVaultSetup(this: AgentManagerPlugin, sourceView: LaunchSource = null): Promise<void> {
    // One at a time: a second click while the first is still looking would start two.
    if (this._openingSetup) return;
    this._openingSetup = true;
    try { await this._openVaultSetup(sourceView); } finally { this._openingSetup = false; }
  }
  async _openVaultSetup(this: AgentManagerPlugin, sourceView: LaunchSource): Promise<void> {
    if (!this.guidesDir()) {
      new import_obsidian.Notice("Agent Manager: the setup guide couldn't be written into the plugin's folder, so setup can't start. Try reloading the plugin.", 10000);
      return;
    }
    const leaf = this.setupLeaf();
    if (leaf) {
      void this.app.workspace.revealLeaf(leaf);
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
      return;
    }
    let sessions: SessionRecord[] = [];
    try { sessions = await this.listedSessions(); } catch { /* best effort */ }
    // Only one that ran in today's AGENTS.md folder: a setup from an earlier choice of
    // folder would work in the wrong place.
    const earlier = sessions.find((s) => s.displayName === SETUP_SESSION_NAME && this.inStartDir(s.cwd));
    const fresh = () => this.startVaultSetup();
    if (!earlier) { await fresh(); return; }
    new SetupChoiceModal(this.app, () => { void this.startResume(earlier, sourceView); }, () => { void fresh(); }).open();
  }
  // A new setup session on the default CLI.
  async startVaultSetup(this: AgentManagerPlugin): Promise<void> {
    const offered = this.getBrowserBackends();
    const backend = offered.includes(this.getCurrentBackend()) ? this.getCurrentBackend() : offered[0];
    await this.startSession(SETUP_SESSION_NAME, null, { backendOverride: backend, setup: true });
  }
  // Did a session run in the AGENTS.md folder? `dir` is its working folder, empty for the
  // vault's root.
  inStartDir(this: AgentManagerPlugin, dir: string | null | undefined): boolean {
    return path.resolve(dir || this.getVaultPath()) === path.resolve(this.startDir());
  }
  // The setup session's tab in today's AGENTS.md folder, loaded or not, or null.
  setupLeaf(this: AgentManagerPlugin): WorkspaceLeaf | null {
    for (const leaf of this.sessionLeaves()) {
      const v = this.sessionOf(leaf);
      const saved = v ? null : this.savedSessionState(leaf);
      const title = v ? v.sessionTitle : saved?.sessionTitle;
      const dir = v ? v.workingDir : saved?.workingDir;
      if (title === SETUP_SESSION_NAME && this.inStartDir(dir)) return leaf;
    }
    return null;
  }
}
export { GuideMethods };
