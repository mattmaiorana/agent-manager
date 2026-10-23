// Small modals: the session switcher, a choice picker, a confirm, and the suggesters for
// a folder or a note typed into a field.

import { import_obsidian } from "../externals.js";
import type { App, TAbstractFile, TFile, TFolder } from "obsidian";
import type { AgentManagerPlugin } from "../plugin/main.js";
import type { SessionRecord } from "../types.js";

// What the switcher lists: "New session", then each session (which has no isNew).
type SwitcherItem = { isNew: true } | (SessionRecord & { isNew?: undefined });
// What a choice picker is told: how to label an item, and what to do with the pick.
interface ChoicePickerOptions<T> {
  label: (it: T) => string;
  sub?: (it: T) => string;
  // What it returns is ignored.
  onPick: (it: T) => unknown;
  placeholder?: string;
}
// The fast path to a session: every session in the vault, with "New session" first.
// Opened through a command, so the user picks its hotkey; the sessions are read before
// it opens, since a SuggestModal is synchronous.
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
    // "New session" is always offered first; typing filters existing sessions.
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
    // A new session from here is "Untitled"; the sidebar is where to type a name.
    if (item.isNew) void this.plugin.startSession("", null);
    else {
      const leaf = this.plugin.getLeafForSession(item.title, item.backend, item.sessionId);
      if (leaf) this.app.workspace.setActiveLeaf(leaf, { focus: true });
      else void this.plugin.startResume(item, null);
    }
  }
}
// Generic single-choice picker (the import flow chains two). Items are arbitrary;
// label and sublabel are functions.
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
// Path autocomplete for a setting's text field, on Obsidian's own suggestion popup
// (AbstractInputSuggest: its position, keys, and closing are Obsidian's), the way Calendar
// Plus does it: every match, alphabetical, plain text, at most 200 so a large vault stays
// fast. Picking one writes it in and fires input and change, so the field saves.
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
// Folders (asked of Obsidian as folders, so no file is listed to find them), the root aside.
class FolderSuggest extends PathSuggest<TFolder> {
  candidates(): TFolder[] { return this.app.vault.getAllFolders(false); }
}
// Notes, or with `extensions`, any of those kinds of file (a base, say).
class FileSuggest extends PathSuggest<TFile> {
  declare extensions: string[];
  constructor(app: App, inputEl: HTMLInputElement, extensions: string[] = ["md"]) {
    super(app, inputEl);
    this.extensions = extensions;
  }
  candidates(): TFile[] { return this.app.vault.getFiles().filter((f) => this.extensions.includes(f.extension)); }
}
export { FileSuggest, FolderSuggest, ChoicePickerModal, ConfirmModal, SessionSwitcherModal };
