// Agents (src/context/agents.ts for the pure parts): which ones there are, which one a
// session gets, where its transcript goes, and moving a session or renaming an agent.
//
// Which agent a session gets is settled once, at launch (launchAgentId), and recorded by
// session id in pluginData.sessionAgents ("" for none), beside its name. A resume never
// works it out again. Before a session has an id, its tab holds it (`_agentId`, saved
// with the tab). A session the plugin didn't start has no record, and counts as none.

import { fs, import_obsidian, path } from "../externals.js";
import { DEFAULT_AGENT_DAILY_NAME, agentArgs, listedAgent, readAgents, shownUnder } from "../context/agents.js";
import type { AgentDef } from "../context/agents.js";
import type { TFile, WorkspaceLeaf } from "obsidian";
import type { AgentManagerPlugin } from "./main.js";

class AgentMethods {
  // Every agent in settings, in order, those turned off included (settings, and the
  // definitions a resume of an old session still needs).
  allAgents(this: AgentManagerPlugin): AgentDef[] {
    return readAgents(this.pluginData.agents);
  }
  // Is "Use agent profiles" on? Off by default, like overviews and tickets.
  agentsOn(this: AgentManagerPlugin): boolean {
    return this.pluginData.useAgents === true;
  }
  // The agents turned on, in order, while agent profiles are on (none while they're off):
  // what the switch, homes, and the Default agent use.
  agentList(this: AgentManagerPlugin): AgentDef[] {
    if (!this.agentsOn()) return [];
    return this.allAgents().filter((a) => a.enabled);
  }
  // Any agent by id, on or off: a session keeps its agent's definition while it's off.
  agentById(this: AgentManagerPlugin, id: string | null | undefined): AgentDef | null {
    if (!id) return null;
    return this.allAgents().find((a) => a.id === id) || null;
  }
  // What the sidebar's switch offers: each agent, and No agent ("") when the Default agent
  // is No agent, since then sessions can have none.
  switchChoices(this: AgentManagerPlugin): { id: string; name: string }[] {
    const choices = this.agentList().map((a) => ({ id: a.id, name: a.name }));
    if (choices.length && !this.defaultAgent()) choices.push({ id: "", name: "No agent profile" });
    return choices;
  }
  // The switch's pick, by id: an agent's, "" for No agent, or null when there are no
  // agents. Unpicked (or a pick that's gone), the Default agent, else No agent.
  switchedAgentId(this: AgentManagerPlugin): string | null {
    const choices = this.switchChoices();
    if (!choices.length) return null;
    const picked = this.pluginData.currentAgent;
    if (typeof picked === "string" && choices.some((c) => c.id === picked)) return picked;
    return this.defaultAgent()?.id ?? choices.find((c) => c.id === "")?.id ?? choices[0].id;
  }
  // The switched agent, or null for No agent or no agents.
  switchedAgent(this: AgentManagerPlugin): AgentDef | null {
    return this.agentById(this.switchedAgentId());
  }
  async setSwitchedAgent(this: AgentManagerPlugin, id: string): Promise<void> {
    this.pluginData.currentAgent = id;
    await this.savePluginData();
    this.refreshBrowsers();
  }
  // The Default agent setting: the agent a session from a note or folder outside every
  // home gets. Null (No agent) unless set to an agent that exists.
  defaultAgent(this: AgentManagerPlugin): AgentDef | null {
    const v = this.pluginData.defaultAgent;
    return typeof v === "string" ? (this.agentList().find((a) => a.id === v) || null) : null;
  }
  // The homes launchContext reads, by agent id, in settings order.
  agentHomes(this: AgentManagerPlugin): { id: string; home: string }[] {
    return this.agentList().filter((a) => a.home !== null).map((a) => ({ id: a.id, home: a.home as string }));
  }
  // Which agent a new session gets, as an id ("" for none): from a note or folder, its
  // home's agent, else the Default agent; with neither (the sidebar's card, Daily Chat,
  // the New session command, a link with no note), the switched agent.
  launchAgentId(this: AgentManagerPlugin, { notePath, folderPath }: { notePath?: string | null; folderPath?: string | null }): string {
    if (!this.agentList().length) return "";
    if (notePath || folderPath) {
      const home = this.launchContext({ notePath, folderPath }).agent;
      return home || this.defaultAgent()?.id || "";
    }
    return this.switchedAgentId() || "";
  }
  // A session's recorded agent: an id, "" for none, or undefined when nothing is recorded.
  recordedAgentId(this: AgentManagerPlugin, sessionId: string | null | undefined): string | undefined {
    if (!sessionId) return undefined;
    const map = this.pluginData.sessionAgents;
    if (!map || !Object.prototype.hasOwnProperty.call(map, sessionId)) return undefined;
    const v = map[sessionId];
    return typeof v === "string" ? v : undefined;
  }
  // Record a session's agent. Only the first record counts (a launch records it once);
  // Move to passes `overwrite`, which changes only where it's filed. A launch also
  // records the agent its conversation launched as (`launchAgentId`, else the same),
  // which nothing changes later.
  async recordSessionAgent(this: AgentManagerPlugin, sessionId: string | null | undefined, agentId: string, { overwrite = false, launchAgentId }: { overwrite?: boolean; launchAgentId?: string } = {}): Promise<void> {
    if (!sessionId) return;
    let changed = false;
    const cur = this.recordedAgentId(sessionId);
    if (cur !== agentId && (cur === undefined || overwrite)) {
      this.pluginData.sessionAgents = { ...(this.pluginData.sessionAgents || {}), [sessionId]: agentId };
      changed = true;
    }
    const launches = this.pluginData.sessionLaunchAgents || {};
    if (!overwrite && !Object.prototype.hasOwnProperty.call(launches, sessionId)) {
      this.pluginData.sessionLaunchAgents = { ...launches, [sessionId]: launchAgentId ?? agentId };
      changed = true;
    }
    if (changed) await this.savePluginData();
  }
  // The agent a session's conversation launched as, by id ("" for none): what a resume or
  // fork of it passes the CLI. Its filed agent for a session recorded before the two were
  // kept apart; undefined when nothing is recorded.
  launchAgentOf(this: AgentManagerPlugin, sessionId: string | null | undefined): string | undefined {
    if (!sessionId) return undefined;
    const v = this.pluginData.sessionLaunchAgents?.[sessionId];
    return typeof v === "string" ? v : this.recordedAgentId(sessionId);
  }
  // A listed session's agent: its record, else (a session too new to have one) its open
  // tab's; undefined when neither knows.
  agentOfSession(this: AgentManagerPlugin, s: { sessionId: string | null; backend: string; title: string }): string | undefined {
    const rec = this.recordedAgentId(s.sessionId);
    if (rec !== undefined) return rec;
    const leaf = this.getLeafForSession(s.title, s.backend, s.sessionId);
    return leaf ? this.agentOfLeaf(leaf) : undefined;
  }
  // An open tab's agent, loaded or not: the session's own, else what its saved state holds.
  agentOfLeaf(this: AgentManagerPlugin, leaf: WorkspaceLeaf): string | undefined {
    const v = this.sessionOf(leaf);
    if (v) return v.agentId();
    const st = this.savedSessionState(leaf);
    if (!st) return undefined;
    return this.recordedAgentId(st.sessionId) ?? st.agent;
  }
  // Is a session listed under the switch's pick? `agentId` is its recorded agent; one
  // with none is listed under the Default agent.
  agentShows(this: AgentManagerPlugin, agentId: string | null | undefined): boolean {
    return shownUnder(agentId, this.switchedAgentId(), new Set(this.agentList().map((a) => a.id)), this.defaultAgent()?.id || null);
  }
  // The agent a session is listed under, by id ("" for No agent).
  listedAgentOf(this: AgentManagerPlugin, agentId: string | null | undefined): string {
    return listedAgent(agentId, new Set(this.agentList().map((a) => a.id)), this.defaultAgent()?.id || null);
  }
  // An agent's instructions note as an absolute path, or "" when it has none.
  agentInstructionsPath(this: AgentManagerPlugin, agent: AgentDef): string {
    return agent.instructions ? path.join(this.getVaultPath(), (0, import_obsidian.normalizePath)(agent.instructions)) : "";
  }
  // The flags that give a CLI this agent (context/agents.ts, agentArgs). `fromId`: the
  // session a Claude resume or fork continues, whose recorded agent name is kept.
  agentLaunchArgs(this: AgentManagerPlugin, backend: string, agentId: string | null | undefined, resume: boolean, fromId: string | null = null): string[] {
    const agent = this.agentById(agentId);
    if (!agent) return [];
    const slug = backend === "claude" && fromId ? this.claudeAgentSetting(fromId) : null;
    return agentArgs(backend, { id: agent.id, name: agent.name, instructionsPath: this.agentInstructionsPath(agent) }, { resume, slug });
  }
  // The agent name a Claude conversation recorded (its last `agentSetting`), or null.
  claudeAgentSetting(this: AgentManagerPlugin, sessionId: string): string | null {
    const rec = this.readStore("claude", null, sessionId)[0];
    if (!rec) return null;
    try {
      const text = fs.readFileSync(rec.file, "utf8");
      const at = text.lastIndexOf('"agentSetting":"');
      if (at === -1) return null;
      const m = text.slice(at).match(/^"agentSetting":"([a-z0-9-]+)"/);
      return m ? m[1] : null;
    } catch { return null; }
  }
  // A session followed to a new id (a re-host, a compaction, a restore that picked the
  // continuation) takes its agent records with it, unless the new id has its own.
  carrySessionAgent(this: AgentManagerPlugin, oldId: string | null | undefined, newId: string | null | undefined): boolean {
    if (!oldId || !newId || oldId === newId) return false;
    let carried = false;
    for (const map of [this.pluginData.sessionAgents, this.pluginData.sessionLaunchAgents]) {
      if (map && oldId in map && !(newId in map)) { map[newId] = map[oldId]; carried = true; }
    }
    return carried;
  }
  // The Agent part of the opening, filled in, for an agent id; "" for none.
  agentOpeningInfo(this: AgentManagerPlugin, agentId: string | null | undefined): { name: string; instructions: string } | null {
    const agent = this.agentById(agentId);
    return agent ? { name: agent.name, instructions: this.agentInstructionsPath(agent) } : null;
  }
  // Where a new transcript note for an agent's session goes: its folder in the
  // transcripts folder; the transcripts folder itself for none.
  agentTranscriptDir(this: AgentManagerPlugin, agentId: string | null | undefined): string {
    const root = this.folderOf("transcriptsFolder");
    const agent = this.agentById(agentId);
    return agent ? (0, import_obsidian.normalizePath)(`${root}/${agent.name}`) : root;
  }
  // Today's chat's name for an agent: its own template ({{profile}} Daily Chat - {{date}} by
  // default), with {{profile}} and {{date}} filled in.
  agentDailyName(this: AgentManagerPlugin, agent: AgentDef): string {
    const t = agent.dailyName.trim() || DEFAULT_AGENT_DAILY_NAME;
    return t.replace(/\{\{profile\}\}/g, agent.name).replace(/\{\{date\}\}/g, this.todayString());
  }
  // Move a session to another agent: its record, its transcript note (into that agent's
  // folder, with its agent property), which list shows it, and the agent a side chat or
  // Continue Session from it starts as. The conversation itself keeps the agent it
  // started as: Claude ignores --agent on a resume, and Codex its instructions (tested
  // 2026-10-22, REFERENCE.md).
  async moveSessionToAgent(this: AgentManagerPlugin, sessionId: string, agentId: string): Promise<void> {
    await this.recordSessionAgent(sessionId, agentId, { overwrite: true });
    const note = this.findTranscriptNoteBySessionId(sessionId);
    if (note) await this.moveTranscriptNote(note, this.agentTranscriptDir(agentId), this.agentById(agentId)?.name || null);
    this.invalidateSessionIndex();
    this.refreshBrowsers();
  }
  // A transcript note moved into `dir` (a free name there if its own is taken), with its
  // agent property set to `agentName` (removed for none).
  // Under the transcript writer's lock for the session, so a capture can't write the
  // old path, or make a second note, while it moves.
  async moveTranscriptNote(this: AgentManagerPlugin, note: TFile, dir: string, agentName: string | null): Promise<void> {
    const tc = this._tc();
    const id = String(this.app.metadataCache.getFileCache(note)?.frontmatter?.session_id || "");
    const key = this.folderOf("transcriptsFolder") + "\n" + (id ? tc.noteIdKey(id) : note.path);
    await tc.withTranscriptLock(key, async () => {
      await this.app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
        if (agentName) fm.agent = agentName; else delete fm.agent;
      });
      if (note.parent?.path === dir) return;
      if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir).catch(() => {});
      let target = (0, import_obsidian.normalizePath)(`${dir}/${note.name}`);
      // A name that's taken gets the id's long key, the other name the lookups know.
      if (this.app.vault.getAbstractFileByPath(target) && id) {
        const title = note.basename.replace(/ \([0-9a-fA-F-]+\)$/, "");
        target = (0, import_obsidian.normalizePath)(`${dir}/${tc.transcriptBasename(id, title, true)}.md`);
      }
      if (this.app.vault.getAbstractFileByPath(target)) {
        new import_obsidian.Notice(`Agent Manager: “${target}” already exists, so the transcript note stayed where it was.`, 8000);
        return;
      }
      await this.app.fileManager.renameFile(note, target);
    });
  }
  // An agent renamed in settings: its transcript folder takes the new name (links follow),
  // and its notes' agent property too. Sessions are recorded by id, so they stay its own.
  async renameAgentFiles(this: AgentManagerPlugin, oldName: string, newName: string): Promise<void> {
    const root = this.folderOf("transcriptsFolder");
    const oldDir = this.app.vault.getAbstractFileByPath((0, import_obsidian.normalizePath)(`${root}/${oldName}`));
    if (!(oldDir instanceof import_obsidian.TFolder)) return;
    const notes = oldDir.children.filter((c): c is TFile => c instanceof import_obsidian.TFile && c.extension === "md");
    for (const n of notes) {
      try {
        await this.app.fileManager.processFrontMatter(n, (fm: Record<string, unknown>) => { if (fm.agent === oldName) fm.agent = newName; });
      } catch { /* best effort: a note with broken frontmatter keeps its old value */ }
    }
    const newPath = (0, import_obsidian.normalizePath)(`${root}/${newName}`);
    if (this.app.vault.getAbstractFileByPath(newPath)) {
      new import_obsidian.Notice(`Agent Manager: “${newPath}” already exists, so the old transcript folder kept its name.`, 8000);
      return;
    }
    await this.app.fileManager.renameFile(oldDir, newPath);
  }
}
export { AgentMethods };
