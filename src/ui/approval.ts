
import type { App } from "obsidian";
import { import_obsidian } from "../externals.js";
import { CLI_BACKENDS, isBackendKey } from "../constants/backends.js";
import { reachFacts } from "../scheduled/reach-facts.js";
import type { TaskView } from "../plugin/scheduler.js";

export class ApprovalModal extends import_obsidian.Modal {
  declare _view: TaskView;
  declare _vaultName: string;
  declare _done: (ok: boolean) => void;
  declare _answered: boolean;
  declare _onEdit: (() => void) | undefined;
  constructor(app: App, view: TaskView, vaultName: string, done: (ok: boolean) => void, onEdit?: () => void) {
    super(app);
    this._onEdit = onEdit;
    this._view = view;
    this._vaultName = vaultName;
    this._done = done;
    this._answered = false;
  }
  override onOpen(): void {
    const v = this._view;
    const t = v.task;
    this.modalEl.addClass("agent-manager-approval");
    this.titleEl.setText(`Approve “${t.label}” on this computer?`);
    const c = this.contentEl;
    c.createEl("p", { text: "A run of this task is a Claude Code session with nobody watching, held to what's below. Approve it to let it run here, now and on its schedule. If any of this changes, it waits for approval again." });
    const buttons = c.createDiv({ cls: "modal-button-container agent-manager-approval-buttons" });
    buttons.createEl("button", { text: "Approve", cls: "mod-cta" }).addEventListener("click", () => {
      this._answered = true;
      this._done(true);
      this.close();
    });
    if (this._onEdit) buttons.createEl("button", { text: "Edit" }).addEventListener("click", () => { this.close(); this._onEdit?.(); });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const label = isBackendKey(v.reach.backend) ? CLI_BACKENDS[v.reach.backend].label : v.reach.backend;
    const dl = c.createDiv({ cls: "agent-manager-task-facts" });
    for (const [k, items] of reachFacts(t, v.reach, label)) {
      dl.createDiv({ cls: "agent-manager-task-key", text: k });
      const dd = dl.createDiv({ cls: "agent-manager-task-value" });
      const verbatim = k === "Prompt";
      for (const x of items) dd.createDiv({ cls: verbatim ? "agent-manager-approval-verbatim" : "", text: x });
    }
    const notes = c.createEl("ul", { cls: "agent-manager-approval-notes" });
    notes.createEl("li", { cls: "mod-warning", text: "A full session run is an ordinary Claude Code session with nobody watching: auto mode decides each action, and it can do what any session of yours can, sending through its connectors included, unless your vault's own rules say otherwise. Approve it only if you'd let a session do this prompt unattended." });
    notes.createEl("li", { text: "Approving covers what's above. Your settings, hooks, MCP servers, the vault's AGENTS.md, and CLAUDE.md are read live at each run, and can change without asking again." });
    if (v.reach.connectors !== "none" && v.reach.web.search) notes.createEl("li", { text: "With connectors and the open web together, a page it reads could steer what it does with your mail or messages. For a task that reads email or Slack, deny WebFetch and WebSearch." });
  }
  override onClose(): void {
    this.contentEl.empty();
    if (!this._answered) { this._answered = true; this._done(false); }
  }
}
