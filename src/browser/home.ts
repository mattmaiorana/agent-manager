// The sidebar: the home page (the header and its custom button, the agent switch, Today's
// chat, the New session and New ticket rows and their cards, the setup note, Pinned, and Recent), session rows and their actions, and dragging rows
// between the two sections.

import { fs, import_obsidian } from "../externals.js";
import { CLI_BACKENDS, REAL_BACKENDS } from "../constants/backends.js";
import { antigravityBrainDir } from "../sessions/transcript-files.js";
import { ConfirmModal } from "../ui/modals.js";
import { stringOf } from "../util/guards.js";
import { ticketFileName } from "../tickets/new-ticket.js";
import type { BackendKey } from "../constants/backends.js";
import type { SessionRecord, TicketCard } from "../types.js";
import type { Browser, CardKind } from "./view.js";

// How long a card takes to open; the CSS animation's length.
const REVEAL_MS = 200;

// What a session row is drawn with (renderSessionRow).
interface RowOptions {
  draggable?: boolean;
  showDate?: boolean;
  // In Pinned sessions: a faint pin at the row's right.
  pinned?: boolean;
}
class BrowserMethods {
  // The sidebar has one page, home. `browserScope` stays null on it.
  renderBrowser(this: Browser, opts: { background?: boolean } | null = null): void {
    // A background render is one no click in this browser asked for.
    this._nextRenderIsBackground = !!(opts && opts.background);
    void this.renderHome();
  }
  async reresolveScope(): Promise<void> {}
  goHome(this: Browser): void {
    this.browserScope = null;
    this.renderBrowser();
  }
  // Update the dots in place, without rebuilding rows: safe to run on focus (a rebuild
  // there would swallow the click that focused the pane).
  refreshStatusDots(this: Browser): void {
    this.refreshTodayDot();
    const openKeys = this.plugin.getOpenSessionKeys();
    const activeKey = this.plugin.getActiveSessionKey();
    const c = this.containerEl;
    // Session rows: green only if that exact session is open, and the "time ago" is
    // refreshed in place from the transcript's current mtime. Each is a div that
    // renderSessionRow made and gave every one of its data fields.
    c.querySelectorAll<HTMLElement>(".agent-manager-row[data-session-title]").forEach((row) => {
      const keys = this.plugin.sessionRowKeys(row.dataset.sessionBackend as string, row.dataset.sessionTitle as string, row.dataset.sessionId || null);
      const rowOpen = keys.some((k) => openKeys.has(k));
      row.querySelector(".agent-manager-status-dot")?.classList.toggle("is-open", rowOpen);
      row.classList.toggle("is-active", !!activeKey && keys.includes(activeKey));
      const dateEl = row.querySelector(".agent-manager-row-date");
      if (dateEl) {
        let mtime = Number(row.dataset.sessionMtime) || 0;
        const file = row.dataset.sessionFile;
        // Only rows on show: Recent builds a row for every session and hides all but a
        // page, and a stat per hidden row on every tab switch adds up.
        if (file && row.style.display !== "none") {
          try { mtime = fs.statSync(file).mtimeMs; row.dataset.sessionMtime = String(mtime); } catch { /* best effort */ }
        }
        dateEl.setText(this.plugin.shortDate(mtime));
      }
    });
  }
  // Re-sort Recent's open rows in place as sessions work: most recently active first
  // (lastActivity, from each transcript as it is now). Moves the existing rows rather
  // than re-rendering, and holds off during a drag or a rename.
  resortOpenRows(this: Browser): void {
    if (this._sessionDragId || this._renamingId) return;
    const list = this.containerEl.querySelector(".agent-manager-recent-open");
    if (!list) return;
    // Its rows are divs that renderSessionRow made and gave every one of its data fields.
    const rows = (Array.from(list.children) as HTMLElement[]).filter((r) => r.classList.contains("agent-manager-session-row"));
    if (rows.length < 2) return;
    const at = new Map<HTMLElement, number>();
    for (const row of rows) {
      let mtime = Number(row.dataset.sessionMtime) || 0;
      const file = row.dataset.sessionFile;
      if (file) {
        try { mtime = fs.statSync(file).mtimeMs; row.dataset.sessionMtime = String(mtime); } catch { /* best effort */ }
      }
      at.set(row, this.plugin.lastActivity(row.dataset.sessionBackend as string, file, mtime));
    }
    // Every row has its time, set just above.
    const sorted = rows.slice().sort((a, b) => (at.get(b) as number) - (at.get(a) as number));
    if (sorted.every((r, i) => r === rows[i])) return;
    for (const row of sorted) list.appendChild(row);
  }
  // Home: the title, the New session card, a setup note when a CLI or Python is
  // missing, then Pinned and Recent. Built into a detached wrap and swapped in at the
  // end, so the reads never leave the sidebar blank.
  async renderHome(this: Browser): Promise<void> {
    const gen = this.beginRender();
    const wrap = createDiv({ cls: "agent-manager-browser-inner agent-manager-home" });
    const head = wrap.createDiv({ cls: "agent-manager-home-head" });
    head.createDiv({ cls: "agent-manager-home-title", text: "Agent Manager" });
    // The header's right side: the custom button, while it's on.
    this.renderCustomButton(head.createDiv({ cls: "agent-manager-head-buttons" }));
    this.renderAgentSwitch(wrap);
    this.renderTodayRow(wrap);
    // Under Daily Chat, the rows that open a card under themselves.
    const reveals: HTMLElement[] = [];
    const sessionOn = this.plugin.pluginData.newButton !== false;
    // New ticket, while tickets are on and it's shown, or a session's menu opened its card.
    const ticketOn = this.plugin.ticketsOn() && (this.plugin.pluginData.newTicketButton !== false || !!this.plugin.ticketCard?.from);
    // Both shown, they share one line (a trial), their cards opening full width below it.
    const pair = sessionOn && ticketOn ? wrap.createDiv({ cls: "agent-manager-card-rows" }) : wrap;
    if (sessionOn) this.renderCardRow(wrap, "session", reveals, pair);
    if (ticketOn) this.renderCardRow(wrap, "ticket", reveals, pair);
    this.renderSetupNote(wrap);
    // Let the header paint before the transcript scan, which is synchronous disk I/O.
    await new Promise((r) => window.setTimeout(r, 0));
    await this.renderSessionSections(wrap);
    this.swapBrowserContent(wrap, gen);
    if (!wrap.isConnected) return;
    // A card a click just opened takes the focus, now that it's in the document. The flag
    // holds until a render lands, as the reveal's does.
    const autofocus = wrap.querySelector<HTMLElement>("[data-autofocus]");
    if (autofocus) { this._focusCard = undefined; autofocus.focus(); }
    // A card a click opened starts growing now that it's on screen; one still growing
    // carries on from the same point, through a negative delay.
    const revealCard = this._revealCard || (this._revealCard = {});
    const revealAt = this._revealAt || (this._revealAt = {});
    for (const reveal of reveals) {
      const kind = reveal.dataset.card as CardKind;
      if (revealCard[kind]) { revealCard[kind] = false; revealAt[kind] = Date.now(); }
      else if (reveal.hasClass("is-opening")) reveal.setCssProps({ "--agent-manager-reveal-delay": `-${Date.now() - (revealAt[kind] as number)}ms` });
    }
  }
  // Whether a card is open. Each starts closed each time Obsidian opens, and stays as
  // left while it runs.
  isCardOpen(this: Browser, kind: CardKind): boolean {
    return kind === "session" ? this.plugin.newCardOpen === true : this.plugin.ticketCard?.open === true;
  }
  // Closing the New ticket card keeps what was typed in it, but not the session it was
  // opened from.
  setCardOpen(this: Browser, kind: CardKind, open: boolean): void {
    if (kind === "session") { this.plugin.newCardOpen = open; return; }
    const card = this.ticketCardState();
    card.open = open;
    if (!open) card.from = undefined;
  }
  // A row that opens a card under itself (New session, New ticket): its icon and name, and while
  // the card is open, the card's color. The card grows down when a click opened it; the
  // flag holds until a render reaches the screen (renderHome), since one the click
  // started can be dropped for a later one. A render that lands while it's folding up
  // draws it closed.
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
  // What to install before a session can start: Python 3, or any agent CLI at all.
  // Shown only once the setup check has found something missing.
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
    // No offer to create AGENTS.md in a folder that's gone.
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
  // The AGENTS.md row: the starting folder has none, so offer to set the vault up with an
  // agent (plugin/guides.ts), or dismiss. The same button stays in settings and the
  // command palette once this is gone.
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
  // The agent switch, once there's an agent: who new sessions and Daily Chat start as,
  // and whose sessions Pinned and Recent show. Its choices are the agents, and No agent
  // when that's the Default agent (switchChoices). Two choices are a pair of pills, more a
  // dropdown, and one is just its name.
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
      // A purple thumb under the two slides to the one clicked, then the lists redraw.
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
  // Today's chat: one row that goes to the day's chat, resumes it, or starts it. Hidden
  // when the Daily Chat button is off in settings.
  renderTodayRow(this: Browser, wrap: HTMLElement): void {
    if (this.plugin.pluginData.dailyChatButton === false) return;
    const name = this.plugin.dailyChatName();
    const row = wrap.createDiv({ cls: "agent-manager-today", attr: { role: "button", tabindex: "0", "data-day": this.plugin.todayString() } });
    const icon = row.createSpan({ cls: "agent-manager-today-icon" });
    import_obsidian.setIcon(icon, "sun");
    const col = row.createDiv({ cls: "agent-manager-today-text" });
    // Named for the switched profile, so the switch shows whose chat it opens.
    const profile = this.plugin.switchedAgent();
    col.createDiv({ cls: "agent-manager-today-title", text: profile ? `${profile.name} Daily Chat` : "Daily Chat" });
    // The day, written out, rather than the session's name.
    col.createDiv({ cls: "agent-manager-today-name", text: new Date().toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) });
    row.setAttribute("aria-label", name);
    const go = () => { void this.plugin.openTodaysChat(this); };
    row.addEventListener("click", go);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    this.refreshTodayDot(row);
  }
  // The custom button, at the header's right while it's on and has something to open:
  // its icon and text, and a click opens its note or link. With no text set, it says
  // Tickets while it opens the tickets note, else what it opens.
  renderCustomButton(this: Browser, parent: HTMLElement): void {
    if (this.plugin.pluginData.customButton === false) return;
    const target = this.plugin.customButtonTarget();
    if (!target) return;
    const set = stringOf(this.plugin.pluginData.customButtonName ?? "").trim();
    const opens = "url" in target ? target.url : target.path;
    const name = set || (stringOf(this.plugin.pluginData.customButtonTarget ?? "").trim() ? opens.replace(/^.*\//, "").replace(/\.(md|base)$/, "") : "Tickets");
    // No aria-label: Obsidian shows one as a tooltip, which would repeat the text.
    const btn = parent.createEl("button", { cls: "agent-manager-head-button agent-manager-custom-button" });
    import_obsidian.setIcon(btn.createSpan({ cls: "agent-manager-head-button-icon" }), this.plugin.customButtonIcon());
    btn.createSpan({ cls: "agent-manager-head-button-name", text: name });
    btn.addEventListener("click", () => { void this.plugin.openCustomButton(); });
  }
  // The row's sun: grey until today's chat has run, yellow once it has and is closed, and
  // green while it has a tab (one Obsidian hasn't loaded yet after a reload included).
  // "Has run" is remembered by the day's name, so it resets when the day changes. Found in
  // the container, not kept: a render that loses the race to a later one leaves its rows
  // detached.
  refreshTodayDot(this: Browser, row: Element | null = this.containerEl.querySelector(".agent-manager-today")): void {
    if (!row) return;
    const name = this.plugin.dailyChatName();
    const leaf = this.plugin.todaysChatLeaf();
    const v = leaf && this.plugin.sessionOf(leaf);
    const open = !!leaf && (!v || !!v.running);
    // Keyed by the agent too, so two agents with one template don't share it.
    const key = `${this.plugin.switchedAgentId() || ""}\n${name}`;
    if (open) this._todayRan = key;
    row.classList.toggle("is-open", open);
    row.classList.toggle("has-run", !open && this._todayRan === key);
  }
  // A shell command shown as code; a click copies it.
  copyableCommand(parent: HTMLElement, command: string): void {
    const el = parent.createEl("code", { cls: "agent-manager-setup-cmd", text: command, attr: { "aria-label": "Click to copy" } });
    el.addEventListener("click", () => { void (async () => {
      try { await navigator.clipboard.writeText(command); new import_obsidian.Notice("Copied."); } catch { new import_obsidian.Notice("Couldn't copy."); }
    })(); });
  }
  // Backend switcher: a dropdown of the backends enabled for the sidebar. It only sets
  // which CLI a new session launches as. The choice belongs to this sidebar and does
  // not change the default.
  renderBackendSelector(this: Browser, parentEl: HTMLElement): void {
    const backends = this.plugin.getBrowserBackends();
    if (this._launchBackend == null || !backends.includes(this._launchBackend)) {
      const current = this.plugin.getCurrentBackend();
      this._launchBackend = backends.includes(current) ? current : (backends[0] || null);
    }
    // With one backend offered, there's nothing to pick, and that one is used.
    if (backends.length < 2) return;
    const select = parentEl.createEl("select", { cls: "dropdown agent-manager-backend-select" });
    for (const key of backends) {
      const opt = select.createEl("option", { text: CLI_BACKENDS[key].label, value: key });
      if (key === this._launchBackend) opt.selected = true;
    }
    select.addEventListener("change", () => {
      // Its options are the offered backends' keys.
      this._launchBackend = select.value as BackendKey;
    });
  }
  // Close a card: it folds up, then the sidebar redraws without it. With no card on
  // show, or the animation off, it closes at once.
  closeCard(this: Browser, kind: CardKind): void {
    const reveal = this.containerEl.querySelector<HTMLElement>(`.agent-manager-newcard-reveal[data-card="${kind}"]`);
    const closing = this._cardClosing || (this._cardClosing = {});
    // The ticket card closing now; a session's menu can put a new one in its place before
    // this finishes, and that one stays open.
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
    // In case the animation never runs (a hidden sidebar, say). Cleared when the view closes.
    timer = window.setTimeout(finish, 400);
    this.register(() => window.clearTimeout(timer));
  }
  // The card's agent profile dropdown, while the switch offers more than one: it starts on
  // the switch's choice, and follows the switch until one is picked here. A pick holds only
  // while the switch stays where it was when it was made.
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
  // The agent profile a session from the card starts as: the card's pick, else the
  // switch's (undefined leaves it to startSession, which reads the switch).
  cardAgentId(this: Browser): string | undefined {
    const pick = this._launchAgent;
    if (!pick || !this.plugin.switchChoices().some((c) => c.id === pick.id)) return undefined;
    return pick.switched === (this.plugin.switchedAgentId() ?? "") ? pick.id : undefined;
  }
  // The New session card: a name (optional), the agent profile (while there's a choice),
  // then the CLI with Start beside it. A session starts in the starting folder; reading a
  // particular note or folder first is the file menu's.
  renderNewSessionForm(this: Browser, wrap: HTMLElement): void {
    const form = wrap.createDiv({ cls: "agent-manager-newform agent-manager-newcard" });
    const input = form.createEl("input", { type: "text", cls: "agent-manager-name-input", attr: { placeholder: "Name this session (optional)" } });
    // A render can land mid-typing (a session opened elsewhere), so the draft is kept.
    input.value = this._titleDraft || "";
    input.addEventListener("input", () => { this._titleDraft = input.value; });
    // The agent profile while there's a choice (profiles on, more than one offered), then
    // the CLI beside Start, as the New ticket card has it beside its buttons.
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
  // The New ticket card's state, made empty the first time it's asked for.
  ticketCardState(this: Browser): TicketCard {
    return this.plugin.ticketCard || (this.plugin.ticketCard = { open: false, draft: { name: "", project: "", backend: null, notes: "" } });
  }
  // The New ticket card: a name (always), the project (always picked, never guessed,
  // except from a session's menu, which fills in the session's), notes, and the CLI (the
  // default to start) beside Create, which makes the ticket and opens it, and Launch
  // (while it's on), which also starts the ticket's main session on the CLI picked. What's typed is kept as it's typed, since a
  // render can land mid-typing. Opened from a session's menu, it says which session
  // Create attaches to the ticket.
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
    project.createEl("option", { text: "Choose a project", value: "" });
    const projects = this.plugin.ticketProjects();
    // A session's project outside the switched profile's home is still offered; any other
    // pick the list no longer has (the switch moved, the folder went) is dropped.
    const picked = draft.project ? this.plugin.app.vault.getAbstractFileByPath(draft.project) : null;
    if (picked instanceof import_obsidian.TFolder && !projects.includes(picked)) {
      if (from) projects.unshift(picked); else draft.project = "";
    } else if (!(picked instanceof import_obsidian.TFolder)) draft.project = "";
    for (const f of projects) {
      const opt = project.createEl("option", { text: this.plugin.ticketProjectLabel(f), value: f.path });
      if (f.path === draft.project) opt.selected = true;
    }
    project.addEventListener("change", () => { draft.project = project.value; });
    const notes = form.createEl("textarea", { cls: "agent-manager-ticket-notes", attr: { placeholder: "Notes (optional)", rows: "3" } });
    notes.value = draft.notes;
    notes.addEventListener("input", () => { draft.notes = notes.value; });
    const controls = form.createDiv({ cls: "agent-manager-newform-row agent-manager-newform-controls" });
    // The CLIs offered, beside the buttons; with one, nothing to pick, and that one is written.
    const backends = this.plugin.getBrowserBackends();
    const fallback = backends.includes(this.plugin.getCurrentBackend()) ? this.plugin.getCurrentBackend() : (backends[0] || null);
    if (!draft.backend || !backends.includes(draft.backend)) draft.backend = fallback;
    if (backends.length > 1) {
      const select = controls.createEl("select", { cls: "dropdown agent-manager-ticket-select", attr: { "aria-label": "CLI" } });
      for (const key of backends) {
        const opt = select.createEl("option", { text: CLI_BACKENDS[key].label, value: key });
        if (key === draft.backend) opt.selected = true;
      }
      // Its options are the offered backends' keys.
      select.addEventListener("change", () => { draft.backend = select.value as BackendKey; });
    }
    const launchOn = this.plugin.pluginData.ticketLaunchButton !== false;
    const create = controls.createEl("button", { text: "Create", cls: "agent-manager-start-btn" + (launchOn ? "" : " mod-cta") });
    const launch = launchOn ? controls.createEl("button", { text: "Launch", cls: "agent-manager-start-btn mod-cta" }) : null;
    let done = false;
    const go = (andLaunch = false) => {
      if (done) return;
      const folder = draft.project ? this.plugin.app.vault.getAbstractFileByPath(draft.project) : null;
      if (!ticketFileName(draft.name)) { new import_obsidian.Notice("Name the ticket."); input.focus(); return; }
      if (!(folder instanceof import_obsidian.TFolder)) { new import_obsidian.Notice("Choose a project for the ticket."); project.focus(); return; }
      done = true;
      const kept = { ...draft };
      const opts = { name: draft.name, backend: draft.backend, notes: draft.notes };
      const fresh: TicketCard = { open: true, draft: { name: "", project: "", backend: null, notes: "" } };
      this.plugin.ticketCard = fresh;
      this.closeCard("ticket");
      void (async () => {
        const file = await this.plugin.newTicket(folder, opts);
        // It couldn't be made (newTicket said why): the card comes back with what was typed.
        if (!file) {
          // Unless a session's menu has opened a new card since.
          if (this.plugin.ticketCard !== fresh) return;
          this.plugin.ticketCard = { open: true, draft: kept, from };
          if (!this._closed) this.renderBrowser();
          return;
        }
        // Both wait until Obsidian has read the ticket's properties, or neither sees it as one.
        if ((andLaunch || (from && from.containerEl.isConnected)) && !(await this.plugin.whenIndexed(file))) {
          new import_obsidian.Notice(`Made “${file.basename}”, but it didn't read as a ticket in time (does the ticket template have type: ticket in its properties?), so ${andLaunch ? "nothing was launched" : "the session wasn't attached"}.`, 8000);
          return;
        }
        // The session it came from, while its tab is still open.
        if (from && from.containerEl.isConnected) await from.attachToTicket(file.path);
        else if (from) new import_obsidian.Notice(`Made “${file.basename}”. “${from.sessionTitle || "The session"}” was closed, so it wasn't attached.`);
        if (andLaunch) await this.plugin.startSession(file.basename, null, { notePath: file.path, ...(opts.backend ? { backendOverride: opts.backend } : {}) });
      })();
    };
    create.addEventListener("click", () => go());
    launch?.addEventListener("click", () => go(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); go(launchOn); }
      else if (e.key === "Escape") { e.preventDefault(); input.blur(); }
    });
    // Enter, and Cmd+Enter in the notes, run the highlighted button.
    notes.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); go(launchOn); }
      else if (e.key === "Escape") { e.preventDefault(); notes.blur(); }
    });
    if (this._focusCard === "ticket") input.dataset.autofocus = "true";
  }
  // Each full render takes a number. A render that finishes after a later one began
  // (the user moved on while it was reading) is dropped at the swap.
  beginRender(this: Browser): number {
    this._renderIsBackground = !!this._nextRenderIsBackground;
    this._nextRenderIsBackground = false;
    this._renderGen = (this._renderGen || 0) + 1;
    return this._renderGen;
  }
  // Swap freshly built browser content into the container in one synchronous step,
  // so the browser paints only the finished result.
  swapBrowserContent(this: Browser, wrap: HTMLElement, gen: number): void {
    // A render still reading when the tab closed must not land in a dead view.
    if (this._closed) return;
    if (gen !== this._renderGen) return;
    const container = this.containerEl;
    // Someone is typing a session name or a rename here. A render nobody asked for
    // (a session starting or ending elsewhere) waits; the next one catches up.
    const focused = container.ownerDocument.activeElement;
    const typing = focused && container.contains(focused) && focused.matches(".agent-manager-name-input, .agent-manager-search-input, .agent-manager-ticket-notes, .agent-manager-ticket-select") ? focused : null;
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
  // The home page's two sections, each session in exactly one.
  //   Pinned: open or not, in an order set by dragging. Always shown, as a drop target.
  //   Recent: the open sessions first, most recently active first and re-sorted live
  //   (resortOpenRows), then every other session in the vault, newest first, 20 at a
  //   time. The search covers both parts of Recent.
  // A session just launched is open before its transcript is written, so the index
  // misses it: its row comes from the open tab. Rendered on a full render, never on
  // focus, so a click in an unfocused pane isn't swallowed by a rebuild.
  async renderSessionSections(this: Browser, parentEl: HTMLElement): Promise<void> {
    let pinned: SessionRecord[] = [], sessions: SessionRecord[] = [];
    try { pinned = await this.plugin.readPinnedSessions(); } catch { /* best effort */ }
    try { sessions = await this.plugin.listedSessions(); } catch { /* best effort */ }
    // While there are agents, only the switched agent's sessions, and those with none.
    const shows = (s: SessionRecord) => this.plugin.agentShows(this.plugin.agentOfSession(s));
    pinned = pinned.filter(shows);
    sessions = sessions.filter(shows);
    // Has today's chat run? Its session is listed once it has a transcript.
    const today = this.plugin.dailyChatName();
    // Filtered to the switched agent above, so a match is its own (or one with no agent).
    if (sessions.some((s) => s.displayName === today) || pinned.some((s) => (s.displayName || s.title) === today)) this._todayRan = `${this.plugin.switchedAgentId() || ""}\n${today}`;
    // The row being built, not the one still showing.
    const todayRow = parentEl.querySelector(".agent-manager-today");
    if (todayRow) this.refreshTodayDot(todayRow);
    const openKeys = this.plugin.getOpenSessionKeys();
    const pinnedKeys = new Set(pinned.flatMap((s) => this.plugin.sessionRowKeys(s.backend, s.title, s.sessionId)));
    // Open and not pinned, one row per session however many tabs show it.
    const seenOpen = new Set<string>();
    const open: { s: SessionRecord; at: number }[] = [];
    for (const o of this.plugin.getOpenSessions()) {
      const k = this.plugin.openSessionKey(o);
      if (pinnedKeys.has(k) || seenOpen.has(k)) continue;
      if (o.leaf && !this.plugin.agentShows(this.plugin.agentOfLeaf(o.leaf))) continue;
      seenOpen.add(k);
      // The open tab's record by id once the tab knows it. A tab with no id yet is a
      // fresh launch, never an older session of the same name.
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
      // Still a drop target, so a pinned session can be dragged back out.
      const empty = parentEl.createDiv({ cls: "agent-manager-recent" });
      this.attachSessionUnpinDrop(empty);
      empty.createEl("p", { text: pinned.length ? "No other sessions." : "No sessions yet.", cls: "agent-manager-empty" });
      return;
    }
    // Obsidian's own search field: the magnifying glass and the clear button.
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
      // The div renderSessionRow just added.
      const row = list.lastElementChild as HTMLElement;
      row.dataset.search = (s.displayName || "Untitled").toLowerCase();
      return row;
    };
    // filter(Boolean) drops the nulls.
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
      // The search covers every session; without one, the closed ones show a page at a time.
      let listed = 0, hidden = 0;
      for (const row of restRows) {
        const hit = !q || (row.dataset.search as string).includes(q);
        const capped = hit && !q && listed >= this._recentShown;
        if (hit) { matched++; if (!capped) listed++; }
        if (capped) hidden++;
        row.toggle(hit && !capped);
      }
      // The open sessions' last row keeps its divider while closed ones show below it.
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
  // One session row, shared by every list. `s` is a session record (see classify).
  renderSessionRow(this: Browser, list: HTMLElement, s: SessionRecord, openKeys: Set<string>, opts: RowOptions = {}): void {
    const row = list.createDiv({ cls: "agent-manager-row agent-manager-session-row" });
    row.dataset.sessionTitle = s.title;
    row.dataset.sessionBackend = s.backend;
    row.dataset.sessionId = s.sessionId || "";
    // Stashed so refreshStatusDots can re-stat and refresh the "time ago" in place.
    row.dataset.sessionFile = s.file || "";
    row.dataset.sessionMtime = String(s.mtime || Date.now());
    if (this._renamingId && s.sessionId && this._renamingId === s.sessionId) {
      this.renderRenameInput(row, s);
      return;
    }
    const rowKeys = this.plugin.sessionRowKeys(s.backend, s.title, s.sessionId);
    const isOpen = rowKeys.some((k) => openKeys.has(k));
    // No row's key is null, so a null active key matches none.
    row.classList.toggle("is-active", (rowKeys as (string | null)[]).includes(this.plugin.getActiveSessionKey()));
    // The whole row is the drag handle. Needs a session id: a row just launched
    // can't be pinned yet.
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
    // A pinned row's pin, centered on the row, as Obsidian marks a pinned note.
    if (opts.pinned) import_obsidian.setIcon(body.createSpan({ cls: "agent-manager-row-pin", attr: { "aria-hidden": "true" } }), "pin");
    // Pin, close, rename, and delete are in the right-click menu.
    row.addEventListener("click", () => {
      if (row.dataset.dragging) return; // a drag just ended; not a click
      const leaf = this.plugin.getLeafForSession(s.title, s.backend, s.sessionId);
      if (leaf) this.app.workspace.setActiveLeaf(leaf, { focus: true });
      else void this.plugin.startResume(s, this);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showRenameMenu(e, s);
    });
    if (canDrag) {
      // canDrag says the row has an id.
      row.dataset.dragId = s.sessionId as string;
      row.draggable = true;
      row.addEventListener("dragstart", (e) => this.onSessionDragStart(e, row, s.sessionId as string));
      row.addEventListener("dragend", () => this.onSessionDragEnd(row));
    }
  }
  // ---- Session drag between home's sections -----------------------------
  // Pinned is an ordered drop target: rows reorder by insert-before, and a session
  // dragged in from Recent is pinned at the drop position. Recent is the way out.
  onSessionDragStart(this: Browser, e: DragEvent, row: HTMLElement, id: string): void {
    this._sessionDragId = id;
    row.dataset.dragging = "1";
    row.addClass("is-dragging");
    // A missing dataTransfer throws here, and the catch takes it, as it always has.
    try { (e.dataTransfer as DataTransfer).effectAllowed = "move"; (e.dataTransfer as DataTransfer).setData("text/plain", id); } catch { /* best effort */ }
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
      // A missing dataTransfer throws here, and the catch takes it, as it always has.
      try { (e.dataTransfer as DataTransfer).dropEffect = "move"; } catch { /* best effort */ }
      // Rows renderSessionRow made: divs.
      const rows = Array.from(listEl.querySelectorAll<HTMLElement>(".agent-manager-session-row:not(.is-dragging)"));
      let beforeId: string | null | undefined = null, markRow: HTMLElement | null = null, markAfter = false;
      for (const r of rows) {
        const rect = r.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) { beforeId = r.dataset.dragId; markRow = r; break; }
      }
      if (!markRow && rows.length) { markRow = rows[rows.length - 1]; markAfter = true; }
      this.clearDropMarks();
      if (markRow) markRow.addClass(markAfter ? "drop-after" : "drop-before");
      else listEl.addClass("drop-into"); // an empty section: dropping here adds the first one
      this._sessionDropBeforeId = beforeId;
    });
    listEl.addEventListener("drop", (e) => { void (async () => {
      if (!this._sessionDragId) return;
      e.preventDefault();
      const draggedId = this._sessionDragId;
      const beforeId = this._sessionDropBeforeId;
      this.clearDropMarks();
      // `place` adds a session from another section at the drop position, or
      // reorders one already in this section.
      await place(draggedId, beforeId);
      this.renderBrowser();
    })(); });
  }
  // The way out: dropping a pinned session on Recent unpins it. A Recent row dropped
  // on Recent does nothing.
  attachSessionUnpinDrop(this: Browser, listEl: HTMLElement): void {
    const pinned = (id: string | null | undefined) => id && this.plugin.isPinned(id);
    listEl.addEventListener("dragover", (e) => {
      if (!pinned(this._sessionDragId)) return;
      e.preventDefault();
      // A missing dataTransfer throws here, and the catch takes it, as it always has.
      try { (e.dataTransfer as DataTransfer).dropEffect = "move"; } catch { /* best effort */ }
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
    // Pin, rename, and the resume link all key on the session id, which a row just
    // launched doesn't have yet.
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
          // As a Markdown link, which a note shows as a pill; a bare obsidian:// address
          // isn't clickable in a note's text.
          // Square brackets in the name become round ones, so the link and its pill hold.
          const label = String(session.displayName || "Resume").replace(/\s+/g, " ").replace(/\[/g, "(").replace(/\]/g, ")");
          // Offered only for a session with an id (above).
          const url = `[${label}](${this.plugin.buildResumeLink(session as { sessionId: string })})`;
          try {
            await navigator.clipboard.writeText(url);
            new import_obsidian.Notice("Resume link copied.");
          } catch {
            new import_obsidian.Notice("Couldn't copy the resume link.");
          }
        })
      );
    }
    this.addMoveToAgent(menu, session.sessionId, session.backend, () => this.renderBrowser());
    if (leaf) {
      menu.addItem((item) =>
        item.setTitle("Reveal open tab").setIcon("arrow-right").onClick(() => {
          void this.app.workspace.revealLeaf(leaf);
          this.app.workspace.setActiveLeaf(leaf, { focus: true });
        })
      );
      menu.addItem((item) =>
        item.setTitle("Close session").setIcon("x").onClick(() => {
          leaf.detach();
          this.renderBrowser();
        })
      );
    }
    // Delete removes the transcript itself; only for a closed, saved session.
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
      new import_obsidian.Notice("Close the session's tab before deleting it.");
      return;
    }
    try {
      // Antigravity keeps a conversation as a whole `brain/<uuid>/` directory: the
      // transcript listed is one file in it, and the conversation agy resumes from
      // sits beside it. Remove the directory, guarded to that exact shape.
      if (session.backend === "antigravity") {
        const brainDir = antigravityBrainDir(session.file);
        if (!brainDir) throw new Error(`not an Antigravity conversation folder: ${session.file}`);
        fs.rmSync(brainDir, { recursive: true, force: true });
      } else fs.unlinkSync(session.file);
    } catch (e) {
      console.error("[Agent Manager] Delete failed:", e);
      new import_obsidian.Notice("Couldn't delete the session.");
      return;
    }
    // Drop the session's rename and pin with it, so nothing is left behind.
    const id = session.sessionId;
    const named = id && this.plugin.pluginData.sessionNames?.[id] != null;
    // `named` found the rename in sessionNames.
    if (named) delete (this.plugin.pluginData.sessionNames as Record<string, string>)[id];
    // And its agent, context-source, and side-chat records.
    if (id) { delete this.plugin.pluginData.sessionAgents?.[id]; delete this.plugin.pluginData.sessionLaunchAgents?.[id]; delete this.plugin.pluginData.sessionSources?.[id]; delete this.plugin.pluginData.sideChats?.[id]; }
    // A session with a file is a store record, which has its id (IndexRecord).
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
