
import { import_obsidian } from "../externals.js";
import { BROWSER_VIEW_TYPE } from "../sessions/constants.js";
import { SessionActionMethods } from "../sessions/session-actions.js";
import { applyParts } from "../util/apply-parts.js";
import { BrowserMethods } from "./home.js";
import { ScheduledMethods } from "./scheduled.js";
import type { BrowserScope } from "./scheduled.js";
import type { WorkspaceLeaf } from "obsidian";
import type { BackendKey } from "../constants/backends.js";
import type { AgentManagerPlugin } from "../plugin/main.js";
type CardKind = "session" | "ticket";
class BrowserView extends import_obsidian.ItemView {
  declare plugin: AgentManagerPlugin;
  declare browserScope: BrowserScope;
  declare _closed: boolean;
  declare _nextRenderIsBackground: boolean | undefined;
  declare _renderIsBackground: boolean | undefined;
  declare _renderGen: number | undefined;
  declare _focusCard: CardKind | undefined;
  declare _titleDraft: string | undefined;
  declare _launchBackend: BackendKey | null | undefined;
  declare _launchAgent: { id: string; switched: string } | undefined;
  declare _revealCard: Partial<Record<CardKind, boolean>> | undefined;
  declare _revealAt: Partial<Record<CardKind, number>> | undefined;
  declare _cardClosing: Partial<Record<CardKind, boolean>> | undefined;
  declare _todayRan: string | undefined;
  declare _recentShown: number;
  declare _sessionSearch: string | undefined;
  declare _sessionDragId: string | null | undefined;
  declare _sessionDropBeforeId: string | null | undefined;
  declare _renamingId: string | null | undefined;
  declare _pausedOpen: boolean | undefined;
  declare _focusTaskCard: boolean | undefined;
  constructor(leaf: WorkspaceLeaf, plugin: AgentManagerPlugin) {
    super(leaf);
    this.plugin = plugin;
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
    this.registerInterval(window.setInterval(() => {
      const row = this.containerEl.querySelector<HTMLElement>(".agent-manager-today");
      if (row && row.dataset.day !== this.plugin.todayString()) this.renderBrowser({ background: true });
    }, 60 * 1000));
  }
  override async onClose(): Promise<void> {
    this._closed = true;
  }
}
interface Browser extends BrowserView, BrowserMethods, ScheduledMethods, SessionActionMethods {}
applyParts(BrowserView, BrowserMethods, ScheduledMethods, SessionActionMethods);
function isBrowser(v: unknown): v is Browser {
  return v instanceof BrowserView;
}
export { BrowserView, isBrowser };
export type { Browser, CardKind };
