// The sidebar: the home page (the header and its New session card, Today's chat, the
// setup note, Pinned, and Recent), session rows and their actions, and dragging rows
// between the two sections.

import { fs, import_obsidian } from "../externals.js";
import { CLI_BACKENDS, REAL_BACKENDS } from "../constants/backends.js";
import { antigravityBrainDir } from "../sessions/transcript-files.js";
import { ConfirmModal } from "../ui/modals.js";
import { stringOf } from "../util/guards.js";
import type { BackendKey } from "../constants/backends.js";
import type { SessionRecord } from "../types.js";
import type { Browser } from "./view.js";

// What a session row is drawn with (renderSessionRow).
interface RowOptions {
  draggable?: boolean;
  showDate?: boolean;
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
        if (file) {
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
    // "+ New session" (a plus icon and the words) opens and closes the card. It starts
    // closed each time Obsidian opens, and stays as left while it runs.
    const cardOpen = this.plugin.newCardOpen === true;
    const toggle = head.createEl("button", { cls: "agent-manager-new-toggle" + (cardOpen ? " is-on" : "") });
    // A plus while the card is closed, a minus while it's open, to say a click closes it.
    import_obsidian.setIcon(toggle.createSpan({ cls: "agent-manager-new-toggle-icon" }), cardOpen ? "minus" : "plus");
    toggle.createSpan({ text: "New Session" });
    toggle.setAttribute("aria-pressed", String(cardOpen));
    toggle.addEventListener("click", () => {
      this.plugin.newCardOpen = !cardOpen;
      this._focusCardName = !cardOpen;
      this.renderBrowser();
    });
    if (cardOpen) this.renderNewSessionForm(wrap);
    this.renderTicketsRow(wrap);
    this.renderTodayRow(wrap);
    this.renderSetupNote(wrap);
    // Let the header paint before the transcript scan, which is synchronous disk I/O.
    await new Promise((r) => window.setTimeout(r, 0));
    await this.renderSessionSections(wrap);
    this.swapBrowserContent(wrap, gen);
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
  // The AGENTS.md row: the starting folder has none, so offer to create a short one.
  renderAgentsRow(this: Browser, note: HTMLElement): void {
    const folder = this.plugin.startFolder();
    note.createDiv({ cls: "agent-manager-setup-title", text: "No AGENTS.md" });
    note.createDiv({ text: `Claude Code, Codex, and Antigravity read AGENTS.md for how to work in ${folder ? `“${folder}”` : "this vault"}. Create a short one to start from, or dismiss this.` });
    const buttons = note.createDiv({ cls: "agent-manager-setup-buttons" });
    const create = buttons.createEl("button", { text: "Create AGENTS.md", cls: "mod-cta" });
    create.addEventListener("click", () => { void (async () => {
      create.disabled = true;
      const file = await this.plugin.createAgentsFile();
      if (file) await this.app.workspace.getLeaf("tab").openFile(file);
      this.renderBrowser();
    })(); });
    const dismiss = buttons.createEl("button", { text: "Dismiss" });
    dismiss.addEventListener("click", () => { void (async () => {
      await this.plugin.dismissAgentsFile();
      this.renderBrowser();
    })(); });
  }
  // Today's chat: one row that goes to the day's chat, resumes it, or starts it.
  renderTodayRow(this: Browser, wrap: HTMLElement): void {
    const name = this.plugin.dailyChatName();
    const row = wrap.createDiv({ cls: "agent-manager-today", attr: { role: "button", tabindex: "0", "data-day": this.plugin.todayString() } });
    const icon = row.createSpan({ cls: "agent-manager-today-icon" });
    import_obsidian.setIcon(icon, "sun");
    const col = row.createDiv({ cls: "agent-manager-today-text" });
    col.createDiv({ cls: "agent-manager-today-title", text: "Daily Chat" });
    // The day, written out, rather than the session's name.
    col.createDiv({ cls: "agent-manager-today-name", text: new Date().toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) });
    row.setAttribute("aria-label", name);
    const go = () => { void this.plugin.openTodaysChat(this); };
    row.addEventListener("click", go);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    this.refreshTodayDot(row);
  }
  // The Tickets button, above Daily Chat while tickets and the button are on: it opens
  // the tickets base, or the note set in settings, under the name set there.
  renderTicketsRow(this: Browser, wrap: HTMLElement): void {
    if (!this.plugin.ticketsOn() || this.plugin.pluginData.ticketsButton === false) return;
    const name = this.plugin.ticketsButtonName();
    const row = wrap.createDiv({ cls: "agent-manager-tickets", attr: { role: "button", tabindex: "0", "aria-label": `Open ${name}` } });
    import_obsidian.setIcon(row.createSpan({ cls: "agent-manager-tickets-icon" }), "ticket");
    row.createDiv({ cls: "agent-manager-today-title", text: name });
    const go = () => { void this.plugin.openTicketsNote(); };
    row.addEventListener("click", go);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
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
    if (open) this._todayRan = name;
    row.classList.toggle("is-open", open);
    row.classList.toggle("has-run", !open && this._todayRan === name);
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
  // The New session card: a name (optional), then the CLI and Start on one row. A session starts in
  // the starting folder; reading a particular note or folder first is the file menu's.
  renderNewSessionForm(this: Browser, wrap: HTMLElement): void {
    const form = wrap.createDiv({ cls: "agent-manager-newform agent-manager-newcard" });
    const input = form.createEl("input", { type: "text", cls: "agent-manager-name-input", attr: { placeholder: "Name this session (optional)" } });
    // A render can land mid-typing (a session opened elsewhere), so the draft is kept.
    input.value = this._titleDraft || "";
    input.addEventListener("input", () => { this._titleDraft = input.value; });
    const controls = form.createDiv({ cls: "agent-manager-newform-row agent-manager-newform-controls" });
    this.renderBackendSelector(controls);
    const start = controls.createEl("button", { text: "Start", cls: "agent-manager-start-btn mod-cta" });
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      this._titleDraft = "";
      void this.plugin.startSession(name, this);
    };
    start.addEventListener("click", go);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); go(); }
      else if (e.key === "Escape") { e.preventDefault(); input.value = ""; this._titleDraft = ""; input.blur(); }
    });
    if (this._focusCardName) { this._focusCardName = false; window.setTimeout(() => input.focus(), 0); }
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
    const typing = focused && container.contains(focused) && focused.matches(".agent-manager-name-input, .agent-manager-search-input") ? focused : null;
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
    // Has today's chat run? Its session is listed once it has a transcript.
    const today = this.plugin.dailyChatName();
    if (sessions.some((s) => s.displayName === today) || pinned.some((s) => (s.displayName || s.title) === today)) this._todayRan = today;
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
    if (pinned.length) for (const s of pinned) this.renderSessionRow(pinList, s, openKeys, rowOpts);
    else pinList.createDiv({ cls: "agent-manager-empty", text: "Right-click a session and choose Pin, or drag it here, to keep it here." });

    parentEl.createDiv({ text: "Recent", cls: "agent-manager-sublabel agent-manager-sessions-head" });
    if (!open.length && !rest.length) {
      // Still a drop target, so a pinned session can be dragged back out.
      const empty = parentEl.createDiv({ cls: "agent-manager-recent" });
      this.attachSessionUnpinDrop(empty);
      empty.createEl("p", { text: pinned.length ? "No other sessions." : "No sessions yet. Click New Session, or try Daily Chat.", cls: "agent-manager-empty" });
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
