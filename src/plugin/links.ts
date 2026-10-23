// obsidian:// links: resuming a session, and starting one.

import type { ObsidianProtocolData } from "obsidian";
import { import_obsidian } from "../externals.js";
import { CLI_BACKENDS, REAL_BACKENDS } from "../constants/backends.js";
import type { BackendKey } from "../constants/backends.js";
import type { AgentManagerPlugin } from "./main.js";
class LinkMethods {
  //   obsidian://agent-manager?vault=<vault>&op=resume&session=<id>
  //   obsidian://agent-manager?vault=<vault>&op=new&backend=<key>&title=<title>
  //   obsidian://agent-manager?vault=<vault>&op=new&note=<path>[&backend=<key>]
  // `note` is a note's or a folder's vault path; the session is started from it, as the
  // file menu does, named for it unless the link gives a title.
  // op=resume finds its session by id alone. The operation is `op`, never `action`:
  // Obsidian overwrites a query parameter named `action`.
  async handleProtocolLink(this: AgentManagerPlugin, params: ObsidianProtocolData): Promise<void> {
    // The link can arrive during a cold start, before the workspace can open a leaf.
    await this.whenLayoutReady();
    const op = String(params.op || "resume").toLowerCase();
    const say = (text: string) => new import_obsidian.Notice(`Agent Manager: ${text}`, 10000);
    if (op === "new") {
      await this.revealBrowser();
      const backendOverride = this.backendFromName(params.backend);
      // A link's title becomes the session's name, and Codex and Antigravity get it in their
      // first message, so it's kept to one plain line: no control characters or quotes,
      // at most 100 characters.
      const plain = [...String(params.title || "")].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === "\"" || c === "`" ? " " : c)).join("");
      const title = plain.replace(/\s+/g, " ").trim().slice(0, 100).trim();
      // A link can come from anywhere (a web page, a shared note). One that names its own
      // session asks first; a link from a note (a Bases board's Start) doesn't, since what
      // it sends is the plugin's own opening for that note.
      if (title && !(await this.askConfirm("Start a session from a link?", `A link asks to start “${title}”${backendOverride ? ` on ${CLI_BACKENDS[backendOverride].label}` : ""}. Start it only if you made or trust the link.`, "Start"))) return;
      const from = String(params.note || "").trim();
      if (from) {
        const file = this.app.vault.getAbstractFileByPath((0, import_obsidian.normalizePath)(from));
        if (!file || !this.canStartFrom(file)) { say(`there's no note or folder at “${from}” in this vault.`); return; }
        const isNote = file instanceof import_obsidian.TFile;
        await this.startSession(title || (isNote ? file.basename : file.name), null, { backendOverride, ...(isNote ? { notePath: file.path } : { folderPath: file.path }) });
        return;
      }
      await this.startSession(title, null, { backendOverride });
      return;
    }
    await this.revealBrowser();
    const sessionId = params.session;
    if (!sessionId) { say("that link names no session."); return; }
    const session = await this.findSessionById(sessionId);
    if (session && !this.placeMissing(session)) {
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
