
import { fs, import_obsidian, path } from "../externals.js";
import { CLI_BACKENDS, REAL_BACKENDS, SIDE_SUFFIX_RE, STRIP_COMMANDS, sideChatName } from "../constants/backends.js";
import { wrapLine } from "../constants/names.js";
import { modelFromTranscriptTail, prettyModelName, readFileTail } from "../sessions/transcript-files.js";
import type { BackendKey, StripCommand } from "../constants/backends.js";
import type { ForkFrom } from "../types.js";
import { ChoicePickerModal } from "../ui/modals.js";
type ContinueRole = "side" | "main" | "new";
import type { ModelInfo } from "../sessions/transcript-files.js";
import type { Session } from "./controller.js";
import { notice } from "../vault-terminal/notice";
type StripItem = StripCommand & { action?: "rename" };
class StripMethods {
  buildStatusStrip(this: Session, container: HTMLElement): void {
    const strip = container.createDiv({ cls: "agent-manager-strip" });
    this._showNoteIcon(strip);
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
          try { await navigator.clipboard.writeText(name); notice(`Copied “${name}”`); } catch { /* empty */ }
        }));
        const id = this._stripSessionId();
        if (id) menu.addItem((i) => i.setTitle(`Copy session id (${id.slice(0, 8)})`).setIcon("copy").onClick(async () => {
          try { await navigator.clipboard.writeText(id); notice(`Copied session id ${id}`); } catch { /* empty */ }
        }));
        this.addMoveToAgent(menu, id, this.getBackendKey());
        menu.showAtMouseEvent(evt);
      });
    }
    this.idEl = strip.createSpan({ cls: "agent-manager-strip-id" });
    this.idEl.addEventListener("click", () => {
      const id = this._stripSessionId();
      if (!id) return;
      void (async () => {
        try { await navigator.clipboard.writeText(id); notice(`Copied session id ${id}`); } catch { /* empty */ }
      })();
    });
    this.agentPillEl = strip.createSpan({ cls: "agent-manager-strip-agent" });
    this.refreshStripId();
    strip.createSpan({ cls: "agent-manager-strip-spacer" });
    this.stripEl = strip;
    if (this._rehostedFrom) this._showRehostPill();
    const stripBackendKey = this.activeBackendKey || this.getBackendKey();
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
    if (REAL_BACKENDS.includes(stripBackendKey) && this.plugin.wrapMessage()) {
      const wrap = strip.createSpan({ cls: "agent-manager-strip-new", text: "Wrap", attr: { role: "button" } });
      this._stripTip(wrap, "Ask the agent to wrap up the session");
      wrap.addEventListener("click", () => { void this.sendWrap(); });
    }
    if (REAL_BACKENDS.includes(stripBackendKey)) {
      const btn = strip.createSpan({ cls: "agent-manager-strip-new", text: "Continue Session", attr: { role: "button" } });
      this._stripTip(btn, "Start a new session that picks up from this one, beside it or in its place");
      btn.addEventListener("click", (evt) => this._continueMenu(evt));
    }
    this.appendBackendBadge(strip, stripBackendKey);
    this.modelEl = strip.createSpan({ cls: "agent-manager-strip-model" });
    void this.updateStripModel();
    if (stripBackendKey === "claude" && this._quietTools) {
      const quiet = strip.createSpan({ cls: "agent-manager-strip-quiet", attr: { role: "button" } });
      quiet.addEventListener("click", () => { void this.sendQuiet(); });
      this._quietBtnEl = quiet;
      this._syncQuietIcon();
    }
    if (REAL_BACKENDS.includes(stripBackendKey)) {
      const tr = strip.createSpan({ cls: "agent-manager-strip-transcript" });
      this._stripTip(tr, "Toggle rendered transcript. Right-click to open the transcript note");
      tr.addEventListener("click", () => this.toggleTranscript());
      tr.addEventListener("contextmenu", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const menu = new import_obsidian.Menu();
        menu.addItem((i) => i.setTitle("Open transcript note").setIcon("file-text").onClick(() => { void this.openDurableTranscriptNote(); }));
        menu.showAtMouseEvent(evt);
      });
      this.transcriptBtnEl = tr;
      if (this._transcriptOpen) tr.addClass("is-active");
      this._syncTranscriptIcon();
    }
    this._buildRcDot(strip);
  }
  _stripSessionId(this: Session): string | null {
    const own = this._ownSessionId();
    if (own) return own;
    const f = this._modelFile;
    if (!f) return null;
    try {
      const id = this.plugin._tc().deriveSessionId(String(f), this.getBackendKey());
      return /^[0-9a-fA-F-]{16,}$/.test(id || "") ? id : null;
    } catch { return null; }
  }
  refreshStripId(this: Session): void {
    this.refreshStripAgent();
    const el = this.idEl;
    if (!el || !el.isConnected) return;
    const id = this._stripSessionId();
    if (!id) { el.setText(""); this._stripTip(el, ""); el.addClass("is-empty"); return; }
    el.removeClass("is-empty");
    el.setText(id.slice(0, 8));
    this._stripTip(el, `Session id ${id}. Its transcript note ends with (${id.slice(0, 8)}). Click to copy the full id.`);
  }
  refreshStripAgent(this: Session): void {
    const el = this.agentPillEl;
    if (!el || !el.isConnected) return;
    const launched = this.plugin.agentsOn() ? this.plugin.agentById(this.conversationAgentId()) : null;
    if (!launched) { el.setText(""); this._stripTip(el, ""); el.addClass("is-empty"); return; }
    el.removeClass("is-empty");
    el.setText(launched.name);
    const filedId = this.agentId();
    const filed = filedId === launched.id ? null : this.plugin.agentById(filedId);
    const where = filedId === launched.id ? "" : filed ? ` Filed under ${filed.name}.` : " Filed under no agent profile.";
    this._stripTip(el, `Agent profile: ${launched.name}.${where}`);
  }
  _stripTip(el: HTMLElement | null | undefined, text: string, classes?: string[]): void {
    if (!el) return;
    el.removeAttribute("title");
    if (!text) { el.removeAttribute("aria-label"); return; }
    el.setAttribute("aria-label", text);
    if (typeof import_obsidian.setTooltip === "function") {
      try { import_obsidian.setTooltip(el, text, { placement: "bottom", ...(classes ? { classes } : {}) }); } catch { /* empty */ }
    }
  }
  _stripCommandItems(backendKey: BackendKey): StripItem[] {
    return STRIP_COMMANDS[backendKey] || [];
  }
  async sendWrap(this: Session): Promise<void> {
    const line = wrapLine(this.plugin.wrapMessage(), this.getBackendKey());
    if (!line) return;
    if (!this.running) { notice("This session isn't running."); return; }
    if (this.hasPendingInput()) { this._notifyNeedsYou("Not sent: you have unsent text in the prompt. Clear it, then press Wrap again."); return; }
    if (this._dialogShowing()) { this._notifyNeedsYou("Not sent: the session is asking you something. Answer it, then press Wrap again."); return; }
    await this.submitLine(line);
  }
  async sendQuiet(this: Session): Promise<void> {
    if (!this.running) { notice("This session isn't running."); return; }
    if (this.hasPendingInput()) { this._notifyNeedsYou("Not sent: you have unsent text in the prompt. Clear it, then press Quiet again."); return; }
    if (this._dialogShowing()) { this._notifyNeedsYou("Not sent: the session is asking you something. Answer it, then press Quiet again."); return; }
    if (this._quietSending) return;
    this._quietSending = true;
    try { await this.submitLine("/quiet"); } finally { this._quietSending = false; }
  }
  _syncQuietIcon(this: Session): void {
    const el = this._quietBtnEl;
    if (!el || !el.isConnected) return;
    import_obsidian.setIcon(el, this._quietOn ? "unfold-vertical" : "fold-vertical");
    this._stripTip(el, this._quietOn ? "Tool output is folded. Click to show it in full (/quiet)" : "Fold tool output to one line (/quiet)");
  }
  _prepareQuietState(this: Session): Record<string, string> | null {
    const dir = this.plugin.claudeQuietStateDir();
    if (!dir) return null;
    try {
      this._stopQuietWatch(true);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${window.crypto.randomUUID()}.json`);
      this._quietFile = file;
      this._setQuietOn(false);
      const name = path.basename(file);
      const watch = fs.watch(dir, (_event, changed) => {
        if (changed && String(changed) !== name) return;
        this._readQuietState();
      });
      watch.on("error", () => this._stopQuietWatch());
      this._quietWatch = watch;
      return { AGENT_MANAGER_QUIET_STATE: file };
    } catch (e) {
      console.error("[Agent Manager] couldn't set up the quiet-tools state file:", e);
      this._stopQuietWatch(true);
      return null;
    }
  }
  _readQuietState(this: Session): void {
    const file = this._quietFile;
    if (!file) return;
    let on = false;
    try {
      const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      on = typeof data === "object" && data !== null && (data as { isQuiet?: unknown }).isQuiet === true;
    } catch { return; }
    this._setQuietOn(on);
  }
  _setQuietOn(this: Session, on: boolean): void {
    if (this._quietOn === on) return;
    this._quietOn = on;
    this._syncQuietIcon();
  }
  _stopQuietWatch(this: Session, remove = false): void {
    try { this._quietWatch?.close(); } catch { /* empty */ }
    this._quietWatch = null;
    if (remove && this._quietFile) { try { fs.rmSync(this._quietFile, { force: true }); } catch { /* empty */ } }
    if (remove) this._quietFile = null;
  }
  _setQuietTools(this: Session, on: boolean): void {
    if (this._quietTools === on) return;
    this._quietTools = on;
    this.rebuildStrip();
  }
  async _runStripCommand(this: Session, c: StripItem): Promise<void> {
    if (c.action === "rename") { this._startStripRename(this.stripEl?.querySelector<HTMLElement>(".agent-manager-strip-title")); return; }
    if (!this.running) { notice("This session isn't running."); return; }
    if (this.hasPendingInput()) { this._notifyNeedsYou(`Not sent: you have unsent text in the prompt. Clear it, then pick ${c.cmd} again.`); return; }
    if (this._dialogShowing()) { this._notifyNeedsYou(`Not sent: the session is asking you something. Answer it, then pick ${c.cmd} again.`); return; }
    if (c.args) { this.writeRaw(`${c.cmd} `); this.focusTerminal(); return; }
    await this.submitLine(c.cmd);
  }
  _syncTranscriptIcon(this: Session): void {
    const el = this.transcriptBtnEl;
    if (!el || !el.isConnected) return;
    import_obsidian.setIcon(el, this._transcriptOpen ? "book-open-text" : "book-text");
  }
  refreshStripTitle(this: Session): void {
    const el = this.stripEl?.querySelector<HTMLElement>(".agent-manager-strip-title");
    if (!el || el.querySelector("input")) return;
    el.setText(this.sessionTitle || "Terminal");
    el.toggleClass("agent-manager-strip-muted", !this.sessionTitle);
  }
  _startStripRename(this: Session, titleEl: HTMLElement | null | undefined): void {
    if (!titleEl || !this.sessionTitle || titleEl.querySelector("input")) return;
    const subject = this.sessionTitle;
    titleEl.empty();
    titleEl.addClass("is-renaming");
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
      if (!sessionId) { notice("Rename after this session's first turn completes; it has no id yet."); return; }
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
    const anchor = strip.querySelector(".agent-manager-strip-title");
    if (anchor && anchor.nextSibling) strip.insertBefore(pill, anchor.nextSibling);
  }
  async sideChat(this: Session): Promise<void> {
    const backend = this.getBackendKey();
    try { await this.updateDurableTranscript(); } catch { /* empty */ }
    const id = this._ownSessionId() || (await this._liveSessionId?.());
    if (!id || (backend === "claude" && !this._modelFile)) { notice("A side chat needs this session's first turn to finish, so there's something to copy. Try again after it does."); return; }
    await this.plugin.startSession(await this._sideChatName(), this, {
      sideSession: true,
      backendOverride: backend,
      notePath: this._notePath || null,
      folderPath: this._folderPath || null,
      forkFrom: { id, backend, cwd: this.workingDir || null },
      agentId: this.agentId(),
    });
  }
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
  _continueChoice(this: Session, backend: BackendKey, role: ContinueRole): void {
    const same = backend === this.getBackendKey();
    const ticket = !!this._notePath && this.plugin.isTicketNote(this._notePath);
    const choices: Array<{ full: boolean; label: string; sub: string }> = [
      same
        ? { full: true, label: "Keep full context (fork)", sub: "A copy of this conversation, made by the CLI." }
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
  async continueSession(this: Session, backend: BackendKey, role: ContinueRole, full: boolean, noFork = false): Promise<void> {
    const here = this.getBackendKey();
    const fork = full && backend === here && !noFork;
    let transcript: string | null = null;
    try { const res = await this.updateDurableTranscript(); transcript = (res && res.path) || null; } catch { /* empty */ }
    let forkFrom: ForkFrom | null = null;
    if (fork) {
      const id = this._ownSessionId() || (await this._liveSessionId?.());
      if (!id || (here === "claude" && !this._modelFile)) { notice("Keeping full context needs this session's first turn to finish, so there's something to copy. Try again after it does."); return; }
      forkFrom = { id, backend, cwd: this.workingDir || null };
    } else if (!transcript) {
      notice("Agent Manager: this session's transcript isn't written yet. Try again after its first turn finishes.");
      return;
    }
    const subject = (this.sessionTitle || "").replace(SIDE_SUFFIX_RE, "").trim() || "Untitled";
    await this.plugin.startSession(role === "side" ? await this._sideChatName() : subject, this, {
      backendOverride: backend,
      notePath: this._notePath || null,
      folderPath: this._notePath ? null : this._folderPath || null,
      sideSession: role === "side",
      newMain: role === "main",
      agentId: this.agentId(),
      ...(forkFrom ? { forkFrom } : {
        handoffNote: transcript,
        handoffFromBackend: here,
        handoffMode: full ? "transcript" : this._notePath ? "pointer" : "last",
      }),
    });
  }
  async _sideChatName(this: Session): Promise<string> {
    const subject = (this.sessionTitle || "").replace(SIDE_SUFFIX_RE, "").trim() || "Untitled";
    const taken: (string | null | undefined)[] = this.plugin.sessionObjects().map((s) => s.sessionTitle);
    try { for (const r of await this.plugin.sessionIndex()) taken.push(r.title, r.rawTitle); } catch { /* empty */ }
    return sideChatName(subject, taken);
  }
  async pointerSideChat(this: Session, afterFailedFork = false): Promise<void> {
    const backend = this.getBackendKey();
    let notePath: string | null = null;
    try { const res = await this.updateDurableTranscript(); notePath = (res && res.path) || null; } catch { /* empty */ }
    if (!notePath) { notice("Agent Manager: a side chat needs this session's transcript, which isn't written yet. Try again after the first turn completes."); return; }
    if (afterFailedFork) notice(`Agent Manager: ${CLI_BACKENDS[backend].label} couldn't fork this conversation, so the side chat is a new session that reads its transcript instead.`);
    await this.plugin.startSession(await this._sideChatName(), this, {
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
  async updateStripModel(this: Session): Promise<void> {
    this.refreshStripId();
    const el = this.modelEl;
    if (!el) return;
    let info: ModelInfo | null = null;
    try { info = await this.getSessionModel(); } catch { /* empty */ }
    if (el !== this.modelEl) return;
    if (!info || !info.model) { el.setText(""); el.removeAttribute("title"); return; }
    const short = prettyModelName(info.model);
    el.setText(info.effort ? `${short} · ${info.effort}` : short);
    el.setAttribute("title", info.effort ? `${info.model} (${info.effort})` : info.model);
  }
  async getSessionModel(this: Session): Promise<ModelInfo | null> {
    const file = await this._transcriptFile();
    if (!file) return null;
    const backendKey = this.getBackendKey();
    if (backendKey === "antigravity") return null;
    const small = readFileTail(file, 65536);
    const info = modelFromTranscriptTail(small, backendKey, false);
    if (info) return info;
    const large = readFileTail(file, 1048576);
    return modelFromTranscriptTail(large, backendKey, false) || modelFromTranscriptTail(small, backendKey, true);
  }
}
export { StripMethods };
