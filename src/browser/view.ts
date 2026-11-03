// The session browser: the sidebar. A view of its own, apart from the session terminal.
// Its parts (the home page, rename) are applied to it. Its full type, with every part's
// methods, is Browser (below).

import { import_obsidian } from "../externals.js";
import { BROWSER_VIEW_TYPE } from "../sessions/constants.js";
import { SessionActionMethods } from "../sessions/session-actions.js";
import { applyParts } from "../util/apply-parts.js";
import { BrowserMethods } from "./home.js";
import type { WorkspaceLeaf } from "obsidian";
import type { BackendKey } from "../constants/backends.js";
import type { AgentManagerPlugin } from "../plugin/main.js";
// The sidebar's cards, each opened by its row: New session and New ticket.
type CardKind = "session" | "ticket";
// The view Obsidian makes. The parts and every method here that calls one take `this` as
// Browser.
class BrowserView extends import_obsidian.ItemView {
  // Every field the class or a part sets on the sidebar. `declare` adds no code: each is
  // set where it always was (the first three in the constructor), and unset until then.
  declare plugin: AgentManagerPlugin;
  declare browserScope: null;
  declare _closed: boolean;
  // Rendering (home.ts).
  declare _nextRenderIsBackground: boolean | undefined;
  declare _renderIsBackground: boolean | undefined;
  declare _renderGen: number | undefined;
  // The card a click just opened, whose first field takes the focus on the next render.
  declare _focusCard: CardKind | undefined;
  // The New session card: its typed name, its CLI pick, and its agent profile pick (with
  // the switch's choice when it was made).
  declare _titleDraft: string | undefined;
  declare _launchBackend: BackendKey | null | undefined;
  declare _launchAgent: { id: string; switched: string } | undefined;
  // Each card: the next render's card grows down (a click just opened it), when the card
  // that did first reached the screen, and whether it's folding up (closeCard), so a
  // render draws it closed.
  declare _revealCard: Partial<Record<CardKind, boolean>> | undefined;
  declare _revealAt: Partial<Record<CardKind, number>> | undefined;
  declare _cardClosing: Partial<Record<CardKind, boolean>> | undefined;
  // The name today's chat ran under, once it has.
  declare _todayRan: string | undefined;
  // Recent: how many closed sessions show (unset until the first render sets it, which
  // its check reads as unset), and the search typed.
  declare _recentShown: number;
  declare _sessionSearch: string | undefined;
  // Dragging a row, and the row being renamed, by session id.
  declare _sessionDragId: string | null | undefined;
  declare _sessionDropBeforeId: string | null | undefined;
  declare _renamingId: string | null | undefined;
  constructor(leaf: WorkspaceLeaf, plugin: AgentManagerPlugin) {
    super(leaf);
    this.plugin = plugin;
    // Where the browser is: null is the home page, its only page so far. Not saved.
    this.browserScope = null;
    this._closed = false;
  }
  getViewType(): string {
    return BROWSER_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Agent Manager";
  }
  override getIcon(): string {
    return "bot";
  }
  override async onOpen(this: Browser): Promise<void> {
    try {
      this.renderBrowser();
    } catch (err) {
      console.error("[Agent Manager] Failed to render browser:", err);
    }
    // A new day redraws the sidebar, so Daily Chat shows the new date and the new day's
    // chat. Checked each minute rather than timed for midnight, so a Mac asleep at
    // midnight catches up when it wakes. The row is a div renderTodayRow made.
    this.registerInterval(window.setInterval(() => {
      const row = this.containerEl.querySelector<HTMLElement>(".agent-manager-today");
      if (row && row.dataset.day !== this.plugin.todayString()) this.renderBrowser({ background: true });
    }, 60 * 1000));
  }
  override async onClose(): Promise<void> {
    this._closed = true;
  }
}
// The sidebar's type: the view, and every part's methods, which applyParts puts on the
// class's prototype below. It is the host session-actions asks for (the plugin and the
// app).
interface Browser extends BrowserView, BrowserMethods, SessionActionMethods {}
applyParts(BrowserView, BrowserMethods, SessionActionMethods);
// Is this a loaded sidebar? instanceof finds the class; applyParts above gave every
// instance the parts, which is what Browser adds.
function isBrowser(v: unknown): v is Browser {
  return v instanceof BrowserView;
}
export { BrowserView, isBrowser };
export type { Browser, CardKind };
