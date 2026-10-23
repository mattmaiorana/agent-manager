// obsidian:// links: resuming a session, and starting one.

import type { ObsidianProtocolData } from "obsidian";
import { fs, import_obsidian, path } from "../externals.js";
import { CLI_BACKENDS, REAL_BACKENDS } from "../constants/backends.js";
import type { BackendKey } from "../constants/backends.js";
import { plainSessionName } from "../constants/names.js";
import type { AgentManagerPlugin } from "./main.js";
class LinkMethods {
  //   obsidian://agent-manager?vault=<vault>&op=resume&session=<id>
  //   obsidian://agent-manager?vault=<vault>&op=new&backend=<key>&title=<title>
  //   obsidian://agent-manager?vault=<vault>&op=new&note=<path>[&backend=<key>]
  // `note` is a note's or a folder's vault path; the session is started from it, as the
  // file menu does, named for it unless the link gives a title.
  // op=resume finds its session by id alone. The operation is `op`, never `action`:
  // Obsidian overwrites a query parameter named `action`.
  // A link can come from anywhere (a web page, a clipped or shared note), so starting a
  // session from one asks first, unless it starts from a ticket (the tickets base's
  // Launch): a web page can't make a note a ticket, since a clipped note's properties come
  // from the user's template. A resume asks only when the session ran outside this vault.
  async handleProtocolLink(this: AgentManagerPlugin, params: ObsidianProtocolData): Promise<void> {
    // The link can arrive during a cold start, before the workspace can open a leaf.
    await this.whenLayoutReady();
    const op = String(params.op || "resume").toLowerCase();
    const say = (text: string) => new import_obsidian.Notice(`Agent Manager: ${text}`, 10000);
    if (op === "new") {
      await this.revealBrowser();
      let backendOverride = this.backendFromName(params.backend);
      // A link's title becomes the session's name, and Codex and Antigravity get it in their
      // first message, so it's kept to one plain line: no control characters or quotes,
      // at most 100 characters.
      const title = plainSessionName(String(params.title || "")).slice(0, 100).trim();
      const from = String(params.note || "").trim();
      if (from) {
        const file = this.app.vault.getAbstractFileByPath((0, import_obsidian.normalizePath)(from));
        if (!file || !this.canStartFrom(file)) { say(`there's no note or folder at “${from}” in this vault.`); return; }
        const isNote = file instanceof import_obsidian.TFile;
        // A ticket's backend property picks its CLI when the link names none.
        if (!backendOverride && isNote) backendOverride = this.ticketBackend(file.path);
        const on = CLI_BACKENDS[backendOverride || this.defaultLaunchBackend()].label;
        // Only the base's own link is exempt: a ticket, and nothing else in the link.
        // One that also names a title or a CLI says more than the base's does, so it asks.
        const fromBoard = isNote && this.isTicketNote(file.path) && !title && !params.backend;
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
    // A fresh index, so a session that just started is found as this vault's.
    this.invalidateSessionIndex();
    const session = await this.findSessionById(sessionId);
    if (session && !this.placeMissing(session)) {
      // Found outside this vault's sessions (another folder on this machine): resuming
      // would run an agent there, and list that folder here from then on, so it asks.
      // Listed isn't proof for Claude: its store names a folder by its path with every
      // other character as "-", so "My Vault" and "My-Vault" share one; the folder the
      // transcript itself records decides.
      // A Claude transcript that records no folder (in the part read) can't prove it.
      const claude = session.backend === "claude";
      const recorded = claude && session.file ? this.parseClaudeHead(session.file).cwd : null;
      const real = (dir: string) => { try { return fs.realpathSync(dir); } catch { return path.resolve(dir); } };
      const cwds = this.sessionCwds();
      const listed = (await this.sessionIndex()).some((r) => r.sessionId === session.sessionId && r.listed);
      const here = listed && (!claude || (!!recorded && (cwds.has(path.resolve(recorded)) || cwds.has(real(recorded)))));
      if (!here && !(await this.askConfirm("Resume a session from outside this vault?", `A link asks to resume “${session.displayName || session.title || String(sessionId).slice(0, 8)}”, a session that ran in ${recorded || session.cwd || "another folder"}, not in this vault. Resuming runs the agent there. Resume it only if you made or trust the link.`, "Resume"))) return;
      // Already open in a tab? Focus it rather than open a second one.
      const leaf = this.getLeafForSession(session.title, session.backend, session.sessionId);
      if (leaf) {
        void this.app.workspace.revealLeaf(leaf);
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
      } else {
        await this.startResume(session, null);
      }
      return;
    }
    // Not resumable here (deleted by the CLI, or another machine). The transcript note
    // outlives the CLI's own copy.
    const note = this.findTranscriptNoteBySessionId(sessionId);
    if (note) {
      say("that session isn't resumable here. Opening its transcript.");
      await this.app.workspace.getLeaf("tab").openFile(note);
      return;
    }
    say(`session ${String(sessionId).slice(0, 8)} was not found.`);
  }
  // A backend named in a link, by key, label, or program name, or null.
  backendFromName(this: AgentManagerPlugin, name: string | null | undefined): BackendKey | null {
    const want = String(name ?? "").trim().toLowerCase();
    if (!want) return null;
    return REAL_BACKENDS.find((k) => k === want || CLI_BACKENDS[k].label.toLowerCase() === want || CLI_BACKENDS[k].binary === want) || null;
  }
  // The link that resumes a session. Every value goes through encodeURIComponent, so a
  // space is %20 (Obsidian's parser does not decode +), and the vault is named, so the
  // link reaches the right vault when several are open.
  buildResumeLink(this: AgentManagerPlugin, session: { sessionId: string }): string {
    const enc = encodeURIComponent;
    return `obsidian://agent-manager?vault=${enc(this.app.vault.getName())}&op=resume&session=${enc(session.sessionId)}`;
  }
}
export { LinkMethods };
