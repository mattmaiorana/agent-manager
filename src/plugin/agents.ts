
import { fs, import_obsidian, path } from "../externals.js";
import { DEFAULT_AGENT_DAILY_NAME, agentArgs, agentRunIndex, arrangedOrder, listedAgent, readAgents, shownUnder, profileColor } from "../context/agents.js";
import type { AgentDef } from "../context/agents.js";
import { readFileTail } from "../sessions/transcript-files.js";
import { plainSessionName } from "../constants/names.js";
import type { TFile, WorkspaceLeaf, WorkspaceParent } from "obsidian";
import type { AgentManagerPlugin } from "./main.js";
import { notice } from "../vault-terminal/notice";

function tabMark(header: HTMLElement, cls: string, on: boolean): void {
  const have = Array.from(header.children).find((c) => c.classList.contains(cls));
  if (on && !have) header.createDiv({ cls, attr: { "aria-hidden": "true" } });
  else if (!on && have) have.remove();
}

class AgentMethods {
  allAgents(this: AgentManagerPlugin): AgentDef[] {
    return readAgents(this.pluginData.agents);
  }
  agentsOn(this: AgentManagerPlugin): boolean {
    return this.pluginData.useAgents === true;
  }
  agentList(this: AgentManagerPlugin): AgentDef[] {
    if (!this.agentsOn()) return [];
    return this.allAgents().filter((a) => a.enabled);
  }
  agentById(this: AgentManagerPlugin, id: string | null | undefined): AgentDef | null {
    if (!id) return null;
    return this.allAgents().find((a) => a.id === id) || null;
  }
  switchChoices(this: AgentManagerPlugin): { id: string; name: string }[] {
    const choices = this.agentList().map((a) => ({ id: a.id, name: a.name }));
    if (choices.length && !this.defaultAgent()) choices.push({ id: "", name: "No agent profile" });
    return choices;
  }
  switchedAgentId(this: AgentManagerPlugin): string | null {
    const choices = this.switchChoices();
    if (!choices.length) return null;
    const picked = this.pluginData.currentAgent;
    if (typeof picked === "string" && choices.some((c) => c.id === picked)) return picked;
    return this.defaultAgent()?.id ?? choices.find((c) => c.id === "")?.id ?? choices[0].id;
  }
  switchedAgent(this: AgentManagerPlugin): AgentDef | null {
    return this.agentById(this.switchedAgentId());
  }
  async setSwitchedAgent(this: AgentManagerPlugin, id: string): Promise<void> {
    this.pluginData.currentAgent = id;
    await this.savePluginData();
    this.refreshBrowsers();
  }
  defaultAgent(this: AgentManagerPlugin): AgentDef | null {
    const v = this.pluginData.defaultAgent;
    const set = typeof v === "string" ? (this.agentList().find((a) => a.id === v) || null) : null;
    return set ?? (this.noAgentOn() ? null : this.agentList()[0] ?? null);
  }
  noAgentOn(this: AgentManagerPlugin): boolean {
    return this.pluginData.noAgentProfile === true;
  }
  agentHomes(this: AgentManagerPlugin): { id: string; home: string }[] {
    return this.agentList().filter((a) => a.home !== null).map((a) => ({ id: a.id, home: a.home as string }));
  }
  launchAgentId(this: AgentManagerPlugin, { notePath, folderPath }: { notePath?: string | null; folderPath?: string | null }): string {
    if (!this.agentList().length) return "";
    if (notePath || folderPath) {
      const home = this.launchContext({ notePath, folderPath }).agent;
      return home || this.defaultAgent()?.id || "";
    }
    return this.switchedAgentId() || "";
  }
  recordedAgentId(this: AgentManagerPlugin, sessionId: string | null | undefined): string | undefined {
    if (!sessionId) return undefined;
    const map = this.pluginData.sessionAgents;
    if (!map || !Object.prototype.hasOwnProperty.call(map, sessionId)) return undefined;
    const v = map[sessionId];
    return typeof v === "string" ? v : undefined;
  }
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
  launchAgentOf(this: AgentManagerPlugin, sessionId: string | null | undefined): string | undefined {
    if (!sessionId) return undefined;
    const v = this.pluginData.sessionLaunchAgents?.[sessionId];
    return typeof v === "string" ? v : this.recordedAgentId(sessionId);
  }
  agentOfSession(this: AgentManagerPlugin, s: { sessionId: string | null; backend: string; title: string }): string | undefined {
    const rec = this.recordedAgentId(s.sessionId);
    if (rec !== undefined) return rec;
    const leaf = this.getLeafForSession(s.title, s.backend, s.sessionId);
    return leaf ? this.agentOfLeaf(leaf) : undefined;
  }
  agentOfLeaf(this: AgentManagerPlugin, leaf: WorkspaceLeaf): string | undefined {
    const v = this.sessionOf(leaf);
    if (v) return v.agentId();
    const st = this.savedSessionState(leaf);
    if (!st) return undefined;
    return this.recordedAgentId(st.sessionId) ?? st.agent;
  }
  agentColor(this: AgentManagerPlugin, agentId: string | null | undefined): string {
    return this.shownColor(agentId)?.color ?? "";
  }
  agentBlackText(this: AgentManagerPlugin, agentId: string | null | undefined): boolean {
    return this.shownColor(agentId)?.blackText ?? false;
  }
  pinnedShown(this: AgentManagerPlugin): boolean {
    const profile = this.switchedAgent();
    return profile ? profile.pinnedOn : this.pluginData.pinnedSection !== false;
  }
  colorsOn(this: AgentManagerPlugin): boolean {
    return this.pluginData.agentColors === true;
  }
  shownColor(this: AgentManagerPlugin, agentId: string | null | undefined): { color: string; blackText: boolean } | null {
    if (!agentId || !this.colorsOn()) return null;
    const all = this.allAgents();
    const i = all.findIndex((a) => a.id === agentId && a.enabled);
    return i === -1 || !this.agentsOn() ? null : profileColor(all[i], i);
  }
  tabAgentOf(this: AgentManagerPlugin, leaf: WorkspaceLeaf): string {
    return this.listedAgentOf(this.agentOfLeaf(leaf));
  }
  paintAgentTab(this: AgentManagerPlugin, leaf: WorkspaceLeaf): void {
    const group = leaf.parent;
    const tabs = group?.type === "tabs" ? (group.children as WorkspaceLeaf[]) : [leaf];
    const sessions = new Set(this.sessionLeaves());
    let prev: string | null = null;
    let prevEl: HTMLElement | null = null;
    let any = false;
    for (const tab of tabs) {
      const el = tab.tabHeaderEl;
      const agent = sessions.has(tab) ? this.tabAgentOf(tab) : null;
      const color = agent === null ? "" : this.agentColor(agent);
      const starts = agent !== null && prev !== null && prev !== agent && !!(color || this.agentColor(prev));
      if (el) {
        el.setCssProps({ "--agent-manager-profile-color": color });
        el.toggleClass("agent-manager-profile-tab", !!color);
        tabMark(el, "agent-manager-profile-line", !!color);
        tabMark(el, "agent-manager-profile-divider", starts);
        el.toggleClass("agent-manager-profile-run-start", starts);
        el.toggleClass("agent-manager-profile-run-end", false);
      }
      if (starts) prevEl?.addClass("agent-manager-profile-run-end");
      if (color) any = true;
      prev = agent;
      prevEl = el ?? null;
    }
    tabs[0]?.tabHeaderEl?.parentElement?.toggleClass("agent-manager-profile-tabs", any);
  }
  paintAgentTabs(this: AgentManagerPlugin): void {
    const now = { agents: this.agentsOn(), colors: this.agentsOn() && this.colorsOn() };
    const was = this._arrangeSeen;
    this._arrangeSeen = now;
    if (was && ((now.agents && !was.agents) || (now.colors && !was.colors))) { this.arrangeAgentTabs(); return; }
    const groups = new Set<unknown>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (groups.has(leaf.parent)) return;
      groups.add(leaf.parent);
      this.paintAgentTab(leaf);
    });
  }
  unpaintAgentTabs(this: AgentManagerPlugin): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const el = leaf.tabHeaderEl;
      if (!el) return;
      tabMark(el, "agent-manager-profile-line", false);
      tabMark(el, "agent-manager-profile-divider", false);
      el.removeClasses(["agent-manager-profile-tab", "agent-manager-profile-run-start", "agent-manager-profile-run-end"]);
      el.setCssProps({ "--agent-manager-profile-color": "" });
      el.parentElement?.removeClass("agent-manager-profile-tabs");
    });
  }
  refreshAgentColors(this: AgentManagerPlugin): void {
    this.paintAgentTabs();
    for (const session of this.sessionObjects()) session.refreshStripAgent();
    this.refreshBrowsers();
  }
  placeInAgentRun(this: AgentManagerPlugin, leaf: WorkspaceLeaf): void {
    if (!this.agentsOn()) return;
    const group = leaf.parent;
    if (group?.type !== "tabs" || typeof group.removeChild !== "function" || typeof group.insertChild !== "function") return;
    const kids = group.children as WorkspaceLeaf[];
    const sessions = new Set(this.sessionLeaves());
    const to = agentRunIndex(kids.map((l) => (sessions.has(l) ? this.tabAgentOf(l) : undefined)), kids.indexOf(leaf));
    if (to < 0) return;
    const ws = this.app.workspace;
    const focused = this.activeLeaf() === leaf;
    const shown = focused || (typeof group.currentTab === "number" && group.currentTab === kids.indexOf(leaf));
    group.removeChild(leaf);
    try {
      group.insertChild(to, leaf);
    } catch (e) {
      console.error("[Agent Manager] placing a tab with its agent's", e);
      try { group.insertChild(kids.length, leaf); } catch { /* empty */ }
      return;
    }
    if (shown) group.selectTabIndex?.(to);
    if (focused) ws.setActiveLeaf(leaf, { focus: true });
    ws.requestSaveLayout();
  }
  arrangeAgentTabs(this: AgentManagerPlugin): void {
    if (!this.agentsOn()) return;
    const ws = this.app.workspace;
    const sessions = new Set(this.sessionLeaves());
    const groups = new Set<WorkspaceParent>();
    ws.iterateAllLeaves((l) => { if (l.parent?.type === "tabs") groups.add(l.parent); });
    const focused = this.activeLeaf();
    let moved = false;
    for (const group of groups) {
      const remove = group.removeChild?.bind(group);
      const insert = group.insertChild?.bind(group);
      if (!remove || !insert || !group.children) continue;
      const live = group.children;
      const kids = [...live];
      const order = arrangedOrder(kids.map((l) => (sessions.has(l) ? this.tabAgentOf(l) : undefined)));
      if (order.every((k, i) => k === i)) continue;
      const shown = typeof group.currentTab === "number" ? kids[group.currentTab] : undefined;
      try {
        order.forEach((k, to) => {
          const leaf = kids[k];
          if (live[to] === leaf) return;
          remove(leaf);
          insert(to, leaf);
        });
      } catch (e) {
        console.error("[Agent Manager] arranging tabs by agent", e);
      }
      if (shown) group.selectTabIndex?.(live.indexOf(shown));
      moved = true;
    }
    if (!moved) { this.paintAgentTabs(); return; }
    if (focused) ws.setActiveLeaf(focused, { focus: true });
    ws.requestSaveLayout();
    this.paintAgentTabs();
  }
  agentShows(this: AgentManagerPlugin, agentId: string | null | undefined): boolean {
    return shownUnder(agentId, this.switchedAgentId(), new Set(this.agentList().map((a) => a.id)), this.defaultAgent()?.id || null);
  }
  listedAgentOf(this: AgentManagerPlugin, agentId: string | null | undefined): string {
    return listedAgent(agentId, new Set(this.agentList().map((a) => a.id)), this.defaultAgent()?.id || null);
  }
  agentInstructionsPath(this: AgentManagerPlugin, agent: AgentDef): string {
    return agent.instructions ? path.join(this.getVaultPath(), (0, import_obsidian.normalizePath)(agent.instructions)) : "";
  }
  agentLaunchArgs(this: AgentManagerPlugin, backend: string, agentId: string | null | undefined, resume: boolean, fromId: string | null = null, context = ""): string[] {
    const agent = this.agentById(agentId);
    const slug = agent && backend === "claude" && fromId ? this.claudeAgentSetting(fromId) : null;
    return agentArgs(backend, agent ? { id: agent.id, name: agent.name, instructionsPath: this.agentInstructionsPath(agent) } : null, { resume, slug, context });
  }
  claudeAgentSetting(this: AgentManagerPlugin, sessionId: string): string | null {
    const rec = this.readStore("claude", null, sessionId)[0];
    if (!rec) return null;
    let size = 0;
    try { size = fs.statSync(rec.file).size; } catch { return null; }
    for (const n of [262144, 4194304, Infinity]) {
      let text: string;
      try { text = n >= size ? fs.readFileSync(rec.file, "utf8") : readFileTail(rec.file, n); } catch { return null; }
      const at = text.lastIndexOf('"agentSetting":"');
      if (at !== -1) {
        const m = text.slice(at).match(/^"agentSetting":"([a-z0-9-]+)"/);
        return m ? m[1] : null;
      }
      if (n >= size) return null;
    }
    return null;
  }
  carrySessionAgent(this: AgentManagerPlugin, oldId: string | null | undefined, newId: string | null | undefined): boolean {
    if (!oldId || !newId || oldId === newId) return false;
    let carried = false;
    for (const map of [this.pluginData.sessionAgents, this.pluginData.sessionLaunchAgents, this.pluginData.sessionSources] as (Record<string, unknown> | undefined)[]) {
      if (map && oldId in map && !(newId in map)) { map[newId] = map[oldId]; carried = true; }
    }
    return carried;
  }
  agentOpeningInfo(this: AgentManagerPlugin, agentId: string | null | undefined): { name: string; instructions: string } | null {
    const agent = this.agentById(agentId);
    return agent ? { name: agent.name, instructions: this.agentInstructionsPath(agent) } : null;
  }
  agentTranscriptDir(this: AgentManagerPlugin, agentId: string | null | undefined): string {
    const root = this.folderOf("transcriptsFolder");
    const agent = this.agentById(agentId);
    return agent ? (0, import_obsidian.normalizePath)(`${root}/${agent.name}`) : root;
  }
  agentDailyName(this: AgentManagerPlugin, agent: AgentDef): string {
    const t = agent.dailyName.trim() || DEFAULT_AGENT_DAILY_NAME;
    return plainSessionName(t.replace(/\{\{profile\}\}/g, agent.name).replace(/\{\{date\}\}/g, this.todayString()));
  }
  async moveSessionToAgent(this: AgentManagerPlugin, sessionId: string, agentId: string): Promise<void> {
    await this.recordSessionAgent(sessionId, agentId, { overwrite: true });
    const note = this.findTranscriptNoteBySessionId(sessionId);
    if (note) await this.moveTranscriptNote(note, this.agentTranscriptDir(agentId), this.agentById(agentId)?.name || null);
    this.invalidateSessionIndex();
    this.refreshBrowsers();
    for (const session of this.sessionObjects()) session.refreshStripAgent();
    const tab = this.sessionLeaves().find((l) => (this.sessionOf(l)?._ownSessionId() ?? this.savedSessionState(l)?.sessionId) === sessionId);
    if (tab) this.placeInAgentRun(tab);
    this.paintAgentTabs();
  }
  async moveTranscriptNote(this: AgentManagerPlugin, note: TFile, dir: string, agentName: string | null): Promise<void> {
    const tc = this._tc();
    const id = String(this.app.metadataCache.getFileCache(note)?.frontmatter?.session_id || "");
    const key = id ? tc.transcriptLockKey(this.folderOf("transcriptsFolder"), id) : note.path;
    await tc.withTranscriptLock(key, async () => {
      await this.app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
        if (agentName) fm.agent = agentName; else delete fm.agent;
      });
      if (note.parent?.path === dir) return;
      if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir).catch(() => {});
      let target = (0, import_obsidian.normalizePath)(`${dir}/${note.name}`);
      if (this.app.vault.getAbstractFileByPath(target) && id) {
        const title = note.basename.replace(/ \([0-9a-fA-F-]+\)$/, "");
        target = (0, import_obsidian.normalizePath)(`${dir}/${tc.transcriptBasename(id, title, true)}.md`);
      }
      if (this.app.vault.getAbstractFileByPath(target)) {
        notice({ head: "The transcript note stayed where it was", detail: `“${target}” already exists.` });
        return;
      }
      const subs = this.app.vault.getAbstractFileByPath(note.path.replace(/\.md$/, ""));
      await this.app.fileManager.renameFile(note, target);
      const subsTo = target.replace(/\.md$/, "");
      if (subs instanceof import_obsidian.TFolder && subs.path !== subsTo && !this.app.vault.getAbstractFileByPath(subsTo)) {
        await this.app.fileManager.renameFile(subs, subsTo).catch(() => { notice({ head: "Couldn't move the sub-agents' transcripts", detail: `“${subs.path}” stayed where it was, not beside “${target}”.` }); });
      }
    });
  }
  async renameAgentFiles(this: AgentManagerPlugin, oldName: string, newName: string): Promise<void> {
    const root = this.folderOf("transcriptsFolder");
    const oldDir = this.app.vault.getAbstractFileByPath((0, import_obsidian.normalizePath)(`${root}/${oldName}`));
    if (!(oldDir instanceof import_obsidian.TFolder)) return;
    const notes = [...oldDir.children, ...oldDir.children.flatMap((c) => (c instanceof import_obsidian.TFolder ? c.children : []))]
      .filter((c): c is TFile => c instanceof import_obsidian.TFile && c.extension === "md");
    for (const n of notes) {
      try {
        await this.app.fileManager.processFrontMatter(n, (fm: Record<string, unknown>) => { if (fm.agent === oldName) fm.agent = newName; });
      } catch { /* empty */ }
    }
    const newPath = (0, import_obsidian.normalizePath)(`${root}/${newName}`);
    if (this.app.vault.getAbstractFileByPath(newPath)) {
      notice({ head: "The transcript folder kept its name", detail: `“${newPath}” already exists.` });
      return;
    }
    await this.app.fileManager.renameFile(oldDir, newPath);
  }
}
export { AgentMethods };
