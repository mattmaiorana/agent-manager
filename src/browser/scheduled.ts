
import { import_obsidian } from "../externals.js";
import { CLI_BACKENDS, isBackendKey } from "../constants/backends.js";
import { fillProjectSelect } from "./project-select.js";
import { LATEST_OUTPUTS_LABEL, NEW_SCHEDULED_TASK_LABEL, SHARED_TASK_CHOICE, NEW_TASK_MODE_HINTS, NEW_TASK_MODELS, NEW_TASK_MODES, SCHEDULED_TASKS_LABEL, newTaskDraft } from "../constants/scheduled.js";
import type { NewTaskDraft, NewTaskMode } from "../constants/scheduled.js";
import { reachFacts } from "../scheduled/reach-facts.js";
import { runParseStarted, runResultPath } from "../scheduled/run-core.js";
import type { RunRow } from "../scheduled/run-core.js";
import { buildSchedulePicker } from "../scheduled/schedule-picker.js";
import { schedDescribe, schedShortWhen } from "../scheduled/schedule-core.js";
import { ReadsSuggest } from "../ui/modals.js";
import type { TFile } from "obsidian";
import type { TaskView } from "../plugin/scheduler.js";
import type { Browser } from "./view.js";
import { notice } from "../vault-terminal/notice";

export type BrowserScope = null | { page: "tasks" } | { page: "task"; notePath: string } | { page: "outputs" };

const STATE_LABEL: Record<TaskView["state"], string> = {
  ok: "Scheduled",
  fix: "To fix",
  approve: "To approve",
  paused: "Paused",
  held: "Held",
};

const isPending = (v: TaskView): boolean => v.state === "fix" || v.state === "approve" || v.state === "held";

const atWhen = (d: Date, now: Date): string => { const w = schedShortWhen(d, now).replace(/ (\S+)$/, " at $1"); return w[0].toUpperCase() + w.slice(1); };

class ScheduledMethods {
  async renderTasksRow(this: Browser, wrap: HTMLElement): Promise<void> {
    if (!this.plugin.scheduledTasksOn()) return;
    let views: TaskView[] = [];
    try { views = await this.plugin.taskViews(); } catch { /* empty */ }
    const row = wrap.createDiv({ cls: "agent-manager-tasks-row", attr: { role: "button", tabindex: "0" } });
    import_obsidian.setIcon(row.createSpan({ cls: "agent-manager-tasks-row-icon" }), "clock");
    const col = row.createDiv({ cls: "agent-manager-tasks-row-text" });
    col.createDiv({ cls: "agent-manager-tasks-row-title", text: SCHEDULED_TASKS_LABEL });
    const line = col.createDiv({ cls: "agent-manager-tasks-row-line" });
    const next = views.find((v) => v.next);
    const running = views.filter((v) => v.running).length;
    if (running) {
      const r = line.createSpan({ cls: "agent-manager-tasks-row-running" });
      r.createSpan({ cls: "agent-manager-status-dot is-open" });
      r.createSpan({ text: running === 1 ? "Running now…" : `${running} running now…` });
    }
    else line.createSpan({ text: !views.length ? "None yet" : next?.next ? `Next: ${schedShortWhen(next.next, new Date())}` : "Nothing to run" });
    const unread = views.reduce((n, v) => n + v.unread, 0);
    if (unread) line.createSpan({ cls: "agent-manager-task-tag is-new", text: unread === 1 ? "1 output" : `${unread} outputs` });
    const pending = views.filter(isPending).length;
    if (pending) line.createSpan({ cls: "agent-manager-task-tag is-fix", text: `${pending} pending` });
    import_obsidian.setIcon(row.createSpan({ cls: "agent-manager-tasks-row-go" }), "chevron-right");
    const go = () => { this.browserScope = { page: "tasks" }; this.renderBrowser(); };
    row.addEventListener("click", go);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  }
  async renderTasksPage(this: Browser): Promise<void> {
    const gen = this.beginRender();
    const wrap = createDiv({ cls: "agent-manager-browser-inner agent-manager-task-page" });
    const pageHead = this.renderPageHead(wrap, SCHEDULED_TASKS_LABEL, () => this.goHome());
    let views: TaskView[] = [];
    try { views = await this.plugin.taskViews(); } catch { /* empty */ }
    const running = views.filter((v) => v.running);
    if (running.length) {
      const pill = pageHead.createDiv({ cls: "agent-manager-tasks-running", attr: { role: "button", tabindex: "0", "aria-label": running.map((v) => v.task.label).join(", ") } });
      pill.createSpan({ cls: "agent-manager-tasks-running-dot" });
      pill.createSpan({ text: running.length === 1 ? "Running" : `${running.length} running` });
      const goTo = (v: TaskView) => { this.browserScope = { page: "task", notePath: v.task.notePath }; this.renderBrowser(); };
      const open = (e: MouseEvent | KeyboardEvent) => {
        if (running.length === 1) { goTo(running[0]); return; }
        const menu = new import_obsidian.Menu();
        for (const v of running) menu.addItem((i) => i.setTitle(v.task.label).setIcon("play").onClick(() => goTo(v)));
        if (e instanceof MouseEvent) menu.showAtMouseEvent(e);
        else { const r = pill.getBoundingClientRect(); menu.showAtPosition({ x: r.left, y: r.bottom }); }
      };
      pill.addEventListener("click", open);
      pill.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e); } });
    }
    const now = new Date();
    const top = wrap.createDiv({ cls: "agent-manager-tasks-summary" });
    const head = top.createDiv({ cls: "agent-manager-tasks-head" });
    head.createDiv({ cls: "agent-manager-tasks-label", text: "Next run" });
    if (!this.plugin.schedulerOn()) {
      const machine = head.createDiv({ cls: "agent-manager-tasks-machine is-off", attr: { "aria-label": "This computer doesn't run the schedule: turn it on in settings, or leave it to the computer that does" } });
      machine.createSpan({ cls: "agent-manager-status-dot" });
      machine.createSpan({ text: "Not on this computer" });
    }
    const next = views.find((v) => v.next);
    const at = (d: Date) => atWhen(d, now);
    top.createDiv({ cls: "agent-manager-tasks-next", text: next ? next.task.label : !views.length ? "No scheduled tasks yet" : "Nothing scheduled" });
    const when = next?.next ? [at(next.next), "error" in next.task.rules ? "" : schedDescribe(next.task.rules).replace(/ at .*$/, "")].filter(Boolean).join(" · ") : views.length ? "Every task is paused, or needs fixing or approving." : "";
    if (when) top.createDiv({ cls: "agent-manager-tasks-when", text: when });
    if (views.length) {
      const counts = top.createDiv({ cls: "agent-manager-tasks-counts" });
      const count = (n: number, word: string, cls = "") => {
        const c = counts.createSpan();
        c.createEl("b", { cls, text: String(n) });
        c.appendText(` ${word}`);
      };
      count(views.filter((v) => v.state === "ok").length, "active", views.some((v) => v.state === "ok") ? "is-active" : "");
      count(views.filter(isPending).length, "pending", views.some(isPending) ? "is-pending" : "");
      count(views.filter((v) => v.state === "paused").length, "paused");
    }
    const safety = await this.plugin.safetyStatus();
    if (safety) {
      const line = wrap.createDiv({ cls: `agent-manager-tasks-safety is-${safety.tone}` });
      line.createSpan({ cls: "agent-manager-tasks-safety-text", text: safety.text });
      if (safety.action) {
        const b = line.createEl("button", { text: safety.action });
        b.addEventListener("click", () => {
          b.disabled = true;
          void this.plugin.safetyPhasesWanted().then((phases) => this.plugin.runSafetyCheck(phases, { manual: true }));
        });
      }
    }
    if (views.some((v) => v.runs.some((r) => runResultPath(r.Result)))) {
      const fresh = views.reduce((n, v) => n + v.unread, 0);
      const outsRow = wrap.createDiv({ cls: "agent-manager-card-row agent-manager-task-new", attr: { role: "button", tabindex: "0" } });
      import_obsidian.setIcon(outsRow.createSpan({ cls: "agent-manager-card-row-icon" }), "inbox");
      outsRow.createDiv({ cls: "agent-manager-today-title agent-manager-card-row-name", text: LATEST_OUTPUTS_LABEL });
      if (fresh) outsRow.createSpan({ cls: "agent-manager-task-newcount agent-manager-outputs-rowcount", text: String(fresh) });
      const openOuts = () => { this.browserScope = { page: "outputs" }; this.renderBrowser(); };
      outsRow.addEventListener("click", openOuts);
      outsRow.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openOuts(); } });
    }
    const card = this.taskCardState();
    const add = wrap.createDiv({ cls: "agent-manager-card-row agent-manager-task-new" + (card.open ? " is-open" : ""), attr: { role: "button", tabindex: "0", "aria-expanded": String(card.open) } });
    import_obsidian.setIcon(add.createSpan({ cls: "agent-manager-card-row-icon" }), import_obsidian.getIcon("clock-plus") ? "clock-plus" : "clock");
    add.createDiv({ cls: "agent-manager-today-title agent-manager-card-row-name", text: NEW_SCHEDULED_TASK_LABEL });
    const toggle = () => { card.open = !card.open; this._focusTaskCard = card.open; this.renderBrowser(); };
    add.addEventListener("click", toggle);
    add.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    if (card.open) this.renderNewTaskForm(wrap.createDiv({ cls: "agent-manager-newcard-reveal agent-manager-task-new-reveal" }));
    if (!views.length) {
      wrap.createDiv({ cls: "agent-manager-empty", text: "A task is a note with type: scheduled task in its properties, in a folder of its own named like it." });
    }
    const groups: [string, TaskView[]][] = [
      ["Active", views.filter((v) => v.state === "ok")],
      ["Pending", views.filter(isPending)],
    ];
    for (const [title, list] of groups) {
      if (!list.length) continue;
      wrap.createDiv({ cls: "agent-manager-sublabel", text: title });
      const el = wrap.createDiv({ cls: "agent-manager-list agent-manager-session-list agent-manager-task-list" });
      for (const v of list) this.renderTaskRow(el, v, now);
    }
    const paused = views.filter((v) => v.state === "paused");
    if (paused.length) {
      const fold = wrap.createEl("details", { cls: "agent-manager-tasks-paused" });
      fold.open = this._pausedOpen === true;
      const sum = fold.createEl("summary", { cls: "agent-manager-sublabel agent-manager-tasks-fold" });
      import_obsidian.setIcon(sum.createSpan({ cls: "agent-manager-tasks-fold-chevron" }), "chevron-right");
      sum.createSpan({ text: "Paused" });
      fold.addEventListener("toggle", () => { this._pausedOpen = fold.open; });
      const el = fold.createDiv({ cls: "agent-manager-list agent-manager-session-list agent-manager-task-list" });
      for (const v of paused) this.renderTaskRow(el, v, now);
    }
    this.swapBrowserContent(wrap, gen);
    const autofocus = wrap.isConnected ? wrap.querySelector<HTMLElement>("[data-autofocus]") : null;
    if (autofocus) { this._focusTaskCard = false; autofocus.focus(); }
  }
  renderPageHead(this: Browser, wrap: HTMLElement, title: string, back: () => void): HTMLElement {
    const head = wrap.createDiv({ cls: "agent-manager-home-head agent-manager-task-head" });
    const b = head.createDiv({ cls: "agent-manager-task-back", attr: { role: "button", tabindex: "0", "aria-label": "Back" } });
    import_obsidian.setIcon(b.createSpan({ cls: "agent-manager-task-back-icon" }), "chevron-left");
    b.createSpan({ cls: "agent-manager-home-title agent-manager-task-title", text: title });
    b.addEventListener("click", back);
    b.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); back(); } });
    return head;
  }
  renderTaskRow(this: Browser, list: HTMLElement, v: TaskView, now: Date): void {
    const row = list.createDiv({ cls: "agent-manager-row agent-manager-session-row agent-manager-task-row", attr: { role: "button", tabindex: "0" } });
    row.dataset.taskPath = v.task.notePath;
    const body = row.createDiv({ cls: "agent-manager-row-body" });
    body.createSpan({ cls: `agent-manager-status-dot agent-manager-task-dot is-${v.state}`, attr: { "aria-label": STATE_LABEL[v.state] } });
    const col = body.createDiv({ cls: "agent-manager-row-col" });
    const name = col.createDiv({ cls: "agent-manager-task-name-line" });
    name.createSpan({ cls: "agent-manager-row-name" + (v.unread ? " is-unread" : ""), text: v.task.label });
    if (this.plugin.agentsOn()) name.createSpan({ cls: "agent-manager-task-profile", text: v.reach.agent || "No profile" });
    if (v.state === "paused") {
      const needs = v.task.problems.length ? "Needs fixing" : !v.approved ? "Needs approval" : "";
      if (needs) name.createSpan({ cls: "agent-manager-task-profile agent-manager-task-needs" + (v.task.problems.length ? "" : " is-approve"), text: needs });
    }
    if (v.unread) body.createSpan({ cls: "agent-manager-task-newcount", text: String(v.unread), attr: { "aria-label": v.unread === 1 ? "A new result" : `${v.unread} new results` } });
    const when = "error" in v.task.rules ? "" : schedDescribe(v.task.rules);
    if (v.state === "ok" || v.state === "paused") { if (when) col.createDiv({ cls: "agent-manager-row-date", text: when }); }
    else if (v.state === "approve") {
      const line = col.createDiv({ cls: "agent-manager-row-date" });
      if (when) line.appendText(`${when} · `);
      line.createSpan({ cls: "agent-manager-task-why is-approve", text: "needs approval" });
    } else col.createDiv({ cls: `agent-manager-row-date agent-manager-task-why is-${v.state}`, text: v.why });
    const last = v.runs[0];
    const at = last ? runParseStarted(last.Started) : null;
    if (v.running) col.createDiv({ cls: "agent-manager-row-date agent-manager-task-why is-running", text: "Running now" });
    else col.createDiv({ cls: "agent-manager-row-date", text: last ? `Last run ${at ? schedShortWhen(at, now) : last.Started}, ${last.Outcome}` : "Hasn't run yet" });
    const go = () => { this.browserScope = { page: "task", notePath: v.task.notePath }; this.renderBrowser(); };
    row.addEventListener("click", go);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const menu = new import_obsidian.Menu();
      this.addTaskActions(menu, v);
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("Open note").setIcon("file-text").onClick(() => this.openTaskNote(v.task.notePath)));
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("Delete task").setIcon("trash").setWarning(true).onClick(() => { void this.plugin.deleteTask(v.task); }));
      menu.showAtMouseEvent(e);
    });
  }
  addTaskActions(this: Browser, menu: InstanceType<typeof import_obsidian.Menu>, v: TaskView): void {
    const t = v.task;
    if (v.running) menu.addItem((i) => i.setTitle("Stop").setIcon("square").onClick(() => { this.plugin.stopRun(t); }));
    else if (!t.problems.length) menu.addItem((i) => i.setTitle("Run now").setIcon("play").onClick(() => { void this.plugin.runNow(v); }));
    menu.addItem((i) => i.setTitle("Start session").setIcon("bot").onClick(() => { this.startTaskSession(t.notePath); }));
    if (!t.problems.length && !v.approved) menu.addItem((i) => i.setTitle("Approve…").setIcon("shield-check").onClick(() => { void this.plugin.approveTask(v); }));
    menu.addItem((i) => i.setTitle(t.paused ? "Unpause" : "Pause").setIcon(t.paused ? "play-circle" : "pause").onClick(() => { void this.plugin.setTaskPaused(t, !t.paused); }));
  }
  startTaskSession(this: Browser, notePath: string): void {
    const f = this.app.vault.getAbstractFileByPath(notePath);
    if (f instanceof import_obsidian.TFile) this.plugin.startFromFile(f);
    else notice("That scheduled task's note isn't there anymore.");
  }
  taskCardState(this: Browser): NonNullable<Browser["plugin"]["taskCard"]> {
    const card = this.plugin.taskCard || (this.plugin.taskCard = { open: false, draft: newTaskDraft() });
    card.draft = { ...newTaskDraft(), ...card.draft };
    return card;
  }
  renderNewTaskForm(this: Browser, wrap: HTMLElement): void {
    const card = this.taskCardState();
    const draft = card.draft;
    const form = wrap.createDiv({ cls: "agent-manager-newform agent-manager-newcard agent-manager-ticketcard agent-manager-taskcard" });
    if (!this.plugin.getBrowserBackends().includes("claude")) {
      form.createDiv({ cls: "agent-manager-ticketcard-from", text: "Scheduled tasks run on Claude Code for now, and Claude Code isn't one of the CLIs offered (Settings → Agent Manager)." });
      return;
    }
    const input = form.createEl("input", { type: "text", cls: "agent-manager-name-input", attr: { placeholder: "Name this scheduled task" } });
    input.value = draft.name;
    input.addEventListener("input", () => { draft.name = input.value; });
    const project = form.createEl("select", { cls: "dropdown agent-manager-ticket-select", attr: { "aria-label": "Project" } });
    const groups = this.plugin.creationProjectGroups();
    const shared = this.plugin.sharedTaskChoice();
    if (shared) groups.push({ label: null, options: [{ text: "Shared - No Agent", value: SHARED_TASK_CHOICE }] });
    const hasHome = this.plugin.agentList().some((a) => a.home);
    if (!hasHome) groups.unshift({ label: null, options: [{ text: "No project", value: "" }] });
    const listed = groups.some((g) => g.options.some((o) => o.value === draft.project));
    if (!listed || (hasHome && !draft.project)) draft.project = this.plugin.creationProjectDefault(groups, listed ? draft.project : "");
    fillProjectSelect(project, groups, draft.project);
    project.addEventListener("change", () => { draft.project = project.value; sayWhere(); });
    const mode = form.createEl("select", { cls: "dropdown agent-manager-ticket-select", attr: { "aria-label": "How it runs" } });
    for (const [value, text] of NEW_TASK_MODES) {
      const opt = mode.createEl("option", { text, value });
      if (value === draft.mode) opt.selected = true;
    }
    const hint = form.createDiv({ cls: "agent-manager-taskcard-hint", text: NEW_TASK_MODE_HINTS[draft.mode] });
    const reach = form.createDiv({ cls: "agent-manager-taskcard-box" });
    const fillReach = () => { reach.empty(); this.renderTaskCardReach(reach, draft); };
    fillReach();
    mode.addEventListener("change", () => {
      draft.mode = mode.value as NewTaskMode;
      if (draft.mode === "web" && draft.web === "off") draft.web = "search";
      hint.setText(NEW_TASK_MODE_HINTS[draft.mode]);
      fillReach();
    });
    buildSchedulePicker(form, draft.schedule, (line) => { draft.schedule = line; });
    const prompt = form.createEl("textarea", { cls: "agent-manager-ticket-notes agent-manager-task-prompt", attr: { placeholder: "What each run should do", rows: "4" } });
    prompt.value = draft.prompt;
    prompt.addEventListener("input", () => { draft.prompt = prompt.value; });
    const advBtn = form.createEl("button", { cls: "agent-manager-taskcard-more", attr: { "aria-expanded": String(draft.advanced) } });
    const advText = advBtn.createDiv();
    advText.createDiv({ text: "Advanced Options" });
    const advSummary = advText.createDiv({ cls: "agent-manager-taskcard-more-summary" });
    const chevron = advBtn.createSpan({ cls: "agent-manager-taskcard-more-chevron" });
    const adv = form.createDiv({ cls: "agent-manager-taskcard-box" });
    const sayAdv = () => {
      const model = NEW_TASK_MODELS.find(([v]) => v === draft.model)?.[1] || draft.model;
      advSummary.setText([draft.eachRun === "new" ? "New session each run" : "Continues its session", model, draft.followUp ? "Follow-up ticket" : "No follow-up ticket", ...(draft.onlyWhenNew ? ["Only when new"] : [])].join(" · "));
      (0, import_obsidian.setIcon)(chevron, draft.advanced ? "chevron-down" : "chevron-right");
      adv.toggleClass("agent-manager-hidden", !draft.advanced);
      advBtn.setAttr("aria-expanded", String(draft.advanced));
    };
    advBtn.addEventListener("click", () => { draft.advanced = !draft.advanced; sayAdv(); });
    taskCardRow(adv, "Each run", "", (r) => taskCardSeg(r, [["new", "New session"], ["continue", "Continue"]], draft.eachRun, (v) => { draft.eachRun = v as NewTaskDraft["eachRun"]; sayAdv(); }));
    taskCardRow(adv, "Model", "", (r) => {
      const sel = r.createEl("select", { cls: "dropdown", attr: { "aria-label": "Model" } });
      for (const [v, t] of NEW_TASK_MODELS) { const o = sel.createEl("option", { text: t, value: v }); if (v === draft.model) o.selected = true; }
      sel.addEventListener("change", () => { draft.model = sel.value; sayAdv(); });
    });
    taskCardCheck(adv, "File results in a follow-up ticket", draft.followUp, (v) => { draft.followUp = v; sayAdv(); });
    taskCardCheck(adv, "Only report when something's new", draft.onlyWhenNew, (v) => { draft.onlyWhenNew = v; sayAdv(); });
    sayAdv();
    const controls = form.createDiv({ cls: "agent-manager-newform-row agent-manager-newform-controls" });
    const where = controls.createDiv({ cls: "agent-manager-taskcard-where" });
    const whereLine = where.createDiv();
    const sayWhere = () => {
      const dir = this.plugin.newTaskFolder(draft.project);
      const agent = draft.project === SHARED_TASK_CHOICE ? (this.plugin.agentList().length ? "no agent profile" : null) : this.plugin.creationAgentName(dir);
      whereLine.setText(`Saved in ${dir}${agent ? ` · runs as ${agent}` : ""}`);
    };
    sayWhere();
    const create = controls.createEl("button", { text: "Create", cls: "agent-manager-start-btn mod-cta" });
    let done = false;
    create.addEventListener("click", () => {
      if (done) return;
      if (!draft.name.trim()) { notice("Name the scheduled task."); input.focus(); return; }
      if (!draft.schedule) { notice("Pick a schedule for the scheduled task."); return; }
      if (!draft.prompt.trim()) { notice("Say what each run should do."); prompt.focus(); return; }
      if (draft.mode !== "local" && draft.web === "sites" && !draft.sites.trim()) { notice("List the sites it may read, or pick another web setting."); return; }
      done = true;
      const opts = { ...draft };
      void (async () => {
        const file = await this.plugin.createTask(opts);
        if (!file) { done = false; return; }
        this.plugin.taskCard = { open: false, draft: newTaskDraft() };
        await this.plugin.whenIndexed(file);
        if (this._closed) return;
        this.browserScope = { page: "task", notePath: file.path };
        this.renderBrowser();
      })();
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); input.blur(); } });
    if (this._focusTaskCard) input.dataset.autofocus = "true";
  }
  renderTaskCardReach(this: Browser, box: HTMLElement, draft: NewTaskDraft): void {
    const sitesField = () => {
      const f = box.createEl("input", { type: "text", cls: "agent-manager-name-input", attr: { placeholder: "Sites it may read, or a [[note]] listing them", "aria-label": "Sites" } });
      f.value = draft.sites;
      f.addEventListener("input", () => { draft.sites = f.value; });
      f.toggleClass("agent-manager-hidden", draft.web !== "sites");
      return f;
    };
    if (draft.mode === "full") {
      let sites: HTMLInputElement | null = null;
      taskCardRow(box, "Web", "", (r) => taskCardSeg(r, [["off", "Off"], ["search", "Search"], ["sites", "Sites"]], draft.web, (v) => { draft.web = v as NewTaskDraft["web"]; sites?.toggleClass("agent-manager-hidden", v !== "sites"); }));
      sites = sitesField();
      taskCardRow(box, "Connectors", "Mail, Slack, calendar: reading and drafts, never sending", (r) => taskCardToggle(r, "Connectors", draft.connectors, (v) => { draft.connectors = v; }));
      taskCardRow(box, "Close its tab after a clean run", "", (r) => taskCardToggle(r, "Close its tab after a clean run", draft.closeTab, (v) => { draft.closeTab = v; }));
    } else if (draft.mode === "local") {
      taskCardRow(box, "Web", "", (r) => r.createDiv({ cls: "agent-manager-taskcard-fixed", text: "Off" }));
      taskCardRow(box, "Files it reads", "", (r) => {
        const sel = r.createEl("select", { cls: "dropdown", attr: { "aria-label": "Files it reads" } });
        for (const [v, t] of [["project", "Its project"], ["vault", "The whole vault"], ["none", "Only its own folder"]] as const) { const o = sel.createEl("option", { text: t, value: v }); if (v === draft.files) o.selected = true; }
        sel.addEventListener("change", () => { draft.files = sel.value as NewTaskDraft["files"]; });
      });
      taskCardRow(box, "Shell", "Sandboxed: no network, writes nowhere", (r) => taskCardToggle(r, "Shell", draft.shell, (v) => { draft.shell = v; }));
    } else {
      let sites: HTMLInputElement | null = null;
      taskCardRow(box, "Web", "", (r) => taskCardSeg(r, [["search", "Search"], ["sites", "Sites"]], draft.web === "sites" ? "sites" : "search", (v) => { draft.web = v as NewTaskDraft["web"]; sites?.toggleClass("agent-manager-hidden", v !== "sites"); }));
      sites = sitesField();
      taskCardRow(box, "Files it reads", "The web and your vault never meet, but for what it reads first", (r) => r.createDiv({ cls: "agent-manager-taskcard-fixed", text: "Its own folder" }));
    }
    this.renderTaskCardReads(box, draft);
  }
  renderTaskCardReads(this: Browser, box: HTMLElement, draft: NewTaskDraft): void {
    const desc = draft.mode === "full" ? "Told to read these first, as a ticket's session is" : draft.mode === "local" ? "Read first, beside the files it reads" : "Read first: the only vault notes and folders it sees";
    taskCardRow(box, "Reads first", desc, () => {});
    const field = box.createEl("input", { type: "text", cls: "agent-manager-name-input", attr: { placeholder: "Add a note or folder…", "aria-label": "Reads first" } });
    const chips = box.createDiv({ cls: "agent-manager-taskcard-chips" });
    const draw = () => {
      chips.empty();
      for (const p of draft.reads) {
        const chip = chips.createSpan({ cls: "agent-manager-taskcard-chip", text: p.replace(/\.md$/, "") });
        const x = chip.createEl("button", { cls: "agent-manager-taskcard-chip-x", text: "×", attr: { "aria-label": `Remove ${p}` } });
        x.addEventListener("click", () => { draft.reads = draft.reads.filter((q) => q !== p); draw(); });
      }
      chips.toggleClass("agent-manager-hidden", !draft.reads.length);
    };
    new ReadsSuggest(this.app, field, (f) => {
      const p = f instanceof import_obsidian.TFolder ? `${f.path}/` : f.path;
      if (!draft.reads.includes(p)) draft.reads = [...draft.reads, p];
      draw();
    });
    draw();
  }
  openTaskNote(this: Browser, notePath: string): void {
    const f = this.app.vault.getAbstractFileByPath(notePath);
    if (f instanceof import_obsidian.TFile) void this.openVaultFile(f);
  }
  async renderTaskPage(this: Browser, notePath: string): Promise<void> {
    const gen = this.beginRender();
    const wrap = createDiv({ cls: "agent-manager-browser-inner agent-manager-task-page" });
    const head = this.renderPageHead(wrap, "", () => { this.browserScope = { page: "tasks" }; this.renderBrowser(); });
    const titleEl = head.querySelector(".agent-manager-task-title") as HTMLElement;
    let v: TaskView | null = null;
    try { v = await this.plugin.taskViewByPath(notePath); } catch { /* empty */ }
    if (!v) {
      titleEl.setText("Scheduled task");
      wrap.createDiv({ cls: "agent-manager-empty", text: "This task isn't in the vault anymore." });
      this.swapBrowserContent(wrap, gen);
      return;
    }
    const t = v.task;
    titleEl.setText(t.label);

    const now = new Date();
    const button = (parent: HTMLElement, text: string, cta: boolean, fn: () => void) => {
      const b = parent.createEl("button", { text, cls: cta ? "mod-cta" : "" });
      b.addEventListener("click", fn);
    };
    const pendingApproval = !t.problems.length && !v.approved && !t.paused;
    if (pendingApproval) {
      const card = wrap.createDiv({ cls: "agent-manager-task-approve-card" });
      card.createDiv({ cls: "agent-manager-task-approve-title", text: this.plugin.taskApprovals()[t.notePath] ? "Its reach changed" : "Waiting for approval" });
      card.createDiv({ cls: "agent-manager-task-approve-why", text: this.plugin.taskApprovals()[t.notePath] ? "What a run of it can reach has changed since it was approved on this computer, so it won't run until it's approved again." : "It won't run on this computer until you've approved what a run of it can reach." });
      const row = card.createDiv({ cls: "agent-manager-task-actions" });
      button(row, "Approve", true, () => { void this.plugin.approveTask(v); });
      button(row, "Start session", false, () => { this.startTaskSession(t.notePath); });
      button(row, "Edit", false, () => { void this.plugin.openTaskNoteFile(t.notePath); });
      button(row, "Pause", false, () => { void this.plugin.setTaskPaused(t, true); });
    }
    if (!pendingApproval || v.running) {
      const summary = wrap.createDiv({ cls: "agent-manager-tasks-summary agent-manager-task-summary" });
      const label = summary.createDiv({ cls: "agent-manager-tasks-label agent-manager-task-summary-label" });
      if (!v.running && v.state !== "ok") label.createSpan({ cls: `agent-manager-status-dot agent-manager-task-dot is-${v.state}` });
      label.createSpan({ text: v.running ? "Now" : v.state === "ok" ? "Next run" : STATE_LABEL[v.state] });
      const big = v.running ? "Running now" : v.state === "ok" ? (v.next ? atWhen(v.next, now) : "Nothing more to run") : v.state === "paused" ? "Paused" : v.state === "fix" ? "Needs fixing" : v.state === "held" ? "Held" : "Waiting for approval";
      summary.createDiv({ cls: "agent-manager-tasks-next", text: big });
      const listed = t.problems.length > 1 || (t.problems.length > 0 && v.state !== "fix");
      const every = "error" in t.rules ? "" : schedDescribe(t.rules).replace(/ at .*$/, "");
      const sub = v.running || v.state === "ok" || v.state === "paused" ? every : listed ? "" : v.why;
      if (sub) summary.createDiv({ cls: "agent-manager-tasks-when" + (v.state === "fix" || v.state === "held" ? " is-warn" : ""), text: sub });
      if (listed) {
        const ul = summary.createEl("ul", { cls: "agent-manager-task-problems" });
        for (const p of t.problems) ul.createEl("li", { text: p });
      }
      const actions = summary.createDiv({ cls: "agent-manager-task-actions" });
      if (t.paused && !v.running) button(actions, "Unpause", true, () => { void this.plugin.setTaskPaused(t, false); });
      if (!v.approved && !t.problems.length && !v.running) button(actions, "Approve", !t.paused, () => { void this.plugin.approveTask(v); });
      if (v.running) button(actions, "Stop", true, () => { this.plugin.stopRun(v.task); });
      else if (!t.problems.length) button(actions, "Run now", !t.paused && v.approved, () => { void this.plugin.runNow(v); });
      button(actions, "Start session", false, () => { this.startTaskSession(t.notePath); });
      button(actions, "Edit", false, () => this.openTaskNote(t.notePath));
      if (!t.paused) button(actions, "Pause", false, () => { void this.plugin.setTaskPaused(t, true); });
    }

    const facts = (title: string, rows: [string, string | string[]][]) => {
      wrap.createDiv({ cls: "agent-manager-sublabel", text: title });
      const dl = wrap.createDiv({ cls: "agent-manager-task-facts" });
      for (const [k, val] of rows) {
        const items = Array.isArray(val) ? val : [val];
        if (!items.length) continue;
        dl.createDiv({ cls: "agent-manager-task-key", text: k });
        const dd = dl.createDiv({ cls: "agent-manager-task-value" });
        for (const x of items) dd.createDiv({ text: x });
      }
    };
    const label = (k: string) => (isBackendKey(k) ? CLI_BACKENDS[k].label : k);
    facts("The task", [
      ["Mode", t.mode === "full" ? "Full session" : t.web.mode === "off" ? "Headless (Local Only)" : "Headless (Web Access)"],
      ["Schedule", "error" in t.rules ? (t.scheduleText || "Not set") : schedDescribe(t.rules)],
      ["Project", t.projectFolder != null ? (t.projectFolder || this.app.vault.getName()) : "Its own folder"],
      ["Agent profile", v.reach.agent || "None"],
      ["Runs on", t.model ? `${label(t.backend)}, ${t.model}` : label(t.backend)],
      ["Each run", t.eachRun === "continue" ? "Continues the last run's session" : "A new session"],
      ["When late", t.catchUp ? "Runs late, within half its interval" : "Runs only within ten minutes of its time"],
      ["Only when new", t.onlyWhenNew ? "A run may report nothing and make no note" : "Every run makes a note"],
    ]);
    const ticket = t.followUp === "ticket" ? this.plugin.followUpTicketOf(t) : null;
    if (ticket) {
      const row = wrap.createDiv({ cls: "agent-manager-task-followup" });
      row.createSpan({ text: "Follow-up ticket: " });
      const a = row.createEl("a", { text: ticket.basename, href: "#" });
      a.addEventListener("click", (e) => { e.preventDefault(); void this.openVaultFile(ticket); });
    }
    const r = v.reach;
    facts("What a run can reach", reachFacts(t, r, label(r.backend)).filter(([k]) => k !== "Runs on" && k !== "Agent profile" && k !== "Each run" && k !== "Mode").map(([k, val]) => (k === "Prompt" || k === "Human Notes" ? [k, "Part of the approval: an edit asks again"] : [k, val])));
    if (r.mode !== "full") {
      const never = wrap.createEl("details", { cls: "agent-manager-task-never" });
      never.createEl("summary", { text: "Every place no run reads" });
      for (const p of r.neverRead) never.createDiv({ cls: "agent-manager-task-path", text: p });
      if (r.otherResults.length) {
        const others = wrap.createEl("details", { cls: "agent-manager-task-never" });
        others.createEl("summary", { text: "Other scheduled tasks' results it doesn't read" });
        for (const p of r.otherResults.filter((x) => !x.endsWith("/**"))) others.createDiv({ cls: "agent-manager-task-path", text: p });
      }
    }
    const approval = wrap.createDiv({ cls: "agent-manager-task-approval" });
    approval.createSpan({ text: v.approved ? "Approved on this computer." : "Not approved on this computer." });
    approval.createSpan({ cls: "agent-manager-task-hash", text: `Reach ${v.hash}` });

    wrap.createDiv({ cls: "agent-manager-sublabel", text: "Runs" });
    if (!v.runs.length) wrap.createDiv({ cls: "agent-manager-empty", text: "It hasn't run yet." });
    const runs = wrap.createDiv({ cls: "agent-manager-list agent-manager-session-list" });
    for (const row of v.runs.slice(0, 20)) {
      const el = runs.createDiv({ cls: "agent-manager-row agent-manager-session-row agent-manager-run-row" });
      const col = el.createDiv({ cls: "agent-manager-row-col" });
      col.createDiv({ cls: "agent-manager-row-name", text: `${row.Started.slice(0, 16)} · ${row.Outcome}${row.Took ? ` · ${row.Took}` : ""}` });
      if (row.Note) col.createDiv({ cls: "agent-manager-row-date", text: row.Note });
      const result = runResultPath(row.Result);
      if (result) {
        el.addEventListener("click", () => this.openTaskNote(result));
        el.addEventListener("contextmenu", (e) => this.showResultMenu(e, result, this.plugin.resultUnread(row), row));
      } else {
        el.addEventListener("click", () => { const tr = this.runTranscript(row); if (tr) void this.openVaultFile(tr); });
        el.addEventListener("contextmenu", (e) => {
          const tr = this.runTranscript(row);
          if (!tr) return;
          e.preventDefault();
          const menu = new import_obsidian.Menu();
          menu.addItem((i) => i.setTitle("Open transcript").setIcon("scroll-text").onClick(() => { void this.openVaultFile(tr); }));
          menu.showAtMouseEvent(e);
        });
      }
    }
    this.swapBrowserContent(wrap, gen);
  }
  runTranscript(this: Browser, r: RunRow): TFile | null {
    return r.Session ? this.plugin.findTranscriptNoteBySessionId(r.Session) : null;
  }
  showResultMenu(this: Browser, e: MouseEvent, path: string, unread: boolean, r: RunRow): void {
    e.preventDefault();
    const menu = new import_obsidian.Menu();
    menu.addItem((i) => i.setTitle("Open").setIcon("file-text").onClick(() => this.openTaskNote(path)));
    const transcript = this.runTranscript(r);
    if (transcript) menu.addItem((i) => i.setTitle("Open transcript").setIcon("scroll-text").onClick(() => { void this.openVaultFile(transcript); }));
    if (unread) menu.addItem((i) => i.setTitle("Mark as read").setIcon("check").onClick(() => { this.plugin.markResultSeen(path); }));
    else menu.addItem((i) => i.setTitle("Mark as unread").setIcon("circle-dot").onClick(() => this.plugin.markResultUnseen(path)));
    menu.showAtMouseEvent(e);
  }
  async renderOutputsPage(this: Browser): Promise<void> {
    const gen = this.beginRender();
    const wrap = createDiv({ cls: "agent-manager-browser-inner agent-manager-task-page" });
    this.renderPageHead(wrap, LATEST_OUTPUTS_LABEL, () => { this.browserScope = { page: "tasks" }; this.renderBrowser(); });
    let views: TaskView[] = [];
    try { views = await this.plugin.taskViews(); } catch { /* empty */ }
    const now = new Date();
    const items: { v: TaskView; r: RunRow; path: string; at: Date | null; unread: boolean }[] = [];
    for (const v of views) {
      for (const r of v.runs) {
        const path = runResultPath(r.Result);
        if (!path || !(this.app.vault.getAbstractFileByPath(path) instanceof import_obsidian.TFile)) continue;
        items.push({ v, r, path, at: runParseStarted(r.Started), unread: this.plugin.resultUnread(r) });
      }
    }
    items.sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
    const when = (it: { at: Date | null; r: RunRow }) => (it.at ? schedShortWhen(it.at, now).replace(/^./, (c) => c.toUpperCase()) : it.r.Started);
    const fresh = items.filter((it) => it.unread);
    const top = wrap.createDiv({ cls: "agent-manager-tasks-summary agent-manager-task-summary" });
    top.createDiv({ cls: "agent-manager-tasks-next", text: !items.length ? "No results yet" : fresh.length ? `${fresh.length} new ${fresh.length === 1 ? "result" : "results"}` : "All read" });
    const tasks = new Set(fresh.map((it) => it.v.task.notePath)).size;
    const sub = fresh.length ? `From ${tasks} ${tasks === 1 ? "task" : "tasks"} · newest ${when(fresh[0]).replace(/^./, (c) => c.toLowerCase())}` : items.length ? `Latest ${when(items[0]).replace(/^./, (c) => c.toLowerCase())}, ${items[0].v.task.label}` : "A task's results show here once it has run.";
    top.createDiv({ cls: "agent-manager-tasks-when", text: sub });
    if (fresh.length) {
      const actions = top.createDiv({ cls: "agent-manager-task-actions" });
      actions.createEl("button", { text: "Mark all as read", cls: "mod-cta" }).addEventListener("click", () => this.plugin.markResultsSeen(fresh.map((it) => it.path)));
    }
    const list = wrap.createDiv({ cls: "agent-manager-list agent-manager-session-list agent-manager-task-list agent-manager-outputs-list" });
    for (const it of items.slice(0, this.plugin.schedSettings().latestOutputs)) {
      const row = list.createDiv({ cls: "agent-manager-row agent-manager-session-row agent-manager-task-row", attr: { role: "button", tabindex: "0" } });
      const body = row.createDiv({ cls: "agent-manager-row-body" });
      body.createSpan({ cls: "agent-manager-outputs-dot" + (it.unread ? " is-unread" : ""), attr: it.unread ? { "aria-label": "New" } : {} });
      const col = body.createDiv({ cls: "agent-manager-row-col" });
      const name = col.createDiv({ cls: "agent-manager-task-name-line" });
      name.createSpan({ cls: "agent-manager-row-name" + (it.unread ? " is-unread" : ""), text: it.v.task.label });
      if (this.plugin.agentsOn()) name.createSpan({ cls: "agent-manager-task-profile", text: it.v.reach.agent || "No profile" });
      col.createDiv({ cls: "agent-manager-row-date", text: [when(it), it.r.Outcome, it.r.Took].filter(Boolean).join(" · ") });
      if (it.r.Note) col.createDiv({ cls: "agent-manager-outputs-note", text: it.r.Note });
      const go = () => this.openTaskNote(it.path);
      row.addEventListener("contextmenu", (e) => this.showResultMenu(e, it.path, it.unread, it.r));
      row.addEventListener("click", go);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    }
    this.swapBrowserContent(wrap, gen);
  }
}
export { ScheduledMethods };

function taskCardRow(parent: HTMLElement, label: string, desc: string, control: (r: HTMLElement) => unknown): HTMLElement {
  const row = parent.createDiv({ cls: "agent-manager-taskcard-row" });
  const lab = row.createDiv({ cls: "agent-manager-taskcard-label" });
  lab.createDiv({ cls: "agent-manager-taskcard-label-name", text: label });
  if (desc) lab.createDiv({ cls: "agent-manager-taskcard-label-desc", text: desc });
  control(row);
  return row;
}
function taskCardSeg(parent: HTMLElement, options: [string, string][], value: string, onChange: (v: string) => void): HTMLElement {
  const seg = parent.createDiv({ cls: "agent-manager-taskcard-seg", attr: { role: "group" } });
  const buttons = options.map(([v, t]) => {
    const b = seg.createEl("button", { text: t, attr: { "aria-pressed": String(v === value) } });
    b.toggleClass("is-active", v === value);
    b.addEventListener("click", (e) => {
      e.preventDefault();
      for (const x of buttons) { x.toggleClass("is-active", x === b); x.setAttr("aria-pressed", String(x === b)); }
      onChange(v);
    });
    return b;
  });
  return seg;
}
function taskCardToggle(parent: HTMLElement, label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const t = parent.createDiv({ cls: "checkbox-container", attr: { role: "switch", tabindex: "0", "aria-label": label, "aria-checked": String(value) } });
  t.toggleClass("is-enabled", value);
  const flip = () => { value = !value; t.toggleClass("is-enabled", value); t.setAttr("aria-checked", String(value)); onChange(value); };
  t.addEventListener("click", flip);
  t.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); } });
  return t;
}
function taskCardCheck(parent: HTMLElement, label: string, value: boolean, onChange: (v: boolean) => void): void {
  const l = parent.createEl("label", { cls: "agent-manager-taskcard-check" });
  const c = l.createEl("input", { type: "checkbox" });
  c.checked = value;
  c.addEventListener("change", () => onChange(c.checked));
  l.createSpan({ text: label });
}
