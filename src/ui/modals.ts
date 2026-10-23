// Small modals: the session switcher, a choice picker, a confirm, and the suggesters for
// a folder or a note typed into a field.

import { import_obsidian } from "../externals.js";
import type { App, TFolder } from "obsidian";
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
// Suggests vault folders for a setting's text field, as the user types: up to 50 whose
// path contains what's typed, shortest paths first. Folders only, asked of Obsidian as
// folders (getAllFolders), so no file in the vault is listed to find them.
class FolderSuggest extends import_obsidian.AbstractInputSuggest<TFolder> {
  declare inputEl: HTMLInputElement;
  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.inputEl = inputEl;
  }
  getSuggestions(query: string): TFolder[] {
    const q = String(query || "").toLowerCase();
    const out = this.app.vault.getAllFolders(false).filter((f) => !q || f.path.toLowerCase().includes(q));
    out.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
    return out.slice(0, 50);
  }
  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    const row = el.createDiv({ cls: "agent-manager-suggest-path" });
    import_obsidian.setIcon(row.createSpan({ cls: "agent-manager-suggest-icon" }), "folder");
    row.createSpan({ text: folder.path });
  }
  override selectSuggestion(folder: TFolder): void {
    this.inputEl.value = folder.path;
    this.inputEl.trigger("input");
    this.inputEl.trigger("change");
    this.close();
  }
}
export { FolderSuggest, ChoicePickerModal, ConfirmModal, SessionSwitcherModal };
