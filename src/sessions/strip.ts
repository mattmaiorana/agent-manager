// The status strip above a session: title, id, model, backend, Side chat, and its commands.

import { import_obsidian } from "../externals.js";
import { CLI_BACKENDS, REAL_BACKENDS, SIDE_SUFFIX_RE, STRIP_COMMANDS } from "../constants/backends.js";
import { wrapLine } from "../constants/names.js";
import { modelFromTranscriptTail, prettyModelName, readFileTail } from "../sessions/transcript-files.js";
import { INPUT_GUARD_NOTICE_MS } from "./constants.js";
import type { BackendKey, StripCommand } from "../constants/backends.js";
import type { ForkFrom } from "../types.js";
import { ChoicePickerModal } from "../ui/modals.js";
// Continue Session's three: beside a note's main session, in its place, or a new session.
type ContinueRole = "side" | "main" | "new";
import type { ModelInfo } from "../sessions/transcript-files.js";
import type { Session } from "./controller.js";
// An item of the strip's info menu: a command, or the plugin's own rename.
type StripItem = StripCommand & { action?: "rename" };
class StripMethods {
  buildStatusStrip(this: Session, container: HTMLElement): void {
    const strip = container.createDiv({ cls: "agent-manager-strip" });
    // The note or folder this session was started from, one click away.
    this._showNoteIcon(strip);
    // The session's title. Right-click for a menu with "Rename session" (a right-click,
    // like the sidebar row's, so a stray click can't start a rename); a plain click only
    // selects text.
    const titleEl = strip.createSpan({
      cls: "agent-manager-strip-title" + (this.sessionTitle ? "" : " agent-manager-strip-muted"),
      text: this.sessionTitle || "Terminal"
    });
    if (this.sessionTitle) {
      this._stripTip(titleEl, "Right-click to rename this session");
      titleEl.addEventListener("contextmenu", (evt) => {
        evt.preventDefault();
        const menu = new import_obsidian.Menu();
        menu.addItem((i) => i.setTitle("Rename session").setIcon("pencil").onClick(() => this._startStripRename(titleEl)));
        menu.addItem((i) => i.setTitle("Copy session name").setIcon("copy").onClick(async () => {
          const name = this.sessionTitle || "";
          try { await navigator.clipboard.writeText(name); new import_obsidian.Notice(`Copied “${name}”`); } catch { /* best effort */ }
        }));
        const id = this._stripSessionId();
        if (id) menu.addItem((i) => i.setTitle(`Copy session id (${id.slice(0, 8)})`).setIcon("copy").onClick(async () => {
          try { await navigator.clipboard.writeText(id); new import_obsidian.Notice(`Copied session id ${id}`); } catch { /* best effort */ }
        }));
        this.addMoveToAgent(menu, id, this.getBackendKey());
        menu.showAtMouseEvent(evt);
      });
    }
    // The session's short id, next to the name: two tabs can share a
    // title after a re-host or a compaction continuation, and this is the quick way to
    // tell which one you are in and which transcript note is yours (its filename ends in
    // the same eight characters). Blank until the id is known; follows a repoint.
    this.idEl = strip.createSpan({ cls: "agent-manager-strip-id" });
    this.idEl.addEventListener("click", () => {
      const id = this._stripSessionId();
      if (!id) return;
      void (async () => {
        try { await navigator.clipboard.writeText(id); new import_obsidian.Notice(`Copied session id ${id}`); } catch { /* best effort */ }
      })();
    });
    this.refreshStripId();
    strip.createSpan({ cls: "agent-manager-strip-spacer" });
    this.stripEl = strip;
    if (this._rehostedFrom) this._showRehostPill();
    const stripBackendKey = this.activeBackendKey || this.getBackendKey();
    // Info: common slash commands for this backend. Click opens a menu; picking a command
    // sends it (or types it, for one that wants an argument).
    if (STRIP_COMMANDS[stripBackendKey] && STRIP_COMMANDS[stripBackendKey].length) {
      const info = strip.createSpan({ cls: "agent-manager-strip-info", attr: { role: "button" } });
      import_obsidian.setIcon(info, "info");
      this._stripTip(info, `Common ${CLI_BACKENDS[stripBackendKey].label} commands. Click for the list; pick one to run it.`);
      info.addEventListener("click", (evt) => {
        const menu = new import_obsidian.Menu();
        menu.addItem((i) => i.setTitle(`Common ${CLI_BACKENDS[stripBackendKey].label} commands`).setDisabled(true));
        for (const c of this._stripCommandItems(stripBackendKey)) {
          menu.addItem((i) => i.setTitle(`${c.cmd}  ·  ${c.what}${c.args ? " (types it; add the rest)" : ""}`).setIcon(c.action === "rename" ? "pencil" : "terminal").onClick(() => { void this._runStripCommand(c); }));
        }
        menu.showAtMouseEvent(evt);
      });
    }
    // Wrap: types the Wrap message setting, as this CLI takes it.
    if (REAL_BACKENDS.includes(stripBackendKey) && this.plugin.wrapMessage()) {
      const wrap = strip.createSpan({ cls: "agent-manager-strip-new", text: "Wrap", attr: { role: "button" } });
      this._stripTip(wrap, "Ask the agent to wrap up the session");
      wrap.addEventListener("click", () => { void this.sendWrap(); });
    }
    // Continue Session: a new session that carries this one on, beside it or in its
    // place, on any CLI.
    if (REAL_BACKENDS.includes(stripBackendKey)) {
      const btn = strip.createSpan({ cls: "agent-manager-strip-new", text: "Continue Session", attr: { role: "button" } });
      this._stripTip(btn, "Start a new session that picks up from this one, beside it or in its place");
      btn.addEventListener("click", (evt) => this._continueMenu(evt));
    }
    // The backend this session is running, as a badge for orientation.
    this.appendBackendBadge(strip, stripBackendKey);
    // Strip order: note, title, id (the identity cluster, left), then the spacer, then the
    // controls: info, Side chat, backend, model, transcript.
    // The model this session is on, read from the transcript (Claude/Codex record
    // it per turn). Short label, full id on hover; blank until the first response
    // writes a model, and blank for Antigravity (no model field in its transcript).
    this.modelEl = strip.createSpan({ cls: "agent-manager-strip-model" });
    void this.updateStripModel();
    // Rendered-transcript toggle — Claude, Codex, and Antigravity (each has a
    // parser). Flips the pane between the live terminal and the session
    // transcript rendered as real markdown (native select/copy, no wrapping,
    // no chrome).
    if (REAL_BACKENDS.includes(stripBackendKey)) {
      const tr = strip.createSpan({ cls: "agent-manager-strip-transcript" });
      this._stripTip(tr, "Toggle rendered transcript");
      tr.addEventListener("click", () => this.toggleTranscript());
      this.transcriptBtnEl = tr;
      if (this._transcriptOpen) tr.addClass("is-active");
      this._syncTranscriptIcon();
    }
  }
  // The id this view is bound to: the resume id, else the transcript file it resolved
  // (a fresh launch learns its id from that file after the first turn).
  _stripSessionId(this: Session): string | null {
    const own = this._ownSessionId();
    if (own) return own;
    const f = this._modelFile;
    if (!f) return null;
    // Per backend, through transcript-core: Claude's file is <uuid>.jsonl, Codex's is
    // rollout-<ts>-<uuid>.jsonl, Antigravity's is brain/<uuid>/.../transcript.jsonl. The
    // old hex-basename regex matched Claude only, so Codex and agy launches had no id
    // pill and no saved id.
    try {
      const id = this.plugin._tc().deriveSessionId(String(f), this.getBackendKey());
      return /^[0-9a-fA-F-]{16,}$/.test(id || "") ? id : null;
    } catch { return null; }
  }
  refreshStripId(this: Session): void {
    const el = this.idEl;
    if (!el || !el.isConnected) return;
    const id = this._stripSessionId();
    if (!id) { el.setText(""); this._stripTip(el, ""); el.addClass("is-empty"); return; }
    el.removeClass("is-empty");
    el.setText(id.slice(0, 8));
    this._stripTip(el, `Session id ${id}. Its transcript note ends with (${id.slice(0, 8)}). Click to copy the full id.`);
  }
  // Strip tooltips go through Obsidian's tooltip system (aria-label, plus setTooltip
  // where the API has it), not a native `title`: native tooltips are unreliable inside
  // Obsidian's window, and Obsidian's render on hover at once, styled, and wrap long text.
  _stripTip(el: HTMLElement | null | undefined, text: string): void {
    if (!el) return;
    el.removeAttribute("title");
    if (!text) { el.removeAttribute("aria-label"); return; }
    el.setAttribute("aria-label", text);
    if (typeof import_obsidian.setTooltip === "function") {
      try { import_obsidian.setTooltip(el, text, { placement: "bottom" }); } catch { /* best effort */ }
    }
  }
  _stripCommandItems(backendKey: BackendKey): StripItem[] {
    return STRIP_COMMANDS[backendKey] || [];
  }
  // Run a command from the info menu. Guarded like /rename: never on top of an unsent
  // draft. A command that wants an argument is typed into the prompt, not sent.
  // Type the Wrap message, never over unsent text or into a question the CLI is asking.
  async sendWrap(this: Session): Promise<void> {
    const line = wrapLine(this.plugin.wrapMessage(), this.getBackendKey());
    if (!line) return;
    if (!this.running) { new import_obsidian.Notice("This session isn't running."); return; }
    if (this.hasPendingInput()) { new import_obsidian.Notice("Not sent: you have unsent text in the prompt. Clear it, then press Wrap again.", INPUT_GUARD_NOTICE_MS); return; }
    if (this._dialogShowing()) { new import_obsidian.Notice("Not sent: the session is asking you something. Answer it, then press Wrap again.", INPUT_GUARD_NOTICE_MS); return; }
    await this.submitLine(line);
  }
  async _runStripCommand(this: Session, c: StripItem): Promise<void> {
    if (c.action === "rename") { this._startStripRename(this.stripEl?.querySelector<HTMLElement>(".agent-manager-strip-title")); return; } // the plugin's rename, never a bare /rename
    if (!this.running) { new import_obsidian.Notice("This session isn't running."); return; }
    if (this.hasPendingInput()) { new import_obsidian.Notice(`Not sent: you have unsent text in the prompt. Clear it, then pick ${c.cmd} again.`, INPUT_GUARD_NOTICE_MS); return; }
    if (this._dialogShowing()) { new import_obsidian.Notice(`Not sent: the session is asking you something. Answer it, then pick ${c.cmd} again.`, INPUT_GUARD_NOTICE_MS); return; }
    if (c.args) { this.writeRaw(`${c.cmd} `); this.focusTerminal(); return; }
    await this.submitLine(c.cmd);
  }
  // The transcript toggle's icon follows its state: a closed book while the terminal
  // shows, an open one while the rendered transcript shows.
  _syncTranscriptIcon(this: Session): void {
    const el = this.transcriptBtnEl;
    if (!el || !el.isConnected) return;
    import_obsidian.setIcon(el, this._transcriptOpen ? "book-open-text" : "book-text");
  }
  // The strip's title text, re-read from sessionTitle (a rename relabels the tab header
  // through leaf.updateHeader, but the strip is built once, so it has to be told).
  refreshStripTitle(this: Session): void {
    const el = this.stripEl?.querySelector<HTMLElement>(".agent-manager-strip-title");
    if (!el || el.querySelector("input")) return;
    el.setText(this.sessionTitle || "Terminal");
    el.toggleClass("agent-manager-strip-muted", !this.sessionTitle);
  }
  // Rename from the strip: the title becomes an input, Enter commits through applyRename
  // (the same path as the sidebar's right-click rename: the plugin-data override, the
  // tab header, this strip, and Claude's own /rename), Escape or blur cancels.
  _startStripRename(this: Session, titleEl: HTMLElement | null | undefined): void {
    if (!titleEl || !this.sessionTitle || titleEl.querySelector("input")) return;
    const subject = this.sessionTitle;
    titleEl.empty();
    titleEl.addClass("is-renaming");
    // The strip gets a class too, so CSS can hide the id chip without :has().
    this.stripEl?.addClass("is-renaming");
    const input = titleEl.createEl("input", { type: "text", cls: "agent-manager-strip-title-input", value: subject });
    let done = false;
    const restore = () => { titleEl.removeClass("is-renaming"); this.stripEl?.removeClass("is-renaming"); titleEl.empty(); titleEl.setText(this.sessionTitle || "Terminal"); };
    const cancel = () => { if (done) return; done = true; restore(); };
    const commit = async () => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      restore();
      if (!value || value === subject) return;
      const sessionId = await this._liveSessionId();
      if (!sessionId) { new import_obsidian.Notice("Rename after this session's first turn completes; it has no id yet."); return; }
      const ok = await this.applyRename({ sessionId, title: subject, backend: this.getBackendKey(), displayName: subject }, value);
      if (ok) this.plugin.refreshBrowsers();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); void commit(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", cancel);
    input.addEventListener("click", (e) => e.stopPropagation());
    window.setTimeout(() => { input.focus(); input.select(); }, 0);
  }
  // The "re-hosted" pill on the strip: this session's conversation moved to a new id
  // (a Remote Control re-host, or a resume that attached to one) and the plugin
  // followed it. Persistent so a re-host can't be overlooked; the tooltip carries the
  // ids and the time. Idempotent per strip.
  _showRehostPill(this: Session): void {
    const strip = this.stripEl;
    const f = this._rehostedFrom;
    if (!strip || !strip.isConnected || !f) return;
    if (strip.querySelector(".agent-manager-strip-rehosted")) return;
    const when = f.at ? new Date(f.at).toLocaleString() : "";
    const continued = f.kind === "continued";
    const pill = strip.createSpan({ cls: "agent-manager-strip-rehosted", text: continued ? "continued" : "re-hosted" });
    const a = String(f.from).slice(0, 8), b = String(f.to).slice(0, 8);
    this._stripTip(pill, continued
      ? `Continued${when ? ` on ${when}` : ""}: Claude compacted this session's context and carried on as a new session (${a} → ${b}). Same conversation. This tab followed it, and the transcript note now grows from the new session. The old session's note stays as history.`
      : `Re-hosted${when ? ` on ${when}` : ""}: Remote Control moved this session to a new session id (${a} → ${b}). Same conversation. This tab followed it, and the transcript note now grows from the new session. The old session's note stays as history.`);
    // Sit right after the title (before the backend badge).
    const anchor = strip.querySelector(".agent-manager-strip-title");
    if (anchor && anchor.nextSibling) strip.insertBefore(pill, anchor.nextSibling);
  }
  // Side chat: a new tab with a copy of this conversation so far, on the same CLI, made
  // by the CLI's own fork (Claude's --fork-session, Codex's fork, Antigravity's /fork).
  // This session is left untouched, and the side chat never takes over the note this
  // one came from, though its transcript links back to it.
  async sideChat(this: Session): Promise<void> {
    const backend = this.getBackendKey();
    // Capture what's new first, so this session's note is current when the copy starts.
    try { await this.updateDurableTranscript(); } catch { /* best effort */ }
    const id = this._ownSessionId() || (await this._liveSessionId?.());
    // A Claude session has its id from launch but nothing to copy until its first
    // message is written, so it needs its transcript too.
    if (!id || (backend === "claude" && !this._modelFile)) { new import_obsidian.Notice("A side chat needs this session's first turn to finish, so there's something to copy. Try again after it does.", 8000); return; }
    await this.plugin.startSession(this._sideChatName(), this, {
      sideSession: true,
      backendOverride: backend,
      notePath: this._notePath || null,
      folderPath: this._folderPath || null,
      forkFrom: { id, backend, cwd: this.workingDir || null },
      agentId: this.agentId(),
    });
  }
  // Continue Session's menu: the CLIs offered, this one first. A session started from a
  // note lists them twice, under Side Session and New Main Session; any other, once.
  _continueMenu(this: Session, evt: MouseEvent): void {
    const here = this.getBackendKey();
    const offered = this.plugin.getBrowserBackends();
    const order = [here, ...offered.filter((k) => k !== here)];
    const menu = new import_obsidian.Menu();
    const items = (role: ContinueRole) => {
      for (const key of order) {
        menu.addItem((i) => i.setTitle(`${CLI_BACKENDS[key].label}${key === here ? " (this backend)" : ""}`).onClick(() => this._continueChoice(key, role)));
      }
    };
    if (this._notePath) {
      menu.addItem((i) => i.setTitle("Side session").setDisabled(true));
      items("side");
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("New main session").setDisabled(true));
      items("main");
    } else {
      menu.addItem((i) => i.setTitle("New session").setDisabled(true));
      items("new");
    }
    menu.showAtMouseEvent(evt);
  }
  // The two choices for what the new session gets: the full one (a copy of this
  // conversation on the same CLI, else this session's transcript to read), or the light
  // one (the ticket or the note it was started from, else this session's last message).
  _continueChoice(this: Session, backend: BackendKey, role: ContinueRole): void {
    const same = backend === this.getBackendKey();
    const ticket = !!this._notePath && this.plugin.isTicketNote(this._notePath);
    const choices: Array<{ full: boolean; label: string; sub: string }> = [
      same
        ? { full: true, label: "Keep full context", sub: "A copy of this conversation, made by the CLI." }
        : { full: false, label: ticket ? "Read the ticket" : this._notePath ? "Read the note" : "Read the last message only", sub: "Told where this session's transcript is, if it needs more." },
      same
        ? { full: false, label: ticket ? "Read the ticket" : this._notePath ? "Read the note" : "Read the last message only", sub: "A fresh start, told where this session's transcript is." }
        : { full: true, label: "Read the transcript", sub: "Reads this session's transcript in full." },
    ];
    new ChoicePickerModal(this.app, choices, {
      placeholder: `${role === "side" ? "Side session" : role === "main" ? "New main session" : "New session"} on ${CLI_BACKENDS[backend].label}: what should it get?`,
      label: (c) => c.label,
      sub: (c) => c.sub,
      onPick: (c) => { void this.continueSession(backend, role, c.full); },
    }).open();
  }
  // Start the session Continue Session asked for. A main one takes the note's
  // main-session once it has an id, and the old one becomes Previous main only then; if
  // it doesn't start, nothing moves.
  async continueSession(this: Session, backend: BackendKey, role: ContinueRole, full: boolean, noFork = false): Promise<void> {
    const here = this.getBackendKey();
    // noFork: the fork already failed (Antigravity's /fork), so the transcript instead.
    const fork = full && backend === here && !noFork;
    let transcript: string | null = null;
    try { const res = await this.updateDurableTranscript(); transcript = (res && res.path) || null; } catch { /* best effort */ }
    let forkFrom: ForkFrom | null = null;
    if (fork) {
      const id = this._ownSessionId() || (await this._liveSessionId?.());
      if (!id || (here === "claude" && !this._modelFile)) { new import_obsidian.Notice("Keeping full context needs this session's first turn to finish, so there's something to copy. Try again after it does.", 8000); return; }
      forkFrom = { id, backend, cwd: this.workingDir || null };
    } else if (!transcript) {
      new import_obsidian.Notice("Agent Manager: this session's transcript isn't written yet. Try again after its first turn finishes.", 8000);
      return;
    }
    const subject = (this.sessionTitle || "").replace(SIDE_SUFFIX_RE, "").trim() || "Untitled";
    await this.plugin.startSession(role === "side" ? this._sideChatName() : subject, this, {
      backendOverride: backend,
      notePath: this._notePath || null,
      folderPath: this._notePath ? null : this._folderPath || null,
      sideSession: role === "side",
      newMain: role === "main",
      // A continuation keeps this session's agent, none included.
      agentId: this.agentId(),
      ...(forkFrom ? { forkFrom } : {
        handoffNote: transcript,
        handoffFromBackend: here,
        handoffMode: full ? "transcript" : this._notePath ? "pointer" : "last",
      }),
    });
  }
  // A side chat's name: this session's, with " (side chat)" once, however deep.
  _sideChatName(this: Session): string {
    const subject = (this.sessionTitle || "").replace(SIDE_SUFFIX_RE, "").trim() || "Untitled";
    return `${subject} (side chat)`;
  }
  // The fallback when a CLI can't fork (Antigravity, when /fork doesn't answer): a new
  // session on the same CLI, told to read this session's transcript note.
  async pointerSideChat(this: Session, afterFailedFork = false): Promise<void> {
    const backend = this.getBackendKey();
    let notePath: string | null = null;
    try { const res = await this.updateDurableTranscript(); notePath = (res && res.path) || null; } catch { /* best effort */ }
    if (!notePath) { new import_obsidian.Notice("Agent Manager: a side chat needs this session's transcript, which isn't written yet. Try again after the first turn completes.", 8000); return; }
    if (afterFailedFork) new import_obsidian.Notice(`Agent Manager: ${CLI_BACKENDS[backend].label} couldn't fork this conversation, so the side chat is a new session that reads its transcript instead.`, 10000);
    await this.plugin.startSession(this._sideChatName(), this, {
      sideSession: true,
      backendOverride: backend,
      notePath: this._notePath || null,
      folderPath: this._folderPath || null,
      handoffNote: notePath,
      handoffFromBackend: backend,
      handoffIntent: (this.sessionTitle || "").replace(SIDE_SUFFIX_RE, "").trim() || "Untitled",
      agentId: this.agentId(),
    });
  }
  // Refresh the strip's model badge from the transcript. Called when the strip is
  // built and on each working→idle edge (a completed turn just wrote a fresh model
  // record), so it stays current across a mid-session /model change without polling
  // the disk. No-op if the strip isn't showing a model element.
  async updateStripModel(this: Session): Promise<void> {
    this.refreshStripId();
    const el = this.modelEl;
    if (!el) return;
    let info: ModelInfo | null = null;
    try { info = await this.getSessionModel(); } catch { /* best effort */ }
    if (el !== this.modelEl) return; // strip was rebuilt mid-read
    if (!info || !info.model) { el.setText(""); el.removeAttribute("title"); return; }
    const short = prettyModelName(info.model);
    el.setText(info.effort ? `${short} · ${info.effort}` : short);
    el.setAttribute("title", info.effort ? `${info.model} (${info.effort})` : info.model);
  }
  // The current model for this session, from the tail of its transcript. Claude and
  // Codex record "model" (and Codex "reasoning_effort") per turn, so the last value
  // is live and tracks /model changes. Antigravity's transcript has no model field,
  // so this returns null (blank badge).
  async getSessionModel(this: Session): Promise<ModelInfo | null> {
    const file = await this._transcriptFile();
    if (!file) return null;
    const backendKey = this.getBackendKey();
    // Antigravity's transcript records no model, so there is nothing to read.
    if (backendKey === "antigravity") return null;
    // The record's own field in the last 64KB, then in the last 1MB (a few large
    // records can push the model out of the smaller window), and only then any
    // "model" string, which conversation content can carry too.
    const small = readFileTail(file, 65536);
    const info = modelFromTranscriptTail(small, backendKey, false);
    if (info) return info;
    const large = readFileTail(file, 1048576);
    return modelFromTranscriptTail(large, backendKey, false) || modelFromTranscriptTail(small, backendKey, true);
  }
}
export { StripMethods };
