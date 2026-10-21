// Small modals: the session switcher, a choice picker, a confirm, and the suggesters for
// a folder or a note typed into a field.

import { import_obsidian } from "../externals.js";
// The fast path to a session: every session in the vault, with "New session" first.
// Opened through a command, so the user picks its hotkey; the sessions are read before
// it opens, since a SuggestModal is synchronous.
var SessionSwitcherModal = class extends import_obsidian.SuggestModal {
  constructor(app, plugin, sessions) {
    super(app);
    this.plugin = plugin;
    this.sessions = sessions;
    this.setPlaceholder("Pick or start a session");
  }
  getSuggestions(query) {
    const q = query.toLowerCase();
    // "New session" is always offered first; typing filters existing sessions.
    const items = [{ isNew: true }, ...this.sessions];
    return items.filter((it) => it.isNew || String(it.displayName || "").toLowerCase().includes(q));
  }
  renderSuggestion(item, el) {
    if (item.isNew) {
      el.createEl("div", { text: "New session" });
      return;
    }
    el.createEl("div", { text: item.displayName || "Untitled" });
    el.createEl("small", { text: this.plugin.relativeTime(item.mtime), cls: "agent-manager-suggest-meta" });
  }
  onChooseSuggestion(item) {
    // A new session from here is "Untitled"; the sidebar is where to type a name.
    if (item.isNew) this.plugin.startSession("", null);
    else {
      const leaf = this.plugin.getLeafForSession(item.title, item.backend, item.sessionId);
      if (leaf) this.app.workspace.setActiveLeaf(leaf, { focus: true });
      else this.plugin.startResume(item, null);
    }
  }
};
// Generic single-choice picker (the import flow chains two). Items are arbitrary;
// label and sublabel are functions.
var ChoicePickerModal = class extends import_obsidian.SuggestModal {
  constructor(app, items, opts) {
    super(app);
    this.items = items || [];
    this.labelFn = opts.label;
    this.subFn = opts.sub || (() => "");
    this.onPick = opts.onPick;
    if (opts.placeholder) this.setPlaceholder(opts.placeholder);
  }
  getSuggestions(query) {
    const q = query.toLowerCase();
    return this.items.filter((it) => (this.labelFn(it) + " " + this.subFn(it)).toLowerCase().includes(q));
  }
  renderSuggestion(it, el) {
    el.createEl("div", { text: this.labelFn(it) });
    const sub = this.subFn(it);
    if (sub) el.createEl("small", { text: sub, cls: "agent-manager-suggest-meta" });
  }
  onChooseSuggestion(it) { this.onPick(it); }
};
var ConfirmModal = class extends import_obsidian.Modal {
  constructor(app, title, body, onConfirm, confirmLabel = "Delete", confirmCls = "mod-warning") {
    super(app);
    this._confirmCls = confirmCls;
    this._title = title;
    this._body = body;
    this._onConfirm = onConfirm;
    this._confirmLabel = confirmLabel;
  }
  onOpen() {
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
  onClose() {
    this.contentEl.empty();
  }
};
// Suggests vault folders and notes for a text field, as the user types. `filter(file)`
// says which are offered; `onPick(file)` hears the choice. Up to 50, folders and notes
// whose path contains what's typed, shortest paths first.
var PathSuggest = class extends import_obsidian.AbstractInputSuggest {
  constructor(app, inputEl, { folders = true, notes = true, filter = null, onPick = null } = {}) {
    super(app, inputEl);
    this.inputEl = inputEl;
    this.opts = { folders, notes, filter, onPick };
  }
  getSuggestions(query) {
    const q = String(query || "").toLowerCase();
    const out = [];
    for (const f of this.app.vault.getAllLoadedFiles()) {
      const isFolder = f instanceof import_obsidian.TFolder;
      if (isFolder ? (!this.opts.folders || f.isRoot()) : !(this.opts.notes && f instanceof import_obsidian.TFile && f.extension === "md")) continue;
      if (this.opts.filter && !this.opts.filter(f)) continue;
      if (q && !f.path.toLowerCase().includes(q)) continue;
      out.push(f);
    }
    out.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
    return out.slice(0, 50);
  }
  renderSuggestion(file, el) {
    const row = el.createDiv({ cls: "agent-manager-suggest-path" });
    const icon = row.createSpan({ cls: "agent-manager-suggest-icon" });
    import_obsidian.setIcon(icon, file instanceof import_obsidian.TFolder ? "folder" : "file-text");
    row.createSpan({ text: file.path });
  }
  // Whether the list is showing, so a field's own Enter can leave it to the list.
  open() {
    super.open();
    this.isOpen = true;
  }
  close() {
    super.close();
    this.isOpen = false;
  }
  selectSuggestion(file) {
    this.inputEl.value = file.path;
    this.inputEl.trigger("input");
    this.inputEl.trigger("change");
    this.opts.onPick?.(file);
    this.close();
  }
};
// Folders only, for a setting.
var FolderSuggest = class extends PathSuggest {
  constructor(app, inputEl) {
    super(app, inputEl, { folders: true, notes: false });
  }
};
export { FolderSuggest, PathSuggest, ChoicePickerModal, ConfirmModal, SessionSwitcherModal };
