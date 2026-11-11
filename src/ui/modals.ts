
import { import_obsidian } from "../externals.js";
import type { App, TAbstractFile, TFile, TFolder } from "obsidian";
import type { AgentManagerPlugin } from "../plugin/main.js";
import type { SessionRecord } from "../types.js";
import { notice } from "../vault-terminal/notice";

type SwitcherItem = { isNew: true } | (SessionRecord & { isNew?: undefined });
interface ChoicePickerOptions<T> {
  label: (it: T) => string;
  sub?: (it: T) => string;
  onPick: (it: T) => unknown;
  placeholder?: string;
}
class SessionSwitcherModal extends import_obsidian.SuggestModal<SwitcherItem> {
  declare plugin: AgentManagerPlugin;
  declare sessions: SessionRecord[];
  constructor(app: App, plugin: AgentManagerPlugin, sessions: SessionRecord[]) {
    super(app);
    this.plugin = plugin;
    this.sessions = sessions;
    this.setPlaceholder("Pick or start a session");
  }
  getSuggestions(query: string): SwitcherItem[] {
    const q = query.toLowerCase();
    const items: SwitcherItem[] = [{ isNew: true }, ...this.sessions];
    return items.filter((it) => it.isNew || String(it.displayName || "").toLowerCase().includes(q));
  }
  renderSuggestion(item: SwitcherItem, el: HTMLElement): void {
    if (item.isNew) {
      el.createDiv({ text: "New session" });
      return;
    }
    el.createDiv({ text: item.displayName || "Untitled" });
    el.createEl("small", { text: this.plugin.relativeTime(item.mtime), cls: "agent-manager-suggest-meta" });
  }
  onChooseSuggestion(item: SwitcherItem): void {
    if (item.isNew) void this.plugin.startSession("", null);
    else {
      const leaf = this.plugin.getLeafForSession(item.title, item.backend, item.sessionId);
      if (leaf) this.app.workspace.setActiveLeaf(leaf, { focus: true });
      else void this.plugin.startResume(item, null);
    }
  }
}
class ChoicePickerModal<T> extends import_obsidian.SuggestModal<T> {
  declare items: T[];
  declare labelFn: (it: T) => string;
  declare subFn: (it: T) => string;
  declare onPick: (it: T) => unknown;
  constructor(app: App, items: T[] | null | undefined, opts: ChoicePickerOptions<T>) {
    super(app);
    this.items = items || [];
    this.labelFn = opts.label;
    this.subFn = opts.sub || (() => "");
    this.onPick = opts.onPick;
    if (opts.placeholder) this.setPlaceholder(opts.placeholder);
  }
  getSuggestions(query: string): T[] {
    const q = query.toLowerCase();
    return this.items.filter((it) => (this.labelFn(it) + " " + this.subFn(it)).toLowerCase().includes(q));
  }
  renderSuggestion(it: T, el: HTMLElement): void {
    el.createDiv({ text: this.labelFn(it) });
    const sub = this.subFn(it);
    if (sub) el.createEl("small", { text: sub, cls: "agent-manager-suggest-meta" });
  }
  onChooseSuggestion(it: T): void { this.onPick(it); }
}
class ConfirmModal extends import_obsidian.Modal {
  declare _confirmCls: string;
  declare _title: string;
  declare _body: string;
  declare _onConfirm: () => void;
  declare _confirmLabel: string;
  constructor(app: App, title: string, body: string, onConfirm: () => void, confirmLabel = "Delete", confirmCls = "mod-warning") {
    super(app);
    this._confirmCls = confirmCls;
    this._title = title;
    this._body = body;
    this._onConfirm = onConfirm;
    this._confirmLabel = confirmLabel;
  }
  override onOpen(): void {
    this.titleEl.setText(this._title);
    this.contentEl.createEl("p", { text: this._body });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const confirm = buttons.createEl("button", { text: this._confirmLabel, cls: this._confirmCls });
    confirm.addEventListener("click", () => {
      this.close();
      this._onConfirm();
    });
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}
class SetupChoiceModal extends import_obsidian.Modal {
  declare _onResume: () => void;
  declare _onFresh: () => void;
  constructor(app: App, onResume: () => void, onFresh: () => void) {
    super(app);
    this._onResume = onResume;
    this._onFresh = onFresh;
  }
  override onOpen(): void {
    this.titleEl.setText("Set up this vault");
    this.contentEl.createEl("p", { text: "You've started setting up this vault before. Pick up where that session left off, or start a fresh one, which looks at what's already done and offers only the rest." });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const fresh = buttons.createEl("button", { text: "Start fresh" });
    fresh.addEventListener("click", () => { this.close(); this._onFresh(); });
    const resume = buttons.createEl("button", { text: "Resume", cls: "mod-cta" });
    resume.addEventListener("click", () => { this.close(); this._onResume(); });
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}
const MAX_SUGGESTIONS = 200;
abstract class PathSuggest<T extends TAbstractFile> extends import_obsidian.AbstractInputSuggest<T> {
  declare inputEl: HTMLInputElement;
  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.inputEl = inputEl;
  }
  abstract candidates(): T[];
  getSuggestions(query: string): T[] {
    const q = String(query || "").toLowerCase();
    return this.candidates()
      .filter((f) => f.path.toLowerCase().includes(q))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, MAX_SUGGESTIONS);
  }
  renderSuggestion(f: T, el: HTMLElement): void {
    el.setText(f.path);
  }
  override selectSuggestion(f: T): void {
    this.setValue(f.path);
    this.inputEl.trigger("input");
    this.inputEl.trigger("change");
    this.close();
  }
}
class FolderSuggest extends PathSuggest<TFolder> {
  candidates(): TFolder[] { return this.app.vault.getAllFolders(false); }
}
class FileSuggest extends PathSuggest<TFile> {
  declare extensions: string[];
  constructor(app: App, inputEl: HTMLInputElement, extensions: string[] = ["md"]) {
    super(app, inputEl);
    this.extensions = extensions;
  }
  candidates(): TFile[] { return this.app.vault.getFiles().filter((f) => this.extensions.includes(f.extension)); }
}
class ReadsSuggest extends import_obsidian.AbstractInputSuggest<TAbstractFile> {
  declare inputEl: HTMLInputElement;
  declare onPick: (f: TAbstractFile) => void;
  constructor(app: App, inputEl: HTMLInputElement, onPick: (f: TAbstractFile) => void) {
    super(app, inputEl);
    this.inputEl = inputEl;
    this.onPick = onPick;
  }
  getSuggestions(query: string): TAbstractFile[] {
    const q = String(query || "").toLowerCase();
    const text = /^(md|txt|csv|json|ya?ml)$/i;
    const all: TAbstractFile[] = [...this.app.vault.getAllFolders(false), ...this.app.vault.getFiles().filter((f) => text.test(f.extension))];
    return all.filter((f) => f.path.toLowerCase().includes(q)).sort((a, b) => a.path.localeCompare(b.path)).slice(0, MAX_SUGGESTIONS);
  }
  renderSuggestion(f: TAbstractFile, el: HTMLElement): void {
    el.setText(f instanceof import_obsidian.TFolder ? `${f.path}/` : f.path);
  }
  override selectSuggestion(f: TAbstractFile): void {
    this.onPick(f);
    this.setValue("");
    this.close();
  }
}
interface NewAgentFields { name: string; instructions: string; home: string; dailyName: string }
class AgentModal extends import_obsidian.Modal {
  declare _problem: (name: string) => string | null;
  declare _onAdd: (fields: NewAgentFields) => Promise<void>;
  declare _dailyPlaceholder: string;
  constructor(app: App, problem: (name: string) => string | null, onAdd: (fields: NewAgentFields) => Promise<void>, dailyPlaceholder: string) {
    super(app);
    this._problem = problem;
    this._onAdd = onAdd;
    this._dailyPlaceholder = dailyPlaceholder;
  }
  override onOpen(): void {
    this.titleEl.setText("Add an agent profile");
    const f: NewAgentFields = { name: "", instructions: "", home: "", dailyName: "" };
    const { contentEl } = this;
    const nameRow = new import_obsidian.Setting(contentEl).setName("Name").setDesc("Its transcripts go in a folder of this name.")
      .addText((t) => { t.setPlaceholder("Personal").onChange((v) => { f.name = v; }); });
    new import_obsidian.Setting(contentEl).setName("Instructions note").setDesc("The note that says who this agent profile is and how it works.")
      .addText((t) => { t.setPlaceholder("Agents/Personal.md").onChange((v) => { f.instructions = v; }); new FileSuggest(this.app, t.inputEl, ["md"]); });
    new import_obsidian.Setting(contentEl).setName("Agent folder").setDesc("A session started from a note or folder in here starts with this agent profile. Empty for none; / for the whole vault.")
      .addText((t) => { t.setPlaceholder("None").onChange((v) => { f.home = v; }); new FolderSuggest(this.app, t.inputEl); });
    new import_obsidian.Setting(contentEl).setName("Daily chat name").setDesc("{{profile}} is its name, {{date}} today's date.")
      .addText((t) => { t.setPlaceholder(this._dailyPlaceholder).onChange((v) => { f.dailyName = v; }); });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const add = buttons.createEl("button", { text: "Add", cls: "mod-cta" });
    const submit = () => {
      const problem = this._problem(f.name);
      if (problem) { notice(problem); return; }
      void this._onAdd(f).then(() => this.close());
    };
    add.addEventListener("click", submit);
    contentEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing && !document.querySelector(".suggestion-container")) { e.preventDefault(); submit(); }
    });
    window.setTimeout(() => nameRow.controlEl.querySelector("input")?.focus(), 0);
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}
export { AgentModal, FileSuggest, FolderSuggest, ReadsSuggest, ChoicePickerModal, ConfirmModal, SessionSwitcherModal, SetupChoiceModal };
export type { NewAgentFields };
