
import type { WorkspaceLeaf } from "obsidian";
import { import_obsidian, path } from "../externals.js";
import guideFiles from "guide-files";
import skillFiles from "skill-files";
import { SETUP_SESSION_NAME } from "../constants/names.js";
import { SetupChoiceModal } from "../ui/modals.js";
import type { SessionRecord } from "../types.js";
import type { AgentManagerPlugin } from "./main.js";

type LaunchSource = Parameters<AgentManagerPlugin["startResume"]>[1];

const SETUP_GUIDE = "vault-setup.md";

class GuideMethods {
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
  async writeBundle(this: AgentManagerPlugin, root: string, files: Record<string, string>): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(root))) await adapter.mkdir(root);
    const wanted = new Set<string>();
    for (const [rel, text] of Object.entries(files)) {
      if (rel.split("/").some((part) => !part || part === "." || part === "..")) continue;
      const file = import_obsidian.normalizePath(`${root}/${rel}`);
      wanted.add(file);
      let current: string | null = null;
      if (await adapter.exists(file)) { try { current = await adapter.read(file); } catch { /* empty */ } }
      if (current === text) continue;
      const dir = file.slice(0, file.lastIndexOf("/"));
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
      await adapter.write(file, text);
    }
    const prune = async (dir: string): Promise<void> => {
      let listed;
      try { listed = await adapter.list(dir); } catch { return; }
      for (const file of listed.files) if (!wanted.has(file)) { try { await adapter.remove(file); } catch { /* empty */ } }
      for (const folder of listed.folders) await prune(folder);
    };
    await prune(root);
  }
  guidesDir(this: AgentManagerPlugin): string | null {
    return this._guidesDir || null;
  }
  setupOpening(this: AgentManagerPlugin, agentId: string | null | undefined): string | null {
    const dir = this.guidesDir();
    if (!dir) return null;
    const guide = path.join(dir, SETUP_GUIDE);
    const line = `Read the setup guide at "${guide}" in full, and follow it. Change nothing in this vault without my yes until you've asked how I'd like you to work and I've answered.`;
    return [this.agentOpening(agentId), line].filter(Boolean).join(" ");
  }
  async openVaultSetup(this: AgentManagerPlugin, sourceView: LaunchSource = null): Promise<void> {
    if (this._openingSetup) return;
    this._openingSetup = true;
    try { await this._openVaultSetup(sourceView); } finally { this._openingSetup = false; }
  }
  async _openVaultSetup(this: AgentManagerPlugin, sourceView: LaunchSource): Promise<void> {
    if (!this.guidesDir()) {
      this.notify("Agent Manager", "The setup guide couldn't be written into the plugin's folder, so setup can't start. Try reloading the plugin.");
      return;
    }
    const leaf = this.setupLeaf();
    if (leaf) {
      void this.app.workspace.revealLeaf(leaf);
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
      return;
    }
    let sessions: SessionRecord[] = [];
    try { sessions = await this.listedSessions(); } catch { /* empty */ }
    const earlier = sessions.find((s) => s.displayName === SETUP_SESSION_NAME && this.inStartDir(s.cwd));
    const fresh = () => this.startVaultSetup();
    if (!earlier) { await fresh(); return; }
    new SetupChoiceModal(this.app, () => { void this.startResume(earlier, sourceView); }, () => { void fresh(); }).open();
  }
  async startVaultSetup(this: AgentManagerPlugin): Promise<void> {
    const offered = this.getBrowserBackends();
    const backend = offered.includes(this.getCurrentBackend()) ? this.getCurrentBackend() : offered[0];
    await this.startSession(SETUP_SESSION_NAME, null, { backendOverride: backend, setup: true });
  }
  inStartDir(this: AgentManagerPlugin, dir: string | null | undefined): boolean {
    return path.resolve(dir || this.getVaultPath()) === path.resolve(this.startDir());
  }
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
