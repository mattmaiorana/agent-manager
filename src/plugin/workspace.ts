
import type { TFile, View, Workspace, WorkspaceLeaf, WorkspaceParent } from "obsidian";
import { import_obsidian } from "../externals.js";
import { BrowserView, isBrowser } from "../browser/view.js";
import { BROWSER_VIEW_TYPE, PLAIN_TERMINAL_VIEW_TYPE, SESSION_VIEW_TYPE } from "../sessions/constants.js";
import { isSession } from "../sessions/controller.js";
import { SessionSwitcherModal } from "../ui/modals.js";
import type { BackendKey } from "../constants/backends.js";
import type { Browser, OpenSession, SavedSessionState, Session, SessionRecord } from "../types.js";
import type { AgentManagerPlugin } from "./main.js";
import type { WorkspaceInternals } from "../obsidian-internals.js";

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
    return this._browserLeaves()[0] || null;
  }
  dedupeBrowserLeaves(this: AgentManagerPlugin, keeper: WorkspaceLeaf | null): void {
    const browsers = this._browserLeaves();
    if (browsers.length < 2) return;
    const keep = keeper && browsers.includes(keeper) ? keeper : browsers[0];
    for (const l of browsers) if (l !== keep) { try { l.detach(); } catch { /* empty */ } }
  }
  async createBrowserTab(this: AgentManagerPlugin): Promise<void> {
    if (!this.layoutReady) return;
    const existing = this.findBrowserLeaf();
    if (existing) { void this.app.workspace.revealLeaf(existing); return; }
    if (this._browserCreateInFlight) return;
    this._browserCreateInFlight = true;
    try {
      const leaf = this.app.workspace.getLeftLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: BROWSER_VIEW_TYPE, active: true });
      void this.app.workspace.revealLeaf(leaf);
      this.dedupeBrowserLeaves(leaf);
    } finally {
      this._browserCreateInFlight = false;
    }
  }
  async revealBrowser(this: AgentManagerPlugin): Promise<void> {
    if (!this.layoutReady) return;
    const existing = this.findBrowserLeaf();
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
    for (const leaf of this.terminalLeaves()) {
      if (leaf.parent?.type === "tabs" && this.isInMainArea(leaf)) return leaf.parent;
    }
    return null;
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
    return this.isSessionView(v) || v instanceof BrowserView || v?.getViewType?.() === SESSION_VIEW_TYPE || v?.getViewType?.() === PLAIN_TERMINAL_VIEW_TYPE;
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
    const wrappedUnpinned = function (this: Workspace, setActive?: boolean): WorkspaceLeaf {
      let group = null;
      try { group = terminalGroup(); } catch { /* empty */ }
      if (!group) return origUnpinned.call(this, setActive);
      const before = group.children ? group.children.slice() : [];
      const leaf = origUnpinned.call(this, setActive);
      try {
        if (!leaf || leaf.parent !== group) return leaf;
        const target = notesLeaf();
        if (!target) return leaf;
        if (setActive !== false) ws.setActiveLeaf(target);
        if (!before.includes(leaf)) leaf.detach();
        return target;
      } catch (e) { console.error("[Agent Manager] open-routing (getUnpinnedLeaf)", e); return leaf; }
    };
    const wrappedInTabGroup = function (this: Workspace, parent?: WorkspaceParent): WorkspaceLeaf {
      try {
        const group = terminalGroup();
        if (group && !parent && ws.getMostRecentLeaf()?.parent === group) {
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
      return t && t !== SESSION_VIEW_TYPE && t !== PLAIN_TERMINAL_VIEW_TYPE && t !== "empty";
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
