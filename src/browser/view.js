// The session browser: the sidebar. A view of its own, apart from the session terminal.

import { import_obsidian } from "../externals.js";
import { BROWSER_VIEW_TYPE } from "../sessions/constants.js";
import { SessionActionMethods } from "../sessions/session-actions.js";
import { applyParts } from "../util/apply-parts.js";
import { BrowserMethods } from "./home.js";
var BrowserView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    // Where the browser is: null is the home page, its only page so far. Not saved.
    this.browserScope = null;
    this._closed = false;
  }
  getViewType() {
    return BROWSER_VIEW_TYPE;
  }
  getDisplayText() {
    return "Agent Manager";
  }
  getIcon() {
    return "bot";
  }
  async onOpen() {
    try {
      this.renderBrowser();
    } catch (err) {
      console.error("[Agent Manager] Failed to render browser:", err);
    }
    // A new day redraws the sidebar, so Daily Chat shows the new date and the new day's
    // chat. Checked each minute rather than timed for midnight, so a Mac asleep at
    // midnight catches up when it wakes.
    this.registerInterval(window.setInterval(() => {
      const row = this.containerEl.querySelector(".agent-manager-today");
      if (row && row.dataset.day !== this.plugin.todayString()) this.renderBrowser({ background: true });
    }, 60 * 1000));
  }
  async onClose() {
    this._closed = true;
  }
};
applyParts(BrowserView, BrowserMethods, SessionActionMethods);
export { BrowserView };
