// A session in a terminal tab: Agent Manager's hold on one view of the new terminal
// (src/vault-terminal/, host.ts, TerminalController). The view runs the program; this
// decides what it runs (a launch or a resume, by id), what the tab is called, the strip
// above it and the transcript overlay beside it, what's typed into it (the opening), and
// whether closing asks. Its parts (strip, identity, transcripts, the note it came from,
// rename) are applied to it.

import { fs, import_obsidian, path } from "../externals.js";
import { CLI_BACKENDS, INPUT_PASTE_MIN } from "../constants/backends.js";
import { OPENING_LEAD, sessionNamePrompt } from "../constants/names.js";
import { DIALOG_RE, INPUT_GUARD_NOTICE_MS } from "./constants.js";
import { splitCommand } from "../vault-terminal/finder";
import { IdentityMethods } from "./identity.js";
import { StripMethods } from "./strip.js";
import { SessionActionMethods } from "./session-actions.js";
import { ViewNoteMethods } from "../notes/view-note.js";
import { ViewTranscriptMethods } from "../transcripts/view-transcripts.js";
import { DraftTracker } from "./draft.js";
import { readFileHead } from "./transcript-files.js";
import { applyParts } from "../util/apply-parts.js";

// A Claude attach that ends this fast with an error didn't find a live agent to attach to.
const ATTACH_FAIL_MS = 4000;


var SessionController = class {
  constructor(view, plugin) {
    this.view = view;
    this.plugin = plugin;
    // Every view of the session type is a session tab: it waits for its launch, its
    // resume, or its restore before the program starts.
    this.gated = true;
    // Sessions start even in a tab that isn't showing ("Force load all sessions").
    this.startHidden = true;
    this.backendKey = null;
    this.workingDir = null;
    this.sessionTitle = null;
    this.sessionName = null;
    this.resumeSessionId = null;
    this.launchSessionId = null;
    this.termHost = null;
    this.stripEl = null;
    // What the user has typed into the prompt and not sent (draft.js).
    this._draft = new DraftTracker();
    this.hasOutput = false;
    this.lastOutputAt = 0;
    this.lastWorkOutputAt = 0;
    this.lastUserInputAt = 0;
    // Each start of the program is one attempt; what's waiting to be typed belongs to one.
    this._attempt = 0;
    // A Claude resume tries attach first, then -r (launch, exit).
    this._resumeStep = null;
    // A tab whose restore failed: kept open, saying why, and never matched or restarted.
    this._inert = null;
  }

  // ---- What the parts and the plugin read ----

  get leaf() { return this.view.leaf; }
  get app() { return this.view.app; }
  get containerEl() { return this.view.containerEl; }
  get running() { return this.view.running; }
  get programPid() { return this.view.programPid; }
  get _lastTitle() { return this.view.programTitle; }
  get programState() { return this.view.state; }
  writeRaw(data) { return this.view.write(data); }
  focusTerminal() { this.view.focus(); }
  // The last lines with text, up to maxLines. Blank rows at the bottom are skipped: a
  // CLI on the normal screen (Antigravity) draws at the top of a tall screen, and its
  // prompt was out of reach of a read of the bottom rows.
  _terminalTailText(maxLines = 40) {
    const lines = String(this.view.screenTail(maxLines + 300) || "").split("\n");
    let end = lines.length;
    while (end > 0 && !lines[end - 1].trim()) end--;
    return lines.slice(Math.max(0, end - maxLines), end).join("\n");
  }
  getBackendKey() {
    const key = this.backendKey || this.plugin.pluginData.cliBackend || "claude";
    return CLI_BACKENDS[key] ? key : "claude";
  }
  getBackend() {
    return CLI_BACKENDS[this.getBackendKey()];
  }
  get activeBackendKey() { return this.getBackendKey(); }

  // ---- The terminal's questions (host.ts, TerminalController) ----

  name() {
    if (this._inert) return this._inert.title;
    return this.sessionTitle || this.getBackend().label;
  }
  icon() { return "bot"; }
  exitHint() {
    if (this._inert) return "This tab can't be restarted. Close it when you're done with it.";
    return "Press Enter to resume this session.";
  }
  getState() {
    const state = {};
    if (this._inert) return state;
    if (this.sessionTitle) state.sessionTitle = this.sessionTitle;
    if (this.workingDir) state.workingDir = this.workingDir;
    if (this.backendKey) state.backendKey = this.backendKey;
    if (this._notePath) state.notePath = this._notePath;
    if (this._folderPath) state.folderPath = this._folderPath;
    if (this._noteSupport) state.noteSupport = true;
    if (this._noteClaim) state.noteClaim = true;
    if (this._noteLaunchAt) state.noteLaunchAt = this._noteLaunchAt;
    if (this._forkFrom) state.forkFrom = this._forkFrom;
    if (this._daily) state.daily = true;
    // Took a turn: its transcript was found, or it was a resume. A restore that finds no
    // transcript for a tab that never did starts it afresh rather than failing.
    if (this._modelFile || this.resumeSessionId || this._started) state.started = true;
    if (this._launchToken) state.launchToken = this._launchToken;
    if (this._rehostedFrom) state.rehostedFrom = this._rehostedFrom;
    const sid = this._stripSessionId?.();
    if (sid) state.sessionId = sid;
    return state;
  }
  // Called once as the tab opens (and again by Obsidian on later setViewState calls,
  // which change nothing once the session is decided).
  setState(state) {
    if (this._decided) return;
    this._decided = true;
    // Opened for a launch or a resume (openSessionLeaf): the caller decides.
    if (state.awaitLaunch) return;
    if (state.backendKey && CLI_BACKENDS[state.backendKey]) this.backendKey = state.backendKey;
    if (typeof state.workingDir === "string") this.workingDir = state.workingDir;
    if (state.notePath) this._notePath = state.notePath;
    if (state.folderPath) this._folderPath = state.folderPath;
    if (state.noteSupport) this._noteSupport = true;
    if (state.noteClaim) this._noteClaim = true;
    if (typeof state.noteLaunchAt === "number") this._noteLaunchAt = state.noteLaunchAt;
    // A side chat saved before it learned its id: restore can't tell its fork from
    // another, so it fails rather than guess (_pickRestoreRecord).
    if (state.forkFrom && typeof state.forkFrom === "object") this._forkFrom = state.forkFrom;
    if (typeof state.launchToken === "string") this._launchToken = state.launchToken;
    if (state.daily) this._daily = true;
    if (state.started) this._started = true;
    if (state.rehostedFrom && typeof state.rehostedFrom === "object") this._rehostedFrom = state.rehostedFrom;
    if (typeof state.sessionTitle === "string" && state.sessionTitle) {
      this.sessionTitle = state.sessionTitle;
      this._pendingResumeTitle = state.sessionTitle;
      this._pendingResumeId = typeof state.sessionId === "string" ? state.sessionId : null;
      // After the view has drawn: the restore reads other tabs' claims.
      window.setTimeout(() => this.restoreResumeFromState().catch((e) => {
        console.error("[Agent Manager] restore failed:", e);
        this._makeInert(`Agent Manager couldn't restore “${this.sessionTitle}”: ${e && e.message}.`);
      }), 0);
      return;
    }
    // Saved with no session (a tab whose restore failed before, or one that never launched).
    this._makeInert("This tab has no session to resume. Close it, and start or resume a session from the sidebar.", "No session");
  }
  // The view's elements: the strip above the terminal, the overlay beside it.
  mount({ top, stage }) {
    this.view.contentEl.addClass("agent-manager-session");
    this.termHost = stage;
    this._stripContainer = top;
    this.closeTranscript?.();
    this.transcriptHost = null;
    this._transcriptBodyEl = null;
    this._transcriptFilePath = null;
    // The overlay's own menu: its text, and the transcript note.
    this.view.registerDomEvent(stage, "contextmenu", (e) => {
      if (!(this._transcriptOpen && this.transcriptHost && this.transcriptHost.contains(e.target))) return;
      e.preventDefault();
      e.stopPropagation();
      const sel = this.view.containerEl.win.getSelection()?.toString() || "";
      const menu = new import_obsidian.Menu();
      menu.addItem((i) => i.setTitle("Copy").setIcon("copy").setDisabled(!sel).onClick(() => navigator.clipboard?.writeText(sel).catch(() => {})));
      menu.addItem((i) => i.setTitle("Open transcript note").setIcon("file-text").onClick(() => this.openDurableTranscriptNote()));
      menu.showAtMouseEvent(e);
    });
    this.rebuildStrip();
  }
  rebuildStrip() {
    const top = this._stripContainer;
    if (!top) return;
    top.empty();
    if (this._inert || !this.sessionTitle) return;
    this.buildStatusStrip(top);
  }
  // Each start of an agent asks what to add to its command (host.ts, HostLaunch).
  async launch(kind, plain) {
    if (this._inert) return { error: this._inert.message };
    this._attempt++;
    this.hasOutput = false;
    this.lastOutputAt = 0;
    this._draft.clear();
    const backendKey = this.getBackendKey();
    const backend = CLI_BACKENDS[backendKey];
    const cwd = this.workingDir || this.plugin.getVaultPath();
    // The flags every start takes: Codex's --no-daemon when its sessions stay off its
    // background server, and the added folders. A session that starts in a folder below
    // the vault's root is never given the root: someone keeping agents to a corner of the
    // vault means it. Flags of your own go in the agent's Command (the terminal's
    // settings). Every Codex start, new or resumed, goes the same way: a conversation the
    // server has open can't be opened without it ("This conversation is open in another app").
    const codexServer = backendKey === "codex" && this.plugin.pluginData.codexServer === true;
    const global = backendKey === "codex" && !codexServer ? ["--no-daemon"] : [];
    const addDirs = this.plugin.addedFolders().filter((d) => path.resolve(d) !== path.resolve(cwd));
    if (addDirs.length && backend.addDirFlag) {
      for (const dir of addDirs) global.push(backend.addDirFlag, dir);
      if (backend.addDirWriteFlags) global.push(...splitCommand(backend.addDirWriteFlags));
    }
    // A side chat: a copy of another session's conversation, made by the CLI's own fork.
    const fork = this._forkFrom;
    if (fork && !this.resumeSessionId) {
      // Claude: resume the source as a new session, with the id the plugin minted.
      if (backendKey === "claude") {
        const args = [...global, "--resume", fork.id, "--fork-session"];
        if (this.launchSessionId) args.push("--session-id", this.launchSessionId);
        if (this.sessionName) args.push(backend.nameFlag, this.sessionName);
        return { args, folder: this.workingDir || "" };
      }
      // Codex: its fork subcommand, by id. The fork's id is learned from its new rollout.
      if (backendKey === "codex") return { args: [...global, "fork", fork.id], folder: this.workingDir || "" };
      // Antigravity has no launch flag for it: open the source conversation, then /fork
      // inside it (_sendFork). The tab is on the source until the fork answers.
      return { args: [...global, ...splitCommand(backend.resumeByIdFlag), fork.id], folder: this.workingDir || "" };
    }
    const id = this.resumeSessionId && /^[0-9a-fA-F-]{16,}$/.test(this.resumeSessionId) ? this.resumeSessionId : null;
    if (id && backend.resumeByIdFlag) {
      if (backendKey === "claude") {
        // A Claude session Remote Control re-hosted runs as a background agent, which
        // `claude -r` refuses: reconnect with `claude attach` when one is listed (the
        // bare command: launch flags don't apply to a supervisor's process), and resume
        // with -r otherwise, or when the attach fails at once (exit).
        // No answer from `claude agents` (slow, or many tabs restoring at once): attach
        // first anyway; a fast attach failure goes on to -r.
        if (this._resumeStep === null) this._resumeStep = (await this._liveAgentFor(id)) === false ? "resume" : "attach";
        if (this._resumeStep === "attach") return { args: ["attach", id.split("-")[0]], folder: this.workingDir || "", plain: true };
        return { args: [...global, backend.resumeByIdFlag, id], folder: this.workingDir || "" };
      }
      return { args: [...global, ...splitCommand(backend.resumeByIdFlag), id], folder: this.workingDir || "" };
    }
    const args = [...global];
    if (this.sessionName && backend.nameFlag) args.push(backend.nameFlag, this.sessionName);
    // The id Agent Manager minted (Claude only), so the transcript is known from the start.
    if (this.launchSessionId && backendKey === "claude" && /^[0-9a-f-]{36}$/.test(this.launchSessionId)) args.push("--session-id", this.launchSessionId);
    return { args, folder: this.workingDir || "" };
  }
  // Is this Claude session running as a background agent right now? From `claude agents
  // --json`, one call shared by the tabs restoring together; null when it didn't answer.
  async _liveAgentFor(id) {
    try {
      const agents = await this.plugin.listClaudeAgentsShared();
      return agents.some((a) => a && String(a.sessionId) === id && a.kind === "background" && a.pid);
    } catch {
      return null;
    }
  }
  started(pid) {
    this._cliFound = true;
    this._ranOnce = true;
    this.plugin.scheduleStatusRefresh();
  }
  launchFailed(message) {
    this._cliFound = false;
    this.plugin.scheduleStatusRefresh();
  }
  output(text) {
    this.hasOutput = true;
    this.lastOutputAt = Date.now();
    // Real output, not a title re-assert, is what the working dot's activity layer counts.
    // eslint-disable-next-line no-control-regex -- terminal escape sequences are control characters
    const activity = text.replace(/\x1b\][02];[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
    if (activity.trim()) this.lastWorkOutputAt = Date.now();
  }
  input(data) {
    // Focus reports aren't typing.
    // eslint-disable-next-line no-control-regex -- terminal escape sequences are control characters
    if (/^(?:\x1b\[[IO])+$/.test(data)) return;
    this._draft.feed(data, this.getBackendKey());
    this.lastUserInputAt = Date.now();
  }
  stateChange(state) {
    // Seen working: a real session, past any trust dialog.
    if (state === "working") this._sessionInteractive = true;
  }
  exit(info) {
    this.plugin.scheduleStatusRefresh();
    // A Claude attach that failed at once: no live agent after all, so resume with -r.
    if (this._resumeStep === "attach") {
      const ran = info.ran !== undefined ? info.ran * 1000 : 0;
      this._resumeStep = "resume";
      if (!info.closed && info.code !== 0 && ran < ATTACH_FAIL_MS) {
        window.setTimeout(() => this.view.restart(), 0);
        return true;
      }
    }
    // Anything the session wrote since the last capture lands in its note.
    try { if (this.transcriptGrewSinceReconcile?.()) this.updateDurableTranscript?.(); } catch { /* best effort */ }
    return false;
  }
  // Enter after the program ended: the same session again, by its id.
  restart() {
    if (this._inert) return;
    this._restartBySession().catch((e) => console.error("[Agent Manager] restart failed:", e));
  }
  async _restartBySession() {
    // A new session whose CLI never ran (no Python, the CLI not found): the same launch
    // again, its minted id unused and its opening still to send.
    if (!this._ranOnce && !this.resumeSessionId && this.sessionName) {
      this.view.restart();
      if (this._forkFrom) { if (this.getBackendKey() === "antigravity") this._sendFork(); }
      else if (this._opening || this._handoffNote || ["codex", "antigravity"].includes(this.getBackendKey())) this.sendOpening(this.sessionTitle);
      return;
    }
    const id = this._ownSessionId() || (await this._liveSessionId());
    if (!id) {
      new import_obsidian.Notice("This session has no id yet (it never finished a turn), so it can't be resumed. Start a new one from the sidebar.", 8000);
      return;
    }
    this.resumeSessionId = id;
    this.launchSessionId = null;
    this.sessionName = null;
    this._resumeStep = null;
    this._opening = null;
    this._forkFrom = null;
    this.view.restart();
  }
  // One decision for the tab's close and the window's: unsent text, or the agent working
  // (Claude's own report, or Agent Manager's detector for Codex and Antigravity).
  closeReason(own) {
    if (this._inert || !this.running || this._closeQuietly) return own;
    const name = this.sessionTitle || this.getBackend().label;
    if (this.hasPendingInput()) return { agent: true, name, draft: true };
    if (own) return { ...own, name };
    if (this.plugin.sessionIsWorking(this)) return { agent: true, name };
    return null;
  }
  closed() {
    if (this._closed) return;
    this._closed = true;
    // Capture what's new before the session goes.
    try { if (this.transcriptGrewSinceReconcile?.()) this.updateDurableTranscript?.(); } catch { /* best effort */ }
    this.closeTranscript?.();
    this.plugin.scheduleStatusRefresh();
  }

  // ---- A failed restore ----

  // The tab stays open and says why; its session keys are cleared, so nothing finds it
  // as that session (a resume link, the sidebar's open dot), and Enter does nothing:
  // a duplicate restarting would put two writers on one transcript.
  _makeInert(message, title) {
    const was = this.sessionTitle;
    this._inert = { message, title: title || `Not restored: ${was || "a session"}` };
    this.sessionTitle = null;
    this.resumeSessionId = null;
    this.launchSessionId = null;
    this._claimedResumeId = null;
    this._notePath = null;
    this._folderPath = null;
    this._rehostedFrom = null;
    this.rebuildStrip();
    this.view.print(message);
    this.view.refreshHeader();
    this.app.workspace.requestSaveLayout();
    this.plugin.scheduleStatusRefresh();
  }
  restoreFailed(message) {
    this._makeInert(message);
  }

  // ---- Launch and resume ----

  // A new session, in the starting folder (the "AGENTS.md folder" setting), or a side
  // chat, in the folder of the session it copies (`_forkFrom`, set by startSession).
  // `reuseId`: a Claude session restored before its first turn keeps its id (and so its pin).
  launchSession(subject, reuseId = null) {
    const title = String(subject || "").trim() || "Untitled";
    this._decided = true;
    this.sessionTitle = title;
    this.sessionName = title;
    this.resumeSessionId = null;
    this._resumeStep = null;
    this._resetSessionIdentity();
    this._launchedAt = Date.now();
    const backendKey = this.getBackendKey();
    this.backendKey = backendKey;
    const fork = this._forkFrom;
    this.launchSessionId = backendKey === "claude" ? (reuseId || this.plugin.newSessionId()) : null;
    // Codex and Antigravity learn their id only once they write a transcript, which is
    // found by a token unique to this launch in the opening (_resolveModelFile). A side
    // chat sends no opening: a Codex fork is its newest rollout, an Antigravity fork the
    // conversation its /fork made.
    this._launchToken = backendKey === "claude" || fork ? null : this.plugin.newSessionId().slice(0, 8);
    this._openingSent = false;
    const start = this.plugin.startDir();
    this.workingDir = fork ? (fork.cwd || null) : (path.resolve(start) === path.resolve(this.plugin.getVaultPath()) ? null : start);
    if (this.workingDir) this.plugin.rememberSessionFolder(this.workingDir).catch(() => {});
    // A Claude side chat's id is minted here, so it's recorded as one at once.
    if (fork && backendKey === "claude") this.plugin.adoptSideChat(this.launchSessionId, null, fork.id).catch(() => {});
    this._opening = fork ? null : this.plugin.buildOpening({ notePath: this._notePath || null, folderPath: this._folderPath || null, daily: !!this._daily });
    this._go();
    if (!fork) this.sendOpening(title);
    else if (backendKey === "antigravity") this._sendFork();
  }
  // An Antigravity side chat: once the source conversation is up in this tab, type /fork
  // and take the conversation it makes as this tab's own. Antigravity answers "Forked
  // conversation." and leaves the source untouched; the fork's folder appears in its
  // store at once, its transcript only with the first turn. If no fork shows up, this tab
  // is closed (two tabs on one conversation would both write it) and the side chat falls
  // back to a new session that reads the source's transcript note.
  async _sendFork() {
    const fork = this._forkFrom;
    if (!fork || this._forkSending) return;
    this._forkSending = true;
    try {
      // The start it's for is the one running once output arrives (asked as the launch
      // is released, the program hasn't started yet).
      if (!(await this.waitForOutput(60000))) {
        // Never left on the source conversation: that tab would write into it.
        if (!this._closed) this._forkFailed(fork, "Antigravity didn't start");
        return;
      }
      const attempt = this._attempt;
      const same = () => this._attempt === attempt && !this._closed && this.running;
      await this.waitForQuiet(1200, 8000);
      if (!(await this.waitPastTrustPrompt()) || !same()) { this._forkFailed(fork, "it asked a question first"); return; }
      const before = new Set(this.plugin.antigravityConversationIds());
      const sentAt = Date.now();
      const sent = await this.submitOpeningLine("/fork");
      if (!same()) return;
      if (!sent) { this._forkFailed(fork, "/fork couldn't be typed"); return; }
      // The proof is Antigravity's own answer to this /fork, on screen below it: "Forked
      // conversation." and then "/resume <the source's id>" to go back (text alone could
      // be a quote, so both lines, in that order, after the /fork), and one new
      // conversation folder made since it was sent.
      const answered = () => {
        const tail = this._terminalTailText(30);
        const at = tail.lastIndexOf("/fork");
        if (at === -1) return false;
        const after = tail.slice(at);
        const done = after.search(/^\s*\S*\s*Forked conversation\./m);
        return done !== -1 && after.indexOf(`/resume ${fork.id}`, done) !== -1;
      };
      let forkId = null;
      for (let i = 0; i < 100 && same() && !forkId; i++) {
        await new Promise((r) => window.setTimeout(r, 200));
        if (!answered()) continue;
        forkId = this.plugin.newAntigravityConversation(before, sentAt, fork.id);
      }
      if (!same()) return;
      if (!forkId) { this._forkFailed(fork, "no forked conversation appeared"); return; }
      this._forkFrom = null;
      this.resumeSessionId = forkId;
      this._claimedResumeId = forkId;
      await this.plugin.adoptSideChat(forkId, this.sessionTitle, fork.id);
      this.refreshStripId?.();
      this.app.workspace.requestSaveLayout();
      this.plugin.refreshBrowsers();
    } finally {
      this._forkSending = false;
    }
  }
  _forkFailed(fork, why) {
    console.warn(`[Agent Manager] Antigravity /fork failed (${why}); falling back to a side chat that reads the transcript.`);
    this._forkFrom = null;
    const source = this.plugin.sessionObjects().find((v) => v !== this && v._ownSessionId() === fork.id);
    // Close this tab first: it holds the source conversation open.
    this._closeQuietly = true;
    this.leaf?.detach();
    if (source) source.pointerSideChat?.(true);
    else new import_obsidian.Notice("Agent Manager: Antigravity couldn't fork this conversation, and its session isn't open to start a side chat from.", INPUT_GUARD_NOTICE_MS);
  }
  // Resume a session from its record. A resume sends nothing.
  resumeSession(session) {
    this._decided = true;
    this.sessionTitle = session.title || "Untitled";
    this.sessionName = null;
    this.resumeSessionId = session.sessionId || null;
    this.launchSessionId = null;
    this._launchToken = null;
    this._launchedAt = null;
    this._resumeStep = null;
    this._resetSessionIdentity();
    this._opening = null;
    if (session.backend && CLI_BACKENDS[session.backend]) this.backendKey = session.backend;
    // Antigravity records no working folder, so its sessions resume in the starting folder.
    const start = this.plugin.startDir();
    const startOrRoot = path.resolve(start) === path.resolve(this.plugin.getVaultPath()) ? null : start;
    this.workingDir = session.cwd || (this.backendKey === "antigravity" ? startOrRoot : null);
    if (this.workingDir) this.plugin.rememberSessionFolder(this.workingDir).catch(() => {});
    // A session started from a note keeps that note when resumed: its transcript note
    // says which (`source`), so its strip icon and its side chats' links come back. A
    // resume never claims the note's main-session; it rewrites it only while it names
    // this session.
    if (!this._notePath && !this._folderPath && this.resumeSessionId) {
      const note = this.plugin.sourceNoteOf(this.resumeSessionId);
      if (note) { this._notePath = note; this._noteClaim = false; }
    }
    if (this.backendKey === "antigravity" && this.resumeSessionId) this.plugin.rememberAntigravitySession(this.resumeSessionId).catch(() => {});
    this._go();
  }
  // The session's decided: its strip, its tab, and the program starts.
  _go() {
    this.backendKey = this.getBackendKey();
    this.view.kind = this.backendKey;
    this.rebuildStrip();
    this.view.refreshHeader();
    this.app.workspace.requestSaveLayout();
    this.view.releaseStart();
    this.plugin.scheduleStatusRefresh();
  }

  // ---- Typing into the session ----

  // The opening instruction for a new session, once the CLI is up, past any trust
  // dialog, and never on top of a draft. Bound to the start it was meant for: if the
  // program is started again (a retry without the terminal's additions) before it's
  // sent, it waits for that start instead, at most twice.
  async sendOpening(title) {
    // One at a time: a quick manual restart of a start that never ran asks again, and
    // two loops would both send it.
    if (this._openingPending) return;
    this._openingPending = true;
    try {
      for (let tries = 0; tries < 3; tries++) {
        // The start it's for is the one running once output arrives: asked as a launch
        // is released, the program hasn't started yet.
        await this.waitForOutput(8000);
        const attempt = this._attempt;
        const outcome = await this._sendOpeningOnce(title, attempt);
        if (outcome !== "restarted") return;
        await this._waitForAttempt(attempt, 15000);
      }
    } finally {
      this._openingPending = false;
    }
  }
  async _waitForAttempt(old, maxMs) {
    const end = Date.now() + maxMs;
    while (Date.now() < end && this._attempt === old && !this._closed) await new Promise((r) => window.setTimeout(r, 100));
  }
  async _sendOpeningOnce(title, attempt) {
    const same = () => this._attempt === attempt && !this._closed;
    const ready = await this.waitForOutput(8000);
    if (!same()) return "restarted";
    if (!ready || !this.running) return "gone";
    if (this._cliFound === false) return "gone";
    await this.waitForQuiet(1200, 6000);
    let clear = await this.waitPastTrustPrompt();
    if (!same()) return "restarted";
    if (!this.running) return "gone";
    if (!clear) {
      new import_obsidian.Notice("Agent Manager: the new session is asking a question first (a trust or permissions dialog). Answer it, and the opening instruction is sent once it clears.", INPUT_GUARD_NOTICE_MS);
      clear = await this.waitPastTrustPrompt(5 * 60 * 1000);
      if (!same()) return "restarted";
      if (!this.running) return "gone";
      if (!clear) {
        new import_obsidian.Notice("Agent Manager: the session's dialog never cleared, so the opening instruction was not sent.", INPUT_GUARD_NOTICE_MS);
        return "gone";
      }
    }
    this._sessionInteractive = true;
    const bk = this.getBackendKey();
    const marked = bk === "codex" || bk === "antigravity";
    const parts = [this._opening, marked ? sessionNamePrompt(title, this._launchToken) : ""].filter(Boolean);
    const handoff = this._handoffOpeningSuffix();
    if (parts.length || handoff) {
      const line = `${OPENING_LEAD} ${parts.join(" ")}${handoff}`;
      let sent = false;
      // A dialog that shows as the opening goes in holds it back: once the dialog is
      // answered, whatever of the opening reached the prompt is cleared and it's sent again.
      for (let tries = 0; tries < 3 && !sent; tries++) {
        sent = await this.submitOpeningLine(line);
        // Restarted while it waited: the next start gets it, the side chat's note included.
        if (!sent && !same()) return "restarted";
        if (sent || !this.running || !this._dialogShowing()) break;
        if (tries === 0) new import_obsidian.Notice("Agent Manager: the session is asking a question. Answer it, and the opening instruction is sent once it clears.", INPUT_GUARD_NOTICE_MS);
        if (!(await this.waitPastTrustPrompt(5 * 60 * 1000)) || !same()) break;
        await this._clearComposeLine(this._echoProbe(line), attempt);
      }
      if (!sent) {
        if (same() && this.running) new import_obsidian.Notice("Agent Manager: the opening instruction couldn't be sent. Type your first message yourself.", INPUT_GUARD_NOTICE_MS);
        return "gone";
      }
      this._openingSent = true;
    }
    if (same()) this._clearHandoff();
    return "sent";
  }
  // Once the opening that carried it is sent.
  _clearHandoff() {
    this._handoffNote = null;
    this._handoffFromBackend = null;
    this._handoffIntent = null;
  }
  _handoffOpeningSuffix() {
    if (!this._handoffNote) return "";
    const abs = path.join(this.plugin.getVaultPath(), this._handoffNote);
    const fromLabel = (CLI_BACKENDS[this._handoffFromBackend] && CLI_BACKENDS[this._handoffFromBackend].label)
      || this._handoffFromBackend || "another backend";
    const intent = this._handoffIntent ? ` In progress: ${this._handoffIntent}.` : "";
    return ` You are a side chat, started alongside work already underway in a ${fromLabel} session,`
      + ` so we share no conversation memory. The full transcript of that work to date is saved at "${abs}".`
      + ` Read that note for the context, then wait for me to say what this session is for (helping,`
      + ` reviewing, or continuing).${intent}`;
  }
  // Does the prompt hold text the user typed and hasn't sent (draft.js)?
  hasPendingInput() {
    return this._draft.pending();
  }
  // Type a line and submit it: the text, then once it shows in the prompt, a separate
  // Enter (sent together, a long line and its CR read as a pasted newline).
  // Nothing is typed, and no Enter sent, while a dialog shows.
  async submitLine(text) {
    if (!this.running || this._dialogShowing()) return false;
    const attempt = this._attempt;
    const probe = this._echoProbe(text);
    await this._writeInput(text);
    let shown = !probe;
    const deadline = Date.now() + 2000;
    while (!shown && Date.now() < deadline) {
      await new Promise((r) => window.setTimeout(r, 90));
      if (!this.running || this._attempt !== attempt) return false;
      shown = this._promptShows(probe);
    }
    if (!shown) console.warn("[Agent Manager] input not echoed by the CLI within 2s; submitting anyway");
    await new Promise((r) => window.setTimeout(r, 180));
    if (!this.running || this._attempt !== attempt) return false;
    // A dialog that appeared while the line went in, unless the line's own text is what
    // matched (a session named "Update available").
    if (this._dialogShowing() && !DIALOG_RE.test(String(text))) return false;
    this.writeRaw("\r");
    return shown;
  }
  async _clearComposeLine(probe, attempt = this._attempt) {
    for (let i = 0; i < 12; i++) {
      if (!this.running || this._attempt !== attempt) return;
      this.writeRaw("\x15");
      await new Promise((r) => window.setTimeout(r, 70));
      if (!probe) return;
      const tail = this._terminalTailText(16).replace(/\s+/g, "");
      if (tail.indexOf(probe.head) === -1 && tail.indexOf(probe.tail) === -1 && !/\[Pastedtext/.test(tail)) return;
    }
  }
  // A long line goes in as one bracketed paste, which the CLI buffers whole however its
  // reads fall (a plain write of a long opening lost all but its last read).
  async _writeInput(text) {
    if (!this.running) return;
    const s = String(text);
    const bracketed = s.length > INPUT_PASTE_MIN && this.view.bracketedPaste;
    this.writeRaw(bracketed ? `\x1b[200~${s}\x1b[201~` : s);
  }
  _echoProbe(text) {
    const s = String(text || "").replace(/\s+/g, "");
    if (s.length < 6) return null;
    return { head: s.slice(0, Math.min(14, s.length)), tail: s.slice(-14) };
  }
  _promptShows(probe) {
    const tail = this._terminalTailText(16).replace(/\s+/g, "");
    if (/\[Pastedtext/.test(tail)) return true;
    return tail.indexOf(probe.head) !== -1 && tail.indexOf(probe.tail) !== -1;
  }
  // The opening, with any draft typed while the session started kept: cleared, the
  // opening sent alone, then the draft typed back, unsent.
  // Bound to the start it began in: a restart partway stops it, so nothing (the draft
  // put back, above all) lands in the next process. A draft it can't put back (a line
  // recalled from history, an edit mid-line) waits for the user to send or clear it.
  async submitOpeningLine(text) {
    const attempt = this._attempt;
    const same = () => this.running && this._attempt === attempt && !this._closed;
    if (this._draft.pending() && (this._draft.text() === "" || this._draft._unknown || this._draft._moved)) {
      new import_obsidian.Notice("Agent Manager: the new session's prompt has text in it, so the opening instruction waits until you send or clear it.", INPUT_GUARD_NOTICE_MS);
      const end = Date.now() + 5 * 60 * 1000;
      while (this._draft.pending() && same() && Date.now() < end) await new Promise((r) => window.setTimeout(r, 250));
      if (!same()) return false;
      if (this._draft.pending()) {
        new import_obsidian.Notice("Agent Manager: the prompt never cleared, so the opening instruction was not sent.", INPUT_GUARD_NOTICE_MS);
        return false;
      }
      // What cleared it may have opened a dialog (Enter on a recalled /model opens its
      // picker), and the opening's Enter would answer it.
      if (!(await this.waitPastTrustPrompt(5 * 60 * 1000)) || !same()) {
        if (same()) new import_obsidian.Notice("Agent Manager: the session's dialog never cleared, so the opening instruction was not sent.", INPUT_GUARD_NOTICE_MS);
        return false;
      }
    }
    const draft = this._draft.text();
    if (draft) {
      await this._clearComposeLine(this._echoProbe(draft), attempt);
      if (!same()) return false;
    }
    const sent = await this.submitLine(text);
    if (draft && same()) {
      await new Promise((r) => window.setTimeout(r, 120));
      if (same()) await this._writeInput(draft);
    }
    return sent;
  }
  async waitForOutput(maxMs) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (this.running && this.hasOutput) return true;
      if (this._closed) return false;
      await new Promise((r) => window.setTimeout(r, 50));
    }
    return !!(this.running && this.hasOutput);
  }
  async waitForQuiet(quietMs, maxMs) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (Date.now() - (this.lastOutputAt || 0) >= quietMs) return;
      await new Promise((r) => window.setTimeout(r, 100));
    }
  }
  // A dialog the CLI opens before its prompt (a folder trust question, Claude's warning
  // for skipped permissions, any "Enter to confirm" menu): nothing is typed into it,
  // since an Enter there answers it: an opening's Enter once answered "No, exit" to
  // Claude's skipped-permissions warning, and picked "Update now" on Codex's "Update
  // available" menu, so Codex updated itself.
  // The visible screen only: a dialog that has scrolled away, or a reply that quoted one
  // and scrolled off, isn't showing. Unanchored, since a trust question's answer lines
  // ("Yes, I trust this folder") carry the words mid-line.
  _dialogShowing() {
    return DIALOG_RE.test(this.view.screenTail(this.view.screenRows || 40));
  }
  // Clear once no dialog shows and the screen has gone quiet with none showing: a second
  // dialog can follow the first (Codex's update menu after a trust question).
  async waitPastTrustPrompt(maxMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (!this.running) return false;
      if (!this._dialogShowing()) {
        await this.waitForQuiet(600, 3000);
        if (!this._dialogShowing()) return true;
      }
      await new Promise((r) => window.setTimeout(r, 250));
    }
    return false;
  }

  // ---- The transcript file ----

  // This session's transcript file: by id when known. A fresh Codex or Antigravity
  // launch has no id until the CLI writes its file, so it is found by the launch token
  // its opening carried: among the files of this backend created since the launch and
  // not another tab's, the one whose head holds the token.
  async _resolveModelFile() {
    const backend = this.getBackendKey();
    const own = this._ownSessionId();
    if (own) {
      // Its own id is never filtered out, whatever vault list it's on.
      const rec = await this.plugin.findSessionById(own, { own: true });
      return rec && rec.backend === backend ? rec.file : null;
    }
    // An Antigravity side chat learns its id from its /fork (_sendFork), never from here.
    if (this._forkFrom && backend === "antigravity") return null;
    if (!this._launchToken && !this._forkFrom) return null;
    let recs = [];
    try { recs = (await this.plugin.sessionIndex()).filter((r) => r.backend === backend); } catch { return null; }
    const taken = new Set();
    for (const v of this.plugin.sessionObjects()) if (v !== this && v._modelFile) taken.add(v._modelFile);
    const since = (this._launchedAt || 0) - 2000;
    const born = (f) => { try { const st = fs.statSync(f); return st.birthtimeMs || st.mtimeMs; } catch { return 0; } };
    const marker = `(launch ${this._launchToken})`;
    const fresh = recs.filter((r) => !taken.has(r.file) && !(this._launchedAt && born(r.file) < since)).sort((a, b) => b.mtime - a.mtime);
    // A Codex side chat: the rollout made since its launch whose first line says it was
    // forked from the source ("forked_from_id"). It carries no name marker of its own.
    // Two side chats of one session started together: neither takes an id another tab
    // holds, and the earlier fork goes to the earlier launch.
    if (this._forkFrom) {
      const from = `"forked_from_id":${JSON.stringify(this._forkFrom.id)}`;
      const held = new Set();
      for (const v of this.plugin.sessionObjects()) if (v !== this && v._ownSessionId()) held.add(v._ownSessionId());
      const found = fresh.filter((r) => {
        try { return r.sessionId !== this._forkFrom.id && !held.has(r.sessionId) && readFileHead(r.file, 8192).includes(from); } catch { return false; }
      }).sort((a, b) => born(a.file) - born(b.file))[0] || null;
      if (found) this._learnId(found.sessionId);
      return found ? found.file : null;
    }
    let found = fresh.find((r) => {
      try { return readFileHead(r.file, 262144).includes(marker); } catch { return false; }
    }) || null;
    // The opening never went out (a dialog held it, or the user typed first), so there's
    // no token to find: the newest of this backend's files made since the launch.
    if (!found && !this._openingSent) found = fresh[0] || null;
    if (found) this._learnId(found.sessionId);
    return found ? found.file : null;
  }
  // A fresh Codex or Antigravity launch has found its transcript: from now on it is that
  // id everywhere (restore, links, rows), and an Antigravity one is this vault's.
  _learnId(id) {
    if (!id || this._ownSessionId()) return;
    this.launchSessionId = id;
    this._launchToken = null;
    // A Codex side chat's rollout has no name marker; its name is kept as a rename.
    if (this._forkFrom) { const src = this._forkFrom.id; this._forkFrom = null; this.plugin.adoptSideChat(id, this.sessionTitle, src).catch(() => {}); }
    if (this.getBackendKey() === "antigravity") this.plugin.rememberAntigravitySession(id).catch(() => {});
    this.refreshStripId?.();
    this.app.workspace.requestSaveLayout();
    this.plugin.refreshBrowsers();
  }
};
applyParts(SessionController, ViewTranscriptMethods, StripMethods, ViewNoteMethods, IdentityMethods, SessionActionMethods);
export { SessionController };
