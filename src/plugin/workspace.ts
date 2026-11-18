
import type { TFile, View, Workspace, WorkspaceLeaf, WorkspaceParent, WorkspaceWindow } from "obsidian";
import { import_obsidian } from "../externals.js";
import { BrowserView, isBrowser } from "../browser/view.js";
import { BROWSER_VIEW_TYPE, PLAIN_TERMINAL_VIEW_TYPE, SESSION_VIEW_TYPE } from "../sessions/constants.js";
import { isSession } from "../sessions/controller.js";
import { SessionSwitcherModal } from "../ui/modals.js";
import { CLI_BACKENDS } from "../constants/backends.js";
const PEER_FORGET_MS = 30 * 60 * 1000;
import type { BackendKey } from "../constants/backends.js";
import type { Browser, OpenSession, SavedSessionState, Session, SessionRecord } from "../types.js";
import type { AgentManagerPlugin } from "./main.js";
import type { WorkspaceInternals } from "../obsidian-internals.js";
import { notice } from "../vault-terminal/notice";

interface ElectronBounds { x: number; y: number; width: number; height: number }
interface ElectronWindow {
  isFullScreen(): boolean; getBounds(): ElectronBounds; setBounds(bounds: ElectronBounds): void;
  isMinimized(): boolean; restore(): void; focus(): void;
  webContents: { getZoomFactor(): number };
}
const MIN_MAIN_WIDTH = 500;
const MIN_POPOUT = 600;
const MIN_COLUMN = 200;

function firstLeafOf(item: unknown): WorkspaceLeaf | null {
  if (item instanceof import_obsidian.WorkspaceLeaf) return item;
  const kids = (item as { children?: unknown[] } | null)?.children;
  return kids?.length ? firstLeafOf(kids[0]) : null;
}

class WorkspaceMethods {
  _browserLeaves(this: AgentManagerPlugin): WorkspaceLeaf[] {
    return this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE);
  }
  browserViews(this: AgentManagerPlugin): Browser[] {
    return this._browserLeaves().map((l) => l.view).filter((v) => isBrowser(v));
  }
  sessionLeaves(this: AgentManagerPlugin): WorkspaceLeaf[] {
    const ws = this.app.workspace;
    return ws.getLeavesOfType(SESSION_VIEW_TYPE);
  }
  sessionOf(this: AgentManagerPlugin, x: WorkspaceLeaf | View | Session | null | undefined): Session | null {
    if (!x) return null;
    if (isSession(x)) return x;
    const v = x instanceof import_obsidian.WorkspaceLeaf ? x.view : x;
    const controller = v && (v as { controller?: unknown }).controller;
    if (v && isSession(controller)) return controller;
    return null;
  }
  sessionObjects(this: AgentManagerPlugin): Session[] {
    return this.sessionLeaves().map((l) => this.sessionOf(l)).filter((v) => v !== null);
  }
  isSessionView(this: AgentManagerPlugin, v: WorkspaceLeaf | View | Session | null | undefined): boolean {
    return !!this.sessionOf(v);
  }
  savedSessionState(this: AgentManagerPlugin, leaf: WorkspaceLeaf): SavedSessionState | null {
    let vs;
    try { vs = leaf.getViewState?.(); } catch { return null; }
    if (!vs) return null;
    if (vs.type === SESSION_VIEW_TYPE) return (vs.state && vs.state.host) || {};
    return null;
  }
  async updateSavedSession(this: AgentManagerPlugin, leaf: WorkspaceLeaf, change: (fields: SavedSessionState) => boolean): Promise<void> {
    const vs = leaf.getViewState?.();
    if (!vs) return;
    let fields: SavedSessionState | null = null;
    if (vs.type === SESSION_VIEW_TYPE) { vs.state = vs.state || {}; fields = vs.state.host = (vs.state.host || {}) as SavedSessionState; }
    if (!fields || !change(fields)) return;
    await leaf.setViewState(vs);
    this.app.workspace.requestSaveLayout();
  }
  findBrowserLeaf(this: AgentManagerPlugin): WorkspaceLeaf | null {
    const inWindow = this.windowBrowserLeaf();
    if (inWindow && inWindow.getContainer()?.win === activeWindow) return inWindow;
    return this.mainBrowserLeaf() ?? inWindow;
  }
  mainBrowserLeaf(this: AgentManagerPlugin): WorkspaceLeaf | null {
    return this._browserLeaves().find((l) => !(l.getContainer() instanceof import_obsidian.WorkspaceWindow)) ?? null;
  }
  windowBrowserLeaf(this: AgentManagerPlugin): WorkspaceLeaf | null {
    return this._browserLeaves().find((l) => l.getContainer() instanceof import_obsidian.WorkspaceWindow) ?? null;
  }
  dedupeBrowserLeaves(this: AgentManagerPlugin, keeper: WorkspaceLeaf | null): void {
    const browsers = this._browserLeaves();
    if (browsers.length < 2) return;
    const out = (l: WorkspaceLeaf) => l.getContainer() instanceof import_obsidian.WorkspaceWindow;
    for (const side of [false, true]) {
      const these = browsers.filter((l) => out(l) === side);
      const keep = keeper && these.includes(keeper) ? keeper : these[0];
      for (const l of these) if (l !== keep) { try { l.detach(); } catch { /* empty */ } }
    }
  }
  async createBrowserTab(this: AgentManagerPlugin, quiet = false): Promise<void> {
    if (!this.layoutReady) return;
    const existing = this.mainBrowserLeaf();
    if (existing) { void this.app.workspace.revealLeaf(existing); return; }
    if (this._browserCreateInFlight) return;
    this._browserCreateInFlight = true;
    try {
      const leaf = this.app.workspace.getLeftLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: BROWSER_VIEW_TYPE, active: !quiet });
      if (!quiet) void this.app.workspace.revealLeaf(leaf);
      this.dedupeBrowserLeaves(leaf);
    } finally {
      this._browserCreateInFlight = false;
    }
  }
  async revealBrowser(this: AgentManagerPlugin): Promise<void> {
    if (!this.layoutReady) return;
    const existing = this.findBrowserLeaf();
    if (existing && existing === this.windowBrowserLeaf() && this._windowSidebarHidden) this.foldWindowSidebar(false);
    if (existing) {
      if (isBrowser(existing.view)
          && this.activeLeaf() === existing && existing.view.browserScope) {
        try { existing.view.goHome(); } catch { /* empty */ }
      }
      void this.app.workspace.revealLeaf(existing);
      this.app.workspace.setActiveLeaf(existing, { focus: true });
      return;
    }
    await this.createBrowserTab();
  }
  async openSessionSwitcher(this: AgentManagerPlugin): Promise<void> {
    let sessions: SessionRecord[] = [];
    try { sessions = await this.listedSessions(); } catch { /* empty */ }
    new SessionSwitcherModal(this.app, this, sessions).open();
  }
  refreshBrowsers(this: AgentManagerPlugin): void {
    try { this.syncTicketActions(); } catch { /* empty */ }
    for (const v of this.browserViews()) {
      void v.reresolveScope().catch(() => {}).then(() => {
        try { v.renderBrowser({ background: true }); } catch { /* empty */ }
      });
    }
  }
  refreshWorkingDots(this: AgentManagerPlugin): void {
    const open = this.getOpenSessions();
    if (!open.length) return;
    const working = open.filter((o) => this.sessionIsWorking(o.view));
    const workingKeys = new Set(working.map((o) => this.openSessionKey(o)));
    const nowMs = Date.now();
    for (const o of open) {
      const v = o.view;
      if (!v) continue;
      const isW = working.includes(o);
      if (isW) v._sessionInteractive = true;
      const edge = v._wasWorking && !isW;
      if (edge) v._detectRehostedSession?.().catch(() => {});
      const stale = nowMs - (v._modelRefreshedAt || 0) > 30000;
      if (edge || stale) {
        v._modelRefreshedAt = nowMs;
        try { void v.updateStripModel(); } catch { /* empty */ }
      }
      let grew = false;
      if (nowMs - (v._durableCheckedAt || 0) > 30000) {
        v._durableCheckedAt = nowMs;
        grew = !!v.transcriptGrewSinceReconcile?.();
      }
      const retryDue = !v._durableCaughtUp && nowMs >= (v._durableRetryAt || 0);
      if (edge || retryDue || grew) {
        void v.updateDurableTranscript?.();
        v._durableCaughtUp = !!v._modelFile;
        if (v._durableCaughtUp) v._durableMisses = 0;
        else {
          const misses = (v._durableMisses = (v._durableMisses || 0) + 1);
          v._durableRetryAt = nowMs + (misses < 15 ? 0 : misses < 40 ? 3000 : 15000);
        }
      }
      if (v._notePath && !v._noteWritten && (edge || nowMs - (v._noteTriedAt || 0) > 3000)) {
        v._noteTriedAt = nowMs;
        void v.maybeWriteNoteBack?.();
      }
      if (!v._ticketDone && (edge || nowMs - (v._ticketTriedAt || 0) > 3000)) {
        v._ticketTriedAt = nowMs;
        void v.maybeWriteTicketBack?.();
      } else if (edge) void v.maybeWriteTicketBack?.();
      v._wasWorking = isW;
    }
    this._seenWorking = this._seenWorking || new Set();
    for (const key of workingKeys) {
      if (this._seenWorking.has(key)) continue;
      this._seenWorking.add(key);
      this.scheduleTimeout(() => {
        for (const v of this.browserViews()) {
          if (v.containerEl.querySelector('.agent-manager-session-row[data-session-id=""]')) { try { v.renderBrowser({ background: true }); } catch { /* empty */ } }
        }
      }, 1500);
    }
    for (const view of this.browserViews()) {
      try { view.refreshTodayDot(); } catch { /* empty */ }
    }
  }
  sessionIsWorking(this: AgentManagerPlugin, view: Session | null | undefined): boolean {
    const now = Date.now();
    const said = view?.programState;
    if (view?.getBackendKey?.() === "claude" && (said === "working" || said === "waiting" || said === "idle" || said === "finished" || said === "error")) return said === "working";
    if (now - (view?.lastWorkOutputAt || 0) > 2000) return false;
    if (/^[\u2000-\u2bff]/.test(view?._lastTitle || "")) return true;
    const rows = view?._terminalTailText ? view._terminalTailText(12).split("\n") : [];
    for (const raw of rows) {
      const line = raw.toLowerCase();
      if (line.includes("esc to interrupt") || line.includes("esc to cancel")) return true;
      if (/…\s*\(\d+m?\s*\d*s[\s·)]/.test(raw)) return true;
    }
    return now - (view?.lastUserInputAt || 0) > 1500;
  }
  openSetSignature(this: AgentManagerPlugin): string {
    return [...this.getOpenSessionKeys()].sort().join("|");
  }
  scheduleStatusRefresh(this: AgentManagerPlugin): void {
    if (this._statusRefreshTimer) return;
    this._statusRefreshTimer = this.scheduleTimeout(() => {
      this._statusRefreshTimer = null;
      const sig = this.openSetSignature();
      if (sig === this._lastOpenSig) return;
      this._lastOpenSig = sig;
      this.refreshBrowsers();
    }, 60);
  }
  useDedicatedSplit(this: AgentManagerPlugin): boolean {
    return this.pluginData.dedicatedTerminalSplit !== false;
  }
  isInMainArea(this: AgentManagerPlugin, node: WorkspaceLeaf | WorkspaceParent | null | undefined): boolean {
    const root = this.app.workspace.rootSplit;
    for (let n: WorkspaceLeaf | WorkspaceParent | null | undefined = node; n; n = n.parent) if (n === root) return true;
    return false;
  }
  terminalLeaves(this: AgentManagerPlugin): WorkspaceLeaf[] {
    return [...this.sessionLeaves(), ...this.app.workspace.getLeavesOfType(PLAIN_TERMINAL_VIEW_TYPE)];
  }
  getTerminalGroup(this: AgentManagerPlugin): WorkspaceParent | null {
    const win = this.agentWindow();
    let beside: WorkspaceParent | null = null;
    for (const leaf of this.terminalLeaves()) {
      const group = leaf.parent;
      if (group?.type !== "tabs") continue;
      if (!win) { if (this.isInMainArea(leaf)) return group; continue; }
      if (leaf.getContainer() !== win) continue;
      if (!(group.children as WorkspaceLeaf[]).some((l) => l.getViewState?.().type === BROWSER_VIEW_TYPE)) return group;
      beside = beside || group;
    }
    return beside;
  }
  async revealAndFlash(this: AgentManagerPlugin, leaf: WorkspaceLeaf): Promise<void> {
    await this.app.workspace.revealLeaf(leaf);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    const header = leaf.tabHeaderEl;
    if (!header || header.hasClass("is-flashing")) return;
    header.addClass("is-flashing");
    header.win.setTimeout(() => header.removeClass("is-flashing"), 750);
  }
  isOurView(this: AgentManagerPlugin, v: View | null | undefined): boolean {
    const type = v?.getViewType?.();
    return this.isSessionView(v) || v instanceof BrowserView || type === SESSION_VIEW_TYPE || type === PLAIN_TERMINAL_VIEW_TYPE;
  }
  shownNotesLeaf(this: AgentManagerPlugin): WorkspaceLeaf | null {
    const termGroup = this.useDedicatedSplit() ? this.getTerminalGroup() : null;
    let best = null as WorkspaceLeaf | null, bestShown = false, bestTime = -1;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!this.isInMainArea(leaf) || leaf.parent?.type !== "tabs" || (termGroup && leaf.parent === termGroup) || this.isOurView(leaf.view)) return;
      const shown = leaf.view?.containerEl?.offsetParent != null;
      const time = leaf.activeTime || 0;
      if ((shown && !bestShown) || (shown === bestShown && time > bestTime)) { best = leaf; bestShown = shown; bestTime = time; }
    });
    return best;
  }
  newNotesTab(this: AgentManagerPlugin): WorkspaceLeaf {
    const ws = this.app.workspace;
    const group = this.shownNotesLeaf()?.parent ?? (this.useDedicatedSplit() ? this.getNotesGroup() : null);
    if (group) return ws.createLeafInParent(group, (group.children as WorkspaceLeaf[]).length);
    if (this.useDedicatedSplit() && this.getTerminalGroup()) return this.createNotesGroupWithLeaf();
    return ws.getLeaf("tab");
  }
  getNotesAnchorLeaf(this: AgentManagerPlugin): WorkspaceLeaf | null {
    const ws = this.app.workspace;
    const recent = ws.getMostRecentLeaf();
    const isOurs = (v: View | null | undefined) => this.isOurView(v);
    if (recent && this.isInMainArea(recent) && !isOurs(recent.view)) return recent;
    let fallback: WorkspaceLeaf | null = null;
    ws.iterateAllLeaves((leaf) => {
      if (fallback) return;
      if (this.isInMainArea(leaf) && !isOurs(leaf.view)) fallback = leaf;
    });
    return fallback;
  }
  openTerminalLeaf(this: AgentManagerPlugin): WorkspaceLeaf {
    const ws = this.app.workspace;
    const browser = this.windowBrowserLeaf();
    if (browser) {
      const inWindow = this.getTerminalGroup();
      if (inWindow) return ws.createLeafInParent(inWindow, (inWindow.children as WorkspaceLeaf[]).length);
      const leaf = ws.createLeafBySplit(browser, "vertical", false);
      const across = browser.view.containerEl.win.innerWidth || 0;
      const share = across ? Math.min(50, Math.round(((this._windowSidebarWidth || 300) / across) * 100)) : 0;
      if (share && browser.parent !== leaf.parent) {
        browser.parent.setDimension?.(share);
        leaf.parent.setDimension?.(100 - share);
      }
      return leaf;
    }
    if (!this.useDedicatedSplit()) return ws.getLeaf("tab");
    const group = this.getTerminalGroup();
    if (group) return ws.createLeafInParent(group, (group.children as WorkspaceLeaf[]).length);
    const anchor = this.getNotesAnchorLeaf();
    if (anchor) return ws.createLeafBySplit(anchor, "vertical", false);
    return ws.getLeaf("tab");
  }
  getNotesGroup(this: AgentManagerPlugin): WorkspaceParent | null {
    const ws = this.app.workspace;
    const termGroup = this.getTerminalGroup();
    let found: WorkspaceParent | null = null;
    ws.iterateAllLeaves((leaf) => {
      if (found) return;
      if (!this.isInMainArea(leaf) || leaf.parent?.type !== "tabs" || leaf.parent === termGroup) return;
      found = leaf.parent;
    });
    return found;
  }
  createNotesGroupWithLeaf(this: AgentManagerPlugin): WorkspaceLeaf {
    if (this.agentWindow()) return this.newMainWindowTab();
    const group = this.getTerminalGroup();
    const anchor = group?.children?.[0];
    if (!anchor) return this.app.workspace.getLeaf("tab");
    return this.app.workspace.createLeafBySplit(anchor, "vertical", true);
  }
  async openInNotesArea(this: AgentManagerPlugin, file: TFile): Promise<void> {
    const ws = this.app.workspace;
    const already = ws.getLeavesOfType("markdown").find((l) => l.view instanceof import_obsidian.FileView && l.view.file?.path === file.path);
    if (already) { await this.revealAndFlash(already); return; }
    const leaf = this.newNotesTab();
    await leaf.openFile(file);
    ws.setActiveLeaf(leaf, { focus: true });
  }
  getOrCreateNotesLeaf(this: AgentManagerPlugin): WorkspaceLeaf {
    const ws = this.app.workspace;
    const termGroup = this.getTerminalGroup();
    let visibleNav = null as WorkspaceLeaf | null, anyNotesLeaf = null as WorkspaceLeaf | null;
    ws.iterateAllLeaves((leaf) => {
      if (!this.isInMainArea(leaf) || leaf.parent?.type !== "tabs" || leaf.parent === termGroup) return;
      anyNotesLeaf = anyNotesLeaf || leaf;
      if (!visibleNav && leaf.canNavigate?.() && leaf.view?.containerEl?.offsetParent != null) visibleNav = leaf;
    });
    if (visibleNav) return visibleNav;
    if (anyNotesLeaf) return ws.createLeafInParent(anyNotesLeaf.parent, (anyNotesLeaf.parent.children as WorkspaceLeaf[]).length);
    return this.createNotesGroupWithLeaf();
  }
  installOpenRouting(this: AgentManagerPlugin): void {
    const ws = this.app.workspace;
    const terminalGroup = () => (this.useDedicatedSplit() ? this.getTerminalGroup() : null);
    const notesLeaf = () => this.getOrCreateNotesLeaf();
    const notesGroup = () => this.getNotesGroup();
    const newNotesGroup = () => this.createNotesGroupWithLeaf();
    const wsi: WorkspaceInternals = ws;
    const origUnpinned = wsi.getUnpinnedLeaf;
    const origInTabGroup = wsi.createLeafInTabGroup;
    if (typeof origUnpinned !== "function" || typeof origInTabGroup !== "function") {
      this._openRoutingAvailable = false;
      console.warn("[Agent Manager] open-routing: workspace internals not found; skipping (file-opening unaffected).");
      return;
    }
    this._openRoutingAvailable = true;
    const agentWindow = () => this.agentWindow();
    const wrappedUnpinned = function (this: Workspace, setActive?: boolean): WorkspaceLeaf {
      let group: WorkspaceParent | null = null, win: WorkspaceWindow | null = null;
      try { group = terminalGroup(); win = agentWindow(); } catch { /* empty */ }
      if (!group && !win) return origUnpinned.call(this, setActive);
      const ours = (l: WorkspaceLeaf) => (!!group && l.parent === group) || (!!win && l.getContainer() === win);
      const before = new Set<WorkspaceLeaf>(group?.children ?? []);
      if (win) ws.iterateAllLeaves((l) => { if (l.getContainer() === win) before.add(l); });
      const leaf = origUnpinned.call(this, setActive);
      try {
        if (!leaf || !ours(leaf)) return leaf;
        const target = notesLeaf();
        if (!target) return leaf;
        if (setActive !== false) ws.setActiveLeaf(target);
        if (!before.has(leaf)) leaf.detach();
        return target;
      } catch (e) { console.error("[Agent Manager] open-routing (getUnpinnedLeaf)", e); return leaf; }
    };
    const wrappedInTabGroup = function (this: Workspace, parent?: WorkspaceParent): WorkspaceLeaf {
      try {
        const group = terminalGroup();
        const win = agentWindow();
        const recent = ws.getMostRecentLeaf();
        if (!parent && recent && ((group && recent.parent === group) || (win && recent.getContainer() === win))) {
          const notes = notesGroup();
          if (notes) return origInTabGroup.call(this, notes);
          const fresh = newNotesGroup();
          if (fresh) return fresh;
        }
      } catch (e) { console.error("[Agent Manager] open-routing (createLeafInTabGroup)", e); }
      return origInTabGroup.call(this, parent);
    };
    const ownUnpinned = Object.prototype.hasOwnProperty.call(ws, "getUnpinnedLeaf");
    const ownInTabGroup = Object.prototype.hasOwnProperty.call(ws, "createLeafInTabGroup");
    wsi.getUnpinnedLeaf = wrappedUnpinned;
    wsi.createLeafInTabGroup = wrappedInTabGroup;
    this.register(() => {
      if (wsi.getUnpinnedLeaf === wrappedUnpinned) {
        if (ownUnpinned) wsi.getUnpinnedLeaf = origUnpinned; else delete wsi.getUnpinnedLeaf;
      }
      if (wsi.createLeafInTabGroup === wrappedInTabGroup) {
        if (ownInTabGroup) wsi.createLeafInTabGroup = origInTabGroup; else delete wsi.createLeafInTabGroup;
      }
    });
  }
  installTerminalGroupJanitor(this: AgentManagerPlugin): void {
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      this.syncAgentWindow();
      if (this._sweepScheduled) return;
      this._sweepScheduled = true;
      this.scheduleTimeout(() => {
        this._sweepScheduled = false;
        try { this.sweepTerminalGroup(); } catch (e) { console.error("[Agent Manager] terminal-group sweep", e); }
      }, 150);
    }));
  }
  sweepTerminalGroup(this: AgentManagerPlugin): void {
    const ws = this.app.workspace;
    if (!ws.layoutReady || !this.useDedicatedSplit()) return;
    const group = this.getTerminalGroup();
    if (!group || !group.children) return;
    const strays = group.children.filter((leaf) => {
      const t = leaf.view?.getViewType?.();
      if (this._unmovableStrays?.has(leaf)) return false;
      return t && t !== SESSION_VIEW_TYPE && t !== PLAIN_TERMINAL_VIEW_TYPE && t !== BROWSER_VIEW_TYPE && t !== "empty";
    });
    for (const stray of strays) {
      try {
        const notesGroup = this.getNotesGroup();
        const target = notesGroup
          ? ws.createLeafInParent(notesGroup, (notesGroup.children as WorkspaceLeaf[]).length)
          : this.createNotesGroupWithLeaf();
        if (!target) continue;
        const wasActive = this.activeLeaf() === stray;
        const shown = this.lastActiveTerminalLeaf;
        const state = stray.getViewState();
        target.setViewState(state).then(() => {
          try {
            if (stray.history && target.history) target.history.deserialize(stray.history.serialize());
            stray.detach();
            if (shown && shown !== stray && shown.parent === group && this.lastActiveTerminalLeaf === shown) {
              void ws.revealLeaf(shown).then(() => { if (wasActive) ws.setActiveLeaf(target); });
            } else if (wasActive) ws.setActiveLeaf(target);
          } catch (e) { console.error("[Agent Manager] transplant finalize", e); }
        }).catch((e) => {
          console.error("[Agent Manager] transplant", e);
          (this._unmovableStrays = this._unmovableStrays || new WeakSet()).add(stray);
          try { target.detach(); } catch { /* empty */ }
        });
      } catch (e) { console.error("[Agent Manager] transplant", e); }
    }
  }
  agentWindow(this: AgentManagerPlugin): WorkspaceWindow | null {
    const container = this.windowBrowserLeaf()?.getContainer();
    return container instanceof import_obsidian.WorkspaceWindow ? container : null;
  }
  canMoveTab(this: AgentManagerPlugin, leaf: WorkspaceLeaf): boolean {
    return typeof leaf.parent?.removeChild === "function" && typeof leaf.parent.insertChild === "function";
  }
  moveTab(this: AgentManagerPlugin, leaf: WorkspaceLeaf, group: WorkspaceParent, index?: number): boolean {
    const from = leaf.parent;
    if (from === group) return true;
    if (!this.canMoveTab(leaf) || typeof group.insertChild !== "function") return false;
    const was = (from.children as WorkspaceLeaf[]).indexOf(leaf);
    from.removeChild?.(leaf);
    try {
      leaf.setDimension?.(null);
      group.insertChild(index ?? (group.children as WorkspaceLeaf[]).length, leaf);
      return true;
    } catch (e) {
      console.error("[Agent Manager] moving a tab", e);
      try { from.insertChild?.(Math.max(0, was), leaf); } catch { /* empty */ }
      return false;
    }
  }
  newMainWindowTab(this: AgentManagerPlugin): WorkspaceLeaf {
    const ws = this.app.workspace;
    const group = ws.getMostRecentLeaf(ws.rootSplit)?.parent;
    if (group?.type === "tabs") return ws.createLeafInParent(group, (group.children as WorkspaceLeaf[]).length);
    return ws.getLeaf("tab");
  }
  mainAreaTerminals(this: AgentManagerPlugin): WorkspaceLeaf[] {
    return this.terminalLeaves().filter((l) => l.parent?.type === "tabs" && this.isInMainArea(l));
  }
  async popOutAgentManager(this: AgentManagerPlugin): Promise<void> {
    if (!this.layoutReady || this._poppingOut || this.agentWindow()) return;
    this._poppingOut = true;
    try {
      const ws = this.app.workspace;
      if (this.pluginData.windowGave !== undefined) { delete this.pluginData.windowGave; this.savePluginData().catch(() => {}); }
      const terms = this.mainAreaTerminals();
      if (terms.length && !this.canMoveTab(terms[0])) { notice({ head: "Session tabs can't move to another window", detail: "This version of Obsidian can't do it." }); return; }
      const sideWidth = this.mainBrowserLeaf()?.view.containerEl.offsetWidth || 300;
      let termWidth = Math.max(0, ...terms.map((l) => l.view.containerEl.offsetWidth)) || 800;
      const mainCols = this.rootColumns();
      const sessionsCol = this.useDedicatedSplit() ? this.getTerminalGroup() : null;
      const leaves = !!mainCols && !!sessionsCol && mainCols.cols.length > 1 && mainCols.cols.includes(sessionsCol)
        && (sessionsCol.children ?? []).every((l) => terms.includes(l));
      const sessionsAt = leaves && sessionsCol ? mainCols.cols.indexOf(sessionsCol) : -1;
      if (leaves && sessionsCol?.containerEl?.offsetWidth) termWidth = sessionsCol.containerEl.offsetWidth;
      const zoom = this.windowZoom();
      const colEl = leaves ? sessionsCol?.containerEl : null;
      const sessionsLeft = colEl ? window.screenX + colEl.getBoundingClientRect().left * zoom : window.screenX + window.outerWidth - termWidth * zoom;
      const width = Math.max(MIN_POPOUT, Math.round((sideWidth + termWidth) * zoom));
      const height = Math.max(MIN_POPOUT, window.outerHeight);
      const scr = window.screen as Screen & { availLeft?: number; availTop?: number };
      const left = scr.availLeft ?? 0, top = scr.availTop ?? 0;
      const sideDip = width - termWidth * zoom;
      const x = Math.round(Math.max(left, Math.min(sessionsLeft - sideDip, left + scr.availWidth - width)));
      const y = Math.max(top, window.screenY);
      const browser = ws.openPopoutLeaf({ x, y, size: { width, height } });
      await browser.setViewState({ type: BROWSER_VIEW_TYPE, active: true });
      const win = browser.getContainer();
      if (!(win instanceof import_obsidian.WorkspaceWindow)) { try { browser.detach(); } catch { /* empty */ } return; }
      this._windowSidebarWidth = sideDip / zoom;
      const place = () => {
        try {
          const w = win.win;
          if (w.closed) return;
          if (Math.abs(w.outerWidth - width) > 2 || Math.abs(w.outerHeight - height) > 2) w.resizeTo(width, height);
          if (Math.abs(w.screenX - x) > 2 || Math.abs(w.screenY - y) > 2) w.moveTo(x, y);
        } catch { /* empty */ }
      };
      this.scheduleTimeout(place, 250);
      this.gatherIntoAgentWindow();
      if (leaves && mainCols && sessionsCol && !this.rootColumns()?.cols.includes(sessionsCol)) {
        const fromLeft = sessionsAt === 0;
        const gave = this.resizeMainWindowBy(-(mainCols.widths.get(sessionsCol) ?? 0) * zoom, fromLeft, true);
        if (gave) {
          this.setRootWidths((c) => mainCols.widths.get(c) ?? 0);
          this.pluginData.windowGave = { width: -gave, left: fromLeft };
          this.savePluginData().catch(() => {});
        }
      }
      const group = this.getTerminalGroup();
      if (group && group !== browser.parent) {
        const share = (sideDip / width) * 100;
        browser.parent.setDimension?.(share);
        group.setDimension?.(100 - share);
      }
      ws.requestSaveLayout();
    } finally {
      this._poppingOut = false;
      this.syncAgentWindow();
    }
  }
  gatherIntoAgentWindow(this: AgentManagerPlugin, from: WorkspaceWindow | null = null): void {
    const win = this.agentWindow();
    if (!win) return;
    const terms = from ? this.terminalLeaves().filter((l) => l.getContainer() === from && l.parent?.type === "tabs") : this.mainAreaTerminals();
    if (!terms.length || !this.canMoveTab(terms[0])) return;
    const ws = this.app.workspace;
    const shown = this.lastActiveTerminalLeaf;
    let group = this.getTerminalGroup();
    let first: WorkspaceLeaf | null = null;
    if (!group) { first = this.openTerminalLeaf(); group = first.parent; }
    for (const leaf of terms) this.moveTab(leaf, group);
    try { first?.detach(); } catch { /* empty */ }
    if (shown && shown.parent === group) ws.setActiveLeaf(shown, { focus: true });
    ws.requestSaveLayout();
  }
  dockAgentManager(this: AgentManagerPlugin): boolean {
    const win = this.agentWindow();
    if (!win || this._poppingOut) return false;
    return this.dockFrom(win, this.windowBrowserLeaf());
  }
  dockFrom(this: AgentManagerPlugin, win: WorkspaceWindow, browser: WorkspaceLeaf | null): boolean {
    if (this._docking) return false;
    this._docking = true;
    try {
      const ws = this.app.workspace;
      const terms = this.terminalLeaves().filter((l) => l.getContainer() === win && l.parent?.type === "tabs");
      if (terms.length && !this.canMoveTab(terms[0])) return false;
      const shown = this.lastActiveTerminalLeaf;
      const gave = this.windowGave();
      const before = this.rootColumns()?.widths ?? new Map<WorkspaceParent, number>();
      let group: WorkspaceParent | null = null;
      let from: WorkspaceParent | null = null;
      if (terms.length) {
        group = this.useDedicatedSplit() ? this.mainTerminalGroup() : null;
        let first: WorkspaceLeaf | null = null;
        if (!group) {
          const cols = this.rootColumns();
          const edge = cols && gave?.left ? cols.cols[0] : cols ? cols.cols[cols.cols.length - 1] : null;
          const edgeLeaf = edge ? firstLeafOf(edge) : null;
          const anchor = this.useDedicatedSplit() ? (edgeLeaf && !this.isOurView(edgeLeaf.view) ? edgeLeaf : this.getNotesAnchorLeaf()) : null;
          from = anchor && cols?.cols.includes(anchor.parent) ? anchor.parent : null;
          first = anchor ? ws.createLeafBySplit(anchor, "vertical", !!gave?.left && !!from && from === cols?.cols[0]) : this.newMainWindowTab();
          group = first.parent;
        }
        let moved = true;
        for (const leaf of terms) moved = this.moveTab(leaf, group) && moved;
        try { first?.detach(); } catch { /* empty */ }
        if (!moved) browser = null;
      }
      const zoom = this.windowZoom();
      let grew = 0;
      if (gave) {
        grew = this.resizeMainWindowBy(gave.width, gave.left, !!group) / zoom;
        delete this.pluginData.windowGave;
        this.savePluginData().catch(() => {});
      }
      const cols = group ? this.rootColumns()?.cols ?? [] : [];
      if (group && gave && cols.includes(group)) {
        const sessions = group;
        if (from && cols.includes(from)) {
          const want = gave.width / zoom, donor = before.get(from) ?? 0;
          const give = Math.min(Math.max(0, want - grew), Math.max(0, donor - MIN_COLUMN));
          if (grew + give >= MIN_COLUMN) this.setRootWidths((c) => c === sessions ? grew + give : c === from ? donor - give : before.get(c));
        } else if (before.has(sessions) && grew > 0) {
          this.setRootWidths((c) => c === sessions ? (before.get(c) ?? 0) + grew : before.get(c));
        }
      }
      if (browser) { try { browser.detach(); } catch { /* empty */ } }
      if (shown && terms.includes(shown)) ws.setActiveLeaf(shown, { focus: true });
      if (!this.mainBrowserLeaf()) void this.createBrowserTab(true);
      ws.requestSaveLayout();
      return true;
    } finally {
      this._lastAgentWindow = null;
      this._docking = false;
      this.syncAgentWindow();
    }
  }
  mainTerminalGroup(this: AgentManagerPlugin): WorkspaceParent | null {
    for (const leaf of this.terminalLeaves()) if (leaf.parent?.type === "tabs" && this.isInMainArea(leaf)) return leaf.parent;
    return null;
  }
  windowGave(this: AgentManagerPlugin): { width: number; left: boolean } | null {
    const g = this.pluginData.windowGave as { width?: unknown; left?: unknown } | undefined;
    return g && typeof g.width === "number" && g.width > 0 ? { width: g.width, left: g.left === true } : null;
  }
  focusAgentWindow(this: AgentManagerPlugin): boolean {
    const win = this.agentWindow()?.win;
    if (!win) return false;
    const bw = this.electronWindowOf(win);
    try {
      if (bw) { if (bw.isMinimized()) bw.restore(); bw.focus(); }
      else win.focus();
    } catch { win.focus(); }
    return true;
  }
  electronWindowOf(this: AgentManagerPlugin, win: Window): ElectronWindow | null {
    try { return (win as Window & { require?: (id: string) => { getCurrentWindow(): ElectronWindow } }).require?.("@electron/remote").getCurrentWindow() ?? null; }
    catch { return null; }
  }
  windowZoom(this: AgentManagerPlugin): number {
    try { const z = this.electronWindowOf(window)?.webContents.getZoomFactor(); return z && z > 0 ? z : 1; }
    catch { return 1; }
  }
  resizeMainWindowBy(this: AgentManagerPlugin, delta: number, fromLeft: boolean, quiet = false): number {
    const bw = this.electronWindowOf(window);
    if (!bw || !delta) return 0;
    try {
      if (bw.isFullScreen()) return 0;
      const b = bw.getBounds();
      const scr = window.screen as Screen & { availLeft?: number };
      const left = scr.availLeft ?? 0, right = left + scr.availWidth;
      const width = Math.max(MIN_MAIN_WIDTH, Math.min(Math.max(scr.availWidth, b.width), Math.round(b.width + delta)));
      if (width === b.width) return 0;
      let x = fromLeft ? b.x + b.width - width : b.x;
      if (width > b.width) { if (x + width > right) x = right - width; if (x < left) x = left; }
      if (quiet) this._paneQuiet = { width: this.app.workspace.rootSplit.containerEl?.clientWidth ?? 0 };
      bw.setBounds({ x, y: b.y, width, height: b.height });
      const got = bw.getBounds().width - b.width;
      if (!got) this._paneQuiet = undefined;
      return got;
    } catch (e) { console.error("[Agent Manager] resizing the main window", e); return 0; }
  }
  rootColumns(this: AgentManagerPlugin): { cols: WorkspaceParent[]; widths: Map<WorkspaceParent, number> } | null {
    const root = this.app.workspace.rootSplit as WorkspaceParent & { direction?: string };
    if (root.direction !== "vertical") return null;
    const cols = (root.children ?? []) as unknown as WorkspaceParent[];
    return { cols, widths: new Map(cols.map((c) => [c, c.containerEl?.offsetWidth ?? 0])) };
  }
  setRootWidths(this: AgentManagerPlugin, width: (col: WorkspaceParent) => number | undefined): void {
    const cols = this.rootColumns()?.cols ?? [];
    const widths = cols.map((c) => Math.max(1, width(c) ?? c.containerEl?.offsetWidth ?? 1));
    const total = widths.reduce((a, b) => a + b, 0);
    if (cols.length < 2 || total <= 0) return;
    cols.forEach((c, i) => c.setDimension?.((widths[i] / total) * 100));
  }
  syncAgentWindow(this: AgentManagerPlugin): void {
    if (this.layoutReady && !this._poppingOut && !this._docking) this.dedupeBrowserLeaves(null);
    this.markWindowSidebar();
    this.syncWindowButtons();
    const win = this.agentWindow();
    const out = !!win;
    const was = this._lastAgentWindow ?? null;
    this._lastAgentWindow = win;
    if (out && was && win && was !== win && !this._poppingOut && !this._docking) {
      const from = was;
      this.scheduleTimeout(() => {
        const now = this.agentWindow();
        try {
          if (!now) { if (!this._docking) this.dockFrom(from, null); } else if (now !== from) this.gatherIntoAgentWindow(from);
        } catch (e) { console.error("[Agent Manager] gathering the session tabs from the last window", e); }
      }, 200);
    }
    if (this._agentWindowOut === out) return;
    this._agentWindowOut = out;
    if (out && !this._poppingOut) this.scheduleTimeout(() => {
      try { this.gatherIntoAgentWindow(); } catch (e) { console.error("[Agent Manager] gathering the session tabs", e); }
      if (!this.mainBrowserLeaf()) void this.createBrowserTab(true);
    }, 200);
    if (!out && was && !this._docking && !this._appClosing) {
      try { this.dockFrom(was, null); } catch (e) { console.error("[Agent Manager] docking a window whose sidebar went", e); }
    }
    this.refreshBrowsers();
  }
  markWindowSidebar(this: AgentManagerPlugin): void {
    const group = this.windowBrowserLeaf()?.parent ?? null;
    const alone = !!group && group.type === "tabs" && (group.children as WorkspaceLeaf[]).every((l) => l.getViewState?.().type === BROWSER_VIEW_TYPE);
    const el = (alone && group?.containerEl) || null;
    const sessions = el ? this.getTerminalGroup()?.containerEl ?? null : null;
    if (!sessions && this._windowSidebarHidden) {
      this._windowSidebarHidden = false;
      this._windowSidebarEl?.removeClass("agent-manager-window-sidebar-folding");
      el?.removeClass("agent-manager-window-sidebar-folding");
    }
    const hidden = !!el && !!this._windowSidebarHidden;
    const lead = hidden ? sessions : null;
    if (this._windowSidebarEl !== el) {
      this._windowSidebarEl?.removeClasses(["agent-manager-window-sidebar", "agent-manager-window-sidebar-hidden", "agent-manager-window-sidebar-folding"]);
      el?.addClass("agent-manager-window-sidebar");
      this._windowSidebarEl = el;
    }
    el?.toggleClass("agent-manager-window-sidebar-hidden", hidden);
    if (this._windowLeadEl !== lead) {
      this._windowLeadEl?.removeClass("agent-manager-window-lead");
      lead?.addClass("agent-manager-window-lead");
      this._windowLeadEl = lead;
    }
    const bar = (lead ?? el)?.querySelector<HTMLElement>(":scope > .workspace-tab-header-container") ?? null;
    let button = this._windowToggleEl ?? null;
    if (button && (!bar || !sessions || button.doc !== bar.doc)) { button.remove(); button = this._windowToggleEl = null; }
    if (!bar || !sessions) return;
    if (!button) {
      button = bar.createDiv({ cls: "sidebar-toggle-button mod-left agent-manager-sidebar-toggle" });
      const icon = button.createDiv({ cls: "clickable-icon" });
      const own = document.querySelector(".sidebar-toggle-button.mod-left svg");
      if (own) icon.appendChild(bar.doc.importNode(own, true));
      else import_obsidian.setIcon(icon, "panel-left");
      button.addEventListener("click", () => this.foldWindowSidebar(!this._windowSidebarHidden));
      this._windowToggleEl = button;
    }
    const placed = lead ? bar.firstElementChild === button : bar.lastElementChild === button;
    if (!placed) { if (lead) bar.prepend(button); else bar.append(button); }
    button.toggleClass("agent-manager-sidebar-open", !hidden);
    button.setAttribute("aria-label", hidden ? "Show the sidebar" : "Hide the sidebar");
  }
  foldWindowSidebar(this: AgentManagerPlugin, hide: boolean): void {
    const el = this._windowSidebarEl;
    if (el && hide) {
      el.setCssProps({ "--agent-manager-sidebar-width": `${el.offsetWidth}px` });
      el.addClass("agent-manager-window-sidebar-folding");
      void el.offsetWidth;
    }
    this._windowSidebarHidden = hide;
    this.markWindowSidebar();
    if (el && !hide) this.scheduleTimeout(() => { if (!this._windowSidebarHidden) el.removeClass("agent-manager-window-sidebar-folding"); }, 200);
  }
  paintWindowButton(this: AgentManagerPlugin, btn: HTMLElement, leaf: WorkspaceLeaf): void {
    const inWindow = !!leaf && leaf === this.windowBrowserLeaf();
    const out = !!this.agentWindow();
    const state = inWindow ? "dock" : out ? "forward" : "pop";
    btn.toggleClass("agent-manager-window-pop-out", state === "forward");
    if (btn.dataset.state === state) return;
    btn.dataset.state = state;
    btn.empty();
    import_obsidian.setIcon(btn, inWindow ? "square-arrow-out-down-left" : "square-arrow-out-up-right");
    btn.setAttribute("aria-label", inWindow ? "Dock in the main window" : out ? "Bring the pop-out window forward" : "Open in pop-out mode");
  }
  syncWindowButtons(this: AgentManagerPlugin): void {
    for (const leaf of this._browserLeaves()) {
      const btn = leaf.view?.containerEl?.querySelector<HTMLElement>(".agent-manager-head-window");
      if (btn) this.paintWindowButton(btn, leaf);
    }
  }
  clickWindowButton(this: AgentManagerPlugin, leaf: WorkspaceLeaf): void {
    if (leaf === this.windowBrowserLeaf()) this.dockAgentManager();
    else if (!this.focusAgentWindow()) void this.popOutAgentManager();
  }
  clearWindowSidebar(this: AgentManagerPlugin): void {
    this._windowSidebarEl?.removeClasses(["agent-manager-window-sidebar", "agent-manager-window-sidebar-hidden", "agent-manager-window-sidebar-folding"]);
    this._windowLeadEl?.removeClass("agent-manager-window-lead");
    this._windowToggleEl?.remove();
    this._windowSidebarEl = this._windowLeadEl = this._windowToggleEl = null;
  }
  guardAgentWindow(this: AgentManagerPlugin, win: WorkspaceWindow): void {
    const orig = win.close;
    if (typeof orig !== "function" || this._guardedAgentWindows?.has(win)) return;
    (this._guardedAgentWindows = this._guardedAgentWindows || new WeakSet()).add(win);
    const own = Object.prototype.hasOwnProperty.call(win, "close");
    const docks = () => !this._appClosing && this.agentWindow() === win;
    const dock = () => this.dockAgentManager();
    const gone = () => !(this.app.workspace.floatingSplit?.children ?? [win]).includes(win);
    const holdsSessions = () => this.terminalLeaves().some((l) => l.getContainer() === win);
    const wrapped = function (this: WorkspaceWindow): void {
      let docked = false;
      try { if (docks()) docked = dock(); } catch (e) { console.error("[Agent Manager] docking a closing window", e); }
      if (docked && (gone() || holdsSessions())) return;
      orig.call(this);
    };
    win.close = wrapped;
    this.register(() => {
      if (win.close !== wrapped) return;
      if (own) win.close = orig; else delete win.close;
    });
  }
  installAgentWindow(this: AgentManagerPlugin): void {
    const ws = this.app.workspace;
    this.registerEvent(ws.on("window-open", (win) => this.guardAgentWindow(win)));
    ws.onLayoutReady(() => {
      ws.iterateAllLeaves((leaf) => {
        const container = leaf.getContainer();
        if (container instanceof import_obsidian.WorkspaceWindow) this.guardAgentWindow(container);
      });
      this._agentWindowOut = !!this.agentWindow();
      this._lastAgentWindow = this.agentWindow();
      if (!this._agentWindowOut && this.pluginData.windowGave !== undefined) { delete this.pluginData.windowGave; this.savePluginData().catch(() => {}); }
      this.markWindowSidebar();
      this.syncWindowButtons();
      try { this.gatherIntoAgentWindow(); } catch (e) { console.error("[Agent Manager] gathering the session tabs", e); }
    });
    this.register(() => this.clearWindowSidebar());
    const closing = () => {
      this._appClosing = true;
      this.scheduleTimeout(() => { this._appClosing = false; }, 60000);
    };
    this.registerEvent(ws.on("quit", closing));
    this.registerDomEvent(window, "beforeunload", closing, { capture: true });
  }
  async openSessionLeaf(this: AgentManagerPlugin, where = "tab", background = false): Promise<Session | null> {
    if (!this.layoutReady) return null;
    const leaf = where === "right"
      ? this.app.workspace.getRightLeaf(false)
      : this.openTerminalLeaf();
    if (!leaf) return null;
    await leaf.setViewState({ type: SESSION_VIEW_TYPE, active: !background, state: { host: { awaitLaunch: true } } });
    if (!background) void this.app.workspace.revealLeaf(leaf);
    else { try { await leaf.loadIfDeferred(); } catch { /* empty */ } }
    for (let i = 0; i < 60; i++) {
      if (this.sessionOf(leaf)) break;
      await new Promise((r) => window.setTimeout(r, 20));
    }
    return this.sessionOf(leaf);
  }
  getOpenSessions(this: AgentManagerPlugin): OpenSession[] {
    const out: OpenSession[] = [];
    for (const leaf of this.sessionLeaves()) {
      const v = this.sessionOf(leaf);
      if (v && v.running && v.sessionTitle) {
        out.push({
          title: v.sessionTitle,
          backendKey: v.activeBackendKey || v.getBackendKey(),
          leaf,
          view: v,
          sessionId: v._stripSessionId?.() || v.resumeSessionId || null,
        });
      }
    }
    return out;
  }
  getWaitingSessionKeys(this: AgentManagerPlugin): Set<string> {
    const set = new Set<string>();
    for (const o of this.getOpenSessions()) if (o.view?._askingYou()) set.add(this.openSessionKey(o));
    return set;
  }
  sessionPlaces(this: AgentManagerPlugin, v: Session): string[] {
    const out = new Set<string>();
    const at = this.contextFromString(v._contextSource?.from);
    if (at) {
      const ctx = this.launchContext(at, true);
      if (ctx.repo) out.add(`repo:${ctx.repo.replace(/\/+$/, "")}`);
    }
    const cwd = (v.workingDir || "").replace(/\/+$/, "");
    const vault = this.getVaultPath().replace(/\/+$/, "");
    if (cwd && cwd !== vault && !cwd.startsWith(`${vault}/`)) out.add(`repo:${cwd}`);
    return [...out];
  }
  peerNote(this: AgentManagerPlugin, s: Session): { text: string; delivered?: () => void } {
    if (s._scheduledRun) return { text: "" };
    const mine = this.sessionPlaces(s);
    if (!mine.length) return { text: "" };
    const now = Date.now();
    const told = (s._peersTold ??= new Map<string, number>());
    const claude: { key: string; name: string }[] = [];
    const others: { key: string; name: string }[] = [];
    for (const o of this.getOpenSessions()) {
      if (!o.view || o.view === s) continue;
      if (!this.sessionIsWorking(o.view)) continue;
      if (!this.sessionPlaces(o.view).some((k) => mine.includes(k))) continue;
      const key = this.openSessionKey(o);
      const last = told.get(key);
      if (last !== undefined && now - last < PEER_FORGET_MS) { told.set(key, now); continue; }
      const name = JSON.stringify(o.title);
      if (o.backendKey === "claude") claude.push({ key, name });
      else others.push({ key, name: `${name} (${CLI_BACKENDS[o.backendKey as BackendKey]?.label || o.backendKey})` });
    }
    if (!claude.length && !others.length) return { text: "" };
    const names = (list: { name: string }[]) => list.map((e) => e.name).sort().join(", ");
    const parts: string[] = [];
    if (claude.length) parts.push(`${claude.length === 1 ? "another session is" : "other sessions are"} working in this repo right now: ${names(claude)}. Before you build, run its tests, or commit here, check with ${claude.length === 1 ? "it" : "them"} by SendMessage to that name; if no answer comes within two minutes, tell the user rather than going ahead, and tell the user what was said either way.`);
    if (others.length) parts.push(`${claude.length ? "Also at work, and" : "Working in this repo right now, and"} unable to take messages: ${names(others)}. Ask the user before touching what you share.`);
    const fresh = [...claude, ...others].map((e) => e.key);
    return { text: `Agent Manager: ${parts.join(" ")}`, delivered: () => { const t = Date.now(); for (const k of fresh) told.set(k, t); } };
  }
  openSessionRecord(this: AgentManagerPlugin, o: OpenSession): SessionRecord {
    return { title: o.title, displayName: o.title, backend: o.backendKey as BackendKey, sessionId: o.sessionId || null, mtime: Date.now(), file: null, cwd: null, listed: true };
  }
  openSessionKey(this: AgentManagerPlugin, o: { backendKey: string; title: string; sessionId?: string | null }): string {
    return o.sessionId ? `${o.backendKey}\nid:${o.sessionId}` : `${o.backendKey}\n${o.title}`;
  }
  sessionRowKeys(this: AgentManagerPlugin, backend: string, title: string, sessionId: string | null | undefined): string[] {
    return sessionId ? [`${backend}\nid:${sessionId}`] : [`${backend}\n${title}`];
  }
  getOpenSessionKeys(this: AgentManagerPlugin): Set<string> {
    const set = new Set<string>();
    for (const o of this.getOpenSessions()) set.add(this.openSessionKey(o));
    for (const leaf of this.sessionLeaves()) {
      if (this.sessionOf(leaf)) continue;
      const s = this.savedSessionState(leaf);
      if (s && s.sessionTitle && s.backendKey) set.add(this.openSessionKey({ title: s.sessionTitle, backendKey: s.backendKey, sessionId: s.sessionId || null }));
    }
    return set;
  }
  activeLeaf(this: AgentManagerPlugin): WorkspaceLeaf | null {
    return this.app.workspace.getActiveViewOfType(import_obsidian.View)?.leaf ?? null;
  }
  getActiveSessionKey(this: AgentManagerPlugin): string | null {
    const v = this.sessionOf(this.activeLeaf());
    if (v && v.running && v.sessionTitle) {
      return this.openSessionKey({ backendKey: v.activeBackendKey || v.getBackendKey(), title: v.sessionTitle, sessionId: v._stripSessionId?.() || v.resumeSessionId || null });
    }
    return null;
  }
  getLeafForSession(this: AgentManagerPlugin, title: string, backendKey: string, sessionId: string | null = null): WorkspaceLeaf | null {
    let found: WorkspaceLeaf | null = null;
    for (const leaf of this.sessionLeaves()) {
      if (found) break;
      const live = this.sessionOf(leaf);
      const s: { sessionTitle?: string | null; backendKey?: string } = live ? { sessionTitle: live.sessionTitle, backendKey: live.backendKey || live.getBackendKey() } : this.savedSessionState(leaf) || {};
      if (!s.sessionTitle || s.sessionTitle !== title || s.backendKey !== backendKey) continue;
      if (sessionId) {
        const vid = live ? live._ownSessionId() : (this.savedSessionState(leaf)?.sessionId || null);
        if (vid && vid !== sessionId) continue;
      }
      found = leaf;
    }
    return found;
  }
  eagerLoadSessions(this: AgentManagerPlugin, leaves: WorkspaceLeaf[] | null | undefined): void {
    const deferred = (leaves || []).filter(
      (l) => l && l.isDeferred && typeof l.loadIfDeferred === "function"
    );
    const GAP = 500;
    deferred.forEach((leaf, i) => {
      this.scheduleTimeout(() => {
        try { void leaf.loadIfDeferred(); }
        catch (e) { console.error("[Agent Manager] Eager session load failed:", e); }
      }, i * GAP);
    });
  }
}
export { WorkspaceMethods };
