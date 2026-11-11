
import { fs, import_obsidian } from "../externals.js";
import { CLI_BACKENDS, REAL_BACKENDS } from "../constants/backends.js";
import { antigravityBrainDir } from "../sessions/transcript-files.js";
import { ConfirmModal } from "../ui/modals.js";
import { stringOf } from "../util/guards.js";
import { ticketFileName } from "../tickets/new-ticket.js";
import { fillProjectSelect } from "./project-select.js";
import type { BackendKey } from "../constants/backends.js";
import type { SessionRecord, TicketCard } from "../types.js";
import type { Browser, CardKind } from "./view.js";
import { notice } from "../vault-terminal/notice";

const REVEAL_MS = 200;

interface RowOptions {
  draggable?: boolean;
  showDate?: boolean;
  pinned?: boolean;
}
class BrowserMethods {
  renderBrowser(this: Browser, opts: { background?: boolean } | null = null): void {
    this._nextRenderIsBackground = !!(opts && opts.background);
    const scope = this.browserScope;
    if (scope?.page === "tasks") { void this.renderTasksPage(); return; }
    if (scope?.page === "task") { void this.renderTaskPage(scope.notePath); return; }
    if (scope?.page === "outputs") { void this.renderOutputsPage(); return; }
    void this.renderHome();
  }
  async reresolveScope(this: Browser): Promise<void> {
    const scope = this.browserScope;
    if (!scope) return;
    if (!this.plugin.scheduledTasksOn()) this.browserScope = null;
    else if (scope.page === "task" && !this.plugin.isTaskNote(scope.notePath)) this.browserScope = { page: "tasks" };
  }
  goHome(this: Browser): void {
    this.browserScope = null;
    this.renderBrowser();
  }
  refreshStatusDots(this: Browser): void {
    this.refreshTodayDot();
    const openKeys = this.plugin.getOpenSessionKeys();
    const activeKey = this.plugin.getActiveSessionKey();
    const c = this.containerEl;
    c.querySelectorAll<HTMLElement>(".agent-manager-row[data-session-title]").forEach((row) => {
      const keys = this.plugin.sessionRowKeys(row.dataset.sessionBackend as string, row.dataset.sessionTitle as string, row.dataset.sessionId || null);
      const rowOpen = keys.some((k) => openKeys.has(k));
      row.querySelector(".agent-manager-status-dot")?.classList.toggle("is-open", rowOpen);
      row.classList.toggle("is-active", !!activeKey && keys.includes(activeKey));
      const dateEl = row.querySelector(".agent-manager-row-date");
      if (dateEl) {
        let mtime = Number(row.dataset.sessionMtime) || 0;
        const file = row.dataset.sessionFile;
        if (file && row.style.display !== "none") {
          try { mtime = fs.statSync(file).mtimeMs; row.dataset.sessionMtime = String(mtime); } catch { /* empty */ }
        }
        dateEl.setText(this.plugin.shortDate(mtime));
      }
    });
  }
  resortOpenRows(this: Browser): void {
    if (this._sessionDragId || this._renamingId) return;
    const list = this.containerEl.querySelector(".agent-manager-recent-open");
    if (!list) return;
    const rows = (Array.from(list.children) as HTMLElement[]).filter((r) => r.classList.contains("agent-manager-session-row"));
    if (rows.length < 2) return;
    const at = new Map<HTMLElement, number>();
    for (const row of rows) {
      let mtime = Number(row.dataset.sessionMtime) || 0;
      const file = row.dataset.sessionFile;
      if (file) {
        try { mtime = fs.statSync(file).mtimeMs; row.dataset.sessionMtime = String(mtime); } catch { /* empty */ }
      }
      at.set(row, this.plugin.lastActivity(row.dataset.sessionBackend as string, file, mtime));
    }
    const sorted = rows.slice().sort((a, b) => (at.get(b) as number) - (at.get(a) as number));
    if (sorted.every((r, i) => r === rows[i])) return;
    for (const row of sorted) list.appendChild(row);
  }
  async renderHome(this: Browser): Promise<void> {
    const gen = this.beginRender();
    const wrap = createDiv({ cls: "agent-manager-browser-inner agent-manager-home" });
    const head = wrap.createDiv({ cls: "agent-manager-home-head" });
    head.createDiv({ cls: "agent-manager-home-title", text: "Agent Manager" });
    this.renderCustomButton(head.createDiv({ cls: "agent-manager-head-buttons" }));
    this.renderAgentSwitch(wrap);
    this.renderTodayRow(wrap);
    await this.renderTasksRow(wrap);
    const reveals: HTMLElement[] = [];
    const sessionOn = this.plugin.pluginData.newButton !== false;
    const ticketOn = this.plugin.ticketsOn() && (this.plugin.pluginData.newTicketButton !== false || !!this.plugin.ticketCard?.from);
    const pair = sessionOn && ticketOn ? wrap.createDiv({ cls: "agent-manager-card-rows" }) : wrap;
    if (sessionOn) this.renderCardRow(wrap, "session", reveals, pair);
    if (ticketOn) this.renderCardRow(wrap, "ticket", reveals, pair);
    this.renderSetupNote(wrap);
    await new Promise((r) => window.setTimeout(r, 0));
    await this.renderSessionSections(wrap);
    this.swapBrowserContent(wrap, gen);
    if (!wrap.isConnected) return;
    const autofocus = wrap.querySelector<HTMLElement>("[data-autofocus]");
    if (autofocus) { this._focusCard = undefined; autofocus.focus(); }
    const revealCard = this._revealCard || (this._revealCard = {});
    const revealAt = this._revealAt || (this._revealAt = {});
    for (const reveal of reveals) {
      const kind = reveal.dataset.card as CardKind;
      if (revealCard[kind]) { revealCard[kind] = false; revealAt[kind] = Date.now(); }
      else if (reveal.hasClass("is-opening")) reveal.setCssProps({ "--agent-manager-reveal-delay": `-${Date.now() - (revealAt[kind] as number)}ms` });
    }
  }
  isCardOpen(this: Browser, kind: CardKind): boolean {
    return kind === "session" ? this.plugin.newCardOpen === true : this.plugin.ticketCard?.open === true;
  }
  setCardOpen(this: Browser, kind: CardKind, open: boolean): void {
    if (kind === "session") { this.plugin.newCardOpen = open; return; }
    const card = this.ticketCardState();
    card.open = open;
    if (!open) card.from = undefined;
  }
  renderCardRow(this: Browser, wrap: HTMLElement, kind: CardKind, reveals: HTMLElement[], rowParent: HTMLElement = wrap): void {
    const open = this.isCardOpen(kind) && !this._cardClosing?.[kind];
    const name = kind === "session" ? this.plugin.newButtonName() : this.plugin.newTicketButtonName();
    const icon = kind === "session" ? "message-square-plus" : import_obsidian.getIcon("ticket-plus") ? "ticket-plus" : "ticket";
    const row = rowParent.createDiv({ cls: "agent-manager-card-row" + (open ? " is-open" : ""), attr: { role: "button", tabindex: "0", "aria-expanded": String(open) } });
    import_obsidian.setIcon(row.createSpan({ cls: "agent-manager-card-row-icon" }), icon);
    row.createDiv({ cls: "agent-manager-today-title agent-manager-card-row-name", text: name });
    const toggle = () => {
      if (open) { this.closeCard(kind); return; }
      this.setCardOpen(kind, true);
      this._focusCard = kind;
      (this._revealCard || (this._revealCard = {}))[kind] = true;
      this.renderBrowser();
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    if (!open) return;
    const at = this._revealAt?.[kind];
    const growing = !!this._revealCard?.[kind] || (!!at && Date.now() - at < REVEAL_MS);
    const reveal = wrap.createDiv({ cls: "agent-manager-newcard-reveal" + (growing ? " is-opening" : ""), attr: { "data-card": kind } });
    reveals.push(reveal);
    const clip = reveal.createDiv({ cls: "agent-manager-newcard-clip" });
    if (kind === "session") this.renderNewSessionForm(clip); else this.renderNewTicketForm(clip);
  }
  renderSetupNote(this: Browser, wrap: HTMLElement): void {
    const status = this.plugin.setupStatus();
    if (!status) return;
    const noCli = REAL_BACKENDS.every((k) => !status.installed[k]);
    const agentsMissing = this.plugin.agentsFileMissing();
    const startGone = this.plugin.startFolderMissing();
    if (status.python && !noCli && !agentsMissing && !startGone) return;
    const note = wrap.createDiv({ cls: "agent-manager-setup" });
    if (startGone) {
      note.createDiv({ cls: "agent-manager-setup-title", text: "The AGENTS.md folder is gone" });
      note.createDiv({ text: `“${stringOf(this.plugin.pluginData.startFolder)}” isn't in this vault anymore, so sessions can't start. Choose another folder in Settings → Agent Manager.` });
    }
    if (status.python && !noCli) { if (!startGone) this.renderAgentsRow(note); return; }
    if (!status.python) {
      note.createDiv({ cls: "agent-manager-setup-title", text: "Python 3 is needed" });
      note.createDiv({ text: "Agent Manager runs its terminal on Python 3, and couldn't find it. Install it from python.org, or with Homebrew:" });
      this.copyableCommand(note, "brew install python");
    }
    if (noCli) {
      note.createDiv({ cls: "agent-manager-setup-title", text: "No agent CLI found" });
      note.createDiv({ text: "Install at least one in Terminal, and sign in to it there once. Click a command to copy it." });
      for (const key of REAL_BACKENDS) {
        note.createDiv({ cls: "agent-manager-setup-cli", text: CLI_BACKENDS[key].label });
        this.copyableCommand(note, CLI_BACKENDS[key].install);
      }
      note.createDiv({ cls: "agent-manager-setup-hint", text: "Installed somewhere unusual? Set its location in Settings → Agent Manager." });
    }
    const again = note.createEl("button", { text: "Check again" });
    again.addEventListener("click", () => {
      again.disabled = true;
      again.setText("Checking…");
      void this.plugin.checkSetup(true);
    });
    if (agentsMissing && !startGone) this.renderAgentsRow(note);
  }
  renderAgentsRow(this: Browser, note: HTMLElement): void {
    const folder = this.plugin.startFolder();
    const title = note.createDiv({ cls: "agent-manager-setup-title", text: "No AGENTS.md" });
    title.createSpan({ cls: "agent-manager-badge", text: "Experimental" });
    note.createDiv({ text: `Claude Code, Codex, and Antigravity read AGENTS.md for how to work in ${folder ? `“${folder}”` : "this vault"}. An agent can set one up with you, and more if you'd like: step by step, or on its own and reporting back. It asks before changing anything already here. An AI does the work, so results vary with the CLI and model.` });
    const buttons = note.createDiv({ cls: "agent-manager-setup-buttons" });
    const setup = buttons.createEl("button", { text: "Set up this vault", cls: "mod-cta" });
    setup.addEventListener("click", () => { void this.plugin.openVaultSetup(this); });
    const dismiss = buttons.createEl("button", { text: "Dismiss" });
    dismiss.addEventListener("click", () => { void (async () => {
      await this.plugin.dismissAgentsFile();
      this.renderBrowser();
    })(); });
  }
  renderAgentSwitch(this: Browser, wrap: HTMLElement): void {
    const agents = this.plugin.switchChoices();
    if (!agents.length) return;
    const current = { id: this.plugin.switchedAgentId() };
    const row = wrap.createDiv({ cls: "agent-manager-agent-switch" });
    if (agents.length === 1) {
      row.createSpan({ cls: "agent-manager-agent-single", text: agents[0].name });
      return;
    }
    if (agents.length === 2) {
      row.addClass("is-pills");
      row.setAttribute("role", "radiogroup");
      row.setAttribute("aria-label", "Agent profile");
      const at = Math.max(0, agents.findIndex((a) => a.id === current?.id));
      row.setCssProps({ "--agent-manager-switch-i": String(at) });
      row.createDiv({ cls: "agent-manager-agent-thumb" });
      const pills: HTMLElement[] = [];
      agents.forEach((a, i) => {
        const on = i === at;
        const pill = row.createEl("button", { cls: "agent-manager-agent-pill" + (on ? " is-active" : ""), text: a.name, attr: { role: "radio", "aria-checked": String(on) } });
        pills.push(pill);
        pill.addEventListener("click", () => {
          if (pill.hasClass("is-active")) return;
          row.setCssProps({ "--agent-manager-switch-i": String(i) });
          for (const p of pills) { p.toggleClass("is-active", p === pill); p.setAttribute("aria-checked", String(p === pill)); }
          const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
          window.setTimeout(() => { void this.plugin.setSwitchedAgent(a.id); }, reduce ? 0 : 200);
        });
      });
      return;
    }
    const select = row.createEl("select", { cls: "dropdown agent-manager-agent-select", attr: { "aria-label": "Agent profile" } });
    for (const a of agents) {
      const opt = select.createEl("option", { text: a.name, value: a.id });
      if (a.id === current?.id) opt.selected = true;
    }
    select.addEventListener("change", () => { void this.plugin.setSwitchedAgent(select.value); });
  }
  renderTodayRow(this: Browser, wrap: HTMLElement): void {
    if (this.plugin.pluginData.dailyChatButton === false) return;
    const name = this.plugin.dailyChatName();
    const row = wrap.createDiv({ cls: "agent-manager-today", attr: { role: "button", tabindex: "0", "data-day": this.plugin.todayString() } });
    const icon = row.createSpan({ cls: "agent-manager-today-icon" });
    import_obsidian.setIcon(icon, "sun");
    const col = row.createDiv({ cls: "agent-manager-today-text" });
    const profile = this.plugin.switchedAgent();
    col.createDiv({ cls: "agent-manager-today-title", text: profile ? `${profile.name} Daily Chat` : "Daily Chat" });
    col.createDiv({ cls: "agent-manager-today-name", text: new Date().toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) });
    row.setAttribute("aria-label", name);
    const go = () => { void this.plugin.openTodaysChat(this); };
    row.addEventListener("click", go);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    this.refreshTodayDot(row);
  }
  renderCustomButton(this: Browser, parent: HTMLElement): void {
    if (this.plugin.pluginData.customButton === false) return;
    const target = this.plugin.customButtonTarget();
    if (!target) return;
    const set = stringOf(this.plugin.pluginData.customButtonName ?? "").trim();
    const opens = "url" in target ? target.url : target.path;
    const name = set || (stringOf(this.plugin.pluginData.customButtonTarget ?? "").trim() ? opens.replace(/^.*\//, "").replace(/\.(md|base)$/, "") : "Tickets");
    const btn = parent.createEl("button", { cls: "agent-manager-head-button agent-manager-custom-button" });
    import_obsidian.setIcon(btn.createSpan({ cls: "agent-manager-head-button-icon" }), this.plugin.customButtonIcon());
    btn.createSpan({ cls: "agent-manager-head-button-name", text: name });
    btn.addEventListener("click", () => { void this.plugin.openCustomButton(); });
  }
  refreshTodayDot(this: Browser, row: Element | null = this.containerEl.querySelector(".agent-manager-today")): void {
    if (!row) return;
    const name = this.plugin.dailyChatName();
    const leaf = this.plugin.todaysChatLeaf();
    const v = leaf && this.plugin.sessionOf(leaf);
    const open = !!leaf && (!v || !!v.running);
    const key = `${this.plugin.switchedAgentId() || ""}\n${name}`;
    if (open) this._todayRan = key;
    row.classList.toggle("is-open", open);
    row.classList.toggle("has-run", !open && this._todayRan === key);
  }
  copyableCommand(parent: HTMLElement, command: string): void {
    const el = parent.createEl("code", { cls: "agent-manager-setup-cmd", text: command, attr: { "aria-label": "Click to copy" } });
    el.addEventListener("click", () => { void (async () => {
      try { await navigator.clipboard.writeText(command); notice("Copied."); } catch { notice("Couldn't copy."); }
    })(); });
  }
  renderBackendSelector(this: Browser, parentEl: HTMLElement): void {
    const backends = this.plugin.getBrowserBackends();
    if (this._launchBackend == null || !backends.includes(this._launchBackend)) {
      const current = this.plugin.getCurrentBackend();
      this._launchBackend = backends.includes(current) ? current : (backends[0] || null);
    }
    if (backends.length < 2) return;
    const select = parentEl.createEl("select", { cls: "dropdown agent-manager-backend-select" });
    for (const key of backends) {
      const opt = select.createEl("option", { text: CLI_BACKENDS[key].label, value: key });
      if (key === this._launchBackend) opt.selected = true;
    }
    select.addEventListener("change", () => {
      this._launchBackend = select.value as BackendKey;
    });
  }
  closeCard(this: Browser, kind: CardKind): void {
    const reveal = this.containerEl.querySelector<HTMLElement>(`.agent-manager-newcard-reveal[data-card="${kind}"]`);
    const closing = this._cardClosing || (this._cardClosing = {});
    const card = kind === "ticket" ? this.plugin.ticketCard : undefined;
    let done = false;
    let timer = 0;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      closing[kind] = false;
      if (kind === "ticket" && this.plugin.ticketCard !== card) { if (!this._closed) this.renderBrowser(); return; }
      this.setCardOpen(kind, false);
      if (!this._closed) this.renderBrowser();
    };
    if (!reveal || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) { finish(); return; }
    closing[kind] = true;
    reveal.removeClass("is-opening");
    reveal.addClass("is-closing");
    reveal.addEventListener("animationend", finish, { once: true });
    timer = window.setTimeout(finish, 400);
    this.register(() => window.clearTimeout(timer));
  }
  renderCardAgentSelector(this: Browser, parentEl: HTMLElement): void {
    const choices = this.plugin.switchChoices();
    if (choices.length < 2) return;
    const switched = this.plugin.switchedAgentId() ?? "";
    const pick = this._launchAgent;
    const current = pick && pick.switched === switched && choices.some((c) => c.id === pick.id) ? pick.id : switched;
    const select = parentEl.createEl("select", { cls: "dropdown agent-manager-card-agent-select", attr: { "aria-label": "Agent profile" } });
    for (const c of choices) {
      const opt = select.createEl("option", { text: c.name, value: c.id });
      if (c.id === current) opt.selected = true;
    }
    select.addEventListener("change", () => { this._launchAgent = { id: select.value, switched }; });
  }
  cardAgentId(this: Browser): string | undefined {
    const pick = this._launchAgent;
    if (!pick || !this.plugin.switchChoices().some((c) => c.id === pick.id)) return undefined;
    return pick.switched === (this.plugin.switchedAgentId() ?? "") ? pick.id : undefined;
  }
  renderNewSessionForm(this: Browser, wrap: HTMLElement): void {
    const form = wrap.createDiv({ cls: "agent-manager-newform agent-manager-newcard" });
    const input = form.createEl("input", { type: "text", cls: "agent-manager-name-input", attr: { placeholder: "Name this session (optional)" } });
    input.value = this._titleDraft || "";
    input.addEventListener("input", () => { this._titleDraft = input.value; });
    this.renderCardAgentSelector(form);
    const controls = form.createDiv({ cls: "agent-manager-newform-row agent-manager-newform-controls" });
    this.renderBackendSelector(controls);
    const start = controls.createEl("button", { text: "Start", cls: "agent-manager-start-btn mod-cta" });
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      this._titleDraft = "";
      const agentId = this.cardAgentId();
      this._launchAgent = undefined;
      void this.plugin.startSession(name, this, agentId !== undefined ? { agentId } : null);
    };
    start.addEventListener("click", go);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); go(); }
      else if (e.key === "Escape") { e.preventDefault(); input.value = ""; this._titleDraft = ""; input.blur(); }
    });
    if (this._focusCard === "session") input.dataset.autofocus = "true";
  }
  ticketCardState(this: Browser): TicketCard {
    return this.plugin.ticketCard || (this.plugin.ticketCard = { open: false, draft: { name: "", project: "", backend: null, notes: "" } });
  }
  renderNewTicketForm(this: Browser, wrap: HTMLElement): void {
    const card = this.ticketCardState();
    const draft = card.draft;
    const form = wrap.createDiv({ cls: "agent-manager-newform agent-manager-newcard agent-manager-ticketcard" });
    const from = card.from;
    if (from) form.createDiv({ cls: "agent-manager-ticketcard-from", text: `Attaches “${from.sessionTitle || "this session"}” to the new ticket` });
    const input = form.createEl("input", { type: "text", cls: "agent-manager-name-input", attr: { placeholder: "Name this ticket" } });
    input.value = draft.name;
    input.addEventListener("input", () => { draft.name = input.value; });
    const project = form.createEl("select", { cls: "dropdown agent-manager-ticket-select", attr: { "aria-label": "Project" } });
    const groups = this.plugin.creationProjectGroups();
    const picked = draft.project ? this.plugin.app.vault.getAbstractFileByPath(draft.project) : null;
    const listed = (v: string) => groups.some((g) => g.options.some((o) => o.value === v));
    if (from && picked instanceof import_obsidian.TFolder && !listed(picked.path)) groups.unshift({ label: null, options: [{ text: picked.path, value: picked.path }] });
    else if (!(picked instanceof import_obsidian.TFolder) || !listed(picked.path)) draft.project = "";
    const hasHome = this.plugin.agentList().some((a) => a.home);
    if (!hasHome) project.createEl("option", { text: "Choose a project", value: "" });
    else if (!draft.project) draft.project = this.plugin.creationProjectDefault(groups);
    fillProjectSelect(project, groups, draft.project);
    project.addEventListener("change", () => { draft.project = project.value; sayWhere(); });
    const notes = form.createEl("textarea", { cls: "agent-manager-ticket-notes", attr: { placeholder: "Notes (optional)", rows: "3" } });
    notes.value = draft.notes;
    notes.addEventListener("input", () => { draft.notes = notes.value; });
    const controls = form.createDiv({ cls: "agent-manager-newform-row agent-manager-newform-controls" });
    const backends = this.plugin.getBrowserBackends();
    const fallback = backends.includes(this.plugin.getCurrentBackend()) ? this.plugin.getCurrentBackend() : (backends[0] || null);
    if (!draft.backend || !backends.includes(draft.backend)) draft.backend = fallback;
    if (backends.length > 1) {
      const select = controls.createEl("select", { cls: "dropdown agent-manager-ticket-select", attr: { "aria-label": "CLI" } });
      for (const key of backends) {
        const opt = select.createEl("option", { text: CLI_BACKENDS[key].label, value: key });
        if (key === draft.backend) opt.selected = true;
      }
      select.addEventListener("change", () => { draft.backend = select.value as BackendKey; });
    }
    const where = form.createDiv({ cls: "agent-manager-taskcard-where agent-manager-ticketcard-where" });
    const sayWhere = () => {
      const folder = draft.project ? this.plugin.app.vault.getAbstractFileByPath(draft.project) : null;
      if (!(folder instanceof import_obsidian.TFolder)) { where.setText(""); return; }
      const agent = this.plugin.creationAgentName(folder.path);
      where.setText(`Saved in ${this.plugin.ticketsFolderFor(folder)}${agent ? ` · runs as ${agent}` : ""}`);
    };
    sayWhere();
    const launchOn = this.plugin.pluginData.ticketLaunchButton !== false;
    const create = controls.createEl("button", { text: "Create", cls: "agent-manager-start-btn" + (launchOn ? "" : " mod-cta") });
    const launch = launchOn ? controls.createEl("button", { text: "Launch", cls: "agent-manager-start-btn mod-cta" }) : null;
    let done = false;
    const go = (andLaunch = false) => {
      if (done) return;
      const folder = draft.project ? this.plugin.app.vault.getAbstractFileByPath(draft.project) : null;
      if (!ticketFileName(draft.name)) { notice("Name the ticket."); input.focus(); return; }
      if (!(folder instanceof import_obsidian.TFolder)) { notice("Choose a project for the ticket."); project.focus(); return; }
      done = true;
      const kept = { ...draft };
      const opts = { name: draft.name, backend: draft.backend, notes: draft.notes };
      const fresh: TicketCard = { open: true, draft: { name: "", project: "", backend: null, notes: "" } };
      this.plugin.ticketCard = fresh;
      this.closeCard("ticket");
      void (async () => {
        const file = await this.plugin.newTicket(folder, opts);
        if (!file) {
          if (this.plugin.ticketCard !== fresh) return;
          this.plugin.ticketCard = { open: true, draft: kept, from };
          if (!this._closed) this.renderBrowser();
          return;
        }
        if ((andLaunch || (from && from.containerEl.isConnected)) && !(await this.plugin.whenIndexed(file))) {
          notice(`Made “${file.basename}”, but it didn't read as a ticket in time (does the ticket template have type: ticket in its properties?), so ${andLaunch ? "nothing was launched" : "the session wasn't attached"}.`);
          return;
        }
        if (from && from.containerEl.isConnected) await from.attachToTicket(file.path);
        else if (from) notice(`Made “${file.basename}”. “${from.sessionTitle || "The session"}” was closed, so it wasn't attached.`);
        if (andLaunch) await this.plugin.startSession(file.basename, null, { notePath: file.path, ...(opts.backend ? { backendOverride: opts.backend } : {}) });
      })();
    };
    create.addEventListener("click", () => go());
    launch?.addEventListener("click", () => go(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); go(launchOn); }
      else if (e.key === "Escape") { e.preventDefault(); input.blur(); }
    });
    notes.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); go(launchOn); }
      else if (e.key === "Escape") { e.preventDefault(); notes.blur(); }
    });
    if (this._focusCard === "ticket") input.dataset.autofocus = "true";
  }
  beginRender(this: Browser): number {
    this._renderIsBackground = !!this._nextRenderIsBackground;
    this._nextRenderIsBackground = false;
    this._renderGen = (this._renderGen || 0) + 1;
    return this._renderGen;
  }
  swapBrowserContent(this: Browser, wrap: HTMLElement, gen: number): void {
    if (this._closed) return;
    if (gen !== this._renderGen) return;
    const container = this.containerEl;
    const focused = container.ownerDocument.activeElement;
    const typing = focused && container.contains(focused) && focused.matches(".agent-manager-name-input, .agent-manager-search-input, .agent-manager-ticket-notes, .agent-manager-ticket-select, .agent-manager-task-prompt") ? focused : null;
    if (this._renderIsBackground && typing) {
      typing.addEventListener("blur", () => window.setTimeout(() => {
        if (!this._closed) this.renderBrowser({ background: true });
      }, 0), { once: true });
      return;
    }
    container.empty();
    container.addClass("agent-manager-browser");
    container.appendChild(wrap);
  }
  clearDropMarks(this: Browser): void {
    this.containerEl.querySelectorAll(".drop-before, .drop-after, .drop-into")
      .forEach((el) => el.classList.remove("drop-before", "drop-after", "drop-into"));
  }
  async renderSessionSections(this: Browser, parentEl: HTMLElement): Promise<void> {
    let pinned: SessionRecord[] = [], sessions: SessionRecord[] = [];
    try { pinned = await this.plugin.readPinnedSessions(); } catch { /* empty */ }
    try { sessions = await this.plugin.listedSessions(); } catch { /* empty */ }
    const shows = (s: SessionRecord) => this.plugin.agentShows(this.plugin.agentOfSession(s));
    pinned = pinned.filter(shows);
    sessions = sessions.filter(shows);
    const today = this.plugin.dailyChatName();
    if (sessions.some((s) => s.displayName === today) || pinned.some((s) => (s.displayName || s.title) === today)) this._todayRan = `${this.plugin.switchedAgentId() || ""}\n${today}`;
    const todayRow = parentEl.querySelector(".agent-manager-today");
    if (todayRow) this.refreshTodayDot(todayRow);
    const openKeys = this.plugin.getOpenSessionKeys();
    const pinnedKeys = new Set(pinned.flatMap((s) => this.plugin.sessionRowKeys(s.backend, s.title, s.sessionId)));
    const seenOpen = new Set<string>();
    const open: { s: SessionRecord; at: number }[] = [];
    for (const o of this.plugin.getOpenSessions()) {
      const k = this.plugin.openSessionKey(o);
      if (pinnedKeys.has(k) || seenOpen.has(k)) continue;
      if (o.leaf && !this.plugin.agentShows(this.plugin.agentOfLeaf(o.leaf))) continue;
      seenOpen.add(k);
      const record = o.sessionId ? sessions.find((r) => r.backend === o.backendKey && r.sessionId === o.sessionId) : null;
      const rec = record || this.plugin.openSessionRecord(o);
      open.push({ s: rec, at: this.plugin.lastActivity(rec.backend, rec.file, rec.mtime) });
    }
    open.sort((a, b) => b.at - a.at);
    const shown = new Set([...pinnedKeys, ...open.flatMap((e) => this.plugin.sessionRowKeys(e.s.backend, e.s.title, e.s.sessionId))]);
    const rest = sessions.filter((s) => !this.plugin.sessionRowKeys(s.backend, s.title, s.sessionId).some((k) => shown.has(k)));
    const rowOpts: RowOptions = { draggable: true, showDate: true };

    parentEl.createDiv({ text: "Pinned", cls: "agent-manager-sublabel" });
    const pinList = parentEl.createDiv({ cls: "agent-manager-list agent-manager-session-list agent-manager-pinned-list" });
    this.attachSessionOrderDrop(pinList, (id, before) => this.plugin.reorderPinnedSession(id, before));
    if (pinned.length) for (const s of pinned) this.renderSessionRow(pinList, s, openKeys, { ...rowOpts, pinned: true });
    else pinList.createDiv({ cls: "agent-manager-empty", text: "Right-click a session and choose Pin, or drag it here, to keep it here." });

    parentEl.createDiv({ text: "Recent", cls: "agent-manager-sublabel agent-manager-sessions-head" });
    if (!open.length && !rest.length) {
      const empty = parentEl.createDiv({ cls: "agent-manager-recent" });
      this.attachSessionUnpinDrop(empty);
      empty.createEl("p", { text: pinned.length ? "No other sessions." : "No sessions yet.", cls: "agent-manager-empty" });
      return;
    }
    const searchBox = parentEl.createDiv({ cls: "search-input-container agent-manager-search" });
    const search = searchBox.createEl("input", { type: "search", cls: "agent-manager-search-input", attr: { placeholder: "Search sessions", spellcheck: "false" } });
    const clear = searchBox.createDiv({ cls: "search-input-clear-button" });
    clear.addEventListener("click", () => { search.value = ""; apply(); search.focus(); });
    const recent = parentEl.createDiv({ cls: "agent-manager-recent" });
    this.attachSessionUnpinDrop(recent);
    const openList = recent.createDiv({ cls: "agent-manager-list agent-manager-session-list agent-manager-recent-open" });
    const restList = recent.createDiv({ cls: "agent-manager-list agent-manager-session-list agent-manager-recent-rest" });
    const add = (list: HTMLElement, s: SessionRecord): HTMLElement | null => {
      const before = list.childElementCount;
      this.renderSessionRow(list, s, openKeys, rowOpts);
      if (list.childElementCount === before) return null;
      const row = list.lastElementChild as HTMLElement;
      row.dataset.search = (s.displayName || "Untitled").toLowerCase();
      return row;
    };
    const openRows = open.map((e) => add(openList, e.s)).filter(Boolean) as HTMLElement[];
    const restRows = rest.map((s) => add(restList, s)).filter(Boolean) as HTMLElement[];
    const PAGE = 20;
    if (!(this._recentShown >= PAGE)) this._recentShown = PAGE;
    const more = parentEl.createDiv({ cls: "agent-manager-row agent-manager-more-row" });
    const moreText = more.createSpan({ cls: "agent-manager-row-name" });
    more.addEventListener("click", () => { this._recentShown += PAGE; apply(); });
    const noMatch = parentEl.createDiv({ cls: "agent-manager-empty", text: "No session names match." });
    const apply = () => {
      const q = search.value.trim().toLowerCase();
      this._sessionSearch = search.value;
      let matched = 0;
      for (const row of openRows) {
        const hit = !q || (row.dataset.search as string).includes(q);
        if (hit) matched++;
        row.toggle(hit);
      }
      let listed = 0, hidden = 0;
      for (const row of restRows) {
        const hit = !q || (row.dataset.search as string).includes(q);
        const capped = hit && !q && listed >= this._recentShown;
        if (hit) { matched++; if (!capped) listed++; }
        if (capped) hidden++;
        row.toggle(hit && !capped);
      }
      openList.toggleClass("has-rows-below", listed !== 0);
      moreText.setText(`Show ${Math.min(PAGE, hidden)} more`);
      more.toggle(hidden !== 0);
      noMatch.toggle(matched === 0 && !!q);
      clear.toggle(!!search.value);
    };
    search.value = this._sessionSearch || "";
    search.addEventListener("input", apply);
    search.addEventListener("keydown", (e) => { if (e.key === "Escape" && search.value) { e.preventDefault(); search.value = ""; apply(); } });
    apply();
  }
  renderSessionRow(this: Browser, list: HTMLElement, s: SessionRecord, openKeys: Set<string>, opts: RowOptions = {}): void {
    const row = list.createDiv({ cls: "agent-manager-row agent-manager-session-row" });
    row.dataset.sessionTitle = s.title;
    row.dataset.sessionBackend = s.backend;
    row.dataset.sessionId = s.sessionId || "";
    row.dataset.sessionFile = s.file || "";
    row.dataset.sessionMtime = String(s.mtime || Date.now());
    if (this._renamingId && s.sessionId && this._renamingId === s.sessionId) {
      this.renderRenameInput(row, s);
      return;
    }
    const rowKeys = this.plugin.sessionRowKeys(s.backend, s.title, s.sessionId);
    const isOpen = rowKeys.some((k) => openKeys.has(k));
    row.classList.toggle("is-active", (rowKeys as (string | null)[]).includes(this.plugin.getActiveSessionKey()));
    const canDrag = opts.draggable && !!s.sessionId;
    const body = row.createDiv({ cls: "agent-manager-row-body" });
    body.createSpan({ cls: "agent-manager-status-dot" + (isOpen ? " is-open" : "") });
    const col = body.createDiv({ cls: "agent-manager-row-col" });
    const name = col.createDiv({ cls: "agent-manager-row-name" });
    name.createSpan({ text: s.displayName || "Untitled", cls: "agent-manager-row-subject" + (s.displayName ? "" : " agent-manager-row-untitled") });
    const meta = col.createDiv({ cls: "agent-manager-row-meta-line" });
    this.appendBackendBadge(meta, s.backend);
    if (opts.showDate) {
      meta.createSpan({ text: "·", cls: "agent-manager-row-sep" });
      meta.createSpan({ text: this.plugin.shortDate(s.mtime), cls: "agent-manager-row-date" });
    }
    if (opts.pinned) import_obsidian.setIcon(body.createSpan({ cls: "agent-manager-row-pin", attr: { "aria-hidden": "true" } }), "pin");
    row.addEventListener("click", () => {
      if (row.dataset.dragging) return;
      const leaf = this.plugin.getLeafForSession(s.title, s.backend, s.sessionId);
      if (leaf) void this.plugin.revealAndFlash(leaf);
      else void this.plugin.startResume(s, this);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showRenameMenu(e, s);
    });
    if (canDrag) {
      row.dataset.dragId = s.sessionId as string;
      row.draggable = true;
      row.addEventListener("dragstart", (e) => this.onSessionDragStart(e, row, s.sessionId as string));
      row.addEventListener("dragend", () => this.onSessionDragEnd(row));
    }
  }
  onSessionDragStart(this: Browser, e: DragEvent, row: HTMLElement, id: string): void {
    this._sessionDragId = id;
    row.dataset.dragging = "1";
    row.addClass("is-dragging");
    try { (e.dataTransfer as DataTransfer).effectAllowed = "move"; (e.dataTransfer as DataTransfer).setData("text/plain", id); } catch { /* empty */ }
  }
  onSessionDragEnd(this: Browser, row: HTMLElement): void {
    delete row.dataset.dragging;
    row.removeClass("is-dragging");
    this.clearDropMarks();
    this._sessionDragId = null;
  }
  attachSessionOrderDrop(this: Browser, listEl: HTMLElement, place: (id: string, before: string | null | undefined) => Promise<void>): void {
    listEl.addEventListener("dragover", (e) => {
      if (!this._sessionDragId) return;
      e.preventDefault();
      try { (e.dataTransfer as DataTransfer).dropEffect = "move"; } catch { /* empty */ }
      const rows = Array.from(listEl.querySelectorAll<HTMLElement>(".agent-manager-session-row:not(.is-dragging)"));
      let beforeId: string | null | undefined = null, markRow: HTMLElement | null = null, markAfter = false;
      for (const r of rows) {
        const rect = r.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) { beforeId = r.dataset.dragId; markRow = r; break; }
      }
      if (!markRow && rows.length) { markRow = rows[rows.length - 1]; markAfter = true; }
      this.clearDropMarks();
      if (markRow) markRow.addClass(markAfter ? "drop-after" : "drop-before");
      else listEl.addClass("drop-into");
      this._sessionDropBeforeId = beforeId;
    });
    listEl.addEventListener("drop", (e) => { void (async () => {
      if (!this._sessionDragId) return;
      e.preventDefault();
      const draggedId = this._sessionDragId;
      const beforeId = this._sessionDropBeforeId;
      this.clearDropMarks();
      await place(draggedId, beforeId);
      this.renderBrowser();
    })(); });
  }
  attachSessionUnpinDrop(this: Browser, listEl: HTMLElement): void {
    const pinned = (id: string | null | undefined) => id && this.plugin.isPinned(id);
    listEl.addEventListener("dragover", (e) => {
      if (!pinned(this._sessionDragId)) return;
      e.preventDefault();
      try { (e.dataTransfer as DataTransfer).dropEffect = "move"; } catch { /* empty */ }
      this.clearDropMarks();
      listEl.addClass("drop-into");
    });
    listEl.addEventListener("drop", (e) => { void (async () => {
      if (!pinned(this._sessionDragId)) return;
      e.preventDefault();
      const id = this._sessionDragId;
      this.clearDropMarks();
      await this.plugin.togglePin(id);
      this.renderBrowser();
    })(); });
  }
  showRenameMenu(this: Browser, evt: MouseEvent, session: SessionRecord): void {
    const menu = new import_obsidian.Menu();
    const leaf = this.plugin.getLeafForSession(session.title, session.backend, session.sessionId);
    if (session.sessionId) {
      const pinned = this.plugin.isPinned(session.sessionId);
      menu.addItem((item) =>
        item.setTitle(pinned ? "Unpin session" : "Pin session").setIcon(pinned ? "pin-off" : "pin").onClick(async () => {
          await this.plugin.togglePin(session.sessionId);
          this.renderBrowser();
        })
      );
      menu.addItem((item) =>
        item.setTitle("Rename session").setIcon("pencil").onClick(() => {
          this._renamingId = session.sessionId;
          this.renderBrowser();
        })
      );
      menu.addItem((item) =>
        item.setTitle("Copy resume link").setIcon("link").onClick(async () => {
          const label = String(session.displayName || "Resume").replace(/\s+/g, " ").replace(/\[/g, "(").replace(/\]/g, ")");
          const url = `[${label}](${this.plugin.buildResumeLink(session as { sessionId: string })})`;
          try {
            await navigator.clipboard.writeText(url);
            notice("Resume link copied.");
          } catch {
            notice("Couldn't copy the resume link.");
          }
        })
      );
    }
    this.addMoveToAgent(menu, session.sessionId, session.backend, () => this.renderBrowser());
    if (leaf) {
      menu.addItem((item) =>
        item.setTitle("Reveal open tab").setIcon("arrow-right").onClick(() => {
          void this.plugin.revealAndFlash(leaf);
        })
      );
      menu.addItem((item) =>
        item.setTitle("Close session").setIcon("x").onClick(() => {
          leaf.detach();
          this.renderBrowser();
        })
      );
    }
    if (session.file && !leaf) {
      menu.addItem((item) =>
        item.setTitle("Delete session").setIcon("trash").setWarning(true).onClick(() => {
          new ConfirmModal(
            this.app,
            "Delete session?",
            session.backend === "antigravity"
              ? `“${session.displayName || "Untitled"}” and its whole Antigravity conversation will be permanently deleted (it disappears from agy’s own /resume too). This can’t be undone.`
              : `“${session.displayName || "Untitled"}” and its transcript will be permanently deleted. This can’t be undone.`,
            () => { void this.deleteSession(session); }
          ).open();
        })
      );
    }
    menu.showAtMouseEvent(evt);
  }
  async deleteSession(this: Browser, session: SessionRecord): Promise<void> {
    if (!session.file) return;
    if (this.plugin.getLeafForSession(session.title, session.backend, session.sessionId)) {
      notice("Close the session's tab before deleting it.");
      return;
    }
    try {
      if (session.backend === "antigravity") {
        const brainDir = antigravityBrainDir(session.file);
        if (!brainDir) throw new Error(`not an Antigravity conversation folder: ${session.file}`);
        fs.rmSync(brainDir, { recursive: true, force: true });
      } else fs.unlinkSync(session.file);
    } catch (e) {
      console.error("[Agent Manager] Delete failed:", e);
      notice("Couldn't delete the session.");
      return;
    }
    const id = session.sessionId;
    const named = id && this.plugin.pluginData.sessionNames?.[id] != null;
    if (named) delete (this.plugin.pluginData.sessionNames as Record<string, string>)[id];
    if (id) { delete this.plugin.pluginData.sessionAgents?.[id]; delete this.plugin.pluginData.sessionLaunchAgents?.[id]; delete this.plugin.pluginData.sessionSources?.[id]; delete this.plugin.pluginData.sideChats?.[id]; }
    if (session.backend === "antigravity") this.plugin.forgetAntigravitySession(id as string);
    await this.plugin.savePluginData();
    if (session.sessionId && this.plugin.isPinned(session.sessionId)) {
      await this.plugin.togglePin(session.sessionId);
    }
    this.plugin.invalidateSessionIndex();
    this.renderBrowser();
  }
  renderRenameInput(this: Browser, row: HTMLElement, session: SessionRecord): void {
    row.addClass("agent-manager-newform");
    const subject = session.displayName;
    const input = row.createEl("input", { type: "text", cls: "agent-manager-name-input", attr: { placeholder: "Session name" } });
    input.value = subject;
    let done = false;
    const cancel = () => {
      if (done) return;
      done = true;
      this._renamingId = null;
      this.renderBrowser();
    };
    const commit = () => {
      if (done) return;
      done = true;
      this._renamingId = null;
      void this.doRename(session, input.value);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", cancel);
    window.setTimeout(() => { input.focus(); input.select(); }, 0);
  }
  async doRename(this: Browser, session: SessionRecord, rawName: string): Promise<void> {
    await this.applyRename(session, rawName);
    this.renderBrowser();
  }
}
export { BrowserMethods };
