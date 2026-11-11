
import type { ObsidianProtocolData } from "obsidian";
import { fs, import_obsidian, path } from "../externals.js";
import { CLI_BACKENDS, REAL_BACKENDS } from "../constants/backends.js";
import type { BackendKey } from "../constants/backends.js";
import { plainSessionName } from "../constants/names.js";
import type { AgentManagerPlugin } from "./main.js";
import { notice } from "../vault-terminal/notice";
class LinkMethods {
  async handleProtocolLink(this: AgentManagerPlugin, params: ObsidianProtocolData, origin?: "terminal"): Promise<void> {
    await this.whenLayoutReady();
    const op = String(params.op || "resume").toLowerCase();
    const say = (text: string) => notice(`Agent Manager: ${text}`);
    if (op === "daily") {
      await this.revealBrowser();
      const named = String(params.agent || "").trim();
      const agents = this.agentList();
      let agentId: string | undefined;
      if (named && agents.length) {
        const want = named.toLowerCase();
        const agent = agents.find((a) => a.id.toLowerCase() === want || a.name.trim().toLowerCase() === want);
        if (!agent) { say(`there's no agent profile named “${named.slice(0, 100)}”.`); return; }
        agentId = agent.id;
      }
      await this.openTodaysChat(null, agentId);
      return;
    }
    if (op === "task") {
      const notePath = String(params.task || "").trim();
      if (!this.scheduledTasksOn()) { say("scheduled tasks are off (Settings → Agent Manager)."); return; }
      if (!this.isTaskNote(notePath)) { say(`there's no scheduled task at “${notePath.slice(0, 200)}”.`); return; }
      await this.openTaskPage(notePath);
      return;
    }
    if (op === "new") {
      await this.revealBrowser();
      let backendOverride = this.backendFromName(params.backend);
      const title = plainSessionName(String(params.title || "")).slice(0, 100).trim();
      const from = String(params.note || "").trim();
      if (from) {
        const file = this.app.vault.getAbstractFileByPath((0, import_obsidian.normalizePath)(from));
        if (!file || !this.canStartFrom(file)) { say(`there's no note or folder at “${from}” in this vault.`); return; }
        const isNote = file instanceof import_obsidian.TFile;
        if (!backendOverride && isNote) backendOverride = this.ticketBackend(file.path);
        const on = CLI_BACKENDS[backendOverride || this.defaultLaunchBackend()].label;
        const fromBoard = origin !== "terminal" && isNote && this.isTicketNote(file.path) && this.noteProperty(file.path, "origin").toLowerCase() !== "external" && !title && !params.backend;
        if (!fromBoard && !(await this.askConfirm("Start a session from a link?", `A link asks to start a ${on} session ${isNote ? "about the note" : "in the folder"} “${file.path}”${title ? `, named “${title}”` : ""}. Start it only if you made or trust the link.`, "Start"))) return;
        await this.startSession(title || (isNote ? file.basename : file.name), null, { backendOverride, ...(isNote ? { notePath: file.path } : { folderPath: file.path }) });
        return;
      }
      const on = CLI_BACKENDS[backendOverride || this.defaultLaunchBackend()].label;
      if (!(await this.askConfirm("Start a session from a link?", `A link asks to start a ${on} session${title ? ` named “${title}”` : ""}. Start it only if you made or trust the link.`, "Start"))) return;
      await this.startSession(title, null, { backendOverride });
      return;
    }
    await this.revealBrowser();
    const sessionId = params.session;
    if (!sessionId) { say("that link names no session."); return; }
    this.invalidateSessionIndex();
    const session = await this.findSessionById(sessionId);
    if (session && !this.placeMissing(session)) {
      const claude = session.backend === "claude";
      const recorded = claude && session.file ? this.parseClaudeHead(session.file).cwd : null;
      const real = (dir: string) => { try { return fs.realpathSync(dir); } catch { return path.resolve(dir); } };
      const cwds = this.sessionCwds();
      const listed = (await this.sessionIndex()).some((r) => r.sessionId === session.sessionId && r.listed);
      const here = listed && (!claude || (!!recorded && (cwds.has(path.resolve(recorded)) || cwds.has(real(recorded)))));
      if (!here && !(await this.askConfirm("Resume a session from outside this vault?", `A link asks to resume “${session.displayName || session.title || String(sessionId).slice(0, 8)}”, a session that ran in ${recorded || session.cwd || "another folder"}, not in this vault. Resuming runs the agent there. Resume it only if you made or trust the link.`, "Resume"))) return;
      const leaf = this.getLeafForSession(session.title, session.backend, session.sessionId);
      if (leaf) {
        void this.revealAndFlash(leaf);
      } else {
        await this.startResume(session, null);
      }
      return;
    }
    const note = this.findTranscriptNoteBySessionId(sessionId);
    if (note) {
      say("that session isn't resumable here. Opening its transcript.");
      await this.openInNotesArea(note);
      return;
    }
    say(`session ${String(sessionId).slice(0, 8)} was not found.`);
  }
  backendFromName(this: AgentManagerPlugin, name: string | null | undefined): BackendKey | null {
    const want = String(name ?? "").trim().toLowerCase();
    if (!want) return null;
    return REAL_BACKENDS.find((k) => k === want || CLI_BACKENDS[k].label.toLowerCase() === want || CLI_BACKENDS[k].binary === want) || null;
  }
  buildResumeLink(this: AgentManagerPlugin, session: { sessionId: string }): string {
    const enc = encodeURIComponent;
    return `obsidian://agent-manager?vault=${enc(this.app.vault.getName())}&op=resume&session=${enc(session.sessionId)}`;
  }
}
export { LinkMethods };
